/* ============================================================================
 * common/med/io_dicom.js — DICOM series -> a volume
 * ----------------------------------------------------------------------------
 * scan(files)   parses every file (common/vendor/dicomParser.min.js), skips what
 *               is not an image (DICOMDIR, reports, stray files) and groups
 *               the rest into series: same SeriesInstanceUID, matrix and
 *               orientation (a localizer in the same series is split off).
 * build(series) sorts the slices along the slice normal by their position
 *               (ImagePositionPatient), not by instance number, and builds
 *               the affine from position, orientation and pixel spacing.
 *               The slice step is (last − first) / (n − 1), so a tilted CT
 *               gantry comes out sheared rather than squashed.
 *
 * DICOM's patient frame is LPS; the affine is flipped to RAS like the other
 * readers. Enhanced (multi-frame) files are read frame by frame from their
 * functional groups. Several images at one position (echoes, phases) become
 * frames when every position has the same number of them.
 *
 * build() also writes the series' sidecar (sidecar()): the acquisition
 * fields dcm2niix puts in its JSON, named as it names them, with nothing that
 * identifies the patient (no name, IDs, birth date, dates or institution).
 *
 * Pixel data must be uncompressed (implicit/explicit VR, little or big
 * endian): decoding JPEG, JPEG 2000 or RLE in the browser needs codecs this
 * widget does not carry, so those files are refused with their syntax named.
 * ========================================================================== */
(function () {
  "use strict";
  const Med = (window.Med = window.Med || {});

  const UNCOMPRESSED = {
    "1.2.840.10008.1.2": "Implicit VR Little Endian",
    "1.2.840.10008.1.2.1": "Explicit VR Little Endian",
    "1.2.840.10008.1.2.2": "Explicit VR Big Endian",
  };
  const COMPRESSED = {
    "1.2.840.10008.1.2.1.99": "Deflated Explicit VR",
    "1.2.840.10008.1.2.4.50": "JPEG Baseline", "1.2.840.10008.1.2.4.51": "JPEG Extended",
    "1.2.840.10008.1.2.4.57": "JPEG Lossless", "1.2.840.10008.1.2.4.70": "JPEG Lossless SV1",
    "1.2.840.10008.1.2.4.80": "JPEG-LS Lossless", "1.2.840.10008.1.2.4.81": "JPEG-LS Near-lossless",
    "1.2.840.10008.1.2.4.90": "JPEG 2000 Lossless", "1.2.840.10008.1.2.4.91": "JPEG 2000",
    "1.2.840.10008.1.2.4.201": "HTJ2K Lossless", "1.2.840.10008.1.2.4.203": "HTJ2K",
    "1.2.840.10008.1.2.5": "RLE Lossless",
  };

  const parseDataSet = (u8) => {
    try { return dicomParser.parseDicom(u8); }
    catch (e) {
      // An old file without the 128-byte preamble and "DICM": read it as
      // implicit VR little endian, the only syntax such files can have.
      if (!/DICM/.test(String(e && (e.exception || e.message || e)))) return null;
      try { return dicomParser.parseDicom(u8, { TransferSyntaxUID: "1.2.840.10008.1.2" }); }
      catch (e2) { return null; }
    }
  };

  const nums = (s) => (s ? String(s).split("\\").map(Number).filter(Number.isFinite) : []);
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  /** An attribute of frame f of a multi-frame file: per-frame group, else
   *  shared group, else the top level. */
  function frameAttr(ds, f, seqTag, tag) {
    for (const gTag of ["x52009230", "x52009229"]) {
      const groups = ds.elements[gTag];
      if (!groups || !groups.items || !groups.items.length) continue;
      const item = groups.items[gTag === "x52009230" ? f : 0];
      const seq = item && item.dataSet.elements[seqTag];
      const inner = seq && seq.items && seq.items[0] && seq.items[0].dataSet;
      if (inner && inner.elements[tag]) return inner.string(tag);
    }
    return ds.string(tag);
  }

  // --- Scan ---------------------------------------------------------------------
  async function scan(files, progress) {
    const groups = new Map();
    let skipped = 0, compressed = null;
    for (let n = 0; n < files.length; n++) {
      if (progress && n % 40 === 0) { progress(`Reading DICOM ${n + 1} / ${files.length}…`); await Med.tick(); }
      const f = files[n];
      const u8 = new Uint8Array(await f.arrayBuffer());
      const ds = parseDataSet(u8);
      const pixel = ds && (ds.elements.x7fe00010 || ds.elements.x7fe00008 || ds.elements.x7fe00009);
      if (!ds || !pixel || !ds.uint16("x00280010")) { skipped++; continue; }
      const ts = ds.string("x00020010") || "1.2.840.10008.1.2";
      if (!UNCOMPRESSED[ts]) { compressed = COMPRESSED[ts] || ts; skipped++; continue; }
      const rows = ds.uint16("x00280010"), cols = ds.uint16("x00280011");
      const frames = ds.intString("x00280008") || 1;
      const uid = ds.string("x0020000e") || "(no series UID)";
      const iop = nums(frames > 1 ? frameAttr(ds, 0, "x00209116", "x00200037") : ds.string("x00200037"));
      const key = frames > 1 ? `${uid}|${ds.string("x00080018") || f.name}`
                             : `${uid}|${rows}x${cols}|${iop.map((v) => v.toFixed(2)).join(",")}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          key, uid, rows, cols, multiframe: frames > 1, items: [],
          number: ds.intString("x00200011"),
          description: ds.string("x0008103e") || "",
          modality: ds.string("x00080060") || "",
        };
        groups.set(key, g);
      }
      g.items.push({ ds, u8, name: f.relPath || f.name, ts, frames });
    }
    const list = Array.from(groups.values()).map((g) => {
      g.count = g.multiframe ? g.items.reduce((s, it) => s + it.frames, 0) : g.items.length;
      g.label = [g.modality, g.number != null ? `#${g.number}` : "", g.description || "(no description)",
                 `${g.cols}×${g.rows}×${g.count}`].filter(Boolean).join(" · ");
      return g;
    }).sort((a, b) => b.count - a.count);
    if (!list.length) {
      if (compressed) throw new Error(`The DICOM pixel data is compressed (${compressed}); only uncompressed DICOM can be read here. Decompress it first, e.g. "gdcmconv --raw" or "dcmdjpeg".`);
      throw new Error(`No DICOM image among the ${files.length} file(s).`);
    }
    list.skipped = skipped;
    list.compressed = compressed;
    return list;
  }

  // --- Build ----------------------------------------------------------------------
  function pixelType(ds) {
    const bits = ds.uint16("x00280100"), signed = ds.uint16("x00280103") === 1;
    if (ds.elements.x7fe00008) return "float32";
    if (ds.elements.x7fe00009) return "float64";
    if (bits === 8) return signed ? "int8" : "uint8";
    if (bits === 16) return signed ? "int16" : "uint16";
    if (bits === 32) return signed ? "int32" : "uint32";
    throw new Error(`${bits}-bit DICOM pixels are not supported.`);
  }

  /** One entry per 2-D image: its file, frame, position and rescale. */
  function slicesOf(series) {
    const out = [];
    for (const it of series.items) {
      const ds = it.ds;
      for (let f = 0; f < it.frames; f++) {
        const mf = it.frames > 1;
        const get = (seq, tag) => (mf ? frameAttr(ds, f, seq, tag) : ds.string(tag));
        out.push({
          it, f,
          ipp: nums(get("x00209113", "x00200032")),
          iop: nums(get("x00209116", "x00200037")),
          spacing: nums(get("x00289110", "x00280030")).length ? nums(get("x00289110", "x00280030"))
                                                             : nums(ds.string("x00181164")),
          thick: parseFloat(get("x00289110", "x00180050")),
          slope: parseFloat(get("x00289145", "x00281053")),
          inter: parseFloat(get("x00289145", "x00281052")),
          inst: (mf ? f : ds.intString("x00200013")) || 0,
        });
      }
    }
    return out;
  }

  function build(series) {
    const notes = [];
    const first = series.items[0].ds;
    const rows = series.rows, cols = series.cols;
    if ((first.uint16("x00280002") || 1) !== 1)
      throw new Error(`Colour DICOM (${first.string("x00280004")}) is not supported; greyscale only.`);
    const type = pixelType(first);
    let slices = slicesOf(series);

    // Orientation and the slice normal.
    let iop = slices[0].iop;
    if (iop.length !== 6) { iop = [1, 0, 0, 0, 1, 0]; notes.push("No ImageOrientationPatient: shown as axial."); }
    const rowCos = iop.slice(0, 3), colCos = iop.slice(3, 6), normal = cross(rowCos, colCos);
    const havePos = slices.every((s) => s.ipp.length === 3);
    if (havePos) {
      slices.forEach((s) => { s.d = dot(s.ipp, normal); });
      slices.sort((a, b) => a.d - b.d || a.inst - b.inst);
    } else {
      slices.sort((a, b) => a.inst - b.inst);
      notes.push("No ImagePositionPatient: slices ordered by instance number.");
    }

    // Images sharing a position: frames when every position has as many.
    let frames = 1;
    if (havePos) {
      const pos = [];
      for (const s of slices) {
        const last = pos[pos.length - 1];
        if (last && Math.abs(s.d - last[0].d) < 1e-3) last.push(s); else pos.push([s]);
      }
      if (pos.length < slices.length) {
        const m = pos[0].length;
        if (pos.every((p) => p.length === m)) {
          frames = m;
          pos.forEach((p) => p.sort((a, b) => a.inst - b.inst));
          // Frame-major: frame 0 of every position, then frame 1, ...
          slices = [];
          for (let t = 0; t < m; t++) pos.forEach((p) => slices.push(p[t]));
          notes.push(`${m} images at each position: shown as ${m} frames (by instance number).`);
        } else {
          slices = pos.map((p) => p[0]);
          notes.push("Some positions hold more than one image; the first of each is shown.");
        }
      }
    }
    const nz = slices.length / frames;
    const stack = slices.slice(0, nz);

    // Affine (LPS), then RAS.
    const ps = stack[0].spacing.length >= 2 ? stack[0].spacing : [1, 1];
    if (stack[0].spacing.length < 2) notes.push("No PixelSpacing: 1 mm assumed.");
    let kvec;
    if (havePos && nz > 1) {
      const a = stack[0].ipp, b = stack[nz - 1].ipp;
      kvec = [0, 1, 2].map((d) => (b[d] - a[d]) / (nz - 1));
      const gaps = stack.slice(1).map((s, i) => s.d - stack[i].d);
      const lo = Math.min(...gaps), hi = Math.max(...gaps);
      if (hi - lo > 0.01 * Math.abs(hi) + 1e-3)
        notes.push(`Uneven slice spacing (${lo.toFixed(2)}–${hi.toFixed(2)} mm): shown at the mean, ${(dot(kvec, normal)).toFixed(2)} mm.`);
      const tilt = Math.acos(Math.min(1, Math.abs(dot(kvec, normal)) / Math.hypot(...kvec))) * 180 / Math.PI;
      if (tilt > 0.5) notes.push(`The slices are sheared by ${tilt.toFixed(1)}° (gantry tilt); the geometry keeps it.`);
    } else {
      const step = parseFloat(first.string("x00180088")) || stack[0].thick || 1;
      kvec = normal.map((v) => v * step);
    }
    const o = havePos ? stack[0].ipp : [0, 0, 0];
    const lps = [
      rowCos[0] * ps[1], colCos[0] * ps[0], kvec[0], o[0],
      rowCos[1] * ps[1], colCos[1] * ps[0], kvec[1], o[1],
      rowCos[2] * ps[1], colCos[2] * ps[0], kvec[2], o[2],
      0, 0, 0, 1,
    ];
    const affine = lps.map((v, i) => (i < 8 ? -v : v));
    affine[12] = affine[13] = affine[14] = 0;
    affine[15] = 1;

    // Pixels.
    const perFrame = rows * cols;
    const sizes = { int8: 1, uint8: 1, int16: 2, uint16: 2, int32: 4, uint32: 4, float32: 4, float64: 8 };
    const Ctor = { int8: Int8Array, uint8: Uint8Array, int16: Int16Array, uint16: Uint16Array,
                   int32: Int32Array, uint32: Uint32Array, float32: Float32Array, float64: Float64Array }[type];
    let data = new Ctor(perFrame * slices.length);
    const bitsStored = first.uint16("x00280101") || sizes[type] * 8;
    const signed = /^int/.test(type);
    slices.forEach((s, n) => {
      const ds = s.it.ds;
      const el = ds.elements.x7fe00010 || ds.elements.x7fe00008 || ds.elements.x7fe00009;
      if (el.encapsulatedPixelData) throw new Error(`${s.it.name}: encapsulated (compressed) pixel data.`);
      const le = s.it.ts !== "1.2.840.10008.1.2.2";
      const arr = Med.io.typedArray(s.it.u8, el.dataOffset + s.f * perFrame * sizes[type], perFrame, type, le);
      data.set(arr, n * perFrame);
    });
    // Bits above BitsStored: garbage (overlays) when unsigned, the sign when
    // signed -- extend it, as a 12-bit signed CT stored in 16 bits needs.
    if (bitsStored < sizes[type] * 8 && !/^float/.test(type)) {
      const shift = 32 - bitsStored, mask = (2 ** bitsStored) - 1;
      for (let i = 0; i < data.length; i++) data[i] = signed ? (data[i] << shift) >> shift : data[i] & mask;
    }

    // Rescale: one slope/intercept for the volume, or applied per slice.
    const sl = slices.map((s) => (Number.isFinite(s.slope) && s.slope !== 0 ? s.slope : 1));
    const ic = slices.map((s) => (Number.isFinite(s.inter) ? s.inter : 0));
    let slope = sl[0], inter = ic[0];
    if (sl.some((v) => v !== slope) || ic.some((v) => v !== inter)) {
      const f32 = new Float32Array(data.length);
      slices.forEach((s, n) => {
        for (let i = n * perFrame, e = i + perFrame; i < e; i++) f32[i] = data[i] * sl[n] + ic[n];
      });
      data = f32;
      slope = 1; inter = 0;
      notes.push("The rescale slope/intercept varies by slice: applied per slice.");
    }

    const photometric = first.string("x00280004") || "";
    const wc = nums(first.string("x00281050"))[0], ww = nums(first.string("x00281051"))[0];
    const date = first.string("x00080020") || "";
    const meta = {
      Format: "DICOM",
      Modality: series.modality || "—",
      Series: [series.number != null ? `#${series.number}` : "", series.description].filter(Boolean).join(" ") || "—",
      Patient: [first.string("x00100010"), first.string("x00100020")].filter(Boolean).join(" · ") || "—",
      "Study date": date.length === 8 ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}` : date || "—",
      Scanner: [first.string("x00080070"), first.string("x00081090")].filter(Boolean).join(" ") || "—",
      "Data type": `${type}, ${bitsStored} bits stored` + (slope !== 1 || inter !== 0 ? ` (× ${slope} + ${inter})` : ""),
      Encoding: UNCOMPRESSED[series.items[0].ts],
      Images: `${slices.length} from ${series.items.length} file(s)`,
    };
    if (frames > 1) meta.Frames = String(frames);
    const name = series.description || series.modality || "DICOM series";
    const vol = new Med.Volume({ name, format: "DICOM", dims: [cols, rows, nz], frames, data, slope, inter,
                                affine, dtype: type, meta, notes });
    vol.invert = photometric === "MONOCHROME1";
    if (Number.isFinite(wc) && Number.isFinite(ww) && ww > 0) vol.dicomWindow = [wc - ww / 2, wc + ww / 2];
    vol.modality = series.modality;
    vol.sidecar = sidecar(first, series, stack, frames);
    return vol;
  }

  /** The anonymised acquisition fields of a series (dcm2niix's JSON names;
   *  times in seconds as there). Missing fields are left out. */
  function sidecar(ds, series, stack, frames) {
    const str = (tag) => { const v = ds.string(tag); return v ? v.trim() : undefined; };
    const num = (tag) => { const v = parseFloat(ds.string(tag)); return Number.isFinite(v) ? v : undefined; };
    const sec = (tag) => { const v = num(tag); return v === undefined ? undefined : +(v / 1000).toPrecision(6); };
    // Enhanced MR keeps TE in a functional group.
    const te = sec("x00180081") ?? (() => {
      const v = parseFloat(frameAttr(ds, 0, "x00189114", "x00189082"));
      return Number.isFinite(v) ? +(v / 1000).toPrecision(6) : undefined;
    })();
    const imageType = str("x00080008");
    const out = {
      Modality: series.modality || str("x00080060"),
      MagneticFieldStrength: num("x00180087"),
      Manufacturer: str("x00080070"),
      ManufacturersModelName: str("x00081090"),
      BodyPartExamined: str("x00180015"),
      SeriesDescription: series.description || undefined,
      ProtocolName: str("x00181030"),
      ScanningSequence: str("x00180020"),
      SequenceVariant: str("x00180021"),
      ScanOptions: str("x00180022"),
      SequenceName: str("x00180024"),
      ImageType: imageType ? imageType.split("\\") : undefined,
      SeriesNumber: series.number ?? undefined,
      SliceThickness: num("x00180050"),
      SpacingBetweenSlices: num("x00180088"),
      EchoTime: te,
      RepetitionTime: sec("x00180080"),
      InversionTime: sec("x00180082"),
      FlipAngle: num("x00181314"),
      ImagesPerPosition: frames > 1 ? frames : undefined,
      ConversionSoftware: "MRI WLAB DICOM to NIfTI (browser)",
    };
    for (const k of Object.keys(out)) if (out[k] === undefined || out[k] === "") delete out[k];
    return out;
  }

  Med.dicom = { scan, build };
})();
