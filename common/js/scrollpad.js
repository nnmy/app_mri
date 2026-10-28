/* ============================================================================
 * common/js/scrollpad.js — floating scroll-up / scroll-down buttons over a
 * viewer, on a touch screen (window.Viz.scrollPad)
 * ----------------------------------------------------------------------------
 * On a phone a drag inside a viewer turns or pans it instead of scrolling the
 * page, so a tall viewer can trap the reader. While the element, widened by
 * `margin` of its height above and below, is on screen, two round buttons
 * at the bottom right scroll the page by most of a screen.
 *
 *   Viz.scrollPad(document.querySelector(".sec-viewer"), { margin: 0.25 });
 *
 * Only where the main pointer is coarse (a touch screen); nothing elsewhere.
 * Look: .scrollpad in common/css/base.css.
 * ========================================================================== */
(function () {
  "use strict";
  const Viz = (window.Viz = window.Viz || {});
  const ICON = (d) => `<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="${d}" fill="none" ` +
    `stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  function scrollPad(el, o) {
    const margin = (o && o.margin) != null ? o.margin : 0.25;
    const touch = window.matchMedia("(pointer: coarse)");
    const pad = document.createElement("div");
    pad.className = "scrollpad hidden";
    pad.innerHTML =
      `<button type="button" data-d="-1" aria-label="Scroll up">${ICON("M6 15l6-6 6 6")}</button>` +
      `<button type="button" data-d="1" aria-label="Scroll down">${ICON("M6 9l6 6 6-6")}</button>`;
    document.body.appendChild(pad);
    pad.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-d]");
      if (b) window.scrollBy({ top: +b.dataset.d * window.innerHeight * 0.8, behavior: "smooth" });
    });
    const update = () => {
      const r = el.getBoundingClientRect(), m = r.height * margin;
      const near = r.height > 0 && r.top - m < window.innerHeight && r.bottom + m > 0;
      pad.classList.toggle("hidden", !(touch.matches && near));
    };
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    if (touch.addEventListener) touch.addEventListener("change", update);
    update();
    return { update };
  }

  Viz.scrollPad = scrollPad;
})();
