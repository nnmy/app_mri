/* ============================================================================
 * vol_view/lib/mosaic.js — a mosaic of slices, as PNG or PDF
 * ----------------------------------------------------------------------------
 * The grid's rows and columns follow one rule, from the shape of a slice as
 * drawn (screen pixels, after the physical aspect):
 *     taller than wide (portrait)                 -> 3 rows × 6 columns
 *     wider than tall (landscape)                 -> 4 rows × 5 columns
 *     roughly square (within SQUARE_TOLERANCE)    -> 3 rows × 5 columns
 * Portrait tiles are narrow, so more fit across; landscape ones are wide, so
 * an extra row makes up the count.
 *
 * The grid is only the default: the page lets the user set rows × columns.
 *
 * The tiles span the slices that carry anatomy (or the shown segments), not
 * the whole array: a raw scan has noise-only slices at both ends, and
 * spreading the tiles over them spends a row on black.
 *
 * The files' metadata is printed under the tiles, one block per file side by
 * side (wrapping when the page is narrow), so a printout says what it shows.
 *
 * Saving it as PNG or PDF: common/js/pdf.js.
 * ========================================================================== */
(function () {
  "use strict";
  const VV = (window.VV = window.VV || {});

  const SQUARE_TOLERANCE = 0.10;
  const PORTRAIT = [3, 6], LANDSCAPE = [4, 5], SQUARE = [3, 5];
  // A slice is "occupied" when more than this fraction of its voxels carry
  // signal (common/med/volume.js signalProfile): small, to skip noise, not crop anatomy.
  const OCCUPIED_FRACTION = 0.002;

  function layoutFor(width, height) {
    const ratio = Math.max(1, width) / Math.max(1, height);
    if (ratio < 1 - SQUARE_TOLERANCE) return PORTRAIT;
    if (ratio > 1 + SQUARE_TOLERANCE) return LANDSCAPE;
    return SQUARE;
  }

  /** [first, last] slice holding signal; the whole range if none does. */
  function occupiedSpan(profile) {
    let lo = -1, hi = -1;
    profile.forEach((f, i) => { if (f > OCCUPIED_FRACTION) { if (lo < 0) lo = i; hi = i; } });
    return lo < 0 ? [0, profile.length - 1] : [lo, hi];
  }

  /** [first, last] slice holding any of `counts` (Int32Arrays); null if none. */
  function countSpan(countsList) {
    let lo = Infinity, hi = -1;
    for (const counts of countsList)
      for (let i = 0; i < counts.length; i++) if (counts[i]) { lo = Math.min(lo, i); hi = Math.max(hi, i); }
    return hi < 0 ? null : [lo, hi];
  }

  /** n evenly spaced slices in [lo, hi], unique (a thin span gives fewer). */
  function sliceIndices(lo, hi, n) {
    const out = new Set();
    for (let t = 0; t < n; t++) out.add(Math.floor(n > 1 ? lo + (t * (hi - lo)) / (n - 1) : (lo + hi) / 2));
    return Array.from(out).sort((a, b) => a - b);
  }

  /**
   * The mosaic as a canvas.
   *   tiles    [{ rgba, caption }] -- all the same w × h
   *   o        { w, h, ax, ay (pixel aspect), scale, cols, title, letters,
   *              legend:[{name, color}], meta:[{title, rows:[[key, value]]}],
   *              background, gap }
   */
  function compose(tiles, o) {
    const tw = Math.round(o.w * o.ax * o.scale), th = Math.round(o.h * o.ay * o.scale);
    const gap = o.gap, pad = Math.max(8, gap * 2);
    const cols = Math.min(o.cols, tiles.length), rows = Math.ceil(tiles.length / cols);
    const font = Math.max(11, Math.min(18, Math.round(tw / 14)));
    const titleH = o.title ? Math.round(font * 2) : 0;
    const width = pad * 2 + cols * tw + (cols - 1) * gap;

    // Legend: wrapped rows of swatch + name.
    const ctxM = document.createElement("canvas").getContext("2d");
    ctxM.font = `${font}px system-ui, sans-serif`;
    const legendRows = [];
    if (o.legend && o.legend.length) {
      let row = [], x = 0;
      for (const item of o.legend) {
        const iw = font * 1.2 + ctxM.measureText(item.name).width + font * 1.4;
        if (row.length && x + iw > width - 2 * pad) { legendRows.push(row); row = []; x = 0; }
        row.push({ ...item, x, iw });
        x += iw;
      }
      legendRows.push(row);
    }
    const legendH = legendRows.length ? legendRows.length * font * 1.6 + gap * 2 : 0;

    // Metadata: blocks of "key  value" lines, placed left to right.
    const mfont = Math.max(10, Math.round(font * 0.85)), line = mfont * 1.45;
    const metaPlaced = [];
    let metaH = 0;
    if (o.meta && o.meta.length) {
      ctxM.font = `${mfont}px system-ui, sans-serif`;
      const inner = width - 2 * pad, colGap = mfont * 2.5;
      let x = 0, y = 0, rowH = 0;
      for (const b of o.meta) {
        const keyW = Math.max(...b.rows.map(([k]) => ctxM.measureText(k).width)) + mfont;
        const valW = Math.max(...b.rows.map(([, v]) => ctxM.measureText(String(v)).width));
        const bw = Math.min(inner, keyW + valW), bh = (b.rows.length + 1) * line;
        if (x > 0 && x + bw > inner) { x = 0; y += rowH + line * 0.6; rowH = 0; }
        metaPlaced.push({ ...b, x, y, keyW, bw });
        x += bw + colGap;
        rowH = Math.max(rowH, bh);
      }
      metaH = y + rowH + gap * 3;
    }
    const height = pad * 2 + titleH + rows * th + (rows - 1) * gap + legendH + metaH;

    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width);
    canvas.height = Math.round(height);
    const ctx = canvas.getContext("2d");
    const dark = o.background !== "white";
    const fg = dark ? "#ffffff" : "#111111";
    ctx.fillStyle = dark ? "#000000" : "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.textBaseline = "top";
    if (o.title) {
      ctx.fillStyle = fg;
      ctx.font = `600 ${Math.round(font * 1.15)}px system-ui, sans-serif`;
      ctx.fillText(o.title, pad, pad);
    }
    ctx.imageSmoothingEnabled = false;
    const tmp = document.createElement("canvas");
    tiles.forEach((t, n) => {
      const x = pad + (n % cols) * (tw + gap), y = pad + titleH + Math.floor(n / cols) * (th + gap);
      Med.render.toCanvas(t.rgba, o.w, o.h, tmp);
      ctx.drawImage(tmp, 0, 0, o.w, o.h, x, y, tw, th);
      ctx.font = `${font}px system-ui, sans-serif`;
      const label = (s, lx, ly, align) => {
        ctx.textAlign = align;
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(0,0,0,.85)";
        ctx.strokeText(s, lx, ly);
        ctx.fillStyle = "#ffffff";
        ctx.fillText(s, lx, ly);
      };
      if (t.caption) label(t.caption, x + 5, y + 4, "left");
      if (o.letters && n === 0) {
        const L = o.letters;
        label(L.top, x + tw / 2, y + 4, "center");
        label(L.bottom, x + tw / 2, y + th - font - 4, "center");
        label(L.left, x + 5, y + th / 2 - font / 2, "left");
        label(L.right, x + tw - 5, y + th / 2 - font / 2, "right");
      }
      ctx.textAlign = "left";
    });
    if (legendRows.length) {
      let y = pad + titleH + rows * th + (rows - 1) * gap + gap * 2;
      ctx.font = `${font}px system-ui, sans-serif`;
      for (const row of legendRows) {
        for (const it of row) {
          ctx.fillStyle = Med.labels.css(it.color);
          ctx.fillRect(pad + it.x, y + font * 0.1, font * 0.9, font * 0.9);
          ctx.fillStyle = fg;
          ctx.fillText(it.name, pad + it.x + font * 1.2, y);
        }
        y += font * 1.6;
      }
    }
    if (metaPlaced.length) {
      const top = pad + titleH + rows * th + (rows - 1) * gap + legendH + gap * 3;
      const fit = (text, max) => {               // ellipsis for a value too long
        if (ctx.measureText(text).width <= max) return text;
        while (text.length > 1 && ctx.measureText(text + "…").width > max) text = text.slice(0, -1);
        return text + "…";
      };
      for (const b of metaPlaced) {
        const x = pad + b.x;
        let y = top + b.y;
        ctx.fillStyle = fg;
        ctx.font = `600 ${mfont}px system-ui, sans-serif`;
        ctx.fillText(b.title, x, y);
        y += line;
        ctx.font = `${mfont}px system-ui, sans-serif`;
        for (const [k, v] of b.rows) {
          ctx.fillStyle = dark ? "#9ca3af" : "#6b7280";
          ctx.fillText(k, x, y);
          ctx.fillStyle = fg;
          ctx.fillText(fit(String(v), b.bw - b.keyW), x + b.keyW, y);
          y += line;
        }
      }
    }
    return canvas;
  }

  VV.mosaic = { layoutFor, occupiedSpan, countSpan, sliceIndices, compose };
})();
