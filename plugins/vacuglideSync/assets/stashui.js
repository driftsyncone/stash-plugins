// Stash UI module (loaded only by the "stashui" interface; classic Stash ignores this file).
// Runs this plugin's normal code inside Stash UI's player – see stashui-host.js – and adds quick controls:
//   - a "VacuGlide" entry in Stash UI's menu: a page to show/hide the badge, see whether the device is online, stop it
//   - an entry in the player's ⚙ menu to show or hide the badge on the spot
const v = new URL(import.meta.url).searchParams.get("v") || "0";

const PLUGIN_ID = "vacuglideSync";
const LATENCY_HOST = "https://latency.autoblowapi.com";
const ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="3" width="10" height="18" rx="5"/><path d="M10 8h4M10 12h4"/></svg>';

export default async function setup(stashui) {
  const { installHost, loadClassic } = await import("./stashui-host.js?v=" + encodeURIComponent(v));
  installHost(stashui);
  await loadClassic(PLUGIN_ID, v);
  addControls(stashui);
}

function addControls(stashui) {
  const ui = stashui.ui || {};
  const esc = ui.esc || ((s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]));
  const toast = (msg, type) => (ui.toast ? ui.toast(msg, type) : console.log("[vacuglideSync]", msg));
  const gql = (q, vars) => stashui.gql(q, vars);

  async function config() {
    const d = await gql("{ configuration { plugins } }");
    return (d.configuration.plugins || {})[PLUGIN_ID] || {};
  }
  // Stash replaces a plugin's settings as a whole: read fresh, change one key, write all back; then the plugin follows
  async function setHidden(on) {
    const cur = await config();
    await gql(`mutation($i: Map!) { configurePlugin(plugin_id: "${PLUGIN_ID}", input: $i) }`, { i: Object.assign({}, cur, { hideBadge: !!on }) });
    window.dispatchEvent(new Event("vacuglide:settings"));
    window.dispatchEvent(new Event("vacuglide:hidden"));
  }
  async function device(token) {
    const r = await fetch(LATENCY_HOST + "/vacuglide/connected", { headers: { "x-device-token": token } });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.message || "HTTP " + r.status);
    return d;
  }
  async function stopAll(token) {
    const d = await device(token);
    if (!d.connected) throw new Error("the device is offline");
    const c = String(d.cluster || "");
    const host = "https://" + (c.includes(".") ? c.replace(/^https?:\/\//, "") : c + ".autoblowapi.com");
    const put = (path, body) => fetch(host + path, { method: "PUT", headers: { "x-device-token": token, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    await Promise.all([
      put("/vacuglide/sync-script/stop"),
      put("/vacuglide/target-speed/stop"),
      put("/vacuglide/valve/stroke-plus", { valveState: false }),
      put("/vacuglide/valve/stroke-minus", { valveState: false }),
    ]);
  }

  // ---------- the page (menu entry "VacuGlide") ----------
  stashui.addRoute({
    path: "vacuglide",
    title: "VacuGlide",
    render(el, { signal }) {
      el.innerHTML = `
        <section class="kb-card">
          <h2>Badge on scenes</h2>
          <p data-badge>…</p>
          <div class="kb-card-acts"><button type="button" class="kb-btn is-primary" data-toggle disabled>…</button></div>
          <p class="kb-hint">Hidden = no VacuGlide badge and no syncing on any scene. Also in the player's ⚙ menu.</p>
        </section>
        <section class="kb-card">
          <h2>Device</h2>
          <p data-dev>Checking …</p>
          <div class="kb-card-acts"><button type="button" class="kb-btn" data-recheck>Check again</button><button type="button" class="kb-btn" data-stop>Stop device</button></div>
          <p class="kb-hint">Stop device stops any script or speed and closes both suction valves. Offline: hold the device's mode button 2.5 s.</p>
        </section>`;
      const $ = (s) => el.querySelector(s);
      let cfg = {};
      async function paint() {
        try {
          cfg = await config();
        } catch (e) {
          $("[data-badge]").textContent = "Couldn't read the settings: " + e.message;
          return;
        }
        if (signal.aborted) return;
        const hidden = !!cfg.hideBadge;
        $("[data-badge]").innerHTML = hidden ? "<b>Hidden</b> – VacuGlide is off on every scene." : "<b>Shown</b> – the badge appears on scenes with a script.";
        const b = $("[data-toggle]");
        b.disabled = false;
        b.textContent = hidden ? "Show the VacuGlide badge" : "Hide the VacuGlide badge";
        b.classList.toggle("is-primary", hidden);
      }
      async function check() {
        const out = $("[data-dev]");
        if (!cfg.deviceToken) return (out.textContent = "No device token yet – add it from the badge on a scene (Device token).");
        out.textContent = "Checking …";
        try {
          const d = await device(cfg.deviceToken);
          if (!signal.aborted) out.innerHTML = d.connected ? `<b>Online</b> (${esc(String(d.cluster || "").replace(/\.autoblowapi\.com$/, ""))})` : "<b>Offline</b>";
        } catch (e) {
          if (!signal.aborted) out.textContent = "Couldn't reach Autoblow: " + e.message;
        }
      }
      el.addEventListener("click", async (e) => {
        if (e.target.closest("[data-toggle]")) {
          const b = e.target.closest("[data-toggle]");
          b.disabled = true;
          try {
            await setHidden(!cfg.hideBadge);
            toast(cfg.hideBadge ? "VacuGlide badge is back" : "VacuGlide badge hidden", "ok");
          } catch (err) {
            toast("Couldn't save: " + err.message, "error");
          }
          paint();
        } else if (e.target.closest("[data-recheck]")) {
          check();
        } else if (e.target.closest("[data-stop]")) {
          try {
            await stopAll(cfg.deviceToken);
            toast("VacuGlide stopped", "ok");
          } catch (err) {
            toast("Couldn't stop: " + err.message, "error");
          }
        }
      });
      const repaint = () => paint();
      window.addEventListener("vacuglide:hidden", repaint);
      paint().then(check);
      return () => window.removeEventListener("vacuglide:hidden", repaint);
    },
  });
  stashui.addNavItem({ id: "vacuglide", label: "VacuGlide", icon: ICON, route: "vacuglide" });

  // ---------- the player's ⚙ menu: show / hide on the spot ----------
  stashui.addSlot("scene.menu", {
    id: "vacuglide",
    mount(el, ctx) {
      const paint = async () => {
        let hidden = false;
        try {
          hidden = !!(await config()).hideBadge;
        } catch (e) { /* shown as "shown" */ }
        if (ctx.signal && ctx.signal.aborted) return;
        el.innerHTML = `<button type="button" class="kb-pmenu-opt${hidden ? "" : " is-on"}" data-vgtoggle title="Hidden = no badge and no syncing on any scene">${hidden ? "<i></i>" : (ui.icon ? ui.icon("check") : "✓")}VacuGlide badge</button>`;
      };
      el.addEventListener("click", async (e) => {
        if (!e.target.closest("[data-vgtoggle]")) return;
        try {
          const hidden = !!(await config()).hideBadge;
          await setHidden(!hidden);
          toast(hidden ? "VacuGlide badge is back" : "VacuGlide badge hidden", "ok");
        } catch (err) {
          toast("Couldn't save: " + err.message, "error");
        }
      });
      window.addEventListener("vacuglide:hidden", paint);
      paint();
      return () => window.removeEventListener("vacuglide:hidden", paint);
    },
  });
}
