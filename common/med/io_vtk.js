/* ============================================================================
 * common/med/io_vtk.js — legacy VTK PolyData (.vtk): surfaces and polylines
 * ----------------------------------------------------------------------------
 * ASCII or BINARY (big-endian, as VTK writes it); POINTS (float or double);
 * POLYGONS and TRIANGLE_STRIPS (surfaces, fanned into triangles) and LINES
 * (polylines: streamlines), in the classic layout ("n size" then "count i j
 * k ...") or VTK 5.1's (OFFSETS + CONNECTIVITY arrays). VERTICES and the
 * point/cell data that follow are skipped. Everything is read into typed
 * arrays: a whole-brain tractogram is ~10^5 lines and ~10^7 points.
 *
 *   parse(u8, name)       -> { positions, indices (triangles), title, space }
 *                            a surface; refuses a file without polygons
 *   parseLines(u8, name)  -> { positions, offsets, title, space }
 *                            polylines: line k is points offsets[k] ..
 *                            offsets[k+1]-1; refuses a file without lines
 *   writeLines(...)       -> polylines as a binary legacy .vtk
 *
 * Space: legacy VTK has no coordinate frame. A title line tagged
 * "SPACE=RAS" or "SPACE=LPS" (as 3D Slicer reads and writes them) says which;
 * otherwise the caller decides (surfaces: RAS; tractograms: LPS, dipy's
 * convention, or whichever overlaps the images -- see the tract page).
 * LPS points are turned to RAS (x and y negated) so meshes and volumes meet.
 * ========================================================================== */
(function () {
  "use strict";
  const Med = (window.Med = window.Med || {});

  function read(u8, name) {
    let at = 0;
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const latin1 = new TextDecoder("latin1");
    const line = () => {
      let s = "";
      while (at < u8.length && s.trim() === "") {
        const start = at;
        while (at < u8.length && u8[at] !== 10) at++;
        s = latin1.decode(u8.subarray(start, at)).replace(/\r$/, "");
        at++;
      }
      return s.trim();
    };
    const head = line();
    if (!/^# vtk DataFile/i.test(head)) throw new Error(`${name}: not a legacy VTK file (no "# vtk DataFile" header).`);
    const title = line();
    const format = line().toUpperCase();
    const binary = format === "BINARY";
    if (!binary && format !== "ASCII") throw new Error(`${name}: unknown format line "${format}".`);
    const dataset = line();
    if (!/^DATASET\s+POLYDATA/i.test(dataset))
      throw new Error(`${name}: ${dataset || "no DATASET"} — only POLYDATA is supported.`);
    const space = (title.match(/SPACE=(RAS|LPS)/i) || [])[1];

    // ASCII numbers: a token cursor that can stop at any point.
    const ascii = (count, Out) => {
      const out = new Out(count);
      let n = 0;
      while (n < count && at < u8.length) {
        while (at < u8.length && u8[at] <= 32) at++;
        const start = at;
        while (at < u8.length && u8[at] > 32) at++;
        if (at > start) out[n++] = Number(latin1.decode(u8.subarray(start, at)));
      }
      if (n < count) throw new Error(`${name}: the file ends early.`);
      return out;
    };
    const SIZES = { float: 4, double: 8, int: 4, vtktypeint32: 4, vtktypeint64: 8, long: 8, vtkidtype: 8 };
    const binaryValues = (count, type, Out) => {
      const size = SIZES[type] || 4;
      if (at + count * size > u8.length) throw new Error(`${name}: the file ends early.`);
      const out = new Out(count);
      if (type === "float") for (let i = 0; i < count; i++, at += 4) out[i] = dv.getFloat32(at, false);
      else if (type === "double") for (let i = 0; i < count; i++, at += 8) out[i] = dv.getFloat64(at, false);
      else if (size === 8) {
        // 64-bit ids: the high word is 0 for any count a browser can hold.
        for (let i = 0; i < count; i++, at += 8) out[i] = dv.getUint32(at + 4, false) + dv.getInt32(at, false) * 4294967296;
      } else for (let i = 0; i < count; i++, at += 4) out[i] = dv.getInt32(at, false);
      return out;
    };
    const values = (count, type, Out) => (binary ? binaryValues(count, String(type).toLowerCase(), Out) : ascii(count, Out));

    /** Cells -> { offsets (n+1), conn } as typed arrays. */
    function cells(n, size) {
      const save = at;
      const next = line();
      if (/^OFFSETS/i.test(next)) {
        // VTK 5.1: "OFFSETS type" (n values) and "CONNECTIVITY type" (size).
        const offsets = values(n, next.split(/\s+/)[1] || "vtktypeint64", Float64Array);
        const cl = line();
        if (!/^CONNECTIVITY/i.test(cl)) throw new Error(`${name}: OFFSETS without CONNECTIVITY.`);
        const conn = values(size, cl.split(/\s+/)[1] || "vtktypeint64", Uint32Array);
        return { offsets: Uint32Array.from(offsets), conn };
      }
      at = save;
      const raw = values(size, "int", Int32Array);
      const offsets = new Uint32Array(n + 1), conn = new Uint32Array(Math.max(0, size - n));
      let i = 0, o = 0;
      for (let c = 0; c < n; c++) {
        const k = raw[i++];
        conn.set(raw.subarray(i, i + k), o);
        i += k; o += k;
        offsets[c + 1] = o;
      }
      return { offsets, conn: conn.subarray(0, o) };
    }

    let positions = null;
    const polys = [], strips = [], lines = [];
    while (at < u8.length) {
      const l = line();
      if (!l) break;
      const parts = l.split(/\s+/), key = parts[0].toUpperCase();
      if (key === "POINTS") positions = values(+parts[1] * 3, parts[2] || "float", Float32Array);
      else if (key === "POLYGONS") polys.push(cells(+parts[1], +parts[2]));
      else if (key === "TRIANGLE_STRIPS") strips.push(cells(+parts[1], +parts[2]));
      else if (key === "LINES") lines.push(cells(+parts[1], +parts[2]));
      else if (key === "VERTICES") cells(+parts[1], +parts[2]);              // read past them
      else if (key === "METADATA") {
        // Ends at a blank line (which line() would skip): find it directly.
        while (at < u8.length - 1 && !(u8[at] === 10 && (u8[at + 1] === 10 || (u8[at + 1] === 13 && u8[at + 2] === 10)))) at++;
        at += 2;
      } else if (key === "POINT_DATA" || key === "CELL_DATA" || key === "FIELD") break;   // colours etc.: not used
    }
    if (!positions) throw new Error(`${name}: no POINTS.`);
    return { title, space: space ? space.toUpperCase() : null, positions, polys, strips, lines };
  }

  /** A surface: triangles from polygons (fanned) and triangle strips. */
  function parse(u8, name) {
    const r = read(u8, name);
    const tris = [];
    for (const { offsets, conn } of r.polys)
      for (let c = 0; c + 1 < offsets.length; c++)
        for (let i = offsets[c] + 1; i + 1 < offsets[c + 1]; i++) tris.push(conn[offsets[c]], conn[i], conn[i + 1]);
    for (const { offsets, conn } of r.strips)
      for (let c = 0; c + 1 < offsets.length; c++)
        for (let i = offsets[c]; i + 2 < offsets[c + 1]; i++) {
          if ((i - offsets[c]) & 1) tris.push(conn[i + 1], conn[i], conn[i + 2]);
          else tris.push(conn[i], conn[i + 1], conn[i + 2]);
        }
    if (!tris.length) throw new Error(`${name}: no polygons` + (r.lines.length ? " (it holds lines: a tractogram?)." : " (only points or lines?)."));
    const nPts = r.positions.length / 3;
    const indices = Uint32Array.from(tris);
    for (let i = 0; i < indices.length; i++)
      if (indices[i] >= nPts) throw new Error(`${name}: a polygon refers to point ${indices[i]} of ${nPts}.`);
    return { name, title: r.title, space: r.space, positions: r.positions, indices };
  }

  /**
   * Polylines: every line's points copied out in order, so line k is points
   * offsets[k] .. offsets[k+1]-1 of `positions` (whatever the file's point
   * sharing). Lines of fewer than 2 points are dropped.
   */
  function parseLines(u8, name) {
    const r = read(u8, name);
    if (!r.lines.length) throw new Error(`${name}: no LINES` + (r.polys.length ? " (it holds polygons: a surface?)." : "."));
    let nLines = 0, nPts = 0;
    for (const { offsets } of r.lines)
      for (let c = 0; c + 1 < offsets.length; c++) {
        const k = offsets[c + 1] - offsets[c];
        if (k >= 2) { nLines++; nPts += k; }
      }
    const src = r.positions, nSrc = src.length / 3;
    const positions = new Float32Array(nPts * 3), offsets = new Uint32Array(nLines + 1);
    let L = 0, P = 0;
    for (const { offsets: off, conn } of r.lines)
      for (let c = 0; c + 1 < off.length; c++) {
        const a = off[c], b = off[c + 1];
        if (b - a < 2) continue;
        for (let i = a; i < b; i++) {
          const p = conn[i];
          if (p >= nSrc) throw new Error(`${name}: a line refers to point ${p} of ${nSrc}.`);
          positions[P * 3] = src[p * 3]; positions[P * 3 + 1] = src[p * 3 + 1]; positions[P * 3 + 2] = src[p * 3 + 2];
          P++;
        }
        offsets[++L] = P;
      }
    return { name, title: r.title, space: r.space, positions, offsets };
  }

  /**
   * Polylines -> a binary legacy .vtk (classic LINES layout, float points),
   * the title tagged with the space the points are written in. `toLps`
   * negates x and y on the way out (positions are RAS mm).
   */
  function writeLines(positions, offsets, title, toLps) {
    const nPts = positions.length / 3, nLines = offsets.length - 1;
    const enc = new TextEncoder();
    const space = toLps ? "LPS" : "RAS";
    const head = enc.encode(`# vtk DataFile Version 3.0\n${String(title || "streamlines").replace(/[\r\n]/g, " ").slice(0, 200)} SPACE=${space}\n` +
                            `BINARY\nDATASET POLYDATA\nPOINTS ${nPts} float\n`);
    const s = toLps ? -1 : 1;
    const pts = new DataView(new ArrayBuffer(nPts * 12));
    for (let i = 0; i < nPts; i++) {
      pts.setFloat32(i * 12, s * positions[i * 3], false);
      pts.setFloat32(i * 12 + 4, s * positions[i * 3 + 1], false);
      pts.setFloat32(i * 12 + 8, positions[i * 3 + 2], false);
    }
    const mid = enc.encode(`\nLINES ${nLines} ${nLines + nPts}\n`);
    const cellv = new DataView(new ArrayBuffer((nLines + nPts) * 4));
    let o = 0;
    for (let c = 0; c < nLines; c++) {
      cellv.setInt32(o, offsets[c + 1] - offsets[c], false); o += 4;
      for (let p = offsets[c]; p < offsets[c + 1]; p++) { cellv.setInt32(o, p, false); o += 4; }
    }
    return new Blob([head, pts.buffer, mid, cellv.buffer, enc.encode("\n")], { type: "application/octet-stream" });
  }

  /** The mesh's points as RAS (from LPS: x and y negated), as a new array. */
  function toRas(mesh, space) {
    const p = Float32Array.from(mesh.positions);
    if (space === "LPS") for (let i = 0; i < p.length; i += 3) { p[i] = -p[i]; p[i + 1] = -p[i + 1]; }
    return p;
  }

  Med.vtk = { parse, parseLines, writeLines, toRas };
})();
