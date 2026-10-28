/* ============================================================================
 * common/med/dirbar.js — the direction-composition bar (window.Med.dirbar)
 * ----------------------------------------------------------------------------
 * One thin bar, 100 % long, a segment per direction class as wide as its
 * share of the streamlines; the count and share in the hover tooltip
 * (data-tip, Viz.ui.tooltips). A click on a segment picks that class, a
 * second click (or another value from the page) goes back to all; the
 * others are dimmed while one is picked. The page decides what that filters.
 *
 *   const bar = Med.dirbar.create(element, { classes: Med.tractSelect.CLASSES,
 *                                            colors: ["#…", …],     // optional; else the classes'
 *                                            onPick: (value) => … });   // "all" | "0".."3"
 *   bar.set(counts, "all");                    // counts: streamlines per class [4]
 *
 * Several bars may share one choice (two subjects): set them all.
 * ========================================================================== */
(function () {
  "use strict";
  const Med = (window.Med = window.Med || {});
  const colorsOf = (o) => o.colors || o.classes.map((c) => `rgb(${c.color})`);

  function create(el, o) {
    el.classList.add("md-dirbar");
    const fmtInt = (n) => n.toLocaleString("en-US");
    const colors = colorsOf(o);
    let current = "all";
    el.addEventListener("click", (e) => {
      const b = e.target.closest("[data-value]");
      if (b && o.onPick) o.onPick(b.dataset.value === current ? "all" : b.dataset.value);
    });
    return {
      set(counts, value) {
        current = value;
        const total = counts.reduce((a, b) => a + b, 0);
        const pct = (n) => (total ? ((100 * n) / total).toFixed(1) : "0");
        el.classList.toggle("picked", value !== "all");
        el.innerHTML = o.classes.map((c, i) => {
          const n = counts[i];
          if (!n) return "";
          return `<button type="button" data-value="${i}" class="${value === String(i) ? "on" : ""}" aria-pressed="${value === String(i)}" ` +
            `style="flex-grow:${n};background:${colors[i]}" data-tip="${c.label}: ${pct(n)} % (${fmtInt(n)} of ${fmtInt(total)})" ` +
            `aria-label="${c.label} ${pct(n)} %"></button>`;
        }).join("") || `<span class="md-dir-empty"></span>`;
      },
    };
  }

  /** The bar drawn on a canvas context (for a saved figure), shares written in. */
  function draw(ctx, x, y, w, h, counts, classes, value, colors) {
    const total = counts.reduce((a, b) => a + b, 0) || 1;
    const cols = colors || classes.map((c) => `rgb(${c.color})`);
    const live = counts.filter((n) => n > 0).length, gap = 2, inner = w - gap * Math.max(0, live - 1);
    let cx = x;
    ctx.save();
    ctx.font = `600 ${Math.round(h * 0.5)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    classes.forEach((c, i) => {
      if (!counts[i]) return;
      const cw = (inner * counts[i]) / total;
      ctx.globalAlpha = value !== "all" && value !== String(i) ? 0.3 : 1;
      ctx.fillStyle = cols[i];
      ctx.beginPath(); ctx.roundRect(cx, y, cw, h, 3); ctx.fill();
      ctx.globalAlpha = 1;
      if (cw > 64) {
        ctx.fillStyle = "#fff";
        ctx.fillText(`${c.label} ${Math.round((100 * counts[i]) / total)} %`, cx + cw / 2, y + h / 2);
      }
      cx += cw + gap;
    });
    ctx.restore();
  }

  Med.dirbar = { create, draw };
})();
