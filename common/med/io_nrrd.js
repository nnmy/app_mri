/* ============================================================================
 * common/med/io_nrrd.js — NRRD (.nrrd, 3D Slicer's .seg.nrrd)
 * ----------------------------------------------------------------------------
 * One file, header and data together; raw, gzip or ASCII encoding. The world
 * frame comes from "space" (LPS, as Slicer writes, is flipped to RAS), the
 * axes from "space directions" and "space origin" (or "spacings" alone).
 *
 * A segmentation from 3D Slicer carries its segments in the header
 * (Segment<N>_Name / _Color / _LabelValue / _Layer); those become the
 * names and colours of the labels. When segments overlap, Slicer stores
 * them in layers (a 4-D file, the layer axis first, "none" direction): the
 * layers are merged into one label map, one id per segment, a later segment
 * winning where two overlap (noted on the page).
 * ========================================================================== */
(function () {
  "use strict";
  const Med = (window.Med = window.Med || {});

  const TYPE_NAMES = [
    ["int8", ["signed char", "int8", "int8_t"]],
    ["uint8", ["uchar", "unsigned char", "uint8", "uint8_t"]],
    ["int16", ["short", "short int", "signed short", "signed short int", "int16", "int16_t"]],
    ["uint16", ["ushort", "unsigned short", "unsigned short int", "uint16", "uint16_t"]],
    ["int32", ["int", "signed int", "int32", "int32_t"]],
    ["uint32", ["uint", "unsigned int", "uint32", "uint32_t"]],
    ["int64", ["longlong", "long long", "long long int", "signed long long", "signed long long int", "int64", "int64_t"]],
    ["uint64", ["ulonglong", "unsigned long long", "unsigned long long int", "uint64", "uint64_t"]],
    ["float32", ["float"]],
    ["float64", ["double"]],
  ];
  const typeOf = (s) => {
    const t = s.trim().toLowerCase();
    const hit = TYPE_NAMES.find(([, names]) => names.includes(t));
    if (!hit) throw new Error(`NRRD type "${s}" is not supported.`);
    return hit[0];
  };
  // The sign of each axis of the file's space, as RAS.
  const SPACES = {
    "right-anterior-superior": [1, 1, 1], ras: [1, 1, 1],
    "left-anterior-superior": [-1, 1, 1], las: [-1, 1, 1],
    "left-posterior-superior": [-1, -1, 1], lps: [-1, -1, 1],
  };

  const sniff = (u8) => u8.length > 8 && String.fromCharCode(...u8.subarray(0, 4)) === "NRRD";

  function splitHeader(u8) {
    for (let i = 0; i < Math.min(u8.length - 1, 1 << 20); i++) {
      if (u8[i] === 10 && u8[i + 1] === 10) return [i, i + 2];
      if (u8[i] === 10 && u8[i + 1] === 13 && u8[i + 2] === 10) return [i, i + 3];
    }
    throw new Error("No end of the NRRD header (a blank line) was found.");
  }

  const vector = (s) => {
    const m = s.match(/\(([^)]*)\)/);
    return m ? m[1].split(",").map(Number) : null;
  };
  const vectors = (s) => (s.match(/\([^)]*\)|none/gi) || []).map((t) => (t.toLowerCase() === "none" ? null : vector(t)));

  async function parse(u8, name) {
    if (!sniff(u8)) throw new Error(`${name}: not a NRRD file.`);
    const [hEnd, dStart] = splitHeader(u8);
    const lines = new TextDecoder("latin1").decode(u8.subarray(0, hEnd)).split(/\r?\n/);
    const fields = {}, kv = {};
    for (const line of lines.slice(1)) {
      if (!line || line[0] === "#") continue;
      let m = line.match(/^([^:]+):=(.*)$/);
      if (m) { kv[m[1].trim()] = m[2]; continue; }
      m = line.match(/^([^:]+):\s*(.*)$/);
      if (m) fields[m[1].trim().toLowerCase()] = m[2].trim();
    }
    if (fields["data file"] || fields.datafile)
      throw new Error(`${name}: the data is in a separate file. Save it as one .nrrd file.`);
    const dimension = +fields.dimension;
    const sizes = (fields.sizes || "").split(/\s+/).map(Number);
    if (!dimension || sizes.length !== dimension) throw new Error(`${name}: bad "dimension"/"sizes" fields.`);
    const type = typeOf(fields.type || "");
    const encoding = (fields.encoding || "raw").toLowerCase();
    const le = (fields.endian || "little").toLowerCase() !== "big";

    // Which axes are in space (a direction vector) and which are a list
    // (layers, components, time).
    let dirs = fields["space directions"] ? vectors(fields["space directions"]) : null;
    if (dirs && dirs.length !== dimension) dirs = null;
    const kinds = (fields.kinds || "").split(/\s+/).filter(Boolean).map((k) => k.toLowerCase());
    let spatial;
    if (dirs) spatial = dirs.map((d, i) => (d ? i : -1)).filter((i) => i >= 0);
    else if (kinds.length === dimension) spatial = kinds.map((k, i) => (k === "domain" || k === "space" ? i : -1)).filter((i) => i >= 0);
    else spatial = [0, 1, 2].filter((i) => i < dimension);
    const list = [...Array(dimension).keys()].filter((i) => !spatial.includes(i));
    if (spatial.length < 2 || spatial.length > 3 || list.length > 1)
      throw new Error(`${name}: a ${dimension}-D NRRD with ${spatial.length} spatial axes is not supported.`);

    // The affine (RAS).
    const space = (fields.space || "").toLowerCase();
    const sign = SPACES[space] || [1, 1, 1];
    const notes = [];
    if (space && !SPACES[space]) notes.push(`Space "${fields.space}" read as RAS.`);
    const origin = (fields["space origin"] && vector(fields["space origin"])) || [0, 0, 0];
    const spacings = (fields.spacings || "").split(/\s+/).map(Number);
    const cols = spatial.map((ax, n) => {
      if (dirs && dirs[ax]) return dirs[ax];
      const s = Number.isFinite(spacings[ax]) && spacings[ax] > 0 ? spacings[ax] : 1;
      return [0, 1, 2].map((d) => (d === n ? s : 0));
    });
    while (cols.length < 3) cols.push([0, 0, 1]);           // a 2-D image: one slice
    if (!dirs && !fields.spacings) notes.push("No orientation in the header: shown as if RAS-aligned.");
    const affine = [
      sign[0] * cols[0][0], sign[0] * cols[1][0], sign[0] * cols[2][0], sign[0] * origin[0],
      sign[1] * cols[0][1], sign[1] * cols[1][1], sign[1] * cols[2][1], sign[1] * origin[1],
      sign[2] * cols[0][2], sign[2] * cols[1][2], sign[2] * cols[2][2], sign[2] * (origin[2] || 0),
      0, 0, 0, 1,
    ];

    // The data.
    const total = sizes.reduce((a, b) => a * b, 1);
    let raw;
    if (encoding === "raw") {
      let start = dStart;
      const skipLines = +fields["line skip"] || +fields.lineskip || 0;
      for (let n = 0; n < skipLines; n++) { while (start < u8.length && u8[start] !== 10) start++; start++; }
      const skip = +(fields["byte skip"] ?? fields.byteskip ?? 0);
      const bytes = total * ({ int8: 1, uint8: 1, int16: 2, uint16: 2, float64: 8, int64: 8, uint64: 8 }[type] || 4);
      start = skip === -1 ? u8.length - bytes : start + skip;
      raw = Med.io.typedArray(u8, start, total, type, le);
    } else if (encoding === "gzip" || encoding === "gz") {
      const body = await Med.io.gunzip(u8.subarray(dStart));
      raw = Med.io.typedArray(body, 0, total, type, le);
    } else if (encoding === "ascii" || encoding === "text" || encoding === "txt") {
      const nums = new TextDecoder("latin1").decode(u8.subarray(dStart)).trim().split(/[\s,]+/).map(Number);
      raw = Float64Array.from(nums.slice(0, total));
      if (raw.length < total) throw new Error(`${name}: ${raw.length} ASCII values for ${total} voxels.`);
    } else {
      throw new Error(`${name}: NRRD encoding "${encoding}" is not supported (raw, gzip or ascii).`);
    }

    // Frame-major (all voxels of frame 0, then frame 1, ...), whatever the
    // list axis's place in the file.
    const dims = [0, 1, 2].map((n) => (n < spatial.length ? sizes[spatial[n]] : 1));
    const nvox = dims[0] * dims[1] * dims[2];
    const frames = list.length ? sizes[list[0]] : 1;
    let data = raw;
    if (frames > 1 && list[0] !== dimension - 1) {
      const strides = [];
      let acc = 1;
      for (let i = 0; i < dimension; i++) { strides.push(acc); acc *= sizes[i]; }
      data = new raw.constructor(raw.length);
      const sx = strides[spatial[0]], sy = strides[spatial[1]], sz = spatial[2] != null ? strides[spatial[2]] : 0;
      const sf = strides[list[0]];
      for (let f = 0, o = 0; f < frames; f++)
        for (let z = 0; z < dims[2]; z++)
          for (let y = 0; y < dims[1]; y++)
            for (let x = 0; x < dims[0]; x++) data[o++] = raw[f * sf + x * sx + y * sy + z * sz];
    }

    const meta = { Format: "NRRD", "Data type": type, Encoding: encoding, Space: fields.space || "—" };
    if (frames > 1) meta[kinds[list[0]] === "list" ? "Layers" : "Frames"] = String(frames);
    const vol = { name, format: "NRRD", dims, frames, data, affine, dtype: type, meta, notes };
    segmentsFromHeader(vol, kv);
    return new Med.Volume(vol);
  }

  /** Slicer's segment table -> labelInfo; layered segments -> one label map. */
  function segmentsFromHeader(vol, kv) {
    const segs = [];
    for (let i = 0; kv[`Segment${i}_ID`] !== undefined || kv[`Segment${i}_Name`] !== undefined; i++) {
      const color = (kv[`Segment${i}_Color`] || "").trim().split(/\s+/).map(Number);
      segs.push({
        name: kv[`Segment${i}_Name`] || kv[`Segment${i}_ID`] || `Segment ${i}`,
        color: color.length >= 3 && color.every(Number.isFinite) ? color.slice(0, 3).map((c) => Math.round(c * 255)) : null,
        value: +(kv[`Segment${i}_LabelValue`] ?? i + 1),
        layer: +(kv[`Segment${i}_Layer`] ?? 0),
      });
    }
    if (!segs.length) return;
    vol.meta.Segments = String(segs.length);
    const nvox = vol.dims[0] * vol.dims[1] * vol.dims[2];
    if (vol.frames > 1) {
      // One id per segment (its index + 1), painted layer by layer.
      const out = new Uint16Array(nvox);
      let overlap = 0;
      segs.forEach((s, n) => {
        const off = s.layer * nvox, id = n + 1;
        for (let v = 0; v < nvox; v++) {
          if (vol.data[off + v] !== s.value) continue;
          if (out[v]) overlap++;
          out[v] = id;
        }
      });
      vol.data = out;
      vol.dtype = "uint16 (merged layers)";
      vol.frames = 1;
      delete vol.meta.Layers;
      vol.labelInfo = new Map(segs.map((s, n) => [n + 1, { name: s.name, color: s.color }]));
      if (overlap) vol.notes.push(`${overlap.toLocaleString("en-US")} voxels belong to two segments; each shows the later one.`);
    } else {
      vol.labelInfo = new Map(segs.map((s) => [s.value, { name: s.name, color: s.color }]));
    }
  }

  Med.nrrd = { sniff, parse };
})();
