/* ============================================================================
 * common/med/io_nifti.js — NIfTI-1 and NIfTI-2 (.nii, .nii.gz)
 * ----------------------------------------------------------------------------
 * The affine as nibabel's get_best_affine picks it: the sform when its code
 * is set, else the qform, else the voxel sizes alone. NIfTI's world is RAS+,
 * so the affine is used as stored. A 4-D file keeps all its frames (the
 * viewer shows one at a time); RGB data types are refused.
 *
 * write() is the other way: a volume -> NIfTI-1 bytes (gzip them with
 * Med.io.gzip for .nii.gz), with the affine as the sform and its closest
 * rotation as the qform (both code 1, scanner space), so every reader --
 * nibabel, ITK, FSL, dcm2niix's users -- places it the same way.
 * ========================================================================== */
(function () {
  "use strict";
  const Med = (window.Med = window.Med || {});

  const DTYPES = {
    2: "uint8", 4: "int16", 8: "int32", 16: "float32", 64: "float64", 256: "int8",
    512: "uint16", 768: "uint32", 1024: "int64", 1280: "uint64",
  };
  const UNSUPPORTED = { 32: "complex64", 128: "RGB24", 1536: "float128", 1792: "complex128",
                        2048: "complex256", 2304: "RGBA32" };

  function header(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (u8.length < 348) return null;
    for (const le of [true, false]) {
      const size = dv.getInt32(0, le);
      if (size === 348) return { version: 1, le, dv };
      if (size === 540) return { version: 2, le, dv };
    }
    return null;
  }

  const sniff = (u8) => {
    const h = header(u8);
    if (!h) return false;
    const at = h.version === 1 ? 344 : 4;
    return u8[at] === 0x6e && (u8[at + 1] === 0x2b || u8[at + 1] === 0x69);   // "n+" / "ni"
  };

  const text = (u8, at, len) => {
    let s = "";
    for (let i = at; i < at + len && u8[i]; i++) s += String.fromCharCode(u8[i]);
    return s.trim();
  };

  function qformAffine(b, c, d, qx, qy, qz, dx, dy, dz, qfac) {
    const a = Math.sqrt(Math.max(0, 1 - (b * b + c * c + d * d)));
    const R = [
      [a * a + b * b - c * c - d * d, 2 * (b * c - a * d), 2 * (b * d + a * c)],
      [2 * (b * c + a * d), a * a + c * c - b * b - d * d, 2 * (c * d - a * b)],
      [2 * (b * d - a * c), 2 * (c * d + a * b), a * a + d * d - c * c - b * b],
    ];
    const s = [dx, dy, dz * (qfac < 0 ? -1 : 1)];
    return [
      R[0][0] * s[0], R[0][1] * s[1], R[0][2] * s[2], qx,
      R[1][0] * s[0], R[1][1] * s[1], R[1][2] * s[2], qy,
      R[2][0] * s[0], R[2][1] * s[1], R[2][2] * s[2], qz,
      0, 0, 0, 1,
    ];
  }

  function parse(u8, name) {
    const h = header(u8);
    if (!h) throw new Error(`${name}: not a NIfTI file (header size is neither 348 nor 540).`);
    const { dv, le } = h;
    const v1 = h.version === 1;
    const i16 = (o) => dv.getInt16(o, le), i32 = (o) => dv.getInt32(o, le);
    const f32 = (o) => dv.getFloat32(o, le), f64 = (o) => dv.getFloat64(o, le);
    const i64 = (o) => Number(dv.getBigInt64(o, le));

    const dim = [], pixdim = [];
    for (let i = 0; i < 8; i++) {
      dim.push(v1 ? i16(40 + 2 * i) : i64(16 + 8 * i));
      pixdim.push(v1 ? f32(76 + 4 * i) : f64(104 + 8 * i));
    }
    const code = v1 ? i16(70) : i16(12);
    const magic = v1 ? text(u8, 344, 4) : text(u8, 4, 4);
    if (magic.startsWith("ni"))
      throw new Error(`${name}: a two-file NIfTI (.hdr + .img). Save it as one .nii(.gz) file.`);
    if (UNSUPPORTED[code]) throw new Error(`${name}: ${UNSUPPORTED[code]} data is not supported (scalar volumes only).`);
    const type = DTYPES[code];
    if (!type) throw new Error(`${name}: unknown NIfTI data type ${code}.`);

    const nd = Math.max(1, Math.min(7, dim[0]));
    const dims = [1, 2, 3].map((i) => (i <= nd ? Math.max(1, dim[i]) : 1));
    let frames = 1;
    for (let i = 4; i <= nd; i++) frames *= Math.max(1, dim[i]);
    const voxOffset = v1 ? Math.max(352, Math.round(f32(108))) : Math.max(544, i64(168));
    let slope = v1 ? f32(112) : f64(176), inter = v1 ? f32(116) : f64(184);
    if (!Number.isFinite(slope) || slope === 0) { slope = 1; inter = 0; }
    if (!Number.isFinite(inter)) inter = 0;

    const qcode = v1 ? i16(252) : i32(344), scode = v1 ? i16(254) : i32(348);
    const sp = [1, 2, 3].map((i) => (pixdim[i] > 0 && Number.isFinite(pixdim[i]) ? pixdim[i] : 1));
    let affine, source;
    if (scode > 0) {
      const row = (o) => (v1 ? [f32(o), f32(o + 4), f32(o + 8), f32(o + 12)]
                             : [f64(o), f64(o + 8), f64(o + 16), f64(o + 24)]);
      affine = [...row(v1 ? 280 : 400), ...row(v1 ? 296 : 432), ...row(v1 ? 312 : 464), 0, 0, 0, 1];
      source = "sform";
    } else if (qcode > 0) {
      const q = v1 ? [256, 260, 264, 268, 272, 276].map(f32) : [352, 360, 368, 376, 384, 392].map(f64);
      affine = qformAffine(...q, sp[0], sp[1], sp[2], pixdim[0]);
      source = "qform";
    } else {
      affine = [sp[0], 0, 0, 0, 0, sp[1], 0, 0, 0, 0, sp[2], 0, 0, 0, 0, 1];
      source = "none (voxel sizes only)";
    }

    const nvox = dims[0] * dims[1] * dims[2];
    const data = Med.io.typedArray(u8, voxOffset, nvox * frames, type, le);
    const notes = [];
    if (source.startsWith("none")) notes.push("No orientation in the header: shown as if RAS-aligned.");
    if (!le) notes.push("Big-endian file.");
    const descrip = text(u8, v1 ? 148 : 240, 80);
    const meta = {
      Format: `NIfTI-${h.version}`,
      "Data type": type + (slope !== 1 || inter !== 0 ? ` (× ${+slope.toPrecision(6)} + ${+inter.toPrecision(6)})` : ""),
      Affine: source,
    };
    if (descrip) meta.Description = descrip;
    if (frames > 1) meta.Frames = String(frames);
    return new Med.Volume({ name, format: "NIfTI", dims, frames, data, slope, inter, affine, dtype: type, meta, notes });
  }

  // --- Writing -----------------------------------------------------------------
  const CODES = { Uint8Array: [2, 8], Int16Array: [4, 16], Int32Array: [8, 32], Float32Array: [16, 32],
                  Float64Array: [64, 64], Int8Array: [256, 8], Uint16Array: [512, 16], Uint32Array: [768, 32] };

  /** The qform of an affine: voxel sizes, qfac, quaternion (b, c, d) and
   *  offset, from the rotation closest to its 3×3 part. */
  function qformOf(a) {
    const col = (c) => [a[c], a[4 + c], a[8 + c]];
    const zooms = [0, 1, 2].map((c) => Math.hypot(...col(c)) || 1);
    const R = [0, 1, 2].map((c) => col(c).map((v) => v / zooms[c]));   // R[c] = column c
    const det = R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1]) - R[1][0] * (R[0][1] * R[2][2] - R[0][2] * R[2][1]) +
                R[2][0] * (R[0][1] * R[1][2] - R[0][2] * R[1][1]);
    const qfac = det < 0 ? -1 : 1;
    if (qfac < 0) R[2] = R[2].map((v) => -v);
    // Orthonormalise (Gram-Schmidt): a sheared affine keeps its sform exact,
    // the qform gets the nearest rotation.
    const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    const unit = (u) => { const n = Math.hypot(...u) || 1; return u.map((v) => v / n); };
    const x = unit(R[0]);
    const y = unit(R[1].map((v, i) => v - dot(R[1], x) * x[i]));
    const z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]];
    // m[r][c]: row r, column c of the rotation.
    const m = [[x[0], y[0], z[0]], [x[1], y[1], z[1]], [x[2], y[2], z[2]]];
    const tr = m[0][0] + m[1][1] + m[2][2];
    let qa, qb, qc, qd;
    if (tr > 0) {
      const s = 0.5 / Math.sqrt(tr + 1);
      qa = 0.25 / s; qb = (m[2][1] - m[1][2]) * s; qc = (m[0][2] - m[2][0]) * s; qd = (m[1][0] - m[0][1]) * s;
    } else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
      const s = 2 * Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]);
      qa = (m[2][1] - m[1][2]) / s; qb = 0.25 * s; qc = (m[0][1] + m[1][0]) / s; qd = (m[0][2] + m[2][0]) / s;
    } else if (m[1][1] > m[2][2]) {
      const s = 2 * Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]);
      qa = (m[0][2] - m[2][0]) / s; qb = (m[0][1] + m[1][0]) / s; qc = 0.25 * s; qd = (m[1][2] + m[2][1]) / s;
    } else {
      const s = 2 * Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]);
      qa = (m[1][0] - m[0][1]) / s; qb = (m[0][2] + m[2][0]) / s; qc = (m[1][2] + m[2][1]) / s; qd = 0.25 * s;
    }
    if (qa < 0) { qb = -qb; qc = -qc; qd = -qd; }        // NIfTI keeps a >= 0
    return { zooms, qfac, b: qb, c: qc, d: qd, offset: [a[3], a[7], a[11]] };
  }

  /**
   * o: { dims:[3], frames, data (typed array, x fastest, frame-major),
   *      affine:[16], slope, inter, descrip, tr (s, for 4-D) }
   * Returns the .nii bytes (Uint8Array).
   */
  function write(o) {
    const code = CODES[o.data.constructor.name];
    if (!code) throw new Error(`Cannot write ${o.data.constructor.name} to NIfTI.`);
    const frames = o.frames || 1;
    const nvox = o.dims[0] * o.dims[1] * o.dims[2] * frames;
    if (o.data.length !== nvox) throw new Error(`${o.data.length} values for ${o.dims.join("×")}×${frames} voxels.`);
    const out = new Uint8Array(352 + o.data.byteLength);
    const dv = new DataView(out.buffer);
    const i16 = (at, v) => dv.setInt16(at, v, true), i32 = (at, v) => dv.setInt32(at, v, true);
    const f32 = (at, v) => dv.setFloat32(at, v, true);
    const str = (at, len, s) => { for (let i = 0; i < Math.min(len - 1, s.length); i++) out[at + i] = s.charCodeAt(i) & 0x7f; };
    const q = qformOf(o.affine);
    i32(0, 348);
    const nd = frames > 1 ? 4 : 3;
    [nd, o.dims[0], o.dims[1], o.dims[2], frames, 1, 1, 1].forEach((v, i) => i16(40 + 2 * i, v));
    i16(70, code[0]);
    i16(72, code[1]);
    [q.qfac, q.zooms[0], q.zooms[1], q.zooms[2], frames > 1 ? (o.tr || 1) : 1, 1, 1, 1].forEach((v, i) => f32(76 + 4 * i, v));
    f32(108, 352);
    f32(112, Number.isFinite(o.slope) && o.slope !== 1 ? o.slope : (o.inter ? 1 : 0));
    f32(116, o.inter || 0);
    out[123] = 2 | (frames > 1 ? 8 : 0);                     // mm, seconds
    str(148, 80, o.descrip || "");
    i16(252, 1);                                             // qform: scanner
    i16(254, 1);                                             // sform: scanner
    f32(256, q.b); f32(260, q.c); f32(264, q.d);
    f32(268, q.offset[0]); f32(272, q.offset[1]); f32(276, q.offset[2]);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) f32(280 + 16 * r + 4 * c, o.affine[r * 4 + c]);
    str(344, 4, "n+1");
    out.set(new Uint8Array(o.data.buffer, o.data.byteOffset, o.data.byteLength), 352);
    return out;
  }

  Med.nifti = { sniff, parse, write, qformOf };
})();
