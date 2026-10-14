// Stash UI module (loaded only by the "stashui" interface; classic Stash ignores this file).
// Runs this plugin's normal code inside Stash UI's player – see stashui-host.js.
const v = new URL(import.meta.url).searchParams.get("v") || "0";

export default async function setup(stashui) {
  const { installHost, loadClassic } = await import("./stashui-host.js?v=" + encodeURIComponent(v));
  installHost(stashui);
  await loadClassic("vacuglideSync", v);
}
