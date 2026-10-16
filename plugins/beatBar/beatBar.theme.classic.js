// Beat Bar theme: classic. Markers slide in from both sides and meet on a centre target,
// which flashes on every beat.
//
// A theme is { name, ahead, behind, height(playerHeight), draw(ctx, view) } registered on
// window.BeatBarThemes. draw() gets a cleared canvas (CSS pixels) and a view:
//   W, H                  size of the bar
//   t                     playhead, seconds
//   beats                 [{ t, dt, gap, i }] beats from t-behind to t+ahead:
//                         dt = seconds until the beat (negative = already passed),
//                         gap = seconds to the following beat, i = beat number
//   ahead, behind         seconds shown either side of now
//   pulse                 1 on a beat, decaying toward 0 after it
//   progress              0..1 from the last beat to the next
//   colors                the theme's colours (copy them to make a variant)
//   heatColor(b)          marker colour for beat b: colors.marker heating toward colors.hot
//                         in fast sections (off when the user turns tempo colours off)
//   mix(a, b, k)          blend two "#rrggbb" colours
// Each beat also has heat: 0 (80 BPM or slower) .. 1 (240 BPM or faster).
(function () {
  "use strict";
  const themes = (window.BeatBarThemes = window.BeatBarThemes || {});

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  themes.classic = {
    name: "Classic",
    ahead: 2.0,
    behind: 0.35,
    colors: { background: "rgba(0,0,0,0.45)", marker: "#ffffff", hot: "#ffb347", target: "#ff4fb0", glow: "rgba(255,79,176,0.9)" },
    height: (playerH) => Math.round(Math.max(34, Math.min(80, playerH * 0.09))),
    draw(ctx, v) {
      const c = this.colors;
      const W = v.W, H = v.H, cx = W / 2, cy = H / 2;
      const r = H * 0.3;

      ctx.fillStyle = c.background;
      roundRect(ctx, 0, H * 0.1, W, H * 0.8, H * 0.4);
      ctx.fill();

      // markers: both sides, from the edges to the target
      const reach = cx - r - 6;
      const mw = Math.max(3, H * 0.09), mh = H * 0.56;
      for (const b of v.beats) {
        if (b.dt < 0) continue;
        const off = r + (b.dt / v.ahead) * reach;
        const alpha = Math.min(1, (1 - b.dt / v.ahead) * 5); // fade in at the edges
        ctx.globalAlpha = alpha;
        ctx.fillStyle = v.heatColor(b);
        for (const x of [cx - off, cx + off]) {
          roundRect(ctx, x - mw / 2, cy - mh / 2, mw, mh, mw / 2);
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;

      // beats just passed: a ring bursting outward from the target
      for (const b of v.beats) {
        if (b.dt >= 0 || -b.dt > v.behind) continue;
        const k = -b.dt / v.behind;
        ctx.strokeStyle = c.target;
        ctx.globalAlpha = (1 - k) * 0.8;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, r * (1 + k * 1.2), 0, 2 * Math.PI);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // target
      ctx.shadowColor = c.glow;
      ctx.shadowBlur = 18 * v.pulse;
      ctx.fillStyle = c.target;
      ctx.globalAlpha = 0.25 + 0.75 * v.pulse;
      ctx.beginPath();
      ctx.arc(cx, cy, r * (1 + 0.15 * v.pulse), 0, 2 * Math.PI);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
      ctx.strokeStyle = c.marker;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, 2 * Math.PI);
      ctx.stroke();
    },
  };
})();
