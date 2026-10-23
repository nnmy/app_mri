/* ============================================================================
 * common/js/home.js — the home page's tiles, from common/registry.js
 * ----------------------------------------------------------------------------
 * One column per group (in registry order), one tile per widget. The search
 * box filters tiles by title and description.
 * ========================================================================== */
(function () {
  "use strict";
  const { esc } = Viz.ui;
  const reg = Viz.registry;
  const holder = document.getElementById("groups");
  const search = document.getElementById("search");

  function tile(w) {
    const desc = w.size === "wide" || w.size === "large"
      ? `<span class="tile-desc">${esc(w.description || "")}</span>` : "";
    return `<a class="tile ${esc(w.size || "medium")}" href="${esc(w.href)}" style="--tile:${esc(w.color)}"` +
      ` title="${esc(w.title + (w.description ? " — " + w.description : ""))}">` +
      (w.icon ? `<img class="tile-icon" src="${esc(w.icon)}" alt="">` : "") + desc +
      (w.server ? `<span class="tile-badge">needs server.py</span>` : "") +
      `<span class="tile-text"><span class="tile-title">${esc(w.title)}</span></span></a>`;
  }

  function render(query) {
    const q = (query || "").trim().toLowerCase();
    const match = (w) => !q || [w.title, w.description].join(" ").toLowerCase().includes(q);
    const html = reg.groups.map((g) => {
      const items = reg.inGroup(g.id).filter(match);
      if (!items.length) return "";
      return `<section class="group"><h2>${esc(g.title)}</h2><div class="tiles">${items.map(tile).join("")}</div></section>`;
    }).join("");
    holder.innerHTML = html || `<p class="tile-empty">No widget matches “${esc(query)}”.</p>`;
  }

  search.addEventListener("input", () => render(search.value));
  render("");
})();
