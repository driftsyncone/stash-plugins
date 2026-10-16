(function () {
  "use strict";

  // Stash UI (the "stashui" plugin's interface) loads this file through our assets/stashui.js and sets
  // window.StashUIHost first. In classic Stash it's undefined and everything works as before.
  const uiHost = () => window.StashUIHost || null;
  function pageSceneId() {
    const h = uiHost();
    if (h) return h.sceneId();
    const m = location.pathname.match(/^\/scenes\/(\d+)/);
    return m ? m[1] : null;
  }
  const routeKey = () => (uiHost() ? "stashui:" + uiHost().sceneId() : location.pathname);

  // Beat Bar: a fap-hero style beat bar over PMVs that don't have one. Beats come from the
  // scene's script: the exact "beats" list Beat Script writes into its scripts, else the
  // bottoms of the strokes. Follows the script picked in Stash Interactive Tools. Drawing is
  // done by a theme (see beatBar.theme.classic.js).

  const PLUGIN_ID = "beatBar";
  const DEFAULT_SHOW = "PMV, HMV, Beat script (auto)";
  const DEFAULT_SKIP = "Beat meter, Fap Hero, Cock Hero";

  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem("beatBar:" + k);
        return v === null ? d : JSON.parse(v);
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem("beatBar:" + k, JSON.stringify(v));
      } catch (e) {
        /* private mode: not remembered */
      }
    },
  };

  const tagList = (s, d) => String(s || d).split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);

  // ---------- beats ----------

  let sceneId = null;
  let eligible = false; // tags say this scene should get a bar
  let beats = []; // seconds, sorted
  let defaultBeats = null; // the "beats" list from the scene's own script file, if any

  // Beat Script music scripts from before it stored "beats" (and its half-speed ones) move once per beat – up on one,
  // down on the next – so every point is a beat; only its rests sit at the middle (50). Its one-stroke-per-beat
  // scripts put the beats at the bottoms, like most scripts.
  const everyPointIsBeat = (fs) => {
    const m = (fs && fs.metadata) || {};
    return m.creator === "beatScript" && /music's beats/i.test(m.description || "") && !/one stroke per beat/i.test(m.description || "");
  };

  // Beat times from a funscript: its "beats" list, else the bottoms of its strokes.
  function beatsOf(fs) {
    if (Array.isArray(fs.beats) && fs.beats.length) return fs.beats.map((ms) => ms / 1000).sort((a, b) => a - b);
    if (defaultBeats) return defaultBeats;
    const a = (Array.isArray(fs.actions) ? fs.actions : []).slice().sort((p, q) => p.at - q.at);
    if (everyPointIsBeat(fs)) return a.filter((x) => x.pos !== 50).map((x) => x.at / 1000);
    const out = [];
    for (let i = 0; i < a.length; i++) {
      const prev = a[i - 1], next = a[i + 1];
      if ((!prev || a[i].pos <= prev.pos) && (!next || a[i].pos < next.pos) && (prev || next)) out.push(a[i].at / 1000);
    }
    return out;
  }

  // Scripts made from an on-screen bar belong to videos that already have one.
  const fromBar = (fs) => /on-screen beat bar/i.test(((fs && fs.metadata) || {}).description || "");

  let scriptFromBar = false;

  function useScript(fs) {
    scriptFromBar = fromBar(fs);
    beats = beatsOf(fs);
  }

  // Stash Interactive Tools hands its chosen script to the player as a text/plain blob: URL.
  const sitPicks = {}; // sceneId -> { fs, at }
  const createObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const url = createObjectURL.apply(this, arguments);
    const m = [null, pageSceneId()];
    if (m[1] && obj instanceof Blob && obj.type.startsWith("text/plain") && obj.size < 50e6) {
      obj.text().then((text) => {
        let fs;
        try {
          fs = JSON.parse(text);
        } catch (e) {
          return;
        }
        if (!fs || !Array.isArray(fs.actions)) return;
        sitPicks[m[1]] = { fs, at: Date.now() };
        if (m[1] === sceneId) useScript(fs);
      }).catch(() => {});
    }
    return url;
  };

  async function loadScene(id) {
    const r = await fetch("/graphql", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "query($id: ID!) { findScene(id: $id) { interactive tags { name } paths { funscript } } configuration { plugins } }",
        variables: { id },
      }),
    });
    const d = (await r.json()).data || {};
    const scene = d.findScene;
    if (id !== sceneId || !scene || !scene.interactive || !scene.paths.funscript) return;
    const settings = ((d.configuration || {}).plugins || {})[PLUGIN_ID] || {};
    readConfig(settings);
    const tags = scene.tags.map((t) => t.name.toLowerCase());
    const show = tagList(settings.showTags, DEFAULT_SHOW), skip = tagList(settings.skipTags, DEFAULT_SKIP);
    themeName = String(settings.theme || "classic").trim().toLowerCase();
    if (!tags.some((t) => show.includes(t)) || tags.some((t) => skip.includes(t))) return;
    const u = new URL(scene.paths.funscript, location.href); // path only: works over any hostname
    const res = await fetch(u.pathname + u.search, { credentials: "same-origin" });
    if (!res.ok || id !== sceneId) return;
    const fs = JSON.parse(await res.text());
    if (Array.isArray(fs.beats) && fs.beats.length) defaultBeats = fs.beats.map((ms) => ms / 1000).sort((a, b) => a - b);
    if (sitPicks[id]) useScript(sitPicks[id].fs); // Interactive Tools' choice wins if it came first
    else useScript(fs);
    eligible = true;
  }

  function firstAtOrAfter(t) {
    let lo = 0, hi = beats.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (beats[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // ---------- settings ----------

  const cfg = { size: 1, top: false, lookahead: 0, offset: 0, opacity: 1, bpm: true, flash: false, tempo: true };

  function num(v, d, lo, hi) {
    const n = parseFloat(v);
    return isFinite(n) && n > 0 ? Math.max(lo, Math.min(hi, n)) : d;
  }

  function readConfig(st) {
    cfg.size = num(st.size, 100, 40, 250) / 100;
    cfg.top = String(st.position || "").trim().toLowerCase() === "top";
    cfg.lookahead = num(st.lookahead, 0, 0.5, 8);
    cfg.offset = isFinite(parseFloat(st.offsetMs)) ? Math.max(-2000, Math.min(2000, parseFloat(st.offsetMs))) : 0;
    cfg.opacity = num(st.opacity, 100, 10, 100) / 100;
    cfg.bpm = !st.hideBpm;
    cfg.flash = !!st.beatFlash;
    cfg.tempo = !st.noTempoColors;
  }

  // ---------- colours ----------

  function hexRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function mix(a, b, k) {
    const x = hexRgb(a), y = hexRgb(b);
    if (!x || !y) return a;
    const c = x.map((v, i) => Math.round(v + (y[i] - v) * k));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }

  // 0 at 80 BPM or slower, 1 at 240 BPM or faster
  const heatOf = (gap) => (isFinite(gap) ? Math.max(0, Math.min(1, (0.75 - gap) / 0.5)) : 0);

  // ---------- overlay ----------

  let themeName = "classic";
  let root = null, canvas = null, ctx = null, toggle = null, themeBtn = null, flash = null, toolsEl = null;

  function theme() {
    const all = window.BeatBarThemes || {};
    return all[store.get("theme", "")] || all[themeName] || all.classic;
  }

  function build() {
    root = document.createElement("div");
    root.className = "bb-root";
    canvas = document.createElement("canvas");
    canvas.className = "bb-canvas kb-nsfw-keep"; // a drawing, not media: Stash UI's NSFW blur must skip it
    ctx = canvas.getContext("2d");
    toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "bb-toggle";
    const stop = (e) => e.stopPropagation(); // keep video.js from treating it as play/pause
    ["pointerdown", "mousedown", "touchstart", "dblclick"].forEach((ev) => toggle.addEventListener(ev, stop));
    toggle.addEventListener("click", (e) => {
      stop(e);
      store.set("collapsed", !store.get("collapsed", false));
      refresh();
    });
    themeBtn = document.createElement("button");
    themeBtn.type = "button";
    themeBtn.className = "bb-toggle bb-theme";
    themeBtn.title = "Switch the beat bar's look (remembered in this browser)";
    ["pointerdown", "mousedown", "touchstart", "dblclick"].forEach((ev) => themeBtn.addEventListener(ev, stop));
    themeBtn.addEventListener("click", (e) => {
      stop(e);
      const names = Object.keys(window.BeatBarThemes || {});
      const cur = names.indexOf(Object.keys(window.BeatBarThemes || {}).find((k) => window.BeatBarThemes[k] === theme()));
      store.set("theme", names[(cur + 1) % names.length]);
      refresh();
    });
    const tools = document.createElement("div");
    tools.className = "bb-tools";
    toolsEl = tools;
    tools.append(toggle, themeBtn);
    root.append(canvas, tools);
    refresh();
  }

  function refresh() {
    const collapsed = store.get("collapsed", false);
    root.classList.toggle("bb-collapsed", collapsed);
    toggle.textContent = collapsed ? "Beat bar" : "Hide beat bar";
    themeBtn.hidden = collapsed;
    const th = theme();
    themeBtn.textContent = "Theme: " + (th ? th.name : "?");
  }

  // Stash UI on a phone held upright: the bar stays on the picture, its buttons go in the strip under it (dock())
  // so they aren't hit when using the seek bar
  function placeTools() {
    if (!toolsEl || !root) return;
    const h = uiHost();
    const dock = h && h.dock ? h.dock() : null;
    const want = dock || root;
    if (toolsEl.parentElement !== want) want.appendChild(toolsEl);
  }

  function player() {
    if (uiHost()) return uiHost().player();
    return document.querySelector(".scene-player-container .video-js") || document.querySelector(".video-js");
  }

  function place(vjs, th) {
    // just above the control row and seek bar while they show; bottom edge when they hide
    const h = uiHost();
    const hidden = h ? h.controlsHidden() : vjs.classList.contains("vjs-user-inactive") && !vjs.classList.contains("vjs-paused");
    let bottom = h ? h.controlsHeight() : 0;
    if (!hidden && !h) {
      const box = vjs.getBoundingClientRect();
      vjs.querySelectorAll(".vjs-control-bar, .vjs-progress-control").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.height && r.top < box.bottom) bottom = Math.max(bottom, Math.round(box.bottom - r.top));
      });
    }
    const height = root.classList.contains("bb-collapsed") ? 26 : Math.round(th.height(vjs.clientHeight) * cfg.size);
    if (cfg.top) {
      root.style.bottom = "auto";
      root.style.top = "6px";
    } else if (root.style.bottom !== bottom + "px") {
      root.style.top = "auto";
      root.style.bottom = bottom + "px";
    }
    root.classList.toggle("bb-top", cfg.top);
    canvas.style.opacity = cfg.opacity;
    if (root.style.height !== height + "px") root.style.height = height + "px";
  }

  function draw() {
    requestAnimationFrame(draw);
    if (!root || !root.isConnected || document.hidden) return;
    const th = theme();
    if (!th) return;
    const vjs = root.parentElement;
    place(vjs, th);
    if (root.classList.contains("bb-collapsed")) {
      if (flash && flash.isConnected) flash.remove();
      return;
    }
    const video = uiHost() ? uiHost().video() : vjs.querySelector("video");
    const t = (video ? video.currentTime : 0) - cfg.offset / 1000; // positive offset = beats later
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const scale = cfg.lookahead ? cfg.lookahead / th.ahead : 1;
    const ahead = th.ahead * scale, behind = th.behind * scale;
    const from = firstAtOrAfter(t - behind);
    const to = firstAtOrAfter(t + ahead);
    const list = [];
    for (let i = from; i < to; i++) {
      const gap = i + 1 < beats.length ? beats[i + 1] - beats[i] : i > 0 ? beats[i] - beats[i - 1] : Infinity;
      list.push({ t: beats[i], dt: beats[i] - t, gap, heat: heatOf(gap), i });
    }
    const n = firstAtOrAfter(t); // next beat index
    const last = n > 0 ? beats[n - 1] : null, next = n < beats.length ? beats[n] : null;
    const since = last === null ? Infinity : t - last;
    const c = th.colors || {};
    const view = {
      W, H, t, beats: list, ahead, behind,
      pulse: Math.exp(-since * 9),
      progress: last !== null && next !== null ? (t - last) / (next - last) : 0,
      colors: c,
      // marker colour for a beat: the theme's marker colour, heating toward its "hot" colour in fast sections
      heatColor: (b, base = c.marker, hot = c.hot) => (cfg.tempo && hot ? mix(base, hot, b.heat) : base),
      mix,
    };
    ctx.save();
    try {
      th.draw(ctx, view);
    } catch (e) {
      console.warn("[beatBar] theme", e);
    }
    ctx.restore();

    if (cfg.bpm) {
      const gaps = [];
      for (let i = Math.max(1, firstAtOrAfter(t - 4)); i < Math.min(beats.length, firstAtOrAfter(t + 4)); i++) gaps.push(beats[i] - beats[i - 1]);
      if (gaps.length > 2) {
        gaps.sort((a, b) => a - b);
        const bpm = Math.round(60 / gaps[gaps.length >> 1]);
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.font = "700 11px system-ui, sans-serif";
        ctx.textAlign = "right";
        ctx.textBaseline = "top";
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(0,0,0,0.7)";
        ctx.strokeText(bpm + " BPM", W - 8, 2);
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.fillText(bpm + " BPM", W - 8, 2);
      }
    }

    if (cfg.flash) {
      const screen = uiHost() ? uiHost().player() : vjs; // the glow goes on the picture, also when the bar is in the strip
      if (screen && (!flash || flash.parentElement !== screen)) {
        flash = flash || Object.assign(document.createElement("div"), { className: "bb-flash" });
        screen.appendChild(flash);
      }
      flash.style.boxShadow = `inset 0 0 ${Math.round((screen || vjs).clientHeight * 0.12)}px ${c.flash || c.target || "#ffffff"}`;
      flash.style.opacity = (0.6 * view.pulse).toFixed(3);
    } else if (flash && flash.isConnected) {
      flash.remove();
    }
  }

  // ---------- routing ----------

  let lastPath = null;

  function tick() {
    if (routeKey() !== lastPath) {
      lastPath = routeKey();
      const id = pageSceneId();
      if (id !== sceneId) {
        sceneId = id;
        eligible = false;
        beats = [];
        defaultBeats = null;
        scriptFromBar = false;
        for (const k of Object.keys(sitPicks)) {
          if (k !== id || Date.now() - sitPicks[k].at > 3000) delete sitPicks[k];
        }
        if (id) loadScene(id).catch((e) => console.warn("[beatBar]", e));
      }
    }
    const want = sceneId && eligible && !scriptFromBar && beats.length > 1;
    if (!want) {
      if (root && root.isConnected) root.remove();
      if (toolsEl && toolsEl.isConnected && toolsEl.parentElement !== root) toolsEl.remove();
      if (flash && flash.isConnected) flash.remove();
      return;
    }
    const vjs = player();
    if (vjs && (!root || root.parentElement !== vjs)) {
      if (!root) build();
      vjs.appendChild(root);
    }
    placeTools();
  }

  setInterval(tick, 300);
  tick();
  requestAnimationFrame(draw);
})();
