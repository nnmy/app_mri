/* ============================================================================
 * tract_view/lib/select.js — which streamlines are shown, and how
 * ----------------------------------------------------------------------------
 *   pointLabels()  the segment label under every point (nearest voxel of the
 *                  segmentation, through its own header)
 *   crop()         the streamlines within the visible segments:
 *                    "clip"  the runs of consecutive points inside them,
 *                            each kept if ≥ 2 points and ≥ MIN_PIECE_MM
 *                            (a cut at the boundary leaves short stubs);
 *                    "pass"  every streamline with a point inside them,
 *                            whole (it is "connected" to them)
 *   classify()     each streamline's dominant direction: the mean of its
 *                  unit step vectors, normalised; L-R if |x| is the largest
 *                  component and ≥ DIRECTION_THRESHOLD, A-P for y, S-I for
 *                  z, otherwise Mixed (a U-shaped or oblique streamline)
 *   colours()      per point: the local direction (Med.tracts.localColours,
 *                  the usual DEC colours) or the streamline's class
 *   project()      the streamlines drawn flat onto a plane: every segment
 *                  rasterised into a colour sum and a count per pixel, so
 *                  a dense bundle reads denser (alpha from the count)
 * ========================================================================== */
(function () {
  "use strict";
  const TV = (window.TV = window.TV || {});

  const MIN_PIECE_MM = 5;
  const DIRECTION_THRESHOLD = 0.7;
  const CLASSES = [
    { key: "lr", label: "L-R", color: [230, 40, 40] },
    { key: "ap", label: "A-P", color: [40, 200, 60] },
    { key: "si", label: "S-I", color: [50, 110, 255] },
    { key: "mixed", label: "Mixed", color: [245, 170, 20] },
  ];

  const count = (t) => t.offsets.length - 1;

  /** Int32Array: the label under each point (0 outside the segmentation). */
  function pointLabels(t, seg) {
    const p = t.positions, n = p.length / 3, out = new Int32Array(n);
    const I = seg.inv, [nx, ny, nz] = seg.dims;
    for (let i = 0; i < n; i++) {
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
      const a = Math.floor(I[0] * x + I[1] * y + I[2] * z + I[3] + 0.5);
      const b = Math.floor(I[4] * x + I[5] * y + I[6] * z + I[7] + 0.5);
      const c = Math.floor(I[8] * x + I[9] * y + I[10] * z + I[11] + 0.5);
      if (a >= 0 && b >= 0 && c >= 0 && a < nx && b < ny && c < nz) out[i] = Math.round(seg.value(a + nx * (b + ny * c)));
    }
    return out;
  }

  /** Streamlines touching each label: Map(label -> count). */
  function touching(t, labels) {
    const counts = new Map(), stamp = new Map();
    for (let k = 0; k < count(t); k++)
      for (let i = t.offsets[k]; i < t.offsets[k + 1]; i++) {
        const l = labels[i];
        if (l <= 0 || stamp.get(l) === k) continue;
        stamp.set(l, k);
        counts.set(l, (counts.get(l) || 0) + 1);
      }
    return counts;
  }

  /**
   * The streamlines within the labels `on` (Uint8Array by label id).
   * Returns { tracts, source (Int32Array: input streamline of each piece) }.
   */
  function crop(t, labels, on, mode) {
    const p = t.positions, inside = (i) => { const l = labels[i]; return l > 0 && l < on.length && on[l] === 1; };
    const runs = [];                    // [start, end) point ranges
    const source = [];
    for (let k = 0; k < count(t); k++) {
      const a = t.offsets[k], b = t.offsets[k + 1];
      if (mode === "pass") {
        for (let i = a; i < b; i++) if (inside(i)) { runs.push(a, b); source.push(k); break; }
        continue;
      }
      let s = -1;
      for (let i = a; i <= b; i++) {
        const isIn = i < b && inside(i);
        if (isIn && s < 0) s = i;
        else if (!isIn && s >= 0) {
          if (i - s >= 2) {
            let len = 0;
            for (let q = s + 1; q < i; q++) len += Math.hypot(p[q * 3] - p[q * 3 - 3], p[q * 3 + 1] - p[q * 3 - 2], p[q * 3 + 2] - p[q * 3 - 1]);
            if (len >= MIN_PIECE_MM) { runs.push(s, i); source.push(k); }
          }
          s = -1;
        }
      }
    }
    return { tracts: gather(t, runs), source: Int32Array.from(source) };
  }

  /** A tractogram of the point ranges [a, b) given as a flat list. */
  function gather(t, runs) {
    let nP = 0;
    for (let r = 0; r < runs.length; r += 2) nP += runs[r + 1] - runs[r];
    const positions = new Float32Array(nP * 3), offsets = new Uint32Array(runs.length / 2 + 1);
    let P = 0;
    for (let r = 0; r < runs.length; r += 2) {
      positions.set(t.positions.subarray(runs[r] * 3, runs[r + 1] * 3), P * 3);
      P += runs[r + 1] - runs[r];
      offsets[r / 2 + 1] = P;
    }
    return { positions, offsets };
  }

  /** Uint8Array: class per streamline (0 L-R, 1 A-P, 2 S-I, 3 Mixed). */
  function classify(t) {
    const p = t.positions, out = new Uint8Array(count(t));
    for (let k = 0; k < count(t); k++) {
      let mx = 0, my = 0, mz = 0, n = 0;
      for (let i = t.offsets[k] + 1; i < t.offsets[k + 1]; i++) {
        const dx = p[i * 3] - p[i * 3 - 3], dy = p[i * 3 + 1] - p[i * 3 - 2], dz = p[i * 3 + 2] - p[i * 3 - 1];
        const d = Math.hypot(dx, dy, dz) + 1e-6;
        mx += dx / d; my += dy / d; mz += dz / d; n++;
      }
      const norm = Math.hypot(mx, my, mz);
      if (!n || !norm) { out[k] = 3; continue; }
      const x = Math.abs(mx / norm), y = Math.abs(my / norm), z = Math.abs(mz / norm);
      if (y > x && y > z && y >= DIRECTION_THRESHOLD) out[k] = 1;
      else if (z > x && z > y && z >= DIRECTION_THRESHOLD) out[k] = 2;
      else if (x > y && x > z && x >= DIRECTION_THRESHOLD) out[k] = 0;
      else out[k] = 3;
    }
    return out;
  }

  /** The streamlines whose class is in `want` (Set of class indices). */
  function byClass(t, cls, want) {
    const runs = [];
    for (let k = 0; k < count(t); k++) if (want.has(cls[k])) runs.push(t.offsets[k], t.offsets[k + 1]);
    const keepCls = [];
    for (let k = 0; k < count(t); k++) if (want.has(cls[k])) keepCls.push(cls[k]);
    return { tracts: gather(t, runs), cls: Uint8Array.from(keepCls) };
  }

  /** Uint8Array rgb per point. mode "local" | "class". */
  function colours(t, cls, mode) {
    if (mode !== "class") return Med.tracts.localColours(t);
    const out = new Uint8Array(t.positions.length);
    for (let k = 0; k < count(t); k++) {
      const c = CLASSES[cls[k]].color;
      for (let i = t.offsets[k]; i < t.offsets[k + 1]; i++) { out[i * 3] = c[0]; out[i * 3 + 1] = c[1]; out[i * 3 + 2] = c[2]; }
    }
    return out;
  }


  /**
   * The streamlines projected flat onto plane view `view` of `grid`, at f
   * pixels per grid pixel, each line `width` pixels wide:
   * { sum (Float32 rgb per pixel), n (Float32), w, h }.
   */
  function project(t, rgb, grid, view, f, width) {
    const W = view.w * f, H = view.h * f;
    const sum = new Float32Array(W * H * 3), n = new Float32Array(W * H);
    const pc = view.p.col, pr = view.p.row;
    const lo = grid.lo, st = grid.step, p = t.positions;
    // A disc of pixels around each sample: offsets within half the width.
    const r = Math.max(0, ((width || 1) - 1) / 2), disc = [];
    for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++)
      for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) if (dx * dx + dy * dy <= r * r + 0.25) disc.push(dx, dy);
    const X = (i) => ((p[i * 3 + pc] - lo[pc]) / st[pc] + 0.5) * f;
    const Y = (i) => (view.h - ((p[i * 3 + pr] - lo[pr]) / st[pr] + 0.5)) * f;
    for (let k = 0; k < count(t); k++)
      for (let i = t.offsets[k]; i + 1 < t.offsets[k + 1]; i++) {
        const x0 = X(i), y0 = Y(i), x1 = X(i + 1), y1 = Y(i + 1);
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
        const cr = rgb[i * 3], cg = rgb[i * 3 + 1], cb = rgb[i * 3 + 2];
        for (let s = 0; s < steps; s++) {
          const u = (s + 0.5) / steps;
          const cx = Math.floor(x0 + u * (x1 - x0)), cy = Math.floor(y0 + u * (y1 - y0));
          for (let k = 0; k < disc.length; k += 2) {
            const x = cx + disc[k], y = cy + disc[k + 1];
            if (x < 0 || y < 0 || x >= W || y >= H) continue;
            const q = y * W + x;
            n[q]++; sum[q * 3] += cr; sum[q * 3 + 1] += cg; sum[q * 3 + 2] += cb;
          }
        }
      }
    return { sum, n, w: W, h: H };
  }

  /**
   * A surface's silhouette on plane view `view` of `grid`, at f pixels per
   * grid pixel: Uint8Array W×H, 1 where some triangle covers the pixel.
   */
  function silhouette(positions, indices, grid, view, f) {
    const W = view.w * f, H = view.h * f, out = new Uint8Array(W * H);
    const pc = view.p.col, pr = view.p.row, lo = grid.lo, st = grid.step, p = positions;
    const X = (i) => ((p[i * 3 + pc] - lo[pc]) / st[pc] + 0.5) * f;
    const Y = (i) => (view.h - ((p[i * 3 + pr] - lo[pr]) / st[pr] + 0.5)) * f;
    for (let t = 0; t < indices.length; t += 3) {
      const ax = X(indices[t]), ay = Y(indices[t]), bx = X(indices[t + 1]), by = Y(indices[t + 1]);
      const cx = X(indices[t + 2]), cy = Y(indices[t + 2]);
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (Math.abs(area) < 1e-9) continue;
      const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx, cx)));
      const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by, cy)));
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5, py = y + 0.5;
          const w0 = (bx - px) * (cy - py) - (by - py) * (cx - px);
          const w1 = (cx - px) * (ay - py) - (cy - py) * (ax - px);
          const w2 = (ax - px) * (by - py) - (ay - py) * (bx - px);
          if ((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0)) out[y * W + x] = 1;
        }
    }
    return out;
  }

  /** Projection composited over `base` (RGBA, W×H): mean colour, alpha
   *  rising with the count, times the opacity. In place. */
  function composite(base, proj, opacity) {
    const { sum, n } = proj;
    for (let q = 0; q < n.length; q++) {
      if (!n[q]) continue;
      const a = opacity * (1 - Math.exp(-n[q] / 1.5)), o = q * 4;
      base[o] = (1 - a) * base[o] + (a * sum[q * 3]) / n[q];
      base[o + 1] = (1 - a) * base[o + 1] + (a * sum[q * 3 + 1]) / n[q];
      base[o + 2] = (1 - a) * base[o + 2] + (a * sum[q * 3 + 2]) / n[q];
    }
    return base;
  }

  /** { n, points, total, mean, median, min, max } of the lengths (mm). */
  function lengthStats(t) {
    const L = TV.simplify.lengths(t);
    const n = L.length;
    if (!n) return { n: 0, points: 0, total: 0, mean: 0, median: 0, min: 0, max: 0 };
    const s = Float64Array.from(L).sort();
    let total = 0;
    for (const v of L) total += v;
    return { n, points: t.positions.length / 3, total, mean: total / n, median: s[n >> 1], min: s[0], max: s[n - 1] };
  }

  TV.select = { MIN_PIECE_MM, DIRECTION_THRESHOLD, CLASSES, count, pointLabels, touching, crop, gather, classify, byClass,
                colours, segments: Med.tracts.segments, project, silhouette, composite, lengthStats };
})();
