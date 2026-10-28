/* ============================================================================
 * demo_brain_aging/lib/data.js — the demo's files, fetched and decoded
 * (window.DBA.data)
 * ----------------------------------------------------------------------------
 * data/manifest.json (written by prep/build_data.py) names the labels,
 * data/measures.csv (per subject and segment: volume, tract count, count per
 * direction class) and, per subject:
 *   tracts      the native-space streamlines, "DBA1" format (gzip'd):
 *               "DBA1", uint32 header length, JSON header {streamlines,
 *               points, scale}, uint16 points per streamline, int16 xyz of
 *               each first point, int8 xyz steps for the rest, all in
 *               `scale` mm (1/32) -- decoded here to { positions (RAS mm),
 *               offsets }, as Med.vtk.parseLines returns them
 *   seg_native  the segmentation on the subject's b0 grid (what the tracts
 *               are cropped and measured with)
 *   seg, t1, t2 the display volumes, on one 1 mm grid in IXI051's b0 space
 *   head        the head surface (VTK, common space)
 * and native_to_common, the 4x4 (RAS, row-major) that moves the subject's
 * tracts into the common space (identity for IXI051, the affine for IXI518).
 *
 * load() fetches what the 3D view needs (tracts, native segmentation, head);
 * loadSlices() the display volumes, when a slice tab is first opened.
 * ========================================================================== */
(function () {
  "use strict";
  const DBA = (window.DBA = window.DBA || {});

  async function bytes(url) {
    const r = await fetch(url, { cache: "no-cache" });
    if (!r.ok) throw new Error(`${url.split("/").pop()}: HTTP ${r.status}`);
    const u8 = new Uint8Array(await r.arrayBuffer());
    return Med.io.isGzip(u8) ? Med.io.gunzip(u8) : u8;
  }

  function decodeTracts(u8, name) {
    const magic = String.fromCharCode(u8[0], u8[1], u8[2], u8[3]);
    if (magic !== "DBA1") throw new Error(`${name}: not a DBA1 tract file.`);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const hn = dv.getUint32(4, true);
    const head = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + hn)));
    const n = head.streamlines, np = head.points, s = head.scale;
    let at = 8 + hn;
    const counts = new Uint16Array(u8.slice(at, at + 2 * n).buffer); at += 2 * n;
    const first = new Int16Array(u8.slice(at, at + 6 * n).buffer); at += 6 * n;
    const steps = new Int8Array(u8.buffer, u8.byteOffset + at, 3 * (np - n));
    const positions = new Float32Array(np * 3), offsets = new Uint32Array(n + 1);
    let p = 0, q = 0;
    for (let k = 0; k < n; k++) {
      offsets[k] = p;
      let x = first[k * 3], y = first[k * 3 + 1], z = first[k * 3 + 2];
      positions[p * 3] = x * s; positions[p * 3 + 1] = y * s; positions[p * 3 + 2] = z * s; p++;
      for (let i = 1; i < counts[k]; i++, p++, q += 3) {
        x += steps[q]; y += steps[q + 1]; z += steps[q + 2];
        positions[p * 3] = x * s; positions[p * 3 + 1] = y * s; positions[p * 3 + 2] = z * s;
      }
    }
    offsets[n] = p;
    return { positions, offsets, head };
  }

  /** Positions moved by a 4x4 (row-major, RAS): a new array. */
  function transform(positions, m) {
    const out = new Float32Array(positions.length);
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i], y = positions[i + 1], z = positions[i + 2];
      out[i] = m[0][0] * x + m[0][1] * y + m[0][2] * z + m[0][3];
      out[i + 1] = m[1][0] * x + m[1][1] * y + m[1][2] * z + m[1][3];
      out[i + 2] = m[2][0] * x + m[2][1] * y + m[2][2] * z + m[2][3];
    }
    return out;
  }
  const isIdentity = (m) => m.every((row, i) => row.every((v, j) => Math.abs(v - (i === j ? 1 : 0)) < 1e-9));

  /** measures.csv -> { subject: { id: { volume_cm3, count, by_class } } }. */
  function parseMeasures(text) {
    const out = {};
    for (const line of text.trim().split(/\r?\n/).slice(1)) {
      const [sid, id, vol, count, ...cls] = line.split(",");
      (out[sid] = out[sid] || {})[id] = { volume_cm3: +vol, count: +count, by_class: cls.map(Number) };
    }
    return out;
  }

  /** The manifest, the measures and every subject's tracts, native
   *  segmentation and head; progress(text) as they come. */
  async function load(baseUrl, progress) {
    const base = new URL(baseUrl, location.href);
    const url = (rel) => new URL(rel, base).href;
    const r = await fetch(url("manifest.json"), { cache: "no-cache" });
    if (!r.ok) throw new Error(`The demo's data (data/manifest.json): HTTP ${r.status}. Run prep/build_data.py first.`);
    const man = await r.json();
    const text = async (rel) => new TextDecoder().decode(await bytes(url(rel)));
    const [labels, meas] = await Promise.all([text(man.labels), text(man.measures)]);
    const table = Med.labels.parseTable(labels), measures = parseMeasures(meas);
    const subjects = [];
    for (const s of man.subjects) {
      progress(`Loading ${s.id}…`);
      const f = s.files;
      const [tr, segN, head] = await Promise.all([bytes(url(f.tracts)), bytes(url(f.seg_native)), bytes(url(f.head))]);
      subjects.push({
        ...s, base, tracts: decodeTracts(tr, f.tracts), measures: measures[s.id] || {},
        segNative: Med.nifti.parse(segN, f.seg_native),
        head: Med.vtk.parse(head, f.head), identity: isIdentity(s.native_to_common),
      });
    }
    return { man, table, subjects };
  }

  /** The display volumes (segmentation, T1, T2 on the common grid) into each subject. */
  async function loadSlices(subjects) {
    await Promise.all(subjects.map(async (s) => {
      const f = s.files, get = (rel) => bytes(new URL(rel, s.base).href);
      const [seg, t1, t2] = await Promise.all([get(f.seg), get(f.t1), get(f.t2)]);
      s.seg = Med.nifti.parse(seg, f.seg); s.t1 = Med.nifti.parse(t1, f.t1); s.t2 = Med.nifti.parse(t2, f.t2);
    }));
  }

  DBA.data = { load, loadSlices, decodeTracts, transform };
})();
