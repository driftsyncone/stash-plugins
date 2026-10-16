"""Find beats from an on-screen beat bar (cock hero / fap hero style). Needs numpy and ffmpeg.

A beat bar is a strip where markers (dots, diamonds, crosses...) slide toward a target and the
beat is the moment a marker reaches it. Works on any marker shape:

  1. locate: sample a few seconds at several points in the video, scaled to 480 px wide. For
     every 3-row band and 64-px window, find the horizontal shift that best explains the change
     over 5 frames. A bar is a band where many windows agree on one non-zero speed.
  2. target: the strongest still graphic where the markers end (circle, chevron, diamond...),
     the gap between two marker runs, the screen centre when markers reach it, or where markers
     are last seen.
  3. beats: stream just the bar rows at full frame rate. Every marker sighting votes for the
     moment it will reach the target (now + distance / speed); vote peaks are beats. Stretches
     where nothing moves at the bar's speed (bar hidden) get no beats.
"""
import json
import subprocess

import numpy as np

W = 480            # analysis width; height follows the video's aspect ratio
BAND = 3           # rows per band in the locator
K_STEP = 5         # frames between compared images in the locator
VMAX = 30          # largest shift searched per K_STEP frames (px)
WIN, WSTEP = 64, 32
CHUNK_S = 60       # seconds of bar rows held in memory at once
ANALYSIS_FPS = 30  # everything runs at this rate (or the video's, if lower): at 120 fps markers move
                   # under 1 px per frame, too little to measure, and every extra frame costs time


def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                          "stream=avg_frame_rate,width,height:format=duration", "-of", "json", str(path)],
                         capture_output=True, text=True)
    j = json.loads(out.stdout or "{}")
    if not j.get("streams"):
        raise RuntimeError("ffprobe couldn't read the video")
    s = j["streams"][0]
    n, d = (s.get("avg_frame_rate") or "30/1").split("/")
    fps = float(n) / float(d) if float(d) else 30.0
    h = int(round(W * s["height"] / s["width"] / 2) * 2)
    return fps, float(j["format"]["duration"]), h


# Deblocking only smooths block edges; at 480 px wide it makes no difference to the analysis
# and skipping it decodes 15-20% faster.
FAST_DECODE = ["-skip_loop_filter", "all"]


def to_channel(yuv, channel="gray"):
    """(n, 3, rows, W) uint8 YUV -> (n, rows, W) uint8. "gray" is plain brightness. "colour"
    adds how colourful each pixel is: coloured markers (pink hearts on a grey strip) can match
    the strip's brightness exactly, but their colour still sets them apart. Brightness works
    best for most bars, so colour is only the fallback."""
    if channel == "gray":
        return np.ascontiguousarray(yuv[:, 0])
    a = yuv.astype(np.int16)
    out = 0.5 * a[:, 0] + 1.5 * (np.abs(a[:, 1] - 128) + np.abs(a[:, 2] - 128))
    return np.clip(out, 0, 255).astype(np.uint8)


def decode(path, start, dur, h, crop=None, fps=None, channel="gray", raw_yuv=False):
    vf = (f"fps={fps}," if fps else "") + f"scale={W}:{h}" + (f",crop={W}:{crop[1] - crop[0]}:0:{crop[0]}" if crop else "")
    rows = crop[1] - crop[0] if crop else h
    # network sources: give up after 30 s without data instead of hanging forever
    net = ["-rw_timeout", "30000000"] if str(path).startswith(("http://", "https://")) else []
    cmd = ["ffmpeg", "-v", "error", "-nostdin", *net, *FAST_DECODE, "-ss", f"{max(0.0, start):.3f}", "-i", str(path),
           "-t", f"{dur:.3f}", "-an", "-vf", vf, "-f", "rawvideo", "-pix_fmt", "yuv444p", "-"]
    raw = subprocess.run(cmd, capture_output=True).stdout
    n = len(raw) // (3 * rows * W)
    yuv = np.frombuffer(raw[:n * 3 * rows * W], np.uint8).reshape(n, 3, rows, W)
    return yuv if raw_yuv else to_channel(yuv, channel)


def highpass(P, n=15):
    """Remove smooth horizontal variation so small sharp shapes (markers) dominate."""
    c = np.cumsum(np.pad(P, [(0, 0)] * (P.ndim - 1) + [(n // 2 + 1, n // 2)], mode="edge"), axis=-1)
    return P - (c[..., n:] - c[..., :-n]) / n


# ---------- 1. locate ----------

def _shift_errors(a, b, x0, vmax):
    """mean |b window - a shifted by s| for s in -vmax..vmax (inf where the shift leaves the frame)."""
    lo, hi = max(0, x0 - vmax), min(W, x0 + WIN + vmax)
    aw, bw = a[:, :, lo:hi], b[:, :, x0:x0 + WIN]
    errs = []
    for s in range(-vmax, vmax + 1):
        src0 = x0 - s - lo
        if src0 < 0 or src0 + WIN > aw.shape[-1]:
            errs.append(np.full(bw.shape[:2], np.inf, np.float32))
        else:
            errs.append(np.abs(bw - aw[:, :, src0:src0 + WIN]).mean(-1))
    return np.stack(errs, -1)


def _scroll_map(F, h):
    """Per 3-row band and 64-px window: the horizontal speed that best explains the change.
    Evenly spaced markers also fit shifts of one marker spacing (wagon-wheel effect), so the
    shift must fit over both 5 and 3 frames; a fake one only fits one of them."""
    T = len(F)
    nb = h // BAND
    P = highpass(F[:, :nb * BAND].reshape(T, nb, BAND, W).astype(np.float32).mean(2))
    idx = np.arange(0, T - K_STEP, 2)
    a, b5, b3 = P[idx], P[idx + K_STEP], P[idx + 3]
    v3max = int(np.ceil(VMAX * 3 / K_STEP))
    s3_for = np.clip(np.round(np.arange(-VMAX, VMAX + 1) * 3 / K_STEP).astype(int), -v3max, v3max) + v3max
    starts = list(range(0, W - WIN + 1, WSTEP))
    gain = np.zeros((len(a), nb, len(starts)), np.float32)
    best = np.zeros_like(gain, dtype=np.int16)
    e0s = np.zeros_like(gain)
    for j, x0 in enumerate(starts):
        E5 = _shift_errors(a, b5, x0, VMAX)
        E3 = _shift_errors(a, b3, x0, v3max)
        e05 = E5[:, :, VMAX].copy()
        e03 = E3[:, :, v3max].copy()
        comb = E5 / (e05[..., None] + 1.0) + E3[:, :, s3_for] / (e03[..., None] + 1.0)
        comb[:, :, VMAX - 2:VMAX + 3] = np.inf
        s = comb.argmin(-1)
        best[:, :, j] = s - VMAX
        e5 = np.take_along_axis(E5, s[..., None], -1)[..., 0]
        gain[:, :, j] = (e05 - e5) / (e05 + 1.0)
        e0s[:, :, j] = e05
    return gain, best, e0s, starts


LAST = {}  # diagnostics from the most recent locate() call


def sample_windows(path, fps, duration, h, n_windows=16, win_s=4, log=None):
    """Short full-frame samples spread over the video, decoded once and shared by the normal
    and the slow-bar search."""
    out = []
    span0, span1 = duration * 0.03, duration * 0.97
    for i in range(n_windows):
        t = span0 + (span1 - span0) * (i + 0.5) / n_windows - win_s / 2
        out.append(decode(path, t, win_s, h, fps=fps, raw_yuv=True))
        if log:
            log(i + 1, n_windows)
    return out


def locate(samples, h, step=1):
    """Find the bar in pre-decoded samples. step=3 looks at every third frame, so slow bars
    move three times as far between the frames compared."""
    G, B, M = [], [], []
    starts = None
    for F in samples:
        F = F[::step]
        if len(F) < K_STEP + 4:
            continue
        g, b, e0, starts = _scroll_map(F, h)
        moving = e0 > 1.0
        G.append(np.where(moving, g, 0))
        B.append(np.where(moving, b, 0))
        M.append(moving)
    if not G:
        return None
    G, B, M = np.concatenate(G), np.concatenate(B), np.concatenate(M)
    nb, nw = G.shape[1:]
    mode = np.zeros((nb, nw), int)
    cons = np.zeros((nb, nw))
    for i in range(nb):
        for j in range(nw):
            v = B[:, i, j][M[:, i, j]]
            # footage noise and slow camera pans pile up at the smallest shifts (±3-4 per 5
            # frames), too slow to count as a bar anyway (slow bars are found by the reduced
            # frame rate retry); leave them out so a bar that is only on screen in some samples
            # still wins the vote
            n_all = len(v)
            v = v[np.abs(v) > 4]
            if len(v) > 10:
                vals, cnt = np.unique(v, return_counts=True)
                m = vals[cnt.argmax()]
                if abs(m) >= VMAX:
                    continue  # pinned at the search limit: fast footage, not a bar
                mode[i, j] = m
                cons[i, j] = cnt.max() / max(len(v), 0.5 * n_all) * min(1.0, 2 * len(v) / len(G))
    cell = G.mean(0) * cons
    band_score = np.zeros(nb)
    band_v = np.zeros(nb, int)
    for i in range(nb):
        ok = cell[i] > 0
        if not ok.any():
            continue
        # A bar is a run of neighbouring windows moving the same way at smoothly changing speeds
        # (constant for flat bars; slowing toward the target on perspective bars).
        best, run = 0, []
        for j in list(range(nw)) + [None]:
            fits = (j is not None and ok[j] and mode[i, j] != 0 and
                    (not run or (np.sign(mode[i, j]) == np.sign(mode[i, run[-1]]) and
                                 abs(mode[i, j] - mode[i, run[-1]]) <= max(2, 0.3 * abs(mode[i, run[-1]])))))
            if fits:
                run.append(j)
                continue
            if run:
                sc = cell[i][run].sum() * len(run) / nw
                if sc > best:
                    best, band_v[i] = sc, int(np.median(mode[i, run]))
            run = [j] if j is not None and ok[j] and mode[i, j] != 0 else []
        band_score[i] = best
    b0 = int(band_score.argmax())
    LAST.clear()
    LAST.update(bands=band_score.copy(), band_v=band_v.copy(), mode=mode.copy(), cell=cell.copy(), b0=b0)
    if band_score[b0] <= 0:
        LAST["why"] = "no band moves consistently"
        return None
    # A bar is a thin strip: nothing else in the frame moves like it. Camera pans and busy
    # footage score about the same on rows all over the picture.
    far = np.r_[band_score[:max(0, b0 - 4)], band_score[b0 + 5:]]
    if len(far) and far.max() > 0.3 * band_score[b0]:
        LAST["why"] = f"not a thin strip (row {int(np.argmax(np.r_[band_score[:max(0, b0 - 4)], np.zeros(9), band_score[b0 + 5:]][:len(band_score)])) * BAND} scores {far.max() / band_score[b0]:.0%} of the bar)"
        return None
    rows = [b for b in range(max(0, b0 - 2), min(nb, b0 + 3))
            if band_score[b] >= 0.35 * band_score[b0] and abs(band_v[b] - band_v[b0]) <= max(1, 0.3 * abs(band_v[b0]))]
    cols = cell[rows].sum(0)
    active = cols > 0.25 * cols.max() if cols.max() > 0 else np.zeros(nw, bool)
    vmap = []
    for j in range(nw):
        sel = cell[rows, j] > 0
        vmap.append(float(np.median(mode[rows, j][sel])) / K_STEP if sel.any() else 0.0)
    # Fainter windows still belong to the bar when they move at its speed, either way (bars that
    # come in from both sides are often dimmer on one side).
    if active.any():
        act = [j for j in range(nw) if active[j]]
        for j in range(nw):
            if active[j] or cols[j] <= 0.08 * cols.max() or vmap[j] == 0:
                continue
            ref = abs(vmap[min(act, key=lambda a: abs(a - j))])
            if ref > 0 and abs(abs(vmap[j]) - ref) <= 0.15 * ref + 0.1 * abs(min(act, key=lambda a: abs(a - j)) - j) * ref:
                active[j] = True
    zs, cur = [], None
    for j, x0 in enumerate(starts):
        v = vmap[j]
        if active[j] and abs(v) >= 0.3:
            if cur and cur[3] == np.sign(v) and x0 <= cur[1]:
                cur[1] = x0 + WIN
                cur[2].append((x0 + WIN / 2, v))
                continue
            if cur:
                zs.append(cur)
            cur = [x0, x0 + WIN, [(x0 + WIN / 2, v)], np.sign(v)]
        elif cur:
            zs.append(cur)
            cur = None
    if cur:
        zs.append(cur)
    # the smallest searchable shift (3 px per 5 frames) is where footage noise lands, so real
    # bars must move faster than that
    # zone = (x0, x1, median speed, [(window centre, speed), ...]) in px per frame
    zs = [(z[0], z[1], float(np.median([q[1] for q in z[2]])), list(z[2])) for z in zs]
    # one failed window splits a run in two with no real gap between: join those pieces
    joined = []
    for z in zs:
        if joined and np.sign(z[2]) == np.sign(joined[-1][2]) and z[0] <= joined[-1][1]:
            a = joined[-1]
            pts = a[3] + z[3]
            joined[-1] = (a[0], z[1], float(np.median([q[1] for q in pts])), pts)
        else:
            joined.append(z)
    zs = [z for z in joined if z[1] - z[0] >= 96 and abs(z[2]) >= 1.0]
    y0, y1 = min(rows) * BAND, (max(rows) + 1) * BAND
    # pad a little so markers taller than the detected band are fully inside
    return {"y0": max(0, y0 - 3), "y1": min(h, y1 + 3), "score": float(band_score[b0]), "zones": zs,
            "debug": {"cols": [round(float(c), 3) for c in cols], "vmap": [round(v, 2) for v in vmap], "starts": starts,
                      "bands": [round(float(b), 3) for b in band_score]}}


# ---------- 2. motion helpers and target ----------

def speed_shape(pts, vmid):
    """Per-column speed relative to the zone's median: 1 everywhere on flat bars, falling toward
    the target on perspective bars. Held constant beyond the measured windows."""
    xs = np.array([q[0] for q in pts], float)
    vs = np.array([q[1] for q in pts], float) / vmid
    order = np.argsort(xs)
    return np.clip(np.interp(np.arange(W), xs[order], vs[order]), 0.3, 3.0)


def refine_velocity(Kh, x0, x1, v0, span=0.4, step=0.05, shape=None):
    """Best overall speed (scaling the shape's profile) for columns x0..x1, and how well it fits."""
    sh = np.ones(x1 - x0) if shape is None else shape[x0:x1]
    T = len(Kh)
    k = 6
    if T <= k + 2:
        return v0, 0.0
    idx = np.arange(0, T - k, max(1, (T - k) // 300))
    a, b = Kh[idx][:, x0:x1], Kh[idx + k][:, x0:x1]
    x = np.arange(x1 - x0)
    e0 = np.mean(np.abs(b - a))

    def err(v):
        aa = np.array([np.interp(x - v * sh * k, x, r, left=np.nan, right=np.nan) for r in a])
        return np.nanmean(np.abs(b - aa))
    grid = np.arange(v0 - span, v0 + span + 1e-6, step)
    grid = grid[np.abs(grid) >= 0.25]
    errs = [err(v) for v in grid]
    i = int(np.argmin(errs))
    return float(grid[i]), float((e0 - errs[i]) / (e0 + 1))


def coherent(Kh, v, k, shape=None):
    """Detail that moves at v px/frame (times the speed shape per column), minus detail that
    stays put."""
    A = np.abs(Kh)
    n = A.shape[1]
    x = np.arange(n)
    vv = v if shape is None else v * shape
    nxt = np.zeros_like(A)
    if len(A) > k:
        nxt[:-k] = np.array([np.interp(x + vv * k, x, r, left=0, right=0) for r in A[k:]])
    still = np.zeros_like(A)
    still[:-k] = A[k:]
    return np.maximum(0, np.minimum(A, nxt) - np.minimum(A, still))


def _shift_gain(Kh, v, k, x0, x1, fps, shape=None):
    """Per frame: how much better the bar k frames later matches the earlier bar shifted by v*k
    than unshifted, in 2 s blocks. A regularly spaced pattern still moving at the bar's speed
    scores high even when the coherence test can't tell it from a still one."""
    T = len(Kh)
    out = np.zeros(T, bool)
    step = max(1, int(2 * fps))
    x = np.arange(x1 - x0)
    sh = np.ones(x1 - x0) if shape is None else shape[x0:x1]
    for s0 in range(0, T - k, step):
        idx = np.arange(s0, min(T - k, s0 + step), 2)
        if not len(idx):
            continue
        a, b = Kh[idx][:, x0:x1], Kh[idx + k][:, x0:x1]
        e0 = np.mean(np.abs(b - a))
        moved = np.array([np.interp(x - v * sh * k, x, r, left=np.nan, right=np.nan) for r in a])
        ev = np.nanmean(np.abs(b - moved))
        out[s0:s0 + step] = e0 > 1.0 and (e0 - ev) / e0 >= 0.45
    return out


def _k_for(v):
    return max(2, int(round(6 / abs(v)))) if abs(v) < 3 else 2


def _presence(Kh, C, Cw, x0, x1, fps):
    T = len(Kh)
    step = max(1, int(2 * fps))
    present = np.zeros(T, bool)
    A = np.abs(Kh[:, x0:x1])
    for s0 in range(0, T, step):
        a = A[s0:s0 + step].mean() + 1e-6
        right = C[s0:s0 + step, x0:x1].mean() / a
        wrong = Cw[s0:s0 + step, x0:x1].mean() / a
        # Dense, evenly spaced markers look nearly as coherent the wrong way round, so a strong
        # right-way score only needs a small margin. Footage without a bar stays under ~0.11.
        present[s0:s0 + step] = (right >= 0.12 and right >= 1.5 * wrong) or (right >= 0.14 and right >= 1.15 * wrong)
    return present


def _still_blobs(Rh, present):
    A = np.abs(Rh[present]) if present.sum() > 30 else np.abs(Rh)
    S = np.percentile(A, 20, axis=0).max(0)
    S = np.convolve(S, np.ones(5) / 5, mode="same")
    base = np.array([np.median(S[max(0, x - 40):x + 41]) for x in range(W)])
    prom = S / (base + 2)
    blobs, x = [], 0
    while x < W:
        if prom[x] >= 2 and S[x] >= 8:
            e = x
            while e + 1 < W and prom[e + 1] >= 2:
                e += 1
            xs = np.arange(x, e + 1)
            blobs.append([x, e, float((xs * S[xs]).sum()), float(S[xs].sum()), float(prom[xs].max())])
            x = e + 1
        else:
            x += 1
    # rings and outlines split into pieces around their hollow middle: join pieces close together
    merged = []
    for b in blobs:
        if merged and b[0] - merged[-1][1] <= 12:
            m = merged[-1]
            m[1], m[2], m[3], m[4] = b[1], m[2] + b[2], m[3] + b[3], max(m[4], b[4]) + 0.5
        else:
            merged.append(b)
    return [(m[2] / m[3], m[4]) for m in merged]


def merge_zones(zs, blobs, max_gap=48):
    """Join same-direction runs separated by a short gap with nothing target-like in it (no still
    graphic, not the screen centre): that is one run with a measurement hole, not two."""
    zs = sorted(zs)
    out = []
    for z in zs:
        if out and np.sign(z[2]) == np.sign(out[-1][2]) and 0 <= z[0] - out[-1][1] <= max_gap:
            g0, g1 = out[-1][1], z[0]
            target_like = any(g0 - 16 <= b[0] <= g1 + 16 for b in blobs) or g0 - 16 <= W // 2 <= g1 + 16
            if not target_like:
                a = out[-1]
                pts = a[3] + z[3]
                out[-1] = (a[0], z[1], float(np.median([q[1] for q in pts])), pts)
                continue
        out.append(z)
    return out


def choose_targets(zs, Rh, Kh, Cs, present):
    """One (target x, how, votes) per zone. A zone that only shows markers after they passed the
    target doesn't vote."""
    blobs = _still_blobs(Rh, present)
    A = np.abs(Kh[present]) if present.sum() > 30 else np.abs(Kh)
    P = np.convolve(np.percentile(A, 50, axis=0), np.ones(9) / 9, mode="same")
    out = []
    for i, (x0, x1, v) in enumerate(z[:3] for z in zs):
        others = [z for j, z in enumerate(zs) if j != i]
        def holds_target(g0, g1):
            return any(g0 - 16 <= b[0] <= g1 + 16 for b in blobs) or g0 - 16 <= W // 2 <= g1 + 16
        up = [z for z in others if np.sign(z[2]) == np.sign(v) and (z[0] >= x1 - 32 if v < 0 else z[1] <= x0 + 32)
              and holds_target(*((x1, z[0]) if v < 0 else (z[1], x0)))]
        if up:
            out.append((None, "after target", False))
            continue
        down = [z for z in others if (z[1] <= x0 + 32 if v < 0 else z[0] >= x1 - 32)]
        if down:
            g = max((z[1] + x0) / 2 for z in down) if v < 0 else min((x1 + z[0]) / 2 for z in down)
            near = [b for b in blobs if abs(b[0] - g) <= 24]
            out.append((int(round(max(near, key=lambda b: b[1])[0])) if near else int(round(g)), "gap", True))
            continue
        end = x0 if v < 0 else x1
        # target graphic at or past the markers' end, or inside the last 40% of their run (faint
        # markers that continue past the target stretch the run beyond it)
        span = 0.4 * (x1 - x0)
        cand = [b for b in blobs if (end - 64 <= b[0] <= end + span if v < 0 else end - span <= b[0] <= end + 64)
                and b[1] >= 2.5]
        if cand:  # the one nearest where the markers end, not the brightest (boxes and labels nearby)
            out.append((int(round(min(cand, key=lambda b: abs(b[0] - end))[0])), "target graphic", True))
            continue
        c = W // 2
        if x0 - 32 <= c <= x1 + 32:
            near = [b for b in blobs if abs(b[0] - c) <= 16]
            out.append((int(round(near[0][0])) if near else c, "centre", True))
            continue
        best, bx = 0.75, None
        for x in range(x0 + 48, x1 - 48):
            side = min(P[x - 48:x - 16].mean(), P[x + 16:x + 48].mean())
            r = P[x] / (side + 1e-6)
            if r < best:
                best, bx = r, x
        if bx is not None:
            near = [b for b in blobs if abs(b[0] - bx) <= 16]
            out.append((int(round(near[0][0])) if near else bx, "marker dip", True))
            continue
        xs = []
        C = Cs[i]
        for t in np.where(C.max(1) > 0)[0][::3]:
            row = C[t]
            p = np.where((row[1:-1] > row[:-2]) & (row[1:-1] >= row[2:]) & (row[1:-1] > 0.3 * row.max()))[0] + 1
            xs.extend(p[(p >= x0 - 64) & (p < x1 + 64)].tolist())
        out.append((int(np.percentile(xs, 3 if v < 0 else 97)) if len(xs) > 50 else end, "last seen", True))
    # Bars are laid out symmetrically: a target found within 12 px of the middle is the middle
    # (emblems with uneven outlines pull the measured centre sideways).
    return [((W // 2 if t is not None and abs(t - W // 2) <= 12 else t), how, votes) for t, how, votes in out]


# ---------- 3. beats ----------

def _vote(C, present, v, tgt, lo, hi, offset, hist, res, shape=None, dense=None):
    if hi - lo < 8:
        return
    # frames to travel from column x to the target: sum of 1/speed over the columns in between
    speed = v * (np.ones(W) if shape is None else shape)
    cum = np.concatenate([[0.0], np.cumsum(1.0 / speed)])  # cum[x] = frames from 0 to x
    at_tgt = np.interp(tgt, np.arange(W + 1), cum)
    Cs = C[:, lo:hi]
    # Marker threshold. Frames packed with markers (dense) carry raw detail, whose typical level
    # is far higher, so they get their own gentler threshold; one shared over the chunk would
    # sit above every marker in a mostly packed stretch.
    dense = np.zeros(len(C), bool) if dense is None else dense
    thr_n = 3 * np.median(Cs[~dense]) + 1e-3 if (~dense).any() else 0.0
    thr_d = 1.5 * np.median(Cs[dense]) + 1e-3 if dense.any() else 0.0
    for t in np.where(present)[0]:
        row = Cs[t]
        thr = thr_d if dense[t] else thr_n
        p = np.where((row[1:-1] > row[:-2]) & (row[1:-1] >= row[2:]) & (row[1:-1] > thr))[0] + 1
        if not len(p):
            continue
        # time each marker from its centre (brightness-weighted), not its brightest pixel:
        # lopsided icons (fists, flames) put the brightest pixel off-centre
        xc = np.empty(len(p))
        for n, q in enumerate(p):
            a, b = max(0, q - 5), min(len(row), q + 6)
            w = row[a:b]
            xc[n] = (np.arange(a, b) * w).sum() / w.sum() if w.sum() > 0 else q
        tau = offset + t + at_tgt - np.interp(xc + lo, np.arange(W + 1), cum)
        b = np.round(tau * res).astype(int)
        ok = (b >= 0) & (b < len(hist))
        np.add.at(hist, b[ok], row[p][ok])


def _peaks(hist, res, fps):
    g = np.exp(-0.5 * (np.arange(-4 * res, 4 * res + 1) / float(res)) ** 2)
    sm = np.convolve(hist, g, mode="same")
    pk = np.where((sm[1:-1] > sm[:-2]) & (sm[1:-1] >= sm[2:]) & (sm[1:-1] > 0))[0] + 1
    if not len(pk):
        return np.array([])
    mind = int(0.12 * fps * res)
    taken = np.zeros(len(sm), bool)
    keep = []
    for p in pk[np.argsort(-sm[pk])]:
        if not taken[max(0, p - mind + 1):p + mind].any():
            keep.append(p)
            taken[p] = True
    keep = np.array(sorted(keep))
    hgt = sm[keep]
    ref = np.array([np.percentile(hgt[max(0, i - 20):i + 20], 80) for i in range(len(hgt))])
    keep = keep[(hgt > 0.3 * ref) & (hgt > 0.05 * hgt.max())]
    return keep / res / fps


def find_beats(path, progress=None, info=None):
    """Return (beat times in seconds, details). Raises RuntimeError when no beat bar is found."""
    src_fps, duration, h = probe(path)
    fps = min(src_fps, ANALYSIS_FPS)
    samples = sample_windows(path, fps, duration, h,
                             log=(lambda i, n: progress(0.12 * i / n, "looking for a beat bar")) if progress else None)
    loc, channel = None, "gray"
    for channel in ("gray", "colour"):
        chan = [to_channel(sm, channel) for sm in samples]
        # Slow bars move under 1 px per frame at 30 fps, too little to measure: look again at
        # every second, then every third frame, where the same motion is bigger per frame
        # (step 2 first: evenly spaced markers can line up with themselves at a step of three)
        for step in (1, 2, 3):
            found = locate(chan, h, step=step)
            if found and found["zones"] and found["score"] >= 0.1:
                found["zones"] = [(x0, x1, v / step, [(c, q / step) for c, q in pts]) for x0, x1, v, pts in found["zones"]]
                loc = found
                break
        if loc:
            break
    if not loc or not loc["zones"] or loc["score"] < 0.1:
        raise RuntimeError("no on-screen beat bar found (markers sliding toward a target)")
    crop = (loc["y0"], loc["y1"])

    # Targets come from a sample: still graphics and marker layout don't change much.
    del samples
    sample = decode(path, duration * 0.3, min(30, duration * 0.4), h, crop, fps=fps, channel=channel).astype(np.float32)
    Kh_s = highpass(sample.mean(1))
    Rh_s = highpass(sample)
    zs, Cs, pres = [], [], []
    for x0, x1, v0, pts in merge_zones(loc["zones"], _still_blobs(Rh_s, np.ones(len(Rh_s), bool))):
        shape = speed_shape(pts, v0)
        v, fit = refine_velocity(Kh_s, x0, x1, v0, shape=shape)
        if fit < 0.05 or np.sign(v) != np.sign(v0):
            v = v0  # the search's own speed is better than a poor refinement
        k = _k_for(v)
        C = coherent(Kh_s, v, k, shape)
        p = _presence(Kh_s, C, coherent(Kh_s, -v, k, shape), x0, x1, fps)
        C[~p] = 0
        zs.append((x0, x1, v, shape))
        Cs.append(C)
        pres.append(p)
    anyp = np.any(pres, axis=0)
    targets = choose_targets(zs, Rh_s, Kh_s, Cs, anyp)
    del sample, Rh_s, Kh_s, Cs
    # Many bars feed the target from both sides but only use one side for long stretches, so
    # the sampled search can miss a side completely. Add the mirror image of any one-sided
    # zone; the presence test keeps it silent where no markers come from that side.
    mirrors = []
    for (x0, x1, v, shape), (tgt, how, votes) in zip(zs, targets):
        if not votes or tgt is None:
            continue
        other_side = [z for z in zs if z is not None and z[0] != x0 and
                      ((z[1] <= tgt + 16) if v < 0 else (z[0] >= tgt - 16))]
        # markers that run on past the target already use that side: nothing to mirror
        passes_through = (x0 < tgt - 32) if v < 0 else (x1 > tgt + 32)
        if other_side or passes_through:
            continue
        reach = (x1 - tgt) if v < 0 else (tgt - x0)
        mx0, mx1 = (max(0, tgt - reach), tgt) if v < 0 else (tgt, min(W, tgt + reach))
        if mx1 - mx0 < 64:
            continue
        cols = np.clip(2 * tgt - np.arange(W), 0, W - 1)
        mirrors.append(((mx0, mx1, -v, shape[cols]), (tgt, "mirror of " + how, True)))
    for z, tg in mirrors:
        zs.append(z)
        targets.append(tg)

    res = 4
    total_frames = int(duration * fps) + 1
    hist = np.zeros((total_frames + int(30 * fps)) * res)
    overlap = 0.0
    for (x0, x1, v, shape), (tgt, _, votes) in zip(zs, targets):
        if votes:
            overlap = max(overlap, float(np.sum(1.0 / np.abs(v * shape))) / fps + 1)
    overlap = min(overlap, 20.0)
    present_s = 0.0
    # One continuous decode of just the bar rows. Each block is processed together with the
    # tail of the previous one (markers already on screen), without decoding anything twice.
    rows = crop[1] - crop[0]
    frame_bytes = 3 * rows * W
    vf = f"fps={fps},scale={W}:{h},crop={W}:{rows}:0:{crop[0]}"
    net = ["-rw_timeout", "30000000"] if str(path).startswith(("http://", "https://")) else []
    proc = subprocess.Popen(["ffmpeg", "-v", "error", "-nostdin", *net, *FAST_DECODE, "-i", str(path), "-an",
                             "-vf", vf, "-f", "rawvideo", "-pix_fmt", "yuv444p", "-"],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    block = int(CHUNK_S * fps)
    keep = int(round(overlap * fps))
    tail = np.zeros((0, rows, W), np.uint8)
    done = 0  # absolute index of the first frame of the next block
    try:
        while True:
            raw = proc.stdout.read(block * frame_bytes)
            n = len(raw) // frame_bytes
            if n == 0:
                break
            new = to_channel(np.frombuffer(raw[:n * frame_bytes], np.uint8).reshape(n, 3, rows, W), channel)
            R = np.concatenate([tail, new]).astype(np.float32)
            skip = len(tail)
            offset = done - skip
            if len(R) >= 10:
                Kh = highpass(R.mean(1))
                chunk_present = 0.0
                for (x0, x1, v0, shape), (tgt, _, votes) in zip(zs, targets):
                    if not votes:
                        continue
                    # bars often speed up in later rounds: search well around the starting speed
                    v, fit = refine_velocity(Kh, x0, x1, v0, span=max(0.15, 0.35 * abs(v0)), step=0.05, shape=shape)
                    if fit < 0.05 or np.sign(v) != np.sign(v0):
                        v = v0
                    k = _k_for(v)
                    C = coherent(Kh, v, k, shape)
                    p = _presence(Kh, C, coherent(Kh, -v, k, shape), x0, x1, fps)
                    # stretches packed with evenly spaced markers fail the coherence test; if the
                    # strip still clearly moves at the bar's speed, count it and vote with the raw
                    # marker detail
                    dense = _shift_gain(Kh, v, k, x0, x1, fps, shape) & ~p
                    if dense.any():
                        C[dense] = np.abs(Kh[dense])
                        p = p | dense
                    p[:skip] = False  # the tail was voted on with the previous block
                    chunk_present = max(chunk_present, p.sum() / fps)
                    lo, hi = (min(tgt, x1), x1) if v < 0 else (x0, max(tgt, x0))
                    _vote(C, p, v, tgt, lo, hi, offset, hist, res, shape, dense)
                present_s += chunk_present
            done += n
            tail = R[-keep:].astype(np.uint8) if keep else tail[:0]
            if progress:
                progress(0.15 + 0.8 * min(1.0, done / fps / duration), "following the beat bar")
            if n < block:
                break
    finally:
        proc.stdout.close()
        proc.kill()
        proc.wait()
    beats = _peaks(hist, res, fps)
    details = {"rows": crop, "fps": fps,
               "zones": [{"x0": z[0], "x1": z[1], "speed": round(z[2], 2), "target": tg[0], "how": tg[1],
                          "profile": [round(float(z[3][c]), 2) for c in (z[0], (z[0] + z[1]) // 2, z[1] - 1)]}
                         for z, tg in zip(zs, targets)],
               "bar_seconds": round(present_s, 1), "duration": duration, "channel": channel}
    return beats, details


def to_actions(beats, max_speed=None, half=False):
    """Strokes from beat times, the way commercial fap hero scripts are made (checked against
    six releases and their beat tracks):

    full: the beat lands at the bottom (0), the top (100) sits halfway to the next beat.
    half: one direction change per beat, strictly alternating bottom/top, so half the speed.
    Every gap gets its stroke, however long (a long gap is just a slow stroke), and the script
    starts on the first beat and ends on the last. With max_speed (units per second), a move
    too fast for it is shortened at the end away from the beat; in full mode the beat stays
    at the bottom."""
    beats = np.asarray(beats, float)
    if len(beats) < 2:
        return []
    cap = float(max_speed) if max_speed else None

    def reach(seconds):
        return 100.0 if cap is None else min(100.0, cap * seconds)

    acts = []
    if half:
        gaps = np.diff(beats)
        for i, t in enumerate(beats):
            if i % 2 == 0:
                acts.append((t, 0.0))
            else:  # the top is reached from the beat before and left toward the beat after
                limit = min(gaps[i - 1], gaps[i]) if i < len(gaps) else gaps[i - 1]
                acts.append((t, reach(limit)))
    else:
        for i, t in enumerate(beats):
            acts.append((t, 0.0))
            if i + 1 < len(beats):
                half_gap = (beats[i + 1] - t) / 2
                acts.append((t + half_gap, reach(half_gap)))
    out = []
    for at, pos in acts:
        ms = int(round(at * 1000))
        if out and ms <= out[-1]["at"]:
            continue
        out.append({"at": ms, "pos": int(round(pos))})
    return out
