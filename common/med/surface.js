/* ============================================================================
 * common/med/surface.js — a label map's segments as smooth surfaces
 * ----------------------------------------------------------------------------
 * Surface nets, every label in one pass: wherever two neighbouring voxels
 * hold different labels, a quad joins the four cells around that voxel edge
 * -- for each of the two labels that is not background, wound so its normal
 * points out of that label. A cell's vertex (one per label it touches) sits
 * at the mean of the cell-edge midpoints where that label begins or ends:
 * already smoother than voxel faces, and Taubin smoothing (a shrink step,
 * then an inflate step) rounds the staircase off without the shrinkage
 * plain Laplacian smoothing causes. Each label is its own closed mesh, in
 * world mm through the volume's affine.
 *
 * A label map over MAX_VOXELS is subsampled (every s-th voxel) first.
 * ========================================================================== */
(function () {
  "use strict";
  const Med = (window.Med = window.Med || {});

  const MAX_VOXELS = 40e6;
  const TAUBIN = [0.5, -0.53];

  /** labels: Int32Array view of the volume (subsampled), dims [3]. */
  function labelGrid(vol) {
    let s = Math.max(1, Math.ceil(Math.cbrt(vol.nvox / MAX_VOXELS)));
    const dims = vol.dims.map((n) => Math.ceil(n / s));
    const lab = new Int32Array(dims[0] * dims[1] * dims[2]);
    const [nx, ny] = vol.dims;
    let o = 0;
    for (let k = 0; k < dims[2]; k++)
      for (let j = 0; j < dims[1]; j++)
        for (let i = 0; i < dims[0]; i++) lab[o++] = Math.round(vol.value(i * s + nx * (j * s + ny * k * s)));
    // Voxel index of the subsampled grid -> original voxel index -> world.
    const affine = Med.M.mul(vol.affine, [s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, 0, 0, 0, 1]);
    return { lab, dims, step: s, affine };
  }

  /**
   * One mesh per label: Map(id -> { positions, normals, indices }).
   * progress(text) between the passes.
   */
  async function build(vol, smoothIterations, progress) {
    const g = labelGrid(vol);
    const [nx, ny, nz] = g.dims, L = g.lab;
    const at = (x, y, z) => (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz ? 0 : L[x + nx * (y + ny * z)]);
    // Cells: (cx, cy, cz) in -1..n-1, spanning voxels c..c+1.
    const gx = nx + 1, gy = ny + 1;
    const cellKey = (cx, cy, cz) => (cx + 1) + gx * ((cy + 1) + gy * (cz + 1));
    const meshes = new Map();                       // id -> { verts: [], map: Map, tris: [] }
    const meshOf = (id) => {
      let m = meshes.get(id);
      if (!m) { m = { verts: [], map: new Map(), tris: [] }; meshes.set(id, m); }
      return m;
    };
    // The 12 edges of a cell, as corner pairs; corner c = (c&1, c>>1&1, c>>2&1).
    const EDGES = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
    const corner = new Int32Array(8);
    function vertex(m, id, cx, cy, cz) {
      const key = cellKey(cx, cy, cz);
      let v = m.map.get(key);
      if (v !== undefined) return v;
      for (let c = 0; c < 8; c++) corner[c] = at(cx + (c & 1), cy + ((c >> 1) & 1), cz + ((c >> 2) & 1));
      let sx = 0, sy = 0, sz = 0, n = 0;
      for (const [a, b] of EDGES) {
        if ((corner[a] === id) === (corner[b] === id)) continue;
        sx += ((a & 1) + (b & 1)) / 2; sy += (((a >> 1) & 1) + ((b >> 1) & 1)) / 2; sz += (((a >> 2) & 1) + ((b >> 2) & 1)) / 2;
        n++;
      }
      v = m.verts.length / 3;
      m.verts.push(cx + sx / n, cy + sy / n, cz + sz / n);
      m.map.set(key, v);
      return v;
    }
    function quad(id, outward, c0, c1, c2, c3) {
      const m = meshOf(id);
      const v = [vertex(m, id, ...c0), vertex(m, id, ...c1), vertex(m, id, ...c2), vertex(m, id, ...c3)];
      if (outward) m.tris.push(v[0], v[1], v[2], v[0], v[2], v[3]);
      else m.tris.push(v[0], v[2], v[1], v[0], v[3], v[2]);
    }
    for (let z = -1; z < nz; z++) {
      if (progress && (z & 15) === 0) { progress(`Building surfaces: ${Math.round((100 * (z + 1)) / (nz + 1))} %`); await Med.tick(); }
      for (let y = -1; y < ny; y++)
        for (let x = -1; x < nx; x++) {
          const a = at(x, y, z);
          // +x: cells (x, y-1..y, z-1..z); outward for the label at the lower voxel.
          const bx = at(x + 1, y, z);
          if (a !== bx) {
            const c = [[x, y - 1, z - 1], [x, y, z - 1], [x, y, z], [x, y - 1, z]];
            if (a > 0) quad(a, true, ...c);
            if (bx > 0) quad(bx, false, ...c);
          }
          const by = at(x, y + 1, z);
          if (a !== by) {
            const c = [[x - 1, y, z - 1], [x - 1, y, z], [x, y, z], [x, y, z - 1]];
            if (a > 0) quad(a, true, ...c);
            if (by > 0) quad(by, false, ...c);
          }
          const bz = at(x, y, z + 1);
          if (a !== bz) {
            const c = [[x - 1, y - 1, z], [x, y - 1, z], [x, y, z], [x - 1, y, z]];
            if (a > 0) quad(a, true, ...c);
            if (bz > 0) quad(bz, false, ...c);
          }
        }
    }
    const out = new Map();
    let done = 0;
    for (const [id, m] of meshes) {
      if (progress && done++ % 8 === 0) { progress(`Smoothing surfaces: ${done} / ${meshes.size}`); await Med.tick(); }
      const pos = Float32Array.from(m.verts), idx = Uint32Array.from(m.tris);
      smooth(pos, idx, smoothIterations);
      // Voxel coordinates -> world mm.
      const a = g.affine;
      for (let i = 0; i < pos.length; i += 3) {
        const x = pos[i], y = pos[i + 1], z = pos[i + 2];
        pos[i] = a[0] * x + a[1] * y + a[2] * z + a[3];
        pos[i + 1] = a[4] * x + a[5] * y + a[6] * z + a[7];
        pos[i + 2] = a[8] * x + a[9] * y + a[10] * z + a[11];
      }
      // A left-handed affine (one flipped axis) turns the winding inside out.
      const det = Med.M.det3(a);
      if (det < 0) for (let t = 0; t < idx.length; t += 3) { const s = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = s; }
      out.set(id, { positions: pos, normals: normals(pos, idx), indices: idx });
    }
    return { meshes: out, step: g.step };
  }

  /** Taubin smoothing: alternate shrink (λ) and inflate (μ) umbrella steps. */
  function smooth(pos, idx, iterations) {
    if (!iterations) return;
    const n = pos.length / 3;
    const acc = new Float64Array(pos.length), cnt = new Float64Array(n);
    for (let it = 0; it < iterations * 2; it++) {
      const f = TAUBIN[it & 1];
      acc.fill(0); cnt.fill(0);
      for (let t = 0; t < idx.length; t += 3) {
        const a = idx[t], b = idx[t + 1], c = idx[t + 2];
        for (const [p, q] of [[a, b], [b, c], [c, a]]) {
          for (let d = 0; d < 3; d++) { acc[p * 3 + d] += pos[q * 3 + d]; acc[q * 3 + d] += pos[p * 3 + d]; }
          cnt[p]++; cnt[q]++;
        }
      }
      for (let v = 0; v < n; v++) {
        if (!cnt[v]) continue;
        for (let d = 0; d < 3; d++) {
          const i = v * 3 + d;
          pos[i] += f * (acc[i] / cnt[v] - pos[i]);
        }
      }
    }
  }

  /** Area-weighted vertex normals. */
  function normals(pos, idx) {
    const nrm = new Float32Array(pos.length);
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const v of [a, b, c]) { nrm[v] += nx; nrm[v + 1] += ny; nrm[v + 2] += nz; }
    }
    for (let i = 0; i < nrm.length; i += 3) {
      const l = Math.hypot(nrm[i], nrm[i + 1], nrm[i + 2]) || 1;
      nrm[i] /= l; nrm[i + 1] /= l; nrm[i + 2] /= l;
    }
    return nrm;
  }

  Med.surface = { build, normals, smooth, MAX_VOXELS };
})();
