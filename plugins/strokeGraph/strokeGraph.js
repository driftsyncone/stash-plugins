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

  // Funscript stroke graph over the bottom of Stash's player: the script around the playhead,
  // past strokes dimmed, each segment coloured by speed (similar colours to the funscript
  // heatmap). Shows the script Stash Interactive Tools has selected, else the scene's default.

  const WINDOWS_S = [5, 10, 20, 40];
  // speed colours, one step per 120 units/s: grey, blue, green, yellow, red, purple, dark purple
  const COLORS = [[150, 150, 150], [30, 144, 255], [34, 139, 34], [255, 215, 0], [220, 20, 60], [147, 112, 219], [80, 50, 200]];

  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem("strokeGraph:" + k);
        return v === null ? d : JSON.parse(v);
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem("strokeGraph:" + k, JSON.stringify(v));
      } catch (e) {
        /* private mode: settings just aren't remembered */
      }
    },
  };

  function speedColor(v, alpha) {
    const s = Math.max(0, v) / 120;
    const i = Math.min(Math.floor(s), COLORS.length - 1);
    const j = Math.min(i + 1, COLORS.length - 1);
    const f = Math.min(s - i, 1);
    const c = COLORS[i].map((a, k) => Math.round(a + (COLORS[j][k] - a) * f));
    return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
  }

  // ---------- script ----------

  let sceneId = null;
  let acts = []; // sorted {at, pos}
  let dirty = true;

  function normalize(list) {
    return (Array.isArray(list) ? list : [])
      .filter((a) => a && isFinite(a.at) && isFinite(a.pos))
      .map((a) => ({ at: +a.at, pos: Math.max(0, Math.min(100, +a.pos)) }))
      .sort((a, b) => a.at - b.at);
  }

  function setActions(list) {
    acts = normalize(list);
    dirty = true;
  }

  function firstAtOrAfter(t, list = acts) {
    let lo = 0, hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].at < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // ---------- comparison ("ghost") script ----------
  //
  // Any of the scene's scripts can be drawn as a thin line behind the active one. The list and
  // file URLs come from Stash Interactive Tools' "init" operation (it serves each script).
  // The choice is remembered by label, so e.g. "HALF" stays selected from scene to scene.

  let ghost = []; // sorted {at, pos}
  let ghostScripts = []; // [{label, path}]

  async function loadScriptList(id) {
    const r = await fetch("/graphql", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: "mutation($a: Map) { runPluginOperation(plugin_id: \"StashInteractiveTools\", args: $a) }",
        variables: { a: { mode: "init", scene_id: id, origin: location.origin } },
      }),
    });
    const out = ((await r.json()).data || {}).runPluginOperation;
    if (id !== sceneId) return;
    ghostScripts = (out && Array.isArray(out.scripts) ? out.scripts : []).filter((x) => x && x.path && x.label);
    fillCompare();
    const want = store.get("ghost", "");
    if (want && ghostScripts.some((x) => x.label === want)) loadGhost(id, want);
  }

  async function loadGhost(id, label) {
    ghost = [];
    dirty = true;
    const item = ghostScripts.find((x) => x.label === label);
    if (!item) return;
    const res = await fetch(item.path, { credentials: "same-origin" });
    if (!res.ok || id !== sceneId) return;
    const fs = JSON.parse(await res.text());
    if (id !== sceneId || store.get("ghost", "") !== label) return;
    ghost = normalize(fs.actions);
    dirty = true;
  }

  // Stash Interactive Tools hands its chosen (and modified) script to Stash's player as a
  // text/plain blob: URL. Catch those so the graph shows the same script.
  const sitPicks = {}; // sceneId -> { actions, at }
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
        sitPicks[m[1]] = { actions: fs.actions, at: Date.now() };
        if (m[1] === sceneId) setActions(fs.actions);
      }).catch(() => {});
    }
    return url;
  };

  async function loadDefault(id) {
    const r = await fetch("/graphql", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "query($id: ID!) { findScene(id: $id) { interactive paths { funscript } } }", variables: { id } }),
    });
    const scene = ((await r.json()).data || {}).findScene;
    if (!scene || !scene.interactive || !scene.paths.funscript) return;
    const u = new URL(scene.paths.funscript, location.href); // keep only the path: works over any hostname
    const res = await fetch(u.pathname + u.search, { credentials: "same-origin" });
    if (!res.ok) return;
    const fs = JSON.parse(await res.text());
    if (id === sceneId && !sitPicks[id]) setActions(fs.actions); // SIT's choice wins if it arrived first
  }

  // ---------- overlay ----------

  let root = null, canvas = null, ctx = null, sizeBtn = null, compare = null, toolsEl = null;

  function fillCompare() {
    if (!compare) return;
    const want = store.get("ghost", "");
    compare.textContent = "";
    const off = document.createElement("option");
    off.value = "";
    off.textContent = "Compare: off";
    compare.appendChild(off);
    ghostScripts.forEach((x) => {
      const o = document.createElement("option");
      o.value = x.label;
      o.textContent = "Compare: " + x.label;
      o.selected = x.label === want;
      compare.appendChild(o);
    });
    compare.hidden = ghostScripts.length < 2 || store.get("collapsed", false);
  }

  function build() {
    root = document.createElement("div");
    root.className = "sg-root";
    canvas = document.createElement("canvas");
    canvas.className = "sg-canvas kb-nsfw-keep"; // a drawing, not media: Stash UI's NSFW blur must skip it
    ctx = canvas.getContext("2d");
    const tools = document.createElement("div");
    tools.className = "sg-tools";
    toolsEl = tools;
    sizeBtn = document.createElement("button");
    sizeBtn.type = "button";
    sizeBtn.className = "sg-btn";
    sizeBtn.title = "Time shown in the stroke graph";
    const hide = document.createElement("button");
    hide.type = "button";
    hide.className = "sg-btn";
    const stop = (e) => e.stopPropagation(); // don't let video.js treat these as play/pause clicks
    ["pointerdown", "mousedown", "touchstart", "dblclick"].forEach((ev) => tools.addEventListener(ev, stop));
    sizeBtn.addEventListener("click", (e) => {
      stop(e);
      const i = WINDOWS_S.indexOf(store.get("window", 10));
      store.set("window", WINDOWS_S[(i + 1) % WINDOWS_S.length]);
      refreshTools();
    });
    hide.addEventListener("click", (e) => {
      stop(e);
      store.set("collapsed", !store.get("collapsed", false));
      refreshTools();
    });
    compare = document.createElement("select");
    compare.className = "sg-btn sg-select";
    compare.title = "Draw another of this scene's scripts as a thin white line, to compare";
    compare.addEventListener("change", (e) => {
      stop(e);
      store.set("ghost", compare.value);
      if (compare.value) loadGhost(sceneId, compare.value);
      else {
        ghost = [];
        dirty = true;
      }
    });
    ["click", "keydown"].forEach((ev) => compare.addEventListener(ev, stop));
    root.hideBtn = hide;
    tools.append(compare, sizeBtn, hide);
    fillCompare();
    root.append(canvas, tools);
    refreshTools();
  }

  function refreshTools() {
    const collapsed = store.get("collapsed", false);
    root.classList.toggle("sg-collapsed", collapsed);
    sizeBtn.hidden = collapsed;
    fillCompare();
    sizeBtn.textContent = store.get("window", 10) + " s";
    root.hideBtn.textContent = collapsed ? "Stroke graph" : "Hide stroke graph";
    root.hideBtn.title = collapsed ? "Show the stroke graph" : "Hide the stroke graph";
    dirty = true;
  }

  // Stash UI on a phone held upright: the graph stays on the picture, its buttons go in the strip under it (dock())
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

  function place(vjs) {
    // sit just above the control bar while it's showing; at the bottom edge when it hides
    const h = uiHost();
    const hidden = h ? h.controlsHidden() : vjs.classList.contains("vjs-user-inactive") && !vjs.classList.contains("vjs-paused");
    let bottom = h ? h.controlsHeight() : 0;
    if (!hidden && !h) {
      // clear the control row and the seek bar (Stash draws the seek bar above the row)
      const box = vjs.getBoundingClientRect();
      vjs.querySelectorAll(".vjs-control-bar, .vjs-progress-control").forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.height && r.top < box.bottom) bottom = Math.max(bottom, Math.round(box.bottom - r.top));
      });
    }
    // stack above the Beat Bar plugin's bar while it's shown; with the bar hidden the graph goes all the way down
    const bb = vjs.querySelector(".bb-root");
    if (bb && !bb.classList.contains("bb-top") && !bb.classList.contains("bb-collapsed")) bottom += bb.offsetHeight;
    const height = Math.round(Math.max(48, Math.min(110, vjs.clientHeight * 0.14)));
    if (root.style.bottom !== bottom + "px") root.style.bottom = bottom + "px";
    if (root.style.height !== height + "px") root.style.height = height + "px";
  }

  let last = "";

  function draw() {
    requestAnimationFrame(draw);
    if (!root || !root.isConnected || document.hidden) return;
    const vjs = root.parentElement;
    place(vjs);
    if (root.classList.contains("sg-collapsed") || !acts.length) {
      if (!acts.length && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const video = uiHost() ? uiHost().video() : vjs.querySelector("video");
    const t = video ? video.currentTime * 1000 : 0;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    const key = [t, W, H, dpr].join();
    if (!dirty && key === last) return;
    dirty = false;
    last = key;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    const span = store.get("window", 10) * 1000;
    const t0 = t - span / 2, t1 = t + span / 2;
    const top = 16, pad = 4; // room for the buttons
    const x = (at) => ((at - t0) / span) * W;
    const y = (pos) => top + (1 - pos / 100) * (H - top - pad);

    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.beginPath();
    [0, 50, 100].forEach((p) => {
      ctx.moveTo(0, Math.round(y(p)) + 0.5);
      ctx.lineTo(W, Math.round(y(p)) + 0.5);
    });
    ctx.stroke();

    if (ghost.length) {
      const gf = Math.max(0, firstAtOrAfter(t0, ghost) - 1);
      const gt = Math.min(ghost.length - 1, firstAtOrAfter(t1, ghost));
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(255,255,255,0.55)";
      ctx.beginPath();
      for (let i = gf; i <= gt; i++) {
        if (i === gf) ctx.moveTo(x(ghost[i].at), y(ghost[i].pos));
        else ctx.lineTo(x(ghost[i].at), y(ghost[i].pos));
      }
      ctx.stroke();
    }

    const from = Math.max(0, firstAtOrAfter(t0) - 1);
    const to = Math.min(acts.length - 1, firstAtOrAfter(t1));
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    let now = null, nowSpeed = 0;
    for (let i = from; i < to; i++) {
      const a = acts[i], b = acts[i + 1];
      const dt = b.at - a.at;
      const v = dt > 0 ? (Math.abs(b.pos - a.pos) / dt) * 1000 : 0;
      ctx.strokeStyle = speedColor(v, b.at <= t ? 0.4 : 1);
      ctx.beginPath();
      ctx.moveTo(x(a.at), y(a.pos));
      ctx.lineTo(x(b.at), y(b.pos));
      ctx.stroke();
      if (a.at <= t && t < b.at && dt > 0) {
        now = a.pos + ((b.pos - a.pos) * (t - a.at)) / dt;
        nowSpeed = v;
      }
    }
    if (span <= 10000) { // action points, when there's room to see them
      ctx.fillStyle = "rgba(255,255,255,0.75)";
      for (let i = from; i <= to; i++) {
        ctx.beginPath();
        ctx.arc(x(acts[i].at), y(acts[i].pos), 1.8, 0, 2 * Math.PI);
        ctx.fill();
      }
    }

    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(Math.round(W / 2) + 0.5, top - 4);
    ctx.lineTo(Math.round(W / 2) + 0.5, H);
    ctx.stroke();
    if (now !== null) {
      ctx.fillStyle = speedColor(nowSpeed, 1);
      ctx.strokeStyle = "#fff";
      ctx.beginPath();
      ctx.arc(W / 2, y(now), 5, 0, 2 * Math.PI);
      ctx.fill();
      ctx.stroke();
    }
    ctx.font = "600 11px system-ui, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.textAlign = "right"; // the buttons are on the left
    ctx.fillText(now !== null ? Math.round(nowSpeed) + " /s" : "no stroke", W - 60, 12);
    ctx.textAlign = "left";
  }

  // ---------- routing ----------

  let lastPath = null;

  function tick() {
    if (routeKey() !== lastPath) {
      lastPath = routeKey();
      const id = pageSceneId();
      if (id !== sceneId) {
        sceneId = id;
        setActions([]);
        ghost = [];
        ghostScripts = [];
        fillCompare();
        for (const k of Object.keys(sitPicks)) {
          if (k !== id || Date.now() - sitPicks[k].at > 3000) delete sitPicks[k]; // keep only a pick made just now
        }
        if (id) {
          if (sitPicks[id]) setActions(sitPicks[id].actions);
          loadDefault(id).catch((e) => console.warn("[strokeGraph]", e));
          loadScriptList(id).catch((e) => console.warn("[strokeGraph] script list", e));
        }
      }
    }
    // only on scenes with a script: no graph and no buttons otherwise
    if (!sceneId || !acts.length) {
      if (root && root.isConnected) root.remove();
      if (toolsEl && toolsEl.isConnected && toolsEl.parentElement !== root) toolsEl.remove();
      return;
    }
    const vjs = player();
    if (vjs && (!root || root.parentElement !== vjs)) {
      if (!root) build();
      vjs.appendChild(root);
      dirty = true;
    }
    placeTools();
  }

  setInterval(tick, 500);
  tick();
  requestAnimationFrame(draw);
})();
