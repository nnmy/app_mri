/* ============================================================================
 * dwi_4d/lib/app.js — the page: DWI volumes in, 4D or 3D out
 * ----------------------------------------------------------------------------
 * Input: NIfTI files -- several 3D volumes (one per gradient), one 4D
 * volume, or several 4D runs -- taken in natural file-name order (DTI-2
 * before DTI-10), every frame one "volume" of the table. Gradients: one
 * .bval / .bvec pair (or an MRtrix table) for all of them, or one pair per
 * file (matched by name). Without b-values the b0s are guessed from the
 * signal (a b0 is the brightest).
 *
 * The user keeps or drops volumes (table, shell chips, the sphere, "reduce
 * each shell to n best-spread directions") and says what to do with
 * several b0s (keep all / the first / their mean). Written: one 4D NIfTI,
 * or one 3D NIfTI per volume (zipped, named by a pattern: {name}, {index},
 * {n}, {source}, {frame}, {b}, each optionally zero-padded as {index:03})
 * -- with the matching .bval / .bvec.
 *
 * The viewer: the gradients on a sphere (the first tab), or the picked
 * volume's axial / coronal / sagittal slices.
 * The data keep their type when nothing is averaged and every input shares
 * it; otherwise they are written as float32 values.
 * ========================================================================== */
(function () {
  "use strict";
  const { ui } = Viz;
  const { esc, fmt } = ui;
  const $ = (id) => document.getElementById(id);
  const G = DW.grad;

  // A volume counts as a guessed b0 when its mean signal is at least this
  // share of the brightest volume's (a b ≈ 1000 volume has a third or so).
  const B0_GUESS_SHARE = 0.75;
  // Inputs whose affines differ by more than this (mm, or direction cosine)
  // do not share a grid.
  const AFFINE_TOLERANCE = 1e-3;

  const S = { sources: [], entries: [], grads: [], pick: -1, urls: [] };
  const status = (t, kind) => ui.status($("status"), t, kind);
  const gstatus = (t, kind) => ui.status($("grad-status"), t, kind);

  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  const stem = (name) => String(name).replace(/\.(nii\.gz|nii|nrrd|gz)$/i, "");
  const gradStem = (name) => String(name).replace(/\.(bvals?|bvecs?|txt|b)$/i, "").replace(/[._-]?(bvals?|bvecs?)$/i, "");

  // ==========================================================================
  // Input
  // ==========================================================================
  const dropDwi = ui.dropZone($("drop-dwi"), {
    title: "DWI volumes", sub: "3D NIfTI files, or one 4D NIfTI", multiple: true, required: true, accept: ".nii,.gz,.nrrd",
    tip: "Several 3D volumes (one per gradient: taken in file-name order), one 4D volume, or several 4D runs (joined in order).",
    onFiles: (files) => guarded(`Reading ${files.length} file(s)…`, async () => {
      files = files.filter((f) => /\.(nii|nii\.gz|nrrd)$/i.test(f.name));
      if (!files.length) throw new Error("No NIfTI / NRRD file among them.");
      files.sort((a, b) => collator.compare(a.name, b.name));
      const sources = [];
      for (const [i, f] of files.entries()) {
        status(`Reading ${i + 1} / ${files.length}: ${f.name}…`, "busy");
        await Med.tick();
        sources.push({ file: f, vol: await Med.io.readVolumeFile(f) });
      }
      checkGrid(sources);
      S.sources = sources;
      buildEntries();
      dropDwi.setInfo(sources.length === 1 ? `${files[0].name} · ${sources[0].vol.frames} volumes` : `${sources.length} files · ${S.entries.length} volumes`);
      $("out-format").value = S.entries.length > 1 && sources.length === 1 ? "3d" : "4d";
      $("out-name").value = defaultName();
      status(`${S.entries.length} volume(s) of ${sources[0].vol.dims.join(" × ")} voxels, ${fmt.mm(sources[0].vol.spacing)}.`, "ok");
    }),
    onClear() { S.sources = []; S.entries = []; refresh(); status(""); },
  });
  const dropGrad = ui.dropZone($("drop-grad"), {
    title: "Gradients", sub: ".bval + .bvec (FSL), or MRtrix", multiple: true,
    tip: "One .bval and one .bvec for all the volumes (in order), or one pair per file (same name stem); an MRtrix table (x y z b per row) also works. Told apart by their shape, not their names.",
    onFiles: (files) => guarded("Reading the gradients…", async () => {
      const grads = [];
      for (const f of files) grads.push({ name: f.name, stem: gradStem(f.name), ...G.parse(await f.text(), f.name) });
      S.grads = grads;
      dropGrad.setInfo(files.map((f) => f.name).join(", "));
      buildEntries();
    }),
    onClear() { S.grads = []; buildEntries(); },
  });

  async function guarded(text, fn) {
    status(text, "busy");
    await ui.busy();
    try {
      await fn();
      if ($("status").classList.contains("busy")) status("", "");     // a step that set no message of its own
    } catch (e) { console.error(e); status(e.message, "err"); }
  }

  /** All inputs must share one grid: same matrix, (nearly) same affine. */
  function checkGrid(sources) {
    const a = sources[0].vol;
    for (const s of sources.slice(1)) {
      const v = s.vol;
      if (v.dims.some((n, i) => n !== a.dims[i]))
        throw new Error(`${s.file.name} is ${v.dims.join(" × ")}, ${sources[0].file.name} is ${a.dims.join(" × ")}: the volumes must share one grid.`);
      const d = Math.max(...v.affine.map((x, i) => Math.abs(x - a.affine[i])));
      if (d > AFFINE_TOLERANCE) throw new Error(`${s.file.name} is placed differently from ${sources[0].file.name} (affines differ by ${d.toFixed(3)}): not one series.`);
    }
  }

  /** One file: its name. Several: the part their names share
   *  (IXI034-…-DTI-00_processed, -01_processed … -> IXI034-…-DTI). */
  function defaultName() {
    const stems = S.sources.map((x) => stem(x.file.name));
    if (stems.length === 1) return stems[0];
    let p = stems[0];
    for (const t of stems) while (!t.startsWith(p)) p = p.slice(0, -1);
    p = p.replace(/[-_. ]*\d*$/, "").replace(/[-_. ]+$/, "");
    return p || stems[0];
  }

  // ==========================================================================
  // The volumes and their gradients
  // ==========================================================================
  /** One mean over a frame's voxels (strided). */
  function meanOf(vol, frame) {
    vol.frame = frame;
    const step = Math.max(1, Math.floor(vol.nvox / 400000));
    let s = 0, n = 0;
    for (let i = 0; i < vol.nvox; i += step) { const v = vol.value(i); if (v === v) { s += v; n++; } }
    vol.frame = 0;
    return n ? s / n : 0;
  }

  function buildEntries() {
    const keep = new Map(S.entries.map((e) => [e.key, e.keep]));
    const entries = [];
    for (const [si, src] of S.sources.entries())
      for (let f = 0; f < src.vol.frames; f++) {
        const key = `${si}:${f}`;
        entries.push({ key, src: si, frame: f, index: entries.length, b: null, dir: null,
                       name: src.vol.frames > 1 ? `${src.file.name} [${f}]` : src.file.name,
                       mean: meanOf(src.vol, f), keep: keep.has(key) ? keep.get(key) : true });
      }
    assignGradients(entries);
    // b0: from b, else from a zero direction, else guessed from the signal.
    const top = Math.max(...entries.map((e) => e.mean), 1e-9);
    for (const e of entries) {
      if (e.b != null) { e.shell = G.shellOf(e.b); e.guessed = false; }
      else if (e.dir) { e.shell = Math.hypot(...e.dir) < 1e-6 ? 0 : -1; e.guessed = false; }
      else { e.shell = e.mean >= B0_GUESS_SHARE * top ? 0 : -1; e.guessed = true; }
    }
    S.entries = entries;
    refresh();
  }

  /** Gradients onto entries; a clear message when the counts disagree. */
  function assignGradients(entries) {
    gstatus("");
    if (!S.grads.length || !entries.length) return;
    const bvals = S.grads.filter((g) => g.bvals), bvecs = S.grads.filter((g) => g.bvecs);
    const apply = (list, from, field) => {
      list.forEach((v, i) => {
        const e = from[i];
        if (field === "b") e.b = v; else e.dir = v.slice(0, 3);
      });
    };
    const errors = [];
    const perFile = S.sources.length > 1 && (bvals.length > 1 || bvecs.length > 1);
    if (perFile) {
      // One pair per source file, matched by name stem.
      for (const [si, src] of S.sources.entries()) {
        const st = stem(src.file.name).toLowerCase();
        const mine = entries.filter((e) => e.src === si);
        const bv = bvals.find((g) => g.stem.toLowerCase() === st), bc = bvecs.find((g) => g.stem.toLowerCase() === st);
        if (bv) { if (bv.bvals.length === mine.length) apply(bv.bvals, mine, "b"); else errors.push(`${bv.name}: ${bv.bvals.length} b-values for ${mine.length} volume(s) of ${src.file.name}`); }
        if (bc) { if (bc.bvecs.length === mine.length) apply(bc.bvecs, mine, "dir"); else errors.push(`${bc.name}: ${bc.bvecs.length} directions for ${mine.length} volume(s) of ${src.file.name}`); }
        if (!bv && !bc) errors.push(`no gradient file named like ${src.file.name}`);
      }
    } else {
      if (bvals.length > 1 || bvecs.length > 1) errors.push("several b-value or direction files for one series: give one of each");
      const bv = bvals[0], bc = bvecs[0];
      if (bv) { if (bv.bvals.length === entries.length) apply(bv.bvals, entries, "b"); else errors.push(`${bv.name} (${bv.kind}) has ${bv.bvals.length} b-values for ${entries.length} volumes`); }
      if (bc) { if (bc.bvecs.length === entries.length) apply(bc.bvecs, entries, "dir"); else errors.push(`${bc.name} (${bc.kind}) has ${bc.bvecs.length} directions for ${entries.length} volumes`); }
    }
    if (errors.length) gstatus(`Gradients not used where they disagree: ${errors.join("; ")}.`, "err");
    else gstatus(`Gradients: ${S.grads.map((g) => `${g.name} (${g.kind})`).join(", ")}.`, "ok");
  }

  // ==========================================================================
  // What is written
  // ==========================================================================
  /** The output volumes in order: { entries:[..] (one, or the b0s averaged) }. */
  function outputs() {
    const mode = $("b0-mode").value, out = [];
    let b0Out = null;
    for (const e of S.entries) {
      if (!e.keep) continue;
      if (e.shell === 0 && mode !== "all") {
        if (!b0Out) { b0Out = { entries: [e] }; out.push(b0Out); }
        else if (mode === "mean") b0Out.entries.push(e);
        continue;
      }
      out.push({ entries: [e] });
    }
    return out;
  }

  function refresh() {
    const any = S.entries.length > 0;
    ["sec-volumes", "sec-output"].forEach((id) => $(id).classList.toggle("hidden", !any));
    renderShells();
    renderTable();
    renderMetrics();
    renderSphere();
    renderOutWhat();
    if (any && S.pick < 0) preview(0);
    if (!any) S.pick = -1;
  }

  function renderShells() {
    const shells = new Map();
    for (const e of S.entries) {
      if (e.shell < 0) continue;
      if (!shells.has(e.shell)) shells.set(e.shell, { n: 0, kept: 0 });
      const s = shells.get(e.shell);
      s.n++; if (e.keep) s.kept++;
    }
    const keys = [...shells.keys()].sort((a, b) => a - b);
    const nz = keys.filter((k) => k > 0);
    $("shell-row").innerHTML = keys.length ? `<span class="ctl-label">Shells</span>` + keys.map((k) => {
      const s = shells.get(k), color = k === 0 ? "#9ca3af" : DW.sphere.SHELL_COLORS[nz.indexOf(k) % DW.sphere.SHELL_COLORS.length];
      return `<label class="dw-chip"><input type="checkbox" data-shell="${k}"${s.kept ? " checked" : ""}${s.kept && s.kept < s.n ? ' data-partial="1"' : ""}>` +
             `<span class="sw" style="background:${color}"></span>b = ${k} <span class="hint">${s.kept}/${s.n}</span></label>`;
    }).join("") : "";
    $("shell-row").querySelectorAll("[data-partial]").forEach((el) => { el.indeterminate = true; });
    $("reduce-row").classList.toggle("hidden", !S.entries.some((e) => e.dir && e.shell > 0));
  }
  $("shell-row").addEventListener("change", (e) => {
    const box = e.target.closest("input[data-shell]");
    if (!box) return;
    for (const en of S.entries) if (en.shell === +box.dataset.shell) en.keep = box.checked;
    refresh();
  });

  function renderTable() {
    $("vol-count").textContent = S.entries.length ? `${S.entries.filter((e) => e.keep).length} of ${S.entries.length} kept` : "";
    const f3 = (v) => (v >= 0 ? " " : "") + v.toFixed(3);
    $("vol-table").innerHTML = `<table><thead><tr><th></th><th>#</th><th>Volume</th><th>b</th><th>Direction</th><th>Mean</th></tr></thead><tbody>` +
      S.entries.map((e) => `<tr data-i="${e.index}" class="${[e.keep ? "" : "off", e.index === S.pick ? "picked" : ""].join(" ").trim()}">` +
        `<td><input type="checkbox" data-i="${e.index}"${e.keep ? " checked" : ""} aria-label="Keep volume ${e.index}"></td>` +
        `<td>${e.index}</td><td class="name" title="Show this volume">${esc(e.name)}` +
        (e.shell === 0 ? ` <span class="dw-tag">${e.guessed ? "b0?" : "b0"}</span>` : "") + `</td>` +
        `<td>${e.b != null ? fmt.num(e.b, 0) : "—"}</td>` +
        `<td class="dir">${e.dir ? e.dir.map(f3).join(" ") : "—"}</td><td>${fmt.num(e.mean, 1)}</td></tr>`).join("") + `</tbody></table>`;
  }
  $("vol-table").addEventListener("change", (e) => {
    const box = e.target.closest("input[data-i]");
    if (!box) return;
    S.entries[+box.dataset.i].keep = box.checked;
    refresh();
  });
  $("vol-table").addEventListener("click", (e) => {
    const cell = e.target.closest("td.name");
    if (!cell) return;
    preview(+cell.parentElement.dataset.i);
    if (viewTabs.get() === "gradients") showPane(lastPlane);     // a volume picked: show it
  });
  $("keep-all").addEventListener("click", () => { S.entries.forEach((e) => { e.keep = true; }); refresh(); });
  $("keep-none").addEventListener("click", () => { S.entries.forEach((e) => { e.keep = false; }); refresh(); });
  $("b0-mode").addEventListener("change", () => { renderMetrics(); renderOutWhat(); });

  $("btn-reduce").addEventListener("click", () => {
    const n = Math.max(1, Math.round(+$("reduce-n").value || 1));
    const shells = new Set(S.entries.filter((e) => e.shell > 0 && e.keep && e.dir).map((e) => e.shell));
    for (const sh of shells) {
      const kept = S.entries.filter((e) => e.shell === sh && e.keep && e.dir);
      if (kept.length <= n) continue;
      const chosen = new Set(G.spread(kept.map((e) => e.dir), n).map((i) => kept[i].index));
      for (const e of kept) e.keep = chosen.has(e.index);
    }
    refresh();
  });

  function renderMetrics() {
    const outs = outputs();
    const b0 = outs.filter((o) => o.entries[0].shell === 0).length;
    const kept = S.entries.filter((e) => e.keep && e.shell > 0);
    const m = G.metrics(kept);
    const condText = (c) => (Number.isFinite(c) ? c.toFixed(2) : "— (fewer than 6, or too few independent)");
    $("metrics").innerHTML = !S.entries.length ? "" :
      `<p class="hint">Written: ${outs.length} volume(s) — ${b0} b0` + (S.entries.some((e) => e.shell < 0) ? `, ${S.entries.filter((e) => e.keep && e.shell < 0).length} not classified` : "") +
      `, ${kept.length} diffusion-weighted.</p>` +
      (m.length ? `<table class="md-compare"><tr><th>Shell</th><th>Directions</th><th title="The smallest angle between two kept directions (opposites count as the same)">Min angle</th>` +
        `<th title="Mean angle from each direction to its nearest neighbour">Mean nearest</th><th title="Condition number of the tensor fit: ~1.5 is ideal; large means the directions bunch up">Tensor fit cond.</th></tr>` +
        m.map((r) => `<tr><td>b = ${r.b}</td><td>${r.n}</td><td>${Number.isFinite(r.minAngle) ? r.minAngle.toFixed(1) + "°" : "—"}</td>` +
          `<td>${Number.isFinite(r.meanNearest) ? r.meanNearest.toFixed(1) + "°" : "—"}</td><td>${condText(r.cond)}</td></tr>`).join("") + `</table>` : "");
  }

  function renderOutWhat() {
    const threeD = $("out-format").value === "3d";
    $("pattern-row").classList.toggle("hidden", !threeD);
    $("pattern-preview").classList.toggle("hidden", !threeD);
    if (!S.entries.length) return;
    if (threeD) renderPatternPreview();
    const n = outputs().length;
    const avg = $("b0-mode").value === "mean" && outputs().some((o) => o.entries.length > 1);
    $("out-what").textContent = `${n} volume(s) → ` + ($("out-format").value === "4d" ? "one 4D NIfTI" : `${n} 3D NIfTI files (zipped)`) +
      (avg ? ", b0s averaged (float32)" : "");
  }
  $("out-format").addEventListener("change", renderOutWhat);
  $("out-pattern").addEventListener("input", renderPatternPreview);
  $("out-name").addEventListener("input", () => { if ($("out-format").value === "3d") renderPatternPreview(); });

  // ==========================================================================
  // 3D file names
  // ==========================================================================
  const TOKENS = ["name", "index", "n", "source", "frame", "b"];
  /** The file names (without .nii.gz) of the output volumes, or an error. */
  function fileNames(outs) {
    const pattern = $("out-pattern").value.trim() || "{name}_{index:03}";
    const name = ($("out-name").value.trim() || defaultName());
    const bad = [...pattern.matchAll(/\{([^}:]*)(?::[^}]*)?\}/g)].map((m) => m[1]).filter((t) => !TOKENS.includes(t));
    if (bad.length) return { error: `unknown {${bad[0]}}: use ${TOKENS.map((t) => `{${t}}`).join(", ")}` };
    const names = outs.map((o, k) => {
      const e = o.entries[0], src = S.sources[e.src];
      const values = { name, index: k, n: k + 1, source: stem(src.file.name), frame: e.frame,
                       b: o.entries.length > 1 ? 0 : e.b != null ? Math.round(e.b) : "x" };
      return pattern.replace(/\{([a-z]+)(?::0?(\d+))?\}/g, (_, t, w) => {
        const v = String(values[t]);
        return w && /^\d+$/.test(v) ? v.padStart(+w, "0") : v;
      }).replace(/[^\w.-]+/g, "_");
    });
    const seen = new Set(), dup = names.find((n) => (seen.has(n) ? true : (seen.add(n), false)));
    if (dup) return { error: `two volumes would both be named ${dup}.nii.gz: add {index} or {n}` };
    if (names.some((n) => !n)) return { error: "an empty file name" };
    return { names };
  }
  function renderPatternPreview() {
    const outs = outputs(), r = fileNames(outs);
    const el = $("pattern-preview");
    el.classList.toggle("err-text", !!r.error);
    if (r.error) { el.textContent = `File names: ${r.error}.`; return; }
    const show = r.names.length > 4 ? [...r.names.slice(0, 3), "…", r.names[r.names.length - 1]] : r.names;
    el.textContent = show.map((n) => (n === "…" ? n : `${n}.nii.gz`)).join(", ");
  }

  // ==========================================================================
  // Sphere
  // ==========================================================================
  const sphere = DW.sphere.create($("sphere"), {
    onToggle(i) { S.entries[i].keep = !S.entries[i].keep; refresh(); },
    onHover(i) {
      const tip = $("sphere-tip");
      if (i < 0) { tip.classList.add("hidden"); return; }
      const e = S.entries[i];
      tip.textContent = `#${e.index} ${e.name} · b ${e.b ?? "?"} · (${e.dir.map((v) => v.toFixed(3)).join(", ")})${e.keep ? "" : " · dropped"}`;
      tip.classList.remove("hidden");
    },
  });
  function renderSphere() {
    const withDir = S.entries.filter((e) => e.dir && e.shell > 0 && Math.hypot(...e.dir) > 1e-6);
    $("sphere-empty").classList.toggle("hidden", withDir.length > 0);
    $("sphere-empty").textContent = S.entries.length ? "No gradient directions: add the .bvec (or an MRtrix table)." : "Load the DWI volumes and their .bval / .bvec.";
    const scanner = $("frame").value === "scanner" && S.sources.length;
    const affine = S.sources.length ? S.sources[0].vol.affine : null;
    sphere.set(withDir.map((e) => ({
      index: e.index, b: e.b, shell: e.shell, keep: e.keep,
      dir: G.unit(scanner ? G.toScanner(e.dir, affine) : e.dir),
    })), {
      radiusByB: $("radius").value === "b", antipodes: $("antipodes").checked,
      axes: scanner ? ["R", "A", "S"] : ["x", "y", "z"],
    });
  }
  ["frame", "radius", "antipodes"].forEach((id) => $(id).addEventListener("change", renderSphere));

  // ==========================================================================
  // Preview
  // ==========================================================================
  const view = Med.sliceView.create($("preview"), { tabs: false });
  view.clear("");
  let lastPlane = "axial";
  const viewTabs = ui.tabs($("view-tabs"), [{ value: "gradients", label: "Gradients" },
    ...Object.values(Med.PLANES).map((p) => ({ value: p.key, label: p.title }))], "gradients", showPane);
  /** Gradients: the sphere; a plane: the picked volume's slices. */
  function showPane(v) {
    const grad = v === "gradients";
    $("pane-gradients").classList.toggle("hidden", !grad);
    $("pane-slices").classList.toggle("hidden", grad);
    viewTabs.set(v);
    if (grad) sphere.draw();
    else { lastPlane = v; view.setPlane(v); }
  }
  function preview(i) {
    const e = S.entries[i];
    if (!e) return;
    S.pick = i;
    const vol = S.sources[e.src].vol;
    vol.frame = e.frame;
    const st = Med.stats(vol);
    const grid = Med.makeGrid(vol), lut = Med.render.lut("gray", false);
    const frame = e.frame;
    $("preview-what").textContent = `#${e.index} · ${e.shell === 0 ? "b0" : e.b != null ? `b ${e.b}` : "b ?"}`;
    view.set({
      grid,
      panels(v, k) {
        vol.frame = frame;
        const vals = Med.sampleSlice(vol, grid, v, k, false);
        return [{ tag: `#${e.index}`, rgba: Med.render.image(vals, [st.p1, st.p99], lut), tip: (r, c) => fmt.num(vals[r * v.w + c], 1) }];
      },
    });
    renderTable();
  }

  // ==========================================================================
  // Write
  // ==========================================================================
  $("btn-write").addEventListener("click", async () => {
    ui.status($("out-status"), "Writing…", "busy");
    await ui.busy();
    try { await write(); } catch (e) { console.error(e); ui.status($("out-status"), e.message, "err"); }
  });

  async function write() {
    const outs = outputs();
    if (!outs.length) throw new Error("No volume is kept.");
    S.urls.forEach((u) => URL.revokeObjectURL(u));
    S.urls = [];
    const first = S.sources[0].vol, nvox = first.nvox;
    const vols = S.sources.map((s) => s.vol);
    const averaged = outs.some((o) => o.entries.length > 1);
    const sameType = vols.every((v) => v.data.constructor === vols[0].data.constructor && v.slope === vols[0].slope && v.inter === vols[0].inter);
    const raw = !averaged && sameType;
    const Ctor = raw ? vols[0].data.constructor : Float32Array;
    /** Output volume o's voxels into dst at offset. */
    const fill = (o, dst, at) => {
      if (raw) {
        const e = o.entries[0], v = vols[e.src];
        dst.set(v.data.subarray(e.frame * nvox, (e.frame + 1) * nvox), at);
        return;
      }
      const n = o.entries.length;
      for (const e of o.entries) {
        const v = vols[e.src], off = e.frame * nvox;
        for (let i = 0; i < nvox; i++) dst[at + i] += (v.data[off + i] * v.slope + v.inter) / n;
      }
    };
    const scaling = raw ? { slope: vols[0].slope, inter: vols[0].inter } : { slope: 1, inter: 0 };
    const name = ($("out-name").value.trim() || defaultName()).replace(/[^\w.-]+/g, "_");
    // Gradients of what is written (an averaged b0: b 0, no direction).
    const gradOut = outs.map((o) => (o.entries.length > 1 ? { b: 0, dir: [0, 0, 0] } : { b: o.entries[0].b, dir: o.entries[0].dir }));
    const haveGrad = gradOut.some((g) => g.b != null || g.dir);
    const fsl = haveGrad ? G.fslText(gradOut.map((g) => ({ b: g.b ?? 0, dir: g.dir || [0, 0, 0] }))) : null;
    const enc = new TextEncoder();
    const entries = [];
    if ($("out-format").value === "4d") {
      const data = new Ctor(nvox * outs.length);
      outs.forEach((o, k) => fill(o, data, k * nvox));
      ui.status($("out-status"), "Compressing…", "busy");
      await ui.busy();
      entries.push({ name: `${name}.nii.gz`, data: await Med.io.gzip(Med.nifti.write({ dims: first.dims, frames: outs.length, data, affine: first.affine, ...scaling })) });
    } else {
      const named = fileNames(outs);
      if (named.error) throw new Error(`File names: ${named.error}.`);
      for (const [k, o] of outs.entries()) {
        ui.status($("out-status"), `Compressing ${k + 1} / ${outs.length}…`, "busy");
        await ui.busy();
        const data = new Ctor(nvox);
        fill(o, data, 0);
        entries.push({ name: `${named.names[k]}.nii.gz`,
                       data: await Med.io.gzip(Med.nifti.write({ dims: first.dims, data, affine: first.affine, ...scaling })) });
      }
    }
    if (fsl) entries.push({ name: `${name}.bval`, data: enc.encode(fsl.bvals) }, { name: `${name}.bvec`, data: enc.encode(fsl.bvecs) });
    const links = [];
    if (entries.length > 1) links.push({ name: `${name}.zip`, blob: Viz.zip(entries), all: true });
    if ($("out-format").value === "4d" || entries.length <= 3) entries.forEach((e) => links.push({ name: e.name, blob: new Blob([e.data]) }));
    $("files").innerHTML = links.map((l) => {
      const href = URL.createObjectURL(l.blob);
      S.urls.push(href);
      return `<li><a href="${esc(href)}" download="${esc(l.name)}">${esc(l.name)}</a><span class="hint">${fmt.bytes(l.blob.size)}${l.all ? " · all files" : ""}</span></li>`;
    }).join("");
    ui.status($("out-status"), `Written: ${outs.length} volume(s), ${raw ? vols[0].dtype : "float32"}` +
      (fsl ? ", with .bval / .bvec" : " (no gradients known: no .bval / .bvec)") + ".", "ok");
  }
})();
