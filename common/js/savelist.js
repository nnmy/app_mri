/* ============================================================================
 * common/js/savelist.js — "💾 Save view" figures, listed and exported
 * (window.Viz.saveList)
 * ----------------------------------------------------------------------------
 * The saved-figures strip a viewer page puts under its views: the count, an
 * export format (PDF with a settings page, or PNG / a .zip of PNGs), Export
 * and Clear, and a thumbnail per figure (× removes it). The page makes the
 * figures; this keeps them and writes them out through Viz.report.
 *
 *   const saved = Viz.saveList.create(element, {
 *     stem: () => "demo_brain_aging",           // file names
 *     pdf: () => ({ header, right, infoTitle, meta, info }),   // Viz.report.pdf options
 *     status: (text, kind) => …,                // the page's status line
 *     hint: "💾 Save view adds what a tab shows",
 *   });
 *   saved.add({ title, caption: [lines], canvas });
 *   saved.items                                 // the figures, in order
 *
 * Generalised from APP_BRAINE's TMS viewer (tms_view/lib/app.js).
 * ========================================================================== */
(function () {
  "use strict";
  const Viz = (window.Viz = window.Viz || {});
  const THUMB_PX = 150;

  function create(el, o) {
    const { ui } = Viz;
    const hint = o.hint || "💾 Save view adds what a view shows";
    el.classList.add("md-saved");
    el.innerHTML =
      `<div class="row"><b>Saved figures</b> <span class="hint md-saved-count"></span><span class="grow"></span>` +
      `<span class="ctl-label">Export</span><select class="md-saved-fmt" aria-label="Export format">` +
      `<option value="pdf">PDF (with a settings page)</option><option value="png">PNG (a .zip of several)</option></select>` +
      `<button type="button" class="btn primary small md-saved-export" disabled>Export</button>` +
      `<button type="button" class="btn small md-saved-clear" disabled>Clear</button></div>` +
      `<div class="md-thumbs"></div>`;
    const q = (c) => el.querySelector(c);
    const items = [];
    const say = o.status || (() => {});

    function render() {
      const n = items.length;
      q(".md-saved-count").textContent = n ? `${n} figure${n > 1 ? "s" : ""}` : `none yet — ${hint}`;
      q(".md-saved-export").disabled = q(".md-saved-clear").disabled = !n;
      q(".md-thumbs").innerHTML = items.map((v, i) => {
        if (!v.thumb) {
          const t = document.createElement("canvas"), k = THUMB_PX / v.canvas.width;
          t.width = THUMB_PX; t.height = Math.max(1, Math.round(v.canvas.height * k));
          t.getContext("2d").drawImage(v.canvas, 0, 0, t.width, t.height);
          v.thumb = t.toDataURL("image/png");
        }
        return `<figure class="md-thumb" title="${ui.esc(v.title)}"><img src="${v.thumb}" alt=""><figcaption>${i + 1}. ${ui.esc(v.title)}</figcaption>` +
               `<button type="button" class="drop-x" data-i="${i}" title="Remove" aria-label="Remove">×</button></figure>`;
      }).join("");
    }
    q(".md-thumbs").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-i]");
      if (b) { items.splice(+b.dataset.i, 1); render(); }
    });
    q(".md-saved-clear").addEventListener("click", () => { items.length = 0; render(); });
    q(".md-saved-export").addEventListener("click", async () => {
      say("Exporting…", "busy");
      await ui.busy();
      try {
        const stem = o.stem ? o.stem() : "figures";
        let blob, name;
        if (q(".md-saved-fmt").value === "png") ({ blob, name } = await Viz.report.png(items, stem));
        else { blob = await Viz.report.pdf(items, o.pdf ? o.pdf() : {}); name = `${stem}_figures.pdf`; }
        ui.download(blob, name);
        say(`${name} (${ui.fmt.bytes(blob.size)})`, "ok");
      } catch (e) { console.error(e); say(e.message, "err"); }
    });
    render();
    return { items, add(fig) { items.push(fig); render(); return items.length; }, render };
  }

  /** "2026-10-28 14:02", for an export's meta line. */
  function now() {
    const d = new Date(), p = (x) => String(x).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  Viz.saveList = { create, now };
})();
