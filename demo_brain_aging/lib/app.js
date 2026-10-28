/* ============================================================================
 * demo_brain_aging/lib/app.js — a younger and an older subject's tracts, side
 * by side (Nguyen, Kubota & Hirata, Neuroscience Informatics 2026, Fig. 6)
 * ----------------------------------------------------------------------------
 * The data (data/, prep/build_data.py): each subject's whole-brain tracts in
 * its NATIVE space, its native segmentation, the head surface, display
 * volumes (T1, T2, segmentation) on one grid in IXI051's b0 space, the
 * matrix that moves IXI518's tracts there, and measures.csv (per segment:
 * volume, tract count per direction class, from every streamline).
 *
 * Per subject, with one set of controls (lib/data.js loads them):
 *   base      the native tracts
 *   simplify  Tract View's simplification (common/med/tract_simplify.js),
 *             the same options for both
 *   label     the native segmentation's label under every point
 *   crop      within the ticked segments (pieces >= 20 mm, the paper's
 *             minimum; or passing through, or the whole head)
 *   classify  each streamline / piece by its dominant direction (the
 *             paper's eq. 2-4; Tract View's rule) -- in native space
 *   dir       the chosen class
 *   draw      moved to the common space, drawn in 3D (two renderers whose
 *             cameras follow each other, common/med/linked.js) and
 *             projected onto the slices
 *
 * The tabs: Tracts (3D) first (a direction bar over each view, which sets
 * the direction for both); Axial / Sagittal / Coronal (one Med.sliceView, a
 * panel per subject on the common grid), whose volumes are fetched when one
 * is first opened; Density and Directions, the charts drawn from
 * measures.csv for the ticked segments. "💾 Save" adds what the tab shows to
 * the saved list (common/js/savelist.js), exported as PDF or PNG
 * (common/js/report.js).
 * ========================================================================== */
(function () {
  "use strict";
  const { ui } = Viz;
  const { esc, fmt } = ui;
  const $ = (id) => document.getElementById(id);
  const SEL = Med.tractSelect, SIMP = Med.tractSimplify;

  const MIN_PIECE_MM = 20;                       // the paper's minimum tract length, applied to a piece in a segment
  const SUBJECT_COLORS = ["#4b5563", "#b4b9c1"]; // the density chart: grays (no clash with the direction colours)
  const DIR_COLORS = ["#a4524a", "#55dd88", "#4f73a8", "#a3a3a3"];   // L-R, A-P, S-I, Mixed (gray)
  const HEAD_COLOR = [0.91, 0.79, 0.69];
  const SEG_FILL_ALPHA = 0.45;                   // the segment slider's last step
  const SEG_SHOW = ["off", "boundary 1", "boundary 2", "boundary 3", "filled"];
  const FIG_ZOOM = 3;                            // a saved slice figure: grid pixels × this
  const TABS = [{ value: "3d", label: "Tracts (3D)" }, { value: "axial", label: "Axial" }, { value: "sagittal", label: "Sagittal" },
                { value: "coronal", label: "Coronal" }, { value: "density", label: "Density" }, { value: "dirs", label: "Directions" }];
  const CLASSES = SEL.CLASSES;

  const S = { man: null, table: null, subj: [], visible: new Set(), dir: "all", tab: "3d", grid: null,
              rows: [], groups: {}, last: [] };
  const subjName = (s) => `Subj. ${s.id}`;
  const ageName = (s) => (s.key === "young" ? "Younger" : "Older");
  const kind = (tab) => (Med.PLANES[tab] ? "2d" : tab);
  const status = (t, k) => ui.status($("status"), t, k);
  const progress = (t) => status(t, "busy");
  async function guarded(text, fn) {
    status(text, "busy");
    await ui.busy();
    try { await fn(); if ($("status").classList.contains("busy")) status("", ""); }
    catch (e) { console.error(e); status(e.message, "err"); }
  }

  // ==========================================================================
  // Segments: every label present, a group (161718) over its members
  // ==========================================================================
  /** The rows of the segment table: { id, name, color, members, group?, member? } --
   *  the paper's tissues only (a group over its members). */
  function buildRows() {
    const present = new Set();
    for (const s of S.subj) for (const id of Med.labelStats(s.segNative, Med.makeGrid(s.segNative)).ids) present.add(id);
    const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const given = new Map(S.man.rois.map((r) => [r.id, hex(r.color)]));
    const name = (id) => (S.table.get(id) && S.table.get(id).name) || `Label ${id}`;
    const color = (id) => given.get(id) || Med.labels.defaultColor(id);
    const wanted = new Set(S.man.rois.flatMap((r) => S.groups[r.id] || [r.id]));
    const groupOf = new Map();
    for (const [g, mem] of Object.entries(S.groups)) for (const m of mem) groupOf.set(m, +g);
    const rows = [], done = new Set();
    for (const id of [...present].sort((a, b) => a - b)) {
      if (id <= 0 || !wanted.has(id)) continue;
      const g = groupOf.get(id);
      if (g == null) { rows.push({ id, name: name(id), color: color(id), members: [id] }); continue; }
      if (done.has(g)) continue;
      done.add(g);
      const members = S.groups[g].filter((m) => present.has(m)), c = color(g);
      rows.push({ id: g, name: name(g), color: c, members, group: true });
      members.forEach((m, i) => rows.push({ id: m, name: name(m), color: c.map((v) => Math.round(v + (255 - v) * 0.18 * (i + 1))),
                                            members: [m], member: g }));
    }
    return rows;
  }
  const rowOf = (id) => S.rows.find((r) => r.id === id);
  const isTicked = (row) => row.members.every((m) => S.visible.has(m));
  /** The ticked segments as measured items: a whole group as one (not its members). */
  function tickedItems() {
    const out = [];
    for (const r of S.rows) {
      if (r.member != null && isTicked(rowOf(r.member))) continue;
      if (isTicked(r)) out.push(r);
    }
    return out;
  }
  const measure = (s, id) => s.measures[String(id)] || null;
  /** Tracts per cm³ for the direction chosen (all, or one class). */
  function density(s, id) {
    const m = measure(s, id);
    if (!m || !m.volume_cm3) return NaN;
    return (S.dir === "all" ? m.count : m.by_class[+S.dir]) / m.volume_cm3;
  }

  function renderSegTable() {
    const head = S.subj.map((s) => `<th>${esc(s.id)}</th>`).join("");
    $("seg-table").innerHTML = `<table><thead><tr><th></th><th></th><th>Name</th>${head}</tr></thead><tbody>` +
      S.rows.map((r) => {
        const on = isTicked(r);
        const cells = S.subj.map((s) => {
          const m = measure(s, r.id);
          return m ? `<td title="${m.volume_cm3.toFixed(1)} cm³, ${fmt.int(m.count)} tracts">${fmt.int(Math.round(density(s, r.id)))}</td>` : `<td>—</td>`;
        }).join("");
        return `<tr class="${on ? "" : "off"}${r.member != null ? " member" : ""}">` +
          `<td><input type="checkbox" data-id="${r.id}"${on ? " checked" : ""} aria-label="Show ${esc(r.name)}"></td>` +
          `<td><span class="md-sw" style="background:rgb(${r.color})"></span></td>` +
          `<td class="name">${esc(r.name)}</td>${cells}</tr>`;
      }).join("") + `</tbody></table>`;
  }
  let cropTimer = null;
  const segmentsChanged = () => {
    renderSegTable();
    if (isChart()) drawChart();
    clearTimeout(cropTimer);
    cropTimer = setTimeout(() => guarded("Selecting tracts…", async () => { await run("crop"); applyOpacity(); }), 120);
  };
  $("seg-table").addEventListener("change", (e) => {
    const box = e.target.closest("input[data-id]");
    if (!box) return;
    for (const m of rowOf(+box.dataset.id).members) if (box.checked) S.visible.add(m); else S.visible.delete(m);
    segmentsChanged();
  });
  $("seg-all").addEventListener("click", () => { S.visible = new Set(S.rows.flatMap((r) => r.members)); segmentsChanged(); });
  $("seg-none").addEventListener("click", () => { S.visible = new Set(); segmentsChanged(); });
  $("crop").addEventListener("change", segmentsChanged);

  // ==========================================================================
  // The pipeline, for both subjects
  // ==========================================================================
  const STAGES = ["simplify", "select", "label", "crop", "dir", "draw"];
  function simplifyOptions() {
    return { heal: $("heal").checked, healGapMm: +$("heal-gap").value || 2, healAngleDeg: +$("heal-angle").value || 45,
             minLengthMm: +$("minlen").value, keepPercent: +$("keep").value, smoothMm: +$("smooth").value };
  }
  async function run(stage) {
    const from = STAGES.indexOf(stage), at = (x) => from <= STAGES.indexOf(x);
    const o = simplifyOptions(), on = $("simplify").checked;
    for (const s of S.subj) {
      if (at("simplify") && on) {
        const key = `${o.heal}|${o.healGapMm}|${o.healAngleDeg}`;
        if (!s.prep || s.prepKey !== key) {
          s.prep = await SIMP.prepare(s.tracts, o, (t) => progress(`${s.id}: ${t}`));
          s.prepKey = key;
        }
      }
      if (at("select")) {
        if (on && s.prep) { s.sel = SIMP.select(s.prep, o); s.simplified = s.sel.tracts; }
        else { s.sel = null; s.simplified = s.tracts; }
      }
      if (at("label")) s.labels = SEL.pointLabels(s.simplified, s.segNative);
      if (at("crop")) {
        const mode = $("crop").value;
        if (mode === "all") s.cropped = s.simplified;
        else {
          const on8 = new Uint8Array(256);
          for (const id of S.visible) if (id < 256) on8[id] = 1;
          s.cropped = SEL.crop(s.simplified, s.labels, on8, mode, MIN_PIECE_MM).tracts;
        }
        s.cls = SEL.classify(s.cropped);
        s.counts = [0, 0, 0, 0];
        for (const c of s.cls) s.counts[c]++;
      }
      if (at("dir")) {
        const want = S.dir === "all" ? new Set([0, 1, 2, 3]) : new Set([+S.dir]);
        const r = SEL.byClass(s.cropped, s.cls, want);
        s.shown = r.tracts; s.shownCls = r.cls;
      }
      if (at("draw")) {
        // Into the common space, then a lighter copy for drawing.
        const common = { positions: s.identity ? s.shown.positions : DBA.data.transform(s.shown.positions, s.native_to_common),
                         offsets: s.shown.offsets };
        s.drawn = Med.tracts.resample(common, Med.tracts.DRAW_STEP_MM);
        s.rgb = SEL.colours(s.drawn, s.shownCls, $("colour").value);
        if (s.R) s.R.setLines(s.drawn.positions, s.rgb, SEL.segments(s.drawn));
        s.proj = {};
      }
    }
    if (at("select")) {
      $("simplify-aside").textContent = on ? `keep ${o.keepPercent} %, ≥ ${o.minLengthMm} mm${o.heal ? ", healed" : ""}` : "off";
      $("simplify-summary").textContent = on ? S.subj.map((s) => `${s.id}: ${SIMP.summary(s.prep, s.sel)}`).join(" · ") : "";
    }
    if (at("dir")) renderSideHeads();
    if (at("crop")) renderDirBars();
    if (at("draw")) { applyOpacity(); drawSlices(); }
  }

  // ==========================================================================
  // Direction
  // ==========================================================================
  const setDir = (v) => guarded("Filtering…", async () => {
    S.dir = v;
    $("dir").value = v;
    renderDirBars(); renderSegTable(); if (isChart()) drawChart();
    await run("dir");
  });
  $("dir").addEventListener("change", (e) => setDir(e.target.value));
  $("colour").addEventListener("change", () => guarded("Colouring…", () => run("draw")));
  function renderDirBars() { S.subj.forEach((s) => s.bar && s.bar.set(s.counts || [0, 0, 0, 0], S.dir)); }
  function renderSideHeads() {
    S.subj.forEach((s, i) => {
      $(`head3d-${i}`).innerHTML = `<b>${esc(subjName(s))}</b> · ${s.age} y <span class="hint">· ${fmt.int(SEL.count(s.shown))} tracts</span>`;
    });
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
    guarded(e.target.checked ? "Simplifying…" : "Showing every streamline…", () => run("simplify"));
  });
  ["minlen", "keep", "smooth"].forEach((id) => {
    $(id).addEventListener("input", showVal);
    $(id).addEventListener("change", () => guarded("Selecting…", () => run("select")));
  });
  ["heal", "heal-gap", "heal-angle"].forEach((id) => $(id).addEventListener("change", () => guarded("Simplifying…", () => run("simplify"))));

  // ==========================================================================
  // Display: opacity, thickness, segments, underlay, overlay
  // ==========================================================================
  function applyOpacity() {
    const t = +$("op-tracts").value, g = +$("op-seg").value, h = +$("op-head").value;
    $("op-tracts-val").textContent = t.toFixed(2);
    $("thick-val").textContent = `${$("thick").value} px`;
    $("seg-show-val").textContent = SEG_SHOW[+$("seg-show").value];
    $("op-seg-val").textContent = g.toFixed(2);
    $("op-head-val").textContent = h.toFixed(2);
    for (const s of S.subj) {
      if (!s.R) continue;
      const L = s.R.scene.lines;
      if (L) { L.alpha = t; L.visible = t > 0; L.width = +$("thick").value; }
      for (const m of s.R.scene.meshes) {
        if (m.isHead) { m.alpha = h; m.visible = h > 0; }
        else { m.alpha = g; m.visible = g > 0 && S.visible.has(m.segId); }
      }
      s.R.redraw();
    }
  }
  $("op-tracts").addEventListener("input", () => { applyOpacity(); drawSlices(); });
  $("seg-show").addEventListener("input", () => { applyOpacity(); drawSlices(); });
  $("op-seg").addEventListener("input", applyOpacity);
  $("op-seg").addEventListener("change", () => {
    if (+$("op-seg").value > 0 && S.subj.some((s) => !s.surfaces)) guarded("Building the segments' surfaces…", buildSurfaces);
  });
  $("op-head").addEventListener("input", applyOpacity);
  $("thick").addEventListener("input", applyOpacity);
  $("thick").addEventListener("change", () => { S.subj.forEach((s) => { s.proj = {}; }); drawSlices(); });
  $("underlay").addEventListener("change", drawSlices);
  $("overlay").addEventListener("change", drawSlices);

  // ==========================================================================
  // 2D: one slice view, a panel per subject on the common grid (loaded when
  // a slice tab is first opened)
  // ==========================================================================
  const sv = Med.sliceView.create($("slices"), { tabs: false, readout: false });
  const win = (v) => { const st = Med.stats(v); return [st.p1, st.p99]; };

  async function ensureSlices() {
    if (S.grid || S.loadingSlices) return;
    S.loadingSlices = true;
    await guarded("Loading the slices…", async () => {
      await DBA.data.loadSlices(S.subj);
      for (const s of S.subj) s.win = { t1: win(s.t1), t2: win(s.t2) };
      S.grid = Med.makeGrid(S.subj[0].t1);
      sv.set({ grid: S.grid, panels, start: Med.sliceView.centreOf(S.subj[0].t1, S.grid) });
    });
    S.loadingSlices = false;
  }

  function panels(view, k) {
    const und = $("underlay").value, over = $("overlay").value, segShow = +$("seg-show").value;
    const ta = +$("op-tracts").value;
    // The label rows (not a group's own row: its id is no label).
    const lk = Med.labels.lookup(S.rows.filter((r) => !r.group), S.visible);
    const lut = Med.render.lut("gray");
    S.last = S.subj.map((s) => {
      const n = view.w * view.h;
      const values = Med.sampleSlice(und === "t2" ? s.t2 : s.t1, S.grid, view, k, false);
      let rgba;
      if (und === "none") { rgba = new Uint8ClampedArray(n * 4); for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255; }
      else rgba = Med.render.image(values, s.win[und], lut);
      // The tracts first, the segments over them.
      let projData = null;
      if (over !== "none" && s.drawn) {
        const slab = over === "slice" ? { k, half: 0.5 } : null;
        const key = `${view.p.key}|${$("thick").value}|${over}${slab ? `|${k}` : ""}`;
        if (!s.proj[key]) {
          if (slab) for (const x of Object.keys(s.proj)) if (x.includes("|slice")) delete s.proj[x];   // one slice kept
          s.proj[key] = SEL.project(s.drawn, s.rgb, S.grid, view, 1, +$("thick").value, slab);
        }
        projData = s.proj[key];
        if (ta > 0) SEL.composite(rgba, projData, ta);
      }
      const lab = Med.sampleSlice(s.seg, S.grid, view, k, true);
      if (segShow === SEG_SHOW.length - 1) Med.render.labels(lab, view.w, view.h, lk, { alpha: SEG_FILL_ALPHA, mode: "both" }, rgba);
      else if (segShow > 0) Med.render.labels(lab, view.w, view.h, lk, { alpha: 1, mode: "outline", width: segShow }, rgba);
      return { s, values, lab, projData, rgba, und };
    });
    return S.last.map((p) => ({ tag: `${subjName(p.s)} · ${p.s.age} y`, rgba: p.rgba, tip: (row, col) => tipText(p, row * view.w + col) }));
  }
  function segName(l) { const r = rowOf(l); return r ? r.name : l ? `Label ${l}` : ""; }
  /** Hover: the image's value, the segment, and the tracts projected there when shown. */
  function tipText(p, i) {
    const v = p.values[i], l = p.lab[i], parts = [];
    if (p.und !== "none" && Number.isFinite(v)) parts.push(`${p.und.toUpperCase()} ${fmt.int(Math.round(v))}`);
    if (l) parts.push(segName(l));
    if (p.projData && p.projData.n[i]) parts.push(`${fmt.int(Math.round(p.projData.n[i]))} tracts${$("overlay").value === "slice" ? " crossing" : ""}`);
    return parts.join(" · ");
  }
  function drawSlices() { if (S.grid && kind(S.tab) === "2d") sv.draw(); }

  // ==========================================================================
  // 3D: two renderers, cameras linked
  // ==========================================================================
  let link = null;
  function setup3d() {
    S.subj.forEach((s, i) => {
      s.R = Med.gl3d.create($(`gl-${i}`));
      s.R.opts.onRender = () => drawGizmo(s.R, $(`gizmo-${i}`));
      s.bar = Med.dirbar.create($(`dirbar-${i}`), { classes: CLASSES, colors: DIR_COLORS, onPick: (v) => { if (v !== S.dir) setDir(v); } });
      const pos = Med.vtk.toRas(s.head, s.head.space || "RAS");
      const rec = s.R.addMesh("head", pos, Med.surface.normals(pos, s.head.indices), s.head.indices, HEAD_COLOR, +$("op-head").value);
      rec.isHead = true;
      $(`gl-${i}`).addEventListener("dblclick", resetView);
    });
    link = Med.linked.cameras(S.subj.map((s) => s.R));
  }
  function renderAgeLabels() {
    const on = $("age-labels").checked;
    S.subj.forEach((s, i) => {
      const el = $(`age-${i}`);
      el.querySelector("span").textContent = ageName(s);
      el.classList.toggle("hidden", !on);
    });
  }
  $("age-labels").addEventListener("change", renderAgeLabels);
  document.querySelectorAll(".db-age-x").forEach((b) => b.addEventListener("click", () => { $("age-labels").checked = false; renderAgeLabels(); }));

  async function buildSurfaces() {
    for (const s of S.subj) {
      if (s.surfaces) continue;
      const res = await Med.surface.build(s.segNative, 10, (t) => progress(`${s.id}: ${t}`));
      for (const r of S.rows) {
        const m = res.meshes.get(r.id);
        if (!m) continue;
        const pos = s.identity ? m.positions : DBA.data.transform(m.positions, s.native_to_common);
        const rec = s.R.addMesh(`seg${r.id}`, pos, Med.surface.normals(pos, m.indices), m.indices, r.color.map((c) => c / 255), +$("op-seg").value);
        rec.segId = r.id;
      }
      s.surfaces = true;
    }
    applyOpacity();
  }
  const VIEW_LEFT = [[-1, 0, 0], [0, 0, 1]];     // seen from the left, S up (the paper's sagittal views)
  function resetView() {
    for (const s of S.subj) s.R.orient(...VIEW_LEFT);
    const boxes = S.subj.map((s) => (s.R.scene.lines ? [s.R.scene.lines.lo, s.R.scene.lines.hi] : s.R.bounds()));
    link.frame(Med.linked.union(boxes));
  }
  $("btn-reset").addEventListener("click", resetView);

  function drawGizmo(R, g) {
    const ctx = g.getContext("2d"), dpr = window.devicePixelRatio || 1;
    if (g.width !== 96 * dpr) g.width = g.height = 96 * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, 96, 96);
    if (!R.bounds() || !R.cam.rot) return;
    gizmoInto(ctx, R, 48, 48, 30, 12);
  }
  function gizmoInto(ctx, R, cx, cy, len, font) {
    const [x, y, z] = R.cam.rot;
    const axes = [["R", [1, 0, 0], "#ef4444"], ["A", [0, 1, 0], "#22c55e"], ["S", [0, 0, 1], "#3b82f6"]]
      .map(([l, v, c]) => ({ l, c, sx: v[0] * x[0] + v[1] * x[1] + v[2] * x[2], sy: v[0] * y[0] + v[1] * y[1] + v[2] * y[2],
                             sz: v[0] * z[0] + v[1] * z[1] + v[2] * z[2] }))
      .sort((p, q) => p.sz - q.sz);
    ctx.save();
    ctx.lineWidth = 2.5;
    ctx.font = `600 ${font}px system-ui, sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (const a of axes) {
      ctx.strokeStyle = a.c;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + a.sx * len, cy - a.sy * len); ctx.stroke();
      ctx.fillStyle = a.c; ctx.fillText(a.l, cx + a.sx * len * 1.33, cy - a.sy * len * 1.33);
    }
    ctx.restore();
  }

  // ==========================================================================
  // Charts (the paper's Figs. 3, 4), from measures.csv, the ticked segments
  // ==========================================================================
  const subjLabel = (s) => `${subjName(s)} (${s.age} y)`;
  const isChart = () => S.tab === "density" || S.tab === "dirs";
  const dirNote = () => (S.dir === "all" ? "" : ` · ${CLASSES[+S.dir].label} only`);
  function drawChart(canvas, scale) {
    const items = tickedItems(), c = canvas || $("chart");
    const size = scale ? { scale, width: 900 } : {};
    if (S.tab === "density") {
      Viz.chart.grouped(c, {
        ...size, height: 360,
        title: `Tract density per segment${dirNote()}`, yLabel: "tracts / cm³",
        categories: items.map((r) => r.name),
        series: S.subj.map((s, i) => ({ label: subjLabel(s), color: SUBJECT_COLORS[i], values: items.map((r) => density(s, r.id)) })),
        format: (v) => fmt.int(Math.round(v)),
        tip: (i, j) => `${S.subj[j].id}: ${fmt.int(Math.round(density(S.subj[j], items[i].id)))} tracts/cm³`,
      });
    } else {
      Viz.chart.stacked(c, {
        ...size, height: 380,
        title: "Direction composition per segment (tracts)",
        parts: CLASSES.map((k, i) => ({ label: k.label, color: DIR_COLORS[i] })),
        panels: items.map((r) => ({
          title: r.name,
          bars: S.subj.map((s) => {
            const m = measure(s, r.id);
            return { label: subjName(s), sublabel: `${s.age} y`, top: m ? fmt.int(m.count) : "", parts: m ? m.by_class : [0, 0, 0, 0] };
          }),
        })),
        tip: (i, j, k) => {
          const m = measure(S.subj[j], items[i].id), n = m.by_class[k];
          return `${CLASSES[k].label}: ${fmt.int(n)} (${((100 * n) / (m.count || 1)).toFixed(1)} %)`;
        },
      });
    }
    return c;
  }
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (isChart()) drawChart(); S.subj.forEach((s) => s.R && s.R.redraw()); }, 150);
  });

  // ==========================================================================
  // Tabs: each shows its own controls; the slices load on the first visit
  // ==========================================================================
  const showControls = (k) => document.querySelectorAll("[data-show]").forEach((el) => el.classList.toggle("hidden", !el.dataset.show.split(" ").includes(k)));
  showControls(kind(S.tab));
  function showTab(v) {
    S.tab = v;
    const k = kind(v);
    ui.tip(null, null);
    $("pane-2d").classList.toggle("hidden", k !== "2d");
    $("pane-3d").classList.toggle("hidden", k !== "3d");
    $("pane-chart").classList.toggle("hidden", !isChart());
    showControls(k);
    if (k === "3d") { S.subj.forEach((s) => s.R && s.R.redraw()); if (!S.framed && link) { resetView(); S.framed = true; } }
    else if (k === "2d") { sv.setPlane(v); ensureSlices(); }
    else drawChart();
  }
  Viz.ui.tabs($("view-tabs"), TABS, S.tab, (v) => { if (S.subj.length) showTab(v); });

  // ==========================================================================
  // Figures, the saved list, the PDF's settings page
  // ==========================================================================
  const saved = Viz.saveList.create($("saved"), {
    stem: () => "demo_brain_aging",
    status,
    hint: "💾 Save adds what a tab shows",
    pdf: () => ({
      header: "APP_MRI - Brain Aging Demo", right: S.subj.map(subjLabel).join(" · "),
      title: "Brain aging: tracts of a younger and an older subject", infoPage: false,
      cite: `${S.man.paper.citation}. doi:${S.man.paper.doi}`,
    }),
  });

  function settingsLine() {
    const crop = $("crop").selectedOptions[0].textContent;
    const segs = $("crop").value === "all" ? "" : `: ${tickedItems().map((r) => r.name).join(", ") || "none"}`;
    const simp = $("simplify").checked ? `simplified (≥ ${$("minlen").value} mm, keep ${$("keep").value} %${$("heal").checked ? ", healed" : ""})` : "every streamline";
    const dir = S.dir === "all" ? "all directions" : `${CLASSES[+S.dir].label} only`;
    return `Tracts ${crop.toLowerCase()}${segs}; ${dir}; ${simp}.`;
  }
  const shownLine = () => S.subj.map((s) => `${s.id}: ${fmt.int(SEL.count(s.shown))} tracts shown`).join(", ");

  function figure2d() {
    const p = Med.PLANES[S.tab], view = Med.planeView(S.grid, S.tab, false);
    const canvases = [...$("slices").querySelectorAll("canvas.md-slice")];
    const fw = Math.round(view.w * (view.sx / Math.min(view.sx, view.sy)) * FIG_ZOOM);
    const fh = Math.round(view.h * (view.sy / Math.min(view.sx, view.sy)) * FIG_ZOOM);
    const pad = 24, gap = 18, head = 34;
    const c = document.createElement("canvas");
    c.width = pad * 2 + fw * canvases.length + gap * (canvases.length - 1);
    c.height = pad + head + fh + pad;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingEnabled = false;
    canvases.forEach((cv, i) => {
      const x = pad + i * (fw + gap), s = S.subj[i];
      ctx.fillStyle = "#111827"; ctx.font = "600 17px system-ui, sans-serif"; ctx.textBaseline = "top";
      ctx.fillText(`${subjName(s)} · ${s.age} y`, x, pad);
      ctx.drawImage(cv, x, pad + head, fw, fh);
      ctx.fillStyle = "#fbbf24"; ctx.font = "600 13px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(view.letters.top, x + fw / 2, pad + head + 10); ctx.fillText(view.letters.bottom, x + fw / 2, pad + head + fh - 10);
      ctx.textAlign = "left"; ctx.fillText(view.letters.left, x + 5, pad + head + fh / 2);
      ctx.textAlign = "right"; ctx.fillText(view.letters.right, x + fw - 5, pad + head + fh / 2);
      ctx.textAlign = "left";
    });
    const k = sv.slice();
    const und = $("underlay").selectedOptions[0].textContent, over = $("overlay").value, proj = over !== "none";
    const title = `${p.title} · ${und}${proj ? ` · tracts ${over === "slice" ? "crossing the slice" : "projected"}` : ""}${k != null ? ` · slice ${k}` : ""}`;
    return { title, caption: [settingsLine(), `Segments: ${SEG_SHOW[+$("seg-show").value]}.${proj ? ` ${shownLine()}.` : ""}`], canvas: c };
  }

  function figure3d() {
    const pad = 22, gap = 16, head = 30, bar = 22;
    S.subj.forEach((s) => s.R.render());
    const gls = S.subj.map((s, i) => $(`gl-${i}`));
    const w = Math.max(...gls.map((g) => g.width)), h = Math.max(...gls.map((g) => g.height));
    const c = document.createElement("canvas");
    c.width = pad * 2 + w * gls.length + gap * (gls.length - 1);
    c.height = pad + head + bar + 8 + h + pad;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    S.subj.forEach((s, i) => {
      const x = pad + i * (w + gap);
      ctx.fillStyle = "#111827"; ctx.font = "600 18px system-ui, sans-serif"; ctx.textBaseline = "top";
      ctx.fillText(`${subjName(s)} · ${s.age} y · ${fmt.int(SEL.count(s.shown))} tracts shown`, x, pad);
      Med.dirbar.draw(ctx, x, pad + head, w, bar, s.counts, CLASSES, S.dir, DIR_COLORS);
      ctx.drawImage(gls[i], x, pad + head + bar + 8);
      if ($("age-labels").checked) {
        const fs = Math.round(Math.max(22, w / 18));
        ctx.save();
        ctx.fillStyle = "#fff"; ctx.font = `700 ${fs}px system-ui, sans-serif`; ctx.textBaseline = "top";
        ctx.shadowColor = "rgba(0,0,0,.8)"; ctx.shadowBlur = 4;
        ctx.fillText(ageName(s), x + 14, pad + head + bar + 8 + 12);
        ctx.restore();
      }
      gizmoInto(ctx, s.R, x + 52, pad + head + bar + 8 + h - 52, 32, 14);
    });
    const title = `Tracts (3D) · ${S.dir === "all" ? "all directions" : CLASSES[+S.dir].label}`;
    return { title, caption: [settingsLine(), "The bars: each subject's direction composition of the tracts within the segments."], canvas: c };
  }

  function figureChart() {
    const c = drawChart(document.createElement("canvas"), 2);
    const segs = `Segments: ${tickedItems().map((r) => r.name).join(", ") || "none"}.`;
    const note = `Every streamline (before simplification), pieces ≥ ${MIN_PIECE_MM} mm inside each segment, native space.`;
    return S.tab === "density"
      ? { title: `Tract density per segment${dirNote()}`, caption: [segs, note], canvas: c }
      : { title: "Direction composition per segment", caption: [segs, `${note} Direction by the mean unit step, τ = ${S.man.tau}.`], canvas: c };
  }

  $("btn-save").addEventListener("click", () => guarded("Saving…", async () => {
    const k = kind(S.tab);
    if (k === "2d" && !S.grid) return;
    const fig = k === "3d" ? figure3d() : k === "2d" ? figure2d() : figureChart();
    saved.add(fig);
    $("saved").classList.remove("hidden");
    const b = $("btn-save");
    b.textContent = "✓ Saved";
    clearTimeout(b._t);
    b._t = setTimeout(() => { b.textContent = "💾 Save"; }, 1400);
    status("", "");
  }));



  function renderMethod() {
    const m = S.man;
    $("method").innerHTML = `<ul>${m.method.ours.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` +
      `<p><b>Differences from the paper</b></p><ul>${m.method.differences.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
  }


  // ==========================================================================
  // Start: the 3D tab's objects only; the rest when its tab is opened
  // ==========================================================================
  (async () => {
    if (location.protocol === "file:") { status("Open this page through the site's server (python server.py): it fetches its data.", "err"); return; }
    try {
      progress("Loading the tracts…");
      const d = await DBA.data.load("data/", progress);
      S.man = d.man; S.table = d.table; S.subj = d.subjects;
      S.groups = Object.fromEntries(Object.entries(S.man.groups).map(([k, v]) => [+k, v]));
      S.rows = buildRows();
      S.visible = new Set(S.man.rois.flatMap((r) => S.groups[r.id] || [r.id]));   // the paper's four tissues
      renderMethod(); renderSegTable(); renderAgeLabels();
      try { setup3d(); }
      catch (e) { $("pane-3d").innerHTML = `<p class="status err">${esc(e.message)}</p>`; }
      await run("simplify");
      showTab(S.tab);
      Viz.scrollPad(document.querySelector(".sec-viewer"), { margin: 0.25 });
      status("", "");
    } catch (e) { console.error(e); status(e.message, "err"); }
  })();
})();
