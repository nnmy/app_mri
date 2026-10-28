/* ============================================================================
 * common/med/viewer.js — slice panels you can hover over
 * ----------------------------------------------------------------------------
 * A row of panels that all show the SAME slice on the SAME pixel grid (the
 * image; the labels over it). Hover over one: every panel draws a crosshair
 * at that pixel and labels it with its own value (an intensity, or a
 * segment's name). A click LOCKS the crosshair (a padlock marks the spot);
 * it stays there across slice changes, reading the new slice's values;
 * another click, or Esc, releases it.
 *
 * The wheel over a panel, or the arrow / Page keys, step through slices.
 *
 * Pixel exactness: each canvas holds one pixel per grid pixel and is scaled
 * by CSS with image-rendering: pixelated. At an integer zoom every grid
 * pixel is the same number of screen pixels, so the pixel under the cursor
 * is the one whose value is shown. Auto zoom therefore picks the largest
 * integer that fits; only a slice wider than the panel is shrunk.
 * ========================================================================== */
(function () {
  "use strict";
  const Med = (window.Med = window.Med || {});

  const LOCK_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 10V7a5 5 0 0 1 10 0v3h1a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h1zm2 0h6V7a3 3 0 0 0-6 0v3z"/></svg>';
  const GAP = 14;                         // px between panels (viewer.css .md-grid)

  /**
   * holder   the element the panels go in
   * opts     { readout: element, describe(row, col) -> html,
   *            onStep(delta), onLock(locked),
   *            heightFraction: of the window a slice may take (0.74) }
   */
  function create(holder, opts) {
    holder.classList.add("md-canvas");
    holder.tabIndex = 0;
    let panels = [];            // [{ el, canvas, tip(row, col) }]
    let view = null;            // { w, h } of the current slice
    let locked = null;          // { index, row, col }
    let last = null;            // the last hovered pixel, for re-describing

    function layout(spec, zoomSetting) {
      // Screen size of one grid pixel: square pixels when the grid's steps
      // are equal, else stretched to the physical aspect.
      const unit = Math.min(spec.sx, spec.sy);
      const ax = spec.sx / unit, ay = spec.sy / unit;
      const n = spec.panels.length;
      let zoom = +zoomSetting;
      if (!zoom) {
        const avail = Math.max(120, holder.clientWidth - GAP * (n - 1) - 2);
        const availH = Math.max(160, window.innerHeight * (opts.heightFraction || 0.74));
        const fit = Math.min(avail / (n * spec.w * ax), availH / (spec.h * ay));
        zoom = fit >= 1 ? Math.floor(fit) : fit;
      }
      return { cssW: spec.w * ax * zoom, cssH: spec.h * ay * zoom, zoom };
    }

    /**
     * spec: { w, h, sx, sy, letters:{top,bottom,left,right},
     *         panels:[{ tag, rgba, tip(row, col) -> text }] }
     */
    function render(spec, zoomSetting) {
      const fresh = !view || view.w !== spec.w || view.h !== spec.h || panels.length !== spec.panels.length;
      view = { w: spec.w, h: spec.h };
      const size = layout(spec, zoomSetting);
      if (fresh) {
        holder.innerHTML = `<div class="md-grid"></div>`;
        const grid = holder.firstChild;
        panels = spec.panels.map(() => {
          const el = document.createElement("div");
          el.className = "md-panel";
          el.innerHTML =
            `<div class="md-wrap"><canvas class="md-slice"></canvas><div class="md-tag"></div>` +
            `<span class="md-ori t"></span><span class="md-ori b"></span><span class="md-ori l"></span><span class="md-ori r"></span>` +
            `<div class="md-cross md-h"></div><div class="md-cross md-v"></div><div class="md-tip"></div>` +
            `<div class="md-lock">${LOCK_SVG}</div></div>`;
          grid.appendChild(el);
          return { el, canvas: el.querySelector("canvas") };
        });
        if (locked && (locked.row >= view.h || locked.col >= view.w || locked.index >= panels.length)) unlock();
      }
      spec.panels.forEach((p, i) => {
        const P = panels[i];
        P.tip = p.tip;
        Med.render.toCanvas(p.rgba, spec.w, spec.h, P.canvas);
        P.canvas.style.width = size.cssW + "px";
        P.canvas.style.height = size.cssH + "px";
        P.el.querySelector(".md-tag").textContent = p.tag;
        const L = spec.letters || {};
        P.el.querySelector(".md-ori.t").textContent = L.top || "";
        P.el.querySelector(".md-ori.b").textContent = L.bottom || "";
        P.el.querySelector(".md-ori.l").textContent = L.left || "";
        P.el.querySelector(".md-ori.r").textContent = L.right || "";
      });
      if (locked) showAt(locked.index, locked.row, locked.col);
      else if (last && last.inside) showAt(last.index, last.row, last.col);
      return size;
    }

    function place(P, row, col, linked, isLockSource) {
      const el = P.el, w = view.w, h = view.h;
      const x = ((col + 0.5) / w) * 100, y = ((row + 0.5) / h) * 100;
      el.classList.toggle("md-linked", linked);
      const hl = el.querySelector(".md-h"), vl = el.querySelector(".md-v");
      const tip = el.querySelector(".md-tip"), lock = el.querySelector(".md-lock");
      hl.style.top = y + "%";
      vl.style.left = x + "%";
      tip.textContent = P.tip ? P.tip(row, col) : "";
      tip.style.left = x + "%";
      tip.style.top = y + "%";
      tip.style.transform = `translate(${x > 55 ? "calc(-100% - 8px)" : "8px"}, ${y > 80 ? "calc(-100% - 8px)" : "8px"})`;
      hl.style.display = vl.style.display = "block";
      tip.style.display = tip.textContent ? "block" : "none";
      lock.style.display = isLockSource ? "block" : "none";
      if (isLockSource) {
        lock.style.left = x + "%";
        lock.style.top = y + "%";
        lock.style.transform = `translate(${x > 55 ? "6px" : "calc(-100% - 6px)"}, ${y > 80 ? "6px" : "calc(-100% - 6px)"})`;
      }
    }

    function showAt(index, row, col) {
      panels.forEach((P, i) => place(P, row, col, i !== index, !!locked && i === index));
      if (opts.readout && opts.describe) opts.readout.innerHTML = opts.describe(row, col);
    }

    function hide() {
      holder.querySelectorAll(".md-cross, .md-tip, .md-lock").forEach((x) => { x.style.display = "none"; });
      if (opts.readout) opts.readout.innerHTML = opts.idle || "";
    }

    function unlock() {
      locked = null;
      holder.classList.remove("md-locked");
      if (opts.onLock) opts.onLock(false);
    }

    function pixelAt(e) {
      const canvas = e.target.closest && e.target.closest("canvas.md-slice");
      if (!canvas || !view) return null;
      const index = panels.findIndex((P) => P.canvas === canvas);
      const r = canvas.getBoundingClientRect();
      const col = Math.floor(((e.clientX - r.left) / r.width) * view.w);
      const row = Math.floor(((e.clientY - r.top) / r.height) * view.h);
      if (col < 0 || row < 0 || col >= view.w || row >= view.h) return null;
      return { index, row, col };
    }

    holder.addEventListener("mousemove", (e) => {
      if (locked) return;
      const at = pixelAt(e);
      last = at ? { ...at, inside: true } : null;
      if (at) showAt(at.index, at.row, at.col); else hide();
    });
    holder.addEventListener("mouseleave", () => { last = null; if (!locked) hide(); });
    holder.addEventListener("click", (e) => {
      const at = pixelAt(e);
      if (!at) return;
      if (locked) unlock();
      else {
        locked = at;
        holder.classList.add("md-locked");
        if (opts.onLock) opts.onLock(true);
      }
      showAt(at.index, at.row, at.col);
    });
    holder.addEventListener("wheel", (e) => {
      if (!view || !e.target.closest("canvas.md-slice")) return;
      e.preventDefault();
      opts.onStep((e.deltaY > 0 ? -1 : 1) * (e.shiftKey ? 5 : 1));
    }, { passive: false });
    holder.addEventListener("keydown", (e) => {
      const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 10, PageDown: -10 }[e.key];
      if (step) { e.preventDefault(); opts.onStep(step); }
      if (e.key === "Escape" && locked) { unlock(); hide(); }
    });

    return {
      render,
      clear(html) { holder.innerHTML = html || ""; panels = []; view = null; locked = null; hide(); },
      isLocked: () => !!locked,
      lockedAt: () => locked,
      refreshReadout() { if (locked) showAt(locked.index, locked.row, locked.col); },
    };
  }

  Med.viewer = { create };
})();
