# driftsyncone's Stash plugins

Plugins for [Stash](https://stashapp.cc).

## Install

1. In Stash, open **Settings → Plugins → Available Plugins → Add Source**.
2. Name it `driftsyncone` and use this URL:

   ```
   https://driftsyncone.github.io/stash-plugins/main/index.yml
   ```

3. Expand the new source, tick the plugins you want, and click **Install**.

Updates show up in **Settings → Plugins** when a new version is published.

## Plugins

### VacuGlide Sync

Plays a scene's funscript on an [Autoblow VacuGlide](https://autoblow.com/product/vacuglide/) in sync with the video, from any browser, including phones. It uses Autoblow's cloud API, so nothing needs installing on the phone and no Bluetooth is involved.

**Setup**

1. Put the VacuGlide online (Autoblow online setup) and note its device token.
2. Hold the device's mode button for 2.5 s to enter online mode.
3. Open any scene that has a funscript and tap the **VacuGlide** badge (bottom left; top left of the player in Stash UI). Expand **Device token**, paste your token, and click **Save**.
4. Press play.

**Features**

- Play, pause and seek follow the video; the device stops when you pause, buffer, change playback speed, switch apps or leave the scene.
- Network latency is measured and compensated automatically, plus a manual offset (±50 ms steps).
- **Intensity** (20–200%) and a **speed limit** (500/400/300/200 per second) reshape the script for a gentler or stronger feel.
- **Device buttons**: the mode button plays/pauses the video, speed +/− change intensity.
- **Suction**: hold **Tighter** / **Looser** in the panel, same as the device's Stroking −/+ buttons (max 5 s per press).
- Follows the script you pick in [Stash Interactive Tools](https://github.com/stashapp/CommunityScripts) (Interactive tab, including its modifiers) and in the player of the [Stash UI](https://github.com/anonym88312/stash-pmv-plugins/tree/main/plugins/stashui) interface; the device reloads only when the script actually changes.
- Works in classic Stash and in Stash UI.
- Uploaded scripts are cached for 8 days, so reopening a scene loads in seconds.

**Requirements**

- A recent Stash release (tested on v0.31.1).
- A VacuGlide with online mode set up. Scripts are sent through Autoblow's servers.

## License

[AGPL-3.0](LICENCE)
