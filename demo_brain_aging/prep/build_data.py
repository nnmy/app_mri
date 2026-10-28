# ============================================================================
# demo_brain_aging/prep/build_data.py — the demo's data, built once
# ----------------------------------------------------------------------------
#     ~/anaconda3/bin/python demo_brain_aging/prep/build_data.py
#
# Two typical subjects of Nguyen, Kubota & Hirata, "Age-related changes in
# brain fiber pathways based on directional decomposition of DTI tractograms",
# Neuroscience Informatics 6 (2026) 100255 (their Fig. 6): IXI051 (25 y) and
# IXI518 (75 y). Writes demo_brain_aging/data/ (README.md there says what each
# file is). Steps, per subject:
#
#   1. Tracking in the subject's native space, the paper's settings where
#      this pipeline can follow them (tracking() below): DTI (WLS), FA >= 0.2
#      tracking mask, CSA-ODF (SH order 6), deterministic tracking (DIPY
#      LocalTracking, maximum turn 30 deg, step 0.5 mm), one random seed per
#      voxel of the mask, streamlines >= 20 mm kept. WHOLE-BRAIN, not per
#      ROI: the page crops the tracts to the ROIs instead (the differences
#      are listed in METHOD below and in the page).
#   2. The stored tracts: each streamline resampled to a point every 1 mm at
#      most (native space), quantised to 1/32 mm (store_tracts()).
#   3. Measures in native space, as the paper does (measures()): per ROI,
#      the pieces of streamline inside it (consecutive points whose nearest
#      voxel is in the ROI, >= 20 mm), their direction class (the paper's
#      eq. 2-4, tau = 0.7; Tract View's rule), count and density (pieces per
#      cm3 of the ROI) -- from the full 0.5 mm streamlines.
#   4. Registration for DISPLAY only (register()): IXI518's b0 onto IXI051's
#      (rigid, then affine; Mattes mutual information; registration/py's
#      method); each subject's T2 onto its own b0 and T1 onto its T2
#      (rigid). The common space is IXI051's b0 space. The tracts stay native
#      on disk; the page moves IXI518's with the affine (exact for a
#      polyline) and measures them where they were tracked.
#   5. Display volumes on a 1 mm grid over IXI051's b0 field of view: T1, T2
#      (int16) and the segmentation (nearest neighbour); the segmentation
#      also on the native b0 grid (what the page crops with); the head
#      surface (marching cubes of the segmentation, common space).
#   6. labels.csv (the tissue names), measures.csv (per subject and segment:
#      volume, tract count by direction class; the page's table and charts),
#      manifest.json, the QC pictures.
#
# Reuses: tractography/py/app.py (read_dwi, read_gradients, synthstrip_mask)
# and tract_simplify.resample; registration/py/app.py (its registration
# method and moving_to_fixed_ras). Neither is changed.
# ============================================================================
import gzip
import json
import math
import shutil
import struct
import sys
import tempfile
import time
from pathlib import Path

import nibabel as nib
import numpy as np
import SimpleITK as sitk

HERE = Path(__file__).resolve().parent
DEMO = HERE.parent
APP = DEMO.parent
OUT = DEMO / "data"
sys.path.insert(0, str(APP / "tractography" / "py"))      # app (tractography), tract_simplify

SRC = Path("/home/my/nas/FROM DESKTOP/TAM/young-old-tract-data")
IXI = Path("/home/my/Documents/archived (non-active proj)/BRAIN PROJECTS (IXI)/data")
SUBJECTS = [
    {"key": "young", "id": "IXI051", "stem": "IXI051-HH-1328"},
    {"key": "old", "id": "IXI518", "stem": "IXI518-HH-2239"},
]
REFERENCE = "IXI051"                       # the common (display) space: its b0's

# --- Tracking (the paper's, Section 2.2.1) --------------------------------------
FA_THR = 0.2
SH_ORDER = 6
MAX_ANGLE_DEG = 30
STEP_MM = 0.5
SEEDS_PER_VOXEL = 1                        # random positions inside each voxel
SEED = 0                                   # the random seeds' generator
MIN_LENGTH_MM = 20
SPHERE = "repulsion724"
BRAIN_BORDER_MM = 1.0                      # SynthStrip (the Tractography tool's default)

# --- Measures -------------------------------------------------------------------
MIN_PIECE_MM = 20                          # a piece inside an ROI counts from this length
TAU = 0.7                                  # direction dominance threshold
CLASSES = ["L-R", "A-P", "S-I", "Mixed"]

# --- Storage ----------------------------------------------------------------------
STORE_STEP_MM = 1.0
QUANT = 32                                 # positions in 1/32 mm
DISPLAY_MM = 1.0

TISSUE_LABEL = {
    0: "Background", 1: "blood_in", 2: "Bone (Cancellous)", 3: "Bone (Cortical)", 4: "Cerebellum",
    5: "CSF", 6: "Dura", 7: "Fat", 8: "Gray Matter", 9: "Mucous Tissue", 10: "Muscle", 11: "Skin",
    12: "V. Humour", 13: "White Matter", 14: "Brainstem & Cortical Nucleis", 15: "Thalamus",
    16: "Midbrain", 17: "Pons", 18: "Medullar", 161718: "Brainstem",
}
GROUPS = {161718: [16, 17, 18]}            # a name for several labels together
# The paper's four ROIs, in its colours (Figs. 3, 4).
ROIS = [
    {"id": 13, "name": "Cerebral WM", "color": "#e8930c"},
    {"id": 4, "name": "Cerebellum", "color": "#1fa34a"},
    {"id": 15, "name": "Thalamus", "color": "#25b5d9"},
    {"id": 161718, "name": "Brainstem", "color": "#1f5fb4"},
]

METHOD = {
    "ours": [
        f"Tracking, each subject in native space: SynthStrip mask, DTI FA ≥ {FA_THR}, CSA-ODF, deterministic "
        f"(turn ≤ {MAX_ANGLE_DEG}°, step {STEP_MM} mm), {SEEDS_PER_VOXEL} seed per voxel, streamlines ≥ {MIN_LENGTH_MM} mm.",
        f"Measures: tracts cropped to each segment (pieces ≥ {MIN_PIECE_MM} mm); density = pieces per cm³; "
        f"direction by the mean unit step, τ = {TAU}.",
        "Display only: IXI518 registered onto IXI051's b0 (affine).",
    ],
    "differences": [
        "Whole-brain tracking, then cropping to the segments (the paper tracked each ROI separately), "
        "so densities are higher; their order is the paper's.",
        "SynthStrip brain mask (the paper: Otsu).",
        "Two subjects, no group statistics (the paper: 200 subjects).",
    ],
}


def say(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ============================================================================
# 1. Tracking
# ============================================================================
def tracking(subj, work: Path):
    import app as tg                                  # tractography/py/app.py
    from dipy.core.gradients import gradient_table
    from dipy.data import get_sphere
    from dipy.direction import DeterministicMaximumDirectionGetter
    from dipy.reconst.dti import TensorModel, fractional_anisotropy
    from dipy.reconst.shm import CsaOdfModel
    from dipy.tracking import utils
    from dipy.tracking.local_tracking import LocalTracking
    from dipy.tracking.stopping_criterion import BinaryStoppingCriterion
    from dipy.tracking.streamline import length

    dwi = sorted((SRC / subj["id"] / "norm-dwi").glob("*_norm.nii.gz"))
    bvals, bvecs = tg.read_gradients([IXI / "IXI-DTI" / "bvals.txt", IXI / "IXI-DTI" / "bvecs.txt"])
    data, ref = tg.read_dwi(dwi, say)
    data = data[..., :len(bvals)]                     # IXI's DTI-16, a QC image, left out
    gtab = gradient_table(bvals, bvecs=bvecs, b0_threshold=50)
    b0 = data[..., int(np.argmax(bvals <= 50))].copy()
    affine = ref.affine
    t = time.time()
    run = work / f"{subj['id']}_synthstrip"
    run.mkdir(parents=True, exist_ok=True)
    brain = tg.synthstrip_mask(b0, affine, BRAIN_BORDER_MM, run, say)
    fit = TensorModel(gtab, fit_method="WLS").fit(data, mask=brain)
    fa = np.nan_to_num(fractional_anisotropy(np.clip(fit.evals, 1e-12, None))).astype(np.float32)
    del fit
    mask = fa >= FA_THR
    say(f"{subj['id']}: brain {int(brain.sum()):,} voxels, FA ≥ {FA_THR}: {int(mask.sum()):,} ({time.time() - t:.0f} s)")

    t = time.time()
    sphere = get_sphere(name=SPHERE)
    csa = CsaOdfModel(gtab, sh_order_max=SH_ORDER).fit(data, mask=mask)
    dg = DeterministicMaximumDirectionGetter.from_shcoeff(csa.shm_coeff, max_angle=MAX_ANGLE_DEG, sphere=sphere)
    del csa, data
    seeds = utils.random_seeds_from_mask(mask, affine, seeds_count=SEEDS_PER_VOXEL,
                                         seed_count_per_voxel=True, random_seed=SEED)
    kept, n_all = [], 0
    for s in LocalTracking(dg, BinaryStoppingCriterion(mask), seeds, affine, step_size=STEP_MM):
        n_all += 1
        if len(s) > 1 and length(s) >= MIN_LENGTH_MM:
            kept.append(np.asarray(s, np.float32))
    say(f"{subj['id']}: {n_all:,} streamlines from {len(seeds):,} seeds, {len(kept):,} ≥ {MIN_LENGTH_MM} mm, "
        f"{sum(map(len, kept)):,} points ({time.time() - t:.0f} s)")
    info = {"seeds": int(len(seeds)), "tracked": n_all, "streamlines": len(kept),
            "brain_voxels": int(brain.sum()), "tracking_voxels": int(mask.sum())}
    return kept, b0, affine, info


CACHE = Path(tempfile.gettempdir()) / "demo_brain_aging_cache"


def cached_tracking(subj, work: Path):
    """tracking(), kept between runs (the slow step) under the temp folder,
    keyed by the tracking settings: a re-run that changes only the later
    steps starts from it."""
    key = f"{subj['id']}_{FA_THR}_{SH_ORDER}_{MAX_ANGLE_DEG}_{STEP_MM}_{SEEDS_PER_VOXEL}_{SEED}_{MIN_LENGTH_MM}_{BRAIN_BORDER_MM}"
    f = CACHE / f"{key}.npz"
    if f.is_file():
        z = np.load(f, allow_pickle=False)
        off = z["offsets"]
        lines = [z["points"][off[i]:off[i + 1]] for i in range(len(off) - 1)]
        say(f"{subj['id']}: tracking reused from {f} ({len(lines):,} streamlines)")
        return lines, z["b0"], z["affine"], json.loads(str(z["info"]))
    lines, b0, aff, info = tracking(subj, work)
    CACHE.mkdir(exist_ok=True)
    off = np.concatenate([[0], np.cumsum([len(x) for x in lines])])
    np.savez(f, points=np.concatenate(lines), offsets=off, b0=b0, affine=aff, info=json.dumps(info))
    return lines, b0, aff, info


# ============================================================================
# 2. Stored tracts
# ============================================================================
def store_tracts(streamlines, path: Path):
    """DBA1 file, gzip'd: "DBA1", uint32 header length, JSON header, then
    uint16 points per streamline, int16 xyz of each first point and int8 xyz
    steps for the rest, all in 1/QUANT mm (steps of the QUANTISED points,
    so nothing drifts). Resampled to STORE_STEP_MM at most first."""
    from tract_simplify import resample
    lines = [resample(s, STORE_STEP_MM) for s in streamlines]
    q = [np.round(s * QUANT).astype(np.int32) for s in lines]
    counts = np.array([len(s) for s in q], np.uint16)
    first = np.array([s[0] for s in q], np.int16)
    steps = np.concatenate([np.diff(s, axis=0) for s in q])
    if np.abs(steps).max() > 127 or counts.max() >= 65535:
        raise RuntimeError("a step or a streamline is too long for the format")
    head = json.dumps({"streamlines": len(q), "points": int(counts.sum()), "scale": 1 / QUANT,
                       "space": "RAS", "step_mm": STORE_STEP_MM}).encode()
    body = b"DBA1" + struct.pack("<I", len(head)) + head + counts.tobytes() + first.tobytes() \
        + steps.astype(np.int8).tobytes()
    path.write_bytes(gzip.compress(body, 9))
    return int(counts.sum())


# ============================================================================
# 3. Measures (native space; Tract View's crop / classify, ported)
# ============================================================================
def point_labels(points, seg, inv):
    ijk = np.floor(points @ inv[:3, :3].T + inv[:3, 3] + 0.5).astype(np.int64)
    ok = np.all((ijk >= 0) & (ijk < seg.shape), axis=1)
    out = np.zeros(len(points), np.int32)
    out[ok] = seg[ijk[ok, 0], ijk[ok, 1], ijk[ok, 2]]
    return out


def classify(m):
    """Direction class of mean unit-step vectors m (k x 3): 0 L-R, 1 A-P,
    2 S-I, 3 Mixed; Tract View's rule and tie order (A-P, S-I, L-R)."""
    n = np.linalg.norm(m, axis=1, keepdims=True)
    a = np.abs(m / np.where(n > 0, n, 1))
    x, y, z = a[:, 0], a[:, 1], a[:, 2]
    out = np.full(len(m), 3, np.int8)
    lr = (x > y) & (x > z) & (x >= TAU)
    out[lr] = 0
    si = (z > x) & (z > y) & (z >= TAU)
    out[si] = 2
    ap = (y > x) & (y > z) & (y >= TAU)
    out[ap] = 1
    out[n[:, 0] == 0] = 3
    return out


def measures(streamlines, seg, seg_affine):
    """Per label (and group): the pieces inside it -- runs of consecutive
    points of one streamline whose nearest voxel is in it, >= 2 points and
    >= MIN_PIECE_MM long (Tract View's crop, "clip") -- counted by direction
    class (each piece's mean unit step), with the volume and the density."""
    P = np.concatenate(streamlines).astype(np.float64)
    lens = np.array([len(x) for x in streamlines])
    first = np.zeros(len(P), bool); first[np.cumsum(lens)[:-1]] = True; first[0] = True
    last = np.zeros(len(P), bool); last[np.cumsum(lens) - 1] = True
    step = np.zeros_like(P)
    step[1:] = P[1:] - P[:-1]
    step[first] = 0                                   # no step into a streamline's first point
    sl = np.linalg.norm(step, axis=1)
    unit = step / (sl[:, None] + 1e-6)
    unit[first] = 0
    C, U = np.cumsum(sl), np.cumsum(unit, axis=0)     # up to and including point i
    labels = point_labels(P, seg, np.linalg.inv(seg_affine))
    vox_cm3 = abs(np.linalg.det(seg_affine[:3, :3])) / 1000
    ids = sorted(int(i) for i in np.unique(seg) if i > 0)
    out = {}
    for rid in ids + list(GROUPS):
        members = GROUPS.get(rid, [rid])
        vol = float(np.isin(seg, members).sum() * vox_cm3)
        if not vol:
            continue
        inside = np.isin(labels, members)
        prev = np.r_[False, inside[:-1]] & ~first
        nxt = np.r_[inside[1:], False] & ~last
        s_idx = np.flatnonzero(inside & ~prev)
        e_idx = np.flatnonzero(inside & ~nxt)
        length = C[e_idx] - C[s_idx]
        keep = (e_idx > s_idx) & (length >= MIN_PIECE_MM)
        cls = classify((U[e_idx] - U[s_idx])[keep])
        by = np.bincount(cls, minlength=4).tolist()
        total = int(keep.sum())
        out[str(rid)] = {"volume_cm3": round(vol, 2), "count": total, "by_class": by,
                         "density": round(total / vol, 2)}
    return out


# ============================================================================
# 4. Registration (display only)
# ============================================================================
_REG = None


def write_measures(stats, path: Path):
    """One row per subject and segment: volume, tract count, the count per direction class."""
    rows = ["subject,id,volume_cm3,count," + ",".join(c.lower().replace("-", "") for c in CLASSES)]
    for sid, by_id in stats.items():
        for k, m in by_id.items():
            rows.append(f"{sid},{k},{m['volume_cm3']},{m['count']}," + ",".join(str(n) for n in m["by_class"]))
    path.write_text("\n".join(rows) + "\n")


def reg_module():
    """registration/py/app.py, loaded by path (its name, app, is also the
    tractography module's)."""
    global _REG
    if _REG is None:
        import importlib.util
        spec = importlib.util.spec_from_file_location("registration_app", APP / "registration" / "py" / "app.py")
        _REG = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(_REG)
    return _REG


def register(fixed: sitk.Image, moving: sitk.Image, affine: bool, name: str) -> sitk.Transform:
    """Rigid, then (if asked) affine: registration/py's method and stages."""
    reg = reg_module()
    t = sitk.CenteredTransformInitializer(fixed, moving, sitk.Euler3DTransform(),
                                          sitk.CenteredTransformInitializerFilter.GEOMETRY)
    before = reg._metric(fixed, moving, t)
    t = reg._stage(fixed, moving, t, f"{name} rigid", say)
    if affine:
        a = sitk.AffineTransform(3)
        a.SetMatrix(t.GetMatrix()); a.SetTranslation(t.GetTranslation()); a.SetCenter(t.GetCenter())
        t = reg._stage(fixed, moving, a, f"{name} affine", say)
    say(f"{name}: metric {before:.4f} → {reg._metric(fixed, moving, t):.4f}")
    return t


def as_matrix(t: sitk.Transform) -> np.ndarray:
    """4x4 (LPS) of an ITK affine-family transform: fixed point -> moving point."""
    m = np.asarray(t.GetMatrix()).reshape(3, 3)
    c, tr = np.asarray(t.GetCenter()), np.asarray(t.GetTranslation())
    a = np.eye(4)
    a[:3, :3], a[:3, 3] = m, c + tr - m @ c
    return a


def from_matrix(a: np.ndarray) -> sitk.AffineTransform:
    t = sitk.AffineTransform(3)
    t.SetMatrix(a[:3, :3].ravel().tolist())
    t.SetTranslation(a[:3, 3].tolist())
    return t


LPS = np.diag([-1.0, -1.0, 1.0, 1.0])


def ras_point_map(fixed_to_moving_lps: np.ndarray) -> np.ndarray:
    """moving RAS -> fixed RAS, from ITK's fixed -> moving (LPS)."""
    return LPS @ np.linalg.inv(fixed_to_moving_lps) @ LPS


def sitk_from_nib(img) -> sitk.Image:
    tmp = Path(tempfile.mkstemp(suffix=".nii.gz")[1])
    nib.save(img, str(tmp))
    out = sitk.ReadImage(str(tmp), sitk.sitkFloat32)
    tmp.unlink()
    return out


# ============================================================================
# 5. Display volumes
# ============================================================================
def display_grid(b0_ref) -> sitk.Image:
    """A 1 mm grid, axes along R, A, S (written LPS for ITK), over the
    reference b0's field of view."""
    shape, aff = np.array(b0_ref.shape[:3]), b0_ref.affine
    corners = np.array([[i, j, k, 1] for i in (-0.5, shape[0] - 0.5) for j in (-0.5, shape[1] - 0.5)
                        for k in (-0.5, shape[2] - 0.5)]) @ aff.T
    lo, hi = corners[:, :3].min(0), corners[:, :3].max(0)
    size = np.ceil((hi - lo) / DISPLAY_MM).astype(int)
    img = sitk.Image([int(s) for s in size], sitk.sitkFloat32)
    img.SetSpacing([DISPLAY_MM] * 3)
    # RAS axes: x along R = -L, y along A = -P, z along S.
    img.SetDirection([-1, 0, 0, 0, -1, 0, 0, 0, 1])
    origin_ras = lo + DISPLAY_MM / 2
    img.SetOrigin([-origin_ras[0], -origin_ras[1], origin_ras[2]])
    return img


def resample(img, grid, transform, nearest=False, pixel=sitk.sitkFloat32):
    return sitk.Resample(img, grid, transform, sitk.sitkNearestNeighbor if nearest else sitk.sitkLinear,
                         0, pixel)


def write(img: sitk.Image, path: Path):
    sitk.WriteImage(img, str(path), useCompression=True)


def to_int16(img: sitk.Image) -> sitk.Image:
    a = sitk.GetArrayFromImage(img)
    hi = np.percentile(a[a > 0], 99.9) if np.any(a > 0) else 1
    out = sitk.GetImageFromArray((np.clip(a, 0, None) * np.float32(min(1.0, 30000 / hi))).astype(np.float32))
    out.CopyInformation(img)
    return sitk.Cast(out, sitk.sitkInt16)


def head_surface(seg_disp: sitk.Image, path: Path):
    """The head (every label > 0) as a triangle mesh, common space, VTK
    (legacy binary, LPS on disk, tagged SPACE=LPS)."""
    from scipy import ndimage
    from skimage import measure
    a = sitk.GetArrayFromImage(seg_disp).transpose(2, 1, 0) > 0         # (x, y, z) RAS-ordered grid
    a = ndimage.binary_fill_holes(ndimage.binary_closing(a, iterations=2))
    v, f, _n, _vals = measure.marching_cubes(ndimage.gaussian_filter(a.astype(np.float32), 1.0), 0.5, step_size=2)
    # Index -> RAS: the grid's RAS origin plus index * spacing (axes R, A, S).
    o = np.array(seg_disp.GetOrigin()) * np.array([-1, -1, 1])
    ras = o + v * DISPLAY_MM
    lps = (ras * np.array([-1, -1, 1])).astype(">f4")
    cells = np.hstack([np.full((len(f), 1), 3), f]).astype(">i4")
    with open(path, "wb") as fh:
        fh.write(f"# vtk DataFile Version 3.0\nhead SPACE=LPS\nBINARY\nDATASET POLYDATA\nPOINTS {len(lps)} float\n".encode())
        fh.write(lps.tobytes())
        fh.write(f"\nPOLYGONS {len(f)} {cells.size}\n".encode())
        fh.write(cells.tobytes())
        fh.write(b"\n")
    return len(v), len(f)


# ============================================================================
# 6. QC pictures
# ============================================================================
def qc_picture(fixed: sitk.Image, moving_on_fixed: sitk.Image, title: str, path: Path):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from skimage import feature
    f = sitk.GetArrayFromImage(fixed)
    m = sitk.GetArrayFromImage(moving_on_fixed)
    fig, axes = plt.subplots(1, 3, figsize=(12, 4.4), facecolor="black")
    for ax, (name, sl) in zip(axes, (("axial", lambda a: a[a.shape[0] // 2]),
                                     ("coronal", lambda a: a[:, a.shape[1] // 2]),
                                     ("sagittal", lambda a: a[:, :, a.shape[2] // 2]))):
        fs, ms = sl(f), sl(m)
        ax.imshow(fs, cmap="gray", origin="lower" if name != "axial" else "upper",
                  vmax=np.percentile(fs, 99.5))
        edge = feature.canny(ms / (np.percentile(ms, 99.5) + 1e-6), sigma=1.5)
        ax.imshow(np.ma.masked_where(~edge, edge), cmap="autumn", alpha=0.9,
                  origin="lower" if name != "axial" else "upper")
        ax.set_title(name, color="white", fontsize=9)
        ax.axis("off")
    fig.suptitle(title, color="white", fontsize=10)
    fig.savefig(path, dpi=90, facecolor="black", bbox_inches="tight")
    plt.close(fig)


# ============================================================================
def main():
    OUT.mkdir(exist_ok=True)
    (OUT / "qc").mkdir(exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="demo_brain_aging_"))
    import pandas as pd
    demo = pd.read_excel(IXI / "IXI_Demographic_Info.xlsx")

    # labels.csv: the tissue names, as given (161718 = 16 + 17 + 18, a group).
    (OUT / "labels.csv").write_text("id,name\n" + "".join(f"{k},{v}\n" for k, v in TISSUE_LABEL.items()))

    subs = {}
    for subj in SUBJECTS:
        sid = subj["id"]
        sdir = OUT / sid
        sdir.mkdir(exist_ok=True)
        row = demo[demo["IXI_ID"] == int(sid[3:])].iloc[0]
        subj.update(age=int(math.floor(row["AGE"])), age_exact=round(float(row["AGE"]), 1),
                    sex={1: "M", 2: "F"}.get(int(row["SEX_ID (1=m, 2=f)"]), "?"),
                    brain_volume_cm3=float(row["ESTIMATED_BRAIN_VOL_IN_CM3"]))
        streamlines, b0, b0_aff, info = cached_tracking(subj, work)
        seg_img = nib.load(str(SRC / sid / "seg" / f"{sid}_voxelized_b0match.nii.gz"))
        seg = np.rint(np.asarray(seg_img.dataobj)).astype(np.uint8)
        if not np.allclose(seg_img.affine, b0_aff, atol=1e-3):
            raise RuntimeError(f"{sid}: the segmentation is not on the b0 grid")
        t = time.time()
        stats = measures(streamlines, seg, b0_aff)
        say(f"{sid}: ROI measures ({time.time() - t:.0f} s): " + ", ".join(
            f"{r['name']} {stats[str(r['id'])]['density']}/cm³" for r in ROIS if str(r["id"]) in stats))
        n_pts = store_tracts(streamlines, sdir / "tracts.dba.gz")
        nib.save(nib.Nifti1Image(seg, b0_aff), str(sdir / "seg_native.nii.gz"))
        nib.save(nib.Nifti1Image(b0.astype(np.float32), b0_aff), str(work / f"{sid}_b0.nii.gz"))
        subs[sid] = {"subj": subj, "info": {**info, "stored_points": n_pts}, "stats": stats,
                     "b0": work / f"{sid}_b0.nii.gz", "seg": sdir / "seg_native.nii.gz"}
        del streamlines

    # --- registration ------------------------------------------------------------
    ref_b0_nib = nib.load(str(subs[REFERENCE]["b0"]))
    ref_b0 = sitk.ReadImage(str(subs[REFERENCE]["b0"]), sitk.sitkFloat32)
    grid = display_grid(ref_b0_nib)
    say(f"Display grid: {grid.GetSize()} voxels of {DISPLAY_MM} mm")
    for sid, s in subs.items():
        b0 = sitk.ReadImage(str(s["b0"]), sitk.sitkFloat32)
        if sid == REFERENCE:
            to_ref = np.eye(4)                                       # common LPS -> this b0 (LPS)
        else:
            t = register(ref_b0, b0, True, f"{sid} b0 → {REFERENCE} b0")
            to_ref = as_matrix(t)
            qc_picture(ref_b0, resample(b0, ref_b0, t), f"{sid} b0 (edges, affine) on {REFERENCE} b0",
                       OUT / "qc" / f"{sid}_b0_on_{REFERENCE}.png")
        s["native_to_common"] = ras_point_map(to_ref)               # native RAS -> common RAS
        st = s["subj"]["stem"]
        t2 = sitk.ReadImage(str(IXI / "IXI-T2" / f"{st}-T2.nii.gz"), sitk.sitkFloat32)
        t1 = sitk.ReadImage(str(IXI / "IXI-T1" / f"{st}-T1.nii.gz"), sitk.sitkFloat32)
        t_t2 = register(b0, t2, False, f"{sid} T2 → b0")
        t_t1 = register(t2, t1, False, f"{sid} T1 → T2")
        qc_picture(b0, resample(t2, b0, t_t2), f"{sid} T2 (edges, rigid) on its b0", OUT / "qc" / f"{sid}_T2_on_b0.png")
        m_t2 = as_matrix(t_t2) @ to_ref                              # display -> T2
        m_t1 = as_matrix(t_t1) @ m_t2                                # display -> T1
        sdir = OUT / sid
        write(to_int16(resample(t1, grid, from_matrix(m_t1))), sdir / "t1.nii.gz")
        write(to_int16(resample(t2, grid, from_matrix(m_t2))), sdir / "t2.nii.gz")
        seg_disp = resample(sitk.ReadImage(str(s["seg"])), grid, from_matrix(to_ref), nearest=True,
                            pixel=sitk.sitkUInt8)
        write(seg_disp, sdir / "seg.nii.gz")
        nv, nf = head_surface(seg_disp, sdir / "head.vtk")
        say(f"{sid}: display volumes written; head surface {nv:,} points, {nf:,} triangles")
    # --- manifest ------------------------------------------------------------------
    manifest = {
        "title": "Brain aging: tracts of a younger and an older subject",
        "paper": {"citation": "M.N. Nguyen, Y. Kubota, A. Hirata, Age-related changes in brain fiber pathways "
                              "based on directional decomposition of DTI tractograms, Neuroscience Informatics 6 "
                              "(2026) 100255", "doi": "10.1016/j.neuri.2025.100255"},
        "reference": REFERENCE,
        "labels": "labels.csv", "measures": "measures.csv", "groups": {str(k): v for k, v in GROUPS.items()}, "rois": ROIS,
        "classes": CLASSES, "tau": TAU, "min_piece_mm": MIN_PIECE_MM,
        "tracking": {"fa_thr": FA_THR, "sh_order": SH_ORDER, "max_angle_deg": MAX_ANGLE_DEG, "step_mm": STEP_MM,
                     "seeds_per_voxel": SEEDS_PER_VOXEL, "min_length_mm": MIN_LENGTH_MM,
                     "brain_mask": f"SynthStrip, border {BRAIN_BORDER_MM:g} mm"},
        "method": METHOD,
        "subjects": [{
            **{k: s["subj"][k] for k in ("key", "id", "stem", "age", "age_exact", "sex", "brain_volume_cm3")},
            "files": {"tracts": f"{sid}/tracts.dba.gz", "seg_native": f"{sid}/seg_native.nii.gz",
                      "seg": f"{sid}/seg.nii.gz", "t1": f"{sid}/t1.nii.gz", "t2": f"{sid}/t2.nii.gz",
                      "head": f"{sid}/head.vtk"},
            "native_to_common": np.round(s["native_to_common"], 6).tolist(),
            "tracking": s["info"],
        } for sid, s in subs.items()],
        "built": time.strftime("%Y-%m-%d %H:%M"),
    }
    write_measures({sid: s["stats"] for sid, s in subs.items()}, OUT / "measures.csv")
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=1, ensure_ascii=False))
    shutil.rmtree(work, ignore_errors=True)
    say(f"Done: {OUT}")


if __name__ == "__main__":
    main()
