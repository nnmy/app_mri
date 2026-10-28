/* ============================================================================
 * common/med/io.js — reading files: what the readers share
 * ----------------------------------------------------------------------------
 * gzip in and out (read by its magic bytes, not the file name), typed arrays from a byte
 * range in either byte order, and which reader a set of files goes to:
 *   *.nii, *.nii.gz            -> io_nifti.js
 *   *.nrrd, *.seg.nrrd         -> io_nrrd.js
 *   anything else              -> io_dicom.js (a series is many files,
 *                                 often without an extension)
 * ========================================================================== */
(function () {
  "use strict";
  const Med = (window.Med = window.Med || {});

  const isGzip = (u8) => u8.length > 2 && u8[0] === 0x1f && u8[1] === 0x8b;

  async function gunzip(u8) {
    if (typeof DecompressionStream === "undefined")
      throw new Error("This browser cannot unpack .gz files (no DecompressionStream). Use a current browser, or unpack the file first.");
    const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function gzip(u8) {
    if (typeof CompressionStream === "undefined")
      throw new Error("This browser cannot write .gz files (no CompressionStream). Use a current browser.");
    const stream = new Blob([u8]).stream().pipeThrough(new CompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** The file's bytes, unpacked when gzipped. */
  async function readBytes(file) {
    const u8 = new Uint8Array(await file.arrayBuffer());
    return isGzip(u8) ? gunzip(u8) : u8;
  }

  const TYPES = {
    int8: [Int8Array, 1], uint8: [Uint8Array, 1], int16: [Int16Array, 2], uint16: [Uint16Array, 2],
    int32: [Int32Array, 4], uint32: [Uint32Array, 4], float32: [Float32Array, 4], float64: [Float64Array, 8],
    int64: [BigInt64Array, 8], uint64: [BigUint64Array, 8],
  };
  const LITTLE_ENDIAN_HOST = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

  /**
   * `count` values of `type` starting at byte `offset` of `u8`, in the
   * file's byte order, as a fresh (aligned) typed array. 64-bit integers
   * become Float64Array: no viewer needs more than 2^53.
   */
  function typedArray(u8, offset, count, type, littleEndian) {
    const spec = TYPES[type];
    if (!spec) throw new Error(`Unsupported data type: ${type}`);
    const [Ctor, size] = spec;
    const bytes = count * size;
    if (offset + bytes > u8.length)
      throw new Error(`The file is truncated: ${u8.length - offset} bytes of data for ${count} values of ${type}.`);
    const copy = u8.slice(offset, offset + bytes);
    if (size > 1 && littleEndian !== LITTLE_ENDIAN_HOST) {
      for (let i = 0; i < bytes; i += size)
        for (let a = i, b = i + size - 1; a < b; a++, b--) { const t = copy[a]; copy[a] = copy[b]; copy[b] = t; }
    }
    const arr = new Ctor(copy.buffer);
    if (type === "int64" || type === "uint64") return Float64Array.from(arr, Number);
    return arr;
  }

  const lower = (f) => (f.name || "").toLowerCase();
  const kindOf = (f) => {
    const n = lower(f);
    if (/\.nii(\.gz)?$/.test(n)) return "nifti";
    if (/\.nrrd$/.test(n)) return "nrrd";
    if (/\.nhdr$/.test(n)) return "nhdr";
    if (/\.(hdr|img)(\.gz)?$/.test(n)) return "analyze";
    return "other";
  };

  /** One volume file (NIfTI or NRRD) -> Med.Volume. */
  async function readVolumeFile(file) {
    const kind = kindOf(file);
    if (kind === "nhdr")
      throw new Error(`${file.name}: a detached NRRD header. Save it as a single .nrrd file (header and data together).`);
    if (kind === "analyze")
      throw new Error(`${file.name}: an Analyze/NIfTI pair (.hdr/.img). Convert it to a single .nii(.gz).`);
    const bytes = await readBytes(file);
    if (kind === "nrrd" || Med.nrrd.sniff(bytes)) return Med.nrrd.parse(bytes, file.name);
    if (kind === "nifti" || Med.nifti.sniff(bytes)) return Med.nifti.parse(bytes, file.name);
    throw new Error(`${file.name}: not a NIfTI or NRRD file.`);
  }

  /**
   * The image input: one NIfTI/NRRD file, or the files of DICOM series.
   * Returns { volume } or { series: [...] } (DICOM; io_dicom.js builds the
   * chosen one).
   */
  async function readImageFiles(files, progress) {
    const vols = files.filter((f) => ["nifti", "nrrd", "nhdr", "analyze"].includes(kindOf(f)));
    if (vols.length) {
      if (vols.length > 1) progress && progress(`Several volume files: opening ${vols[0].name}.`);
      return { volume: await readVolumeFile(vols[0]) };
    }
    return { series: await Med.dicom.scan(files, progress) };
  }

  const stem = (name) => String(name || "").replace(/\.(nii\.gz|nii|seg\.nrrd|nrrd|gz|dcm)$/i, "");

  // Yield to the browser between chunks of a long read, so the page repaints.
  Med.tick = () => new Promise((r) => setTimeout(r, 0));

  Object.assign(Med, { io: { isGzip, gunzip, gzip, readBytes, typedArray, kindOf, readVolumeFile, readImageFiles, stem } });
})();
