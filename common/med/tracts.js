/* ============================================================================
 * common/med/tracts.js — streamlines for the 3D view (window.Med.tracts)
 * ----------------------------------------------------------------------------
 * A tractogram is { positions: Float32Array (xyz per point, RAS mm),
 * offsets: Uint32Array } -- streamline k is points offsets[k] ..
 * offsets[k+1]-1 -- as Med.vtk.parseLines returns it.
 *
 *   count(t)         the number of streamlines
 *   localColours(t)  RGB per point from the local direction (|dx|, |dy|,
 *                    |dz| of the step: the usual DEC colours)
 *   segments(t)      index pairs, one per step within each streamline (what
 *                    Med.gl3d's setLines takes)
 *   resample(t, mm)  a lighter copy FOR DRAWING: each streamline resampled
 *                    evenly along its length, no step longer than `mm`,
 *                    the end points kept; one already that coarse is copied
 *                    as it is. Tracking writes a point every 0.875 mm; at
 *                    DRAW_STEP_MM (2 mm) IXI051's 7.2 M points become
 *                    3.3 M, the original points within 0.2 mm (median of
 *                    each streamline's largest distance; 0.3 mm at the 95th
 *                    percentile) of the copy. Never for saving or measuring.
 * ========================================================================== */
(function () {
  "use strict";
  const Med = (window.Med = window.Med || {});

  const DRAW_STEP_MM = 2;
  const count = (t) => t.offsets.length - 1;

  function localColours(t) {
    const p = t.positions, out = new Uint8Array(p.length);
    for (let k = 0; k < count(t); k++) {
      const a = t.offsets[k], b = t.offsets[k + 1];
      for (let i = a; i < b; i++) {
        const j = i + 1 < b ? i + 1 : i, h = j === i ? i - 1 : i;
        const dx = p[j * 3] - p[h * 3], dy = p[j * 3 + 1] - p[h * 3 + 1], dz = p[j * 3 + 2] - p[h * 3 + 2];
        const d = Math.hypot(dx, dy, dz) || 1;
        // Lifted a little off black so a step along one axis still shows.
        out[i * 3] = 40 + 215 * Math.abs(dx / d); out[i * 3 + 1] = 40 + 215 * Math.abs(dy / d); out[i * 3 + 2] = 40 + 215 * Math.abs(dz / d);
      }
    }
    return out;
  }

  function segments(t) {
    const n = t.positions.length / 3 - count(t), out = new Uint32Array(Math.max(0, n) * 2);
    let o = 0;
    for (let k = 0; k < count(t); k++)
      for (let i = t.offsets[k]; i + 1 < t.offsets[k + 1]; i++) { out[o++] = i; out[o++] = i + 1; }
    return out;
  }

  function resample(t, stepMm) {
    const p = t.positions, n = count(t), m = new Uint32Array(n);
    let total = 0, longest = 0;
    for (let k = 0; k < n; k++) {
      const a = t.offsets[k], b = t.offsets[k + 1];
      let L = 0;
      for (let i = a + 1; i < b; i++) L += Math.hypot(p[i * 3] - p[i * 3 - 3], p[i * 3 + 1] - p[i * 3 - 2], p[i * 3 + 2] - p[i * 3 - 1]);
      m[k] = b - a < 3 ? b - a : Math.max(2, Math.min(b - a, Math.ceil(L / stepMm) + 1));
      total += m[k];
      longest = Math.max(longest, b - a);
    }
    const out = new Float32Array(total * 3), offsets = new Uint32Array(n + 1), cum = new Float64Array(longest);
    let o = 0;
    for (let k = 0; k < n; k++) {
      const a = t.offsets[k], b = t.offsets[k + 1], np = b - a, mk = m[k];
      offsets[k] = o;
      if (mk === np) { out.set(p.subarray(a * 3, b * 3), o * 3); o += np; continue; }
      cum[0] = 0;
      for (let i = 1; i < np; i++) {
        const q = (a + i) * 3;
        cum[i] = cum[i - 1] + Math.hypot(p[q] - p[q - 3], p[q + 1] - p[q - 2], p[q + 2] - p[q - 1]);
      }
      const L = cum[np - 1];
      let j = 0;
      for (let s = 0; s < mk; s++, o++) {
        const at = (L * s) / (mk - 1);
        while (j < np - 2 && cum[j + 1] < at) j++;
        const seg = cum[j + 1] - cum[j], f = seg > 0 ? Math.min(1, Math.max(0, (at - cum[j]) / seg)) : 0;
        const q0 = (a + j) * 3, q1 = q0 + 3;
        out[o * 3] = p[q0] + f * (p[q1] - p[q0]);
        out[o * 3 + 1] = p[q0 + 1] + f * (p[q1 + 1] - p[q0 + 1]);
        out[o * 3 + 2] = p[q0 + 2] + f * (p[q1 + 2] - p[q0 + 2]);
      }
    }
    offsets[n] = o;
    return { positions: out, offsets };
  }

  Med.tracts = { DRAW_STEP_MM, count, localColours, segments, resample };
})();
