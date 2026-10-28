/* ============================================================================
 * common/med/render.js — sampled slices -> RGBA pixels
 * ----------------------------------------------------------------------------
 * Shared by the viewer and the mosaic export, so both draw a slice the same
 * way: the image through a window and a colour map; the labels in their
 * colours, filled at an opacity over the image, outlined, or both. The
 * highlighted segment gets a magenta outline on every panel. Everything is
 * one pixel per grid pixel; scaling to the screen is the caller's.
 * ========================================================================== */
(function () {
  "use strict";
  const Med = (window.Med = window.Med || {});

  const HIGHLIGHT = [236, 72, 153];

  // Colour maps as stops; expanded to a 256-entry table.
  const MAPS = {
    gray: [[0, [0, 0, 0]], [1, [255, 255, 255]]],
    hot: [[0, [0, 0, 0]], [0.375, [255, 0, 0]], [0.75, [255, 255, 0]], [1, [255, 255, 255]]],
    viridis: [[0, [68, 1, 84]], [0.25, [59, 82, 139]], [0.5, [33, 145, 140]], [0.75, [94, 201, 98]], [1, [253, 231, 37]]],
    jet: [[0, [0, 0, 128]], [0.125, [0, 0, 255]], [0.375, [0, 255, 255]], [0.625, [255, 255, 0]], [0.875, [255, 0, 0]], [1, [128, 0, 0]]],
  };

  function lut(name, invert) {
    const stops = MAPS[name] || MAPS.gray;
    const out = new Uint8Array(256 * 3);
    for (let i = 0; i < 256; i++) {
      const t = (invert ? 255 - i : i) / 255;
      let s = 1;
      while (s < stops.length - 1 && stops[s][0] < t) s++;
      const [t0, c0] = stops[s - 1], [t1, c1] = stops[s];
      const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
      for (let c = 0; c < 3; c++) out[i * 3 + c] = Math.round(c0[c] + f * (c1[c] - c0[c]));
    }
    return out;
  }

  /** values (NaN outside) -> RGBA; outside the volume is black. */
  function image(values, win, table) {
    const n = values.length, out = new Uint8ClampedArray(n * 4);
    const lo = win[0], span = win[1] - win[0] || 1;
    for (let i = 0; i < n; i++) {
      const v = values[i], o = i * 4;
      out[o + 3] = 255;
      if (v !== v) continue;                                     // NaN
      let q = Math.round(((v - lo) / span) * 255);
      q = q < 0 ? 0 : q > 255 ? 255 : q;
      out[o] = table[q * 3]; out[o + 1] = table[q * 3 + 1]; out[o + 2] = table[q * 3 + 2];
    }
    return out;
  }

  /** Pixels whose label differs from a 4-neighbour's (a one-pixel outline). */
  function isEdge(labels, w, h, i) {
    const id = labels[i], x = i % w;
    return (x > 0 && labels[i - 1] !== id) || (x < w - 1 && labels[i + 1] !== id) ||
           (i >= w && labels[i - w] !== id) || (i < w * (h - 1) && labels[i + w] !== id) ||
           x === 0 || x === w - 1 || i < w || i >= w * (h - 1);
  }

  /** Within `r` pixels (a square) of another label or the slice's border. */
  function nearEdge(labels, w, h, i, r) {
    if (r <= 1) return isEdge(labels, w, h, i);
    const id = labels[i], x = i % w, y = (i - x) / w;
    if (x < r || y < r || x >= w - r || y >= h - r) return true;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (labels[i + dy * w + dx] !== id) return true;
    return false;
  }

  /**
   * Labels drawn into `base` (RGBA, changed in place), or onto black when
   * base is null (the labels-only panel, always opaque fill).
   *   lk     Med.labels.lookup(): colour and visibility per id
   *   opts   { alpha, mode: "fill" | "outline" | "both", focus: id | null,
   *            width: the outline's thickness in pixels (1) }
   */
  function labels(lab, w, h, lk, opts, base) {
    const n = lab.length;
    const out = base || new Uint8ClampedArray(n * 4);
    const a = base ? opts.alpha : 1;
    const mode = base ? opts.mode : "fill";
    const fill = mode !== "outline", line = mode !== "fill";
    const { rgb, on, max } = lk;
    for (let i = 0; i < n; i++) {
      const o = i * 4;
      if (!base) out[o + 3] = 255;
      const id = lab[i];
      if (id <= 0 || id > max || !on[id]) continue;
      const edge = line && nearEdge(lab, w, h, i, (base && opts.width) || 1);
      if (!fill && !edge) continue;
      const aa = edge ? 1 : a;
      out[o] = (1 - aa) * out[o] + aa * rgb[id * 3];
      out[o + 1] = (1 - aa) * out[o + 1] + aa * rgb[id * 3 + 1];
      out[o + 2] = (1 - aa) * out[o + 2] + aa * rgb[id * 3 + 2];
    }
    if (opts.focus != null) outline(lab, w, h, opts.focus, out);
    return out;
  }

  /** The highlighted segment's outline, in magenta. */
  function outline(lab, w, h, id, out) {
    for (let i = 0; i < lab.length; i++) {
      if (lab[i] !== id || !isEdge(lab, w, h, i)) continue;
      const o = i * 4;
      out[o] = HIGHLIGHT[0]; out[o + 1] = HIGHLIGHT[1]; out[o + 2] = HIGHLIGHT[2]; out[o + 3] = 255;
    }
    return out;
  }

  /** RGBA -> a canvas of the same pixel size. */
  function toCanvas(rgba, w, h, canvas) {
    const c = canvas || document.createElement("canvas");
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    c.getContext("2d").putImageData(new ImageData(rgba, w, h), 0, 0);
    return c;
  }

  Med.render = { HIGHLIGHT, MAPS, lut, image, labels, outline, toCanvas };
})();
