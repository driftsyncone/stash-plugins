// Shared by our plugins' Stash UI modules (each plugin ships a copy as assets/stashui-host.js).
//
// Stash UI (the "stashui" plugin) is a separate interface: classic Stash's plugin code isn't loaded there.
// Our player plugins (VacuGlide Sync, Stroke Graph, Beat Bar) run their normal classic code inside it;
// this helper gives that code what it reads from classic Stash's page:
//   window.StashUIHost.sceneId()        scene open in Stash UI's player (#/scene/<id>), else null
//   window.StashUIHost.player()         the player's picture area (.kb-screen) – overlays go in here
//   window.StashUIHost.video()          the <video>
//   window.StashUIHost.controlsHidden() true while the player's controls are faded out
//   window.StashUIHost.controlsHeight() px the controls take at the bottom of the picture (0 when hidden)
// and hands over the funscript picked in Stash UI's player (its variants) the way Stash Interactive Tools
// does in classic Stash: as a text/plain blob: URL, which the plugins already listen for.
// Classic Stash never loads this file, so nothing changes there.

const VERSION = 1;
const POLL_MS = 2000;

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

export function installHost() {
  if (window.StashUIHost && window.StashUIHost.version >= VERSION) return window.StashUIHost;

  const stage = () => document.querySelector(".kb-stage.kb-player");
  const sceneId = () => {
    const m = location.hash.match(/^#\/scene\/(\d+)/);
    return m && stage() ? m[1] : null;
  };
  const host = {
    version: VERSION,
    sceneId,
    player: () => (stage() ? stage().querySelector(".kb-screen") : null),
    video: () => (stage() ? stage().querySelector("video.kb-video") : null),
    controlsHidden: () => !!stage() && stage().classList.contains("is-idle"),
    controlsHeight: () => {
      const s = stage();
      const c = s && s.querySelector(".kb-controls");
      return c && !s.classList.contains("is-idle") ? c.offsetHeight : 0;
    },
  };
  window.StashUIHost = host;

  // ---- the script picked in Stash UI's player ----
  // Stash UI remembers the picked variant per scene in its plugin settings (fsVariants: {sceneId: path})
  // and reads variant files through its backend. No pick = the scene's own funscript.
  async function picked(id) {
    const d = await gql("{ configuration { plugins } }");
    const all = JSON.parse((((d.configuration.plugins || {}).stashui || {}).fsVariants) || "{}") || {};
    return all[id] || null;
  }

  async function hand(id, path) {
    let text;
    if (path) {
      const d = await gql("mutation($a: Map) { runPluginOperation(plugin_id: \"stashui\", args: $a) }",
        { a: { mode: "funscript_read", path } });
      text = (d.runPluginOperation || {}).content;
    } else {
      const s = (await gql("query($id: ID!) { findScene(id: $id) { paths { funscript } } }", { id })).findScene;
      if (!s || !s.paths.funscript) return;
      const u = new URL(s.paths.funscript, location.href);
      const r = await fetch(u.pathname + u.search, { credentials: "same-origin" });
      if (!r.ok) return;
      text = await r.text();
    }
    if (!text || sceneId() !== id) return;
    URL.createObjectURL(new Blob([text], { type: "text/plain" })); // the plugins catch this
  }

  let watched = null;
  let last; // undefined = not looked yet for this scene
  let busy = false;
  setInterval(async () => {
    const id = sceneId();
    if (id !== watched) {
      watched = id;
      last = undefined;
    }
    if (!id || busy || document.hidden) return;
    busy = true;
    try {
      const p = await picked(id);
      if (sceneId() !== id) return;
      if (last === undefined) {
        last = p;
        if (p) await hand(id, p); // opened with a variant picked earlier
      } else if (p !== last) {
        last = p;
        await hand(id, p); // picked another one (or back to the scene's own)
      }
    } catch (e) {
      /* Stash busy or Stash UI's backend missing: try again next round */
    } finally {
      busy = false;
    }
  }, POLL_MS);

  return host;
}

// Load a plugin's classic Stash code (and CSS) into this page, as Stash itself serves it.
export function loadClassic(pluginId, version) {
  const v = encodeURIComponent(version || "0");
  if (!document.querySelector(`link[data-classic="${pluginId}"]`)) {
    const css = document.createElement("link");
    css.rel = "stylesheet";
    css.href = `/plugin/${encodeURIComponent(pluginId)}/css?v=${v}`;
    css.dataset.classic = pluginId;
    document.head.appendChild(css);
  }
  if (document.querySelector(`script[data-classic="${pluginId}"]`)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = `/plugin/${encodeURIComponent(pluginId)}/javascript?v=${v}`;
    s.dataset.classic = pluginId;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("couldn't load " + pluginId + "'s code"));
    document.head.appendChild(s);
  });
}
