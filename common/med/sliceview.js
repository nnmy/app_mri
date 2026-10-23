/* ============================================================================
 * common/med/sliceview.js — plane tabs, a slice slider and hover panels
 * ----------------------------------------------------------------------------
 * The small slice viewer the processing pages share (Volume Slices has its own,
 * fuller one): Axial / Coronal / Sagittal tabs, a slice slider with the
 * slice's position in mm, and the panels of common/med/viewer.js (linked
 * crosshair, values under the cursor, click to lock).
 *
 *   const sv = Med.sliceView.create(element, { tabs: false });   // the page's own tabs
 *   sv.setPlane("coronal");
 *   sv.set({ grid,                                 // Med.makeGrid(...)
 *            panels(view, k) -> [{ tag, rgba, tip(row, col) }],
 *            describe(view, k, row, col) -> html,  // optional readout
 *            start: { axial: k, … } });            // optional first slices
 *   sv.clear("message");
 *
 * Slices are drawn neurological (the subject's left on the left).
 * ========================================================================== */
(function () {
  "use strict";
  const Med = (window.Med = window.Med || {});

  const AXIS_LETTERS = [["L", "R"], ["P", "A"], ["I", "S"]];

  function create(el, opts) {
    const withTabs = !opts || opts.tabs !== false;
    el.innerHTML =
      (withTabs ? `<div class="md-sv-tabs"></div>` : "") +
      `<div class="md-slicebar"><span class="ctl-label">Slice</span>` +
      `<input type="range" class="grow md-sv-slider" min="0" max="0" value="0" aria-label="Slice">` +
      `<input type="number" class="md-sv-num" min="0" value="0" aria-label="Slice number">` +
      `<span class="hint mono md-sv-info"></span></div>` +
      `<div class="md-sv-panels"></div><div class="md-readout mono md-sv-readout"></div>`;
    const q = (c) => el.querySelector(c);
    let spec = null, plane = "axial", k = {}, cur = null;

    const viewer = Med.viewer.create(q(".md-sv-panels"), {
      readout: q(".md-sv-readout"),
      describe: (row, col) => (spec && spec.describe && cur ? spec.describe(cur.view, cur.k, row, col) : ""),
      onStep: (d) => setSlice((k[plane] || 0) + d),
      heightFraction: 0.5,
    });
    const tabs = withTabs ? Viz.ui.tabs(q(".md-sv-tabs"), Object.values(Med.PLANES).map((p) => ({ value: p.key, label: p.title })),
                                        plane, (v) => { plane = v; draw(); }) : null;

    function setSlice(next) {
      if (!spec) return;
      const depth = spec.grid.dims[Med.PLANES[plane].axis];
      next = Math.max(0, Math.min(depth - 1, Math.round(next)));
      if (next === k[plane]) return;
      k[plane] = next;
      draw();
    }
    q(".md-sv-slider").addEventListener("input", (e) => setSlice(+e.target.value));
    q(".md-sv-num").addEventListener("change", (e) => setSlice(+e.target.value));

    function draw() {
      if (!spec) return;
      const view = Med.planeView(spec.grid, plane, false);
      const kk = Math.max(0, Math.min(view.depth - 1, k[plane] | 0));
      k[plane] = kk;
      cur = { view, k: kk };
      const panels = spec.panels(view, kk);
      viewer.render({ w: view.w, h: view.h, sx: view.sx, sy: view.sy, letters: view.letters, panels }, 0);
      const s = q(".md-sv-slider"), n = q(".md-sv-num");
      s.max = n.max = view.depth - 1;
      s.value = n.value = kk;
      const axis = view.p.axis, v = spec.grid.lo[axis] + spec.grid.step[axis] * kk;
      const [neg, pos] = AXIS_LETTERS[axis];
      q(".md-sv-info").textContent = `/ ${view.depth - 1} · ${v >= 0 ? pos : neg} ${Math.abs(v).toFixed(1)} mm`;
    }

    let resizeTimer = null;
    window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(draw, 120); });

    return {
      set(next) {
        // Another volume on the same grid (a DWI series' next frame) keeps
        // the slices where they were.
        const same = spec && next.grid.dims.every((n, i) => n === spec.grid.dims[i]);
        spec = next;
        if (same) { draw(); return; }
        k = {};
        for (const key of Object.keys(Med.PLANES)) {
          const n = spec.grid.dims[Med.PLANES[key].axis];
          k[key] = spec.start && spec.start[key] != null ? spec.start[key] : Math.floor(n / 2);
        }
        q(".md-slicebar").classList.remove("hidden");
        if (withTabs) q(".md-sv-tabs").classList.remove("hidden");
        draw();
      },
      draw,
      setPlane(p) { plane = p; if (tabs) tabs.set(p); draw(); },
      clear(message) {
        spec = null;
        q(".md-slicebar").classList.add("hidden");
        if (withTabs) q(".md-sv-tabs").classList.add("hidden");
        viewer.clear(`<div class="md-empty">${message || ""}</div>`);
      },
    };
  }

  /** The slice holding most of `vol`'s signal along each plane's axis (its
   *  centre of mass on `grid`), so a preview opens on anatomy. */
  function centreOf(vol, grid) {
    const st = Med.stats(vol);
    const out = {};
    for (const key of Object.keys(Med.PLANES)) {
      const axis = Med.PLANES[key].axis;
      const prof = Med.signalProfile(vol, grid, axis, [st.p1, st.p99]);
      let s = 0, w = 0;
      prof.forEach((f, i) => { s += i * f; w += f; });
      out[key] = w ? Math.round(s / w) : Math.floor(grid.dims[axis] / 2);
    }
    return out;
  }

  Med.sliceView = { create, centreOf };
})();
