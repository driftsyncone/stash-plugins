// Beat Bar theme: angular. A dark angled strip with purple edges and chevron end caps; heart
// markers scroll from right to left through a raised centre panel holding the target heart,
// and carry on to the left (dimmed) after the beat. See beatBar.theme.classic.js for the API.
(function () {
  "use strict";
  const themes = (window.BeatBarThemes = window.BeatBarThemes || {});

  function heart(ctx, x, y, s) {
    // heart centred on (x, y), s = width
    const h = s * 0.9;
    ctx.beginPath();
    ctx.moveTo(x, y + h * 0.45);
    ctx.bezierCurveTo(x - s * 0.62, y + h * 0.02, x - s * 0.5, y - h * 0.55, x, y - h * 0.22);
    ctx.bezierCurveTo(x + s * 0.5, y - h * 0.55, x + s * 0.62, y + h * 0.02, x, y + h * 0.45);
    ctx.closePath();
  }

  function poly(ctx, pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
  }

  themes.angular = {
    name: "Angular",
    ahead: 2.2,
    behind: 2.2,
    colors: {
      body: "#121218", bodyHi: "#22222c", stripe: "rgba(255,255,255,0.05)",
      edge: "#8f3dff", cap: "#7a2fe0", marker: "#b45cff", hot: "#ff3d8b", markerEdge: "#f1e2ff",
      target: "#c77dff", glow: "rgba(170,80,255,0.95)",
    },
    height: (playerH) => Math.round(Math.max(36, Math.min(88, playerH * 0.1))),
    draw(ctx, v) {
      const c = this.colors;
      const W = v.W, H = v.H, cx = W / 2;
      const top = H * 0.24, bot = H * 0.92, mid = (top + bot) / 2, bh = bot - top;
      const capW = Math.max(18, H * 0.9), slant = bh * 0.6;

      // strip body with fine horizontal stripes
      const g = ctx.createLinearGradient(0, top, 0, bot);
      g.addColorStop(0, c.bodyHi);
      g.addColorStop(1, c.body);
      ctx.fillStyle = g;
      poly(ctx, [[capW * 0.5, top], [W - capW * 0.5, top], [W - capW * 0.5 - slant, bot], [capW * 0.5 + slant, bot]]);
      ctx.fill();
      ctx.strokeStyle = c.stripe;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let y = top + 3; y < bot - 1; y += 3) {
        ctx.moveTo(capW, Math.round(y) + 0.5);
        ctx.lineTo(W - capW, Math.round(y) + 0.5);
      }
      ctx.stroke();
      ctx.strokeStyle = c.edge;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(capW * 0.5, top);
      ctx.lineTo(W - capW * 0.5, top);
      ctx.moveTo(capW * 0.5 + slant, bot);
      ctx.lineTo(W - capW * 0.5 - slant, bot);
      ctx.stroke();

      // raised centre panel (the target zone)
      const pw = Math.max(H * 2.2, W * 0.12), ptop = H * 0.08;
      const pg = ctx.createLinearGradient(0, ptop, 0, bot);
      pg.addColorStop(0, "#2c2c38");
      pg.addColorStop(1, c.body);
      ctx.fillStyle = pg;
      poly(ctx, [[cx - pw / 2, ptop], [cx + pw / 2, ptop], [cx + pw / 2 + slant * 0.6, bot], [cx - pw / 2 - slant * 0.6, bot]]);
      ctx.fill();
      ctx.strokeStyle = c.edge;
      ctx.globalAlpha = 0.6 + 0.4 * v.pulse;
      ctx.stroke();
      ctx.globalAlpha = 1;

      // markers: right (coming) to left (gone)
      const span = cx - capW * 1.1;
      const ms = bh * 0.62;
      ctx.lineWidth = 1.2;
      for (const b of v.beats) {
        const k = b.dt >= 0 ? b.dt / v.ahead : b.dt / v.behind; // -1..1
        const x = cx + k * span;
        const edgeFade = Math.min(1, (1 - Math.abs(k)) * 6);
        ctx.globalAlpha = edgeFade * (b.dt < 0 ? 0.45 : 1);
        ctx.shadowColor = c.glow;
        ctx.shadowBlur = b.dt >= 0 ? 8 : 0;
        ctx.fillStyle = v.heatColor(b);
        heart(ctx, x, mid, ms);
        ctx.fill();
        ctx.shadowBlur = 0;
        ctx.strokeStyle = c.markerEdge;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // target heart: outline, filling and glowing on each beat
      const ts = bh * (0.95 + 0.18 * v.pulse);
      ctx.shadowColor = c.glow;
      ctx.shadowBlur = 6 + 22 * v.pulse;
      ctx.fillStyle = c.target;
      ctx.globalAlpha = 0.18 + 0.82 * v.pulse;
      heart(ctx, cx, mid, ts);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
      ctx.strokeStyle = c.markerEdge;
      ctx.lineWidth = 2;
      ctx.stroke();

      // chevron end caps
      ctx.fillStyle = c.cap;
      for (const side of [-1, 1]) {
        const x0 = side < 0 ? 0 : W;
        const inner = x0 - side * capW;
        poly(ctx, [[x0, top - 2], [inner + side * slant * 0.2, top - 2], [inner - side * slant * 0.6, mid],
          [inner + side * slant * 0.2, bot + 1], [x0, bot + 1]]);
        ctx.fill();
        ctx.strokeStyle = c.markerEdge;
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x0 - side * capW * 0.35, top + bh * 0.2);
        ctx.lineTo(x0 - side * capW * 0.6, mid);
        ctx.lineTo(x0 - side * capW * 0.35, bot - bh * 0.2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    },
  };
})();
