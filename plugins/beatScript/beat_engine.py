"""Turn a video's soundtrack into a beat-synced funscript. Needs numpy and ffmpeg.

Steps:
  1. decode the audio to mono 22.05 kHz with ffmpeg
  2. onset strength per 23 ms frame from spectral flux (how much new sound energy appears)
  3. local tempo every 2 s from the onset autocorrelation, so songs in a PMV can change BPM
  4. beat times by dynamic programming (Ellis 2007): beats land on strong onsets while
     keeping close to the local tempo
  5. one stroke end per beat, deeper when the music is louder, paused through silence
"""
import subprocess

import numpy as np

SR = 22050
HOP = 512
NFFT = 2048
FPS = SR / HOP  # onset frames per second (~43)
# Frame t covers samples t*HOP .. t*HOP+NFFT and its flux compares it with frame t-1, so a hit
# shows up about half a window plus one hop after the frame's start time. Measured against
# librosa on real PMVs: ~70 ms.
LATENCY_S = (NFFT / 2 + HOP) / SR

DEFAULTS = {
    "min_amplitude": 50,     # stroke depth (0-100) in the quietest passages
    "max_speed": 400,        # funscript units per second; deeper strokes are cut down to stay under it
    "min_stroke_ms": 250,    # beats closer than this are skipped (fast songs play at half time)
    "silence": 0.12,         # loudness below this fraction of the track's loud parts counts as silence
    "bpm_min": 70,
    "bpm_max": 180,
    "bass_boost": 1.0,
    "tightness": 100.0,
}


def decode_audio(path):
    cmd = ["ffmpeg", "-v", "error", "-nostdin", "-i", str(path), "-vn", "-ac", "1", "-ar", str(SR),
           "-f", "f32le", "-"]
    out = subprocess.run(cmd, capture_output=True, check=False)
    if out.returncode != 0:
        raise RuntimeError("ffmpeg couldn't read the audio: " + out.stderr.decode(errors="replace")[-300:])
    y = np.frombuffer(out.stdout, dtype=np.float32)
    if y.size < SR:
        raise RuntimeError("the video has no audio track (or under a second of it)")
    return y


def _moving_avg(x, n):
    n = max(1, int(n))
    k = np.ones(n) / n
    return np.convolve(np.pad(x, (n // 2, n - 1 - n // 2), mode="edge"), k, mode="valid")


def onset_and_loudness(y, bass_boost=1.0):
    """Onset strength and RMS loudness, one value per hop."""
    n = 1 + (len(y) - NFFT) // HOP
    win = np.hanning(NFFT).astype(np.float32)
    # Log-spaced bands from 30 Hz to 8 kHz so kick drums and hi-hats both count.
    freqs = np.fft.rfftfreq(NFFT, 1 / SR)
    edges = np.geomspace(30, 8000, 41)
    band = np.digitize(freqs, edges) - 1
    valid = (band >= 0) & (band < 40)
    # Kick drums mark the downbeat; weighting the low bands keeps strokes on the beat
    # instead of on off-beat snares and hi-hats.
    centers = np.sqrt(edges[:-1] * edges[1:])
    weights = np.where(centers < 150, bass_boost, 1.0).astype(np.float32)

    flux = np.zeros(n, dtype=np.float32)
    rms = np.zeros(n, dtype=np.float32)
    prev = None
    for start in range(0, n, 2048):  # chunks keep memory flat on hour-long videos
        idx = np.arange(start, min(n, start + 2048))
        frames = y[idx[:, None] * HOP + np.arange(NFFT)]
        rms[idx] = np.sqrt((frames ** 2).mean(axis=1))
        mag = np.abs(np.fft.rfft(frames * win, axis=1))
        bands = np.zeros((len(idx), 40), dtype=np.float32)
        np.add.at(bands.T, band[valid], mag[:, valid].T)
        bands = np.log1p(100 * bands)
        bands = bands * weights
        if prev is not None:
            bands_all = np.vstack([prev[None], bands])
        else:
            bands_all = np.vstack([bands[:1], bands])
        flux[idx] = np.maximum(0, np.diff(bands_all, axis=0)).sum(axis=1)
        prev = bands[-1]

    onset = np.maximum(0, flux - _moving_avg(flux, FPS))  # remove the slow trend
    sd = onset.std()
    return (onset / sd if sd > 0 else onset), rms


def local_period(onset, bpm_min, bpm_max):
    """Beat period in frames for every frame, from 8 s windows every 2 s."""
    win, step = int(8 * FPS), int(2 * FPS)
    lags = np.arange(int(FPS * 60 / bpm_max), int(FPS * 60 / bpm_min) + 1)
    # Prefer tempos near 120 BPM when a half or double tempo scores about the same.
    bpm = 60 * FPS / lags
    prior = np.exp(-0.5 * (np.log2(bpm / 120) / 0.9) ** 2)

    centers, periods = [], []
    for s in range(0, max(1, len(onset) - win + 1), step):
        seg = onset[s:s + win]
        seg = seg - seg.mean()
        denom = (seg ** 2).sum()
        if denom <= 0:
            continue
        ac = np.array([(seg[:-l] * seg[l:]).sum() for l in lags]) / denom
        centers.append(s + win // 2)
        w = ac * prior
        i = int(np.argmax(w))
        # Parabolic fit around the peak gives sub-frame precision (frames are 23 ms).
        shift = 0.0
        if 0 < i < len(w) - 1:
            den = w[i - 1] - 2 * w[i] + w[i + 1]
            shift = 0.5 * (w[i - 1] - w[i + 1]) / den if den else 0.0
        periods.append(lags[i] + float(np.clip(shift, -0.5, 0.5)))
    if not periods:
        return np.full(len(onset), FPS * 60 / 120)
    periods = np.array(periods, dtype=float)
    # Median over ~10 s smooths single-window glitches but keeps song changes.
    k = 2
    smooth = np.array([np.median(periods[max(0, i - k):i + k + 1]) for i in range(len(periods))])
    return np.interp(np.arange(len(onset)), centers, smooth)


def track_beats(onset, period, tightness=100.0):
    n = len(onset)
    score = onset.astype(float).copy()
    back = np.full(n, -1)
    for t in range(n):
        p = period[t]
        lo, hi = t - int(round(2 * p)), t - int(round(p / 2))
        if hi <= 0:
            continue
        prev = np.arange(max(0, lo), hi)
        cand = score[prev] - tightness * np.log((t - prev) / p) ** 2
        i = np.argmax(cand)
        score[t] = onset[t] + cand[i]
        back[t] = prev[i]
    tail = int(round(period[-1]))
    t = n - tail + int(np.argmax(score[-tail:]))
    beats = []
    while t >= 0:
        beats.append(t)
        t = back[t]
    return np.array(beats[::-1])


def generate(path, **opts):
    """Return (actions, info) for the video or audio file at path."""
    o = dict(DEFAULTS, **{k: v for k, v in opts.items() if v is not None})
    y = decode_audio(path)
    onset, rms = onset_and_loudness(y, o["bass_boost"])
    period = local_period(onset, o["bpm_min"], o["bpm_max"])
    beats = track_beats(onset, period, o["tightness"])

    loud = _moving_avg(rms, 0.4 * FPS)
    ref = np.percentile(loud, 95) or 1.0
    quiet = loud < o["silence"] * ref
    lo, hi = np.percentile(loud, 20), ref
    level = np.clip((loud - lo) / max(hi - lo, 1e-9), 0, 1)

    times = beats / FPS + LATENCY_S
    keep, last = [], -1e9
    for b, t in zip(beats, times):
        if quiet[b]:
            continue
        if (t - last) * 1000 < o["min_stroke_ms"]:
            continue
        keep.append(b)
        last = t

    actions, up, prev_t = [], True, None
    for b in keep:
        t = b / FPS + LATENCY_S
        amp = o["min_amplitude"] + (100 - o["min_amplitude"]) * level[b]
        if prev_t is not None:
            gap = t - prev_t
            if gap > 2.5 * period[b] / FPS:
                # Music came back after a pause: rest at the middle until this beat.
                actions.append({"at": int(round((t - period[b] / FPS) * 1000)), "pos": 50})
                gap = period[b] / FPS
            amp = min(amp, o["max_speed"] * gap)
        half = amp / 2
        actions.append({"at": int(round(t * 1000)), "pos": int(round(50 + half if up else 50 - half))})
        up = not up
        prev_t = t

    # Settle back to the middle after the last beat, or at the start of each long silence.
    if actions:
        actions.append({"at": actions[-1]["at"] + 500, "pos": 50})

    bpms = 60 * FPS / period[keep] if keep else np.array([0.0])
    info = {"beats": len(keep), "bpm_median": float(np.median(bpms)),
            "bpm_min": float(bpms.min()), "bpm_max": float(bpms.max()),
            "duration_s": len(y) / SR,
            "beat_times": [b / FPS + LATENCY_S for b in keep]}
    return actions, info


def funscript(actions, title="", creator="beatScript"):
    return {"version": "1.0", "inverted": False, "range": 100, "actions": actions,
            "metadata": {"title": title, "creator": creator,
                         "description": "Generated automatically from the music's beats", "type": "basic"}}
