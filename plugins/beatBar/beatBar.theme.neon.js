// Beat Bar theme: neon. Synthwave: glowing cyan bars scroll right to left along a neon rail
// into a magenta ring on the left, which bursts on every beat. See beatBar.theme.classic.js.
(function () {
  "use strict";
  const themes = (window.BeatBarThemes = window.BeatBarThemes || {});
  themes.neon = {
    name: "Neon",
    ahead: 2.4,
    behind: 0.5,
    colors: { marker: "#29f0ff", hot: "#fff35c", rail: "#29f0ff", target: "#ff2fd0", glow: "#ff2fd0", flash: "#ff2fd0" },
    height: (playerH) => Math.round(Math.max(36, Math.min(84, playerH * 0.095))),
    draw(ctx, v) {
      const c = this.colors;
      const W = v.W, H = v.H, mid = H / 2, tx = Math.max(H * 1.2, W * 0.18), r = H * 0.3;

      const bg = ctx.createLinearGradient(0, 0, 0, H);
      bg.addColorStop(0, "rgba(20,0,40,0)");
      bg.addColorStop(0.5, "rgba(20,0,40,0.55)");
      bg.addColorStop(1, "rgba(20,0,40,0)");
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);

      // rail, glowing, with a perspective grid fading to the right
      ctx.shadowColor = c.rail;
      ctx.shadowBlur = 10;
      ctx.strokeStyle = c.rail;
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, mid);
      ctx.lineTo(W, mid);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 0.18;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const tick = 0.25 / v.ahead; // a tick every quarter second, scrolling with the beats
      const phase = ((v.t % 0.25) / 0.25) * tick;
      for (let k = -phase; k < 1; k += tick) {
        const x = tx + k * (W - tx);
        ctx.moveTo(x, H * 0.2);
        ctx.lineTo(x, H * 0.8);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;

      // bars
      for (const b of v.beats) {
        const x = b.dt >= 0 ? tx + (b.dt / v.ahead) * (W - tx - 6) : tx + (b.dt / v.behind) * tx;
        const fade = b.dt >= 0 ? Math.min(1, (1 - b.dt / v.ahead) * 6) : 1 + b.dt / v.behind;
        const col = v.heatColor(b);
        ctx.globalAlpha = Math.max(0, fade) * (b.dt < 0 ? 0.5 : 1);
        ctx.shadowColor = col;
        ctx.shadowBlur = 12;
        ctx.fillStyle = col;
        const bw = Math.max(3, H * 0.07), bh = H * (0.5 + 0.2 * b.heat);
        ctx.fillRect(x - bw / 2, mid - bh / 2, bw, bh);
      }
      ctx.globalAlpha = 1;

      // target ring + burst
      ctx.shadowColor = c.glow;
      ctx.shadowBlur = 8 + 26 * v.pulse;
      ctx.strokeStyle = c.target;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(tx, mid, r * (1 + 0.25 * v.pulse), 0, 2 * Math.PI);
      ctx.stroke();
      ctx.fillStyle = c.target;
      ctx.globalAlpha = 0.15 + 0.7 * v.pulse;
      ctx.fill();
      ctx.globalAlpha = v.pulse;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * 2 * Math.PI, r0 = r * 1.3, r1 = r * (1.3 + 0.9 * (1 - v.pulse));
        ctx.moveTo(tx + Math.cos(a) * r0, mid + Math.sin(a) * r0);
        ctx.lineTo(tx + Math.cos(a) * r1, mid + Math.sin(a) * r1);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
    },
  };
})();
