/* ============================================================================
 * sample_data/lib/app.js — the sample files: one link each, or all zipped
 * ----------------------------------------------------------------------------
 * One section per study folder (its name in the title, not repeated on each
 * file). Each file is a plain link into asset/IXI034/ (works from file://
 * too). "Download all" fetches them and zips them in the browser under
 * IXI034/, folders kept -- which needs the page served over http
 * (server.py, or any static server): a page opened from file:// may not
 * fetch its files.
 * ========================================================================== */
(function () {
  "use strict";
  const { ui } = Viz;
  const { esc, fmt } = ui;
  const $ = (id) => document.getElementById(id);
  const BASE = "asset/IXI034/";
  const status = (t, kind) => ui.status($("status"), t, kind);

  const total = SD.files.reduce((s, f) => s + f.size, 0);
  $("total").textContent = `${SD.files.length} files · ${fmt.bytes(total)}`;

  const link = (f) => `<a href="${esc(BASE + f.path)}" download="${esc(f.name)}" title="${esc(f.name)}">${esc(f.short || f.name)}</a>`;

  $("groups").innerHTML = SD.groups.map((g) => {
    const size = g.files.reduce((s, f) => s + f.size, 0);
    const head = `<h2 class="sec-label">${esc(g.title)} <code class="sd-folder">${esc(g.folder)}/</code>` +
                 `<span class="sec-aside">${g.files.length} · ${fmt.bytes(size)}</span></h2>`;
    const note = g.note ? `<p class="hint sd-note">${esc(g.note)}</p>` : "";
    const body = g.layout === "grid"
      ? `<ul class="sd-grid">${g.files.map((f) => `<li>${link(f)}${f.what ? ` <span class="sd-tag">${esc(f.what)}</span>` : ""}` +
          `<span class="size">${fmt.bytes(f.size)}</span></li>`).join("")}</ul>`
      : `<table class="sd-table"><tbody>${g.files.map((f) => `<tr><td class="file">${link(f)}</td>` +
          `<td class="what">${esc(f.what)}</td><td class="size">${fmt.bytes(f.size)}</td></tr>`).join("")}</tbody></table>`;
    return `<section class="sec${g.collapsed ? " collapsed" : ""}">${head}${note}${body}</section>`;
  }).join("");
  ui.sections($("groups"));

  $("btn-all").addEventListener("click", async () => {
    if (location.protocol === "file:") {
      status("A page opened from the disk cannot gather its files: download them one by one, or open the site from server.py.", "err");
      return;
    }
    $("btn-all").disabled = true;
    try {
      const entries = [];
      for (const [i, f] of SD.files.entries()) {
        status(`Fetching ${i + 1} / ${SD.files.length}: ${f.name}…`, "busy");
        const r = await fetch(BASE + f.path);
        if (!r.ok) throw new Error(`${f.path}: ${r.status} ${r.statusText}`);
        entries.push({ name: `${SD.subject}/${f.path}`, data: new Uint8Array(await r.arrayBuffer()) });
      }
      status("Zipping…", "busy");
      await ui.busy();
      const blob = Viz.zip(entries);
      ui.download(blob, `${SD.subject}_sample.zip`);
      status(`Saved ${SD.subject}_sample.zip (${fmt.bytes(blob.size)}).`, "ok");
    } catch (e) {
      console.error(e);
      status(`Could not gather the files: ${e.message}`, "err");
    } finally {
      $("btn-all").disabled = false;
    }
  });
})();
