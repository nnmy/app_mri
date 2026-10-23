/* ============================================================================
 * dicom2nifti/lib/app.js — the page: a DICOM study in, NIfTI files out
 * ----------------------------------------------------------------------------
 * Two converters behind one page:
 *   browser   common/med/io_dicom.js reads the series (uncompressed DICOM),
 *             common/med/io_nifti.js writes them; nothing leaves the
 *             computer. The series are listed as soon as the files are
 *             dropped, each with a box: untick what you do not want.
 *   server    the files go to py/app.py (dcm2niix, through server.py) and
 *             come back as NIfTI + sidecars; for compressed DICOM.
 * Either way each series gets a sidecar (dcm2niix's field names, nothing
 * identifying the patient) and a role guess, T1 / T2 (lib/roles.js), and the
 * best of each is starred.
 * ========================================================================== */
(function () {
  "use strict";
  const { ui } = Viz;
  const { esc, fmt } = ui;
  const $ = (id) => document.getElementById(id);
  const svc = Viz.py.service("dicom2nifti");

  const S = { files: [], rows: [], scanned: false, serverOk: false, focus: null, urls: [] };
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
    title: "DICOM", sub: "files, a folder, or a .zip of the study", multiple: true, directory: true, required: true,
    tip: "Drop the study's files, its folder, or a .zip of it (any folder layout inside). Shift-click to pick a folder.",
    onFiles: take,
    onClear() { S.files = []; reset(); status(""); },
  });
  $("btn-folder").addEventListener("click", () => drop.pickFolder());

  function reset() {
    S.rows = []; S.scanned = false; S.focus = null;
    S.urls.forEach((u) => URL.revokeObjectURL(u));
    S.urls = [];
    $("sec-output").classList.add("hidden");
    $("btn-convert").disabled = !S.files.length;
    renderTable();
    preview.clear("The series found will be listed above; click one to preview it.");
  }

  async function take(files) {
    S.files = files;
    reset();
    drop.setInfo(`${files.length} file(s), ${fmt.bytes(files.reduce((s, f) => s + f.size, 0))}`);
    if ($("converter").value === "browser") await scan();
    else status(`${files.length} file(s) ready for dcm2niix.`, "");
  }

  $("converter").addEventListener("change", async () => {
    if ($("converter").value === "server" && !S.serverOk) {
      status(`dcm2niix runs on the server, which is not reachable. ${Viz.py.START_HINT}.`, "err");
      $("converter").value = "browser";
      return;
    }
    reset();
    if ($("converter").value === "browser" && S.files.length) await scan();
  });

  // ==========================================================================
  // Browser converter: scan, list, write
  // ==========================================================================
  async function expand(files) {
    const out = [];
    for (const f of files) {
      const head = new Uint8Array(await f.slice(0, 4).arrayBuffer());
      if (Viz.isZip(head)) out.push(...(await Viz.unzip(f)));
      else out.push(f);
    }
    return out;
  }

  async function scan() {
    status("Reading the DICOM files…", "busy");
    await ui.busy();
    try {
      const files = await expand(S.files);
      const list = await Med.dicom.scan(files, (t) => status(t, "busy"));
      const rows = [];
      for (const series of list) {
        try {
          const vol = Med.dicom.build(series);
          rows.push(rowOf({
            vol, sidecar: vol.sidecar, number: series.number,
            shape: vol.frames > 1 ? [...vol.dims, vol.frames] : vol.dims.slice(), zooms: vol.spacing,
            notes: vol.notes,
          }));
        } catch (e) {
          rows.push({ error: e.message, description: series.description || series.label, number: series.number,
                      include: false, shape: [series.cols, series.rows, series.count], zooms: [], why: "", role: "" });
        }
        await Med.tick();
      }
      finish(rows);
      S.scanned = true;
      const n = rows.filter((r) => r.include).length;
      let msg = `${rows.length} series found; ${n} ticked for conversion.`;
      if (list.skipped) msg += ` ${list.skipped} file(s) skipped (not an image).`;
      if (list.compressed) msg += ` Some files are compressed (${list.compressed}): use dcm2niix (server) for those.`;
      status(msg, list.compressed ? "err" : "ok");
    } catch (e) {
      console.error(e);
      status(e.message + (/compressed/.test(e.message) && S.serverOk ? " Choose “dcm2niix (server)”." : ""), "err");
    }
  }

  /** A table row from a series: role, skip reason, default tick. */
  function rowOf(r) {
    const j = r.sidecar || {};
    const { role, why } = D2N.roles.classify(r);
    const skip = D2N.roles.skipReason(r);
    return {
      ...r, role, why: skip ? `${why}; ${skip}` : why, skip,
      number: r.number != null ? r.number : j.SeriesNumber,
      description: j.SeriesDescription || j.ProtocolName || r.file || "(no description)",
      te: j.EchoTime, tr: j.RepetitionTime,
      include: r.include != null ? r.include : !skip,
    };
  }

  function finish(rows) {
    rows.sort((a, b) => (a.number || 0) - (b.number || 0));
    const best = D2N.roles.pick(rows.filter((r) => !r.error));
    rows.forEach((r) => { r.best = r === best.T1 || r === best.T2; });
    S.rows = rows;
    renderTable();
    $("btn-convert").disabled = !S.files.length;
  }

  /** dcm2niix's "%s_%p": series number and protocol name, file-safe. */
  function baseName(r, used) {
    const j = r.sidecar || {};
    let name = `${r.number ?? 0}_${(j.ProtocolName || j.SeriesDescription || "series").trim()}`
      .replace(/[^\w.-]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
    let out = name, n = 0;
    while (used.has(out)) out = `${name}_${String.fromCharCode(97 + n++)}`;
    used.add(out);
    return out;
  }

  async function convertInBrowser() {
    const chosen = S.rows.filter((r) => r.include && r.vol);
    if (!chosen.length) throw new Error("No series is ticked.");
    const entries = [], used = new Set(), links = [];
    for (const [i, r] of chosen.entries()) {
      status(`Writing ${i + 1} / ${chosen.length}: ${r.description}…`, "busy");
      await ui.busy();
      const v = r.vol;
      const nii = await Med.io.gzip(Med.nifti.write({
        dims: v.dims, frames: v.frames, data: v.data, affine: v.affine, slope: v.slope, inter: v.inter,
        descrip: (r.sidecar.SeriesDescription || "").slice(0, 79), tr: r.tr,
      }));
      const name = baseName(r, used);
      const json = new TextEncoder().encode(JSON.stringify(r.sidecar, null, 2) + "\n");
      entries.push({ name: `${name}.nii.gz`, data: nii }, { name: `${name}.json`, data: json });
      links.push(link(new Blob([nii]), `${name}.nii.gz`, r), link(new Blob([json], { type: "application/json" }), `${name}.json`));
    }
    const all = link(Viz.zip(entries), "dicom2nifti_output.zip");
    showFiles([all, ...links], `${chosen.length} series written.`);
  }

  function link(blob, name, row) {
    const href = URL.createObjectURL(blob);
    S.urls.push(href);
    if (row) row.download = name;
    return { href, name, size: blob.size };
  }

  // ==========================================================================
  // Server converter (dcm2niix)
  // ==========================================================================
  async function convertOnServer() {
    $("console").textContent = "";
    say(`Uploading ${S.files.length} file(s)…`);
    const data = await svc.uploadMany(S.files);
    let shown = 0;
    const [log, rows, files] = await svc.call("convert", [data], (partial) => {
      const lines = String(partial[0] || "").split("\n");
      lines.slice(shown).forEach(say);
      shown = lines.length;
    });
    String(log || "").split("\n").slice(shown).forEach(say);
    const byName = new Map(files.map((f) => [f.orig_name || f.path.split("/").pop(), f]));
    finish(rows.map((r) => rowOf({ ...r, file: r.file, fd: byName.get(r.file), include: true })));
    const links = files.map((f) => ({ href: svc.fileUrl(f), name: f.orig_name || f.path.split("/").pop(), size: f.size }));
    S.rows.forEach((r) => { r.download = r.file; });
    showFiles(links, `${rows.length} series converted by dcm2niix.`);
  }

  // ==========================================================================
  // Convert, output
  // ==========================================================================
  $("btn-convert").addEventListener("click", async () => {
    const server = $("converter").value === "server";
    $("btn-convert").disabled = true;
    status(server ? "Converting with dcm2niix…" : "Converting…", "busy");
    await ui.busy();
    try {
      if (server) await convertOnServer(); else await convertInBrowser();
      status("Done.", "ok");
    } catch (e) {
      console.error(e);
      status(e.message, "err");
    } finally {
      $("btn-convert").disabled = !S.files.length;
    }
  });

  function showFiles(links, summary) {
    const best = D2N.roles.pick(S.rows);
    const role = (r) => (r ? `${r.description}` : "none found");
    ui.status($("summary"), `${summary} T1: ${role(best.T1)}; T2: ${role(best.T2)}.`, "ok");
    $("files").innerHTML = links.map((l, i) =>
      `<li><a href="${esc(l.href)}" download="${esc(l.name)}">${esc(l.name)}</a>` +
      `<span class="hint">${l.size ? fmt.bytes(l.size) : ""}${i === 0 ? " · all files" : ""}</span></li>`).join("");
    $("sec-output").classList.remove("hidden");
    renderTable();
  }

  // ==========================================================================
  // The series table and preview
  // ==========================================================================
  const preview = Med.sliceView.create($("preview"));
  preview.clear("The series found will be listed above; click one to preview it.");

  function renderTable() {
    $("series-count").textContent = S.rows.length ? `${S.rows.length}` : "";
    if (!S.rows.length) { $("series").innerHTML = ""; return; }
    const browser = $("converter").value === "browser";
    const ms = (s) => (s == null ? "" : fmt.num(1000 * s, 1));
    const body = S.rows.map((r, i) => {
      const cls = [S.focus === i ? "focus" : "", r.include || !browser ? "" : "off"].join(" ").trim();
      const box = browser ? `<input type="checkbox" data-i="${i}"${r.include ? " checked" : ""}${r.error ? " disabled" : ""} aria-label="Convert">` : "";
      const roleCell = r.role ? `${r.role}${r.best ? " ★" : ""}` : "—";
      return `<tr data-i="${i}" class="${cls}"><td>${box}</td><td>${r.number ?? ""}</td>` +
        `<td class="name" title="${r.error ? esc(r.error) : "Preview"}">${esc(r.description)}${r.error ? ` <span class="err-text">(${esc(r.error)})</span>` : ""}</td>` +
        `<td>${(r.shape || []).join(" × ")}</td><td>${(r.zooms || []).map((z) => fmt.num(z, 2)).join(" × ")}</td>` +
        `<td>${ms(r.te)}</td><td>${ms(r.tr)}</td><td>${roleCell}</td><td class="why">${esc(r.why || "")}</td></tr>`;
    }).join("");
    $("series").innerHTML =
      `<table><thead><tr><th></th><th>#</th><th>Series</th><th>Voxels</th><th>Voxel (mm)</th>` +
      `<th>TE (ms)</th><th>TR (ms)</th><th>Role</th><th>Why</th></tr></thead><tbody>${body}</tbody></table>`;
  }

  $("series").addEventListener("change", (e) => {
    const box = e.target.closest("input[data-i]");
    if (!box) return;
    S.rows[+box.dataset.i].include = box.checked;
    renderTable();
  });
  $("series").addEventListener("click", async (e) => {
    const cell = e.target.closest("td.name");
    if (!cell) return;
    const i = +cell.parentElement.dataset.i, r = S.rows[i];
    if (r.error) return;
    S.focus = i;
    renderTable();
    try {
      if (!r.vol && r.fd) {
        status(`Fetching ${r.file}…`, "busy");
        r.vol = await Med.io.readVolumeFile(await svc.fetchFile(r.fd));
        status("", "");
      }
      showPreview(r);
    } catch (err) { console.error(err); status(err.message, "err"); }
  });

  function showPreview(r) {
    const vol = r.vol;
    vol.frame = 0;
    const grid = Med.makeGrid(vol);
    const st = Med.stats(vol);
    const lut = Med.render.lut("gray", !!vol.invert);
    preview.set({
      grid, start: Med.sliceView.centreOf(vol, grid),
      panels(view, k) {
        const vals = Med.sampleSlice(vol, grid, view, k, false);
        return [{ tag: `#${r.number ?? ""} ${r.description}`, rgba: Med.render.image(vals, [st.p1, st.p99], lut),
                  tip: (row, col) => fmt.num(vals[row * view.w + col], 2) }];
      },
    });
  }

  // ==========================================================================
  // Is dcm2niix there?
  // ==========================================================================
  (async () => {
    const opt = $("converter").querySelector('option[value="server"]');
    if (await svc.available()) {
      try {
        const [state] = await svc.call("status", []);
        S.serverOk = !String(state).startsWith("unavailable");
        $("server-state").textContent = S.serverOk ? `Server converter: ${state}.` : `Server converter ${state}.`;
      } catch (e) { $("server-state").textContent = `Server converter: ${e.message}`; }
    } else {
      $("server-state").textContent = `dcm2niix (server) needs server.py: ${Viz.py.START_HINT}.`;
    }
    opt.disabled = !S.serverOk;
  })();
})();
