/* ============================================================================
 * common/med/volume.js — a volume in world space, and its slices
 * ----------------------------------------------------------------------------
 * Every reader (NIfTI, NRRD, DICOM) returns a Med.Volume: the voxels as read
 * (native typed array, x fastest), a rescale slope/intercept, and the affine
 * from voxel index to RAS millimetres. Nothing is resampled up front: a 512²
 * CT of 600 slices would not fit in memory twice.
 *
 * The display grid (makeGrid) is RAS-aligned over the reference volume's
 * field of view (the image, else the segmentation). Its step on each RAS axis
 * is the native spacing of the voxel axis closest to it, so an axis-aligned
 * volume is shown voxel for voxel and a thick-slice series is not repeated
 * ten times while scrolling. A slice is sampled on demand, nearest
 * neighbour, through each volume's inverse affine. That is also why an image
 * and a segmentation line up: they meet in world space, not by voxel index.
 *
 * Slices are drawn as seen: axial anterior up, coronal and sagittal superior
 * up; the subject's left on the screen's left (neurological) unless
 * `radiological` flips axial and coronal; sagittal anterior on the right.
 * ========================================================================== */
(function () {
  "use strict";
  const Med = (window.Med = window.Med || {});

  // --- 4×4 matrices, row-major [16] -----------------------------------------
  const M = {
    identity: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    mul(a, b) {
      const o = new Array(16).fill(0);
      for (let r = 0; r < 4; r++)
        for (let c = 0; c < 4; c++)
          for (let k = 0; k < 4; k++) o[r * 4 + c] += a[r * 4 + k] * b[k * 4 + c];
      return o;
    },
    apply: (a, x, y, z) => [
      a[0] * x + a[1] * y + a[2] * z + a[3],
      a[4] * x + a[5] * y + a[6] * z + a[7],
      a[8] * x + a[9] * y + a[10] * z + a[11],
    ],
    /** The 3×3 part only (directions, not points). */
    dir: (a, x, y, z) => [
      a[0] * x + a[1] * y + a[2] * z,
      a[4] * x + a[5] * y + a[6] * z,
      a[8] * x + a[9] * y + a[10] * z,
    ],
    det3: (a) =>
      a[0] * (a[5] * a[10] - a[6] * a[9]) - a[1] * (a[4] * a[10] - a[6] * a[8]) +
      a[2] * (a[4] * a[9] - a[5] * a[8]),
    inv(m) {
      const inv = new Array(16);
      inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
      inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
      inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
      inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
      inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
      inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
      inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
      inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
      inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
      inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
      inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
      inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
      inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
      inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
      inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
      inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
      const det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
      if (!det) throw new Error("The affine is singular (a zero voxel size?).");
      return inv.map((v) => v / det);
    },
  };

  // --- Volume -----------------------------------------------------------------
  class Volume {
    /**
     * o: { name, format, dims:[nx,ny,nz], frames, data, slope, inter, affine,
     *      dtype, meta:{label: text}, notes:[], labelInfo: Map(id -> {name, color}) }
     */
    constructor(o) {
      this.name = o.name || "volume";
      this.format = o.format || "";
      this.dims = o.dims.map((n) => Math.max(1, n | 0));
      this.nvox = this.dims[0] * this.dims[1] * this.dims[2];
      this.frames = o.frames || 1;
      this.frame = 0;
      this.data = o.data;
      if (this.data.length < this.nvox * this.frames)
        throw new Error(`${this.name}: ${this.data.length} values for ${this.dims.join("×")}` +
                        (this.frames > 1 ? `×${this.frames}` : "") + " voxels — the file is truncated.");
      this.slope = Number.isFinite(o.slope) && o.slope !== 0 ? o.slope : 1;
      this.inter = Number.isFinite(o.inter) ? o.inter : 0;
      this.affine = o.affine;
      this.inv = M.inv(o.affine);
      this.dtype = o.dtype || "";
      this.meta = o.meta || {};
      this.notes = o.notes || [];
      this.labelInfo = o.labelInfo || null;
    }
    get spacing() {
      const a = this.affine;
      return [0, 1, 2].map((c) => Math.hypot(a[c], a[4 + c], a[8 + c]));
    }
    get voxelMl() { return Math.abs(M.det3(this.affine)) / 1000; }
    value(idx) { return this.data[idx + this.frame * this.nvox] * this.slope + this.inter; }

    /** "RAS", "LPS", …: the world direction each voxel axis points to. */
    orientation() {
      const a = this.affine, pos = "RAS", neg = "LPI";
      let s = "";
      for (let c = 0; c < 3; c++) {
        const v = [a[c], a[4 + c], a[8 + c]].map(Math.abs);
        const r = v.indexOf(Math.max(...v));
        s += a[r * 4 + c] >= 0 ? pos[r] : neg[r];
      }
      return s;
    }
    /** The largest angle (°) between a voxel axis and its nearest world axis:
     *  0 for an axis-aligned volume. */
    obliqueDegrees() {
      const a = this.affine, sp = this.spacing;
      let worst = 0;
      for (let c = 0; c < 3; c++) {
        const v = [a[c], a[4 + c], a[8 + c]].map((x) => Math.abs(x) / sp[c]);
        worst = Math.max(worst, Math.acos(Math.min(1, Math.max(...v))) * 180 / Math.PI);
      }
      return worst;
    }
    /** RAS bounding box of the voxels' outer edges: [[lo], [hi]]. */
    bounds() {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const i of [-0.5, this.dims[0] - 0.5])
        for (const j of [-0.5, this.dims[1] - 0.5])
          for (const k of [-0.5, this.dims[2] - 0.5]) {
            const w = M.apply(this.affine, i, j, k);
            for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d], w[d]); hi[d] = Math.max(hi[d], w[d]); }
          }
      return [lo, hi];
    }
    /** The spacing along RAS axis d: that of the voxel axis closest to it. */
    worldStep(d) {
      const a = this.affine, sp = this.spacing;
      let best = 0, step = sp[0];
      for (let c = 0; c < 3; c++) {
        const cos = Math.abs(a[d * 4 + c]) / sp[c];
        if (cos > best) { best = cos; step = sp[c]; }
      }
      return step;
    }
  }

  // --- Value statistics ---------------------------------------------------------
  /** Up to `max` values of the current frame, evenly strided; finite only. */
  function sample(vol, max) {
    const n = vol.nvox, stride = Math.max(1, Math.floor(n / (max || 2e6)));
    const out = new Float32Array(Math.ceil(n / stride));
    const off = vol.frame * vol.nvox, d = vol.data, s = vol.slope, b = vol.inter;
    let m = 0;
    for (let i = 0; i < n; i += stride) {
      const v = d[off + i] * s + b;
      if (Number.isFinite(v)) out[m++] = v;
    }
    return out.subarray(0, m);
  }

  /** {min, max, p1, p99} of the frame; percentiles of the non-zero values (a
   *  scanner's background is zero and would pull the window down). */
  function stats(vol) {
    const v = sample(vol, 2e6);
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < v.length; i++) { if (v[i] < min) min = v[i]; if (v[i] > max) max = v[i]; }
    let nz = v.filter((x) => x !== 0);
    if (!nz.length) nz = v;
    nz.sort();
    const q = (p) => nz.length ? nz[Math.min(nz.length - 1, Math.floor(p * (nz.length - 1)))] : 0;
    if (!Number.isFinite(min)) { min = 0; max = 1; }
    return { min, max, p1: q(0.01), p99: q(0.99), p05: q(0.005), p995: q(0.995) };
  }

  // --- Display grid -------------------------------------------------------------
  // Per-axis cap on the grid, so a huge field of view cannot allocate a
  // canvas the browser refuses.
  const MAX_GRID = 1024;

  /** grid: { lo:[3] (centre of voxel 0), step:[3], dims:[3] } over `ref`'s
   *  field of view; `finer` (optional) may only make the steps smaller. */
  function makeGrid(ref, finer) {
    const [lo, hi] = ref.bounds();
    const step = [0, 1, 2].map((d) => {
      let s = ref.worldStep(d);
      if (finer) s = Math.min(s, finer.worldStep(d));
      return Math.max(s, (hi[d] - lo[d]) / MAX_GRID);
    });
    const dims = [0, 1, 2].map((d) => Math.max(1, Math.round((hi[d] - lo[d]) / step[d])));
    // Centre the grid on the field of view (rounding may shave a fraction).
    const start = [0, 1, 2].map((d) => (lo[d] + hi[d]) / 2 - (dims[d] - 1) * step[d] / 2);
    return { lo: start, step, dims };
  }

  const PLANES = {
    axial: { key: "axial", title: "Axial", axis: 2, col: 0, row: 1, top: "A", bottom: "P" },
    coronal: { key: "coronal", title: "Coronal", axis: 1, col: 0, row: 2, top: "S", bottom: "I" },
    sagittal: { key: "sagittal", title: "Sagittal", axis: 0, col: 1, row: 2, top: "S", bottom: "I" },
  };

  /** How `plane` is laid out on screen: size, whether columns run right to
   *  left (radiological), the physical pixel aspect and the edge letters. */
  function planeView(grid, plane, radiological) {
    const p = PLANES[plane];
    const flip = radiological && plane !== "sagittal";
    const w = grid.dims[p.col], h = grid.dims[p.row];
    const left = plane === "sagittal" ? "P" : flip ? "R" : "L";
    const right = plane === "sagittal" ? "A" : flip ? "L" : "R";
    return { p, w, h, flip, depth: grid.dims[p.axis], sx: grid.step[p.col], sy: grid.step[p.row],
             letters: { top: p.top, bottom: p.bottom, left, right } };
  }

  /** Grid index (gx, gy, gz) of pixel (row, col) of slice k. */
  function gridIndex(view, k, row, col) {
    const g = [0, 0, 0];
    g[view.p.axis] = k;
    g[view.p.col] = view.flip ? view.w - 1 - col : col;
    g[view.p.row] = view.h - 1 - row;
    return g;
  }
  const gridWorld = (grid, g) => [0, 1, 2].map((d) => grid.lo[d] + grid.step[d] * g[d]);

  /**
   * Slice k of `plane` of `vol`, sampled on `grid`, nearest neighbour.
   * Returns a Float32Array (h × w, row-major) of values, NaN outside the
   * volume -- or, with asLabels, an Int32Array of label ids, 0 outside.
   */
  function sampleSlice(vol, grid, view, k, asLabels) {
    const { w, h } = view;
    const out = asLabels ? new Int32Array(w * h) : new Float32Array(w * h);
    if (!asLabels) out.fill(NaN);
    const w0 = gridWorld(grid, gridIndex(view, k, 0, 0));
    const ec = [0, 0, 0], er = [0, 0, 0];
    ec[view.p.col] = grid.step[view.p.col] * (view.flip ? -1 : 1);
    er[view.p.row] = -grid.step[view.p.row];
    const v0 = M.apply(vol.inv, w0[0], w0[1], w0[2]);
    const dc = M.dir(vol.inv, ec[0], ec[1], ec[2]);
    const dr = M.dir(vol.inv, er[0], er[1], er[2]);
    const [nx, ny, nz] = vol.dims, nxy = nx * ny;
    const d = vol.data, off = vol.frame * vol.nvox, s = vol.slope, b = vol.inter;
    for (let r = 0; r < h; r++) {
      let x = v0[0] + r * dr[0], y = v0[1] + r * dr[1], z = v0[2] + r * dr[2];
      const base = r * w;
      for (let c = 0; c < w; c++, x += dc[0], y += dc[1], z += dc[2]) {
        const i = Math.floor(x + 0.5), j = Math.floor(y + 0.5), kk = Math.floor(z + 0.5);
        if (i < 0 || j < 0 || kk < 0 || i >= nx || j >= ny || kk >= nz) continue;
        const v = d[off + i + nx * j + nxy * kk] * s + b;
        out[base + c] = asLabels ? Math.round(v) : v;
      }
    }
    return out;
  }

  /** The voxel of `vol` under pixel (row, col) of slice k: [i, j, k] or null. */
  function voxelAt(vol, grid, view, k, row, col) {
    const w = gridWorld(grid, gridIndex(view, k, row, col));
    const v = M.apply(vol.inv, w[0], w[1], w[2]).map((x) => Math.floor(x + 0.5));
    for (let d = 0; d < 3; d++) if (v[d] < 0 || v[d] >= vol.dims[d]) return null;
    return v;
  }

  /**
   * For each RAS axis, how many voxels of `vol` fall in each grid slice,
   * per label (segmentation) -- the "which slices hold this segment" strip
   * and the jump to the slice with most of it. Native voxels, so a count
   * times voxelMl is the segment's volume.
   * Returns { ids:[...], count: Map(id -> n), perSlice: Map(id -> [Int32Array ×3]) }.
   */
  function labelStats(vol, grid) {
    const [nx, ny, nz] = vol.dims, a = vol.affine;
    const off = vol.frame * vol.nvox, d = vol.data, s = vol.slope, b = vol.inter;
    const gd = grid.dims;
    // Grid index along axis d of voxel (i, j, k), linear in i, j, k.
    const g0 = [0, 1, 2].map((r) => (a[r * 4 + 3] - grid.lo[r]) / grid.step[r] + 0.5);
    const gi = [0, 1, 2].map((r) => a[r * 4] / grid.step[r]);
    const gj = [0, 1, 2].map((r) => a[r * 4 + 1] / grid.step[r]);
    const gk = [0, 1, 2].map((r) => a[r * 4 + 2] / grid.step[r]);
    const entries = new Map();
    const entry = (id) => {
      let e = entries.get(id);
      if (!e) {
        e = { n: 0, slices: [new Int32Array(gd[0]), new Int32Array(gd[1]), new Int32Array(gd[2])] };
        entries.set(id, e);
      }
      return e;
    };
    let idx = 0;
    for (let k = 0; k < nz; k++)
      for (let j = 0; j < ny; j++) {
        const bx = g0[0] + j * gj[0] + k * gk[0], by = g0[1] + j * gj[1] + k * gk[1],
              bz = g0[2] + j * gj[2] + k * gk[2];
        for (let i = 0; i < nx; i++, idx++) {
          const raw = d[off + idx];
          if (raw === 0 && b === 0) continue;
          const id = Math.round(raw * s + b);
          if (id <= 0) continue;                       // background (and nonsense negatives)
          const e = entry(id);
          e.n++;
          const x = Math.floor(bx + i * gi[0]), y = Math.floor(by + i * gi[1]), z = Math.floor(bz + i * gi[2]);
          if (x >= 0 && x < gd[0]) e.slices[0][x]++;
          if (y >= 0 && y < gd[1]) e.slices[1][y]++;
          if (z >= 0 && z < gd[2]) e.slices[2][z]++;
        }
      }
    const ids = Array.from(entries.keys()).sort((p, q) => p - q);
    const count = new Map(ids.map((id) => [id, entries.get(id).n]));
    const perSlice = new Map(ids.map((id) => [id, entries.get(id).slices]));
    return { ids, count, perSlice };
  }

  /**
   * Per grid slice along `axis`, the fraction of `vol`'s voxels there that
   * carry signal (above lo + 5 % of the 1–99 % window): the slices worth
   * putting in a mosaic. Strided, so a big volume costs well under a second.
   */
  const SIGNAL_LEVEL = 0.05;
  function signalProfile(vol, grid, axis, window) {
    const [nx, ny, nz] = vol.dims, a = vol.affine, n = grid.dims[axis];
    const stride = Math.max(1, Math.round(Math.cbrt(vol.nvox / 4e6)));
    const level = window[0] + SIGNAL_LEVEL * Math.max(window[1] - window[0], 0);
    const hit = new Float64Array(n), all = new Float64Array(n);
    const off = vol.frame * vol.nvox, d = vol.data, s = vol.slope, b = vol.inter;
    const g0 = (a[axis * 4 + 3] - grid.lo[axis]) / grid.step[axis] + 0.5;
    const gi = a[axis * 4] / grid.step[axis], gj = a[axis * 4 + 1] / grid.step[axis],
          gk = a[axis * 4 + 2] / grid.step[axis];
    for (let k = 0; k < nz; k += stride)
      for (let j = 0; j < ny; j += stride)
        for (let i = 0; i < nx; i += stride) {
          const g = Math.floor(g0 + i * gi + j * gj + k * gk);
          if (g < 0 || g >= n) continue;
          all[g]++;
          if (d[off + i + nx * (j + ny * k)] * s + b > level) hit[g]++;
        }
    return Array.from(hit, (h, g) => (all[g] ? h / all[g] : 0));
  }

  Object.assign(Med, { M, Volume, sample, stats, makeGrid, PLANES, planeView, gridIndex, gridWorld,
                      sampleSlice, voxelAt, labelStats, signalProfile });
})();
