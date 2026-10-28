# ============================================================================
# tractography/py/app.py — whole-brain tractography from a DWI series
# (DIPY; the page's server side)
# ----------------------------------------------------------------------------
# Mounted by server.py at /py/tractography; `python app.py` runs it alone.
#
#   track()  DWI volumes (several 3D, or one 4D) + .bval / .bvec -> whole-
#            brain streamlines, written as VTK and/or PLY, plus the FA map.
#
# The method is the lab's (PROJ_DCONDNET b6_dti_wholebrain_tractography.py,
# core/med/lib_dwi.py + lib_tract.py), step for step:
#   1. brain mask: median Otsu on the b0 (radius 2, one pass), dilated by 5 %
#      of the smallest image dimension; a 30th-percentile threshold of the
#      b0 when Otsu keeps under 100 voxels;
#      -- or, the page's other choice, SynthStrip on the b0 (below);
#   2. DTI fit (WLS) in the brain mask -> FA; the tracking mask is
#      FA >= FA_THR;
#   3. CSA-ODF (SH order 6) peaks on the repulsion724 sphere in the tracking
#      mask (relative peak threshold 0.5, at least 45° apart);
#   4. deterministic local tracking from `seed density` seeds per voxel of
#      the mask, stopping where it ends (binary), step 0.875 mm;
#   5. streamlines shorter than 80 mm dropped (the lab's b6 dropped those
#      under 20 mm); no streamline is healed (joined across a break).
# With the lab's data the volumes are named <subject>-...-DTI-NN_*.nii.gz, in
# file-name order; any volume beyond the b-values (IXI's DTI-16, a QC image)
# is left out, as b3_nii_preprocessing.py does.
#
# Streamlines leave the tracker in world mm (RAS: it is given the b0
# affine). Files written:
#   .vtk   binary legacy PolyData LINES, LPS on disk (dipy's and 3D Slicer's
#          convention), tagged SPACE=LPS in the title line; per-point
#          direction colours as POINT_DATA COLOR_SCALARS "rgb";
#   .ply   binary little-endian, a vertex element (float x, y, z) and an
#          edge element (int vertex1, vertex2) per step, RAS, tagged with a
#          "comment SPACE=RAS" line (as 3D Slicer writes); the vertices
#          carry the same colours (uchar red, green, blue);
#   _simplified.vtk / .ply  (when asked) a lighter copy, made alike for every
#          subject: >= 80 mm, 30 % at random, a point every 2 mm
#          at most (tract_simplify.py, which also makes it from a saved VTK);
#   _brainmask.nii.gz  the brain mask the DTI was fitted in (uint8);
# and, for the page's viewer only (not among the results):
#   preview.vtk  every k-th streamline, at most PREVIEW_STREAMLINES (the full
#          file can be over 100 MB);
#   preview_fa.nii.gz  the FA map on the DWI grid (float32).
# The settings, counts and times come back as the result, not as a file.
#
# SynthStrip (Hoopes et al., NeuroImage 2022; vendored verbatim in
# synthstrip/, see its VERSION.md) runs under its own interpreter, as
# APP_BRAINE's lfmultigrid2026a runs it. The b6 mask's dilation reaches into
# skull and scalp, where the noise fits a high FA: on IXI034, 31 % of the
# FA >= 0.2 voxels lay on non-brain tissue (by its segmentation); 9 % with
# SynthStrip's mask, 3 % with its border 2 mm inside the brain.
# ============================================================================
import os
import subprocess
import queue
import re
import shutil
import tempfile
import threading
import time
from pathlib import Path

import gradio as gr
import nibabel as nib
import numpy as np

import tract_simplify

# --- Settings (the lab's defaults; the page may change the first four) -------
FA_THR = 0.2                 # tracking mask: FA >= this
SEED_DENSITY = 1             # seeds per voxel (per axis, as dipy counts it)
STEP_MM = 0.875              # tracking step
MIN_LENGTH_MM = 80           # shorter streamlines are dropped (b6: 20)
SH_ORDER = 6                 # CSA-ODF spherical-harmonic order
PEAK_THRESHOLD = 0.5         # relative peak threshold
MIN_SEPARATION_DEG = 45      # peaks closer than this merge
SPHERE = "repulsion724"
B0_MAX = 50                  # s/mm²: at or below, a b0
OTSU_MEDIAN_RADIUS, OTSU_PASSES = 2, 1
MASK_DILATION = 0.05         # of the smallest image dimension, in voxels
MIN_BRAIN_VOXELS = 100       # fewer: Otsu failed, use a percentile of the b0
# Brain mask: "synthstrip" (the default) or "b6" (the lab's). SynthStrip's mask
# is its signed distance map (mm, < 0 inside) below the border, which is 1 mm
# by default as in its own script; negative moves the edge inwards.
BRAIN_MASKS = ("b6", "synthstrip")
SYNTHSTRIP_BORDER_MM = 1.0
SYNTHSTRIP_BORDER_RANGE_MM = (-10.0, 10.0)
SYNTHSTRIP_DIR = Path(__file__).resolve().parent / "synthstrip"
SYNTHSTRIP_SCRIPT = SYNTHSTRIP_DIR / "mri_synthstrip"
SYNTHSTRIP_MODEL = SYNTHSTRIP_DIR / "models" / "synthstrip.1.pt"
# The conda env built from synthstrip/cpu.requirements.txt (Python 3.10).
SYNTHSTRIP_PYTHON = Path(os.environ.get("MRI_SYNTHSTRIP_PYTHON")
                         or Path.home() / "anaconda3" / "envs" / "synthstrip" / "bin" / "python")
SYNTHSTRIP_TIMEOUT_S = 10 * 60     # a b0 takes seconds on CPU; past this it is hung
PROBE_TIMEOUT_S = 120
LOG_EVERY = 50000            # streamlines between progress lines
PREVIEW_STREAMLINES = 20000  # at most this many (every k-th) in the page's 3D view
FORMATS = ("vtk", "ply")
# Run folders and how long they are kept.
RUNS = Path(tempfile.gettempdir()) / "mri_wlab" / "tractography"
KEEP_RUNS_S = 2 * 3600

NII = re.compile(r"\.nii(\.gz)?$", re.I)


def _new_run() -> Path:
    RUNS.mkdir(parents=True, exist_ok=True)
    for old in RUNS.iterdir():
        if time.time() - old.stat().st_mtime > KEEP_RUNS_S:
            shutil.rmtree(old, ignore_errors=True)
    return Path(tempfile.mkdtemp(prefix=time.strftime("%Y%m%d-%H%M%S_"), dir=RUNS))


def _natural(name: str):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", name)]


def subject_stem(names) -> str:
    """A name for the outputs: the part of the DWI file names before
    '-DTI' / '_dwi' (IXI051-HH-1328-DTI-00_norm -> IXI051-HH-1328), else
    their common prefix."""
    stems = [NII.sub("", Path(n).name) for n in names]
    prefix = stems[0]
    for s in stems[1:]:
        while not s.startswith(prefix):
            prefix = prefix[:-1]
    prefix = re.split(r"[-_.](?:DTI|DWI)(?:[-_.]|$)", prefix, maxsplit=1, flags=re.I)[0]
    return prefix.strip("-_. ") or "dwi"


# ============================================================================
# Inputs
# ============================================================================
def _numbers(path) -> np.ndarray:
    rows = []
    for line in Path(path).read_text(errors="replace").splitlines():
        line = line.split("#")[0].strip()
        if line:
            rows.append([float(v) for v in re.split(r"[\s,;]+", line)])
    if not rows or len({len(r) for r in rows}) != 1:
        raise gr.Error(f"{Path(path).name}: not a table of numbers.")
    return np.array(rows)


def read_gradients(paths):
    """(bvals [N], bvecs [N, 3]) from FSL files, told apart by shape: one row
    or column -> b-values; three rows or columns -> directions."""
    bvals = bvecs = None
    for p in paths:
        t = _numbers(p)
        if 1 in t.shape:
            bvals = t.ravel()
        elif t.shape[0] == 3:
            bvecs = t.T
        elif t.shape[1] == 3:
            bvecs = t
        else:
            raise gr.Error(f"{Path(p).name}: {t.shape[0]} × {t.shape[1]} numbers; "
                           "a .bval (one row) or a .bvec (three rows) is needed.")
    if bvals is None or bvecs is None:
        raise gr.Error("Both a .bval and a .bvec file are needed.")
    if len(bvals) != len(bvecs):
        raise gr.Error(f"{len(bvals)} b-values but {len(bvecs)} directions.")
    return bvals, bvecs


def read_dwi(paths, say):
    """(data [X, Y, Z, N] float32, the first volume's image) from one 4D file
    or several 3D ones (stacked in file-name order, on one grid)."""
    paths = sorted(paths, key=lambda p: _natural(Path(p).name))
    imgs = [nib.load(str(p)) for p in paths]
    if len(imgs) == 1 and len(imgs[0].shape) == 4:
        say(f"DWI: {Path(paths[0]).name}, 4D, {imgs[0].shape[3]} volumes")
        return np.asarray(imgs[0].dataobj, dtype=np.float32), imgs[0]
    ref = imgs[0]
    for p, img in zip(paths, imgs):
        if len(img.shape) != 3:
            raise gr.Error(f"{Path(p).name} is {len(img.shape)}-D: give 3D volumes, or one 4D file.")
        if img.shape != ref.shape or not np.allclose(img.affine, ref.affine, atol=1e-3):
            raise gr.Error(f"{Path(p).name} is not on the grid of {Path(paths[0]).name}.")
    say(f"DWI: {len(paths)} 3D volumes, {Path(paths[0]).name} … {Path(paths[-1]).name}")
    return np.stack([np.asarray(i.dataobj, dtype=np.float32) for i in imgs], axis=-1), ref


def brain_mask(b0: np.ndarray) -> np.ndarray:
    from dipy.segment.mask import median_otsu
    from scipy.ndimage import binary_dilation
    _, mask = median_otsu(b0, median_radius=OTSU_MEDIAN_RADIUS, numpass=OTSU_PASSES)
    mask = binary_dilation(mask, iterations=int(MASK_DILATION * min(mask.shape)))
    if mask.sum() < MIN_BRAIN_VOXELS:
        mask = b0 > np.percentile(b0, 30)
    return mask


def _clean_env():
    """Ours, minus anything that would point SynthStrip's interpreter at this
    server's packages."""
    return {k: v for k, v in os.environ.items() if k not in ("PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP")}


_probed = None


def synthstrip_status():
    """(available, message), probed once: the files there and
    `import torch, surfa` working under SynthStrip's interpreter."""
    global _probed
    if _probed is None:
        _probed = _probe()
    return _probed


def _probe():
    for path, what in ((SYNTHSTRIP_PYTHON, "SynthStrip's Python"), (SYNTHSTRIP_SCRIPT, "the SynthStrip script"),
                       (SYNTHSTRIP_MODEL, "the SynthStrip weights")):
        if not Path(path).is_file():
            return False, f"{what} not found at {path} (see tractography/py/synthstrip/VERSION.md)."
    try:
        proc = subprocess.run([str(SYNTHSTRIP_PYTHON), "-c", "import torch, surfa; print(torch.__version__)"],
                              capture_output=True, text=True, env=_clean_env(), timeout=PROBE_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        return False, f"SynthStrip's Python did not answer within {PROBE_TIMEOUT_S} s."
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout).strip().splitlines()[-1:] or ["?"]
        return False, f"`import torch, surfa` failed under {SYNTHSTRIP_PYTHON}: {tail[0]}"
    return True, f"SynthStrip (torch {proc.stdout.strip()})"


def synthstrip_mask(b0: np.ndarray, affine: np.ndarray, border_mm: float, run: Path, say) -> np.ndarray:
    """SynthStrip on the b0 (the vendored script, unmodified); the mask is
    its distance map below `border_mm`, on the DWI grid."""
    ok, message = synthstrip_status()
    if not ok:
        raise gr.Error(message)
    work = run / "synthstrip"
    work.mkdir()
    image, sdt = work / "b0.nii.gz", work / "b0_sdt.nii.gz"
    nib.save(nib.Nifti1Image(b0.astype(np.float32), affine), str(image))
    cmd = [str(SYNTHSTRIP_PYTHON), str(SYNTHSTRIP_SCRIPT), "-i", str(image), "-d", str(sdt),
           "--model", str(SYNTHSTRIP_MODEL)]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, errors="replace", env=_clean_env(),
                              timeout=SYNTHSTRIP_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        raise gr.Error(f"SynthStrip took over {SYNTHSTRIP_TIMEOUT_S} s and was stopped.")
    if proc.returncode != 0 or not sdt.is_file():
        for line in (proc.stdout + proc.stderr).strip().splitlines()[-10:]:
            say(f"  synthstrip | {line}")
        raise gr.Error(f"SynthStrip failed (exit code {proc.returncode}).")
    dist = np.asarray(nib.load(str(sdt)).dataobj, dtype=np.float32)
    shutil.rmtree(work, ignore_errors=True)
    return dist < border_mm


# ============================================================================
# Writers
# ============================================================================
def direction_colours(streamlines):
    """RGB (uint8) per point from the local direction, |dx|, |dy|, |dz| of
    the step to the next point (the last point: from the one before), lifted
    off black: the page's colours (common/med/tracts.js localColours)."""
    pts = np.concatenate(streamlines).astype(np.float64)
    lens = np.array([len(s) for s in streamlines], np.int64)
    d = np.zeros_like(pts)
    d[:-1] = pts[1:] - pts[:-1]
    ends = np.cumsum(lens) - 1                     # last point of each streamline
    d[ends] = 0
    tail = ends[lens > 1]
    d[tail] = pts[tail] - pts[tail - 1]
    n = np.linalg.norm(d, axis=1, keepdims=True)
    n[n == 0] = 1
    return (40 + 215 * np.abs(d / n)).astype(np.uint8)


def write_vtk(streamlines, path: Path, title: str):
    """Binary legacy VTK, LPS on disk, big-endian as the format requires."""
    # Sign flip first: arithmetic on a big-endian array returns a native one.
    pts = (np.concatenate(streamlines) * np.array([-1, -1, 1], np.float32)).astype(">f4")
    lens = np.array([len(s) for s in streamlines], np.int64)
    starts = np.concatenate([[0], np.cumsum(lens)[:-1]])
    cells = np.empty(int(lens.sum() + len(lens)), ">i4")
    at = np.concatenate([[0], np.cumsum(lens + 1)[:-1]])
    cells[at] = lens
    fill = np.ones(len(cells), bool)
    fill[at] = False
    cells[fill] = np.concatenate([np.arange(s, s + n) for s, n in zip(starts, lens)])
    with open(path, "wb") as f:
        f.write(f"# vtk DataFile Version 3.0\n{title} SPACE=LPS\nBINARY\nDATASET POLYDATA\n"
                f"POINTS {len(pts)} float\n".encode())
        f.write(pts.tobytes())
        f.write(f"\nLINES {len(lens)} {len(cells)}\n".encode())
        f.write(cells.tobytes())
        # COLOR_SCALARS in a binary file: unsigned chars, 0..255.
        f.write(f"\nPOINT_DATA {len(pts)}\nCOLOR_SCALARS rgb 3\n".encode())
        f.write(direction_colours(streamlines).tobytes())
        f.write(b"\n")


def write_ply(streamlines, path: Path, title: str):
    """Binary little-endian PLY: vertices + one edge per step, RAS."""
    pts = np.concatenate(streamlines).astype("<f4")
    vert = np.empty(len(pts), [("xyz", "<f4", 3), ("rgb", "u1", 3)])
    vert["xyz"], vert["rgb"] = pts, direction_colours(streamlines)
    lens = np.array([len(s) for s in streamlines], np.int64)
    step = np.ones(len(pts) - 1, bool)
    step[np.cumsum(lens)[:-1] - 1] = False         # no edge from one streamline to the next
    a = np.nonzero(step)[0].astype("<i4")
    edges = np.stack([a, a + 1], axis=1)
    with open(path, "wb") as f:
        f.write(f"ply\nformat binary_little_endian 1.0\ncomment {title}\ncomment SPACE=RAS\n"
                f"comment {len(lens)} streamlines\n"
                f"element vertex {len(pts)}\nproperty float x\nproperty float y\nproperty float z\n"
                "property uchar red\nproperty uchar green\nproperty uchar blue\n"
                f"element edge {len(edges)}\nproperty int vertex1\nproperty int vertex2\n"
                "end_header\n".encode())
        f.write(vert.tobytes())
        f.write(edges.tobytes())


# ============================================================================
# Tractography
# ============================================================================
def _track(dwi, grads, params, formats, run: Path, say):
    from dipy.core.gradients import gradient_table
    from dipy.data import get_sphere
    from dipy.direction import peaks_from_model
    from dipy.reconst.dti import TensorModel, fractional_anisotropy
    from dipy.reconst.shm import CsaOdfModel
    from dipy.tracking import utils
    from dipy.tracking.local_tracking import LocalTracking
    from dipy.tracking.stopping_criterion import BinaryStoppingCriterion
    from dipy.tracking.streamline import length

    t_all = time.time()
    bvals, bvecs = read_gradients(grads)
    data, ref = read_dwi(dwi, say)
    n_vol, n_grad = data.shape[3], len(bvals)
    if n_vol < n_grad:
        raise gr.Error(f"{n_vol} volumes but {n_grad} b-values.")
    if n_vol > n_grad:
        extra = f"{n_grad}" if n_vol - n_grad == 1 else f"{n_grad}–{n_vol - 1}"
        say(f"Note: {n_vol} volumes but {n_grad} b-values: volume {extra} (counting from 0) left out, "
            "as the lab's preprocessing does (in IXI, a QC image)")
        data = data[..., :n_grad]
    b0s = bvals <= B0_MAX
    if not b0s.any():
        raise gr.Error("No b0 volume (b ≤ 50) among the b-values.")
    shells = sorted({int(round(b / 50) * 50) for b in bvals[~b0s]})
    say(f"Gradients: {int(b0s.sum())} b0 + {int((~b0s).sum())} at b = {', '.join(map(str, shells))}")
    zooms = ref.header.get_zooms()[:3]
    say(f"Grid: {' × '.join(map(str, data.shape[:3]))} voxels of "
        f"{' × '.join(f'{z:.2f}' for z in zooms)} mm, {''.join(nib.aff2axcodes(ref.affine))}")
    gtab = gradient_table(bvals, bvecs=bvecs, b0_threshold=B0_MAX)
    affine = ref.affine
    stem = subject_stem(dwi)
    times = {}

    t = time.time()
    b0 = data[..., int(np.argmax(b0s))]
    if params["brain_mask"] == "synthstrip":
        say(f"Brain mask: SynthStrip on the b0, border {params['synthstrip_border_mm']:g} mm…")
        mask = synthstrip_mask(b0, ref.affine, params["synthstrip_border_mm"], run, say)
        times["brain_mask_s"] = round(time.time() - t, 1)
        say(f"SynthStrip: {int(mask.sum()):,} voxels ({times['brain_mask_s']} s)")
        if mask.sum() < MIN_BRAIN_VOXELS:
            raise gr.Error(f"SynthStrip's mask has {int(mask.sum())} voxels: is the b0 a brain?")
        t = time.time()
    else:
        mask = brain_mask(b0)
    fit = TensorModel(gtab, fit_method="WLS").fit(data, mask=mask)
    fa = np.nan_to_num(fractional_anisotropy(np.clip(fit.evals, 1e-12, None))).astype(np.float32)
    del fit
    track_mask = fa >= params["fa_thr"]
    times["dti_s"] = round(time.time() - t, 1)
    mask_label = ("SynthStrip" if params["brain_mask"] == "synthstrip" else "Otsu + dilation")
    say(f"DTI (WLS): brain mask ({mask_label}) {int(mask.sum()):,} voxels; FA ≥ {params['fa_thr']}: "
        f"{int(track_mask.sum()):,} voxels ({times['dti_s']} s)")
    if track_mask.sum() == 0:
        raise gr.Error(f"No voxel has FA ≥ {params['fa_thr']}: lower the threshold.")

    t = time.time()
    say("Fibre directions (CSA-ODF peaks)…")
    peaks = peaks_from_model(CsaOdfModel(gtab, sh_order_max=SH_ORDER), data, get_sphere(name=SPHERE),
                             relative_peak_threshold=PEAK_THRESHOLD, min_separation_angle=MIN_SEPARATION_DEG,
                             mask=track_mask, return_sh=False, return_odf=False, normalize_peaks=True)
    del data
    times["peaks_s"] = round(time.time() - t, 1)
    say(f"Peaks: done ({times['peaks_s']} s)")

    t = time.time()
    seeds = utils.seeds_from_mask(track_mask, affine=affine, density=int(params["seed_density"]))
    say(f"Tracking from {len(seeds):,} seeds, step {params['step_mm']} mm…")
    kept, n_all = [], 0
    for s in LocalTracking(peaks, BinaryStoppingCriterion(track_mask), seeds, affine=affine,
                           step_size=params["step_mm"]):
        n_all += 1
        if len(s) > 1 and length(s) >= params["min_length_mm"]:
            kept.append(s.astype(np.float32))
        if n_all % LOG_EVERY == 0:
            say(f"  {n_all:,} streamlines, {len(kept):,} of them ≥ {params['min_length_mm']:g} mm")
    times["tracking_s"] = round(time.time() - t, 1)
    if not kept:
        raise gr.Error("No streamline long enough: check the inputs or lower the minimum length.")
    n_pts = int(sum(len(s) for s in kept))
    lens = np.array([length(s) for s in kept])
    say(f"Tracking: {n_all:,} streamlines, {len(kept):,} kept (≥ {params['min_length_mm']:g} mm), "
        f"{n_pts:,} points ({times['tracking_s']} s)")

    files = []
    title = f"{stem}_wb_tracts"
    if "vtk" in formats:
        files.append(run / f"{title}.vtk")
        write_vtk(kept, files[-1], title)
    if "ply" in formats:
        files.append(run / f"{title}.ply")
        write_ply(kept, files[-1], title)
    simplified = None
    if params["simplified"]:
        t = time.time()
        light, simplified = tract_simplify.simplify(kept)
        if not light:
            raise gr.Error(f"No streamline is {tract_simplify.MIN_LENGTH_MM:g} mm or longer: "
                           "no simplified copy (untick it).")
        for f, write in (("vtk", write_vtk), ("ply", write_ply)):
            if f in formats:
                files.append(run / f"{title}_simplified.{f}")
                write(light, files[-1], f"{title}_simplified")
        times["simplify_s"] = round(time.time() - t, 1)
        say(f"Simplified copy: {simplified['long_streamlines']:,} ≥ {tract_simplify.MIN_LENGTH_MM:g} mm, "
            f"{simplified['streamlines']:,} kept ({times['simplify_s']} s)")
    files.append(run / f"{stem}_brainmask.nii.gz")
    nib.save(nib.Nifti1Image(mask.astype(np.uint8), affine), str(files[-1]))
    times["total_s"] = round(time.time() - t_all, 1)
    result = {
        "subject": stem,
        "streamlines": len(kept), "tracked": n_all, "points": n_pts, "seeds": int(len(seeds)),
        "length_mm": {"mean": round(float(lens.mean()), 1), "median": round(float(np.median(lens)), 1),
                      "max": round(float(lens.max()), 1)},
        "volumes": {"files": n_vol, "used": n_grad, "b0": int(b0s.sum()), "shells": shells},
        "grid": {"dims": list(map(int, fa.shape)), "spacing_mm": [round(float(z), 3) for z in zooms],
                 "orientation": "".join(nib.aff2axcodes(affine))},
        "mask_voxels": {"brain": int(mask.sum()), "tracking": int(track_mask.sum())},
        "settings": {**params, "fit": "DTI (WLS)", "model": "CSA-ODF", "sh_order": SH_ORDER,
                     "peak_threshold": PEAK_THRESHOLD, "min_separation_deg": MIN_SEPARATION_DEG,
                     "sphere": SPHERE, "stopping": "binary (tracking mask)"}
                    | ({} if params["brain_mask"] == "synthstrip" else {"synthstrip_border_mm": None}),
        "simplified": simplified,
        "times": times,
        "files": [p.name for p in files],
    }
    say(f"Saved {', '.join(p.name for p in files)} ({times['total_s']} s in all)")
    preview, preview_fa = run / "preview.vtk", run / "preview_fa.nii.gz"
    write_vtk(kept[::max(1, -(-len(kept) // PREVIEW_STREAMLINES))], preview, "preview")
    nib.save(nib.Nifti1Image(fa, affine), str(preview_fa))
    return result, files + [preview, preview_fa]


def track(dwi, grads, fa_thr, seed_density, step_mm, min_length_mm, formats,
          brain_mask_method="synthstrip", synthstrip_border_mm=SYNTHSTRIP_BORDER_MM, simplified=True):
    """Yields (log, result, files): the log as it grows, then the result.
    The work runs in a thread so the log reaches the page while it runs."""
    dwi = [str(p) for p in (dwi or [])]
    grads = [str(p) for p in (grads or [])]
    if not dwi:
        raise gr.Error("No DWI volumes.")
    if not grads:
        raise gr.Error("No .bval / .bvec files.")
    formats = [f for f in (formats or []) if f in FORMATS]
    if not formats:
        raise gr.Error("Choose VTK and/or PLY.")
    params = {"fa_thr": float(fa_thr), "seed_density": int(seed_density), "step_mm": float(step_mm),
              "min_length_mm": float(min_length_mm), "brain_mask": str(brain_mask_method or "synthstrip"),
              "synthstrip_border_mm": float(synthstrip_border_mm), "simplified": bool(simplified)}
    lo, hi = SYNTHSTRIP_BORDER_RANGE_MM
    if not (0 < params["fa_thr"] < 1 and 1 <= params["seed_density"] <= 4
            and 0.1 <= params["step_mm"] <= 5 and params["min_length_mm"] >= 0
            and params["brain_mask"] in BRAIN_MASKS and lo <= params["synthstrip_border_mm"] <= hi):
        raise gr.Error("Settings out of range.")
    run = _new_run()
    lines, q, box = [], queue.Queue(), {}

    def work():
        try:
            box["out"] = _track(dwi, grads, params, formats, run, q.put)
        except Exception as exc:                       # noqa: BLE001 - reported to the page
            box["err"] = exc

    th = threading.Thread(target=work, daemon=True)
    th.start()
    while th.is_alive() or not q.empty():
        try:
            lines.append(q.get(timeout=0.5))
            while not q.empty():
                lines.append(q.get_nowait())
            yield "\n".join(lines), None, None
        except queue.Empty:
            pass
    for p in dwi + grads:                     # the uploads, from Gradio's cache
        Path(p).unlink(missing_ok=True)
    if "err" in box:
        err = box["err"]
        raise err if isinstance(err, gr.Error) else gr.Error(f"{type(err).__name__}: {err}")
    result, files = box["out"]
    yield "\n".join(lines), result, [str(f) for f in files]


def options():
    """What the page may offer: whether SynthStrip is there, and the border
    default and range."""
    ok, message = synthstrip_status()
    return {"synthstrip": {"available": ok, "message": message, "border_mm": SYNTHSTRIP_BORDER_MM,
                           "border_range_mm": list(SYNTHSTRIP_BORDER_RANGE_MM)}}


def build() -> gr.Blocks:
    with gr.Blocks(title="Tractography service") as demo:
        gr.Markdown("Service for the Tractography page; use the page.")
        dwi = gr.File(label="DWI volumes", file_count="multiple")
        grads = gr.File(label=".bval + .bvec", file_count="multiple")
        fa_thr = gr.Number(FA_THR, label="FA threshold")
        seed_density = gr.Number(SEED_DENSITY, label="Seeds per voxel", precision=0)
        step_mm = gr.Number(STEP_MM, label="Step (mm)")
        min_length = gr.Number(MIN_LENGTH_MM, label="Minimum length (mm)")
        formats = gr.CheckboxGroup(list(FORMATS), value=["vtk"], label="Formats")
        mask = gr.Radio(list(BRAIN_MASKS), value="synthstrip", label="Brain mask")
        border = gr.Number(SYNTHSTRIP_BORDER_MM, label="SynthStrip border (mm)")
        light = gr.Checkbox(True, label="Simplified copy")
        log, result, files = gr.Textbox(label="Log"), gr.JSON(label="Result"), gr.File(file_count="multiple")
        gr.Button("Run").click(track, [dwi, grads, fa_thr, seed_density, step_mm, min_length, formats, mask, border, light],
                               [log, result, files], api_name="track")
        info = gr.JSON(label="Options")
        gr.Button("Options").click(options, None, info, api_name="options")
    return demo


if __name__ == "__main__":
    build().launch()
