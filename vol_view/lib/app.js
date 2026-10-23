/* ============================================================================
 * vol_view/lib/app.js — the page: inputs, viewer, segments, export
 * ----------------------------------------------------------------------------
 * State lives in S; every change ends in rebuild() (new files: a new grid,
 * new segment statistics) or draw() (anything else: one slice, re-sampled).
 *
 * Inputs, any combination:
 *   image          DICOM files / a folder of them, or one NIfTI / NRRD
 *   segmentation   NIfTI or NRRD label map (Slicer .seg.nrrd: with names)
 *   label names    an optional table naming and colouring the labels
 * With both, the viewer shows the image beside the labels over it; each
 * meets the other in world space (common/med/volume.js). A segmentation saved without
 * a proper header (same matrix as the image, different affine) can be
 * matched by voxel index instead.
 *
 * Slices are always drawn neurological (the subject's left on the left).
 * ========================================================================== */
(function () {
  "use strict";
  const { ui } = Viz;
  const { esc, fmt } = ui;
  const $ = (id) => document.getElementById(id);

  const S = {
    image: null, seg: null, segShown: null, series: null, table: null,
    grid: null, stats: null, segs: [], segById: new Map(), visible: new Set(), focus: null, lk: null,
    plane: "axial", k: {},
    range: "p99", bright: 0, contrast: 0, cmap: "gray", lutTable: Med.render.lut("gray", false),
    gridEdited: false,
    alpha: 0.45, mode: "fill", imgStats: null, profiles: {}, matchIndex: false,
    alignNotes: [], fileNotes: [], cur: null,
  };

  const status = (text, kind) => ui.status($("status"), text, kind);
  async function guarded(text, fn) {
    status(text, "busy");
    await ui.busy();
    try { await fn(); }
    catch (e) {
      console.error(e);
      status(e && e.message ? e.message : String(e), "err");
    }
  }

  // ==========================================================================
  // Inputs
  // ==========================================================================
  const dropImage = ui.dropZone($("drop-image"), {
    title: "Image", sub: "DICOM files or folder · NIfTI · NRRD", multiple: true, directory: true, required: true,
    tip: "A DICOM series (drop the files or their folder), or one NIfTI (.nii, .nii.gz) or NRRD file. " +
         "Uncompressed DICOM only.",
    onFiles: loadImage,
    onClear() {
      S.image = null; S.series = null; S.fileNotes = [];
      $("series-row").classList.add("hidden");
      rebuild({ resetSlices: true });
      status("");
    },
  });
  const dropSeg = ui.dropZone($("drop-seg"), {
    title: "Segmentation", sub: "NIfTI · NRRD (.seg.nrrd)", accept: ".nii,.gz,.nrrd",
    tip: "A label map: one integer per voxel, 0 = background. From 3D Slicer (.seg.nrrd) the segment " +
         "names and colours come along.",
    onFiles: loadSeg,
    onClear() { S.seg = null; S.matchIndex = false; $("match-index").checked = false; rebuild({}); status(""); },
  });
  const dropLut = ui.dropZone($("drop-lut"), {
    title: "Label names", sub: "optional · CSV / ITK-SNAP / LUT", accept: ".csv,.tsv,.txt,.ctbl,.lut,.label",
    tip: "Names (and colours) for the label ids: CSV rows “id,name[,r,g,b]”, an ITK-SNAP label " +
         "description file, or a FreeSurfer / 3D Slicer colour table.",
    onFiles: loadTable,
    onClear() { S.table = null; rebuild({}); },
  });

  async function loadImage(files) {
    await guarded(`Reading ${files.length} file(s)…`, async () => {
      const res = await Med.io.readImageFiles(files, (t) => status(t, "busy"));
      S.fileNotes = [];
      if (res.volume) {
        S.series = null;
        $("series-row").classList.add("hidden");
        setImage(res.volume);
        dropImage.setInfo(res.volume.name);
      } else {
        S.series = res.series;
        const sel = $("series");
        sel.innerHTML = res.series.map((s, i) => `<option value="${i}">${esc(s.label)}</option>`).join("");
        $("series-row").classList.toggle("hidden", res.series.length < 2);
        if (res.series.skipped) {
          S.fileNotes.push(`${res.series.skipped} file(s) skipped (not an image` +
                           (res.series.compressed ? `, or compressed: ${res.series.compressed}` : "") + ").");
        }
        dropImage.setInfo(`${files.length} file(s) · ${res.series.length} series`);
        buildSeries(0);
      }
    });
  }

  function buildSeries(i) {
    const vol = Med.dicom.build(S.series[i]);
    setImage(vol);
  }

  function setImage(vol) {
    S.image = vol;
    S.imgStats = Med.stats(vol);
    S.profiles = {};
    // MONOCHROME1 DICOM stores white as low values: its grey map runs backwards.
    S.lutTable = Med.render.lut(S.cmap, !!vol.invert);
    $("mx-title").value = Med.io.stem(vol.name);
    rebuild({ resetSlices: true });
    status(`Loaded ${vol.name}: ${vol.dims.join(" × ")}${vol.frames > 1 ? ` × ${vol.frames}` : ""}.`, "ok");
  }

  async function loadSeg(files) {
    const file = files[0];
    await guarded(`Reading ${file.name}…`, async () => {
      const vol = await Med.io.readVolumeFile(file);
      // A label map holds a modest number of integer values.
      const sample = Med.sample(vol, 1e6);
      const uniq = new Set();
      let fractional = false;
      for (let i = 0; i < sample.length && uniq.size <= 5000; i++) {
        if (sample[i] % 1) fractional = true;
        uniq.add(Math.round(sample[i]));
      }
      if (uniq.size > 5000)
        throw new Error(`${file.name} has over 5,000 distinct values: an image, not a segmentation? Put it in the Image box.`);
      if (fractional) vol.notes.push("Non-integer values: rounded to the nearest label.");
      if (vol.frames > 1) vol.notes.push(`A ${vol.frames}-frame file: frame 1 is used as the label map.`);
      S.seg = vol;
      S.matchIndex = false;
      $("match-index").checked = false;
      dropSeg.setInfo(file.name);
      rebuild({ resetSlices: true });
      status(`Loaded ${file.name}: ${S.segs.length} segment(s).`, "ok");
    });
  }

  async function loadTable(files) {
    await guarded(`Reading ${files[0].name}…`, async () => {
      S.table = Med.labels.parseTable(await files[0].text());
      dropLut.setInfo(`${files[0].name} · ${S.table.size} labels`);
      rebuild({});
      status(`Label names from ${files[0].name}.`, "ok");
    });
  }

  $("series").addEventListener("change", (e) =>
    guarded("Building the series…", async () => buildSeries(+e.target.value)));
  $("btn-folder").addEventListener("click", () => dropImage.pickFolder());
  // ==========================================================================
  // Rebuild: grid, alignment, segment statistics
  // ==========================================================================
  function align() {
    S.alignNotes = [];
    S.segShown = S.seg;
    const row = $("match-row");
    row.classList.add("hidden");
    if (!S.seg || !S.image) return;
    const a = S.image, b = S.seg;
    const sameDims = a.dims.every((n, i) => n === b.dims[i]);
    const diff = Math.max(...a.affine.map((v, i) => Math.abs(v - b.affine[i])));
    const [alo, ahi] = a.bounds(), [blo, bhi] = b.bounds();
    const overlap = [0, 1, 2].every((d) => Math.min(ahi[d], bhi[d]) - Math.max(alo[d], blo[d]) > 0);
    // Different affines can still place both in one box: a DICOM series
    // stacked feet-first and its NRRD segmentation, say. Only a box that
    // moved means the headers disagree.
    const apart = Math.max(...[0, 1, 2].map((d) => Math.max(Math.abs(alo[d] - blo[d]), Math.abs(ahi[d] - bhi[d]))));
    if (sameDims && diff > 1e-3) {
      row.classList.remove("hidden");
      $("match-why").textContent = apart < 0.05 ? "Same matrix and the same box in world space."
                                                : `Same matrix, placed up to ${apart.toFixed(1)} mm apart.`;
    }
    if (!overlap)
      S.alignNotes.push("The segmentation and the image do not overlap in world space: their headers disagree." +
                        (sameDims ? " They have the same matrix: try “Match the image by voxel index”." : ""));
    else if (sameDims && apart >= 0.05 && !S.matchIndex)
      S.alignNotes.push(`The segmentation has the image's matrix but lies up to ${apart.toFixed(1)} mm away; ` +
                        "it is placed by its own header.");
    if (S.matchIndex && sameDims) {
      S.segShown = new Med.Volume({ ...b, dims: b.dims, affine: a.affine, notes: [], meta: b.meta });
      S.alignNotes.push("Segmentation matched to the image by voxel index (its own header is ignored).");
    }
  }

  function rebuild(opts) {
    if (!S.image && !S.seg) {
      S.grid = null;
      viewer.clear(`<div class="md-empty">Open an image (DICOM, NIfTI, NRRD) and/or a segmentation.</div>`);
      ["sec-segments", "sec-details", "sec-export"].forEach((id) => $(id).classList.add("hidden"));
      $("image-controls").classList.add("hidden");
      $("slice-info").textContent = "";
      $("strip").classList.add("hidden");
      return;
    }
    align();
    S.grid = Med.makeGrid(S.image || S.segShown, S.image && S.segShown ? S.segShown : null);
    if (S.segShown) {
      S.stats = Med.labelStats(S.segShown, S.grid);
      const before = S.segs.length ? new Set(S.segs.map((s) => s.id)) : null;
      S.segs = Med.labels.segments(S.segShown, S.stats, S.table);
      S.segById = new Map(S.segs.map((s) => [s.id, s]));
      // Keep the user's choice of shown segments across a re-read of names.
      const sameSet = before && S.segs.length === before.size && S.segs.every((s) => before.has(s.id));
      if (!sameSet || opts.resetSlices) S.visible = new Set(S.segs.map((s) => s.id));
      if (S.focus != null && !S.segById.has(S.focus)) S.focus = null;
    } else {
      S.stats = null; S.segs = []; S.segById = new Map(); S.focus = null;
    }
    updateLookup();
    if (opts.resetSlices || !S.k.axial) centreSlices();
    if (opts.resetSlices) S.gridEdited = false;
    renderSegTable();
    renderDetails();
    $("image-controls").classList.toggle("hidden", !S.image);
    $("sec-export").classList.remove("hidden");
    frameControls();
    exportForm();
    draw();
  }

  /** Each plane starts at the segments' centre of mass, else mid-volume. */
  function centreSlices() {
    for (const key of Object.keys(Med.PLANES)) {
      const axis = Med.PLANES[key].axis, n = S.grid.dims[axis];
      let k = Math.floor(n / 2);
      if (S.stats && S.stats.ids.length) {
        let sum = 0, w = 0;
        for (const id of S.stats.ids) {
          const c = S.stats.perSlice.get(id)[axis];
          for (let i = 0; i < c.length; i++) { sum += i * c[i]; w += c[i]; }
        }
        if (w) k = Math.round(sum / w);
      }
      S.k[key] = k;
    }
  }

  const updateLookup = () => { S.lk = S.segs.length ? Med.labels.lookup(S.segs, S.visible) : null; };

  // ==========================================================================
  // Draw one slice
  // ==========================================================================
  const viewer = Med.viewer.create($("panels"), {
    readout: $("readout"),
    describe,
    onStep: (d) => setSlice(S.k[S.plane] + d),
  });

  const planeTabs = ui.tabs($("plane-tabs"),
    Object.values(Med.PLANES).map((p) => ({ value: p.key, label: p.title })), S.plane,
    (v) => { S.plane = v; draw(); exportForm(); });

  function setSlice(k) {
    if (!S.grid) return;
    const depth = S.grid.dims[Med.PLANES[S.plane].axis];
    const next = Math.max(0, Math.min(depth - 1, Math.round(k)));
    if (next === S.k[S.plane]) return;
    S.k[S.plane] = next;
    draw();
  }

  const AXIS_LETTERS = [["L", "R"], ["P", "A"], ["I", "S"]];
  function positionText(axis, k) {
    const v = S.grid.lo[axis] + S.grid.step[axis] * k;
    const [neg, pos] = AXIS_LETTERS[axis];
    return `${v >= 0 ? pos : neg} ${Math.abs(v).toFixed(1)} mm`;
  }

  const segName = (id) => (id > 0 ? (S.segById.get(id) || { name: `Label ${id}` }).name : "—");
  const valueText = (v) => (v === v ? fmt.num(v, 2) : "outside");

  function draw() {
    if (!S.grid) return;
    const view = Med.planeView(S.grid, S.plane, false);
    const k = Math.max(0, Math.min(view.depth - 1, S.k[S.plane] | 0));
    S.k[S.plane] = k;
    const vals = S.image ? Med.sampleSlice(S.image, S.grid, view, k, false) : null;
    const lab = S.segShown ? Med.sampleSlice(S.segShown, S.grid, view, k, true) : null;
    const { w, h } = view;
    const at = (r, c) => r * w + c;
    const opts = { alpha: S.alpha, mode: S.mode, focus: S.focus };
    const panels = [];
    if (vals) {
      const base = Med.render.image(vals, displayWindow(), S.lutTable);
      let over = null;
      if (lab && S.lk) over = Med.render.labels(lab, w, h, S.lk, opts, new Uint8ClampedArray(base));
      if (lab && S.focus != null) Med.render.outline(lab, w, h, S.focus, base);
      panels.push({ tag: S.image.modality || "Image", rgba: base, tip: (r, c) => valueText(vals[at(r, c)]) });
      if (over) panels.push({ tag: "Segments", rgba: over, tip: (r, c) => segName(lab[at(r, c)]) });
    } else if (lab && S.lk) {
      panels.push({ tag: "Segments", rgba: Med.render.labels(lab, w, h, S.lk, opts, null),
                    tip: (r, c) => segName(lab[at(r, c)]) });
    }
    S.cur = { view, k, vals, lab };
    if (!panels.length) { viewer.clear(`<div class="md-empty">No segment in this file.</div>`); return; }
    viewer.render({ w, h, sx: view.sx, sy: view.sy, letters: view.letters, panels }, 0);

    const slider = $("slice"), num = $("slice-num");
    slider.max = view.depth - 1;
    slider.value = k;
    num.max = view.depth - 1;
    num.value = k;
    $("slice-info").textContent = `/ ${view.depth - 1} · ${positionText(view.p.axis, k)}`;
    drawStrip(view, k);
  }

  function describe(row, col) {
    const c = S.cur;
    if (!c) return "";
    const parts = [];
    const world = Med.gridWorld(S.grid, Med.gridIndex(c.view, c.k, row, col));
    if (S.image) {
      const v = Med.voxelAt(S.image, S.grid, c.view, c.k, row, col);
      parts.push(`<b>Image</b> ${v ? `[${v.join(", ")}]` : ""} ${esc(valueText(c.vals[row * c.view.w + col]))}`);
    }
    if (S.segShown) {
      const id = c.lab[row * c.view.w + col];
      const seg = S.segById.get(id);
      const sw = seg ? `<span class="md-sw" style="background:${Med.labels.css(seg.color)}"></span> ` : "";
      parts.push(`<b>Label</b> ${sw}${id > 0 ? `${id} ${esc(segName(id))}` : "background"}`);
    }
    parts.push(`<b>RAS</b> (${world.map((x) => x.toFixed(1)).join(", ")}) mm`);
    return parts.join(" &nbsp;·&nbsp; ");
  }

  /** Which slices of the current plane hold the highlighted segment. */
  function drawStrip(view, k) {
    const el = $("strip");
    if (S.focus == null || !S.stats) { el.classList.add("hidden"); return; }
    const counts = S.stats.perSlice.get(S.focus)[view.p.axis];
    const n = counts.length;
    let top = 0, first = -1, last = -1;
    counts.forEach((c, i) => { if (c) { top = Math.max(top, c); if (first < 0) first = i; last = i; } });
    const [r, g, b] = Med.render.HIGHLIGHT;
    let cells = "";
    for (let i = 0; i < n; i++)
      if (counts[i]) cells += `<rect x="${i}" y="2" width="1" height="10" fill="rgb(${r},${g},${b})" fill-opacity="${(0.15 + 0.85 * counts[i] / top).toFixed(2)}"/>`;
    el.innerHTML =
      `<div>${esc(segName(S.focus))}: ${first < 0 ? "not in this plane" : `slices ${first}–${last}`} ` +
      `(darker = more; the bar = this slice, ${k})</div>` +
      `<svg viewBox="0 0 ${n} 14" preserveAspectRatio="none">` +
      `<rect x="0" y="2" width="${n}" height="10" fill="none" stroke="#9ca3af" stroke-width="0.3" vector-effect="non-scaling-stroke"/>` +
      `${cells}<rect x="${k}" y="0" width="1" height="14" fill="currentColor"/></svg>` +
      `<div class="md-strip-ticks"><span>0</span><span>${n - 1}</span></div>`;
    el.classList.remove("hidden");
  }
  $("strip").addEventListener("click", (e) => {
    const svg = e.target.closest("svg");
    if (!svg || !S.grid) return;
    const r = svg.getBoundingClientRect();
    const n = S.grid.dims[Med.PLANES[S.plane].axis];
    setSlice(Math.floor(((e.clientX - r.left) / r.width) * n));
  });

  // ==========================================================================
  // Viewer controls
  // ==========================================================================
  $("slice").addEventListener("input", (e) => setSlice(+e.target.value));
  $("slice-num").addEventListener("change", (e) => setSlice(+e.target.value));
  $("cmap").addEventListener("change", (e) => {
    S.cmap = e.target.value;
    S.lutTable = Med.render.lut(S.cmap, !!(S.image && S.image.invert));
    draw();
  });

  /**
   * The grey window: the chosen range (1–99 % of the non-zero values, or
   * min–max), then contrast narrows or widens it (×4 either way at ±100)
   * and brightness slides it (±100 = the range's full width).
   */
  function displayWindow() {
    const st = S.imgStats;
    if (!st) return [0, 1];
    const [lo, hi] = S.range === "full" ? [st.min, st.max] : [st.p1, st.p99];
    const span = hi - lo || 1;
    const width = span * Math.pow(2, -S.contrast / 50);
    const centre = (lo + hi) / 2 - (S.bright / 100) * span;
    return [centre - width / 2, centre + width / 2];
  }
  $("win-range").addEventListener("change", (e) => { S.range = e.target.value; draw(); });
  const bc = { bright: $("bright"), contrast: $("contrast") };
  for (const [key, el] of Object.entries(bc)) {
    el.addEventListener("input", () => { S[key] = +el.value; draw(); });
    el.addEventListener("dblclick", () => { el.value = 0; S[key] = 0; draw(); });
  }
  $("bc-reset").addEventListener("click", () => {
    S.bright = S.contrast = 0;
    bc.bright.value = bc.contrast.value = 0;
    draw();
  });

  function frameControls() {
    const n = S.image ? S.image.frames : 1;
    $("frame-row").classList.toggle("hidden", n < 2);
    if (n < 2) return;
    $("frame").max = n - 1;
    $("frame").value = S.image.frame;
    $("frame-val").textContent = `${S.image.frame + 1} / ${n}`;
  }
  $("frame").addEventListener("input", (e) => {
    S.image.frame = +e.target.value;
    S.profiles = {};
    $("frame-val").textContent = `${S.image.frame + 1} / ${S.image.frames}`;
    draw();
  });

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(draw, 120);
  });

  // ==========================================================================
  // Segments
  // ==========================================================================
  function renderSegTable() {
    const sec = $("sec-segments");
    sec.classList.toggle("hidden", !S.seg);
    if (!S.seg) return;
    const total = S.segs.reduce((a, s) => a + s.ml, 0);
    $("seg-count").textContent = `${S.segs.length} · ${total.toFixed(1)} mL`;
    $("seg-filter").classList.toggle("hidden", S.segs.length <= 12);
    const q = $("seg-filter").value.trim().toLowerCase();
    const rows = S.segs.filter((s) => !q || s.name.toLowerCase().includes(q) || String(s.id) === q).map((s) => {
      const on = S.visible.has(s.id);
      const cls = [S.focus === s.id ? "focus" : "", on ? "" : "off"].join(" ").trim();
      return `<tr data-id="${s.id}" class="${cls}"><td><input type="checkbox" data-id="${s.id}"${on ? " checked" : ""} aria-label="Show ${esc(s.name)}"></td>` +
        `<td><span class="md-sw" style="background:${Med.labels.css(s.color)}"></span></td>` +
        `<td class="name" title="Highlight and jump to it">${esc(s.name)}</td><td>${s.id}</td>` +
        `<td>${fmt.int(s.voxels)}</td><td>${s.ml < 0.05 ? s.ml.toFixed(3) : s.ml.toFixed(1)}</td></tr>`;
    }).join("");
    $("seg-table").innerHTML = S.segs.length
      ? `<table><thead><tr><th></th><th></th><th>Name</th><th>id</th><th>Voxels</th><th>mL</th></tr></thead><tbody>${rows}</tbody></table>`
      : `<p class="hint">No labelled voxel (all zero).</p>`;
  }

  $("seg-table").addEventListener("change", (e) => {
    const box = e.target.closest("input[data-id]");
    if (!box) return;
    const id = +box.dataset.id;
    if (box.checked) S.visible.add(id); else S.visible.delete(id);
    box.closest("tr").classList.toggle("off", !box.checked);
    updateLookup();
    draw();
  });
  $("seg-table").addEventListener("click", (e) => {
    const cell = e.target.closest("td.name");
    if (!cell) return;
    const id = +cell.parentElement.dataset.id;
    S.focus = S.focus === id ? null : id;
    if (S.focus != null) {
      // Show it if hidden, and go to the slice holding most of it.
      if (!S.visible.has(id)) { S.visible.add(id); updateLookup(); }
      const counts = S.stats.perSlice.get(id)[Med.PLANES[S.plane].axis];
      let best = 0;
      for (let i = 1; i < counts.length; i++) if (counts[i] > counts[best]) best = i;
      S.k[S.plane] = best;
    }
    renderSegTable();
    draw();
  });
  const setVisible = (ids) => { S.visible = new Set(ids); updateLookup(); renderSegTable(); draw(); };
  $("seg-all").addEventListener("click", () => setVisible(S.segs.map((s) => s.id)));
  $("seg-none").addEventListener("click", () => setVisible([]));
  $("seg-filter").addEventListener("input", renderSegTable);
  $("seg-mode").addEventListener("change", (e) => { S.mode = e.target.value; draw(); });
  $("seg-alpha").addEventListener("input", (e) => {
    S.alpha = +e.target.value;
    $("seg-alpha-val").textContent = S.alpha.toFixed(2);
    draw();
  });
  $("match-index").addEventListener("change", (e) => { S.matchIndex = e.target.checked; rebuild({ resetSlices: true }); });

  // ==========================================================================
  // Metadata (the section, and the block printed under a mosaic)
  // ==========================================================================
  function metaBlocks() {
    const blocks = [];
    const rowsOf = (vol, extra) => {
      const sp = vol.spacing;
      const obl = vol.obliqueDegrees();
      return [["File", vol.name], ...Object.entries(vol.meta),
        ["Matrix", vol.dims.join(" × ") + (vol.frames > 1 ? ` × ${vol.frames}` : "")],
        ["Voxel size", fmt.mm(sp)],
        ["Field of view", fmt.mm(vol.dims.map((n, i) => n * sp[i]))],
        ["Orientation", vol.orientation() + (obl > 0.5 ? ` (oblique, ${obl.toFixed(1)}°)` : "")],
        ...extra];
    };
    if (S.image) {
      const st = S.imgStats;
      blocks.push({ title: "Image", rows: rowsOf(S.image, [["Values", `${fmt.num(st.min, 2)} – ${fmt.num(st.max, 2)}`]]) });
    }
    if (S.seg) {
      blocks.push({ title: "Segmentation", rows: rowsOf(S.seg, [["Labels", `${S.segs.length}` +
        (S.segs.length ? ` (ids ${S.segs[0].id}–${S.segs[S.segs.length - 1].id})` : "")]]) });
    }
    return blocks;
  }

  function renderDetails() {
    const blocks = metaBlocks().map((b) => `<h3>${esc(b.title)}</h3><table class="kv">` +
      b.rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("") + `</table>`);
    if (S.grid) {
      blocks.push(`<h3>Display grid</h3><table class="kv">` +
        `<tr><td>Size</td><td>${S.grid.dims.join(" × ")} (RAS)</td></tr>` +
        `<tr><td>Step</td><td>${fmt.mm(S.grid.step)}</td></tr></table>`);
    }
    const notes = [...S.fileNotes, ...(S.image ? S.image.notes : []), ...(S.seg ? S.seg.notes : []), ...S.alignNotes];
    if (notes.length) blocks.push(`<ul class="md-notes">${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`);
    $("details").innerHTML = `<div class="md-details">${blocks.join("")}</div>`;
    $("sec-details").classList.remove("hidden");
  }

  // ==========================================================================
  // Export mosaic: the viewer's plane, its content (the image with the shown
  // segments over it, or whichever of the two is loaded), its window and
  // colours, and the metadata printed underneath.
  // ==========================================================================
  /** The current plane's view, and its screen pixel aspect. */
  function exportView() {
    const view = Med.planeView(S.grid, S.plane, false);
    const unit = Math.min(view.sx, view.sy);
    return { view, ax: view.sx / unit, ay: view.sy / unit };
  }

  function exportForm() {
    if (!S.grid) return;
    $("mx-plane").textContent = Med.PLANES[S.plane].title;
    $("mx-legend-box").classList.toggle("hidden", !S.segShown);
    // The grid follows the slice's shape until the user sets it.
    if (!S.gridEdited) {
      const { view, ax, ay } = exportView();
      const [rows, cols] = VV.mosaic.layoutFor(view.w * ax, view.h * ay);
      $("mx-rows").value = rows;
      $("mx-cols").value = cols;
    }
  }
  ["mx-rows", "mx-cols"].forEach((id) => $(id).addEventListener("change", () => { S.gridEdited = true; }));
  $("mx-range").addEventListener("change", (e) =>
    document.querySelector(".mx-list").classList.toggle("hidden", e.target.value !== "list"));

  const mxStatus = (t, kind) => ui.status($("mx-status"), t, kind);

  function sliceRGBA(view, k) {
    const vals = S.image ? Med.sampleSlice(S.image, S.grid, view, k, false) : null;
    const lab = S.segShown ? Med.sampleSlice(S.segShown, S.grid, view, k, true) : null;
    const opts = { alpha: S.alpha, mode: S.mode, focus: null };
    if (vals) {
      const base = Med.render.image(vals, displayWindow(), S.lutTable);
      return lab && S.lk ? Med.render.labels(lab, view.w, view.h, S.lk, opts, base) : base;
    }
    if (!S.lk) return Med.render.image(new Float32Array(view.w * view.h).fill(NaN), [0, 1], S.lutTable);
    return Med.render.labels(lab, view.w, view.h, S.lk, opts, null);
  }

  /** "20, 34, 40-60" -> [20, 34, 40, 41, …, 60], in range, unique, in order. */
  const MAX_TILES = 400;
  function parseSlices(text, last) {
    const out = new Set();
    for (const part of text.split(/[\s,;]+/).filter(Boolean)) {
      const m = part.match(/^(\d+)(?:[-–](\d+))?$/);
      if (!m) throw new Error(`“${part}” is not a slice index or a range like 40-60.`);
      let a = +m[1], b = m[2] != null ? +m[2] : a;
      if (a > b) [a, b] = [b, a];
      if (a > last) throw new Error(`Slice ${a} is past the last slice, ${last}.`);
      for (let k = a; k <= Math.min(b, last); k++) out.add(k);
      if (out.size > MAX_TILES) throw new Error(`More than ${MAX_TILES} slices.`);
    }
    if (!out.size) throw new Error("Enter at least one slice index.");
    return Array.from(out).sort((x, y) => x - y);
  }

  /** Auto: the slices holding the shown segments, else the image's signal. */
  function autoSpan(axis) {
    if (S.stats && S.visible.size) {
      const span = VV.mosaic.countSpan(Array.from(S.visible, (id) => S.stats.perSlice.get(id)[axis]));
      if (span) return span;
    }
    if (S.image) {
      const key = `${S.plane}|${S.image.frame}`;
      if (!S.profiles[key]) S.profiles[key] = Med.signalProfile(S.image, S.grid, axis, [S.imgStats.p1, S.imgStats.p99]);
      return VV.mosaic.occupiedSpan(S.profiles[key]);
    }
    return [0, S.grid.dims[axis] - 1];
  }

  function buildMosaic() {
    const { view, ax, ay } = exportView();
    const axis = view.p.axis, last = view.depth - 1;
    const rows = Math.max(1, Math.min(20, +$("mx-rows").value || 1));
    const cols = Math.max(1, Math.min(20, +$("mx-cols").value || 1));
    let ks;
    if ($("mx-range").value === "list") ks = parseSlices($("mx-list").value, last);
    else {
      const span = autoSpan(axis);
      ks = VV.mosaic.sliceIndices(span[0], span[1], rows * cols);
    }
    const caption = $("mx-caption").value;
    const tiles = ks.map((k) => ({
      rgba: sliceRGBA(view, k),
      caption: caption === "index" ? String(k) : caption === "mm" ? positionText(axis, k) : "",
    }));
    // About 220 px per tile, at an integer scale (1–4).
    const scale = Math.max(1, Math.min(4, Math.round(220 / (view.w * ax))));
    const span = [ks[0], ks[ks.length - 1]];
    const legend = !S.segShown || !$("mx-legend").checked ? [] :
      S.segs.filter((s) => S.visible.has(s.id) && S.stats.perSlice.get(s.id)[axis].some((c, i) => c && ks.includes(i)));
    const canvasW = (view.w * ax * scale + 4) * Math.min(cols, tiles.length);
    if (canvasW > 16000) throw new Error("The mosaic would be over 16,000 px wide: use fewer columns.");
    const canvas = VV.mosaic.compose(tiles, {
      w: view.w, h: view.h, ax, ay, scale, cols, gap: 4,
      title: $("mx-title").value.trim(),
      letters: $("mx-letters").checked ? view.letters : null,
      legend, meta: metaBlocks(), background: $("mx-white").checked ? "white" : "black",
    });
    return { canvas, plane: S.plane, ks, span, notes: [] };
  }

  function showPreview(m) {
    const out = $("mx-out");
    out.innerHTML = "";
    out.appendChild(m.canvas);
    out.classList.remove("hidden");
    const [first, lastK] = m.span;
    mxStatus(`${m.ks.length} ${Med.PLANES[m.plane].title.toLowerCase()} slices (${first}–${lastK}) · ` +
             `${m.canvas.width} × ${m.canvas.height} px` + (m.notes.length ? ` · ${m.notes.join(" ")}` : ""), "");
  }

  $("mx-preview").addEventListener("click", async () => {
    mxStatus("Composing…", "busy");
    await ui.busy();
    try { showPreview(buildMosaic()); } catch (e) { console.error(e); mxStatus(e.message, "err"); }
  });
  $("mx-export").addEventListener("click", async () => {
    mxStatus("Composing…", "busy");
    await ui.busy();
    try {
      const m = buildMosaic();
      showPreview(m);
      const format = $("mx-format").value;
      const base = (Med.io.stem((S.image || S.seg).name) || "volume").replace(/[^\w.-]+/g, "_");
      const name = `${base}_${m.plane}_mosaic`;
      if (format === "png") ui.download(await Viz.pdf.png(m.canvas), name + ".png");
      else ui.download(await Viz.pdf.pdf(m.canvas, format, $("mx-title").value.trim() || name), name + ".pdf");
      ui.toast(`Saved ${name}.${format === "png" ? "png" : "pdf"}`);
    } catch (e) { console.error(e); mxStatus(e.message, "err"); }
  });

  rebuild({});
})();
