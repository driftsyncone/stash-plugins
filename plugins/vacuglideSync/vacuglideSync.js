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
    return saveSettings({ deviceToken: value });
  }

  // Stash replaces a plugin's settings as a whole: read them fresh, change the given keys, write all back.
  async function saveSettings(patch) {
    const d = await stashGql("{ configuration { plugins } }");
    const current = (d.configuration.plugins || {})[PLUGIN_ID] || {};
    const next = Object.assign({}, current, patch);
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
        return hash;
      } catch (e) {
        /* token expired or rejected: upload again */
      }
    }
    const fd = new FormData();
    fd.append("file", new Blob([text], { type: "application/json" }), "scene-" + sceneId + ".funscript");
    const d = await api("/vacuglide/sync-script/upload-funscript", { method: "PUT", body: fd, timeoutMs: SLOW_MS });
    const token = d.syncScriptToken || (d.state && d.state.syncScriptToken);
    if (token) store.set(key, { token, hash, at: Date.now() });
    return hash;
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
    if (status === "playing" && s.status !== "playing") lastPulse = Date.now();
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
        const url = s.funscriptUrl;
        s.loadedHash = await loadScript(s.sceneId, url);
        if (s.funscriptUrl !== url) {
          // Interactive Tools switched script while this one was loading: load that instead
          s.loading = null;
          return ensureLoaded(s);
        }
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

  // ---------- suction (air valves) ----------
  //
  // As the real VacuGlide behaves (user test on the device, 0.6.6): Tighter is the API's stroke-plus
  // valve (air out of the sleeve, more suction), Looser is stroke-minus (air in). Until 0.6.6 this
  // followed the manual's reading (Tighter = stroke-minus), which the device does the other way
  // round, so the buttons were reversed and keep-suction pulses were loosening. VALVE_TIGHTER /
  // VALVE_LOOSER are the only place the names are decided. They are plain open/close switches, so the
  // buttons hold a valve open while pressed. Every open is closed again: on release, after
  // VALVE_MAX_MS, on leaving the scene and on closing the tab.

  const VALVE_TIGHTER = "stroke-plus"; // air out, more suction
  const VALVE_LOOSER = "stroke-minus"; // air in, less suction
  const VALVE_MIN_MS = 250; // a quick tap still nudges a little
  const VALVE_MAX_MS = 5000;
  let valve = null; // the valve currently held open
  let valveQueue = Promise.resolve(); // valve commands go out strictly in order
  let valveClosing = Promise.resolve(); // a new press waits for the previous release to finish

  function valveSend(name, open) {
    const run = () => api("/vacuglide/valve/" + name, { method: "PUT", body: { valveState: open } });
    valveQueue = valveQueue.catch(() => {}).then(run);
    return valveQueue;
  }

  // pulseMs: an automatic suction pulse, closed pulseMs after the valve really opened. Without it
  // the valve is a held button, closed on release or after VALVE_MAX_MS.
  function valveOpen(name, pulseMs) {
    if (valve && valve.pulse && !pulseMs) valveClose(valve); // a press takes over from a pulse
    if (valve) return;
    const v = { name, pulse: pulseMs || 0, openedAt: Date.now() };
    valve = v;
    if (!v.pulse) v.timer = setTimeout(() => valveClose(v), VALVE_MAX_MS);
    v.opening = valveClosing.then(() => (host ? null : connect())).then(() => valveSend(name, true))
      .then(() => {
        v.openedAt = Date.now();
        if (v.pulse && !v.closing) v.timer = setTimeout(() => valveClose(v), v.pulse);
      });
    v.opening.catch((e) => {
      flash("suction: " + e.message);
      if (v.pulse) valveClose(v);
    });
    render();
  }

  function valveClose(v = valve) {
    if (!v || v.closing) return;
    v.closing = true;
    clearTimeout(v.timer);
    if (valve === v) valve = null;
    if (!v.pulse && v.name === VALVE_TIGHTER) lastPulse = Date.now(); // just tightened by hand
    render();
    valveClosing = finishClose(v);
  }

  async function finishClose(v) {
    try {
      await v.opening;
    } catch (e) {
      return; // never opened
    }
    const wait = (v.pulse || VALVE_MIN_MS) - (Date.now() - v.openedAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await valveSend(v.name, false);
        return;
      } catch (e) {
        if (attempt === 2) flash("valve may still be open: press Stop device");
      }
    }
  }

  function closeValvesNow(keepalive) {
    if (valve) valveClose(valve);
    if (!host || !token()) return;
    ["stroke-plus", "stroke-minus"].forEach((name) => fetch(host + "/vacuglide/valve/" + name, {
      method: "PUT", keepalive: !!keepalive,
      headers: { "x-device-token": token(), "Content-Type": "application/json" },
      body: JSON.stringify({ valveState: false }),
    }).catch(() => {}));
  }

  // ---------- suction maintenance ----------
  //
  // Starting a sync script closes both valves, so suction slowly leaks during a scene. Autoblow's
  // own app tops it up with short Tighter (stroke-plus) pulses at these levels (pulse ms, every ms); same
  // here, only while the script is playing.

  const SUCTION_LEVELS = [
    null,
    { name: "Low", pulse: 350, every: 15000 },
    { name: "Medium", pulse: 400, every: 10000 },
    { name: "High", pulse: 450, every: 8000 },
  ];
  let lastPulse = 0;

  function suctionLevel() {
    return clamp(store.get("suction", 0), 0, SUCTION_LEVELS.length - 1);
  }

  function suctionTick() {
    const lv = SUCTION_LEVELS[suctionLevel()];
    if (!lv || !session || session.status !== "playing" || valve) return;
    if (Date.now() - lastPulse < lv.every) return;
    lastPulse = Date.now();
    valveOpen(VALVE_TIGHTER, lv.pulse);
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
    if (valve) valveClose(valve);
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
        <div class="vg-row">
          <span>Suction</span>
          <button type="button" class="vg-valve" data-valve="${VALVE_TIGHTER}" aria-label="Tighter suction, hold">Tighter</button>
          <button type="button" class="vg-valve" data-valve="${VALVE_LOOSER}" aria-label="Looser suction, hold">Looser</button>
        </div>
        <div class="vg-hint">Tighter lets air out (more suction), Looser lets air in: tap for a little, hold for more (max 5 s per press).</div>
        <div class="vg-row">
          <span>Keep suction</span>
          <button type="button" data-act="suction" class="vg-suction"></button>
        </div>
        <div class="vg-hint">Tops up suction while the script plays, like Autoblow's app: a short Tighter pulse every 15 s (Low), 10 s (Medium) or 8 s (High).</div>
        <label class="vg-row vg-check"><input type="checkbox" data-act="buttons"> Device buttons control the video</label>
        <div class="vg-hint">Mode button: play/pause. Speed +/−: intensity. Intensity and speed changes reload the script (about 3 s).</div>
        <div class="vg-row">
          <button type="button" data-act="load">Reload script</button>
          <button type="button" data-act="stop" class="vg-stop">Stop device</button>
        </div>
        <div class="vg-row">
          <button type="button" data-act="hide">Hide VacuGlide</button>
        </div>
        <div class="vg-hint">Stops the device and takes the badge away on every scene. Bring it back from VacuGlide in Stash UI's menu or the player's ⚙ menu (or Settings → Plugins → VacuGlide Sync).</div>
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
    root.querySelectorAll(".vg-valve").forEach((btn) => {
      const release = () => {
        if (valve && !valve.pulse) valveClose();
      };
      btn.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        if (!session || !token()) return;
        try {
          btn.setPointerCapture(e.pointerId);
        } catch (err) {
          /* capture unsupported: pointerleave still releases */
        }
        valveOpen(btn.dataset.valve);
      });
      ["pointerup", "pointercancel", "lostpointercapture", "pointerleave"].forEach((ev) => btn.addEventListener(ev, release));
      btn.addEventListener("contextmenu", (e) => e.preventDefault()); // long-press menu on phones
      btn.addEventListener("keydown", (e) => {
        if ((e.key === " " || e.key === "Enter") && !e.repeat && session && token()) {
          e.preventDefault();
          valveOpen(btn.dataset.valve);
        }
      });
      btn.addEventListener("keyup", (e) => {
        if (e.key === " " || e.key === "Enter") release();
      });
      btn.addEventListener("blur", release);
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
      } else if (act === "suction") {
        store.set("suction", (suctionLevel() + 1) % SUCTION_LEVELS.length);
        lastPulse = Date.now();
        render();
      } else if (act === "buttons") {
        store.set("buttons", e.target.checked);
        if (e.target.checked && (s.status === "ready" || s.status === "playing")) openEvents(s);
        else closeEvents();
      } else if (act === "load") {
        s.loading = null;
        store.set("script:" + s.sceneId, null);
        ensureLoaded(s);
      } else if (act === "hide") {
        if (s.video) s.video.pause();
        stopDevice(false);
        closeValvesNow(false);
        panelOpen = false;
        endSession();
        saveSettings({ hideBadge: true })
          .then(() => window.dispatchEvent(new Event("vacuglide:hidden"))) // Stash UI's page and menu repaint
          .catch((err) => console.warn("[vacuglideSync] couldn't save hideBadge", err));
      } else if (act === "stop") {
        if (s.video) s.video.pause();
        stopDevice(false);
        closeValvesNow(false);
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
    // In Stash UI the badge lives inside the player, so it stays visible in fullscreen and goes with it – except on
    // a phone held upright, where it's pinned to the screen's bottom-left corner instead of covering the video.
    const where = uiHome();
    if (where && ui.parentElement !== where) where.appendChild(ui);
    ui.classList.toggle("vg-pinned", !!uiHost() && where === document.body);
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
    ui.querySelectorAll(".vg-valve").forEach((b) => b.classList.toggle("vg-held", !!valve && !valve.pulse && valve.name === b.dataset.valve));
    const lv = SUCTION_LEVELS[suctionLevel()];
    ui.querySelector(".vg-suction").textContent = lv ? lv.name : "Off";
    ui.querySelector(".vg-panel").hidden = !panelOpen;
  }

  // ---------- Stash Interactive Tools ----------
  //
  // SIT's script menu (and its modifiers, e.g. Halver) builds the chosen script as a blob: URL
  // and hands it to Stash's player. Catch those so the VacuGlide plays whatever SIT selected.
  // Script content is compared, so SIT re-sending the same script doesn't interrupt playback.

  const sitPicks = {}; // sceneId -> { url, hash }
  const createObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const url = createObjectURL.apply(this, arguments);
    const m = [null, pageSceneId()];
    if (m[1] && obj instanceof Blob && obj.type.startsWith("text/plain") && obj.size < 50e6) {
      obj.text().then((text) => onSitPick(m[1], url, text)).catch(() => {});
    }
    return url;
  };

  function onSitPick(sceneId, url, text) {
    let fs;
    try {
      fs = JSON.parse(text);
    } catch (e) {
      return;
    }
    if (!fs || !Array.isArray(fs.actions)) return;
    const hash = hashStr(JSON.stringify(shapeScript(fs, shapeSettings())));
    sitPicks[sceneId] = { url, hash };
    const s = session;
    if (!s || s.sceneId !== sceneId || s.funscriptUrl === url) return;
    s.funscriptUrl = url;
    if (hash === s.loadedHash) return; // same script, nothing to reload
    if (s.status === "ready" || s.status === "playing") { // a load in progress re-checks the URL itself
      flash("script changed in Interactive Tools: reloading");
      s.loading = null;
      ensureLoaded(s);
    }
  }

  // ---------- routing ----------

  let currentPath = null;

  async function onRoute() {
    const sceneId = pageSceneId();
    if (session && session.sceneId === sceneId) return;
    endSession();
    if (!sceneId) return;
    try {
      const d = await stashGql(
        "query($id: ID!) { findScene(id: $id) { interactive paths { funscript } } configuration { plugins } }",
        { id: sceneId },
      );
      settings = (d.configuration.plugins || {})[PLUGIN_ID] || {};
      if (settings.hideBadge) return; // hidden on purpose: no badge, no syncing
      const scene = d.findScene;
      if (!scene || !scene.interactive || !scene.paths.funscript) return;
      if (pageSceneId() !== sceneId) return; // navigated away meanwhile
      // Stash returns an absolute URL; keep only the path so it works over VPN/other hostnames too.
      const u = new URL(scene.paths.funscript, location.href);
      session = newSession(sceneId, sitPicks[sceneId] ? sitPicks[sceneId].url : u.pathname + u.search);
      render();
      if (settings.autoLoad) ensureLoaded(session);
    } catch (e) {
      console.warn("[vacuglideSync]", e);
    }
  }

  // Stash UI: on a phone held upright (its docked()) the screen's corner, otherwise the picture
  function uiHome() {
    const h = uiHost();
    if (!h) return null;
    return h.docked && h.docked() ? document.body : h.player();
  }

  function tick() {
    suctionTick();
    if (session && ui && uiHost()) { // phone turned, fullscreen: move along
      const where = uiHome();
      if (where && ui.parentElement !== where) render();
    }
    if (routeKey() !== currentPath) {
      currentPath = routeKey();
      onRoute();
    }
    if (session && !session.video) {
      const v = uiHost() ? uiHost().video() : document.querySelector(".video-js video, .scene-player-container video, video");
      if (v) attachVideo(session, v);
    } else if (session && session.video && !session.video.isConnected) {
      if (session.detach) session.detach();
      session.video = null; // player re-rendered; re-attach on next tick
    }
  }

  // Stash UI's VacuGlide page and gear menu (assets/stashui.js) change hideBadge and then say so: follow at once.
  window.addEventListener("vacuglide:settings", async () => {
    try {
      const d = await stashGql("{ configuration { plugins } }");
      settings = (d.configuration.plugins || {})[PLUGIN_ID] || {};
    } catch (e) {
      return;
    }
    if (settings.hideBadge) {
      if (session) {
        if (session.video) session.video.pause();
        stopDevice(false);
        closeValvesNow(false);
        panelOpen = false;
        endSession();
      }
    } else if (!session) {
      currentPath = null; // the next tick sees the scene again and brings the badge back
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && valve) valveClose(valve);
    if (!session) return;
    session.epoch++;
    pump(session);
  });
  window.addEventListener("blur", () => {
    if (valve) valveClose(valve);
  });
  window.addEventListener("pagehide", () => {
    if (valve) closeValvesNow(true);
    if (session && session.status === "playing") stopDevice(true);
  });

  setInterval(tick, 500);
  tick();
})();
