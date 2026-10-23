/* ============================================================================
 * resample/lib/app.js — the page: volumes in, resampled volumes out
 * ----------------------------------------------------------------------------
 * Every file with the same voxel size, interpolation and "To RAS" setting
 * ("Auto" still decides per file: labels or image), one .nii.gz each and a
 * zip when there are several. The viewer shows one result: before and after
 * side by side on one world grid (the finer of the two), the crosshair
 * linked, and a table of both grids.
 * ========================================================================== */
(function () {
  "use strict";
  const { ui } = Viz;
  const { esc, fmt } = ui;
  const $ = (id) => document.getElementById(id);

  const S = { inputs: [], results: [], urls: [] };
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
  const drop = ui.dropZone($("drop"), {
    title: "Volumes", sub: "NIfTI / NRRD, one or several", multiple: true, required: true,
    accept: ".nii,.gz,.nrrd",
    tip: ".nii, .nii.gz or .nrrd; one or several, all resampled with the same settings.",
    onFiles: take,
    onClear() { S.inputs = []; $("inputs").innerHTML = ""; $("btn-run").disabled = true; status(""); },
  });

  async function take(files) {
    status(`Reading ${files.length} file(s)…`, "busy");
    await ui.busy();
    const inputs = [], lines = [];
    for (const f of files) {
      try {
        const vol = await Med.io.readVolumeFile(f);
        if (vol.frames > 1) throw new Error(`${vol.frames} frames; a 3-D volume is needed`);
        const labels = RS.resample.isLabels(vol);
        inputs.push({ file: f, vol, labels });
        lines.push(`<li><span><b>${esc(f.name)}</b>: ${vol.dims.join(" × ")} voxels of ${fmt.mm(vol.spacing)}, ` +
                   `${vol.orientation()}, ${fmt.bytes(f.size)} (${labels ? "labels" : "image"})</span></li>`);
      } catch (e) {
        lines.push(`<li><span><b>${esc(f.name)}</b>: <span class="err-text">cannot use this file: ${esc(e.message)}</span></span></li>`);
      }
    }
    const names = inputs.map((x) => x.file.name);
    const dup = names.filter((n, i) => names.indexOf(n) !== i);
    if (dup.length) status(`Two files share a name: ${[...new Set(dup)].join(", ")}.`, "err");
    else status(inputs.length ? `${inputs.length} volume(s) ready.` : "", inputs.length ? "ok" : "err");
    S.inputs = dup.length ? [] : inputs;
    $("inputs").innerHTML = lines.join("");
    drop.setInfo(`${files.length} file(s)`);
    $("btn-run").disabled = !S.inputs.length;
  }

  // ==========================================================================
  // Run
  // ==========================================================================
  const stem = (name) => Med.io.stem(name).replace(/[^\w.-]+/g, "_");

  $("btn-run").addEventListener("click", async () => {
    const mm = parseFloat($("voxel").value);
    const method = $("method").value, toRas = $("ras").checked;
    $("btn-run").disabled = true;
    $("console").textContent = "";
    S.urls.forEach((u) => URL.revokeObjectURL(u));
    S.urls = []; S.results = [];
    try {
      if (!(mm >= RS.resample.MIN_MM && mm <= RS.resample.MAX_MM))
        throw new Error(`The voxel size must be ${RS.resample.MIN_MM}–${RS.resample.MAX_MM} mm.`);
      const tag = String(+mm.toFixed(3)).replace(".", "p");
      const entries = [];
      for (const [i, inp] of S.inputs.entries()) {
        say(`--- ${i + 1}/${S.inputs.length}: ${inp.file.name}`);
        const used = method === "Auto" ? (inp.labels ? "Nearest" : "Linear") : method;
        say(`Input: ${inp.vol.dims.join(" × ")} voxels of ${fmt.mm(inp.vol.spacing)}, ${inp.vol.orientation()}, ${inp.vol.dtype}`);
        say(`Content: ${inp.labels ? "labels" : "image"} → ${inp.labels ? "Nearest" : used}${method === "Auto" ? " (auto)" : ""}` +
            (inp.labels && method !== "Auto" && method !== "Nearest" ? " (labels are always nearest)" : ""));
        let src = inp.vol;
        if (toRas) {
          const c = RS.resample.canonical(src);
          src = c.vol;
          say(c.changed ? `Reoriented ${c.from} → RAS` : "Already RAS");
        }
        const res = await RS.resample.resample(src, mm, used, inp.labels, (t) => status(`${inp.file.name}: ${t}`, "busy"));
        res.notes.forEach(say);
        const name = `${stem(inp.file.name)}_${tag}mm.nii.gz`;
        res.vol.name = name;
        const bytes = await Med.io.gzip(Med.nifti.write({ dims: res.vol.dims, data: res.vol.data, affine: res.vol.affine }));
        say(`Output: ${res.vol.dims.join(" × ")} voxels of ${fmt.mm(res.vol.spacing)}, ${res.vol.orientation()}, ${res.vol.dtype}, ${fmt.bytes(bytes.length)}`);
        entries.push({ name, data: bytes });
        S.results.push({ input: inp, after: res.vol, labels: inp.labels, size: bytes.length, name });
      }
      const links = entries.map((e) => ({ name: e.name, href: URL.createObjectURL(new Blob([e.data])), size: e.data.length }));
      if (entries.length > 1) {
        const all = Viz.zip(entries);
        links.unshift({ name: "resample_output.zip", href: URL.createObjectURL(all), size: all.size, all: true });
      }
      S.urls = links.map((l) => l.href);
      $("files").innerHTML = links.map((l) =>
        `<li><a href="${esc(l.href)}" download="${esc(l.name)}">${esc(l.name)}</a>` +
        `<span class="hint">${fmt.bytes(l.size)}${l.all ? " · all files" : ""}</span></li>`).join("");
      $("sec-output").classList.remove("hidden");
      $("pick").innerHTML = S.results.map((r, i) => `<option value="${i}">${esc(r.input.file.name)}</option>`).join("");
      $("pick-row").classList.toggle("hidden", S.results.length < 2);
      show(0);
      status(`Done · ${S.results.length} file(s) at ${mm} mm${S.results.length > 1 ? " · the zip holds them all" : ""}.`, "ok");
    } catch (e) {
      console.error(e);
      say(`FAILED: ${e.message}`);
      status(e.message, "err");
    } finally {
      $("btn-run").disabled = !S.inputs.length;
    }
  });

  // ==========================================================================
  // Viewer: before | after, and the two grids
  // ==========================================================================
  const view = Med.sliceView.create($("view"));
  view.clear("Upload a volume, pick a voxel size, then press Run.");
  $("pick").addEventListener("change", (e) => show(+e.target.value));

  function show(i) {
    const r = S.results[i];
    const before = r.input.vol, after = r.after;
    const grid = Med.makeGrid(after, before);
    let draw;
    if (r.labels) {
      const st = Med.labelStats(before, grid);
      const segs = Med.labels.segments(before, st, null);
      const lk = Med.labels.lookup(segs, new Set(segs.map((s) => s.id)));
      const name = (id) => (id > 0 ? `label ${id}` : "background");
      draw = (vol, view, k) => {
        const lab = Med.sampleSlice(vol, grid, view, k, true);
        return { rgba: Med.render.labels(lab, view.w, view.h, lk, {}, null), tip: (row, col) => name(lab[row * view.w + col]) };
      };
    } else {
      const st = Med.stats(before), lut = Med.render.lut("gray", false);
      draw = (vol, view, k) => {
        const vals = Med.sampleSlice(vol, grid, view, k, false);
        return { rgba: Med.render.image(vals, [st.p1, st.p99], lut), tip: (row, col) => fmt.num(vals[row * view.w + col], 2) };
      };
    }
    view.set({
      grid, start: r.labels ? undefined : Med.sliceView.centreOf(before, grid),
      panels: (v, k) => [{ tag: "Before", ...draw(before, v, k) }, { tag: "After", ...draw(after, v, k) }],
    });
    $("compare").innerHTML = compareTable(r);
  }

  function info(vol, size, name) {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < vol.nvox; i++) { const v = vol.value(i); if (v < lo) lo = v; if (v > hi) hi = v; }
    return {
      File: name, "File size": size ? fmt.bytes(size) : "—",
      "Dimension (voxels)": vol.dims.join(" × "),
      "Voxel size (mm)": vol.spacing.map((v) => fmt.num(v, 3)).join(" × "),
      "Dimension (mm)": vol.dims.map((n, c) => fmt.num(n * vol.spacing[c], 1)).join(" × "),
      Orientation: vol.orientation(), "Data type": vol.dtype,
      "Value range": `${fmt.num(lo, 4)} … ${fmt.num(hi, 4)}`,
    };
  }

  function compareTable(r) {
    const a = info(r.input.vol, r.input.file.size, r.input.file.name), b = info(r.after, r.size, r.name);
    return `<table class="md-compare"><tr><th></th><th>Before</th><th>After</th></tr>` +
      Object.keys(a).map((k) => `<tr><td>${esc(k)}</td><td>${esc(a[k])}</td><td>${esc(b[k])}</td></tr>`).join("") + `</table>`;
  }
})();
