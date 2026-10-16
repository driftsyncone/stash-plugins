// Stash UI module (loaded only by the "stashui" interface; classic Stash ignores this file).
// A menu entry that opens the Beat Script page, which Stash UI shows embedded from classic Stash.
export default function setup(stashui) {
  if (!stashui.has("navItem")) return;
  stashui.addNavItem({
    id: "page", label: "Beat Script", icon: "music", group: "Manage",
    href: "#/extern/classic?path=" + encodeURIComponent("/beatscript"),
  });
}
