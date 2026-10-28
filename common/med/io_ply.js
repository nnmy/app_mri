/* ============================================================================
 * common/med/io_ply.js — PLY files (window.Med.ply)
 * ----------------------------------------------------------------------------
 * ASCII or binary (either byte order). What is read:
 *   vertex    x, y, z (other properties skipped)
 *   edge      vertex1, vertex2 -> chained into polylines (chainEdges)
 *   any list  "vertex_indices" / "vertex_index" (face, line, polyline, …)
 * A "comment SPACE=RAS" / "SPACE=LPS" line (as 3D Slicer writes) gives the
 * coordinate frame; otherwise it is unknown and the caller decides.
 *
 *   read(u8, name)     -> { space, positions, edges, lists: { element: [Uint32Array] } }
 *   surface(u8, name)  -> { space, positions, indices } (faces fanned into triangles)
 * ========================================================================== */
(function () {
  "use strict";
  const Med = (window.Med = window.Med || {});

  const TYPES = {
    char: [1, "getInt8"], int8: [1, "getInt8"], uchar: [1, "getUint8"], uint8: [1, "getUint8"],
    short: [2, "getInt16"], int16: [2, "getInt16"], ushort: [2, "getUint16"], uint16: [2, "getUint16"],
    int: [4, "getInt32"], int32: [4, "getInt32"], uint: [4, "getUint32"], uint32: [4, "getUint32"],
    float: [4, "getFloat32"], float32: [4, "getFloat32"], double: [8, "getFloat64"], float64: [8, "getFloat64"],
  };

  function read(u8, name) {
    const latin1 = new TextDecoder("latin1");
    let end = -1;
    for (let i = 0; i < Math.min(u8.length - 10, 1 << 16); i++)
      if (u8[i] === 0x65 && latin1.decode(u8.subarray(i, i + 10)) === "end_header") { end = i; break; }
    if (latin1.decode(u8.subarray(0, 3)) !== "ply" || end < 0) throw new Error(`${name}: not a PLY file.`);
    let body = end + 10;
    while (u8[body] === 13 || u8[body] === 10) { body++; if (u8[body - 1] === 10) break; }
    let format = "ascii", space = null;
    const elements = [];
    for (const l of latin1.decode(u8.subarray(0, end)).split(/\r?\n/)) {
      const t = l.trim().split(/\s+/);
      if (t[0] === "format") format = t[1];
      else if (t[0] === "comment" || t[0] === "obj_info") { const m = l.match(/SPACE=(RAS|LPS)/i); if (m) space = m[1].toUpperCase(); }
      else if (t[0] === "element") elements.push({ name: t[1], count: +t[2], props: [] });
      else if (t[0] === "property" && elements.length) {
        const el = elements[elements.length - 1];
        if (t[1] === "list") el.props.push({ name: t[4], list: true, countType: t[2], type: t[3] });
        else el.props.push({ name: t[2], type: t[1] });
      }
    }
    const le = format === "binary_little_endian", binary = format !== "ascii";
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let at = body, tokens = null, ti = 0;
    if (!binary) tokens = latin1.decode(u8.subarray(body)).trim().split(/\s+/);
    const scalar = (type) => {
      if (!binary) return Number(tokens[ti++]);
      const spec = TYPES[type];
      if (!spec) throw new Error(`${name}: PLY type "${type}" is not supported.`);
      const v = dv[spec[1]](at, le);
      at += spec[0];
      return v;
    };
    let positions = null, edges = null;
    const lists = {};
    for (const el of elements) {
      const isVertex = el.name === "vertex";
      if (isVertex) positions = new Float32Array(el.count * 3);
      const ix = el.props.findIndex((p) => p.name === "x"), iy = el.props.findIndex((p) => p.name === "y"), iz = el.props.findIndex((p) => p.name === "z");
      const v1 = el.props.findIndex((p) => p.name === "vertex1"), v2 = el.props.findIndex((p) => p.name === "vertex2");
      const isEdge = el.name === "edge" && v1 >= 0 && v2 >= 0;
      if (isEdge) edges = new Uint32Array(el.count * 2);
      const listIdx = el.props.findIndex((p) => p.list && /vertex_ind/.test(p.name));
      if (listIdx >= 0 && !isVertex) lists[el.name] = [];
      for (let r = 0; r < el.count; r++)
        for (let k = 0; k < el.props.length; k++) {
          const p = el.props[k];
          if (p.list) {
            const n = scalar(p.countType), vals = new Uint32Array(n);
            for (let q = 0; q < n; q++) vals[q] = scalar(p.type);
            if (k === listIdx && !isVertex && n >= 2) lists[el.name].push(vals);
          } else {
            const v = scalar(p.type);
            if (isVertex) { if (k === ix) positions[r * 3] = v; else if (k === iy) positions[r * 3 + 1] = v; else if (k === iz) positions[r * 3 + 2] = v; }
            else if (isEdge) { if (k === v1) edges[r * 2] = v; else if (k === v2) edges[r * 2 + 1] = v; }
          }
        }
    }
    if (!positions) throw new Error(`${name}: no vertex element.`);
    return { space, positions, edges, lists };
  }

  /** A triangle surface from the "face" lists (polygons fanned). */
  function surface(u8, name) {
    const r = read(u8, name);
    const faces = r.lists.face || [];
    const tris = [];
    for (const f of faces) for (let i = 1; i + 1 < f.length; i++) tris.push(f[0], f[i], f[i + 1]);
    if (!tris.length) throw new Error(`${name}: no faces (a surface needs a "face" element).`);
    const n = r.positions.length / 3, indices = Uint32Array.from(tris);
    for (let i = 0; i < indices.length; i++) if (indices[i] >= n) throw new Error(`${name}: a face refers to vertex ${indices[i]} of ${n}.`);
    return { name, space: r.space, positions: r.positions, indices };
  }

  /** Edge pairs -> polylines: walk each chain from an end (degree 1). */
  function chainEdges(edges, nVerts) {
    const deg = new Uint32Array(nVerts), adjStart = new Uint32Array(nVerts + 1);
    for (const v of edges) deg[v]++;
    for (let v = 0; v < nVerts; v++) adjStart[v + 1] = adjStart[v] + deg[v];
    const adj = new Uint32Array(edges.length), fill = adjStart.slice(0, nVerts);
    for (let e = 0; e < edges.length; e += 2) {
      adj[fill[edges[e]]++] = edges[e + 1];
      adj[fill[edges[e + 1]]++] = edges[e];
    }
    const seen = new Uint8Array(nVerts), out = [];
    const walk = (start) => {
      const line = [start];
      seen[start] = 1;
      let cur = start;
      for (;;) {
        let next = -1;
        for (let k = adjStart[cur]; k < adjStart[cur + 1]; k++) if (!seen[adj[k]]) { next = adj[k]; break; }
        if (next < 0) break;
        seen[next] = 1; line.push(next); cur = next;
      }
      if (line.length >= 2) out.push(Uint32Array.from(line));
    };
    for (let v = 0; v < nVerts; v++) if (!seen[v] && deg[v] === 1) walk(v);
    for (let v = 0; v < nVerts; v++) if (!seen[v] && deg[v] > 0) walk(v);    // closed loops
    return out;
  }

  Med.ply = { read, surface, chainEdges };
})();
