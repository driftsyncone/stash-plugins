// Beat Bar theme: approach. Rhythm-game style: a ring closes in on the centre circle for each
// beat and lands exactly on it on the beat; small dots on either side show what's coming.
(function () {
  "use strict";
  const themes = (window.BeatBarThemes = window.BeatBarThemes || {});
  themes.approach = {
    name: "Approach",
    ahead: 1.2,
    behind: 0.3,
    colors: { background: "rgba(0,0,0,0.4)", marker: "#7fd4ff", hot: "#ff5f7e", target: "#ffffff", glow: "#7fd4ff", flash: "#7fd4ff" },
    height: (playerH) => Math.round(Math.max(44, Math.min(100, playerH * 0.12))),
    draw(ctx, v) {
      const c = this.colors;
      const W = v.W, H = v.H, cx = W / 2, cy = H / 2, r = H * 0.17, R = H * 0.48; // R: largest ring that fits
      ctx.fillStyle = c.background;
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.min(W / 2, H * 4), H * 0.5, 0, 0, 2 * Math.PI);
      ctx.fill();

      // preview dots: upcoming beats laid out on both sides
      for (const b of v.beats) {
        if (b.dt < 0) continue;
        const off = r + 8 + (b.dt / v.ahead) * (H * 3.4);
        ctx.globalAlpha = Math.min(1, (1 - b.dt / v.ahead) * 4) * 0.8;
        ctx.fillStyle = v.heatColor(b);
        for (const x of [cx - off, cx + off]) {
          ctx.beginPath();
          ctx.arc(x, cy, Math.max(2, H * 0.05), 0, 2 * Math.PI);
          ctx.fill();
        }
      }
      // approach rings (furthest first)
      for (let i = v.beats.length - 1; i >= 0; i--) {
        const b = v.beats[i];
        if (b.dt < 0) continue;
        const k = b.dt / v.ahead;
        ctx.globalAlpha = Math.min(1, (1 - k) * 2.5);
        ctx.strokeStyle = v.heatColor(b);
        ctx.lineWidth = 2 + 2 * (1 - k);
        ctx.beginPath();
        ctx.arc(cx, cy, r + k * (R - r), 0, 2 * Math.PI);
        ctx.stroke();
      }
      // hit: a fading ring growing past the circle
      for (const b of v.beats) {
        if (b.dt >= 0) continue;
        const k = -b.dt / v.behind;
        ctx.globalAlpha = (1 - k) * 0.9;
        ctx.strokeStyle = c.target;
        ctx.lineWidth = 3 * (1 - k) + 0.5;
        ctx.beginPath();
        ctx.arc(cx, cy, r * (1 + k * 0.8), 0, 2 * Math.PI);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.shadowColor = c.glow;
      ctx.shadowBlur = 20 * v.pulse;
      ctx.fillStyle = c.target;
      ctx.globalAlpha = 0.2 + 0.8 * v.pulse;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, 2 * Math.PI);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
      ctx.strokeStyle = c.target;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    },
  };
})();
