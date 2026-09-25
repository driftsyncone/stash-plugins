(function () {
  "use strict";

  const PLUGIN_ID = "vacuglideSync";
  const LATENCY_HOST = "https://latency.autoblowapi.com";
  const TOKEN_TTL_MS = 8 * 24 * 3600 * 1000; // Autoblow keeps uploaded scripts 9 days
  const SLOW_MS = 90000; // uploads/loads can take up to 60 s

  // ---------- small helpers ----------

  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem("vacuglide:" + k);
        return v === null ? d : JSON.parse(v);
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem("vacuglide:" + k, JSON.stringify(v));
      } catch (e) {
        /* private mode etc. */
      }
    },
  };

  function hashStr(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16) + ":" + s.length;
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  async function stashGql(query, variables) {
    const r = await fetch("/graphql", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const j = await r.json();
    if (j.errors) throw new Error(j.errors[0].message);
    return j.data;
  }

  // ---------- Autoblow API ----------

  let settings = {};

  function token() {
    return settings.deviceToken || "";
  }

  async function saveToken(value) {
    const d = await stashGql("{ configuration { plugins } }");
    const current = (d.configuration.plugins || {})[PLUGIN_ID] || {};
    const next = Object.assign({}, current, { deviceToken: value });
    await stashGql("mutation($i: Map!) { configurePlugin(plugin_id: \"" + PLUGIN_ID + "\", input: $i) }", { i: next });
    settings = next;
  }
  let host = null; // cluster base URL, e.g. https://us-east-1.autoblowapi.com

  async function api(path, { method = "GET", body, timeoutMs = 15000, base } = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    const headers = { "x-device-token": token() };
    let payload = body;
    if (body && !(body instanceof FormData)) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    try {
      const r = await fetch((base || host) + path, { method, headers, body: payload, signal: ctl.signal });
      const text = await r.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch (e) {
        data = { message: text };
      }
      if (!r.ok) {
        const msg = r.status === 429 ? "rate limited, wait a moment" :
          r.status === 502 ? "device offline" : data.message || data.error || "HTTP " + r.status;
        throw Object.assign(new Error(msg), { status: r.status });
      }
      return data;
    } catch (e) {
      if (e.name === "AbortError") throw new Error("timed out");
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async function connect() {
    if (!token()) throw new Error("no device token: add yours below");
    const d = await api("/vacuglide/connected", { base: LATENCY_HOST });
    if (!d.connected) throw new Error("device offline: hold the mode button 2.5 s");
    if (d.deviceType && d.deviceType !== "vacuglide") throw new Error("token is for a " + d.deviceType);
    const c = String(d.cluster || "");
    host = "https://" + (c.includes(".") ? c.replace(/^https?:\/\//, "") : c + ".autoblowapi.com");
  }

  async function measureLatency(n = 5) {
    const samples = [];
    for (let i = 0; i < n; i++) {
      const t = performance.now();
      await api("/vacuglide/state");
      samples.push(performance.now() - t);
    }
    samples.sort((a, b) => a - b);
    return Math.round(samples[Math.floor(n / 2)] / 2); // median one-way estimate
  }

  // ---------- script shaping (intensity / speed limit) ----------

  const SPEED_LIMITS = [0, 500, 400, 300, 200]; // position units per second; 0 = off

  function shapeSettings() {
    return { intensity: store.get("intensity", 100), speedLimit: store.get("speedLimit", 0) };
  }

  // The VacuGlide turns position changes into motor speed, so smaller or slower moves = gentler.
  function shapeScript(fs, { intensity, speedLimit }) {
    const k = intensity / 100;
    let actions = (fs.actions || []).slice().sort((a, b) => a.at - b.at)
      .map((a) => ({ at: a.at, pos: clamp(Math.round(50 + (a.pos - 50) * k), 0, 100) }));
    if (speedLimit > 0 && actions.length) {
      const out = [actions[0]];
      for (let i = 1; i < actions.length; i++) {
        const prev = out[out.length - 1];
        const cur = actions[i];
        const maxDelta = Math.trunc((speedLimit * Math.max(1, cur.at - prev.at)) / 1000); // trunc: never exceed the limit
        out.push({ at: cur.at, pos: clamp(prev.pos + clamp(cur.pos - prev.pos, -maxDelta, maxDelta), 0, 100) });
      }
      actions = out;
    }
    return Object.assign({}, fs, { actions });
  }

  async function loadScript(sceneId, funscriptUrl) {
    const res = await fetch(funscriptUrl, { credentials: "same-origin" });
    if (!res.ok) throw new Error("couldn't read funscript from Stash");
    const text = JSON.stringify(shapeScript(JSON.parse(await res.text()), shapeSettings()));
    const key = "script:" + sceneId;
    const hash = hashStr(text);
    const cached = store.get(key);
    if (cached && cached.hash === hash && Date.now() - cached.at < TOKEN_TTL_MS) {
      try {
        await api("/vacuglide/sync-script/load-token", {
          method: "PUT", body: { scriptToken: cached.token }, timeoutMs: SLOW_MS,
        });
        return;
      } catch (e) {
        /* token expired or rejected: upload again */
      }
    }
    const fd = new FormData();
    fd.append("file", new Blob([text], { type: "application/json" }), "scene-" + sceneId + ".funscript");
    const d = await api("/vacuglide/sync-script/upload-funscript", { method: "PUT", body: fd, timeoutMs: SLOW_MS });
    const token = d.syncScriptToken || (d.state && d.state.syncScriptToken);
    if (token) store.set(key, { token, hash, at: Date.now() });
  }

  // ---------- per-scene session ----------

  let session = null;

  function newSession(sceneId, funscriptUrl) {
    return {
      sceneId, funscriptUrl,
      status: "idle", // idle | loading | ready | playing | error
      detail: "",
      latency: store.get("latency", 0),
      loading: null,
      video: null,
      sent: null,
      epoch: 0,
      busy: false,
    };
  }

  function setStatus(s, status, detail = "") {
    if (s !== session) return;
    s.status = status;
    s.detail = detail;
    render();
  }

  function userOffset() {
    return store.get("offset", 0);
  }

  async function applyOffset(s) {
    const ms = clamp(s.latency + userOffset(), -10000, 10000);
    await api("/vacuglide/sync-script/offset", { method: "PUT", body: { offsetTimeMs: ms } });
  }

  function ensureLoaded(s) {
    if (s.loading) return s.loading;
    setStatus(s, "loading", "connecting…");
    s.loading = (async () => {
      try {
        await connect();
        setStatus(s, "loading", "loading script (up to 60 s)…");
        await loadScript(s.sceneId, s.funscriptUrl);
        s.latency = await measureLatency(3);
        store.set("latency", s.latency);
        await applyOffset(s);
        openEvents(s);
        s.sent = null;
        setStatus(s, "ready");
        pump(s);
      } catch (e) {
        s.loading = null;
        setStatus(s, "error", e.message);
      }
    })();
    return s.loading;
  }

  function desired(s) {
    const v = s.video;
    if (!v || document.hidden) return "stop";
    if (v.playbackRate !== 1) return "stop";
    return !v.paused && !v.seeking && !v.ended && v.readyState >= 3 ? "play" : "stop";
  }

  // Sends only the latest wanted state; events that arrive mid-request are coalesced.
  async function pump(s) {
    if (s.busy || !(s.status === "ready" || s.status === "playing")) return;
    s.busy = true;
    try {
      for (;;) {
        const want = desired(s);
        const epoch = s.epoch;
        if (s.sent && s.sent.want === want && (want === "stop" || s.sent.epoch === epoch)) break;
        if (want === "play") {
          await api("/vacuglide/sync-script/start", {
            method: "PUT", body: { startTimeMs: Math.round(s.video.currentTime * 1000) },
          });
        } else {
          await api("/vacuglide/sync-script/stop", { method: "PUT" });
        }
        s.sent = { want, epoch };
        const note = want === "stop" && s.video && s.video.playbackRate !== 1 ? "paused: playback speed must be 1×" : "";
        setStatus(s, want === "play" ? "playing" : "ready", note);
      }
    } catch (e) {
      s.sent = null;
      setStatus(s, "error", e.message);
    } finally {
      s.busy = false;
    }
  }

  function stopDevice(keepalive) {
    if (!host || !token()) return;
    fetch(host + "/vacuglide/sync-script/stop", {
      method: "PUT", headers: { "x-device-token": token() }, keepalive: !!keepalive,
    }).catch(() => {});
  }

  function attachVideo(s, video) {
    s.video = video;
    const kick = () => {
      s.epoch++;
      pump(s);
    };
    const onPlay = () => {
      if (s.status === "idle" || s.status === "error") ensureLoaded(s);
      kick();
    };
    ["pause", "seeking", "seeked", "waiting", "ratechange", "ended"].forEach((ev) => video.addEventListener(ev, kick));
    video.addEventListener("playing", onPlay);
    s.detach = () => {
      ["pause", "seeking", "seeked", "waiting", "ratechange", "ended"].forEach((ev) => video.removeEventListener(ev, kick));
      video.removeEventListener("playing", onPlay);
    };
    if (!video.paused) onPlay();
  }

  // ---------- device buttons ----------

  let events = null;
  let reshapeTimer = null;
  const BUTTON_EVENTS = ["mode-button-pressed", "speed-plus-button-pressed", "speed-minus-button-pressed"];

  function openEvents(s) {
    closeEvents();
    if (!store.get("buttons", true) || !host) return;
    const es = new EventSource(host + "/events/stream?deviceToken=" + encodeURIComponent(token()));
    BUTTON_EVENTS.forEach((name) => es.addEventListener(name, () => onDeviceButton(s, name)));
    es.onmessage = (e) => {
      const m = String(e.data || "").match(/(mode|speed-plus|speed-minus)-button-pressed/);
      if (m) onDeviceButton(s, m[0]);
    };
    events = es;
  }

  function closeEvents() {
    if (events) {
      events.close();
      events = null;
    }
  }

  function onDeviceButton(s, name) {
    if (s !== session || !s.video) return;
    if (name === "mode-button-pressed") {
      if (s.video.paused) {
        const p = s.video.play();
        if (p && p.catch) p.catch(() => flash("browser blocked play: tap the video once"));
      } else {
        s.video.pause();
      }
    } else {
      setIntensity(shapeSettings().intensity + (name === "speed-plus-button-pressed" ? 10 : -10));
    }
  }

  function setIntensity(v) {
    store.set("intensity", clamp(v, 20, 200));
    flash("intensity " + shapeSettings().intensity + "%");
    scheduleReshape();
  }

  // Re-upload the reshaped script once the settings stop changing.
  function scheduleReshape() {
    render();
    clearTimeout(reshapeTimer);
    reshapeTimer = setTimeout(() => {
      const s = session;
      if (s && (s.status === "ready" || s.status === "playing")) {
        s.loading = null;
        ensureLoaded(s);
      }
    }, 1200);
  }

  let flashText = "";
  let flashTimer = null;

  function flash(text) {
    flashText = text;
    render();
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      flashText = "";
      render();
    }, 2500);
  }

  function endSession() {
    if (!session) return;
    closeEvents();
    clearTimeout(reshapeTimer);
    if (session.detach) session.detach();
    if (session.status === "playing") stopDevice(false);
    session = null;
    render();
  }

  // ---------- UI ----------

  let ui = null;
  let panelOpen = false;

  const LABELS = {
    idle: "tap to load",
    loading: "loading…",
    ready: "ready",
    playing: "syncing",
    error: "error",
  };

  function buildUi() {
    const root = document.createElement("div");
    root.className = "vg-root";
    root.innerHTML = `
      <button class="vg-badge" type="button"><span class="vg-dot"></span><span class="vg-label"></span></button>
      <div class="vg-panel" hidden>
        <div class="vg-detail"></div>
        <div class="vg-row">
          <span>Offset</span>
          <button type="button" data-act="off-" aria-label="Offset minus 50 ms">−50</button>
          <span class="vg-offset"></span>
          <button type="button" data-act="off+" aria-label="Offset plus 50 ms">+50</button>
        </div>
        <div class="vg-hint">Positive = device moves earlier. Network latency (<span class="vg-lat"></span>) is added automatically.</div>
        <div class="vg-row">
          <span>Intensity</span>
          <button type="button" data-act="int-" aria-label="Intensity minus 10%">−10</button>
          <span class="vg-int"></span>
          <button type="button" data-act="int+" aria-label="Intensity plus 10%">+10</button>
        </div>
        <div class="vg-row">
          <span>Speed limit</span>
          <button type="button" data-act="lim" class="vg-lim"></button>
        </div>
        <label class="vg-row vg-check"><input type="checkbox" data-act="buttons"> Device buttons control the video</label>
        <div class="vg-hint">Mode button: play/pause. Speed +/−: intensity. Intensity and speed changes reload the script (about 3 s).</div>
        <div class="vg-row">
          <button type="button" data-act="load">Reload script</button>
          <button type="button" data-act="stop" class="vg-stop">Stop device</button>
        </div>
        <details class="vg-token">
          <summary>Device token <span class="vg-token-src"></span></summary>
          <div class="vg-row">
            <input type="password" class="vg-token-input" autocomplete="off" placeholder="paste your VacuGlide token">
            <button type="button" data-act="tok-save">Save</button>
          </div>
          <div class="vg-hint">Shown on the device during Autoblow online setup. Saved in Stash's plugin settings.</div>
        </details>
      </div>`;
    root.querySelector(".vg-badge").addEventListener("click", () => {
      if (!session) return;
      if (!token()) {
        panelOpen = true;
        root.querySelector(".vg-token").open = true;
        setStatus(session, "error", "no device token: add yours below");
        return;
      }
      if (session.status === "idle" || session.status === "error") ensureLoaded(session);
      panelOpen = !panelOpen;
      render();
    });
    root.querySelector(".vg-panel").addEventListener("click", async (e) => {
      const act = e.target.dataset && e.target.dataset.act;
      if (!act || !session) return;
      const s = session;
      if (act === "tok-save") {
        const input = root.querySelector(".vg-token-input");
        const value = input.value.trim();
        if (!value || value === token()) return;
        if (s.status === "playing") stopDevice(false); // stop the old device before switching
        try {
          await saveToken(value);
        } catch (err) {
          setStatus(s, "error", "couldn't save token: " + err.message);
          return;
        }
        // New device: forget its server and cached scripts, then reconnect.
        closeEvents();
        host = null;
        store.set("script:" + s.sceneId, null);
        s.loading = null;
        s.sent = null;
        if (token()) ensureLoaded(s);
        else setStatus(s, "error", "no device token: add yours below");
        render();
      } else if (act === "off-" || act === "off+") {
        store.set("offset", clamp(userOffset() + (act === "off+" ? 50 : -50), -5000, 5000));
        render();
        if (s.status === "ready" || s.status === "playing") {
          applyOffset(s).catch((err) => setStatus(s, "error", err.message));
        }
      } else if (act === "int-" || act === "int+") {
        setIntensity(shapeSettings().intensity + (act === "int+" ? 10 : -10));
      } else if (act === "lim") {
        const i = SPEED_LIMITS.indexOf(shapeSettings().speedLimit);
        store.set("speedLimit", SPEED_LIMITS[(i + 1) % SPEED_LIMITS.length]);
        scheduleReshape();
      } else if (act === "buttons") {
        store.set("buttons", e.target.checked);
        if (e.target.checked && (s.status === "ready" || s.status === "playing")) openEvents(s);
        else closeEvents();
      } else if (act === "load") {
        s.loading = null;
        store.set("script:" + s.sceneId, null);
        ensureLoaded(s);
      } else if (act === "stop") {
        if (s.video) s.video.pause();
        stopDevice(false);
        s.sent = { want: "stop", epoch: s.epoch };
        setStatus(s, s.status === "playing" ? "ready" : s.status);
      }
    });
    document.body.appendChild(root);
    return root;
  }

  function render() {
    if (!session) {
      if (ui) ui.hidden = true;
      return;
    }
    if (!ui) ui = buildUi();
    ui.hidden = false;
    ui.dataset.status = session.status;
    ui.querySelector(".vg-label").textContent = "VacuGlide: " + (flashText || LABELS[session.status]);
    const shape = shapeSettings();
    ui.querySelector(".vg-int").textContent = shape.intensity + "%";
    ui.querySelector(".vg-lim").textContent = shape.speedLimit ? shape.speedLimit + " /s" : "Off";
    ui.querySelector("[data-act=buttons]").checked = store.get("buttons", true);
    ui.querySelector(".vg-detail").textContent = session.detail || LABELS[session.status];
    ui.querySelector(".vg-offset").textContent = userOffset() + " ms";
    ui.querySelector(".vg-lat").textContent = session.latency + " ms";
    ui.querySelector(".vg-token-src").textContent = token() ? "(set)" : "(not set)";
    const input = ui.querySelector(".vg-token-input");
    if (document.activeElement !== input) input.value = token();
    ui.querySelector(".vg-panel").hidden = !panelOpen;
  }

  // ---------- routing ----------

  let currentPath = null;

  async function onRoute() {
    const m = location.pathname.match(/^\/scenes\/(\d+)/);
    const sceneId = m ? m[1] : null;
    if (session && session.sceneId === sceneId) return;
    endSession();
    if (!sceneId) return;
    try {
      const d = await stashGql(
        "query($id: ID!) { findScene(id: $id) { interactive paths { funscript } } configuration { plugins } }",
        { id: sceneId },
      );
      settings = (d.configuration.plugins || {})[PLUGIN_ID] || {};
      const scene = d.findScene;
      if (!scene || !scene.interactive || !scene.paths.funscript) return;
      if (!location.pathname.startsWith("/scenes/" + sceneId)) return; // navigated away meanwhile
      // Stash returns an absolute URL; keep only the path so it works over VPN/other hostnames too.
      const u = new URL(scene.paths.funscript, location.href);
      session = newSession(sceneId, u.pathname + u.search);
      render();
      if (settings.autoLoad) ensureLoaded(session);
    } catch (e) {
      console.warn("[vacuglideSync]", e);
    }
  }

  function tick() {
    if (location.pathname !== currentPath) {
      currentPath = location.pathname;
      onRoute();
    }
    if (session && !session.video) {
      const v = document.querySelector(".video-js video, .scene-player-container video, video");
      if (v) attachVideo(session, v);
    } else if (session && session.video && !session.video.isConnected) {
      if (session.detach) session.detach();
      session.video = null; // player re-rendered; re-attach on next tick
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (!session) return;
    session.epoch++;
    pump(session);
  });
  window.addEventListener("pagehide", () => {
    if (session && session.status === "playing") stopDevice(true);
  });

  setInterval(tick, 500);
  tick();
})();
