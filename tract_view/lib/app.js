/* ============================================================================
 * tract_view/lib/app.js — the page: tracts within segments, by direction
 * ----------------------------------------------------------------------------
 * The pipeline, each stage cached and rerun only from where a control
 * changed it:
 *
 *   base       the tract file's points in RAS mm (its space: tagged, chosen,
 *              or auto -- whichever puts the points on the images)
 *   simplified heal + cluster once (lib/simplify.js prepare), then cut /
 *              thin / smooth per slider (select); or the base, unsimplified
 *   labelled   the segment label under every point, and how many
 *              streamlines touch each segment (the segment table)
 *   cropped    within the ticked segments, clipped or passing through
 *              (lib/select.js crop); all of them without a segmentation
 *   classified each streamline's dominant direction (L-R, A-P, S-I, Mixed)
 *   shown      the chosen direction(s): drawn in 3D (lines), projected on
 *              the three planes under it, saved, and summed up in the info
 *
 * The head surface (VTK / PLY) is drawn in 3D at its own opacity, and as a
 * silhouette under each projection; the segments as smooth surfaces in 3D
 * and as a fill on the panels, at the slice where the other two planes meet
 * (a click on one panel moves the other two).
 *
 * When the segments have names (a names table, or a 3D Slicer .seg.nrrd),
 * those outside the brain (CSF, scalp, skin, bone, fat, eyes, humour, dura)
 * are left out of the table, and of the rest those of the white matter,
 * brainstem (midbrain, pons, medulla) and cerebellum are ticked: tracts run
 * there. A tractogram over AUTO_SIMPLIFY_* is simplified on
 * loading, for viewing, and the page says so.
 * Everything meets in world space (RAS mm), each file through its own header.
 * ========================================================================== */
(function () {
  "use strict";
  const { ui } = Viz;
  const { esc, fmt } = ui;
  const $ = (id) => document.getElementById(id);
  const SEL = TV.select, SIMP = TV.simplify;

  const PROJ_PX = 420;                       // a projection's longer side, about
  // Above either, a tractogram is simplified as it loads (heavy to draw,
  // above all on a phone).
  const AUTO_SIMPLIFY_STREAMLINES = 30000;
  const AUTO_SIMPLIFY_POINTS = 3e6;
  // Segment names: left out of the table (outside the brain), and ticked
  // at first (where tracts run). "wm" / "gm" only as whole words.
  const SKIP_NAME = /csf|scalp|skin|bone|fat|eye|humou?r|dura/i;
  const TICK_NAME = /(^|[^a-z])wm([^a-z]|$)|white|brain[\s_-]*stem|mid[\s_-]*brain|pons|medull|cerebell/i;
  const HEAD_COLOR = [0.91, 0.79, 0.69];      // skin
  // The head surface: smoothed this much (Taubin steps), and faded out
  // from the bottom by the "Head fade" degree d (0..1): gone below
  // d × FADE_FROM_PER of its height, fully shown FADE_SPAN above that.
  // d = 0.6 (the default): gone below 24 %, shown above 57 %. The jaw and
  // neck sit low and are the parts a head scan captures worst.
  const HEAD_SMOOTH = 8;
  const HEAD_FADE_FROM_PER = 0.4, HEAD_FADE_SPAN = 0.33;
  const PROJ_MAX_H = 200;                     // the projections' shared height, at most (px)

  const S = {
    file: null, raw: null, base: null, space: "auto", spaceUsed: null, spaceNote: "",
    head: null, seg: null, segFile: "", table: null, segs: [], visible: new Set(),
    prep: null, prepKey: "", sel: null, simplified: null,
    labels: null, touch: null, cropped: null, cls: null, classCounts: [0, 0, 0, 0],
    dir: "all", colour: "local", shown: null, shownRgb: null,
    grid: null, pos: [0, 0, 0], proj: {}, posSet: false,
  };
  const status = (t, kind) => ui.status($("status"), t, kind);

  let R;
  try { R = Med.gl3d.create($("gl")); }
  catch (e) { $("empty").textContent = e.message; status(e.message, "err"); return; }
  R.opts.onRender = drawGizmo;

  async function guarded(text, fn) {
    status(text, "busy");
    await ui.busy();
    try {
      await fn();
      if ($("status").classList.contains("busy")) status("", "");     // a step that set no message of its own
    } catch (e) { console.error(e); status(e.message, "err"); }
  }
  const progress = (t) => status(t, "busy");

  // ==========================================================================
  // Inputs
  // ==========================================================================
  const dropTracts = ui.dropZone($("drop-tracts"), {
    title: "Tracts", sub: "VTK · PLY · TRK · TCK", accept: ".vtk,.ply,.trk,.tck,.gz", required: true,
    tip: "A whole-brain tractogram: legacy VTK (lines), PLY (edges or polylines), TrackVis .trk or MRtrix .tck.",
    onFiles: (files) => guarded(`Reading ${files[0].name}…`, () => loadTracts(files[0], false)),
    onClear() { S.file = null; S.base = null; S.prep = null; R.setLines(null); refreshEmpty(); clearOut(); },
  });
  /** A tract file into the viewer. The user's first one ends the demo: the
   *  sample's head and segmentation go with it (unless replaced by the user's). */
  async function loadTracts(file, demo) {
      if (!demo && S.demo) await endDemo();
      const t = await TV.io.read(file);
      if (!SIMP.count({ offsets: t.offsets })) throw new Error(`${file.name}: no streamline with 2 or more points.`);
      S.file = t;
      S.prep = null; S.prepKey = "";
      const n = SIMP.count(t), pts = t.raw.length / 3;
      if (!demo) dropTracts.setInfo(`${t.name} · ${fmt.int(n)} streamlines`);
      const heavy = n > AUTO_SIMPLIFY_STREAMLINES || pts > AUTO_SIMPLIFY_POINTS;
      $("simplify").checked = heavy || $("simplify").checked;
      $("simplify-controls").classList.toggle("hidden", !$("simplify").checked);
      if (!demo) $("sec-simplify").classList.remove("collapsed");
      ui.status($("simplify-auto"), heavy && !demo ? `${fmt.int(n)} streamlines, ${fmt.int(pts)} points: simplified for viewing. ` +
        `Untick to show every streamline (slow on a phone).` : "", heavy ? "ok" : "");
      decideSpace();
      await run("base");
      R.orient(...VIEWS.A); frameView(); R.redraw();
      if (!demo) status(`${t.name}: ${fmt.int(n)} streamlines, ${fmt.int(pts)} points (${S.spaceUsed})` +
                        (heavy ? ` — simplified for viewing to ${fmt.int(SIMP.count(S.simplified))}.` : "."), "ok");
  }
  const dropHead = ui.dropZone($("drop-head"), {
    title: "Head surface", sub: "VTK · PLY", accept: ".vtk,.ply,.gz",
    tip: "The head (skin) surface around the tracts, in the same scanner space: legacy VTK or PLY. RAS unless tagged SPACE=LPS.",
    onFiles: (files) => guarded(`Reading ${files[0].name}…`, () => loadHead(files[0], false)),
    onClear() { clearHead(); afterImages(); },
  });
  async function loadHead(f, demo) {
      const u8 = await Med.io.readBytes(f);
      const mesh = /\.ply$/i.test(f.name) ? Med.ply.surface(u8, f.name) : Med.vtk.parse(u8, f.name);
      S.head = { name: f.name, mesh, tagged: !!mesh.space, demo };
      if (!demo) dropHead.setInfo(`${f.name} · ${fmt.int(mesh.indices.length / 3)} triangles`);
      $("head-space").value = mesh.space || "RAS";
      $("head-space-row").classList.toggle("hidden", !!mesh.space);
      placeHead();
      await afterImages();
      if (!demo) status(`Head surface ${f.name}: ${fmt.int(mesh.positions.length / 3)} points, ${fmt.int(mesh.indices.length / 3)} triangles` +
                        (mesh.space ? ` (${mesh.space}).` : " (untagged: RAS assumed)."), "ok");
  }
  function clearHead() { S.head = null; R.removeMeshes((m) => m.isHead); $("head-space-row").classList.add("hidden"); applyOpacity(); }
  /** The head mesh in RAS, in the scene (replacing any earlier one). */
  function placeHead() {
    R.removeMeshes((m) => m.isHead);
    S.proj = {};
    if (!S.head) return;
    const pos = Med.vtk.toRas(S.head.mesh, $("head-space").value);
    Med.surface.smooth(pos, S.head.mesh.indices, HEAD_SMOOTH);
    S.head.positions = pos;
    const rec = R.addMesh("head", pos, Med.surface.normals(pos, S.head.mesh.indices), S.head.mesh.indices, HEAD_COLOR, +$("op-head").value);
    rec.isHead = true;
    S.head.zlo = rec.lo[2];
    S.head.zh = rec.hi[2] - rec.lo[2];
    applyOpacity();
  }
  $("head-space").addEventListener("change", () => { placeHead(); drawProjections(); });
  const dropSeg = ui.dropZone($("drop-seg"), {
    title: "Segmentation", sub: "NIfTI · NRRD labels", accept: ".nii,.gz,.nrrd",
    tip: "A label map in the same space: the tracts are shown within the ticked segments.",
    onFiles: (files) => guarded(`Reading ${files[0].name}…`, () => loadSeg(files[0], false)),
    onClear() { clearSeg(); afterImages(); },
  });
  async function loadSeg(file, demo) {
      const v = await Med.io.readVolumeFile(file);
      const st = Med.labelStats(v, Med.makeGrid(v));
      if (st.ids.length > 2000) throw new Error(`${file.name}: ${st.ids.length} labels — an image, not a segmentation.`);
      S.seg = v; S.segStats = st; S.segDemo = demo;
      if (!demo) dropSeg.setInfo(`${v.name} · ${st.ids.length} segments`);
      nameSegments(true);
      // Its 3D surfaces only when they are to be seen (Segments opacity > 0):
      // the tracts are selected from the label map itself.
      R.removeMeshes((m) => m.segId != null);
      S.surfaces = null;
      if (+$("op-seg").value > 0) await buildSurfaces();
      await afterImages();
      if (!demo) status(`Segmentation ${v.name}: ${st.ids.length} segment(s).`, "ok");
  }
  function clearSeg() { S.seg = null; S.segs = []; S.segDemo = false; R.removeMeshes((m) => m.segId != null); }

  // ==========================================================================
  // The demo: the sample subject, shown until the user's first tract file
  // ==========================================================================
  // Fetched from Sample Data (needs http: from file:// the page just starts
  // empty). Its input boxes stay empty; the other sections are locked and
  // the viewer's direction tabs and segment opacity hidden until then.
  const DEMO = "sample_data/asset/IXI034/";
  const DEMO_FILES = { tracts: "tract/IXI034_wb_tracts.vtk", head: "seg/IXI034_head.vtk", seg: "seg/IXI034_seg_match_dwi.nii.gz" };
  async function startDemo() {
    if (location.protocol === "file:") return;
    const get = async (path) => {
      const r = await fetch(Viz.chrome.url(DEMO + path));
      if (!r.ok) throw new Error(`${path}: ${r.status}`);
      return new File([await r.blob()], path.split("/").pop());
    };
    S.demo = true;
    setDemoLook(true);
    try {
      status("Loading the sample subject (IXI034) for a demonstration…", "busy");
      const [t, h, g] = await Promise.all([get(DEMO_FILES.tracts), get(DEMO_FILES.head), get(DEMO_FILES.seg)]);
      if (!S.demo) return;                        // the user was quicker
      await loadSeg(g, true);
      if (!S.demo) return;
      await loadHead(h, true);
      if (!S.demo) return;
      await loadTracts(t, true);
      status("", "");
    } catch (e) {
      console.warn("No demo:", e);
      if (S.demo) { S.demo = false; setDemoLook(false); status("", ""); }
    }
  }
  /** The user's own tract file: drop what was the sample's, unlock. */
  async function endDemo() {
    S.demo = false;
    if (S.segDemo) clearSeg();
    if (S.head && S.head.demo) clearHead();
    S.file = null; S.base = null; S.prep = null; S.posSet = false; S.grid = null; S.proj = {}; S.headSil = null;
    $("report-title").value = "";
    setDemoLook(false);
    nameSegments(true);
  }
  function setDemoLook(on) {
    document.body.classList.toggle("tv-demo", on);
    $("demo-note").classList.toggle("hidden", !on);
    for (const id of LOCKED) {
      const sec = $(id);
      sec.classList.toggle("locked", on);
      if (on) sec.classList.add("collapsed");
    }
    $("sec-simplify").classList.toggle("collapsed", on);
  }
  const LOCKED = ["sec-segments", "sec-simplify", "sec-save", "sec-info", "sec-report"];
  // The tissue names used until the user gives others: the sample subject's
  // (sample_data/asset/IXI034/seg/IXI034_labels.csv), the 14 tissue classes
  // of the lab's head models. Written here, not fetched: a page opened from
  // file:// cannot fetch.
  const DEFAULT_NAMES = { file: "IXI034_labels.csv", text:
    "id,name\n1,blood_in\n2,cancellous_bone\n3,cortical_bone\n4,cerebellar\n5,csf\n6,csf_meninges\n7,fat\n" +
    "8,gray_matter\n9,mucous_membrane\n10,muscle\n11,scalp\n12,eye_humour\n13,white_matter\n14,brainstem_cortical_nuclei\n" };
  const dropNames = ui.dropZone($("drop-names"), {
    title: "Tissue names", sub: "optional · CSV / LUT", accept: ".csv,.tsv,.txt,.ctbl,.lut,.label",
    tip: "Names (and colours) for the label ids: CSV “id,name[,r,g,b]”, ITK-SNAP, or a FreeSurfer / 3D Slicer colour table.",
    onFiles: (files) => guarded(`Reading ${files[0].name}…`, async () => {
      S.table = Med.labels.parseTable(await files[0].text());
      dropNames.setInfo(`${files[0].name} · ${S.table.size} names`);
      nameSegments(true);
      recolourSurfaces();
      if (S.file && S.seg) await run("label");
      else renderSegTable();
    }),
    onClear() { S.table = null; nameSegments(true); recolourSurfaces(); if (S.file && S.seg) guarded("Selecting tracts…", () => run("label")); else renderSegTable(); },
  });
  S.table = Med.labels.parseTable(DEFAULT_NAMES.text);
  dropNames.setInfo(`${DEFAULT_NAMES.file} · ${S.table.size} names (default)`);

  /** After the head surface or the segmentation changed: grid, space, everything. */
  async function afterImages() {
    S.grid = makeGrid();
    S.posSet = false;
    const before = S.spaceUsed;
    if (S.file && S.space === "auto") decideSpace();
    // New images change the labels, not the tracts -- unless they moved the
    // tracts' auto space.
    await run(!S.file ? "none" : S.spaceUsed !== before || !S.base ? "base" : "label");
    frameView(); R.redraw();
  }

  /** The tract file's space: its tag, the user's choice, or auto. */
  function decideSpace() {
    const t = S.file;
    $("space-row").classList.toggle("hidden", !t || t.tagged);
    if (!t) return;
    if (t.tagged) { S.spaceUsed = t.fileSpace; S.spaceNote = `${t.fileSpace} (from the file)`; return; }
    if (S.space !== "auto") { S.spaceUsed = S.space; $("space-why").textContent = "chosen"; return; }
    if (!S.seg) {
      S.spaceUsed = "LPS";
      $("space-why").textContent = "LPS assumed (dipy's convention) until a segmentation is loaded";
      return;
    }
    // LPS unless RAS fits clearly better (dipy's convention for untagged files).
    const sc = TV.io.spaceScore(t.raw, S.seg, null);
    S.spaceUsed = sc.RAS > sc.LPS * 1.1 ? "RAS" : "LPS";
    const other = S.spaceUsed === "RAS" ? "LPS" : "RAS";
    $("space-why").textContent = `${S.spaceUsed} (auto, by ${sc.how}: ${sc[S.spaceUsed].toFixed(2)} vs ${sc[other].toFixed(2)} as ${other})`;
  }
  $("space").addEventListener("change", (e) => guarded("Re-reading the tracts…", async () => {
    S.space = e.target.value;
    S.prep = null;
    decideSpace();
    await run("base");
    frameView(); R.redraw();
    status("", "");
  }));

  // ==========================================================================
  // The pipeline
  // ==========================================================================
  const STAGES = ["base", "simplify", "select", "label", "crop", "dir", "draw"];
  /** Rerun from `stage` on. */
  async function run(stage) {
    if (stage === "none" || !S.file) { refreshEmpty(); drawProjections(); renderInfo(); return; }
    const from = STAGES.indexOf(stage);
    const at = (s) => from <= STAGES.indexOf(s);
    if (at("base")) S.base = { positions: TV.io.toRas(S.file.raw, S.spaceUsed), offsets: S.file.offsets };
    if (at("simplify") && $("simplify").checked) {
      const o = simplifyOptions();
      const key = `${o.heal}|${o.healGapMm}|${o.healAngleDeg}`;
      if (!S.prep || S.prepKey !== key || from === 0) {
        S.prep = await SIMP.prepare(S.base, o, progress);
        S.prepKey = key;
      }
    }
    if (at("select")) {
      if ($("simplify").checked && S.prep) {
        S.sel = SIMP.select(S.prep, simplifyOptions());
        S.simplified = S.sel.tracts;
        $("simplify-summary").textContent = SIMP.summary(S.prep, S.sel) + ` · prepared in ${S.prep.seconds.toFixed(1)} s`;
      } else { S.sel = null; S.simplified = S.base; $("simplify-summary").textContent = ""; }
    }
    if (at("label")) {
      S.labels = S.seg ? SEL.pointLabels(S.simplified, S.seg) : null;
      S.touch = S.labels ? SEL.touching(S.simplified, S.labels) : null;
      renderSegTable();
    }
    if (at("crop")) {
      if (S.seg) {
        const max = S.segs.reduce((m, s) => Math.max(m, s.id), 0);
        const on = new Uint8Array(max + 1);
        for (const id of S.visible) if (id <= max) on[id] = 1;
        S.cropped = SEL.crop(S.simplified, S.labels, on, $("crop").value).tracts;
      } else S.cropped = S.simplified;
      S.cls = SEL.classify(S.cropped);
      S.classCounts = [0, 0, 0, 0];
      for (const c of S.cls) S.classCounts[c]++;
      renderDirTabs();
    }
    if (at("dir")) {
      const want = S.dir === "all" ? new Set([0, 1, 2, 3]) : new Set([+S.dir]);
      const r = SEL.byClass(S.cropped, S.cls, want);
      S.shown = r.tracts; S.shownCls = r.cls;
    }
    if (at("draw")) {
      S.shownRgb = SEL.colours(S.shown, S.shownCls, S.colour);
      R.setLines(S.shown.positions, S.shownRgb, SEL.segments(S.shown));
      if (!S.grid) S.grid = makeGrid();
      if (!S.posSet) centrePositions();
      S.proj = {};
      applyOpacity();
      drawProjections();
      renderInfo();
      refreshEmpty();
    }
  }

  function simplifyOptions() {
    return {
      heal: $("heal").checked, healGapMm: +$("heal-gap").value || 2, healAngleDeg: +$("heal-angle").value || 45,
      minLengthMm: +$("minlen").value, keepPercent: +$("keep").value, smoothMm: +$("smooth").value,
    };
  }

  // ==========================================================================
  // Segments
  // ==========================================================================
  /**
   * The segments listed: every one, or -- when they have names -- all but
   * those outside the brain (SKIP_NAME). `retick`: tick the brain-tissue
   * ones (TICK_NAME; every listed one when none is named so, or without
   * names) -- a new segmentation or names table.
   */
  function nameSegments(retick) {
    const all = S.seg ? Med.labels.segments(S.seg, S.segStats, S.table) : [];
    const named = all.some((s) => !/^Label \d+$/.test(s.name));
    const kept = named ? all.filter((s) => !SKIP_NAME.test(s.name)) : all;
    S.segs = kept.length ? kept : all;
    const tick = named ? S.segs.filter((s) => TICK_NAME.test(s.name)) : [];
    const skipped = all.length - S.segs.length;
    S.segNote = !S.seg || !named ? "" :
      (skipped ? `${skipped} of ${all.length} left out (outside the brain)` : "") +
      (tick.length ? "" : `${skipped ? "; " : ""}none named white matter, brainstem or cerebellum: all ticked`);
    if (retick) S.visible = new Set((tick.length ? tick : S.segs).map((x) => x.id));
    else S.visible = new Set([...S.visible].filter((id) => S.segs.some((x) => x.id === id)));
  }

  /** The segments' 3D surfaces (surface nets, then smoothed so they do not
   *  look like stacked voxels): only for drawing, and only once the
   *  Segments opacity is raised above 0. */
  async function buildSurfaces() {
    R.removeMeshes((m) => m.segId != null);
    if (!S.seg) return;
    S.surfaces = S.seg;
    const res = await Med.surface.build(S.seg, 10, progress);
    // Surfaces for every segment; only the listed and ticked ones show.
    for (const s of Med.labels.segments(S.seg, S.segStats, S.table)) {
      const m = res.meshes.get(s.id);
      if (!m) continue;
      const rec = R.addMesh(`seg${s.id}`, m.positions, m.normals, m.indices, s.color.map((c) => c / 255), +$("op-seg").value);
      rec.segId = s.id;
    }
  }
  function recolourSurfaces() {
    const all = S.seg ? Med.labels.segments(S.seg, S.segStats, S.table) : [];
    for (const m of R.scene.meshes) {
      const s = all.find((x) => x.id === m.segId);
      if (s) m.color = s.color.map((c) => c / 255);
    }
    syncSurfaces();
  }

  function renderSegTable() {
    $("sec-segments").classList.toggle("hidden", !S.seg);
    if (!S.seg) return;
    $("seg-count").textContent = `${S.visible.size} of ${S.segs.length} ticked`;
    $("seg-table").innerHTML = (S.segNote ? `<p class="hint">${esc(S.segNote)}.</p>` : "") + `<table><thead><tr><th></th><th></th><th>Name</th><th>id</th><th>mL</th>` +
      `<th title="Streamlines (after simplification) with a point in the segment">Tracts</th></tr></thead><tbody>` +
      S.segs.map((s) => `<tr class="${S.visible.has(s.id) ? "" : "off"}">` +
        `<td><input type="checkbox" data-id="${s.id}"${S.visible.has(s.id) ? " checked" : ""} aria-label="Show ${esc(s.name)}"></td>` +
        `<td><span class="md-sw" style="background:${Med.labels.css(s.color)}"></span></td>` +
        `<td class="name">${esc(s.name)}</td><td>${s.id}</td><td>${s.ml < 0.05 ? s.ml.toFixed(3) : s.ml.toFixed(1)}</td>` +
        `<td>${S.touch ? fmt.int(S.touch.get(s.id) || 0) : "—"}</td></tr>`).join("") + `</tbody></table>`;
  }
  let cropTimer = null;
  const recrop = () => {
    clearTimeout(cropTimer);
    cropTimer = setTimeout(() => guarded("Selecting tracts…", async () => { syncSurfaces(); await run("crop"); status("", ""); }), 120);
  };
  $("seg-table").addEventListener("change", (e) => {
    const box = e.target.closest("input[data-id]");
    if (!box) return;
    const id = +box.dataset.id;
    if (box.checked) S.visible.add(id); else S.visible.delete(id);
    box.closest("tr").classList.toggle("off", !box.checked);
    $("seg-count").textContent = `${S.visible.size} of ${S.segs.length} ticked`;
    recrop();
  });
  $("seg-all").addEventListener("click", () => { S.visible = new Set(S.segs.map((s) => s.id)); renderSegTable(); recrop(); });
  $("seg-none").addEventListener("click", () => { S.visible = new Set(); renderSegTable(); recrop(); });
  $("crop").addEventListener("change", recrop);
  function syncSurfaces() {
    const g = +$("op-seg").value;
    for (const m of R.scene.meshes) if (m.segId != null) m.visible = g > 0 && S.visible.has(m.segId);
    R.redraw();
  }

  // ==========================================================================
  // Simplification controls
  // ==========================================================================
  const showVal = () => {
    $("minlen-val").textContent = `${$("minlen").value} mm`;
    $("keep-val").textContent = `${$("keep").value} %`;
    $("smooth-val").textContent = +$("smooth").value ? `σ ${$("smooth").value} mm` : "off";
  };
  showVal();
  $("simplify").addEventListener("change", (e) => {
    $("simplify-controls").classList.toggle("hidden", !e.target.checked);
    guarded(e.target.checked ? "Simplifying…" : "Showing every streamline…", async () => { await run("simplify"); status("", ""); });
  });
  ["minlen", "keep", "smooth"].forEach((id) => {
    $(id).addEventListener("input", showVal);
    $(id).addEventListener("change", () => guarded("Selecting…", async () => { await run("select"); status("", ""); }));
  });
  ["heal", "heal-gap", "heal-angle"].forEach((id) =>
    $(id).addEventListener("change", () => guarded("Simplifying…", async () => { await run("simplify"); status("", ""); })));

  // ==========================================================================
  // Direction, colour, opacity, view
  // ==========================================================================
  /**
   * The direction bar: "All", then one tab per direction, each as wide as
   * its share of the streamlines within the segments (never narrower than
   * its label), tinted with its colour.
   */
  function renderDirTabs() {
    const total = S.classCounts.reduce((a, b) => a + b, 0);
    const pct = (n) => (total ? Math.round((100 * n) / total) : 0);
    $("dir-tabs").innerHTML =
      `<button type="button" class="tv-dir-all${S.dir === "all" ? " on" : ""}" data-value="all" aria-pressed="${S.dir === "all"}">` +
      `All<span class="n">${fmt.int(total)}</span></button><div class="tv-dir-track">` +
      SEL.CLASSES.map((c, i) => {
        const n = S.classCounts[i], on = S.dir === String(i);
        return `<button type="button" data-value="${i}" class="${on ? "on" : ""}${n ? "" : " empty"}" aria-pressed="${on}" ` +
          `style="flex-grow:${total ? n / total : 1};--c:${c.color}" title="${c.label}: ${fmt.int(n)} streamlines (${pct(n)} %)">` +
          `<b>${c.label}</b><span class="n">${pct(n)} %</span></button>`;
      }).join("") + `</div>`;
  }
  $("dir-tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-value]");
    if (!b || b.dataset.value === S.dir) return;
    guarded("Filtering…", async () => { S.dir = b.dataset.value; renderDirTabs(); await run("dir"); status("", ""); });
  });
  $("colour").addEventListener("change", (e) => guarded("Colouring…", async () => { S.colour = e.target.value; await run("draw"); status("", ""); }));

  function applyOpacity() {
    const t = +$("op-tracts").value, h = +$("op-head").value, g = +$("op-seg").value;
    $("op-tracts-val").textContent = t.toFixed(2);
    $("thick-val").textContent = `${$("thick").value} px`;
    $("op-head-val").textContent = h.toFixed(2);
    $("head-fade-cell").classList.toggle("hidden", !S.head);
    $("head-fade-val").textContent = +$("head-fade").value ? `${Math.round(100 * $("head-fade").value)} %` : "off";
    $("op-seg-val").textContent = g.toFixed(2);
    if (R.scene.lines) { R.scene.lines.alpha = t; R.scene.lines.visible = t > 0; R.scene.lines.width = +$("thick").value; }
    for (const mesh of R.scene.meshes) {
      if (mesh.isHead) { mesh.alpha = h; mesh.visible = h > 0; mesh.fade = headFade(); }
      else { mesh.alpha = g; mesh.visible = g > 0 && S.visible.has(mesh.segId); }
    }
    R.redraw();
  }
  $("op-tracts").addEventListener("input", () => { applyOpacity(); drawProjections(); });
  $("op-head").addEventListener("input", () => { applyOpacity(); drawProjections(); });
  $("head-fade").addEventListener("input", () => applyOpacity());
  /** The head's fade band [z gone, z shown] (world S, mm), or null. */
  function headFade() {
    const d = +$("head-fade").value;
    if (!S.head || !(d > 0)) return null;
    const from = d * HEAD_FADE_FROM_PER;
    return [S.head.zlo + from * S.head.zh, S.head.zlo + (from + HEAD_FADE_SPAN) * S.head.zh];
  }
  $("op-seg").addEventListener("input", () => { applyOpacity(); drawProjections(); });
  // The first time the segments are to be seen in 3D, build their surfaces.
  $("op-seg").addEventListener("change", () => {
    if (+$("op-seg").value > 0 && S.seg && S.surfaces !== S.seg)
      guarded("Building the segments' 3D surfaces…", async () => { await buildSurfaces(); applyOpacity(); });
  });
  $("thick").addEventListener("input", () => { applyOpacity(); });
  $("thick").addEventListener("change", () => { S.proj = {}; drawProjections(); });

  const VIEWS = { A: [[0, 1, 0], [0, 0, 1]] };          // the view Reset returns to
  /** Fit the camera to the tracts shown (else to everything). */
  const frameView = () => R.frame(R.scene.lines ? [R.scene.lines.lo, R.scene.lines.hi] : undefined);
  const resetView = () => { R.orient(...VIEWS.A); frameView(); R.redraw(); };
  $("btn-reset").addEventListener("click", resetView);
  $("gl").addEventListener("dblclick", resetView);
  $("bg").addEventListener("change", (e) => {
    const white = e.target.value === "white";
    R.scene.background = white ? [1, 1, 1] : [0, 0, 0];
    $("stage").style.background = white ? "#fff" : "#000";
    R.redraw();
  });
  window.addEventListener("resize", () => R.redraw());

  function drawGizmo() {
    const g = $("gizmo"), ctx = g.getContext("2d"), dpr = window.devicePixelRatio || 1;
    if (g.width !== 96 * dpr) g.width = g.height = 96 * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, 96, 96);
    if (!R.bounds()) return;
    const [x, y, z] = R.cam.rot;
    const axes = [["R", [1, 0, 0], "#ef4444"], ["A", [0, 1, 0], "#22c55e"], ["S", [0, 0, 1], "#3b82f6"]]
      .map(([l, v, c]) => ({ l, c, sx: v[0] * x[0] + v[1] * x[1] + v[2] * x[2], sy: v[0] * y[0] + v[1] * y[1] + v[2] * y[2],
                             sz: v[0] * z[0] + v[1] * z[1] + v[2] * z[2] }))
      .sort((p, q) => p.sz - q.sz);
    ctx.lineWidth = 2.5;
    ctx.font = "600 12px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const a of axes) {
      ctx.strokeStyle = a.c;
      ctx.beginPath(); ctx.moveTo(48, 48); ctx.lineTo(48 + a.sx * 30, 48 - a.sy * 30); ctx.stroke();
      ctx.fillStyle = a.c;
      ctx.fillText(a.l, 48 + a.sx * 40, 48 - a.sy * 40);
    }
  }

  function refreshEmpty() {
    const any = !!S.file;
    $("empty").classList.toggle("hidden", any);
    ["sec-simplify", "sec-save", "sec-info", "sec-report", "proj"].forEach((id) => $(id).classList.toggle("hidden", !any));
    $("report-title").value = $("report-title").value || (S.file ? Med.io.stem(S.file.name.replace(/\.(vtk|ply|trk|tck)$/i, "")) : "");
  }
  function clearOut() { renderInfo(); drawProjections(); }

  // ==========================================================================
  // The three projections
  // ==========================================================================
  /** The display grid: the segmentation's, else 1 mm over the head surface
   *  and the tracts. */
  function makeGrid() {
    if (S.seg) return Med.makeGrid(S.seg);
    if (!S.base && !S.head) return null;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of [S.base && S.base.positions, S.head && S.head.positions])
      if (p) for (let i = 0; i < p.length; i += 3) for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d], p[i + d]); hi[d] = Math.max(hi[d], p[i + d]); }
    const dims = lo.map((v, d) => Math.max(1, Math.ceil(hi[d] - v + 10)));
    return { lo: lo.map((v) => v - 5), step: [1, 1, 1], dims };
  }

  /** Slices start at the centre of what is shown (or of the grid). */
  function centrePositions() {
    const g = S.grid;
    if (!g) return;
    const p = S.shown && S.shown.positions.length ? S.shown.positions : null;
    for (let d = 0; d < 3; d++) {
      let c = g.lo[d] + (g.step[d] * (g.dims[d] - 1)) / 2;
      if (p) { let s = 0; const n = p.length / 3; for (let i = d; i < p.length; i += 3) s += p[i]; c = s / n; }
      S.pos[d] = c;
    }
    S.posSet = true;
  }

  const PANELS = [["axial", 2], ["coronal", 1], ["sagittal", 0]];
  function drawProjections() {
    const g = S.grid;
    if (!g || !S.shown) return;
    const tractA = +$("op-tracts").value, headA = +$("op-head").value, segA = +$("op-seg").value;
    const lk = S.seg && S.segs.length ? Med.labels.lookup(S.segs, S.visible) : null;
    for (const [plane, axis] of PANELS) {
      const view = Med.planeView(g, plane, false);
      const f = Math.max(1, Math.round(PROJ_PX / Math.max(view.w * (view.sx / Math.min(view.sx, view.sy)), view.h)));
      const k = Math.max(0, Math.min(view.depth - 1, Math.round((S.pos[axis] - g.lo[axis]) / g.step[axis])));
      // Background: black, the ticked segments filled at their opacity.
      let base = new Uint8ClampedArray(view.w * view.h * 4);
      for (let i = 3; i < base.length; i += 4) base[i] = 255;
      if (lk && segA > 0) Med.render.labels(Med.sampleSlice(S.seg, g, view, k, true), view.w, view.h, lk, { alpha: segA, mode: "fill" }, base);
      // Upsample to the panel's pixels (nearest), then the projection.
      const W = view.w * f, H = view.h * f, big = new Uint8ClampedArray(W * H * 4);
      for (let y = 0; y < H; y++) {
        const sy = Math.floor(y / f) * view.w;
        for (let x = 0; x < W; x++) {
          const s = (sy + Math.floor(x / f)) * 4, o = (y * W + x) * 4;
          big[o] = base[s]; big[o + 1] = base[s + 1]; big[o + 2] = base[s + 2]; big[o + 3] = 255;
        }
      }
      // The head's silhouette, skin-toned at its opacity (half strength: a
      // backdrop, not a wall).
      if (S.head && headA > 0) {
        const hk = `${f}|${g.dims}|${g.lo}|${S.head.name}|${$("head-space").value}`;
        if (!S.headSil) S.headSil = {};
        if (!S.headSil[plane] || S.headSil[plane].key !== hk)
          S.headSil[plane] = { key: hk, mask: SEL.silhouette(S.head.positions, S.head.mesh.indices, g, view, f) };
        const m = S.headSil[plane].mask, a = 0.5 * headA, c = HEAD_COLOR.map((v) => v * 255);
        for (let q = 0; q < m.length; q++) {
          if (!m[q]) continue;
          const o = q * 4;
          big[o] = (1 - a) * big[o] + a * c[0]; big[o + 1] = (1 - a) * big[o + 1] + a * c[1]; big[o + 2] = (1 - a) * big[o + 2] + a * c[2];
        }
      }
      // The line width in the panel's own pixels (it is drawn scaled to fit).
      const shownW = $(`proj-${plane}`).clientWidth || W;
      const width = +$("thick").value * (W / shownW);
      const key = `${f}|${width.toFixed(2)}`;
      if (!S.proj[plane] || S.proj[plane].key !== key) S.proj[plane] = { key, data: SEL.project(S.shown, S.shownRgb, g, view, f, width) };
      if (tractA > 0) SEL.composite(big, S.proj[plane].data, tractA);
      const c = $(`proj-${plane}`);
      Med.render.toCanvas(big, W, H, c);
      // Where the other two planes cut this one, and the edge letters.
      const ctx = c.getContext("2d");
      ctx.strokeStyle = "rgba(250, 204, 21, .55)";
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      const colX = ((S.pos[view.p.col] - g.lo[view.p.col]) / g.step[view.p.col] + 0.5) * f;
      const rowY = (view.h - ((S.pos[view.p.row] - g.lo[view.p.row]) / g.step[view.p.row] + 0.5)) * f;
      ctx.beginPath(); ctx.moveTo(colX, 0); ctx.lineTo(colX, H); ctx.moveTo(0, rowY); ctx.lineTo(W, rowY); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#fbbf24";
      ctx.font = `600 ${Math.max(11, Math.round(H / 22))}px system-ui, sans-serif`;   // by height: the panels share one
      ctx.textBaseline = "middle";
      const L = view.letters;
      ctx.textAlign = "center"; ctx.fillText(L.top, W / 2, 10); ctx.fillText(L.bottom, W / 2, H - 10);
      ctx.textAlign = "left"; ctx.fillText(L.left, 5, H / 2);
      ctx.textAlign = "right"; ctx.fillText(L.right, W - 5, H / 2);
      c.dataset.f = f;
    }
    equalProjectionHeights();
    R.redraw();
  }
  /** One height for the three projections (at most PROJ_MAX_H), each as wide
   *  as its aspect needs, together no wider than their row. A phone stacks
   *  them at full width instead (tract.css). */
  function equalProjectionHeights() {
    const row = $("proj"), canvases = PANELS.map(([p]) => $(`proj-${p}`));
    if (window.matchMedia("(max-width: 600px)").matches || !row.clientWidth) {
      canvases.forEach((c) => { c.style.height = ""; c.style.width = ""; });
      return;
    }
    const aspects = canvases.map((c) => (c.width && c.height ? c.width / c.height : 1));
    const gaps = 10 * (canvases.length - 1);
    const h = Math.min(PROJ_MAX_H, (row.clientWidth - gaps) / aspects.reduce((a, b) => a + b, 0));
    canvases.forEach((c, i) => { c.style.height = `${Math.floor(h)}px`; c.style.width = `${Math.floor(h * aspects[i])}px`; });
  }
  window.addEventListener("resize", equalProjectionHeights);

  for (const [plane] of PANELS) {
    // A click on a panel moves the other two planes there.
    $(`proj-${plane}`).addEventListener("click", (e) => {
      const g = S.grid, c = e.currentTarget;
      if (!g) return;
      const view = Med.planeView(g, plane, false), f = +c.dataset.f || 1;
      const r = c.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * c.width / f, y = ((e.clientY - r.top) / r.height) * c.height / f;
      S.pos[view.p.col] = g.lo[view.p.col] + g.step[view.p.col] * (x - 0.5);
      S.pos[view.p.row] = g.lo[view.p.row] + g.step[view.p.row] * (view.h - y - 0.5);
      drawProjections();
    });
  }

  // ==========================================================================
  // Info
  // ==========================================================================
  function infoRows() {
    const rows = [];
    if (S.file) {
      const ls = SEL.lengthStats(S.shown || S.base);
      rows.push(["Tracts", [
        ["File", `${S.file.name} (${S.file.format}, ${S.spaceUsed}${S.file.tagged ? "" : " " + (S.space === "auto" ? "auto" : "chosen")})`],
        ["In the file", `${fmt.int(SIMP.count(S.file))} streamlines, ${fmt.int(S.file.raw.length / 3)} points`],
        ["Simplified", S.sel ? SIMP.summary(S.prep, S.sel) : "no"],
        ["Within", S.seg ? `${S.visible.size} of ${S.segs.length} segments, ${$("crop").value === "clip" ? "clipped (pieces ≥ 5 mm)" : "passing through"}` : "everything (no segmentation)"],
        ["Direction", S.dir === "all" ? "all" : SEL.CLASSES[+S.dir].label],
        ["By direction", SEL.CLASSES.map((c, i) => `${c.label} ${fmt.int(S.classCounts[i])}`).join(" · ")],
        ["Shown", `${fmt.int(ls.n)} streamlines, ${fmt.int(ls.points)} points`],
        ["Length", ls.n ? `mean ${ls.mean.toFixed(1)} mm, median ${ls.median.toFixed(1)} mm, range ${ls.min.toFixed(1)}–${ls.max.toFixed(1)} mm` : "—"],
        ["Total length", `${fmt.int(Math.round(ls.total))} mm`],
      ]]);
    }
    const volRows = (v) => [["File", v.name], ["Matrix", v.dims.join(" × ") + (v.frames > 1 ? ` × ${v.frames}` : "")],
      ["Voxel size", fmt.mm(v.spacing)], ["Field of view", fmt.mm(v.dims.map((n, i) => n * v.spacing[i]))], ["Orientation", v.orientation()]];
    if (S.head) rows.push(["Head surface", [["File", S.head.name],
      ["Points", fmt.int(S.head.mesh.positions.length / 3)], ["Triangles", fmt.int(S.head.mesh.indices.length / 3)],
      ["Space", `${$("head-space").value}${S.head.tagged ? " (tagged)" : " (assumed)"}`]]]);
    if (S.seg) {
      const ticked = S.segs.filter((s) => S.visible.has(s.id));
      rows.push(["Segmentation", [...volRows(S.seg),
        ["Ticked", ticked.length ? ticked.map((s) => `${s.name} (${s.ml.toFixed(1)} mL)`).join(", ") : "none"]]]);
    }
    return rows;
  }
  function renderInfo() {
    $("info").innerHTML = infoRows().map(([title, rows]) => `<h3>${esc(title)}</h3><table class="kv">` +
      rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("") + `</table>`).join("");
    $("save-what").textContent = S.shown ? `${fmt.int(SIMP.count(S.shown))} streamlines: the ones shown.` : "";
  }

  // ==========================================================================
  // Save tracts
  // ==========================================================================
  function outName(ext) {
    const stem = Med.io.stem(S.file.name.replace(/\.(vtk|ply|trk|tck)$/i, "")).replace(/[^\w.-]+/g, "_");
    let seg = "";
    if (S.seg) {
      const ticked = S.segs.filter((s) => S.visible.has(s.id));
      seg = ticked.length === S.segs.length ? "_allsegs" : ticked.length <= 3
        ? "_" + ticked.map((s) => s.name.replace(/[^\w-]+/g, "")).join("-") : `_${ticked.length}segs`;
      seg += $("crop").value === "clip" ? "_clipped" : "_passing";
    }
    const dir = S.dir === "all" ? "" : "_" + SEL.CLASSES[+S.dir].key;
    return `${stem}${seg}${dir}${S.sel ? "_simplified" : ""}.${ext}`;
  }
  $("btn-save").addEventListener("click", () => guarded("Writing…", async () => {
    if (!S.shown || !SIMP.count(S.shown)) throw new Error("No streamline is shown.");
    const fmtSel = $("save-format").value;
    let blob;
    if (fmtSel === "vtk") blob = Med.vtk.writeLines(S.shown.positions, S.shown.offsets, outName("vtk"), true);
    else {
      let ref = S.seg;
      if (!ref) {
        const g = S.grid;
        ref = new Med.Volume({ dims: g.dims, data: new Uint8Array(1 * g.dims[0] * g.dims[1] * g.dims[2]),
                               affine: [g.step[0], 0, 0, g.lo[0], 0, g.step[1], 0, g.lo[1], 0, 0, g.step[2], g.lo[2], 0, 0, 0, 1] });
      }
      blob = TV.io.writeTrk(S.shown.positions, S.shown.offsets, ref);
    }
    const name = outName(fmtSel);
    ui.download(blob, name);
    status(`Saved ${name}: ${fmt.int(SIMP.count(S.shown))} streamlines, ${fmt.bytes(blob.size)}.`, "ok");
  }));

  // ==========================================================================
  // The report: the view, the three projections, the info
  // ==========================================================================
  /** The part of a canvas that differs from its corner colour, with a margin. */
  function contentBox(cv) {
    const w = cv.width, h = cv.height;
    const tmp = document.createElement("canvas");
    tmp.width = w; tmp.height = h;
    const tctx = tmp.getContext("2d");
    tctx.drawImage(cv, 0, 0);
    const px = tctx.getImageData(0, 0, w, h).data;
    const bg = [px[0], px[1], px[2]];
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y += 2)
      for (let x = 0; x < w; x += 2) {
        const o = (y * w + x) * 4;
        if (Math.abs(px[o] - bg[0]) + Math.abs(px[o + 1] - bg[1]) + Math.abs(px[o + 2] - bg[2]) > 24) {
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    if (x1 < 0) return [0, 0, w, h];
    const m = Math.round(0.04 * Math.max(x1 - x0, y1 - y0));
    x0 = Math.max(0, x0 - m); y0 = Math.max(0, y0 - m); x1 = Math.min(w, x1 + m); y1 = Math.min(h, y1 + m);
    return [x0, y0, x1 - x0, y1 - y0];
  }

  /** One page: title, the 3D view (cropped to what it shows), the three
   *  projections at one height, the direction key and the info -- its text
   *  made smaller until it fits. */
  function reportCanvas() {
    R.render();
    const portrait = $("report-page").value === "a4-portrait";
    const W = portrait ? 1240 : 1754, H = portrait ? 1754 : 1240, pad = 50, gap = 12;
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = "top";
    ctx.fillStyle = "#111"; ctx.font = "600 30px system-ui, sans-serif";
    ctx.fillText($("report-title").value || "Tracts", pad, pad);
    const now = new Date(), two = (v) => String(v).padStart(2, "0");
    const stamp = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}:${two(now.getMinutes())}`;
    ctx.font = "16px system-ui, sans-serif"; ctx.fillStyle = "#555";
    ctx.fillText(`MRI WLAB · Tract View · ${stamp}`, pad, pad + 40);
    let y = pad + 78;
    const inner = W - 2 * pad;

    // The 3D view and the projections: side by side (landscape) or stacked.
    const gl = $("gl"), box = contentBox(gl);
    const panels = PANELS.map(([p]) => $(`proj-${p}`));
    const aspects = panels.map((cv) => cv.width / cv.height);
    const viewBoxH = portrait ? Math.round(H * 0.34) : Math.round(H * 0.5);
    const viewBoxW = portrait ? inner : Math.round(inner * 0.42);
    const vs = Math.min(viewBoxW / box[2], viewBoxH / box[3]);
    const vw = Math.round(box[2] * vs), vh = Math.round(box[3] * vs);
    ctx.fillStyle = `rgb(${R.scene.background.map((v) => v * 255)})`;
    ctx.fillRect(pad, y, viewBoxW, vh);
    ctx.drawImage(gl, box[0], box[1], box[2], box[3], pad + (viewBoxW - vw) / 2, y, vw, vh);
    let px = pad, py = y + vh + gap, rowW = inner;
    if (!portrait) { px = pad + viewBoxW + 2 * gap; py = y; rowW = inner - viewBoxW - 2 * gap; }
    const ph = Math.min(portrait ? H * 0.2 : vh, (rowW - 2 * gap) / aspects.reduce((a, b) => a + b, 0));
    let x = px;
    panels.forEach((cv, i) => {
      const pw = ph * aspects[i];
      ctx.drawImage(cv, x, py, pw, ph);
      ctx.fillStyle = "#fff"; ctx.font = "600 14px system-ui, sans-serif";
      ctx.fillText(PANELS[i][0][0].toUpperCase() + PANELS[i][0].slice(1), x + 6, py + 6);
      x += pw + gap;
    });
    y = Math.max(y + vh, py + ph) + 20;

    // Direction key.
    ctx.font = "15px system-ui, sans-serif"; ctx.fillStyle = "#111";
    const key = S.colour === "local" ? "Colour: local direction (red L-R, green A-P, blue S-I)" : "Colour: direction class";
    ctx.fillText(key, pad, y);
    if (S.colour === "class") {
      let kx = pad + ctx.measureText(key).width + 16;
      for (const cl of SEL.CLASSES) {
        ctx.fillStyle = `rgb(${cl.color})`; ctx.fillRect(kx, y + 2, 14, 14);
        ctx.fillStyle = "#111"; ctx.fillText(cl.label, kx + 20, y);
        kx += 30 + ctx.measureText(cl.label).width;
      }
    }
    y += 32;

    // Info: two columns of key / value, the font shrunk until it fits.
    const blocks = infoRows(), colW = (inner - 30) / 2, keyW = 120;
    const wrap = (text, max) => {
      const lines = [];
      let line = "";
      for (const word of String(text).split(" ")) {
        const t = line ? line + " " + word : word;
        if (ctx.measureText(t).width > max && line) { lines.push(line); line = word; } else line = t;
      }
      if (line) lines.push(line);
      return lines;
    };
    const layout = (fs, draw) => {
      const cy = [y, y], lh = Math.round(fs * 1.35);
      for (const [title, rows] of blocks) {
        const col = cy[0] <= cy[1] ? 0 : 1, x0 = pad + col * (colW + 30);
        let yy = cy[col];
        ctx.font = `600 ${fs + 3}px system-ui, sans-serif`;
        if (draw) { ctx.fillStyle = "#111"; ctx.fillText(title, x0, yy); }
        yy += lh + 6;
        ctx.font = `${fs}px system-ui, sans-serif`;
        for (const [k, v] of rows) {
          if (draw) { ctx.fillStyle = "#666"; ctx.fillText(k, x0, yy); }
          for (const l of wrap(v, colW - keyW)) {
            if (draw) { ctx.fillStyle = "#111"; ctx.fillText(l, x0 + keyW, yy); }
            yy += lh;
          }
          yy += 2;
        }
        cy[col] = yy + 12;
      }
      return Math.max(...cy);
    };
    let fs = 14;
    while (fs > 9 && layout(fs, false) > H - pad) fs--;
    layout(fs, true);
    return c;
  }
  const reportName = (ext) => `${($("report-title").value || "tracts").replace(/[^\w.-]+/g, "_")}_view.${ext}`;
  $("btn-report").addEventListener("click", async () => {
    ui.status($("report-status"), "Composing…", "busy");
    await ui.busy();
    try {
      ui.download(await Viz.pdf.pdf(reportCanvas(), $("report-page").value, $("report-title").value || "Tracts"), reportName("pdf"));
      ui.status($("report-status"), `Saved ${reportName("pdf")}.`, "ok");
    } catch (e) { console.error(e); ui.status($("report-status"), e.message, "err"); }
  });
  $("btn-report-png").addEventListener("click", async () => {
    try { ui.download(await Viz.pdf.png(reportCanvas()), reportName("png")); ui.status($("report-status"), `Saved ${reportName("png")}.`, "ok"); }
    catch (e) { console.error(e); ui.status($("report-status"), e.message, "err"); }
  });

  // Auto-rotate: a slow turn about the screen's vertical axis, one frame at
  // a time while ticked; a drag on the view stops it.
  const SPIN_RAD_PER_S = 0.5;
  let spinLast = 0;
  function spin(t) {
    if (!$("spin").checked) return;
    const dt = spinLast ? Math.min(0.1, (t - spinLast) / 1000) : 0;
    spinLast = t;
    if (dt && R.bounds()) { R.rotateBy(SPIN_RAD_PER_S * dt, 0); R.render(); }
    requestAnimationFrame(spin);
  }
  $("spin").addEventListener("change", (e) => { spinLast = 0; if (e.target.checked) requestAnimationFrame(spin); });
  $("gl").addEventListener("pointerdown", () => { $("spin").checked = false; });

  renderDirTabs();
  applyOpacity();
  startDemo();
})();
