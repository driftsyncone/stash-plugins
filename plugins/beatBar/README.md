# Beat Bar

Draws a fap-hero style beat bar over PMVs that don't have one, inside Stash's player
(works fullscreen and on phones). Timed from the scene's active script:

1. the `beats` list (ms) Beat Script >= 0.7.0 writes into every script it makes, else
2. the bottoms of the script's strokes.

Follows the script picked in Stash Interactive Tools. Shown only on interactive scenes with a
"show" tag and none of the "skip" tags (plugin settings), and never when the script was made
from an on-screen bar.

## Themes

classic, angular, neon, minimal, approach, heartbeat. The **Theme** button on the bar cycles them
(remembered per browser); the plugin's Theme setting is the default.

A theme is a JS file that registers `window.BeatBarThemes.<name> = { name, ahead, behind,
height(playerH), colors, draw(ctx, view) }` (see `beatBar.theme.classic.js` for the `view`
fields, incl. `heatColor(b)` for tempo colours). Add the file to `beatBar.yml` before
`beatBar.js`.

## Settings (Settings → Plugins → Beat Bar)

Show/skip tags, default theme, position (bottom/top), size %, look-ahead seconds (scroll
speed), timing offset ms, opacity %, beat flash (edge glow on each beat), hide BPM, no tempo
colours. The core applies these for every theme.
