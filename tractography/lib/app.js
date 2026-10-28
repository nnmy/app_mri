/* ============================================================================
 * tractography/lib/app.js — the page: a DWI series in, whole-brain tracts out
 * ----------------------------------------------------------------------------
 * The tracking runs on the server (py/app.py, DIPY, through server.py): the
 * page reads the DWI volumes and gradient files only to check them (how many
 * volumes, how many b-values, one grid), uploads them, streams the log, then
 * shows the result itself: a preview of the streamlines in 3D (every k-th of
 * them, coloured by local direction) and the FA map with the tracking mask,
 * slice by slice. The full tract files are download links. The brain mask is
 * SynthStrip's (the default) or the lab's b6 one, which is used instead when
 * the server has no SynthStrip.
 * ========================================================================== */
(function () {
  "use strict";
  const { ui } = Viz;
  const { esc, fmt } = ui;
  const $ = (id) => document.getElementById(id);
  const svc = Viz.py.service("tractography");
  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

  const S = { dwi: [], volumes: 0, grid: null, grads: {}, serverOk: false, fa: null, faThr: 0.2 };
  const status = (t, kind) => ui.status($("status"), t, kind);
  const say = (line) => {
    const el = $("console");
    el.textContent += (el.textContent ? "\n" : "") + line;
    el.scrollTop = el.scrollHeight;
    $("sec-console").classList.remove("hidden");
  };

  // ==========================================================================
  // Input
  // ==========================================================================
  const dropDwi = ui.dropZone($("drop-dwi"), {
    title: "DWI volumes", sub: "3D NIfTI files, or one 4D NIfTI", multiple: true, directory: true, required: true,
    accept: ".nii,.gz",
    tip: "One 3D volume per gradient (taken in file-name order: …-DTI-00, -01, …), or one 4D volume. Shift-click to pick a folder.",
    async onFiles(files) {
      files = files.filter((f) => /\.nii(\.gz)?$/i.test(f.name)).sort((a, b) => collator.compare(a.name, b.name));
      S.dwi = []; S.volumes = 0;
      try {
        if (!files.length) throw new Error("No NIfTI file among them.");
        let ref = null, volumes = 0;
        for (const [i, f] of files.entries()) {
          status(`Reading ${i + 1} / ${files.length}: ${f.name}…`, "busy");
          await Med.tick();
          const v = await Med.io.readVolumeFile(f);
          if (files.length > 1 && v.frames > 1) throw new Error(`${f.name} is 4D: give 3D volumes, or one 4D file alone.`);
          if (ref && v.dims.join() !== ref.dims.join()) throw new Error(`${f.name} is ${v.dims.join("×")}, not ${ref.dims.join("×")} as ${files[0].name}.`);
          ref = ref || v;
          volumes += v.frames;
        }
        S.dwi = files; S.volumes = volumes; S.grid = ref;
        dropDwi.setInfo(files.length === 1 ? `${files[0].name} · ${volumes} volumes` : `${files.length} files · ${ref.dims.join("×")}`);
        status("");
      } catch (e) { dropDwi.clear(); status(e.message, "err"); }
      check();
    },
    onClear() { S.dwi = []; S.volumes = 0; check(); },
  });

  const dropGrad = ui.dropZone($("drop-grad"), {
    title: "Gradients", sub: ".bval + .bvec (FSL)", multiple: true, required: true,
    tip: "The b-values (one row or column) and the directions (three rows or columns), told apart by their shape, not their names.",
    async onFiles(files) {
      try {
        for (const f of files) {
          const g = shapeOf(await f.text(), f.name);
          S.grads[g.kind] = { file: f, n: g.n };
        }
        const { bval, bvec } = S.grads;
        dropGrad.setInfo([bval && `${bval.file.name} (${bval.n} b)`, bvec && `${bvec.file.name} (${bvec.n} dirs)`].filter(Boolean).join(" · "));
        status("");
      } catch (e) { status(e.message, "err"); }
      check();
    },
    onClear() { S.grads = {}; check(); },
  });

  /** A gradient file's kind from its shape: one row or column of numbers ->
   *  b-values, three -> directions. The server reads them again, fully. */
  function shapeOf(text, name) {
    const rows = text.split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim()).filter(Boolean)
      .map((l) => l.split(/[\s,;]+/).map(Number));
    if (!rows.length || rows.some((r) => r.length !== rows[0].length || !r.every(Number.isFinite)))
      throw new Error(`${name}: not a table of numbers.`);
    const nr = rows.length, nc = rows[0].length;
    if (nr === 1 || nc === 1) return { kind: "bval", n: nr * nc };
    if (nr === 3) return { kind: "bvec", n: nc };
    if (nc === 3) return { kind: "bvec", n: nr };
    throw new Error(`${name}: ${nr} × ${nc} numbers; a .bval (one row) or a .bvec (three rows) is needed.`);
  }

  /** Volumes against gradients: more volumes is fine (the extra are left out,
   *  as the lab's preprocessing does), fewer is not. */
  function check() {
    const { bval, bvec } = S.grads;
    let msg = "", kind = "";
    if (bval && bvec && bval.n !== bvec.n) { msg = `${bval.n} b-values but ${bvec.n} directions.`; kind = "err"; }
    else if (S.volumes && bval) {
      if (S.volumes < bval.n) { msg = `${S.volumes} volumes but ${bval.n} b-values.`; kind = "err"; }
      else if (S.volumes > bval.n) {
        msg = `${S.volumes} volumes, ${bval.n} b-values: the last ${S.volumes - bval.n} will be left out.`;
        kind = "ok";
      } else { msg = `${S.volumes} volumes, ${bval.n} b-values.`; kind = "ok"; }
    }
    if (msg || !$("status").classList.contains("err")) status(msg, kind);
    S.inputOk = S.dwi.length && bval && bvec && kind !== "err";
    ready();
  }
  const formats = () => ["vtk", "ply"].filter((f) => $(`fmt-${f}`).checked);
  const ready = () => { $("btn-run").disabled = !(S.inputOk && S.serverOk && formats().length); };
  $("fmt-vtk").addEventListener("change", ready);
  $("fmt-ply").addEventListener("change", ready);
  const maskChoice = () => $("brain-mask").value;
  const maskChanged = () => { $("ss-border").disabled = maskChoice() !== "synthstrip"; };
  $("brain-mask").addEventListener("change", maskChanged);

  // ==========================================================================
  // Run
  // ==========================================================================
  const num = (id) => {
    const el = $(id), v = Number(el.value);
    if (!Number.isFinite(v) || v < +el.min || v > +el.max) throw new Error(`${el.closest("label").firstChild.textContent.trim()}: ${el.min} to ${el.max}.`);
    return v;
  };

  $("btn-run").addEventListener("click", async () => {
    $("btn-run").disabled = true;
    $("console").textContent = "";
    $("sec-output").classList.add("hidden");
    try {
      const settings = [num("fa-thr"), num("seed-density"), num("step"), num("min-length")];
      const mask = [maskChoice(), maskChoice() === "synthstrip" ? num("ss-border") : +$("ss-border").defaultValue];
      status(`Uploading ${S.dwi.length + 2} files…`, "busy");
      const dwi = await svc.uploadMany(S.dwi);
      const grads = await svc.uploadMany([S.grads.bval.file, S.grads.bvec.file]);
      status("Tracking… (the console shows each step; about a minute on the server)", "busy");
      let shown = 0;
      const echo = (log) => {
        const lines = String(log || "").split("\n").filter(Boolean);
        lines.slice(shown).forEach(say);
        shown = lines.length;
      };
      const [log, result, files] = await svc.call("track", [dwi, grads, ...settings, formats(), ...mask, $("simplified").checked], (p) => echo(p[0]));
      echo(log);
      const byName = new Map(files.map((f) => [f.orig_name || f.path.split("/").pop(), f]));
      showOutput(result, byName);
      status("Fetching the preview…", "busy");
      S.faThr = result.settings.fa_thr;
      await showTracts(await svc.fetchFile(byName.get("preview.vtk")), result.streamlines);
      S.fa = await Med.io.readVolumeFile(await svc.fetchFile(byName.get("preview_fa.nii.gz")));
      tabs.set("3d"); showPane("3d");
      drawSlices();
      status(`Done: ${fmt.int(result.streamlines)} streamlines (${result.times.total_s} s).`, "ok");
    } catch (e) {
      console.error(e);
      say(`FAILED: ${e.message}`);
      status(e.message, "err");
    } finally { ready(); }
  });

  function showOutput(r, byName) {
    const rows = [
      ["Streamlines", `${fmt.int(r.streamlines)} (≥ ${r.settings.min_length_mm} mm)`],
      ...(r.simplified ? [["Simplified", `${fmt.int(r.simplified.streamlines)} (≥ ${r.simplified.settings.min_length_mm} mm, ` +
        `${Math.round(100 * r.simplified.settings.keep_fraction)} %)`]] : []),
      ["Brain mask", `${r.settings.brain_mask === "synthstrip" ? "SynthStrip" : "b6"}, ${fmt.int(r.mask_voxels.brain)} voxels`],
      ["Time", `${r.times.total_s} s`],
    ];
    $("summary").innerHTML = `<table class="kv">${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("")}</table>`;
    $("files").innerHTML = r.files.map((name) => {
      const f = byName.get(name);
      return f ? `<li><a href="${esc(svc.fileUrl(f))}" download="${esc(name)}">${esc(name)}</a>` +
                 `<span class="hint">${f.size ? fmt.bytes(f.size) : ""}</span></li>` : "";
    }).join("");
    $("sec-output").classList.remove("hidden");
  }

  // ==========================================================================
  // Viewer: the tracts in 3D, the FA map and tracking mask in slices
  // ==========================================================================
  const tabs = ui.tabs($("view-tabs"), [{ value: "3d", label: "Tracts (3D)" }, { value: "fa", label: "FA and tracking mask" }],
                       "3d", showPane);
  function showPane(v) {
    $("pane-3d").classList.toggle("hidden", v !== "3d");
    $("pane-fa").classList.toggle("hidden", v !== "fa");
    if (v === "3d" && R) R.redraw();
    // The slice panels size themselves from their container, which had no
    // width while hidden: lay them out again (sliceview redraws on resize).
    if (v === "fa") window.dispatchEvent(new Event("resize"));
  }

  let R = null;
  try { R = Med.gl3d.create($("gl")); }
  catch (e) { $("empty").textContent = e.message; }

  async function showTracts(file, total) {
    if (!R) return;
    const t = Med.vtk.parseLines(await Med.io.readBytes(file), file.name);
    if (t.space === "LPS") for (let i = 0; i < t.positions.length; i += 3) { t.positions[i] *= -1; t.positions[i + 1] *= -1; }
    const d = Med.tracts.resample(t, Med.tracts.DRAW_STEP_MM);
    R.setLines(d.positions, Med.tracts.localColours(d), Med.tracts.segments(d));
    applyLook();
    $("empty").classList.add("hidden");
    const n = Med.tracts.count(t);
    $("shown").textContent = n < total ? `${fmt.int(n)} of ${fmt.int(total)} streamlines shown` : `${fmt.int(n)} streamlines`;
    resetView();
  }
  function applyLook() {
    const L = R && R.scene.lines;
    if (!L) return;
    L.width = +$("thick").value;
    L.alpha = +$("opacity").value;
    R.redraw();
  }
  const resetView = () => {
    if (!R) return;
    R.orient([0, 1, 0], [0, 0, 1]);
    R.frame(R.scene.lines ? [R.scene.lines.lo, R.scene.lines.hi] : undefined);
    R.redraw();
  };
  $("thick").addEventListener("input", applyLook);
  $("opacity").addEventListener("input", applyLook);
  $("btn-reset").addEventListener("click", resetView);
  $("gl").addEventListener("dblclick", resetView);
  window.addEventListener("resize", () => R && R.redraw());

  const view = Med.sliceView.create($("slices"));
  view.clear("The FA map shows here after a run.");

  function drawSlices() {
    const F = S.fa, grid = Med.makeGrid(F), grey = Med.render.lut("gray", false), thr = S.faThr;
    view.set({
      grid, start: Med.sliceView.centreOf(F, grid),
      panels(v, k) {
        const fa = Med.sampleSlice(F, grid, v, k, false);
        const base = Med.render.image(fa, [0, 1], grey);
        const masked = base.slice();
        for (let i = 0; i < fa.length; i++)
          if (fa[i] >= thr) { masked[i * 4] = 0.45 * masked[i * 4] + 140; masked[i * 4 + 1] *= 0.55; masked[i * 4 + 2] *= 0.55; }
        const tip = (r, c) => `FA ${fmt.num(fa[r * v.w + c], 3)}`;
        return [{ tag: "FA", rgba: base, tip }, { tag: `FA ≥ ${thr}`, rgba: masked, tip }];
      },
      describe(v, k, r, c) {
        const w = Med.gridWorld(grid, Med.gridIndex(v, k, r, c));
        return `<b>RAS</b> (${w.map((x) => x.toFixed(1)).join(", ")}) mm`;
      },
    });
  }

  // ==========================================================================
  // Is the server there?
  // ==========================================================================
  (async () => {
    S.serverOk = await svc.available();
    $("server-state").textContent = S.serverOk ? "" : `Tractography runs on the server: ${Viz.py.START_HINT}.`;
    ready();
    if (!S.serverOk) return;
    // SynthStrip runs under its own interpreter: offered only when the server
    // finds it (tractography/py/synthstrip/VERSION.md); otherwise b6.
    const opt = $("brain-mask").querySelector('option[value="synthstrip"]');
    try {
      const [o] = await svc.call("options", []);
      opt.disabled = !o.synthstrip.available;
      if (!o.synthstrip.available) { opt.textContent += " — not installed"; $("brain-mask").title = o.synthstrip.message; }
    } catch (e) { opt.disabled = true; }
    if (opt.disabled && opt.selected) { $("brain-mask").value = "b6"; maskChanged(); }
  })();
})();
