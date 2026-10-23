/* ============================================================================
 * dwi_4d/lib/gradients.js — diffusion gradient tables (window.DW.grad)
 * ----------------------------------------------------------------------------
 *   parse()     a gradient file's text -> b-values and/or directions:
 *                 FSL .bval (one row, or one column) and .bvec (3 rows, or 3
 *                 columns), MRtrix (N rows "x y z b"); told apart by shape,
 *                 not by name
 *   shellOf()   b rounded to the nearest SHELL_STEP; ≤ B0_MAX is a b0
 *   toScanner() an FSL bvec (image axes; x flipped when the image is stored
 *               neurological, i.e. det > 0) -> scanner RAS, through the
 *               image's rotation
 *   metrics()   per shell: directions, the smallest angle between two of
 *               them and the mean angle to the nearest (antipodes count as
 *               the same direction: a diffusion measurement is symmetric),
 *               and the condition number of the tensor fit's design matrix
 *               (rows gx², gy², gz², 2gxgy, 2gxgz, 2gygz): about 1.5 for a
 *               well-spread set, large when directions bunch up
 *   spread()    the n directions of a set that are best spread: greedy
 *               farthest-point (each next one the farthest from those
 *               chosen), starting from the pair farthest apart
 * ========================================================================== */
(function () {
  "use strict";
  const DW = (window.DW = window.DW || {});

  const B0_MAX = 50;          // s/mm²: at or below, a b0
  const SHELL_STEP = 50;      // b-values rounded to this to form shells

  /** Numbers of a text table: rows of numbers (blank lines and # skipped). */
  function table(text) {
    return text.split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim()).filter(Boolean)
      .map((l) => l.split(/[\s,;]+/).map(Number))
      .filter((r) => r.length && r.every(Number.isFinite));
  }

  /** { bvals: [..] | null, bvecs: [[x,y,z], ..] | null, kind } from a file's text. */
  function parse(text, name) {
    const rows = table(text);
    if (!rows.length) throw new Error(`${name}: no numbers in it.`);
    const nr = rows.length, nc = rows[0].length;
    if (rows.some((r) => r.length !== nc)) throw new Error(`${name}: rows of different lengths.`);
    if (nc === 4 && nr >= 2) return { kind: "MRtrix (x y z b)", bvecs: rows.map((r) => r.slice(0, 3)), bvals: rows.map((r) => r[3]) };
    // A direction's components are at most 1; a b-value list has some > 1.
    const big = rows.some((r) => r.some((v) => Math.abs(v) > 1.5));
    if (big && nr === 1) return { kind: "FSL bval (1 row)", bvecs: null, bvals: rows[0] };
    if (big && nc === 1) return { kind: "bval (1 column)", bvecs: null, bvals: rows.map((r) => r[0]) };
    if (nr === 3 && nc >= 1 && !(nc === 3 && looksLikeColumns(rows)))
      return { kind: "FSL bvec (3 rows)", bvecs: rows[0].map((_, i) => [rows[0][i], rows[1][i], rows[2][i]]), bvals: null };
    if (nc === 3) return { kind: "bvec (3 columns)", bvecs: rows.map((r) => r.slice(0, 3)), bvals: null };
    if (nr === 1) return { kind: "FSL bval (1 row)", bvecs: null, bvals: rows[0] };
    if (nc === 1) return { kind: "bval (1 column)", bvecs: null, bvals: rows.map((r) => r[0]) };
    throw new Error(`${name}: a ${nr} × ${nc} table is neither b-values (one row) nor directions (3 rows / 3 columns / 4 columns).`);
  }
  /** A 3 × 3 table: rows of unit vectors (columns layout) or not. */
  function looksLikeColumns(rows) {
    const unitRows = rows.filter((r) => { const n = Math.hypot(...r); return n < 1e-6 || Math.abs(n - 1) < 0.02; }).length;
    const cols = [0, 1, 2].map((c) => rows.map((r) => r[c]));
    const unitCols = cols.filter((r) => { const n = Math.hypot(...r); return n < 1e-6 || Math.abs(n - 1) < 0.02; }).length;
    return unitRows > unitCols;
  }

  const shellOf = (b) => (b <= B0_MAX ? 0 : Math.round(b / SHELL_STEP) * SHELL_STEP);
  const unit = (g) => { const n = Math.hypot(...g); return n > 1e-6 ? g.map((v) => v / n) : [0, 0, 0]; };

  /** FSL bvec -> scanner RAS through the image affine (Med row-major). */
  function toScanner(g, affine) {
    const cols = [0, 1, 2].map((c) => unit([affine[c], affine[4 + c], affine[8 + c]]));
    const det = cols[0][0] * (cols[1][1] * cols[2][2] - cols[1][2] * cols[2][1]) -
                cols[1][0] * (cols[0][1] * cols[2][2] - cols[0][2] * cols[2][1]) +
                cols[2][0] * (cols[0][1] * cols[1][2] - cols[0][2] * cols[1][1]);
    const v = [det > 0 ? -g[0] : g[0], g[1], g[2]];
    return [0, 1, 2].map((r) => cols[0][r] * v[0] + cols[1][r] * v[1] + cols[2][r] * v[2]);
  }

  /** Angle (degrees) between two directions, antipodes the same. */
  const angle = (a, b) => (Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI;

  /** Eigenvalues of a symmetric matrix (Jacobi rotations). */
  function eigSym(A) {
    const n = A.length, a = A.map((r) => r.slice());
    for (let sweep = 0; sweep < 60; sweep++) {
      let off = 0;
      for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
      if (off < 1e-20) break;
      for (let p = 0; p < n; p++)
        for (let q = p + 1; q < n; q++) {
          if (Math.abs(a[p][q]) < 1e-30) continue;
          const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
          const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
          const c = 1 / Math.sqrt(t * t + 1), s = t * c;
          for (let k = 0; k < n; k++) {
            const akp = a[k][p], akq = a[k][q];
            a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
          }
          for (let k = 0; k < n; k++) {
            const apk = a[p][k], aqk = a[q][k];
            a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
          }
        }
    }
    return a.map((r, i) => r[i]);
  }

  /** Condition number of the tensor design matrix of unit directions g
   *  (√(λmax/λmin) of BᵀB); Infinity when fewer than 6 or degenerate. */
  function tensorCondition(dirs) {
    if (dirs.length < 6) return Infinity;
    const BtB = Array.from({ length: 6 }, () => new Array(6).fill(0));
    for (const g of dirs) {
      const [x, y, z] = g;
      const row = [x * x, y * y, z * z, 2 * x * y, 2 * x * z, 2 * y * z];
      for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) BtB[i][j] += row[i] * row[j];
    }
    const ev = eigSym(BtB);
    const lo = Math.min(...ev), hi = Math.max(...ev);
    return lo > 1e-10 * hi ? Math.sqrt(hi / lo) : Infinity;
  }

  /** Per shell b > 0: { b, n, minAngle, meanNearest, cond }. */
  function metrics(entries) {
    const shells = new Map();
    for (const e of entries) {
      if (!e.dir || e.shell === 0) continue;
      if (!shells.has(e.shell)) shells.set(e.shell, []);
      shells.get(e.shell).push(unit(e.dir));
    }
    const out = [];
    for (const [b, dirs] of [...shells.entries()].sort((p, q) => p[0] - q[0])) {
      let minA = 90, sumNear = 0;
      for (let i = 0; i < dirs.length; i++) {
        let near = 90;
        for (let j = 0; j < dirs.length; j++) if (i !== j) near = Math.min(near, angle(dirs[i], dirs[j]));
        minA = Math.min(minA, near);
        sumNear += near;
      }
      out.push({ b, n: dirs.length, minAngle: dirs.length > 1 ? minA : NaN,
                 meanNearest: dirs.length > 1 ? sumNear / dirs.length : NaN, cond: tensorCondition(dirs) });
    }
    return out;
  }

  /** Indices (into dirs) of the n best-spread directions. */
  function spread(dirs, n) {
    const m = dirs.length;
    if (n >= m) return dirs.map((_, i) => i);
    if (n <= 0) return [];
    const u = dirs.map(unit);
    let a = 0, b = 1, best = -1;
    for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) { const t = angle(u[i], u[j]); if (t > best) { best = t; a = i; b = j; } }
    const chosen = n === 1 ? [a] : [a, b];
    const near = u.map((g) => Math.min(...chosen.map((c) => angle(g, u[c]))));
    while (chosen.length < n) {
      let k = -1, far = -1;
      for (let i = 0; i < m; i++) if (!chosen.includes(i) && near[i] > far) { far = near[i]; k = i; }
      chosen.push(k);
      for (let i = 0; i < m; i++) near[i] = Math.min(near[i], angle(u[i], u[k]));
    }
    return chosen.sort((p, q) => p - q);
  }

  /** FSL text: bvals one row; bvecs three rows. */
  function fslText(entries) {
    const f = (v) => String(+v.toFixed(6));
    const bvals = entries.map((e) => f(e.b ?? 0)).join(" ") + "\n";
    const bvecs = [0, 1, 2].map((c) => entries.map((e) => f(e.dir ? e.dir[c] : 0)).join(" ")).join("\n") + "\n";
    return { bvals, bvecs };
  }

  DW.grad = { B0_MAX, SHELL_STEP, parse, shellOf, unit, toScanner, angle, tensorCondition, metrics, spread, fslText };
})();
