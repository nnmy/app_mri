/* ============================================================================
 * dwi_4d/lib/sphere.js — the gradient directions on a sphere (DW.sphere)
 * ----------------------------------------------------------------------------
 * A 2-D canvas, orthographic: a sphere outline, its graticule (front solid,
 * back faint), the three axes, and one dot per diffusion-weighted volume at
 * its direction -- and a hollow ring at the opposite point (a measurement
 * along g is the same as along −g, so coverage is judged on both). Dots are
 * coloured by shell; with "radius by b", each shell sits on its own sphere
 * (radius ∝ √b, as in q-space), so a multi-shell scheme reads as nested
 * shells. Volumes not kept are drawn grey and crossed.
 *
 * Drag to turn it, double-click to reset; hover a dot for its volume; click
 * one to keep or drop that volume (onToggle).
 * ========================================================================== */
(function () {
  "use strict";
  const DW = (window.DW = window.DW || {});

  const SHELL_COLORS = ["#2563eb", "#dc2626", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#be185d", "#65a30d"];

  /**
   * canvas, opts { onToggle(index), onHover(index | -1) }.
   * set(points, o): points [{ index, dir:[3] (frame already applied), b,
   * shell, keep, label }], o { radiusByB, antipodes, axes:["x","y","z"] }.
   */
  function create(canvas, opts) {
    let pts = [], o = { radiusByB: false, antipodes: true, axes: ["x", "y", "z"] };
    let rot = null, hover = -1, drag = null, screen = [];
    const reset = () => { rot = mul(rotX(-0.35), rotZ(0.5)); };   // a little from above and the side
    reset();

    function rotX(a) { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, -s, 0, s, c]; }
    function rotZ(a) { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, s, c, 0, 0, 0, 1]; }
    function mul(a, b) {
      const r = new Array(9).fill(0);
      for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) r[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
      return r;
    }
    // World (x right-ish, y, z up) -> screen: rotate, then x right, z up,
    // y into the screen (depth). The view starts looking along +y.
    const apply = (m, v) => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];

    function draw() {
      const dpr = window.devicePixelRatio || 1;
      const W = canvas.clientWidth, H = canvas.clientHeight;
      if (canvas.width !== Math.round(W * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); }
      const ctx = canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const cs = getComputedStyle(canvas);
      const fg = cs.getPropertyValue("--fg").trim() || "#111", muted = cs.getPropertyValue("--muted").trim() || "#888";
      const cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.4;
      const P = (v) => { const r = apply(rot, v); return { x: cx + r[0] * R, y: cy - r[2] * R, z: r[1] }; };
      // Graticule: latitude every 30°, longitude every 30°, back half faint.
      ctx.lineWidth = 1;
      const curve = (fn) => {
        let prev = null;
        for (let t = 0; t <= 72; t++) {
          const p = P(fn((t / 72) * 2 * Math.PI));
          if (prev) {
            ctx.strokeStyle = p.z < 0 && prev.z < 0 ? muted : muted + "40";
            ctx.globalAlpha = p.z < 0 && prev.z < 0 ? 0.55 : 0.35;
            ctx.beginPath(); ctx.moveTo(prev.x, prev.y); ctx.lineTo(p.x, p.y); ctx.stroke();
          }
          prev = p;
        }
      };
      for (let lat = -60; lat <= 60; lat += 30) {
        const z = Math.sin((lat * Math.PI) / 180), r = Math.cos((lat * Math.PI) / 180);
        curve((a) => [r * Math.cos(a), r * Math.sin(a), z]);
      }
      for (let lon = 0; lon < 180; lon += 30) {
        const c = Math.cos((lon * Math.PI) / 180), s = Math.sin((lon * Math.PI) / 180);
        curve((a) => [Math.cos(a) * c, Math.cos(a) * s, Math.sin(a)]);
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = muted;
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, 2 * Math.PI); ctx.stroke();
      // Axes.
      ctx.font = "600 12px system-ui, sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      [[1, 0, 0], [0, 1, 0], [0, 0, 1]].forEach((v, i) => {
        const a = P(v.map((x) => -x * 1.12)), b = P(v.map((x) => x * 1.12));
        ctx.strokeStyle = ["#ef4444", "#22c55e", "#3b82f6"][i];
        ctx.globalAlpha = 0.7;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = ctx.strokeStyle;
        const t = P(v.map((x) => x * 1.22));
        ctx.fillText(o.axes[i], t.x, t.y);
      });
      // Points, back to front.
      const bmax = Math.max(1, ...pts.map((p) => p.b || 0));
      const shells = [...new Set(pts.map((p) => p.shell))].sort((a, b) => a - b);
      const items = [];
      for (const p of pts) {
        const rad = o.radiusByB ? Math.sqrt((p.b || 0) / bmax) : 1;
        const g = p.dir.map((v) => v * rad);
        items.push({ p, s: P(g), anti: false });
        if (o.antipodes) items.push({ p, s: P(g.map((v) => -v)), anti: true });
      }
      items.sort((a, b) => b.s.z - a.s.z);
      screen = [];
      for (const it of items) {
        const { p, s } = it;
        const front = s.z <= 0;
        const color = p.keep ? SHELL_COLORS[shells.indexOf(p.shell) % SHELL_COLORS.length] : "#9ca3af";
        const r = (p.index === hover ? 7.5 : 5.5) * (front ? 1 : 0.8);
        ctx.globalAlpha = front ? 1 : 0.45;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, 2 * Math.PI);
        if (it.anti) { ctx.strokeStyle = color; ctx.stroke(); }
        else { ctx.fillStyle = color; ctx.fill(); ctx.strokeStyle = "#fff"; ctx.lineWidth = 1; ctx.stroke(); }
        if (!p.keep && !it.anti) {
          ctx.strokeStyle = "#ef4444"; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(s.x - r, s.y - r); ctx.lineTo(s.x + r, s.y + r); ctx.moveTo(s.x + r, s.y - r); ctx.lineTo(s.x - r, s.y + r); ctx.stroke();
        }
        screen.push({ x: s.x, y: s.y, index: p.index, front });
      }
      ctx.globalAlpha = 1;
      // Legend.
      ctx.textAlign = "left";
      ctx.font = "12px system-ui, sans-serif";
      let ly = 14;
      for (const [i, sh] of shells.entries()) {
        const n = pts.filter((p) => p.shell === sh && p.keep).length, all = pts.filter((p) => p.shell === sh).length;
        ctx.fillStyle = SHELL_COLORS[i % SHELL_COLORS.length];
        ctx.beginPath(); ctx.arc(14, ly, 5, 0, 2 * Math.PI); ctx.fill();
        ctx.fillStyle = fg;
        ctx.fillText(`b = ${sh}: ${n} of ${all} kept`, 26, ly);
        ly += 18;
      }
      if (o.antipodes) { ctx.fillStyle = muted; ctx.fillText("○ = the opposite direction", 8, ly); }
    }

    function nearest(e) {
      const r = canvas.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      let best = -1, bd = 10;
      for (const s of screen) {
        const d = Math.hypot(s.x - x, s.y - y) - (s.front ? 1 : 0);
        if (d < bd) { bd = d; best = s.index; }
      }
      return best;
    }
    canvas.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, moved: false }; try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* no live pointer */ } });
    canvas.addEventListener("pointermove", (e) => {
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
        drag.x = e.clientX; drag.y = e.clientY;
        // Screen axes: x right, z up (y is depth): a horizontal drag turns
        // about the vertical (z), a vertical drag about the horizontal (x).
        rot = mul(rotZ(dx * 0.01), mul(rotX(dy * 0.01), rot));
        draw();
        return;
      }
      const h = nearest(e);
      if (h !== hover) { hover = h; draw(); if (opts.onHover) opts.onHover(h); }
    });
    canvas.addEventListener("pointerup", (e) => {
      const wasDrag = drag && drag.moved;
      drag = null;
      if (wasDrag) return;
      const h = nearest(e);
      if (h >= 0 && opts.onToggle) opts.onToggle(h);
    });
    canvas.addEventListener("pointerleave", () => { if (hover !== -1) { hover = -1; draw(); if (opts.onHover) opts.onHover(-1); } });
    canvas.addEventListener("dblclick", () => { reset(); draw(); });
    window.addEventListener("resize", draw);

    return {
      set(points, options) { pts = points; Object.assign(o, options || {}); draw(); },
      draw,
      highlight(i) { hover = i; draw(); },
    };
  }

  DW.sphere = { create, SHELL_COLORS };
})();
