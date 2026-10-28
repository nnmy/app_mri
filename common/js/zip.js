/* ============================================================================
 * common/js/zip.js — a .zip of several outputs (window.Viz.zip)
 * ----------------------------------------------------------------------------
 * Stored, not deflated: the outputs it bundles are .nii.gz and PNG, already
 * compressed, so deflating again only costs time. UTF-8 names, no folders.
 *
 *   const blob = Viz.zip([{ name: "a.nii.gz", data: Uint8Array }, …]);
 *
 * And back: Viz.unzip(file) -> the files inside, as File objects (stored or
 * deflated members; no ZIP64, no encryption). A DICOM study often comes
 * zipped.
 * ========================================================================== */
(function () {
  "use strict";
  const Viz = (window.Viz = window.Viz || {});

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(u8) {
    let c = 0xffffffff;
    for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function zip(entries) {
    const enc = new TextEncoder();
    const now = new Date();
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [], central = [];
    let offset = 0;
    for (const e of entries) {
      const name = enc.encode(e.name);
      const data = e.data instanceof Uint8Array ? e.data : new Uint8Array(e.data);
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);              // version needed
      local.setUint16(6, 0x0800, true);          // UTF-8 names
      local.setUint16(8, 0, true);               // stored
      local.setUint16(10, time, true);
      local.setUint16(12, date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true);
      parts.push(local.buffer, name, data);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true);
      cen.setUint16(4, 20, true);
      cen.setUint16(6, 20, true);
      cen.setUint16(8, 0x0800, true);
      cen.setUint16(12, time, true);
      cen.setUint16(14, date, true);
      cen.setUint32(16, crc, true);
      cen.setUint32(20, data.length, true);
      cen.setUint32(24, data.length, true);
      cen.setUint16(28, name.length, true);
      cen.setUint32(42, offset, true);
      central.push(cen.buffer, name);
      offset += 30 + name.length + data.length;
    }
    const size = central.reduce((s, b) => s + b.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, size, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end.buffer], { type: "application/zip" });
  }

  async function inflate(u8) {
    if (typeof DecompressionStream === "undefined")
      throw new Error("This browser cannot unpack .zip files (no DecompressionStream). Unpack it first.");
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  const isZip = (u8) => u8.length >= 4 && u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04;

  /** The members of a .zip (folders skipped), as Files named by their path. */
  async function unzip(file) {
    const u8 = new Uint8Array(await file.arrayBuffer());
    const dv = new DataView(u8.buffer);
    let end = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--)
      if (dv.getUint32(i, true) === 0x06054b50) { end = i; break; }
    if (end < 0) throw new Error(`${file.name}: not a zip file (no central directory).`);
    const count = dv.getUint16(end + 10, true);
    let at = dv.getUint32(end + 16, true);
    if (at === 0xffffffff) throw new Error(`${file.name}: a ZIP64 archive; unpack it first.`);
    const dec = new TextDecoder();
    const out = [];
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(at, true) !== 0x02014b50) throw new Error(`${file.name}: damaged central directory.`);
      const flags = dv.getUint16(at + 8, true), method = dv.getUint16(at + 10, true);
      const csize = dv.getUint32(at + 20, true);
      const nlen = dv.getUint16(at + 28, true), xlen = dv.getUint16(at + 30, true), clen = dv.getUint16(at + 32, true);
      const local = dv.getUint32(at + 42, true);
      const name = dec.decode(u8.subarray(at + 46, at + 46 + nlen));
      at += 46 + nlen + xlen + clen;
      if (name.endsWith("/")) continue;
      if (flags & 1) throw new Error(`${file.name}: encrypted members are not supported.`);
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const raw = u8.subarray(start, start + csize);
      let data;
      if (method === 0) data = raw.slice();
      else if (method === 8) data = await inflate(raw);
      else throw new Error(`${file.name}: ${name} uses compression method ${method}.`);
      const f = new File([data], name.split("/").pop());
      try { Object.defineProperty(f, "relPath", { value: name }); } catch (e) { /* frozen */ }
      out.push(f);
    }
    return out;
  }

  Viz.zip = zip;
  Viz.unzip = unzip;
  Viz.isZip = isZip;
})();
