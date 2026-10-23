/* ============================================================================
 * tract_view/lib/tracts.js — tractograms in and out (window.TV.io)
 * ----------------------------------------------------------------------------
 * A tractogram here is { positions: Float32Array (xyz per point, RAS mm),
 * offsets: Uint32Array } -- streamline k is points offsets[k] ..
 * offsets[k+1]-1 -- plus where it came from (name, format, the space its
 * file was in).
 *
 * Reading:
 *   .vtk   legacy PolyData LINES (common/med/io_vtk.js). Untagged files are
 *          LPS by dipy's convention (what the lab's tractography writes);
 *          the page checks that against the images (spaceScore).
 *   .ply   a vertex element (x, y, z) and either an edge element (vertex1,
 *          vertex2), chained into polylines, or a list element (face / line
 *          / polyline / streamline, "vertex_indices"), one polyline per
 *          entry; ascii or binary, either byte order. Untagged: as .vtk.
 *   .trk   TrackVis v1/v2: points in voxel-mm, taken to RAS mm through the
 *          header's vox_to_ras (nibabel's convention).
 *   .tck   MRtrix: points already RAS mm; NaN rows split streamlines.
 *
 * Writing:
 *   .vtk   binary legacy, LPS on disk and tagged SPACE=LPS (dipy reads it as
 *          LPS, 3D Slicer honours the tag)
 *   .trk   v2, against a reference image (its grid, voxel size and affine):
 *          voxmm = (ijk + ½) · voxel size, ijk = affine⁻¹ · RAS
 * ========================================================================== */
(function () {
  "use strict";
  const TV = (window.TV = window.TV || {});

  const kindOf = (name) => {
    const n = String(name).toLowerCase();
    if (n.endsWith(".vtk")) return "vtk";
    if (n.endsWith(".ply")) return "ply";
    if (n.endsWith(".trk")) return "trk";
    if (n.endsWith(".tck")) return "tck";
    if (n.endsWith(".vtp")) return "vtp";
    return "";
  };

  async function read(file) {
    const kind = kindOf(file.name);
    if (kind === "vtp") throw new Error(`${file.name}: XML VTK (.vtp) is not supported; save it as a legacy .vtk.`);
    const u8 = await Med.io.readBytes(file);
    if (kind === "vtk") {
      const t = Med.vtk.parseLines(u8, file.name);
      return { name: file.name, format: "VTK", fileSpace: t.space, tagged: !!t.space, raw: t.positions, offsets: t.offsets };
    }
    if (kind === "ply") return { name: file.name, format: "PLY", ...readPly(u8, file.name) };
    if (kind === "trk") return { name: file.name, format: "TRK", ...readTrk(u8, file.name) };
    if (kind === "tck") return { name: file.name, format: "TCK", ...readTck(u8, file.name) };
    throw new Error(`${file.name}: a tractogram must be .vtk, .ply, .trk or .tck.`);
  }

  /** Positions in RAS mm from the file's points in `space` (LPS: x, y negated). */
  function toRas(raw, space) {
    const p = Float32Array.from(raw);
    if (space === "LPS") for (let i = 0; i < p.length; i += 3) { p[i] = -p[i]; p[i + 1] = -p[i + 1]; }
    return p;
  }

  /**
   * How well the points sit on the images in each space, { LPS, RAS, how }.
   * Tracts run in white matter, so with a segmentation the score is the
   * share of points in the single most common label (IXI258: 0.64 in the
   * right frame, 0.39 flipped); with an image only, the points' intensities
   * are more uniform in the right frame: the share of points on non-zero
   * voxels over (1 + their coefficient of variation). Merely landing inside
   * the head does not tell the frames apart -- a head is nearly symmetric.
   */
  function spaceScore(raw, seg, volume) {
    const ref = seg || volume;
    const n = raw.length / 3, step = Math.max(1, Math.floor(n / 6000));
    const inv = ref.inv, [nx, ny, nz] = ref.dims;
    const score = { how: seg ? "points in the dominant segment" : "uniformity of the intensities under the points" };
    for (const space of ["LPS", "RAS"]) {
      const sg = space === "LPS" ? -1 : 1;
      const counts = new Map();
      let total = 0, nonzero = 0, sum = 0, sum2 = 0;
      for (let i = 0; i < n; i += step) {
        const x = sg * raw[i * 3], y = sg * raw[i * 3 + 1], z = raw[i * 3 + 2];
        const a = Math.round(inv[0] * x + inv[1] * y + inv[2] * z + inv[3]);
        const b = Math.round(inv[4] * x + inv[5] * y + inv[6] * z + inv[7]);
        const c = Math.round(inv[8] * x + inv[9] * y + inv[10] * z + inv[11]);
        total++;
        if (a < 0 || b < 0 || c < 0 || a >= nx || b >= ny || c >= nz) continue;
        const v = ref.value(a + nx * (b + ny * c));
        if (seg) { const l = Math.round(v); if (l > 0) counts.set(l, (counts.get(l) || 0) + 1); }
        else if (v > 0) { nonzero++; sum += v; sum2 += v * v; }
      }
      if (seg) score[space] = total ? Math.max(0, ...counts.values()) / total : 0;
      else {
        const mean = nonzero ? sum / nonzero : 0, cv = mean ? Math.sqrt(Math.max(0, sum2 / nonzero - mean * mean)) / mean : 1;
        score[space] = total ? nonzero / total / (1 + cv) : 0;
      }
    }
    return score;
  }

  // --- PLY (common/med/io_ply.js): edges and vertex lists as polylines ------
  function readPly(u8, name) {
    const r = Med.ply.read(u8, name);
    const polylines = Object.values(r.lists).flat();
    if (r.edges && r.edges.length) polylines.push(...Med.ply.chainEdges(r.edges, r.positions.length / 3));
    if (!polylines.length) throw new Error(`${name}: no streamlines (an "edge" element or a list of vertex_indices is needed).`);
    const positions = r.positions;
    let nPts = 0;
    for (const pl of polylines) nPts += pl.length;
    const raw = new Float32Array(nPts * 3), offsets = new Uint32Array(polylines.length + 1);
    let P = 0;
    polylines.forEach((pl, k) => {
      for (const v of pl) { raw[P * 3] = positions[v * 3]; raw[P * 3 + 1] = positions[v * 3 + 1]; raw[P * 3 + 2] = positions[v * 3 + 2]; P++; }
      offsets[k + 1] = P;
    });
    return { fileSpace: r.space, tagged: !!r.space, raw, offsets };
  }

  // --- TRK ----------------------------------------------------------------------
  function readTrk(u8, name) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const id = new TextDecoder("latin1").decode(u8.subarray(0, 5));
    if (id !== "TRACK") throw new Error(`${name}: not a TrackVis file.`);
    let le = true;
    if (dv.getInt32(996, true) !== 1000) {
      if (dv.getInt32(996, false) === 1000) le = false;
      else throw new Error(`${name}: bad TrackVis header size.`);
    }
    const i16 = (o) => dv.getInt16(o, le), i32 = (o) => dv.getInt32(o, le), f32 = (o) => dv.getFloat32(o, le);
    const vs = [f32(12), f32(16), f32(20)].map((v) => (v > 0 ? v : 1));
    const nScalars = i16(36), nProps = i16(238), count = i32(988), version = i32(992);
    let v2r = [];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) v2r.push(f32(440 + (r * 4 + c) * 4));
    const notes = [];
    if (version < 2 || v2r[15] === 0) {
      v2r = [vs[0], 0, 0, 0, 0, vs[1], 0, 0, 0, 0, vs[2], 0, 0, 0, 0, 1];
      notes.push("TrackVis v1 (no vox_to_ras): points placed by the voxel size only.");
    }
    // RAS = vox_to_ras · (voxmm / vs − ½).
    const A = Med.M.mul(v2r, [1 / vs[0], 0, 0, -0.5, 0, 1 / vs[1], 0, -0.5, 0, 0, 1 / vs[2], -0.5, 0, 0, 0, 1]);
    const order = new TextDecoder("latin1").decode(u8.subarray(948, 951)).toUpperCase();
    const pts = [], offs = [0];
    let at = 1000, n = 0;
    while (at + 4 <= u8.length && (count <= 0 || n < count)) {
      const k = i32(at); at += 4;
      if (k < 0 || at + k * (3 + nScalars) * 4 > u8.length) throw new Error(`${name}: truncated at streamline ${n}.`);
      for (let p = 0; p < k; p++) {
        const x = f32(at), y = f32(at + 4), z = f32(at + 8);
        at += (3 + nScalars) * 4;
        pts.push(A[0] * x + A[1] * y + A[2] * z + A[3], A[4] * x + A[5] * y + A[6] * z + A[7], A[8] * x + A[9] * y + A[10] * z + A[11]);
      }
      at += nProps * 4;
      if (k >= 2) offs.push(pts.length / 3); else pts.length -= k * 3;
      n++;
    }
    if (order && /^[RLAPSI]{3}$/.test(order)) {
      const v = new Med.Volume({ dims: [1, 1, 1], data: new Uint8Array(1), affine: v2r });
      if (v.orientation() !== order) notes.push(`Voxel order ${order} differs from the affine's ${v.orientation()}; the affine is used.`);
    }
    return { fileSpace: "RAS", tagged: true, raw: Float32Array.from(pts), offsets: Uint32Array.from(offs), notes };
  }

  // --- TCK ----------------------------------------------------------------------
  function readTck(u8, name) {
    const latin1 = new TextDecoder("latin1");
    const headEnd = latin1.decode(u8.subarray(0, Math.min(u8.length, 1 << 16))).indexOf("\nEND");
    if (!latin1.decode(u8.subarray(0, 13)) === "mrtrix tracks" || headEnd < 0) throw new Error(`${name}: not an MRtrix .tck file.`);
    const head = latin1.decode(u8.subarray(0, headEnd));
    const dtype = ((head.match(/datatype:\s*(\S+)/) || [])[1] || "Float32LE").toUpperCase();
    const off = +((head.match(/file:\s*\.\s+(\d+)/) || [])[1] || 0);
    if (!/^FLOAT(32|64)(LE|BE)$/.test(dtype)) throw new Error(`${name}: datatype ${dtype} is not supported.`);
    const size = dtype.startsWith("FLOAT64") ? 8 : 4, le = dtype.endsWith("LE");
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const get = size === 8 ? (o) => dv.getFloat64(o, le) : (o) => dv.getFloat32(o, le);
    const pts = [], offs = [0];
    let cur = 0;
    for (let at = off; at + 3 * size <= u8.length; at += 3 * size) {
      const x = get(at), y = get(at + size), z = get(at + 2 * size);
      if (!Number.isFinite(x)) {
        if (cur >= 2) offs.push(pts.length / 3); else pts.length -= cur * 3;
        cur = 0;
        if (x === Infinity || x === -Infinity) break;
        continue;
      }
      pts.push(x, y, z);
      cur++;
    }
    return { fileSpace: "RAS", tagged: true, raw: Float32Array.from(pts), offsets: Uint32Array.from(offs) };
  }

  // --- Writing --------------------------------------------------------------------
  /**
   * TrackVis v2 against `ref` (a Med.Volume: dims, affine). positions are
   * RAS mm. Returns a Blob.
   */
  function writeTrk(positions, offsets, ref) {
    const nL = offsets.length - 1, nP = positions.length / 3;
    const head = new DataView(new ArrayBuffer(1000));
    const str = (o, s) => { for (let i = 0; i < s.length; i++) head.setUint8(o + i, s.charCodeAt(i)); };
    const vs = ref.spacing;
    str(0, "TRACK");
    ref.dims.forEach((d, i) => head.setInt16(6 + 2 * i, d, true));
    vs.forEach((v, i) => head.setFloat32(12 + 4 * i, v, true));
    for (let i = 0; i < 16; i++) head.setFloat32(440 + 4 * i, ref.affine[i], true);
    str(948, ref.orientation());
    head.setInt32(988, nL, true);
    head.setInt32(992, 2, true);
    head.setInt32(996, 1000, true);
    // voxmm = (affine⁻¹ · RAS + ½) · vs
    const I = ref.inv;
    const body = new DataView(new ArrayBuffer(nL * 4 + nP * 12));
    let o = 0;
    for (let c = 0; c < nL; c++) {
      body.setInt32(o, offsets[c + 1] - offsets[c], true); o += 4;
      for (let p = offsets[c]; p < offsets[c + 1]; p++) {
        const x = positions[p * 3], y = positions[p * 3 + 1], z = positions[p * 3 + 2];
        for (let r = 0; r < 3; r++) {
          const v = I[r * 4] * x + I[r * 4 + 1] * y + I[r * 4 + 2] * z + I[r * 4 + 3];
          body.setFloat32(o, (v + 0.5) * vs[r], true); o += 4;
        }
      }
    }
    return new Blob([head.buffer, body.buffer], { type: "application/octet-stream" });
  }

  TV.io = { kindOf, read, toRas, spaceScore, writeTrk };
})();
