/* ============================================================================
 * common/js/chart.js — bar charts on a canvas (window.Viz.chart)
 * ----------------------------------------------------------------------------
 * Drawn on a 2D canvas, so the same chart is shown on the page and saved
 * into a PDF / PNG figure (common/js/report.js) as it is.
 *
 *   Viz.chart.grouped(canvas, {
 *     title, yLabel, categories: ["Cerebral WM", …],
 *     series: [{ label: "IXI051 (25 y)", color: "#…", values: [89.4, …] }, …],
 *     format: (v) => v.toFixed(1),            // the value over each bar
 *     tip: (i, j) => "…",                     // hover text, category i, series j (optional)
 *   });
 *   Viz.chart.stacked(canvas, {
 *     title, panels: [{ title: "Thalamus", bars: [
 *       { label: "IXI051", sublabel: "25 y", top: "4,261", parts: [n0, n1, n2, n3] }, …] }, …],
 *     parts: [{ label: "L-R", color: "#…" }, …],   // bottom to top
 *     tip: (panel, bar, k) => "…",                 // hover text (optional)
 *   });
 *
 * Each chart sizes the canvas to its element's CSS width (× the device
 * pixel ratio) and to opts.height CSS pixels; `opts.scale` instead draws at
 * a fixed pixel size (for an export, no hover). Thin bars with rounded ends,
 * a 2 px gap between neighbours, recessive grid and axes; the values of a
 * stack's parts are in the hover tooltip (Viz.ui.tip), not on the bars.
 * ========================================================================== */
(function () {
  "use strict";
  const Viz = (window.Viz = window.Viz || {});

  const INK = "#2b2f36", INK2 = "#6b7280", GRID = "#eceef1", AXIS = "#c9ccd1", BG = "#fff";
  const FONT = "system-ui, -apple-system, Segoe UI, sans-serif";
  const GAP = 2, RADIUS = 4;

  /** A tidy axis: [0, top] with about n steps of 1, 2 or 5 × 10^k. */
  function niceTicks(max, n) {
    if (!(max > 0)) return { top: 1, step: 0.2 };
    const raw = max / (n || 5), mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
    return { top: Math.ceil(max / step) * step, step };
  }
  const short = (v) => (v >= 1000 ? `${+(v / 1000).toFixed(1)}k` : String(+v.toFixed(3)));

  function setup(canvas, o) {
    const dpr = o.scale || window.devicePixelRatio || 1;
    const cssW = o.width || canvas.clientWidth || 600, cssH = o.height || 300;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    if (!o.scale) canvas.style.height = cssH + "px";
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, cssW, cssH);
    const hits = [];
    if (!o.scale) hover(canvas, hits, cssW);
    return { ctx, w: cssW, h: cssH, hits };
  }
  const font = (px, bold) => `${bold ? "600 " : ""}${px}px ${FONT}`;

  /** The hover tooltip: the hit under the pointer (CSS px of the chart). */
  function hover(canvas, hits, cssW) {
    canvas._hits = hits;
    canvas._cssW = cssW;
    if (canvas._hover) return;
    canvas._hover = true;
    canvas.dataset.hoverTip = "";
    const at = (e) => {
      const r = canvas.getBoundingClientRect(), k = canvas._cssW / r.width;
      const x = (e.clientX - r.left) * k, y = (e.clientY - r.top) * k;
      const h = canvas._hits.find((b) => x >= b.x - 2 && x <= b.x + b.w + 2 && y >= b.y - 2 && y <= b.y + b.h + 2);
      canvas.style.cursor = h ? "default" : "";
      Viz.ui.tip(e, h && h.text);
    };
    canvas.addEventListener("pointermove", at);
    canvas.addEventListener("pointerdown", at);
    canvas.addEventListener("pointerleave", (e) => Viz.ui.tip(e, null));
  }

  /** A bar whose top corners are rounded (it stands on the baseline). */
  function bar(ctx, x, y, w, h, rTop) {
    if (h <= 0 || w <= 0) return;
    const r = Math.min(rTop, w / 2, h);
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h);
    ctx.closePath();
    ctx.fill();
  }

  function title(ctx, text, x) {
    ctx.fillStyle = INK; ctx.font = font(14, true); ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillText(text || "", x, 8);
  }

  function gridLines(ctx, x0, y0, plotW, plotH, ticks, fmt, size) {
    ctx.font = font(size || 11);
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 1;
    for (let v = 0; v <= ticks.top + 1e-9; v += ticks.step) {
      const y = Math.round(y0 - (v / ticks.top) * plotH) + 0.5;
      ctx.strokeStyle = v ? GRID : AXIS;
      ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + plotW, y); ctx.stroke();
      ctx.fillStyle = INK2;
      ctx.fillText((fmt || short)(v), x0 - 6, y);
    }
  }

  function legend(ctx, items, x, y) {
    ctx.font = font(12);
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    for (const it of items) {
      ctx.fillStyle = it.color;
      ctx.beginPath(); ctx.roundRect(x, y - 5, 10, 10, 2); ctx.fill();
      ctx.fillStyle = INK2;
      ctx.fillText(it.label, x + 15, y);
      x += 30 + ctx.measureText(it.label).width;
    }
  }

  /** Text cut to a width, with an ellipsis. */
  function fit(ctx, s, maxW) {
    if (ctx.measureText(s).width <= maxW) return s;
    while (s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1);
    return s + "…";
  }

  /** Bars side by side per category, one per series. */
  function grouped(canvas, o) {
    const { ctx, w, h, hits } = setup(canvas, o);
    const top = 62, bottom = 30, left = 52, right = 8;
    const plotW = w - left - right, plotH = h - top - bottom, y0 = top + plotH;
    title(ctx, o.title, 8);
    legend(ctx, o.series.map((s) => ({ label: s.label, color: s.color })), 8, 40);
    const max = Math.max(0, ...o.series.flatMap((s) => s.values.filter(Number.isFinite)));
    const ticks = niceTicks(max * 1.1, 5);
    gridLines(ctx, left, y0, plotW, plotH, ticks, o.yFormat);
    if (o.yLabel) {
      ctx.save(); ctx.translate(12, y0 - plotH / 2); ctx.rotate(-Math.PI / 2);
      ctx.textAlign = "center"; ctx.fillStyle = INK2; ctx.font = font(11); ctx.fillText(o.yLabel, 0, 0); ctx.restore();
    }
    const nC = o.categories.length, nS = o.series.length, slot = plotW / Math.max(1, nC);
    const barW = Math.max(4, Math.min(34, (slot * 0.7) / nS));
    o.categories.forEach((c, i) => {
      const cx = left + slot * (i + 0.5);
      o.series.forEach((s, j) => {
        const v = s.values[i];
        if (!Number.isFinite(v)) return;
        const x = cx + (j - nS / 2) * barW, bh = (v / ticks.top) * plotH;
        ctx.fillStyle = s.color;
        bar(ctx, x + GAP / 2, y0 - bh, barW - GAP, bh, RADIUS);
        if (barW >= 18) {
          ctx.fillStyle = INK2; ctx.font = font(10.5); ctx.textAlign = "center"; ctx.textBaseline = "bottom";
          ctx.fillText(o.format ? o.format(v) : String(v), x + barW / 2, y0 - bh - 3);
        }
        hits.push({ x, y: y0 - bh, w: barW, h: Math.max(bh, 6),
                    text: o.tip ? o.tip(i, j) : `${s.label} · ${c}: ${o.format ? o.format(v) : v}` });
      });
      ctx.fillStyle = INK; ctx.font = font(11.5); ctx.textAlign = "center"; ctx.textBaseline = "top";
      ctx.fillText(fit(ctx, c, slot - 6), cx, y0 + 8);
    });
    return canvas;
  }

  /** Panels side by side; in each, stacked bars (parts bottom to top). */
  function stacked(canvas, o) {
    const { ctx, w, h, hits } = setup(canvas, o);
    const nP = o.panels.length, gap = 18, left = 8, top = 62, bottom = 40, head = 22;
    const panelW = (w - left - gap * (nP - 1) - 6) / Math.max(1, nP);
    title(ctx, o.title, left);
    legend(ctx, o.parts, left, 40);
    o.panels.forEach((p, i) => {
      const px = left + i * (panelW + gap), axisW = 36;
      const plotW = panelW - axisW, plotH = h - top - bottom - head - 14, y0 = top + head + 14 + plotH;
      const max = Math.max(1, ...p.bars.map((b) => b.parts.reduce((a, c) => a + c, 0)));
      const ticks = niceTicks(max * 1.12, 4);
      ctx.save();
      ctx.translate(px, 0);
      ctx.fillStyle = INK; ctx.font = font(12, true); ctx.textAlign = "center"; ctx.textBaseline = "top";
      ctx.fillText(fit(ctx, p.title, panelW), axisW + plotW / 2, top);
      gridLines(ctx, axisW, y0, plotW, plotH, ticks, null, 10);
      const slot = plotW / p.bars.length, barW = Math.max(6, Math.min(40, slot * 0.56));
      p.bars.forEach((b, j) => {
        const x = axisW + slot * (j + 0.5) - barW / 2;
        let y = y0;
        const last = b.parts.reduce((k, v, n) => (v > 0 ? n : k), -1);
        b.parts.forEach((v, k) => {
          const bh = (v / ticks.top) * plotH;
          if (bh <= 0) return;
          ctx.fillStyle = o.parts[k].color;
          // A 2 px surface gap above each part but the top one.
          const drawn = k === last ? bh : Math.max(0.5, bh - GAP);
          if (k === last) bar(ctx, x, y - bh, barW, bh, RADIUS);
          else ctx.fillRect(x, y - drawn, barW, drawn);
          hits.push({ x: px + x, y: y - bh, w: barW, h: Math.max(bh, 3),
                      text: o.tip ? o.tip(i, j, k) : `${b.label} · ${p.title} · ${o.parts[k].label}: ${v}` });
          y -= bh;
        });
        if (b.top) { ctx.fillStyle = INK2; ctx.font = font(10); ctx.textAlign = "center"; ctx.textBaseline = "bottom"; ctx.fillText(b.top, x + barW / 2, y - 3); }
        ctx.fillStyle = INK; ctx.font = font(slot < 56 ? 9.5 : 11, true); ctx.textAlign = "center"; ctx.textBaseline = "top";
        ctx.fillText(fit(ctx, b.label, slot - 4), x + barW / 2, y0 + 6);
        if (b.sublabel) { ctx.fillStyle = INK2; ctx.font = font(10); ctx.fillText(fit(ctx, b.sublabel, slot - 4), x + barW / 2, y0 + 20); }
      });
      ctx.restore();
    });
    return canvas;
  }

  Viz.chart = { grouped, stacked, niceTicks };
})();
