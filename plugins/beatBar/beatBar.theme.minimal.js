// Beat Bar theme: minimal. A thin line with small dots sliding right to left onto a tick in the
// middle; the dot on the tick grows on each beat. Low-profile, good on phones.
(function () {
  "use strict";
  const themes = (window.BeatBarThemes = window.BeatBarThemes || {});
  themes.minimal = {
    name: "Minimal",
    ahead: 1.8,
    behind: 0.6,
    colors: { line: "rgba(255,255,255,0.35)", marker: "#ffffff", hot: "#ff6b6b", target: "#ffffff", flash: "#ffffff" },
    height: (playerH) => Math.round(Math.max(22, Math.min(40, playerH * 0.05))),
    draw(ctx, v) {
      const c = this.colors;
      const W = v.W, H = v.H, mid = H * 0.55, cx = W / 2;
      ctx.strokeStyle = c.line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(W * 0.1, Math.round(mid) + 0.5);
      ctx.lineTo(W * 0.9, Math.round(mid) + 0.5);
      ctx.moveTo(Math.round(cx) + 0.5, mid - H * 0.32);
      ctx.lineTo(Math.round(cx) + 0.5, mid + H * 0.32);
      ctx.stroke();
      const span = W * 0.4, r = Math.max(2.5, H * 0.1);
      for (const b of v.beats) {
        const k = b.dt >= 0 ? b.dt / v.ahead : b.dt / v.behind;
        ctx.globalAlpha = Math.max(0, Math.min(1, (1 - Math.abs(k)) * 4)) * (b.dt < 0 ? 0.35 : 0.95);
        ctx.fillStyle = v.heatColor(b);
        ctx.beginPath();
        ctx.arc(cx + k * span, mid, r, 0, 2 * Math.PI);
        ctx.fill();
      }
      ctx.globalAlpha = 0.5 + 0.5 * v.pulse;
      ctx.fillStyle = c.target;
      ctx.beginPath();
      ctx.arc(cx, mid, r * (1.2 + 1.1 * v.pulse), 0, 2 * Math.PI);
      ctx.fill();
      ctx.globalAlpha = 1;
    },
  };
})();
