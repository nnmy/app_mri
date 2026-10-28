/* ============================================================================
 * tract_view/lib/simplify.js — heal, cluster, cut, thin, smooth (TV.simplify)
 * ----------------------------------------------------------------------------
 * A tractogram as tractography writes it reads poorly: long tracts broken
 * into pieces, thousands of near-identical streamlines per bundle, short
 * fragments everywhere. This makes a lighter copy for viewing (never for
 * analysis), in two halves:
 *
 *   prepare()  the slow half, run once: HEAL breaks -- two endpoints within
 *              a gap whose outward exit tangents are within an angle of
 *              head-to-tail are joined, one partner per endpoint, best
 *              first, then one pass of length-3 augmenting paths (which
 *              recovers what plain greedy loses in a dense bundle); then
 *              CLUSTER by shape with QuickBundles (MDF over 12 resampled
 *              points, either direction).
 *   select()   the quick half, per slider move: CUT streamlines shorter than
 *              a length (after healing), THIN to a percentage of EVERY
 *              cluster (rounded up, never below one, so a small bundle
 *              survives), SMOOTH each with a Gaussian along it (σ in mm).
 *
 * Which members of a cluster survive is fixed by one seeded random key per
 * streamline: the same percentage keeps the same streamlines, and lowering
 * it only removes, never swaps.
 *
 * QuickBundles is accelerated, not approximated: the MDF distance of two
 * streamlines is at least the distance between their mean points (the mean
 * of point distances >= the distance of the means), so only clusters whose
 * centroid's mean point lies within the threshold -- found in a grid of
 * threshold-sized cells -- can take a streamline.
 * ========================================================================== */
(function () {
  "use strict";
  const TV = (window.TV = window.TV || {});

  const DEFAULTS = {
    heal: false, healGapMm: 2, healAngleDeg: 45,
    minLengthMm: 100, keepPercent: 50, smoothMm: 1.5,
  };
  const TANGENT_POINTS = 4;      // exit tangent measured over this many steps in
  const GAP_STEP_MM = 1;         // points laid across a bridged gap, about this far apart
  const QB_THRESHOLD_MM = 12;
  const QB_POINTS = 12;
  const THIN_SEED = 0;

  const count = (t) => t.offsets.length - 1;

  /** Arc length of every streamline, mm. */
  function lengths(t) {
    const n = count(t), out = new Float64Array(n), p = t.positions;
    for (let k = 0; k < n; k++) {
      let s = 0;
      for (let i = t.offsets[k] + 1; i < t.offsets[k + 1]; i++)
        s += Math.hypot(p[i * 3] - p[i * 3 - 3], p[i * 3 + 1] - p[i * 3 - 2], p[i * 3 + 2] - p[i * 3 - 1]);
      out[k] = s;
    }
    return out;
  }

  // ==========================================================================
  // Healing
  // ==========================================================================
  /** Endpoints [2n] and unit exit tangents (pointing OUT of the streamline). */
  function exitTangents(t) {
    const n = count(t), p = t.positions;
    const ends = new Float64Array(n * 6), tan = new Float64Array(n * 6);
    for (let s = 0; s < n; s++) {
      const a = t.offsets[s], b = t.offsets[s + 1] - 1, k = Math.min(TANGENT_POINTS, b - a);
      for (const [e, end, inner] of [[2 * s, a, a + k], [2 * s + 1, b, b - k]]) {
        const dx = p[end * 3] - p[inner * 3], dy = p[end * 3 + 1] - p[inner * 3 + 1], dz = p[end * 3 + 2] - p[inner * 3 + 2];
        const nn = Math.hypot(dx, dy, dz);
        ends[e * 3] = p[end * 3]; ends[e * 3 + 1] = p[end * 3 + 1]; ends[e * 3 + 2] = p[end * 3 + 2];
        if (nn) { tan[e * 3] = dx / nn; tan[e * 3 + 1] = dy / nn; tan[e * 3 + 2] = dz / nn; }
      }
    }
    return { ends, tan };
  }

  /** Pairs of endpoints within `r` (grid of r-sized cells). Calls fn(i, j, d). */
  function pairsWithin(pts, n, r, fn) {
    const cell = new Map(), key = (a, b, c) => `${a},${b},${c}`;
    for (let i = 0; i < n; i++) {
      const k = key(Math.floor(pts[i * 3] / r), Math.floor(pts[i * 3 + 1] / r), Math.floor(pts[i * 3 + 2] / r));
      let list = cell.get(k);
      if (!list) cell.set(k, (list = []));
      list.push(i);
    }
    for (let i = 0; i < n; i++) {
      const cx = Math.floor(pts[i * 3] / r), cy = Math.floor(pts[i * 3 + 1] / r), cz = Math.floor(pts[i * 3 + 2] / r);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++) {
            const list = cell.get(key(cx + dx, cy + dy, cz + dz));
            if (!list) continue;
            for (const j of list) {
              if (j <= i) continue;
              const d = Math.hypot(pts[i * 3] - pts[j * 3], pts[i * 3 + 1] - pts[j * 3 + 1], pts[i * 3 + 2] - pts[j * 3 + 2]);
              if (d <= r) fn(i, j, d);
            }
          }
    }
  }

  /** One partner per endpoint (-1 = none): greedy best-first, then one pass
   *  of length-3 augmenting paths. */
  function matchEndpoints(I, J, score, nEnd) {
    const link = new Int32Array(nEnd).fill(-1);
    const order = Array.from(score.keys()).sort((a, b) => score[a] - score[b] || a - b);
    const cand = Array.from({ length: nEnd }, () => []);
    for (const k of order) {
      const a = I[k], b = J[k];
      cand[a].push(b); cand[b].push(a);
      if (link[a] === -1 && link[b] === -1) { link[a] = b; link[b] = a; }
    }
    for (let u = 0; u < nEnd; u++) {
      if (link[u] !== -1 || !cand[u].length) continue;
      let done = false;
      for (const v of cand[u]) {
        const w = link[v];
        if (w === -1) continue;
        for (const x of cand[w])
          if (x !== v && x !== u && link[x] === -1) {
            link[u] = v; link[v] = u; link[w] = x; link[x] = w;
            done = true;
            break;
          }
        if (done) break;
      }
    }
    return link;
  }

  /** { tracts (healed), pieces per healed streamline, joins }. */
  function heal(t, gapMm, angleDeg) {
    const n = count(t);
    if (n < 2 || gapMm <= 0) return { tracts: t, pieces: new Int32Array(n).fill(1), joins: 0 };
    const { ends, tan } = exitTangents(t);
    const limit = -Math.cos((angleDeg * Math.PI) / 180);
    const I = [], J = [], score = [];
    pairsWithin(ends, 2 * n, gapMm, (i, j, d) => {
      if ((i >> 1) === (j >> 1)) return;
      const dot = tan[i * 3] * tan[j * 3] + tan[i * 3 + 1] * tan[j * 3 + 1] + tan[i * 3 + 2] * tan[j * 3 + 2];
      if (dot > limit) return;
      const angle = (Math.acos(Math.min(1, Math.max(-1, -dot))) * 180) / Math.PI;
      I.push(i); J.push(j); score.push(d / gapMm + angle / angleDeg);
    });
    const link = I.length ? matchEndpoints(I, J, Float64Array.from(score), 2 * n) : new Int32Array(2 * n).fill(-1);
    let joins = 0;
    for (let e = 0; e < 2 * n; e++) if (link[e] >= 0) joins++;
    joins /= 2;
    if (!joins) return { tracts: t, pieces: new Int32Array(n).fill(1), joins: 0 };

    // Walk every chain from its free end; endpoint 2s is streamline s's
    // first point, 2s+1 its last (entering there means running it backwards).
    const p = t.positions;
    const visited = new Uint8Array(n);
    const outPts = [], outOff = [0], pieces = [];
    let total = 0;
    const push = (x, y, z) => { outPts.push(x, y, z); total++; };
    for (let s = 0; s < n; s++) {
      if (visited[s]) continue;
      let start = 2 * s;
      while (link[start] !== -1) {
        start = link[start] ^ 1;
        if (start === 2 * s) {                       // a closed chain: cut it here
          const partner = link[start];
          link[start] = link[partner] = -1;
          joins--;
          break;
        }
      }
      let e = start, k = 0, last = null;
      for (;;) {
        const line = e >> 1;
        visited[line] = 1;
        k++;
        const a = t.offsets[line], b = t.offsets[line + 1];
        const fwd = (e & 1) === 0;
        const first = fwd ? a : b - 1;
        if (last) {
          const fx = p[first * 3], fy = p[first * 3 + 1], fz = p[first * 3 + 2];
          const d = Math.hypot(fx - last[0], fy - last[1], fz - last[2]);
          const mid = Math.round(d / GAP_STEP_MM) - 1;
          for (let m = 1; m <= mid; m++) {
            const f = m / (mid + 1);
            push(last[0] + f * (fx - last[0]), last[1] + f * (fy - last[1]), last[2] + f * (fz - last[2]));
          }
        }
        if (fwd) for (let i = a; i < b; i++) push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
        else for (let i = b - 1; i >= a; i--) push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
        const lp = fwd ? b - 1 : a;
        last = [p[lp * 3], p[lp * 3 + 1], p[lp * 3 + 2]];
        const nxt = link[e ^ 1];
        if (nxt === -1) break;
        e = nxt;
      }
      outOff.push(total);
      pieces.push(k);
    }
    return { tracts: { positions: Float32Array.from(outPts), offsets: Uint32Array.from(outOff) },
             pieces: Int32Array.from(pieces), joins };
  }

  // ==========================================================================
  // QuickBundles
  // ==========================================================================
  /** Streamline k resampled to m points evenly along its length, into out (3m). */
  function resample(t, k, m, out) {
    const p = t.positions, a = t.offsets[k], b = t.offsets[k + 1];
    const n = b - a;
    const cum = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      const q = (a + i) * 3;
      cum[i] = cum[i - 1] + Math.hypot(p[q] - p[q - 3], p[q + 1] - p[q - 2], p[q + 2] - p[q - 1]);
    }
    const L = cum[n - 1];
    let j = 0;
    for (let s = 0; s < m; s++) {
      const target = m > 1 ? (L * s) / (m - 1) : 0;
      while (j < n - 2 && cum[j + 1] < target) j++;
      const seg = cum[j + 1] - cum[j];
      const f = seg > 0 ? Math.min(1, Math.max(0, (target - cum[j]) / seg)) : 0;
      const q0 = (a + j) * 3, q1 = (a + Math.min(j + 1, n - 1)) * 3;
      out[s * 3] = p[q0] + f * (p[q1] - p[q0]);
      out[s * 3 + 1] = p[q0 + 1] + f * (p[q1 + 1] - p[q0 + 1]);
      out[s * 3 + 2] = p[q0 + 2] + f * (p[q1 + 2] - p[q0 + 2]);
    }
  }

  /** QuickBundles cluster id per streamline. progress(fraction) now and then. */
  async function cluster(t, thresholdMm, progress) {
    const n = count(t), m = QB_POINTS, r = thresholdMm;
    const ids = new Int32Array(n);
    const cents = [];          // { sum: Float64Array(3m), n, mean: [3], cell }
    const grid = new Map();
    const cellKey = (x, y, z) => `${Math.floor(x / r)},${Math.floor(y / r)},${Math.floor(z / r)}`;
    const place = (c) => {
      const key = cellKey(...c.mean);
      if (key === c.cell) return;
      if (c.cell) { const l = grid.get(c.cell); l.splice(l.indexOf(c.id), 1); }
      c.cell = key;
      let l = grid.get(key);
      if (!l) grid.set(key, (l = []));
      l.push(c.id);
    };
    const s = new Float64Array(3 * m);
    for (let k = 0; k < n; k++) {
      if (progress && (k & 4095) === 0) { progress(k / n); await Med.tick(); }
      resample(t, k, m, s);
      let mx = 0, my = 0, mz = 0;
      for (let i = 0; i < m; i++) { mx += s[i * 3]; my += s[i * 3 + 1]; mz += s[i * 3 + 2]; }
      mx /= m; my /= m; mz /= m;
      let best = -1, bestD = Infinity, bestFlip = false;
      const cx = Math.floor(mx / r), cy = Math.floor(my / r), cz = Math.floor(mz / r);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++) {
            const l = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
            if (!l) continue;
            for (const id of l) {
              const c = cents[id];
              if (Math.hypot(c.mean[0] - mx, c.mean[1] - my, c.mean[2] - mz) >= Math.min(r, bestD)) continue;
              const inv = 1 / c.n;
              let d0 = 0, d1 = 0;
              for (let i = 0; i < m; i++) {
                const q = i * 3, qf = (m - 1 - i) * 3;
                const ax = c.sum[q] * inv, ay = c.sum[q + 1] * inv, az = c.sum[q + 2] * inv;
                d0 += Math.hypot(ax - s[q], ay - s[q + 1], az - s[q + 2]);
                d1 += Math.hypot(ax - s[qf], ay - s[qf + 1], az - s[qf + 2]);
              }
              const d = Math.min(d0, d1) / m;
              if (d < bestD) { bestD = d; best = id; bestFlip = d1 < d0; }
            }
          }
      if (best >= 0 && bestD < r) {
        const c = cents[best];
        for (let i = 0; i < m; i++) {
          const q = i * 3, qs = (bestFlip ? m - 1 - i : i) * 3;
          c.sum[q] += s[qs]; c.sum[q + 1] += s[qs + 1]; c.sum[q + 2] += s[qs + 2];
        }
        c.n++;
        c.mean[0] += (mx - c.mean[0]) / c.n; c.mean[1] += (my - c.mean[1]) / c.n; c.mean[2] += (mz - c.mean[2]) / c.n;
        place(c);
        ids[k] = best;
      } else {
        const c = { id: cents.length, sum: Float64Array.from(s), n: 1, mean: [mx, my, mz], cell: null };
        cents.push(c);
        place(c);
        ids[k] = c.id;
      }
    }
    return { ids, n: cents.length, sizes: cents.map((c) => c.n) };
  }

  // ==========================================================================
  // Cut, thin, smooth
  // ==========================================================================
  /** A seeded generator (mulberry32): the same keys every time. */
  function keys(n, seed) {
    let a = seed >>> 0;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      out[i] = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    return out;
  }

  /** Of the candidates, keep ceil(fraction × members) of every cluster, ≥ 1. */
  function thinMask(clusterId, candidates, fraction, key) {
    const n = clusterId.length, keep = new Uint8Array(n);
    const byCluster = new Map();
    for (let i = 0; i < n; i++) {
      if (!candidates[i]) continue;
      let l = byCluster.get(clusterId[i]);
      if (!l) byCluster.set(clusterId[i], (l = []));
      l.push(i);
    }
    const f = Math.min(1, Math.max(0, fraction));
    for (const l of byCluster.values()) {
      l.sort((a, b) => key[a] - key[b]);
      const allowed = Math.max(1, Math.ceil(f * l.length));
      for (let r = 0; r < allowed && r < l.length; r++) keep[l[r]] = 1;
    }
    return keep;
  }

  /** The kept streamlines, each through a Gaussian of sigmaMm along it
   *  (scipy's gaussian_filter1d: truncate 4, edge mode "nearest"). */
  function smoothSubset(t, keep, sigmaMm) {
    const p = t.positions;
    let nL = 0, nP = 0;
    for (let k = 0; k < keep.length; k++) if (keep[k]) { nL++; nP += t.offsets[k + 1] - t.offsets[k]; }
    const out = new Float32Array(nP * 3), off = new Uint32Array(nL + 1);
    let L = 0, P = 0;
    for (let k = 0; k < keep.length; k++) {
      if (!keep[k]) continue;
      const a = t.offsets[k], b = t.offsets[k + 1], n = b - a;
      let sigma = 0;
      if (sigmaMm > 0 && n >= 3) {
        let step = 0;
        for (let i = a + 1; i < b; i++) step += Math.hypot(p[i * 3] - p[i * 3 - 3], p[i * 3 + 1] - p[i * 3 - 2], p[i * 3 + 2] - p[i * 3 - 1]);
        sigma = sigmaMm / Math.max(step / (n - 1), 1e-6);
      }
      if (!sigma) out.set(p.subarray(a * 3, b * 3), P * 3);
      else {
        const rad = Math.floor(4 * sigma + 0.5), w = new Float64Array(2 * rad + 1);
        let sum = 0;
        for (let i = -rad; i <= rad; i++) { w[i + rad] = Math.exp(-0.5 * (i / sigma) ** 2); sum += w[i + rad]; }
        for (let i = 0; i < n; i++) {
          let x = 0, y = 0, z = 0;
          for (let j = -rad; j <= rad; j++) {
            const q = (a + Math.min(n - 1, Math.max(0, i + j))) * 3, ww = w[j + rad] / sum;
            x += ww * p[q]; y += ww * p[q + 1]; z += ww * p[q + 2];
          }
          out[(P + i) * 3] = x; out[(P + i) * 3 + 1] = y; out[(P + i) * 3 + 2] = z;
        }
      }
      P += n;
      off[++L] = P;
    }
    return { positions: out, offsets: off };
  }

  // ==========================================================================
  // The two halves
  // ==========================================================================
  async function prepare(t, o, progress) {
    const t0 = performance.now();
    let healed = t, pieces = null, joins = 0;
    if (o.heal) {
      progress && progress("Healing broken streamlines…");
      await Med.tick();
      ({ tracts: healed, pieces, joins } = heal(t, o.healGapMm, o.healAngleDeg));
    }
    const qb = await cluster(healed, QB_THRESHOLD_MM, (f) => progress && progress(`Clustering (QuickBundles): ${Math.round(100 * f)} %`));
    return {
      healed, pieces, joins, nOriginal: count(t), clusterId: qb.ids, nClusters: qb.n,
      lengths: lengths(healed), key: keys(count(healed), THIN_SEED),
      heal: o.heal, healGapMm: o.healGapMm, healAngleDeg: o.healAngleDeg, seconds: (performance.now() - t0) / 1000,
    };
  }

  function select(prep, o) {
    const n = prep.lengths.length, long = new Uint8Array(n);
    let nLong = 0;
    for (let i = 0; i < n; i++) if (prep.lengths[i] >= o.minLengthMm) { long[i] = 1; nLong++; }
    const keep = thinMask(prep.clusterId, long, o.keepPercent / 100, prep.key);
    let nKept = 0;
    for (let i = 0; i < n; i++) nKept += keep[i];
    return { tracts: smoothSubset(prep.healed, keep, o.smoothMm), nLong, nKept, ...o };
  }

  function summary(prep, sel) {
    const heal = prep.heal ? `healed: ${prep.joins.toLocaleString("en-US")} joins → ${(prep.healed.offsets.length - 1).toLocaleString("en-US")} streamlines` : "not healed";
    return `${sel.nKept.toLocaleString("en-US")} of ${prep.nOriginal.toLocaleString("en-US")} kept (${heal}; ` +
           `${sel.nLong.toLocaleString("en-US")} ≥ ${sel.minLengthMm} mm; ${sel.keepPercent} % of each of ` +
           `${prep.nClusters.toLocaleString("en-US")} clusters` + (sel.smoothMm > 0 ? `; smoothed σ ${sel.smoothMm} mm)` : ")");
  }

  TV.simplify = { DEFAULTS, QB_THRESHOLD_MM, count, lengths, heal, cluster, thinMask, smoothSubset, prepare, select, summary, resample };
})();
