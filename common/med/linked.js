/* ============================================================================
 * common/med/linked.js — views that move together (window.Med.linked)
 * ----------------------------------------------------------------------------
 *   Med.linked.cameras([R1, R2, …])
 *       3D renderers (Med.gl3d.create) whose cameras follow each other: turn,
 *       pan or zoom one and the others take the same camera. Each renderer's
 *       opts.onRender (kept, and still called) copies its camera into any
 *       other whose camera differs and redraws it; that one then finds them
 *       equal and stops, so nothing loops. Returns { frame(bounds) } -- fit
 *       every camera to one [lo, hi] box (the union of what they show), so
 *       two subjects in one space are seen from the same place.
 *
 * Slice views need no link of their own: two subjects on one grid are two
 * panels of one Med.sliceView, whose crosshair and slice are shared already.
 * ========================================================================== */
(function () {
  "use strict";
  const Med = (window.Med = window.Med || {});

  const EPS = 1e-9;
  const same = (a, b) => Math.abs(a - b) < EPS;
  const sameVec = (a, b) => a.length === b.length && a.every((v, i) => same(v, b[i]));

  function sameCam(a, b) {
    return same(a.dist, b.dist) && same(a.radius, b.radius) && sameVec(a.target, b.target) && sameVec(a.pan, b.pan) &&
           !!a.rot && !!b.rot && a.rot.every((r, i) => sameVec(r, b.rot[i]));
  }
  function copyCam(from, to) {
    to.rot = from.rot.map((r) => r.slice());
    to.target = from.target.slice();
    to.pan = from.pan.slice();
    to.dist = from.dist;
    to.radius = from.radius;
  }

  function cameras(renderers) {
    for (const R of renderers) {
      const own = R.opts.onRender;
      R.opts.onRender = (view) => {
        if (own) own(view);
        if (!R.cam.rot) return;
        // While one is dragged, the others draw its lighter line set too
        // (gl3d's LINES_LOD_STEPS), and the full one again when it stops.
        const moving = R.isInteractive();
        for (const other of renderers) {
          if (other === R) continue;
          const camSame = other.cam.rot && sameCam(R.cam, other.cam);
          if (camSame && other.isInteractive() === moving) continue;
          if (!camSame) copyCam(R.cam, other.cam);
          other.setInteractive(moving);
          other.redraw();
        }
      };
    }
    return {
      frame(bounds) {
        for (const R of renderers) R.frame(bounds);
        for (const R of renderers.slice(1)) copyCam(renderers[0].cam, R.cam);
        for (const R of renderers) R.redraw();
      },
    };
  }

  /** The union of [lo, hi] boxes (nulls skipped), or undefined. */
  function union(boxes) {
    const b = boxes.filter(Boolean);
    if (!b.length) return undefined;
    return [[0, 1, 2].map((d) => Math.min(...b.map((x) => x[0][d]))), [0, 1, 2].map((d) => Math.max(...b.map((x) => x[1][d])))];
  }

  Med.linked = { cameras, union };
})();
