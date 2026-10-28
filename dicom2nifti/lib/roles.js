/* ============================================================================
 * dicom2nifti/lib/roles.js — which series is the T1, which the T2
 * ----------------------------------------------------------------------------
 * From a series' sidecar (either converter writes dcm2niix's field names):
 * words in SeriesDescription / ProtocolName / SequenceName first, then the
 * contrast itself (T1: short TE; T2: long TE and no inversion). FLAIR, SWI,
 * T2*, diffusion, fMRI and localisers are never T1/T2; nor is anything that
 * is not a 3-D volume of at least MIN_VOXELS_PER_AXIS per axis.
 *
 * pick(): the best T1 and T2 -- finest voxels first, then the later series
 * (a repeat is usually the good one).
 * ========================================================================== */
(function () {
  "use strict";
  const D2N = (window.D2N = window.D2N || {});

  const T1_WORDS = ["t1", "mprage", "mp-rage", "mp2rage", "mpr", "tfl", "spgr", "bravo", "fspgr", "tfe"];
  const T2_WORDS = ["t2", "spc", "space", "cube", "tse", "fse", "vista"];
  const EXCLUDE_WORDS = ["flair", "swi", "t2star", "t2*", "fl2d", "dwi", "dti", "diff", "bold",
                         "fmri", "ep2d", "scout", "localizer", "loc", "survey", "mip"];
  const T1_MAX_TE_S = 0.015;
  const T2_MIN_TE_S = 0.060;
  const MIN_VOXELS_PER_AXIS = 64;

  const isAlnum = (w) => /^[a-z0-9]+$/.test(w);

  /** { role: "T1" | "T2" | "", why } for { shape:[...], sidecar:{} }. */
  function classify(series) {
    const j = series.sidecar || {}, shape = series.shape || [];
    const names = [j.SeriesDescription, j.ProtocolName, j.SequenceName];
    const raw = names.map((x) => String(x || "").toLowerCase()).join(" ");
    const toks = names.flatMap((x) => String(x || "").toLowerCase().split(/[^a-z0-9]+/)).filter(Boolean);
    const has = (words) => toks.some((t) => words.some((w) => isAlnum(w) && t.startsWith(w)));
    if (shape.length < 3 || Math.min(...shape.slice(0, 3)) < MIN_VOXELS_PER_AXIS)
      return { role: "", why: "not a 3-D volume" };
    if (shape.length > 3 && shape[3] > 1) return { role: "", why: `${shape[3]} volumes` };
    if (has(EXCLUDE_WORDS) || EXCLUDE_WORDS.some((w) => !isAlnum(w) && raw.includes(w)))
      return { role: "", why: "excluded by its name" };
    const t1 = has(T1_WORDS), t2 = has(T2_WORDS);
    const te = j.EchoTime, ti = j.InversionTime;
    if (t1 && !t2) return { role: "T1", why: "name" };
    if (t2 && !t1) return { role: "T2", why: "name" };
    if (te != null && te <= T1_MAX_TE_S) return { role: "T1", why: `TE ${(1000 * te).toFixed(1)} ms` };
    if (te != null && te >= T2_MIN_TE_S && !ti) return { role: "T2", why: `TE ${(1000 * te).toFixed(0)} ms` };
    return { role: "", why: "unclear" };
  }

  /** { T1: series | null, T2: series | null } among classified series. */
  function pick(list) {
    const best = (role) => {
      const c = list.filter((s) => s.role === role);
      if (!c.length) return null;
      const vol = (s) => (s.zooms || [1, 1, 1]).slice(0, 3).reduce((a, b) => a * b, 1);
      return c.reduce((a, b) => (vol(b) < vol(a) - 1e-9 || (Math.abs(vol(b) - vol(a)) < 1e-9 && (b.number || 0) > (a.number || 0)) ? b : a));
    };
    return { T1: best("T1"), T2: best("T2") };
  }

  /** Why dcm2niix would skip a series (its -i y): derived, localiser, 2-D. */
  function skipReason(series) {
    const type = (series.sidecar && series.sidecar.ImageType || []).map((t) => String(t).toUpperCase());
    if (type.includes("DERIVED")) return "derived";
    if (type.includes("LOCALIZER")) return "localiser";
    if ((series.shape || [1, 1, 1])[2] < 2) return "2-D";
    return "";
  }

  D2N.roles = { classify, pick, skipReason };
})();
