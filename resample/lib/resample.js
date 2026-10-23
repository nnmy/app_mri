/* ============================================================================
 * resample/lib/resample.js — a volume to an isotropic voxel size
 * ----------------------------------------------------------------------------
 *   canonical(vol)     reorient to RAS: voxel axes permuted and flipped so
 *                      they run R, A, S (the closest canonical orientation,
 *                      as nibabel's as_closest_canonical); no interpolation.
 *   isLabels(vol)      integer type, slope 1, intercept 0, at most MAX_LABELS
 *                      distinct values: a label map, resampled nearest.
 *   resample(vol, mm, method)
 *                      the same field of view -- same outer corner, same axis
 *                      directions -- with cubic voxels of `mm`: n' = round(n ·
 *                      old / mm) voxels per axis, so the output overlays the
 *                      input. Images: Gaussian smoothing first on the axes
 *                      whose voxels grow (sigma = sqrt(new² − old²) / 2.3548
 *                      mm, the FWHM that makes up the difference), so
 *                      shrinking does not alias; then linear or cubic
 *                      B-spline; written as float32. Labels: nearest, type
 *                      kept.
 *
 * The axis directions do not change, so every output voxel's position along
 * one axis depends on that axis only: the volume is resampled one axis at a
 * time (three 1-D passes). Sample t (input voxel index) of output voxel i is
 * (i + ½) · new / old − ½; samples beyond the last voxel take the edge value.
 * The B-spline is the interpolating cubic: coefficients prefiltered (Unser's
 * recursive filter, mirror boundaries), then evaluated with the cubic kernel.
 * ========================================================================== */
(function () {
  "use strict";
  const RS = (window.RS = window.RS || {});

  const MAX_LABELS = 256;
  const MIN_MM = 0.1, MAX_MM = 10;
  const INT_TYPES = ["uint8", "int8", "uint16", "int16", "uint32", "int32", "int64", "uint64"];

  // --- What the volume is --------------------------------------------------------
  function isLabels(vol) {
    if (!INT_TYPES.includes(vol.dtype) || vol.slope !== 1 || vol.inter !== 0) return false;
    const seen = new Set();
    const d = vol.data;
    for (let i = 0; i < vol.nvox; i++) {
      seen.add(d[i]);
      if (seen.size > MAX_LABELS) return false;
    }
    return true;
  }

  // --- Reorient to RAS ------------------------------------------------------------
  function canonical(vol) {
    const a = vol.affine, n = vol.dims;
    // For each world axis r (R, A, S): the voxel axis c pointing most along
    // it, and whether it points the negative way.
    const used = new Set(), src = [0, 0, 0], flip = [false, false, false];
    const order = [0, 1, 2].map((c) => {
      const v = [0, 1, 2].map((r) => Math.abs(a[r * 4 + c]));
      return { c, r: v.indexOf(Math.max(...v)), w: Math.max(...v) / Math.hypot(...v) };
    }).sort((p, q) => q.w - p.w);
    for (const { c, r } of order) {
      let rr = r;
      if (used.has(rr)) rr = [0, 1, 2].find((x) => !used.has(x));   // a tie: take a free axis
      used.add(rr);
      src[rr] = c;
      flip[rr] = a[rr * 4 + c] < 0;
    }
    if (src.every((c, r) => c === r) && !flip.some(Boolean)) return { vol, changed: false };
    const dims = src.map((c) => n[c]);
    const affine = Med.M.identity();
    for (let r = 0; r < 3; r++) {
      const c = src[r], s = flip[r] ? -1 : 1;
      for (let w = 0; w < 3; w++) affine[w * 4 + r] = a[w * 4 + c] * s;
    }
    for (let w = 0; w < 3; w++) {
      let t = a[w * 4 + 3];
      for (let r = 0; r < 3; r++) if (flip[r]) t += a[w * 4 + src[r]] * (n[src[r]] - 1);
      affine[w * 4 + 3] = t;
    }
    // Output voxel (i0, i1, i2) <- source voxel with axis src[r] at i_r
    // (or its mirror when flipped).
    const strideSrc = [1, n[0], n[0] * n[1]];
    const out = new vol.data.constructor(vol.nvox);
    const st = src.map((c, r) => (flip[r] ? -strideSrc[c] : strideSrc[c]));
    const base = src.reduce((b, c, r) => b + (flip[r] ? (n[c] - 1) * strideSrc[c] : 0), 0);
    let o = 0;
    for (let k = 0; k < dims[2]; k++)
      for (let j = 0; j < dims[1]; j++) {
        let s = base + k * st[2] + j * st[1];
        for (let i = 0; i < dims[0]; i++, s += st[0]) out[o++] = vol.data[s];
      }
    const from = vol.orientation();
    return {
      vol: new Med.Volume({ ...vol, dims, data: out, affine, frames: 1, notes: [], meta: vol.meta }),
      changed: true, from,
    };
  }

  // --- 1-D passes ---------------------------------------------------------------
  /** Apply fn(line in, line out) to every line of `src` along `axis`. */
  function alongAxis(src, dims, axis, nOut, fn) {
    const outDims = dims.slice();
    outDims[axis] = nOut;
    const out = new Float32Array(outDims[0] * outDims[1] * outDims[2]);
    const n = dims[axis];
    const sIn = [1, dims[0], dims[0] * dims[1]][axis];
    const sOut = [1, outDims[0], outDims[0] * outDims[1]][axis];
    const a = [0, 1, 2].filter((x) => x !== axis);
    const lineIn = new Float64Array(n), lineOut = new Float64Array(nOut);
    for (let q = 0; q < dims[a[1]]; q++)
      for (let p = 0; p < dims[a[0]]; p++) {
        const idx = [0, 0, 0];
        idx[a[0]] = p; idx[a[1]] = q;
        const bi = idx[0] + dims[0] * (idx[1] + dims[1] * idx[2]);
        const bo = idx[0] + outDims[0] * (idx[1] + outDims[1] * idx[2]);
        for (let i = 0; i < n; i++) lineIn[i] = src[bi + i * sIn];
        fn(lineIn, lineOut);
        for (let i = 0; i < nOut; i++) out[bo + i * sOut] = lineOut[i];
      }
    return { data: out, dims: outDims };
  }

  function gaussianKernel(sigmaVox) {
    const r = Math.min(16, Math.max(1, Math.ceil(3 * sigmaVox)));
    const k = new Float64Array(2 * r + 1);
    let s = 0;
    for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-0.5 * (i / sigmaVox) ** 2); s += k[i + r]; }
    return k.map((v) => v / s);
  }

  function smoothLine(kernel) {
    const r = (kernel.length - 1) / 2;
    return (inp, out) => {
      const n = inp.length;
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let t = -r; t <= r; t++) {
          let j = i + t;
          j = j < 0 ? 0 : j >= n ? n - 1 : j;          // edge value beyond the ends
          s += kernel[t + r] * inp[j];
        }
        out[i] = s;
      }
    };
  }

  /** Sample positions (input voxel index) of the output voxels. */
  const positions = (nOut, ratio) => Float64Array.from({ length: nOut }, (_, i) => (i + 0.5) * ratio - 0.5);

  function nearestLine(pos) {
    return (inp, out) => {
      const n = inp.length;
      for (let i = 0; i < pos.length; i++) {
        let j = Math.floor(pos[i] + 0.5);
        j = j < 0 ? 0 : j >= n ? n - 1 : j;
        out[i] = inp[j];
      }
    };
  }

  function linearLine(pos) {
    return (inp, out) => {
      const n = inp.length;
      for (let i = 0; i < pos.length; i++) {
        const t = Math.min(Math.max(pos[i], 0), n - 1);
        const j = Math.min(Math.floor(t), n - 2 < 0 ? 0 : n - 2), f = t - j;
        out[i] = n > 1 ? inp[j] * (1 - f) + inp[j + 1] * f : inp[0];
      }
    };
  }

  // Cubic B-spline: pole of the interpolating prefilter.
  const POLE = Math.sqrt(3) - 2;
  function prefilter(c) {
    const n = c.length;
    if (n < 2) return;
    const z = POLE, lambda = (1 - z) * (1 - 1 / z);
    for (let k = 0; k < n; k++) c[k] *= lambda;
    // Causal start, mirror boundary (truncated sum: |z|^k below 1e-10).
    const horizon = Math.min(n, Math.ceil(Math.log(1e-10) / Math.log(Math.abs(z))));
    let sum = c[0], zk = z;
    for (let k = 1; k < horizon; k++) { sum += zk * c[k]; zk *= z; }
    c[0] = sum;
    for (let k = 1; k < n; k++) c[k] += z * c[k - 1];
    c[n - 1] = (z / (z * z - 1)) * (c[n - 1] + z * c[n - 2]);
    for (let k = n - 2; k >= 0; k--) c[k] = z * (c[k + 1] - c[k]);
  }

  function bsplineLine(pos) {
    return (inp, out) => {
      const n = inp.length;
      const c = Float64Array.from(inp);
      prefilter(c);
      const at = (j) => {                                 // mirror boundary
        if (n === 1) return c[0];
        const p = 2 * n - 2;
        j = ((j % p) + p) % p;
        return c[j < n ? j : p - j];
      };
      for (let i = 0; i < pos.length; i++) {
        const x = Math.min(Math.max(pos[i], 0), n - 1);
        const j = Math.floor(x), t = x - j, t2 = t * t, t3 = t2 * t;
        const w0 = (1 - t) ** 3 / 6, w1 = (4 - 6 * t2 + 3 * t3) / 6;
        const w2 = (1 + 3 * t + 3 * t2 - 3 * t3) / 6, w3 = t3 / 6;
        out[i] = w0 * at(j - 1) + w1 * at(j) + w2 * at(j + 1) + w3 * at(j + 2);
      }
    };
  }

  // --- The resampling -------------------------------------------------------------
  /**
   * vol: a 3-D Med.Volume. method: "Nearest" | "Linear" | "B-spline".
   * Returns { vol, notes }.
   */
  async function resample(vol, mm, method, labels, progress) {
    if (!(mm >= MIN_MM && mm <= MAX_MM)) throw new Error(`The voxel size must be ${MIN_MM}–${MAX_MM} mm.`);
    const notes = [];
    const old = vol.spacing, a = vol.affine;
    const nOut = vol.dims.map((n, c) => Math.max(1, Math.round((n * old[c]) / mm)));
    // Values (scaled) as float.
    let data = new Float32Array(vol.nvox);
    for (let i = 0; i < vol.nvox; i++) data[i] = vol.value(i);
    let dims = vol.dims.slice();
    if (!labels && method !== "Nearest") {
      const sigmaMm = old.map((o) => (mm > o ? Math.sqrt(mm * mm - o * o) / 2.3548 : 0));
      if (sigmaMm.some((s) => s > 0)) {
        notes.push("Anti-alias smoothing before shrinking: sigma " + sigmaMm.map((s) => s.toFixed(2)).join(" × ") + " mm");
        for (let c = 0; c < 3; c++) {
          if (!sigmaMm[c]) continue;
          progress && progress(`Smoothing axis ${c + 1} / 3…`);
          await Med.tick();
          data = alongAxis(data, dims, c, dims[c], smoothLine(gaussianKernel(sigmaMm[c] / old[c]))).data;
        }
      }
    }
    const line = { Nearest: nearestLine, Linear: linearLine, "B-spline": bsplineLine }[labels ? "Nearest" : method];
    for (let c = 0; c < 3; c++) {
      progress && progress(`Resampling axis ${c + 1} / 3…`);
      await Med.tick();
      const r = alongAxis(data, dims, c, nOut[c], line(positions(nOut[c], mm / old[c])));
      data = r.data;
      dims = r.dims;
    }
    // Same directions and outer corner; voxel size mm.
    const affine = a.slice();
    for (let c = 0; c < 3; c++) {
      const dir = [a[c] / old[c], a[4 + c] / old[c], a[8 + c] / old[c]];
      for (let w = 0; w < 3; w++) {
        affine[w * 4 + c] = dir[w] * mm;
        affine[w * 4 + 3] += (dir[w] * (mm - old[c])) / 2;
      }
    }
    let out = data;
    let dtype = "float32";
    if (labels) {
      out = new vol.data.constructor(data.length);
      for (let i = 0; i < data.length; i++) out[i] = data[i];
      dtype = vol.dtype;
    }
    return {
      vol: new Med.Volume({ name: vol.name, format: "NIfTI", dims, data: out, affine, dtype,
                            meta: { Format: "NIfTI-1", "Data type": dtype } }),
      notes,
    };
  }

  RS.resample = { MAX_LABELS, MIN_MM, MAX_MM, isLabels, canonical, resample, prefilter };
})();
