/* ============================================================================
 * vol_3d/lib/app.js — the page: what is loaded, how it is drawn
 * ----------------------------------------------------------------------------
 * Inputs (any combination, at least one):
 *   volume         DICOM series, NIfTI or NRRD -> common/med/gl3d.js ray-casts it
 *   segmentation   NIfTI / NRRD label map -> one smooth surface per segment
 *                  (common/med/surface.js), named and coloured as in Volume Slices
 *   surfaces       legacy VTK PolyData files (common/med/io_vtk.js), each with its
 *                  own colour, opacity and coordinate space
 *   label names    an optional table naming and colouring the labels
 * Everything meets in world space (RAS mm), each file through its own
 * header, as the slice viewers do.
 *
 * The window sliders are percentages of the chosen range (1–99 % of the
 * non-zero voxels, or min–max); the texture holds the full range, so moving
 * a slider only redraws.
 * ========================================================================== */
(function () {
  "use strict";
  const { ui } = Viz;
  const { esc, fmt } = ui;
  const $ = (id) => document.getElementById(id);

  // Volumes are subsampled above this many voxels for the GPU (2 bytes each).
  const MAX_TEXTURE_VOXELS = 48e6;
  const MESH_COLORS = ["#f2d1b3", "#9ecae1", "#fdae6b", "#a1d99b", "#bcbddc", "#fc9272"];

  const S = {
    volume: null, series: null, stats: null, seg: null, table: null, segs: [], visible: new Set(),
    segAlpha: 1, smooth: 10, vtk: [], mode: "dvr", range: "p99", cmap: "gray",
  };
  const status = (t, kind) => ui.status($("status"), t, kind);

  let R;
  try {
    R = Med.gl3d.create($("gl"));
  } catch (e) {
    $("empty").textContent = e.message;
    status(e.message, "err");
    return;
  }
  R.opts.onRender = drawGizmo;

  // ==========================================================================
  // Inputs
  // ==========================================================================
  const dropVol = ui.dropZone($("drop-volume"), {
    title: "Volume", sub: "DICOM · NIfTI · NRRD", multiple: true, directory: true,
    tip: "The image to render: a DICOM series (files or folder; uncompressed), or one NIfTI / NRRD file.",
    onFiles: loadVolume,
    onClear() { S.volume = null; S.series = null; R.setVolume(null); $("series-row").classList.add("hidden"); refresh(true); },
  });
  const dropSeg = ui.dropZone($("drop-seg"), {
    title: "Segmentation", sub: "NIfTI · NRRD", accept: ".nii,.gz,.nrrd",
    tip: "A label map: each segment becomes a surface. 3D Slicer's .seg.nrrd brings its names and colours.",
    onFiles: loadSeg,
    onClear() { S.seg = null; S.segs = []; R.removeMeshes((m) => m.kind === "seg"); refresh(true); },
  });
  ui.dropZone($("drop-vtk"), {
    title: "Surfaces", sub: "VTK (.vtk), one or several", accept: ".vtk", multiple: true,
    tip: "Legacy VTK PolyData, e.g. a head or cortical surface, in world mm (RAS unless tagged SPACE=LPS).",
    onFiles: loadVtk,
    onClear() { S.vtk = []; R.removeMeshes((m) => m.kind === "vtk"); refresh(true); },
  });
  const dropLut = ui.dropZone($("drop-lut"), {
    title: "Label names", sub: "optional · CSV / ITK-SNAP / LUT", accept: ".csv,.tsv,.txt,.ctbl,.lut,.label",
    tip: "Names and colours for the label ids: CSV “id,name[,r,g,b]”, ITK-SNAP, or a FreeSurfer / 3D Slicer colour table.",
    async onFiles(files) {
      try {
        S.table = Med.labels.parseTable(await files[0].text());
        dropLut.setInfo(`${files[0].name} · ${S.table.size} labels`);
        if (S.seg) applySegColours();
      } catch (e) { status(e.message, "err"); }
    },
    onClear() { S.table = null; if (S.seg) applySegColours(); },
  });

  async function guarded(text, fn) {
    status(text, "busy");
    await ui.busy();
    try { await fn(); } catch (e) { console.error(e); status(e.message, "err"); }
  }

  async function loadVolume(files) {
    await guarded(`Reading ${files.length} file(s)…`, async () => {
      const res = await Med.io.readImageFiles(files, (t) => status(t, "busy"));
      if (res.volume) {
        S.series = null;
        $("series-row").classList.add("hidden");
        setVolume(res.volume);
        dropVol.setInfo(res.volume.name);
      } else {
        S.series = res.series;
        $("series").innerHTML = res.series.map((s, i) => `<option value="${i}">${esc(s.label)}</option>`).join("");
        $("series-row").classList.toggle("hidden", res.series.length < 2);
        dropVol.setInfo(`${files.length} file(s) · ${res.series.length} series`);
        setVolume(Med.dicom.build(res.series[0]));
      }
    });
  }
  $("series").addEventListener("change", (e) => guarded("Building the series…", async () => setVolume(Med.dicom.build(S.series[+e.target.value]))));

  function setVolume(vol) {
    const first = !R.bounds();
    S.volume = vol;
    S.stats = Med.stats(vol);
    uploadVolume();
    $("frame-row").classList.toggle("hidden", vol.frames < 2);
    $("frame").max = vol.frames - 1;
    $("frame").value = vol.frame;
    $("frame-val").textContent = `${vol.frame + 1} / ${vol.frames}`;
    refresh(first);
    status(`Volume ${vol.name}: ${vol.dims.join(" × ")}` + (R.scene.volume.step > 1 ? ` (drawn at every ${R.scene.volume.step}th voxel)` : "") + ".", "ok");
  }

  function uploadVolume() {
    const st = S.stats;
    R.setVolume(S.volume, st.min, st.max, MAX_TEXTURE_VOXELS);
    R.setLut(Med.render.lut(S.cmap, !!S.volume.invert));
    applyVolumeControls();
  }

  async function loadSeg(files) {
    const file = files[0];
    await guarded(`Reading ${file.name}…`, async () => {
      const vol = await Med.io.readVolumeFile(file);
      S.seg = vol;
      const grid = Med.makeGrid(vol);
      const stats = Med.labelStats(vol, grid);
      if (stats.ids.length > 2000) throw new Error(`${file.name}: ${stats.ids.length} labels — an image, not a segmentation? Put it in the Volume box.`);
      S.segStats = stats;
      S.visible = new Set(stats.ids);
      dropSeg.setInfo(file.name);
      await buildSurfaces();
    });
  }

  async function buildSurfaces() {
    if (!S.seg) return;
    const first = !R.bounds();
    R.removeMeshes((m) => m.kind === "seg");
    const t0 = performance.now();
    const res = await Med.surface.build(S.seg, S.smooth, (t) => status(t, "busy"));
    S.segMeshes = res.meshes;
    S.segs = Med.labels.segments(S.seg, S.segStats, S.table);
    for (const s of S.segs) {
      const m = res.meshes.get(s.id);
      if (!m) continue;
      const rec = R.addMesh(`seg${s.id}`, m.positions, m.normals, m.indices, s.color.map((c) => c / 255), S.segAlpha);
      rec.kind = "seg";
      rec.segId = s.id;
      rec.visible = S.visible.has(s.id);
      s.triangles = m.indices.length / 3;
    }
    refresh(first);
    const tris = S.segs.reduce((n, s) => n + (s.triangles || 0), 0);
    status(`${S.segs.length} segment surface(s), ${fmt.int(tris)} triangles` +
           (res.step > 1 ? ` (from every ${res.step}th voxel)` : "") +
           ` · ${((performance.now() - t0) / 1000).toFixed(1)} s.`, "ok");
  }

  function applySegColours() {
    S.segs = Med.labels.segments(S.seg, S.segStats, S.table);
    for (const m of R.scene.meshes) {
      if (m.kind !== "seg") continue;
      const s = S.segs.find((x) => x.id === m.segId);
      if (s) m.color = s.color.map((c) => c / 255);
    }
    renderSegTable();
    R.redraw();
  }

  async function loadVtk(files) {
    await guarded(`Reading ${files.length} surface file(s)…`, async () => {
      const first = !R.bounds();
      for (const f of files) {
        const mesh = Med.vtk.parse(new Uint8Array(await f.arrayBuffer()), f.name);
        const item = { mesh, space: mesh.space || "RAS", tagged: !!mesh.space,
                       color: MESH_COLORS[S.vtk.length % MESH_COLORS.length], alpha: 1, visible: true };
        item.id = `vtk${Date.now()}_${S.vtk.length}`;
        S.vtk.push(item);
        addVtkMesh(item);
      }
      refresh(first);
      status(`${S.vtk.length} surface file(s).`, "ok");
    });
  }

  function addVtkMesh(item) {
    R.removeMeshes((m) => m.id === item.id);
    const pos = Med.vtk.toRas(item.mesh, item.space);
    const rec = R.addMesh(item.id, pos, Med.surface.normals(pos, item.mesh.indices), item.mesh.indices,
                          hexToRgb(item.color), item.alpha);
    rec.kind = "vtk";
    rec.visible = item.visible;
  }

  const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  const rgbToHex = (rgb) => "#" + rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");

  // ==========================================================================
  // Volume controls
  // ==========================================================================
  const modeTabs = ui.tabs($("mode-tabs"), [
    { value: "dvr", label: "Volume" }, { value: "mip", label: "MIP" }, { value: "iso", label: "Isosurface" }, { value: "off", label: "Off" },
  ], S.mode, (v) => { S.mode = v; applyVolumeControls(); });

  /** The chosen range's ends, raw intensity. */
  function baseRange() {
    const st = S.stats;
    return S.range === "full" ? [st.min, st.max] : [st.p1, st.p99];
  }
  /** Slider percentage -> raw value and -> texture value (0..1 over min..max). */
  function fromPct(p) {
    const [lo, hi] = baseRange();
    return lo + (p / 100) * (hi - lo);
  }
  const toTex = (v) => (v - S.stats.min) / ((S.stats.max - S.stats.min) || 1);

  function applyVolumeControls() {
    document.querySelectorAll(".v3-dvr, .v3-mip, .v3-iso").forEach((el) => {
      const on = el.classList.contains(`v3-${S.mode}`);
      el.classList.toggle("hidden", !on);
    });
    if (!S.volume) return;
    let lo = +$("low").value, hi = +$("high").value;
    if (lo >= hi) hi = Math.min(100, lo + 0.5);
    const o = R.scene.vol;
    o.mode = S.mode;
    o.win = [toTex(fromPct(lo)), toTex(fromPct(hi))];
    o.opacity = +$("opacity").value;
    o.iso = toTex(fromPct(+$("iso").value));
    o.isoColor = hexToRgb($("iso-color").value);
    o.shade = $("shade").checked;
    o.quality = +$("quality").value;
    o.visible = S.mode !== "off";
    $("low-val").textContent = fmt.num(fromPct(lo), 1);
    $("high-val").textContent = fmt.num(fromPct(hi), 1);
    $("opacity-val").textContent = o.opacity.toFixed(3);
    $("iso-val").textContent = fmt.num(fromPct(+$("iso").value), 1);
    R.redraw();
  }
  ["low", "high", "opacity", "iso", "iso-color", "shade", "quality"].forEach((id) =>
    $(id).addEventListener("input", applyVolumeControls));
  $("range").addEventListener("change", (e) => { S.range = e.target.value; applyVolumeControls(); });
  $("cmap").addEventListener("change", (e) => {
    S.cmap = e.target.value;
    if (S.volume) R.setLut(Med.render.lut(S.cmap, !!S.volume.invert));
    R.redraw();
  });
  $("frame").addEventListener("input", (e) => {
    S.volume.frame = +e.target.value;
    $("frame-val").textContent = `${S.volume.frame + 1} / ${S.volume.frames}`;
    S.stats = Med.stats(S.volume);
    uploadVolume();
  });

  // ==========================================================================
  // Segments and surfaces tables
  // ==========================================================================
  function renderSegTable() {
    $("sec-segments").classList.toggle("hidden", !S.seg);
    if (!S.seg) return;
    $("seg-count").textContent = `${S.segs.length} · ${S.segs.reduce((a, s) => a + s.ml, 0).toFixed(1)} mL`;
    $("seg-table").innerHTML = `<table><thead><tr><th></th><th></th><th>Name</th><th>id</th><th>mL</th></tr></thead><tbody>` +
      S.segs.map((s) => `<tr data-id="${s.id}" class="${S.visible.has(s.id) ? "" : "off"}">` +
        `<td><input type="checkbox" data-id="${s.id}"${S.visible.has(s.id) ? " checked" : ""} aria-label="Show ${esc(s.name)}"></td>` +
        `<td><input type="color" data-id="${s.id}" value="${rgbToHex(s.color)}" aria-label="Colour of ${esc(s.name)}"></td>` +
        `<td class="name">${esc(s.name)}</td><td>${s.id}</td><td>${s.ml < 0.05 ? s.ml.toFixed(3) : s.ml.toFixed(1)}</td></tr>`).join("") +
      `</tbody></table>`;
  }
  $("seg-table").addEventListener("input", (e) => {
    const el = e.target, id = +el.dataset.id;
    if (el.type === "checkbox") {
      if (el.checked) S.visible.add(id); else S.visible.delete(id);
      el.closest("tr").classList.toggle("off", !el.checked);
    } else if (el.type === "color") {
      const s = S.segs.find((x) => x.id === id);
      s.color = hexToRgb(el.value).map((c) => Math.round(c * 255));
    }
    syncSegMeshes();
  });
  function syncSegMeshes() {
    for (const m of R.scene.meshes) {
      if (m.kind !== "seg") continue;
      const s = S.segs.find((x) => x.id === m.segId);
      m.visible = S.visible.has(m.segId);
      m.alpha = S.segAlpha;
      if (s) m.color = s.color.map((c) => c / 255);
    }
    R.redraw();
  }
  $("seg-all").addEventListener("click", () => { S.visible = new Set(S.segs.map((s) => s.id)); renderSegTable(); syncSegMeshes(); });
  $("seg-none").addEventListener("click", () => { S.visible = new Set(); renderSegTable(); syncSegMeshes(); });
  $("seg-alpha").addEventListener("input", (e) => {
    S.segAlpha = +e.target.value;
    $("seg-alpha-val").textContent = S.segAlpha.toFixed(2);
    syncSegMeshes();
  });
  let smoothTimer = null;
  $("smooth").addEventListener("input", (e) => {
    S.smooth = +e.target.value;
    $("smooth-val").textContent = S.smooth;
    clearTimeout(smoothTimer);
    smoothTimer = setTimeout(() => guarded("Rebuilding the surfaces…", buildSurfaces), 300);
  });

  function renderMeshTable() {
    $("sec-meshes").classList.toggle("hidden", !S.vtk.length);
    $("mesh-count").textContent = S.vtk.length ? String(S.vtk.length) : "";
    $("mesh-table").innerHTML = `<table><thead><tr><th></th><th></th><th>File</th><th>Opacity</th><th>Space</th><th></th></tr></thead><tbody>` +
      S.vtk.map((v, i) => `<tr data-i="${i}" class="${v.visible ? "" : "off"}">` +
        `<td><input type="checkbox" data-i="${i}" data-k="visible"${v.visible ? " checked" : ""} aria-label="Show"></td>` +
        `<td><input type="color" data-i="${i}" data-k="color" value="${v.color}" aria-label="Colour"></td>` +
        `<td class="name" title="${esc(v.mesh.title)}">${esc(v.mesh.name)}<br><span class="hint">${fmt.int(v.mesh.positions.length / 3)} points, ${fmt.int(v.mesh.indices.length / 3)} triangles</span></td>` +
        `<td><input type="range" data-i="${i}" data-k="alpha" min="0.05" max="1" step="0.05" value="${v.alpha}" aria-label="Opacity"></td>` +
        `<td><select data-i="${i}" data-k="space" aria-label="Coordinate space" title="${v.tagged ? "From the file's SPACE tag" : "Untagged: RAS assumed"}">` +
        `<option${v.space === "RAS" ? " selected" : ""}>RAS</option><option${v.space === "LPS" ? " selected" : ""}>LPS</option></select></td>` +
        `<td><button type="button" class="drop-x" data-i="${i}" data-k="remove" title="Remove" aria-label="Remove">×</button></td></tr>`).join("") +
      `</tbody></table>`;
  }
  $("mesh-table").addEventListener("input", (e) => {
    const el = e.target, v = S.vtk[+el.dataset.i], k = el.dataset.k;
    if (!v) return;
    const rec = R.scene.meshes.find((m) => m.id === v.id);
    if (k === "visible") { v.visible = el.checked; rec.visible = el.checked; el.closest("tr").classList.toggle("off", !el.checked); }
    if (k === "color") { v.color = el.value; rec.color = hexToRgb(el.value); }
    if (k === "alpha") { v.alpha = +el.value; rec.alpha = v.alpha; }
    if (k === "space") { v.space = el.value; addVtkMesh(v); }
    R.redraw();
  });
  $("mesh-table").addEventListener("click", (e) => {
    const el = e.target.closest('[data-k="remove"]');
    if (!el) return;
    const v = S.vtk.splice(+el.dataset.i, 1)[0];
    R.removeMeshes((m) => m.id === v.id);
    refresh(false);
  });

  // ==========================================================================
  // View
  // ==========================================================================
  const VIEWS = { A: [[0, 1, 0], [0, 0, 1]], P: [[0, -1, 0], [0, 0, 1]], L: [[-1, 0, 0], [0, 0, 1]],
                  R: [[1, 0, 0], [0, 0, 1]], S: [[0, 0, 1], [0, 1, 0]], I: [[0, 0, -1], [0, 1, 0]] };
  document.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => {
    R.orient(...VIEWS[b.dataset.view]);
    R.redraw();
  }));
  const resetView = () => { R.orient(...VIEWS.A); R.frame(); R.redraw(); };
  $("btn-reset").addEventListener("click", resetView);
  $("gl").addEventListener("dblclick", resetView);
  $("bg").addEventListener("change", (e) => {
    const white = e.target.value === "white";
    R.scene.background = white ? [1, 1, 1] : [0, 0, 0];
    $("stage").style.background = white ? "#fff" : "#000";
    R.redraw();
  });
  let spinning = false;
  $("spin").addEventListener("change", (e) => {
    spinning = e.target.checked;
    const tick = () => {
      if (!spinning) return;
      R.rotateBy(0.01, 0);
      R.render();
      requestAnimationFrame(tick);
    };
    if (spinning) requestAnimationFrame(tick);
  });
  $("btn-shot").addEventListener("click", () => {
    R.render();
    $("gl").toBlob((blob) => {
      if (!blob) { status("The browser could not capture the view.", "err"); return; }
      const base = Med.io.stem((S.volume || S.seg || (S.vtk[0] && S.vtk[0].mesh) || { name: "view" }).name);
      ui.download(blob, `${base.replace(/[^\w.-]+/g, "_")}_3d.png`);
    }, "image/png");
  });

  // Clip plane: a world axis, a position across what is shown, a side.
  function applyClip() {
    const axis = $("clip-axis").value;
    $("clip-pos").disabled = $("clip-flip").disabled = axis === "";
    if (axis === "") { R.scene.clip = null; $("clip-val").textContent = ""; R.redraw(); return; }
    const b = R.bounds();
    if (!b) return;
    const a = +axis, t = +$("clip-pos").value / 1000;
    const p = b[0][a] + t * (b[1][a] - b[0][a]);
    const s = $("clip-flip").checked ? -1 : 1;
    const plane = [0, 0, 0, -s * p];
    plane[a] = s;
    R.scene.clip = plane;
    $("clip-val").textContent = `${["x", "y", "z"][a]} ${p.toFixed(1)} mm`;
    R.redraw();
  }
  ["clip-axis", "clip-pos", "clip-flip"].forEach((id) => $(id).addEventListener("input", applyClip));

  /** The R/A/S axes as seen, bottom-left. */
  function drawGizmo() {
    const g = $("gizmo"), ctx = g.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    if (g.width !== 96 * dpr) { g.width = g.height = 96 * dpr; }
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
      const ex = 48 + a.sx * 30, ey = 48 - a.sy * 30;
      ctx.strokeStyle = a.c;
      ctx.beginPath(); ctx.moveTo(48, 48); ctx.lineTo(ex, ey); ctx.stroke();
      ctx.fillStyle = a.c;
      ctx.fillText(a.l, 48 + a.sx * 40, 48 - a.sy * 40);
    }
  }

  // ==========================================================================
  // After any change of inputs
  // ==========================================================================
  function refresh(reframe) {
    const any = !!(S.volume || S.seg || S.vtk.length);
    $("empty").classList.toggle("hidden", any);
    $("sec-volume").classList.toggle("hidden", !S.volume);
    $("vol-aside").textContent = S.volume ? `${S.volume.dims.join(" × ")}` : "";
    renderSegTable();
    renderMeshTable();
    renderDetails();
    if (reframe && any) { R.orient(...VIEWS.A); R.frame(); }
    applyVolumeControls();
    applyClip();
    R.redraw();
  }

  function renderDetails() {
    const blocks = [];
    const table = (title, rows) => `<h3>${esc(title)}</h3><table class="kv">` +
      rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("") + `</table>`;
    const volRows = (vol) => [["File", vol.name], ...Object.entries(vol.meta),
      ["Matrix", vol.dims.join(" × ") + (vol.frames > 1 ? ` × ${vol.frames}` : "")],
      ["Voxel size", fmt.mm(vol.spacing)], ["Orientation", vol.orientation()]];
    if (S.volume) {
      const V = R.scene.volume;
      blocks.push(table("Volume", [...volRows(S.volume),
        ["Values", `${fmt.num(S.stats.min, 2)} – ${fmt.num(S.stats.max, 2)}`],
        ["Drawn as", `${V.dims.join(" × ")} texture${V.step > 1 ? ` (every ${V.step}th voxel)` : ""}`]]));
    }
    if (S.seg) blocks.push(table("Segmentation", [...volRows(S.seg), ["Segments", String(S.segs.length)]]));
    for (const v of S.vtk)
      blocks.push(table(`Surface: ${v.mesh.name}`, [["Title", v.mesh.title], ["Points", fmt.int(v.mesh.positions.length / 3)],
        ["Triangles", fmt.int(v.mesh.indices.length / 3)], ["Space", `${v.space}${v.tagged ? " (tagged)" : " (assumed)"}`]]));
    $("details").innerHTML = `<div class="md-details">${blocks.join("")}</div>`;
    $("sec-details").classList.toggle("hidden", !blocks.length);
  }

  window.addEventListener("resize", () => R.redraw());
  applyVolumeControls();
})();
