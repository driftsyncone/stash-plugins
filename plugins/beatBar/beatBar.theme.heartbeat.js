// Beat Bar theme: heartbeat. A heart-monitor trace scrolls right to left past the scan head;
// each beat is a spike that peaks exactly as it crosses the head, which blips. Faster sections
// spike higher. Upcoming trace is dim, the part already traced glows.
(function () {
  "use strict";
  const themes = (window.BeatBarThemes = window.BeatBarThemes || {});

  // shape of one beat, as height (-1..1) by time from the beat in seconds
  function spike(dt) {
    const a = Math.abs(dt);
    if (a > 0.09) return 0;
    if (dt < -0.03) return -0.18 * Math.sin(((dt + 0.09) / 0.06) * Math.PI); // dip before
    if (dt > 0.04) return -0.3 * Math.sin(((dt - 0.04) / 0.05) * Math.PI); // dip after
    return 1 - a / 0.04; // the peak, on the beat
  }

  themes.heartbeat = {
    name: "Heartbeat",
    ahead: 2.0,
    behind: 2.0,
    colors: { background: "rgba(0,12,6,0.6)", grid: "rgba(60,255,140,0.10)", trace: "#3cff8c", marker: "#3cff8c", hot: "#ff4d4d", target: "#eafff2", flash: "#3cff8c" },
    height: (playerH) => Math.round(Math.max(40, Math.min(90, playerH * 0.1))),
    draw(ctx, v) {
      const c = this.colors;
      const W = v.W, H = v.H, mid = H * 0.62, hx = W * 0.62, amp = H * 0.48;
      ctx.fillStyle = c.background;
      ctx.fillRect(0, 0, W, H);
      ctx.strokeStyle = c.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const cell = H / 4;
      for (let x = (-(v.t * (hx / v.behind)) % cell + cell) % cell; x < W; x += cell) {
        ctx.moveTo(Math.round(x) + 0.5, 0);
        ctx.lineTo(Math.round(x) + 0.5, H);
      }
      for (let y = cell / 2; y < H; y += cell) {
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(W, Math.round(y) + 0.5);
      }
      ctx.stroke();

      // seconds per pixel either side of the head
      const secAt = (x) => (x < hx ? -((hx - x) / hx) * v.behind : ((x - hx) / (W - hx)) * v.ahead);
      const yAt = (x) => {
        const s = secAt(x);
        let h = 0, heat = 0;
        for (const b of v.beats) {
          const e = spike(s - b.dt);
          if (e !== 0) {
            h += e * (0.6 + 0.4 * b.heat);
            heat = b.heat;
          }
        }
        return [mid - h * amp, heat];
      };
      for (const part of [[hx, W, 0.35], [0, hx, 1]]) {
        ctx.globalAlpha = part[2];
        ctx.shadowColor = c.trace;
        ctx.shadowBlur = part[2] === 1 ? 8 : 0;
        ctx.lineWidth = 2;
        ctx.strokeStyle = c.trace;
        ctx.beginPath();
        for (let x = part[0]; x <= part[1]; x += 1) {
          const [y] = yAt(x);
          if (x === part[0]) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
      // dots under upcoming beats, tempo-coloured
      for (const b of v.beats) {
        if (b.dt < 0) continue;
        const x = hx + (b.dt / v.ahead) * (W - hx);
        ctx.fillStyle = v.heatColor(b);
        ctx.globalAlpha = 0.8;
        ctx.beginPath();
        ctx.arc(x, H - 4, 2.2, 0, 2 * Math.PI);
        ctx.fill();
      }
      // scan head
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = c.target;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(hx) + 0.5, 0);
      ctx.lineTo(Math.round(hx) + 0.5, H);
      ctx.stroke();
      const [hy] = yAt(hx);
      ctx.globalAlpha = 1;
      ctx.shadowColor = c.trace;
      ctx.shadowBlur = 6 + 18 * v.pulse;
      ctx.fillStyle = c.target;
      ctx.beginPath();
      ctx.arc(hx, hy, 3 + 4 * v.pulse, 0, 2 * Math.PI);
      ctx.fill();
      ctx.shadowBlur = 0;
    },
  };
})();
