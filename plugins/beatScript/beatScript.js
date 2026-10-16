(function () {
  "use strict";

  const PLUGIN_ID = "beatScript";
  const ROUTE = "/beatscript";
  const LOG_PREFIX = "[Plugin / Beat Script] ";
  const STORE_KEY = "beatScript:jobs";
  const FINISH_TIMEOUT_MS = 20 * 60 * 1000;
  const ACTIVE = ["queued", "running", "finishing"];

  const api = window.PluginApi;
  const React = api.React;
  const h = React.createElement;
  const { useState, useEffect, useRef } = React;

  async function gql(query, variables) {
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

  function fmtDuration(s) {
    s = Math.round(s || 0);
    const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
    return (hh ? hh + ":" + String(mm).padStart(2, "0") : mm) + ":" + String(ss).padStart(2, "0");
  }

  function fmtBytes(b) {
    if (b == null) return "unknown";
    const u = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return b.toFixed(i > 2 ? 1 : 0) + " " + u[i];
  }

  function loadJobs() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; } catch (e) { return []; }
  }

  function saveJobs(list) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(list)); } catch (e) { /* list just won't survive a reload */ }
  }

  function Check({ state, children }) {
    const icon = { ok: "✓", warn: "!", bad: "✕" }[state];
    return h("li", { className: "bs-check bs-" + state }, h("span", { className: "bs-icon" }, icon), h("span", null, children));
  }

  const STATUS_TEXT = {
    queued: "Queued", running: "Working", finishing: "Adding to Stash…",
    done: "Done", failed: "Failed", cancelled: "Cancelled",
  };

  function JobRow({ d, onCancel, onRemove }) {
    const pct = Math.round((d.progress || 0) * 100);
    const barPct = d.status === "running" ? pct : d.status === "queued" ? 0 : 100;
    const barClass = "progress-bar" +
      (d.status === "finishing" ? " progress-bar-striped progress-bar-animated" : "") +
      (d.status === "failed" || d.status === "cancelled" ? " bg-danger" : d.status === "done" ? " bg-success" : "");
    const detail = d.status === "running" ? (d.step || pct + "%")
      : d.status === "failed" ? d.error || "see Stash logs"
      : d.status === "queued" ? "waiting for other Stash jobs"
      : d.status === "done" ? d.step || ""
      : "";
    return h("li", { className: "bs-job" },
      d.thumbnail && h("img", { className: "bs-job-thumb", src: d.thumbnail, alt: "" }),
      h("div", { className: "bs-job-body" },
        h("div", { className: "bs-job-title" }, d.title),
        h("div", { className: "bs-job-status" }, h("strong", null, STATUS_TEXT[d.status]), detail && h("span", null, " · " + detail)),
        h("div", { className: "progress" }, h("div", { className: barClass, style: { width: barPct + "%" } }))),
      h("div", { className: "bs-job-actions" },
        d.status === "done" && d.sceneId && h("a", { className: "btn btn-sm btn-success", href: "/scenes/" + d.sceneId }, "Open"),
        (d.status === "queued" || d.status === "running") &&
          h("button", { className: "btn btn-sm btn-danger", onClick: () => onCancel(d) }, "Cancel"),
        !ACTIVE.includes(d.status) &&
          h("button", { className: "btn btn-sm btn-secondary", title: "Remove from list", onClick: () => onRemove(d) }, "✕")));
  }

  // New state of one job from Stash's job queue, this plugin's log lines and a scene lookup.
  function nextState(d, job, logs, scene) {
    const tag = "[" + d.key + "] ";
    const mine = logs.filter((l) => l.text.startsWith(tag) && l.at >= d.started - 5000)
      .map((l) => ({ level: l.level, text: l.text.slice(tag.length) }));
    const n = Object.assign({}, d);
    const last = mine.filter((l) => l.level !== "Error").pop();
    if (last) n.step = last.text;
    const saved = mine.filter((l) => l.text.startsWith("saved beat script: ")).pop();
    if (saved) n.summary = saved.text.replace("saved beat script: ", "");
    const err = mine.find((l) => l.level === "Error");

    if (err || (job && job.status === "FAILED")) {
      n.status = "failed";
      n.error = err ? err.text.replace(/^Beat script failed: /, "") : job.error;
    } else if (d.kind === "scene" && mine.some((l) => /has a beat script$/.test(l.text))) {
      n.status = "done";
      n.sceneId = d.sceneId;
      n.step = n.summary;
    } else if (d.kind === "url" && scene && mine.some((l) => /^scene \d+ ready$/.test(l.text))) {
      n.status = "done";
      n.sceneId = scene.id;
      n.step = n.summary;
    } else if (job && (job.status === "CANCELLED" || job.status === "STOPPING")) {
      n.status = "cancelled";
    } else if (job && job.status === "READY") {
      n.status = "queued";
    } else if (job && job.status === "RUNNING") {
      n.status = "running";
      n.progress = job.progress || 0;
    } else if (d.status !== "finishing") {
      n.status = "finishing";
      n.progress = 1;
      n.finishingSince = Date.now();
    } else if (Date.now() - (d.finishingSince || d.started) > FINISH_TIMEOUT_MS) {
      n.status = "failed";
      n.error = "timed out waiting for the scan; check Settings → Tasks";
    }
    return n;
  }

  function BeatScriptPage() {
    const [url, setUrl] = useState("");
    const [check, setCheck] = useState(null);
    const [checking, setChecking] = useState(false);
    const [error, setError] = useState("");
    const [sceneId, setSceneId] = useState("");
    const [overwrite, setOverwrite] = useState(false);
    const [method, setMethodState] = useState(() => {
      try { return localStorage.getItem("beatScript:method") || "auto"; } catch (e) { return "auto"; }
    });
    const [strokes, setStrokesState] = useState(() => {
      try { return localStorage.getItem("beatScript:strokes") || "full"; } catch (e) { return "full"; }
    });
    function setStrokes(v) {
      setStrokesState(v);
      try { localStorage.setItem("beatScript:strokes", v); } catch (e) { /* not remembered */ }
    }
    function setMethod(m) {
      setMethodState(m);
      try { localStorage.setItem("beatScript:method", m); } catch (e) { /* not remembered */ }
    }
    const [jobs, setJobsState] = useState(loadJobs);
    const listRef = useRef(jobs);

    function setJobs(update) {
      setJobsState((prev) => {
        const next = typeof update === "function" ? update(prev) : update;
        listRef.current = next;
        saveJobs(next);
        return next;
      });
    }

    useEffect(() => {
      setCheck(null);
      setError("");
      if (!/^https?:\/\/\S+$/.test(url.trim())) return undefined;
      const t = setTimeout(runCheck, 600);
      return () => clearTimeout(t);
    }, [url]);

    async function runCheck() {
      setChecking(true);
      setError("");
      try {
        const d = await gql("mutation($a: Map) { runPluginOperation(plugin_id: \"" + PLUGIN_ID + "\", args: $a) }",
          { a: { mode: "check", url: url.trim() } });
        setCheck(d.runPluginOperation);
      } catch (e) {
        setError(e.message);
      } finally {
        setChecking(false);
      }
    }

    const queuedAlready = check && jobs.some((d) => d.key === check.key && ACTIVE.includes(d.status));
    const canStart = check && !check.problems.length && !queuedAlready;

    async function startTask(task, args, row) {
      const d = await gql("mutation($a: Map) { runPluginTask(plugin_id: \"" + PLUGIN_ID +
        "\", task_name: \"" + task + "\", args_map: $a) }", { a: args });
      setJobs((list) => [Object.assign({ jobId: d.runPluginTask, started: Date.now(), status: "queued", progress: 0 }, row)]
        .concat(list.filter((x) => x.key !== row.key)));
    }

    async function startDownload() {
      const c = check;
      try {
        await startTask("Download and script", { mode: "download", url: c.link, key: c.key, method, strokes },
          { kind: "url", key: c.key, link: c.link, title: c.title, thumbnail: c.thumbnail });
        setUrl("");
        setCheck(null);
      } catch (e) {
        setError("Couldn't start: " + e.message);
      }
    }

    async function startScene() {
      const id = sceneId.trim().replace(/.*\/scenes\/(\d+).*/, "$1");
      if (!/^\d+$/.test(id)) { setError("Enter a scene number or paste a scene's link."); return; }
      try {
        const s = await gql("query($id: ID!) { findScene(id: $id) { id title files { basename } paths { screenshot } } }", { id });
        if (!s.findScene) throw new Error("no scene " + id);
        await startTask("Script a scene", { mode: "scene", scene_id: id, overwrite: overwrite ? "1" : "", method, strokes },
          { kind: "scene", key: "scene-" + id, sceneId: id,
            title: s.findScene.title || (s.findScene.files[0] || {}).basename || "scene " + id,
            thumbnail: s.findScene.paths.screenshot });
        setSceneId("");
      } catch (e) {
        setError("Couldn't start: " + e.message);
      }
    }

    async function cancel(d) {
      await gql("mutation($id: ID!) { stopJob(job_id: $id) }", { id: d.jobId }).catch(() => {});
      setJobs((list) => list.map((x) => (x.key === d.key ? Object.assign({}, x, { status: "cancelled" }) : x)));
    }

    const activeKey = jobs.filter((d) => ACTIVE.includes(d.status)).map((d) => d.key).join(",");
    useEffect(() => {
      if (!activeKey) return undefined;
      let alive = true;
      const tick = async () => {
        const active = listRef.current.filter((d) => ACTIVE.includes(d.status));
        if (!active.length) return;
        const parts = active.map((d, i) =>
          "j" + i + ": findJob(input: {id: \"" + d.jobId + "\"}) { status progress error } " +
          "s" + i + ": findScenes(scene_filter: {url: {value: " + JSON.stringify(d.link || "-none-") +
          ", modifier: EQUALS}}, filter: {per_page: 1}) { scenes { id } }");
        try {
          const r = await gql("{ " + parts.join(" ") + " logs { time level message } }");
          if (!alive) return;
          const logs = r.logs.filter((l) => l.message.startsWith(LOG_PREFIX)).reverse()
            .map((l) => ({ at: Date.parse(l.time), level: l.level, text: l.message.slice(LOG_PREFIX.length) }));
          const updated = {};
          active.forEach((d, i) => { updated[d.key] = nextState(d, r["j" + i], logs, r["s" + i].scenes[0]); });
          setJobs((list) => list.map((x) => updated[x.key] || x));
        } catch (e) {
          /* transient error: try again next tick */
        }
      };
      tick();
      const timer = setInterval(tick, 1500);
      return () => { alive = false; clearInterval(timer); };
    }, [activeKey]);

    const finished = jobs.filter((d) => !ACTIVE.includes(d.status));

    return h("div", { className: "bs-page" },
      h("h2", null, "Beat Script"),
      h("p", { className: "bs-lead" }, "Paste a video link, or pick a scene below. It gets a funscript that strokes to the beat: " +
        "from an on-screen beat bar when the video has one (cock hero / fap hero), otherwise from the music."),
      h("div", { className: "bs-method-row" },
        h("span", null, "Script from:"),
        h("select", { className: "form-control", value: method, onChange: (e) => setMethod(e.target.value) },
          h("option", { value: "auto" }, "Auto: beat bar if there is one, else the music"),
          h("option", { value: "bar" }, "On-screen beat bar only"),
          h("option", { value: "music" }, "Music only")),
        h("span", null, "Active:"),
        h("select", { className: "form-control", value: strokes, onChange: (e) => setStrokes(e.target.value),
          title: "Both versions are saved and selectable in the scene's Interactive tab (Stash Interactive Tools); this picks which one plays by default. Full = a whole stroke on every beat; Half = one direction change per beat (half the speed)." },
          h("option", { value: "full" }, "Full (stroke every beat)"),
          h("option", { value: "half" }, "Half (half speed)"))),
      h("div", { className: "bs-input-row" },
        h("input", { className: "form-control", type: "url", placeholder: "https://…", value: url, autoFocus: true,
          onChange: (e) => setUrl(e.target.value) }),
        h("button", { className: "btn btn-secondary", disabled: checking || !url.trim(), onClick: runCheck },
          checking ? "Checking…" : "Check")),
      error && h("div", { className: "bs-error" }, error),
      check && h("div", { className: "bs-card" },
        check.thumbnail && h("img", { className: "bs-thumb", src: check.thumbnail, alt: "" }),
        h("div", { className: "bs-info" },
          h("h3", null, check.title),
          h("div", { className: "bs-meta" }, fmtDuration(check.duration) + (check.uploader ? " · by " + check.uploader : "") +
            (check.site ? " · " + check.site : "")),
          h("ul", { className: "bs-checks" },
            queuedAlready && h(Check, { state: "bad" }, "Already in the list below"),
            check.existing_scene
              ? h(Check, { state: "bad" }, "Already in Stash: ", h("a", { href: "/scenes/" + check.existing_scene }, "scene " + check.existing_scene))
              : h(Check, { state: "ok" }, "Not in Stash yet"),
            h(Check, { state: check.free_bytes != null && check.free_bytes >= check.est_bytes * 2 ? "ok" : "bad" },
              "Disk: " + fmtBytes(check.free_bytes) + " free, needs about " + fmtBytes(check.est_bytes)),
            h(Check, { state: "ok" }, "Saves to ", h("code", null, check.dest_path)),
            check.warnings.map((w) => h(Check, { key: w, state: "warn" }, w))),
          check.problems.length > 0 && h("div", { className: "bs-error" }, check.problems.join(" ")),
          h("button", { className: "btn btn-primary btn-lg", disabled: !canStart, onClick: startDownload },
            "Download and make script"))),
      h("div", { className: "bs-scene-row" },
        h("span", null, "Or script a scene already in Stash:"),
        h("input", { className: "form-control", placeholder: "scene number or link", value: sceneId,
          onChange: (e) => setSceneId(e.target.value) }),
        h("label", null, h("input", { type: "checkbox", checked: overwrite, onChange: (e) => setOverwrite(e.target.checked) }),
          " make it the active script (the current one stays selectable in the Interactive tab)"),
        h("button", { className: "btn btn-secondary", disabled: !sceneId.trim(), onClick: startScene }, "Make script")),
      jobs.length > 0 && h("div", { className: "bs-jobs" },
        h("div", { className: "bs-jobs-head" },
          h("h4", null, "Jobs"),
          finished.length > 0 && h("button", { className: "btn btn-sm btn-link",
            onClick: () => setJobs((list) => list.filter((d) => ACTIVE.includes(d.status))) }, "Clear finished")),
        h("ul", { className: "bs-job-list" },
          jobs.map((d) => h(JobRow, { key: d.key, d, onCancel: cancel,
            onRemove: (x) => setJobs((list) => list.filter((y) => y.key !== x.key)) })))));
  }

  api.register.route(ROUTE, BeatScriptPage);

  function addButton() {
    if (document.getElementById("beat-script-btn")) return;
    const bar = document.querySelector(".navbar-buttons");
    if (!bar) return;
    const btn = document.createElement("a");
    btn.id = "beat-script-btn";
    btn.href = ROUTE;
    btn.className = "btn btn-secondary minimal";
    btn.title = "Download a video and make a beat script";
    btn.textContent = "Beat Script";
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      window.history.pushState({}, "", ROUTE);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    bar.prepend(btn);
  }

  setInterval(addButton, 1000);
  addButton();
})();
