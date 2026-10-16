#!/usr/bin/env python3
"""Beat Script: download a video from a link and give it a funscript made from its music's beats.

Runs in the Alpine Stash image. Videos are fetched with yt-dlp (single-file build kept next
to this script); numpy is pip-installed into ./lib on first use for the beat analysis.

Modes (Stash passes them in args.mode):
  check     url=<link>              title/length/duplicate checks for the page
  download  url=<link>              download, write the beat script, queue scan + finalize
  finalize  url=<link> path=<file>  fill in the scene's title, URL, cover and tag after the scan
  scene     scene_id=<id>           make a beat script for a scene already in Stash
  (download and scene take method=auto|bar|music: auto follows an on-screen beat bar when the
   video has one, else the music)
  selftest                          run the beat engine on a synthetic click track
"""
import base64
import glob
import json
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

PLUGIN_ID = "beatScript"
UA = "Mozilla/5.0 (X11; Linux x86_64) StashBeatScript/0.1"
YTDLP_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp"
YTDLP_MAX_AGE = 30 * 86400
SCENE_WAIT_S = 15 * 60
HERE = Path(__file__).resolve().parent
LIB = HERE / "lib"

CURRENT_JOB = None  # prefixed to log lines so the page can follow each job separately


def _log(level, msg):
    if CURRENT_JOB and level != "p":
        msg = f"[{CURRENT_JOB}] {msg}"
    sys.stderr.write(f"\x01{level}\x02{msg}\n")
    sys.stderr.flush()


def info(msg):
    _log("i", msg)


def warn(msg):
    _log("w", msg)


def error(msg):
    _log("e", msg)


def progress(p):
    _log("p", f"{max(0.0, min(1.0, p)):.3f}")


class Stash:
    def __init__(self, conn):
        host = conn.get("Host") or "localhost"
        if host == "0.0.0.0":
            host = "localhost"
        self.url = f"{conn.get('Scheme', 'http')}://{host}:{conn.get('Port', 9999)}/graphql"
        self.headers = {"Content-Type": "application/json"}
        cookie = conn.get("SessionCookie") or {}
        if cookie.get("Value"):
            self.headers["Cookie"] = f"{cookie.get('Name', 'session')}={cookie['Value']}"

    def gql(self, query, variables=None):
        body = json.dumps({"query": query, "variables": variables or {}}).encode()
        req = urllib.request.Request(self.url, body, self.headers)
        with urllib.request.urlopen(req, timeout=120) as r:
            out = json.load(r)
        if out.get("errors"):
            raise RuntimeError(out["errors"][0]["message"])
        return out["data"]


def http_get(url, timeout=30):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=timeout) as r:
        return r.read()


def safe_name(s):
    s = re.sub(r'[\\/:*?"<>|\x00-\x1f]', " ", s or "")
    s = re.sub(r"\s+", " ", s).strip(" .")
    return s[:150] or "video"


def job_key(url):
    """Short stable id for a link, used to tag log lines."""
    import hashlib
    return hashlib.sha1(url.strip().encode()).hexdigest()[:10]


# ---------- dependencies ----------

def beat_engine():
    """Import beat_engine, pip-installing numpy into ./lib the first time."""
    sys.path.insert(0, str(LIB))
    try:
        import numpy  # noqa: F401
    except ImportError:
        info("first run: installing numpy for the beat analysis (about 15 s)")
        r = subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "--disable-pip-version-check",
                            "--break-system-packages", "--root-user-action=ignore", "--target", str(LIB), "numpy"],
                           capture_output=True, text=True)
        if r.returncode != 0:
            raise RuntimeError("couldn't install numpy: " + r.stderr.strip()[-300:])
        import importlib
        importlib.invalidate_caches()
    sys.path.insert(0, str(HERE))
    import beat_engine as be
    return be


def ytdlp_path():
    p = HERE / "yt-dlp"
    if not p.exists() or time.time() - p.stat().st_mtime > YTDLP_MAX_AGE:
        info("fetching latest yt-dlp")
        try:
            tmp = p.with_suffix(".new")
            tmp.write_bytes(http_get(YTDLP_URL, timeout=180))
            tmp.replace(p)
        except Exception as e:
            if not p.exists():
                raise RuntimeError(f"couldn't download yt-dlp: {e}")
            warn(f"couldn't update yt-dlp, using existing copy: {e}")
    return p


# ---------- yt-dlp ----------

def pmvhaven_info(vid, max_height):
    """yt-dlp has no PMVHaven extractor, so use its open API (same as the FapTap Import plugin)."""
    v = json.loads(http_get(f"https://pmvhaven.com/api/videos/{vid}"))["data"]
    duration = v.get("durationSeconds") or 0
    variants = sorted((x for x in v.get("hlsVariants") or [] if x.get("playlistUrl") and x.get("height")),
                      key=lambda x: x["height"], reverse=True)
    capped = [x for x in variants if max_height and x["height"] <= int(max_height)]
    if capped and (v.get("height") or 0) > int(max_height or 0):
        src, size = capped[0]["playlistUrl"], int((capped[0].get("bandwidth") or 5_000_000) / 8 * duration)
    elif v.get("videoUrl"):
        src, size = v["videoUrl"], v.get("fileSize") or int(duration * 2_000_000)
    elif variants:
        src, size = variants[0]["playlistUrl"], int((variants[0].get("bandwidth") or 5_000_000) / 8 * duration)
    else:
        raise RuntimeError("PMVHaven has no downloadable copy of this video")
    sizes = v.get("thumbnailSizes") or {}
    creators = [c for c in v.get("creator") or [] if c]
    return {"webpage_url": f"https://pmvhaven.com/video/{vid}", "id": vid, "title": v.get("title"),
            "duration": duration, "uploader": creators[0] if creators else v.get("uploaderUsername") or "",
            "extractor_key": "PMVHaven", "filesize_approx": size, "download_url": src,
            "thumbnail": (sizes.get("lg") or {}).get("url") or v.get("thumbnailUrl"),
            "has_scripts": bool(v.get("userFunScripts"))}


def link_info(url, settings):
    m = re.search(r"pmvhaven\.com/videos?/(?:[^/?#\s]*_)?([0-9a-f]{24})\b", url)
    if m:
        return pmvhaven_info(m.group(1), settings.get("maxHeight"))
    return ytdlp_info(url)


def ytdlp_info(url):
    r = subprocess.run([sys.executable, str(ytdlp_path()), "-J", "--no-playlist", "--no-warnings", url],
                       capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        msg = (r.stderr.strip().splitlines() or ["unknown error"])[-1]
        raise RuntimeError("yt-dlp can't read this link: " + re.sub(r"^ERROR:\s*", "", msg))
    return json.loads(r.stdout)


def fmt_selector(max_height):
    if max_height:
        h = int(max_height)
        return f"bv*[height<={h}]+ba/b[height<={h}]/bv*+ba/b"
    return "bv*+ba/b"


def ytdlp_download(url, dest_dir, base, max_height):
    """Download url to dest_dir/base.<ext>. Returns the final Path, or None on failure."""
    cmd = [sys.executable, str(ytdlp_path()),
           "--no-playlist", "--newline", "--progress",
           "--progress-template",
           "download:PROGRESS %(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s",
           "--print", "after_move:FINAL %(filepath)s",
           "--socket-timeout", "30", "--retries", "5", "--fragment-retries", "10",
           "--concurrent-fragments", "4",
           "-f", fmt_selector(max_height), "--merge-output-format", "mp4",
           "-o", str(dest_dir / (base.replace("%", "%%") + ".%(ext)s")), url]
    final, last_pct, tail = None, -1, []
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    for line in proc.stdout:
        line = line.strip()
        m = re.search(r"PROGRESS\s+([\d.]+)%\|([^|]*)\|(.*)", line)
        if m:
            pct = float(m.group(1))
            if int(pct) != last_pct:
                last_pct = int(pct)
                progress(pct / 100 * 0.85)
                if last_pct % 5 == 0:
                    info(f"downloading: {last_pct}% at {m.group(2).strip()}, {m.group(3).strip()} left")
            continue
        if line.startswith("FINAL "):
            final = Path(line[6:])
        elif line:
            tail = (tail + [line])[-5:]
    proc.wait()
    if proc.returncode == 0 and final and final.exists():
        return final
    warn("yt-dlp failed: " + " | ".join(tail))
    for leftover in dest_dir.glob(glob.escape(base) + ".*"):
        if ".part" in leftover.name or leftover.name.endswith(".ytdl"):
            leftover.unlink(missing_ok=True)
    return None


# ---------- Stash helpers ----------

def plugin_settings(stash):
    return stash.gql("{ configuration { plugins } }")["configuration"]["plugins"].get(PLUGIN_ID) or {}


def scene_by_url(stash, url):
    d = stash.gql("""query($u: String!) { findScenes(
        scene_filter: {url: {value: $u, modifier: EQUALS}}, filter: {per_page: 1}) {
        scenes { id } } }""", {"u": url})
    s = d["findScenes"]["scenes"]
    return s[0]["id"] if s else None


def scene_by_path(stash, path):
    d = stash.gql("""query($p: String!) { findScenes(
        scene_filter: {path: {value: $p, modifier: EQUALS}}, filter: {per_page: 5}) {
        scenes { id urls tags { id } files { path } } } }""", {"p": path})
    for s in d["findScenes"]["scenes"]:
        if any(f["path"] == path for f in s["files"]):
            return s
    return None


def ensure_tag(stash, name):
    d = stash.gql("""query($n: String!) { findTags(tag_filter: {name: {value: $n, modifier: EQUALS}},
        filter: {per_page: 1}) { tags { id } } }""", {"n": name})
    if d["findTags"]["tags"]:
        return d["findTags"]["tags"][0]["id"]
    return stash.gql("mutation($n: String!) { tagCreate(input: {name: $n}) { id } }", {"n": name})["tagCreate"]["id"]


def engine_opts(settings):
    def num(key):
        v = settings.get(key)
        return float(v) if v not in (None, "", 0) else None
    return {"min_amplitude": num("minAmplitude"), "max_speed": num("maxSpeed"),
            "min_stroke_ms": num("minStrokeMs")}


METHODS = ("auto", "bar", "music")


def bar_script(video, settings, span):
    """Beats from an on-screen beat bar. Returns (beat times, summary) or raises RuntimeError."""
    sys.path.insert(0, str(HERE))
    import bar_engine
    lo, hi = span
    last = [-1.0]

    def prog(p, msg):
        progress(lo + (hi - lo) * p)
        step = int(p * 10)
        if step != last[0]:
            last[0] = step
            info(f"{msg}: {int(p * 100)}%")
    info("looking for an on-screen beat bar")
    beats, d = bar_engine.find_beats(video, progress=prog)
    if len(beats) < 20 or d["bar_seconds"] < min(30, 0.1 * d["duration"]):
        raise RuntimeError(f"a bar-like strip was found but only {d['bar_seconds']:.0f} s of it moved like a beat bar")
    voting = [z for z in d["zones"] if z["target"] is not None]
    how = voting[0]["how"] if voting else "?"
    bpm = 60 / float(sorted(b - a for a, b in zip(beats, beats[1:]))[len(beats) // 2])
    summary = (f"{len(beats)} beats from the beat bar (target found by {how}), bar on screen "
               f"{d['bar_seconds'] / 60:.1f} of {d['duration'] / 60:.1f} min, typical {bpm:.0f} BPM")
    return list(beats), summary


def save_variants(be, video, title, variants, active_label, make_active, beats=None):
    """Write each variant as "<video> <label>.funscript" (the naming Stash Interactive Tools lists) and decide the
    active <video>.funscript: set it when there is none, or when make_active is set (the script
    that was active is kept first as "<video> Original.funscript")."""
    video = Path(video)
    main = video.with_suffix(".funscript")
    # what the siblings held before this run, so re-scripting doesn't save the old active script
    # as "Original" just because its variant file is being rewritten
    before = {p.read_bytes() for p in video.parent.glob(glob.escape(video.stem) + " *.funscript")}
    texts = {}
    for label, (actions, description) in variants.items():
        data = be.funscript(actions, title)
        data["metadata"]["description"] = description
        if beats is not None:  # exact beat times (ms) for the Beat Bar overlay plugin
            data["beats"] = [int(round(b * 1000)) for b in beats]
        texts[label] = json.dumps(data, separators=(",", ":"))
        video.with_name(f"{video.stem} {label}.funscript").write_text(texts[label])
    if main.exists() and not make_active:
        info(f"kept the scene's current script active; the new versions are in the Interactive tab ({', '.join(variants)})")
        return False
    if main.exists():
        current = main.read_bytes()
        if current not in before and not any(t.encode() == current for t in texts.values()):
            keep, n = video.with_name(f"{video.stem} Original.funscript"), 2
            while keep.exists():
                keep, n = video.with_name(f"{video.stem} Original {n}.funscript"), n + 1
            keep.write_bytes(current)
            info(f"kept the previous script as {keep.name}")
    main.write_text(texts[active_label])
    info(f"active script: {active_label}")
    return True


def write_script(be, video, settings, title, method="auto", span=(0.0, 0.95), strokes="full", make_active=True):
    """Beat script(s) for one video: FULL and HALF versions (plus the loudness-shaped "Music" one
    when scripting from the music), all selectable in Stash Interactive Tools. `strokes` picks which is
    active: "full", "half", or "music" (the loudness-shaped one; for a beat bar video, FULL)."""
    sys.path.insert(0, str(HERE))
    import bar_engine
    method = method if method in METHODS else "auto"
    max_speed = engine_opts(settings)["max_speed"]  # empty = full strokes, like commercial FULL scripts
    half_label = "HALF" if strokes == "half" else "FULL"
    if method in ("auto", "bar"):
        try:
            beats, summary = bar_script(video, settings, span)
            desc = "Generated automatically from the on-screen beat bar"
            variants = {"Beat Bar FULL": (bar_engine.to_actions(beats, max_speed=max_speed), desc + " (one stroke per beat)"),
                        "Beat Bar HALF": (bar_engine.to_actions(beats, max_speed=max_speed, half=True), desc + " (half speed)")}
            save_variants(be, video, title, variants, "Beat Bar " + half_label, make_active, beats)
            info(f"saved beat script: {summary}")
            return Path(video).with_suffix(".funscript"), {"source": "bar"}
        except RuntimeError as e:
            if method == "bar":
                raise
            info(f"{e}; using the music instead")
    info("analysing the music")
    actions, stats = be.generate(video, **engine_opts(settings))
    if len(actions) < 10:
        raise RuntimeError("couldn't find a beat in this video's audio")
    beats = stats.pop("beat_times")
    desc = "Generated automatically from the music's beats"
    variants = {"Music": (actions, desc + " (deeper when louder)"),
                "Music FULL": (bar_engine.to_actions(beats, max_speed=max_speed), desc + " (one stroke per beat)"),
                "Music HALF": (bar_engine.to_actions(beats, max_speed=max_speed, half=True), desc + " (half speed)")}
    save_variants(be, video, title, variants, "Music" if strokes == "music" else "Music " + half_label, make_active, beats)
    info(f"saved beat script: {stats['beats']} beats from the music, about {stats['bpm_median']:.0f} BPM"
         + (f" ({stats['bpm_min']:.0f}-{stats['bpm_max']:.0f} BPM across songs)"
            if stats["bpm_max"] - stats["bpm_min"] > 10 else ""))
    return Path(video).with_suffix(".funscript"), stats


def dest_dir(settings):
    return Path(settings.get("downloadDir") or "/data/PMV")


def plan_base(folder, title, vid):
    base = safe_name(title)
    if folder.exists() and any(p for p in folder.glob(glob.escape(base) + ".*") if ".part" not in p.name):
        base = f"{base} [{vid}]"
    return base


# ---------- tasks ----------

def task_check(stash, args, settings):
    url = (args.get("url") or "").strip()
    if not re.match(r"https?://", url):
        raise ValueError("paste a full link starting with http:// or https://")
    meta = link_info(url, settings)
    page = meta.get("webpage_url") or url
    problems = []
    existing = scene_by_url(stash, page)
    if existing:
        problems.append("Already in Stash.")
    folder = dest_dir(settings)
    probe = folder if folder.exists() else folder.parent
    free = shutil.disk_usage(probe).free if probe.exists() else None
    if free is None:
        problems.append(f"Download folder {folder} isn't reachable from Stash.")
    est = meta.get("filesize_approx") or int((meta.get("duration") or 300) * 1_000_000)
    if free is not None and free < est * 2:
        problems.append("Not enough free disk space.")
    if meta.get("_type") == "playlist":
        problems.append("That link is a playlist; paste a single video.")
    warnings = []
    if meta.get("has_scripts"):
        warnings.append("PMVHaven already has hand-made scripts for this video; the FapTap Import button can fetch those instead.")
    if meta.get("acodec") == "none" and not any((f.get("acodec") or "none") != "none" for f in meta.get("formats") or []):
        warnings.append("No audio track found, so there are no beats to follow.")
    return {
        "key": job_key(page), "link": page, "title": meta.get("title") or "video",
        "duration": meta.get("duration") or 0, "uploader": meta.get("uploader") or "",
        "site": meta.get("extractor_key") or "", "thumbnail": meta.get("thumbnail"),
        "existing_scene": existing, "dest_path": str(folder / plan_base(folder, meta.get("title"), meta.get("id"))) + ".mp4",
        "est_bytes": est, "free_bytes": free, "problems": problems, "warnings": warnings,
    }


def task_download(stash, args, settings):
    url = args["url"].strip()
    be = beat_engine()
    meta = link_info(url, settings)
    page = meta.get("webpage_url") or url
    existing = scene_by_url(stash, page)
    if existing:
        info(f"{page} is already in Stash as scene {existing}")
        return f"already in Stash as scene {existing}"
    title = meta.get("title") or "video"
    info(f"downloading \"{title}\"")
    folder = dest_dir(settings)
    folder.mkdir(parents=True, exist_ok=True)
    path = ytdlp_download(meta.get("download_url") or url, folder, plan_base(folder, title, meta.get("id")),
                          settings.get("maxHeight"))
    if not path:
        raise RuntimeError("video download failed")
    info(f"saved video: {path}")
    progress(0.85)
    write_script(be, path, settings, title, args.get("method"), span=(0.85, 0.97), strokes=args.get("strokes") or "full")
    progress(0.97)
    stash.gql("mutation($p: [String!]) { metadataScan(input: {paths: $p}) }", {"p": [str(path.parent)]})
    stash.gql("""mutation($a: Map) { runPluginTask(plugin_id: "beatScript", task_name: "Finalize",
        args_map: $a) }""", {"a": {"mode": "finalize", "url": page, "path": str(path), "title": title,
                                    "thumbnail": meta.get("thumbnail") or "", "key": job_key(page)}})
    info("queued a folder scan and the metadata step")
    progress(1)
    return f"downloaded {path.name}"


def fetch_cover(url):
    if not url:
        return None
    try:
        data = http_get(url, timeout=60)
    except Exception as e:
        warn(f"thumbnail unavailable ({e})")
        return None
    mime = ("image/jpeg" if data[:3] == b"\xff\xd8\xff" else "image/png" if data[:8] == b"\x89PNG\r\n\x1a\n"
            else "image/webp" if data[:4] == b"RIFF" and data[8:12] == b"WEBP" else None)
    return f"data:{mime};base64," + base64.b64encode(data).decode() if mime else None


def tag_scene(stash, scene, settings, extra=None):
    tag_name = (settings.get("tagName") or "Beat script (auto)").strip()
    tag_ids = [t["id"] for t in scene["tags"]]
    if tag_name:
        tid = ensure_tag(stash, tag_name)
        if tid not in tag_ids:
            tag_ids.append(tid)
    inp = dict(extra or {}, id=scene["id"], tag_ids=tag_ids)
    return stash.gql("mutation($i: SceneUpdateInput!) { sceneUpdate(input: $i) { id interactive } }", {"i": inp})


def queue_sit_refresh(stash):
    """Queue Stash Interactive Tools' tag + remap behind our scan/heatmap jobs (Stash runs jobs in
    order), so the [SIT: Multi-Script] tag and SIT's stacked heatmap aren't replaced by Stash's
    single one. Skipped quietly when SIT isn't installed."""
    try:
        for task in ("tag", "remap"):
            stash.gql('mutation($t: String!) { runPluginTask(plugin_id: "StashInteractiveTools", task_name: $t) }', {"t": task})
        info("queued Stash Interactive Tools tag + remap")
    except Exception as e:
        info(f"Stash Interactive Tools not refreshed ({e})")


def task_finalize(stash, args, settings):
    path, url = args["path"], args["url"]
    deadline = time.time() + SCENE_WAIT_S
    scene = scene_by_path(stash, path)
    while not scene and time.time() < deadline:
        time.sleep(5)
        scene = scene_by_path(stash, path)
    if not scene:
        raise RuntimeError(f"no scene found for {path}; scan the folder, then run Finalize again")
    urls = list(dict.fromkeys((scene.get("urls") or []) + [url]))
    extra = {"title": args.get("title") or Path(path).stem, "urls": urls}
    cover = fetch_cover(args.get("thumbnail"))
    try:
        res = tag_scene(stash, scene, settings, dict(extra, cover_image=cover) if cover else extra)
    except Exception as e:
        warn(f"cover image rejected ({e}); saving without it")
        res = tag_scene(stash, scene, settings, extra)
    if res["sceneUpdate"]["interactive"]:
        stash.gql("""mutation($ids: [ID!]) { metadataGenerate(input: {interactiveHeatmapsSpeeds: true,
            sceneIDs: $ids}) }""", {"ids": [scene["id"]]})
        queue_sit_refresh(stash)
    pull_site_metadata(stash, url, path)
    info(f"scene {scene['id']} ready")
    return f"scene {scene['id']} ready"


def pull_site_metadata(stash, url, path):
    """PMVHaven links: let FapTap Import fill in tags, performers, studio, uploader, date and details.
    It runs after this update, so it keeps the tag set above."""
    m = re.search(r"pmvhaven\.com/videos?/(?:[^/?#\s]*_)?([0-9a-f]{24})\b", url)
    if not m:
        return
    plugins = stash.gql("{ plugins { id enabled } }")["plugins"] or []
    if not any(p["id"] == "faptapImport" and p["enabled"] for p in plugins):
        info("FapTap Import isn't enabled, so only the title, link and cover were set")
        return
    stash.gql("""mutation($a: Map) { runPluginTask(plugin_id: "faptapImport", task_name: "Finalize import",
        args_map: $a) }""", {"a": {"mode": "finalize", "site": "pmvhaven", "id": m.group(1), "path": path}})
    info("queued FapTap Import to add PMVHaven's tags, performers and details")


def task_scene(stash, args, settings):
    sid = str(args.get("scene_id") or "").strip()
    d = stash.gql("""query($id: ID!) { findScene(id: $id) { id title interactive tags { id }
        files { path } } }""", {"id": sid})
    scene = d["findScene"]
    if not scene or not scene["files"]:
        raise RuntimeError(f"scene {sid} not found or has no file")
    video = Path(scene["files"][0]["path"])
    be = beat_engine()
    write_script(be, video, settings, scene.get("title") or video.stem, args.get("method"), span=(0.0, 0.9),
                 strokes=args.get("strokes") or "full", make_active=bool(args.get("overwrite")))
    # Stash runs one job at a time, so the scan only starts after this task ends. Queue the scan
    # (marks the scene interactive) and then the heatmap job behind it instead of waiting here.
    stash.gql("mutation($p: [String!]) { metadataScan(input: {paths: $p}) }", {"p": [str(video)]})
    tag_scene(stash, scene, settings)
    stash.gql("""mutation($ids: [ID!]) { metadataGenerate(input: {interactiveHeatmapsSpeeds: true,
        sceneIDs: $ids, overwrite: true}) }""", {"ids": [sid]})
    queue_sit_refresh(stash)
    info(f"scene {sid} has a beat script")
    return f"scene {sid} scripted"


def task_selftest(stash, args, settings):
    """Run the beat engine on a synthetic 120 BPM click track; nothing touches the library."""
    import tempfile
    be = beat_engine()
    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "click.wav"
        subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i",
                        "aevalsrc=sin(2*PI*60*t)*exp(-30*mod(t\\,0.5)):s=22050:d=30", str(wav)], check=True)
        actions, stats = be.generate(wav)
    return {"actions": len(actions), **{k: round(v, 1) for k, v in stats.items()}}


def main():
    global CURRENT_JOB
    raw = sys.stdin.read()
    data = json.loads(raw) if raw.strip() else {}
    args = data.get("args") or {}
    try:
        mode = args.get("mode")
        if mode in ("download", "finalize"):
            CURRENT_JOB = args.get("key") or job_key(args.get("url", ""))
        elif mode == "scene":
            CURRENT_JOB = "scene-" + str(args.get("scene_id"))
        stash = Stash(data.get("server_connection") or {})
        settings = plugin_settings(stash)
        tasks = {"selftest": task_selftest, "check": task_check, "download": task_download, "finalize": task_finalize, "scene": task_scene}
        if mode not in tasks:
            raise ValueError(f"unknown mode {mode!r}")
        print(json.dumps({"output": tasks[mode](stash, args, settings)}))
    except Exception as e:
        error(f"Beat script failed: {e}")
        print(json.dumps({"error": str(e)}))


if __name__ == "__main__":
    main()
