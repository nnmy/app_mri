/* ============================================================================
 * registration/lib/app.js — the page: fixed + moving in, registered out
 * ----------------------------------------------------------------------------
 * The registration itself runs on the server (py/app.py, SimpleITK, through
 * server.py); the page uploads the files, streams the log, then draws the
 * check itself from the files: on the fixed image's grid, the fixed image in
 * red with the moving one in green (aligned structures turn yellow), the
 * moving image alone, and the moving image's segmentation over the fixed
 * image. "Before registration" shows the moving image as it came, placed by
 * its own header -- the misalignment the registration removed. Below, the
 * server's co-histogram of the moving image before vs after.
 * ========================================================================== */
(function () {
  "use strict";
  const { ui } = Viz;
  const { esc, fmt } = ui;
  const $ = (id) => document.getElementById(id);
  const svc = Viz.py.service("registration");

  const S = { fixed: null, moving: null, seg: null, files: {}, result: null, serverOk: false };
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
  function volumeDrop(id, key, title, required, tip) {
    const zone = ui.dropZone($(id), {
      title, sub: "NIfTI / NRRD", accept: ".nii,.gz,.nrrd", required, tip,
      async onFiles(files) {
        const f = files[0];
        try {
          const vol = await Med.io.readVolumeFile(f);
          if (vol.frames > 1) throw new Error(`${vol.frames} frames; a 3-D volume is needed.`);
          S[key] = vol;
          S.files[key] = f;
          zone.setInfo(`${f.name} · ${vol.dims.join("×")}`);
          status("");
        } catch (e) { status(e.message, "err"); }
        ready();
      },
      onClear() { S[key] = null; delete S.files[key]; ready(); },
    });
    return zone;
  }
  volumeDrop("drop-fixed", "fixed", "Fixed image (F)", true, "The reference: the output lies in its space.");
  volumeDrop("drop-moving", "moving", "Moving image (M)", true, "Moved onto F.");
  volumeDrop("drop-seg", "seg", "Segmentation of M", false, "Optional; carried with the same transform (nearest neighbour).");

  const ready = () => { $("btn-run").disabled = !(S.fixed && S.moving && S.serverOk); };

  // ==========================================================================
  // Run
  // ==========================================================================
  $("btn-run").addEventListener("click", async () => {
    $("btn-run").disabled = true;
    $("console").textContent = "";
    $("sec-output").classList.add("hidden");
    status("Uploading…", "busy");
    try {
      const up = async (k) => (S.files[k] ? svc.upload(S.files[k]) : null);
      const data = [await up("fixed"), await up("moving"), await up("seg"), $("mode").value,
                    $("match-spacing").checked, $("match-size").checked];
      status("Registering… (the console shows each stage)", "busy");
      let shown = 0;
      const echo = (log) => {
        const lines = String(log || "").split("\n").filter(Boolean);
        lines.slice(shown).forEach(say);
        shown = lines.length;
      };
      const [log, result, files] = await svc.call("register", data, (p) => echo(p[0]));
      echo(log);
      S.result = result;
      status("Fetching the result…", "busy");
      const byName = new Map(files.map((f) => [f.orig_name || f.path.split("/").pop(), f]));
      const reg = await svc.fetchFile(byName.get(result.files[0]));
      S.registered = await Med.io.readVolumeFile(reg);
      S.registeredSeg = S.seg ? await Med.io.readVolumeFile(await svc.fetchFile(byName.get(result.files[1]))) : null;
      const png = files.find((f) => /_cohistogram\.png$/.test(f.orig_name || f.path));
      showOutput(result, files);
      $("figure").innerHTML = png ? `<img src="${esc(svc.fileUrl(png))}" alt="Displacement co-histogram of the moving image">` : "";
      $("figure").classList.toggle("hidden", !png);
      $("show-row").classList.remove("hidden");
      $("show").value = "after";
      draw();
      status(`Done. ${result.mode}: metric ${result.metric_before.toFixed(4)} → ${result.metric_after.toFixed(4)} ` +
             "(Mattes mutual information; lower = better match).", "ok");
    } catch (e) {
      console.error(e);
      say(`FAILED: ${e.message}`);
      status(e.message, "err");
    } finally { ready(); }
  });

  function showOutput(r, files) {
    const m = r.moving_to_fixed_ras;
    const g = r.output_grid;
    $("summary").innerHTML =
      `<table class="kv"><tr><td>Method</td><td>${esc(r.mode)}</td></tr>` +
      `<tr><td>Metric</td><td>${r.metric_before.toFixed(4)} → ${r.metric_after.toFixed(4)}</td></tr>` +
      `<tr><td>Output grid</td><td>${g.size.join(" × ")} voxels of ${g.spacing.join(" × ")} mm${g.fixed_grid ? " (F's grid)" : ""}</td></tr>` +
      `<tr><td>M → F (RAS mm)</td><td class="mono">${m.map((row) => row.map((v) => v.toFixed(4).padStart(9)).join(" ")).join("<br>")}</td></tr></table>`;
    $("files").innerHTML = files.map((f) => {
      const name = f.orig_name || f.path.split("/").pop();
      return `<li><a href="${esc(svc.fileUrl(f))}" download="${esc(name)}">${esc(name)}</a>` +
             `<span class="hint">${f.size ? fmt.bytes(f.size) : ""}</span></li>`;
    }).join("");
    $("sec-output").classList.remove("hidden");
  }

  // ==========================================================================
  // Viewer
  // ==========================================================================
  const view = Med.sliceView.create($("view"));
  view.clear("Upload a fixed and a moving image, then press Run.");
  $("show").addEventListener("change", draw);

  function draw() {
    const after = $("show").value === "after";
    const F = S.fixed, M = after ? S.registered : S.moving, L = after ? S.registeredSeg : S.seg;
    const grid = Med.makeGrid(F);
    const fs = Med.stats(F), ms = Med.stats(S.moving);
    const grey = Med.render.lut("gray", false);
    const norm = (v, st) => (v === v ? Math.max(0, Math.min(1, (v - st.p1) / ((st.p99 - st.p1) || 1))) : 0);
    let lk = null, segName = null;
    if (L) {
      const stats = Med.labelStats(L, grid);
      const segs = Med.labels.segments(L, stats, null);
      lk = Med.labels.lookup(segs, new Set(segs.map((s) => s.id)));
      segName = (id) => (id > 0 ? `label ${id}` : "background");
    }
    view.set({
      grid, start: Med.sliceView.centreOf(F, grid),
      panels(v, k) {
        const f = Med.sampleSlice(F, grid, v, k, false), m = Med.sampleSlice(M, grid, v, k, false);
        const rgb = new Uint8ClampedArray(f.length * 4);
        for (let i = 0; i < f.length; i++) {
          rgb[i * 4] = 255 * norm(f[i], fs);
          rgb[i * 4 + 1] = 255 * norm(m[i], ms);
          rgb[i * 4 + 3] = 255;
        }
        const at = (r, c) => r * v.w + c;
        const panels = [
          { tag: "Fixed (red) + moving (green)", rgba: rgb,
            tip: (r, c) => `F ${fmt.num(f[at(r, c)], 1)} · M ${fmt.num(m[at(r, c)], 1)}` },
          { tag: after ? "Moving (registered)" : "Moving (before)", rgba: Med.render.image(m, [ms.p1, ms.p99], grey),
            tip: (r, c) => fmt.num(m[at(r, c)], 2) },
        ];
        if (L) {
          const lab = Med.sampleSlice(L, grid, v, k, true);
          const base = Med.render.image(f, [fs.p1, fs.p99], grey);
          panels.push({ tag: "Segmentation on F", rgba: Med.render.labels(lab, v.w, v.h, lk, { alpha: 0.45, mode: "both" }, base),
                        tip: (r, c) => segName(lab[at(r, c)]) });
        }
        return panels;
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
    $("server-state").textContent = S.serverOk ? "" : `Registration runs on the server: ${Viz.py.START_HINT}.`;
    ready();
  })();
})();
