/* ============================================================================
 * common/js/chrome.js — the navbar (and footer) of every page
 * ----------------------------------------------------------------------------
 * Reads <body data-root=".." data-widget="<id>">: data-root is the path from
 * the page to the site root (links are built from it, so a page works at any
 * depth), data-widget marks the current widget in the menu. The menu lists
 * common/registry.js by group. The colour theme follows the system's
 * light/dark preference (base.css).
 * ========================================================================== */
(function () {
  "use strict";
  const Viz = (window.Viz = window.Viz || {});
  const SITE_NAME = "MRI WLAB";
  // The footer's text; empty = no footer.
  const FOOTER_HTML = "Developed by My N. Nguyen x AI";

  const body = document.body;
  const root = (body.dataset.root || ".").replace(/\/+$/, "");
  const current = body.dataset.widget || "";
  const url = (path) => root + "/" + path;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function menuHtml(reg) {
    return reg.groups.map((g) => {
      const items = reg.inGroup(g.id);
      if (!items.length) return "";
      return `<h4>${esc(g.title)}</h4>` + items.map((w) =>
        `<a href="${esc(url(w.href))}" class="${w.id === current ? "current" : ""}" title="${esc(w.description || "")}">` +
        `<span class="sw" style="background:${esc(w.color)}"></span>${esc(w.title)}</a>`).join("");
    }).join("");
  }

  function buildNav() {
    const reg = Viz.registry || { groups: [], widgets: [] };
    const here = reg.widgets.find((w) => w.id === current);
    const nav = document.createElement("nav");
    nav.className = "nav";
    nav.innerHTML =
      `<a class="nav-brand" href="${esc(url("index.html"))}"><img src="${esc(url("common/img/favicon.svg"))}" alt="">${SITE_NAME}</a>` +
      `<a class="nav-link${current ? "" : " current"}" href="${esc(url("index.html"))}">Home</a>` +
      `<div class="nav-menu"><button type="button" aria-haspopup="true">Widgets ▾</button>` +
      `<div class="nav-drop" role="menu">${menuHtml(reg)}</div></div>` +
      (here ? `<a class="nav-link current nav-here" href="${esc(url(here.href))}">${esc(here.title)}</a>` : "");
    body.insertBefore(nav, body.firstChild);

    const menu = nav.querySelector(".nav-menu");
    menu.querySelector("button").addEventListener("click", (e) => {
      e.stopPropagation();
      menu.classList.toggle("open");
    });
    document.addEventListener("click", () => menu.classList.remove("open"));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") menu.classList.remove("open"); });
  }

  function buildFooter() {
    if (!FOOTER_HTML) return;
    const foot = document.createElement("footer");
    foot.className = "footer";
    foot.innerHTML = FOOTER_HTML;
    body.appendChild(foot);
  }

  buildNav();
  buildFooter();

  Viz.chrome = { root, url, esc };
})();
