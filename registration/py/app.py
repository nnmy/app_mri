# ============================================================================
# registration/py/app.py — register a moving NIfTI onto a fixed one
# (SimpleITK; the page's server side)
# ----------------------------------------------------------------------------
# Mounted by server.py at /py/registration; `python app.py` runs it alone.
#
#   register()   fixed + moving (+ the moving image's segmentation) -> a
#                rigid, or rigid-then-affine, transform in physical (mm)
#                space (Mattes mutual information, so the two may differ in
#                modality); the moving image resampled into the fixed space
#                (linear, float32) and the segmentation with the same
#                transform (nearest neighbour, labels and type kept). The
#                output grid (output_grid()) is the fixed image's -- or, per
#                the page's two boxes, the fixed orientation with the moving
#                image's voxel size and/or a size holding the whole
#                registered moving image. Output voxels beyond the moving
#                image take its nearest edge value (nearest-neighbour
#                extrapolation), not 0.
#   cohistogram_png()  the moving image before (x) vs after (y)
#                registration, voxel by voxel on the fixed grid, with both
#                histograms as marginals, the mutual information, the
#                transform and the image centre before and after.
#
# Registration runs in physical space through each file's own header: the
# segmentation need only share the moving image's space, not its grid. The
# page draws the slices itself from the files returned.
#
# Method settings: a regular-step optimizer, coarse-to-fine. On a known
# 8-degree / 6 % scale / 12 mm distortion of a T1, it recovered the labels to
# Dice 0.98 where plain gradient descent (whose convergence check stops after
# a few iterations at full resolution) reached 0.67.
# ============================================================================
import io
import json
import queue
import re
import shutil
import tempfile
import threading
import time
from pathlib import Path

import gradio as gr
import numpy as np
import SimpleITK as sitk

# --- Settings ---------------------------------------------------------------
# Method choices -> stages run, in order. Affine runs a rigid stage first.
MODES = {"Rigid (6 DOF)": ("rigid",), "Affine (12 DOF)": ("rigid", "affine")}
HISTOGRAM_BINS = 50
SAMPLING_PERCENTAGE = 0.2          # random voxel sample per iteration
SAMPLING_SEED = 42                 # fixed: the same inputs give the same result
SHRINK_FACTORS = (4, 2, 1)         # coarse-to-fine pyramid
SMOOTHING_SIGMAS_MM = (2, 1, 0)
LEARNING_RATE = 2.0                # first step, in mm (scales from physical shift)
MIN_STEP = 1e-4                    # stop when the step shrinks below this
MAX_ITERATIONS = 500               # per pyramid level
# Co-histogram: bins per axis, intensity range (0 to this percentile of the
# non-zero voxels; brighter ones go in the last bin), figure size and dpi.
COHIST_BINS = 128
COHIST_TOP_PERCENTILE = 99.5
COHIST_FIGSIZE = (6.4, 7.4)
COHIST_DPI = 100
# Run folders and how long they are kept.
RUNS = Path(tempfile.gettempdir()) / "mri_wlab" / "registration"
KEEP_RUNS_S = 2 * 3600


def _stem(path) -> str:
    return re.sub(r"\.nii(\.gz)?$", "", Path(path).name, flags=re.I)


def _read(path, label: str, pixel_type=None) -> sitk.Image:
    img = sitk.ReadImage(str(path), pixel_type) if pixel_type is not None else sitk.ReadImage(str(path))
    if img.GetDimension() != 3:
        raise gr.Error(f"{label} {Path(path).name} is {img.GetDimension()}-D; a 3-D volume is needed.")
    return img


def _new_run() -> Path:
    RUNS.mkdir(parents=True, exist_ok=True)
    for old in RUNS.iterdir():
        if time.time() - old.stat().st_mtime > KEEP_RUNS_S:
            shutil.rmtree(old, ignore_errors=True)
    return Path(tempfile.mkdtemp(prefix=time.strftime("%Y%m%d-%H%M%S_"), dir=RUNS))


# ============================================================================
# Registration
# ============================================================================
def _method(initial_transform) -> sitk.ImageRegistrationMethod:
    m = sitk.ImageRegistrationMethod()
    m.SetMetricAsMattesMutualInformation(numberOfHistogramBins=HISTOGRAM_BINS)
    m.SetMetricSamplingStrategy(m.RANDOM)
    m.SetMetricSamplingPercentage(SAMPLING_PERCENTAGE, seed=SAMPLING_SEED)
    m.SetInterpolator(sitk.sitkLinear)
    m.SetOptimizerAsRegularStepGradientDescent(
        learningRate=LEARNING_RATE, minStep=MIN_STEP, numberOfIterations=MAX_ITERATIONS,
        gradientMagnitudeTolerance=1e-8)
    m.SetOptimizerScalesFromPhysicalShift()
    m.SetShrinkFactorsPerLevel(list(SHRINK_FACTORS))
    m.SetSmoothingSigmasPerLevel(list(SMOOTHING_SIGMAS_MM))
    m.SmoothingSigmasAreSpecifiedInPhysicalUnitsOn()
    m.SetInitialTransform(initial_transform, inPlace=False)
    return m


def _unwrap(transform):
    """Execute() may wrap the result in a CompositeTransform."""
    if isinstance(transform, sitk.CompositeTransform):
        return transform.GetNthTransform(transform.GetNumberOfTransforms() - 1)
    return transform


def _stage(fixed, moving, transform, name, say):
    method = _method(transform)
    level = {"n": 0}

    def on_level():
        level["n"] += 1
        say(f"{name}: pyramid level {level['n']} / {len(SHRINK_FACTORS)}")

    method.AddCommand(sitk.sitkMultiResolutionIterationEvent, on_level)
    t0 = time.time()
    try:
        out = _unwrap(method.Execute(fixed, moving))
    except RuntimeError as exc:
        say(f"{name} stage failed ({exc}); keeping the previous transform")
        return transform
    say(f"{name}: {method.GetOptimizerStopConditionDescription()} "
        f"({time.time() - t0:.0f} s, metric {method.GetMetricValue():.4f})")
    return out


def _metric(fixed, moving, transform) -> float:
    """Mattes MI of the pair under `transform` (lower = better match)."""
    return _method(transform).MetricEvaluate(fixed, moving)


def output_grid(fixed, moving, transform, match_spacing: bool, match_size: bool) -> sitk.Image:
    """An empty image on the grid the outputs are written on, always in the
    fixed image's orientation:
      spacing  the fixed image's, or (match_spacing off) the moving image's;
      size     the fixed image's voxel counts, centred on the fixed image --
               with its spacing, exactly the fixed grid -- or (match_size
               off) as many voxels as cover the whole registered moving
               image, on a lattice through the fixed image's origin."""
    if match_spacing and match_size:
        return fixed
    d = np.asarray(fixed.GetDirection()).reshape(3, 3)
    f_org = np.asarray(fixed.GetOrigin())
    spacing = np.asarray(fixed.GetSpacing() if match_spacing else moving.GetSpacing(), float)
    if match_size:
        size = np.asarray(fixed.GetSize(), int)
        centre = np.asarray(fixed.TransformContinuousIndexToPhysicalPoint(
            [(n - 1) / 2.0 for n in fixed.GetSize()]))
        origin = centre - d @ (spacing * (size - 1) / 2.0)
    else:
        inverse = transform.GetInverse()
        corners = [moving.TransformContinuousIndexToPhysicalPoint(
                       [c * (n - 1) for c, n in zip(bits, moving.GetSize())])
                   for bits in np.ndindex(2, 2, 2)]
        pts = np.array([inverse.TransformPoint(c) for c in corners])
        idx = (d.T @ (pts - f_org).T).T / spacing
        i0, i1 = np.floor(idx.min(0) + 1e-6), np.ceil(idx.max(0) - 1e-6)
        size = (i1 - i0 + 1).astype(int)
        origin = f_org + d @ (spacing * i0)
    grid = sitk.Image([int(n) for n in size], sitk.sitkUInt8)
    grid.SetSpacing([float(x) for x in spacing])
    grid.SetOrigin([float(x) for x in origin])
    grid.SetDirection(fixed.GetDirection())
    return grid


def _register(fixed_path, moving_path, seg_path, mode, match_spacing, match_size, run: Path, say):
    stages = MODES[mode]
    fixed = _read(fixed_path, "Fixed", sitk.sitkFloat32)
    moving = _read(moving_path, "Moving", sitk.sitkFloat32)
    seg = _read(seg_path, "Segmentation") if seg_path else None
    say(f"Fixed {Path(fixed_path).name}: {fixed.GetSize()} voxels of "
        f"{tuple(round(s, 3) for s in fixed.GetSpacing())} mm")
    say(f"Moving {Path(moving_path).name}: {moving.GetSize()} voxels of "
        f"{tuple(round(s, 3) for s in moving.GetSpacing())} mm")
    if seg is not None and seg.GetSize() != moving.GetSize():
        say("Note: the segmentation's grid differs from the moving image's; "
            "it is mapped through its own header (same space assumed)")

    transform = sitk.CenteredTransformInitializer(
        fixed, moving, sitk.Euler3DTransform(), sitk.CenteredTransformInitializerFilter.GEOMETRY)
    before = _metric(fixed, moving, transform)
    say(f"Start: image centres aligned (metric {before:.4f})")
    if "rigid" in stages:
        transform = _stage(fixed, moving, transform, "Rigid", say)
    if "affine" in stages:
        affine = sitk.AffineTransform(3)
        affine.SetMatrix(transform.GetMatrix())
        affine.SetTranslation(transform.GetTranslation())
        affine.SetCenter(transform.GetCenter())
        transform = _stage(fixed, moving, affine, "Affine", say)
    after = _metric(fixed, moving, transform)

    grid = output_grid(fixed, moving, transform, match_spacing, match_size)
    say(f"Output grid: {grid.GetSize()} voxels of {tuple(round(x, 3) for x in grid.GetSpacing())} mm"
        + (" (the fixed image's)" if grid is fixed else
           f" (fixed orientation; {'fixed' if match_spacing else 'moving'} voxel size, "
           f"{'fixed size' if match_size else 'fits the whole moving image'})"))
    written = sitk.Resample(moving, grid, transform, sitk.sitkLinear, 0.0, sitk.sitkFloat32, True)
    files = [run / f"{_stem(moving_path)}_reg.nii.gz"]
    sitk.WriteImage(written, str(files[0]))
    if seg is not None:
        out_seg = sitk.Resample(seg, grid, transform, sitk.sitkNearestNeighbor, 0, seg.GetPixelID(), True)
        files.append(run / f"{_stem(seg_path)}_reg.nii.gz")
        sitk.WriteImage(out_seg, str(files[1]))

    # The co-histogram compares on the FIXED grid, 0 outside the moving
    # image: before = placed by its header only, after = registered.
    on_fixed = sitk.Resample(moving, fixed, transform, sitk.sitkLinear, 0.0, sitk.sitkFloat32)
    placed = sitk.Resample(moving, fixed, sitk.Transform(3, sitk.sitkIdentity), sitk.sitkLinear, 0.0,
                           sitk.sitkFloat32)
    png = cohistogram_png(sitk.GetArrayFromImage(placed), sitk.GetArrayFromImage(on_fixed),
                          transform, moving, mode)
    figure = run / f"{_stem(moving_path)}_cohistogram.png"
    figure.write_bytes(png)
    files.append(figure)

    m = np.asarray(transform.GetMatrix()).reshape(3, 3)
    t = np.asarray(transform.GetTranslation())
    say(f"{mode}: metric {before:.4f} → {after:.4f}")
    result = {
        "mode": mode, "metric_before": before, "metric_after": after,
        "moving_to_fixed_ras": moving_to_fixed_ras(transform).round(6).tolist(),
        "itk_matrix": m.round(6).tolist(), "itk_translation_mm": t.round(4).tolist(),
        "output_grid": {"size": list(grid.GetSize()), "spacing": [round(x, 4) for x in grid.GetSpacing()],
                        "fixed_grid": grid is fixed},
        "files": [p.name for p in files],
    }
    (run / "transform.json").write_text(json.dumps(result, indent=2))
    files.append(run / "transform.json")
    return result, files


def register(fixed, moving, seg, mode, match_spacing, match_size):
    """Yields (log, result, files): the log as it grows, then the result.
    The work runs in a thread so the log reaches the page while it runs."""
    if not fixed or not moving:
        raise gr.Error("Both a fixed and a moving image are needed.")
    if mode not in MODES:
        raise gr.Error(f"Unknown method {mode!r}.")
    run = _new_run()
    lines, q, box = [], queue.Queue(), {}

    def say(msg):
        q.put(msg)

    def work():
        try:
            box["out"] = _register(fixed, moving, seg, mode, bool(match_spacing), bool(match_size), run, say)
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
    for p in (fixed, moving, seg):          # the uploads, from Gradio's cache
        if p:
            Path(p).unlink(missing_ok=True)
    if "err" in box:
        err = box["err"]
        raise err if isinstance(err, gr.Error) else gr.Error(f"{type(err).__name__}: {err}")
    result, files = box["out"]
    yield "\n".join(lines), result, [str(f) for f in files]


# ============================================================================
# The displacement co-histogram
# ============================================================================
def moving_to_fixed_ras(transform) -> np.ndarray:
    """4x4: a point of the moving image -> where it lands in the fixed image,
    in RAS mm (the inverse of ITK's fixed -> moving transform, from LPS)."""
    m = np.asarray(transform.GetMatrix()).reshape(3, 3)
    c = np.asarray(transform.GetCenter())
    t = np.asarray(transform.GetTranslation())
    a = np.eye(4)
    a[:3, :3] = m
    a[:3, 3] = c + t - m @ c
    flip = np.diag([-1.0, -1.0, 1.0, 1.0])
    return flip @ np.linalg.inv(a) @ flip


def centre_of_mass_ras(image: sitk.Image) -> np.ndarray:
    arr = sitk.GetArrayFromImage(image).astype(np.float64)        # (z, y, x)
    w = np.where(arr > 0, arr, 0.0)
    idx = np.indices(arr.shape).reshape(3, -1)
    zyx = (idx * w.ravel()).sum(axis=1) / max(w.sum(), 1e-12)
    lps = image.TransformContinuousIndexToPhysicalPoint([float(zyx[2]), float(zyx[1]), float(zyx[0])])
    return np.diag([-1.0, -1.0, 1.0]) @ np.asarray(lps)


def mutual_information(joint: np.ndarray) -> float:
    p = joint / max(joint.sum(), 1)
    px, py = p.sum(axis=1, keepdims=True), p.sum(axis=0, keepdims=True)
    nz = p > 0
    return float((p[nz] * np.log2(p[nz] / (px @ py)[nz])).sum())


def cohistogram_png(before: np.ndarray, after: np.ndarray, transform, moving, mode: str) -> bytes:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    keep = (before > 0) | (after > 0)                  # drop shared background
    x, y = before[keep].astype(np.float64), after[keep].astype(np.float64)
    both = np.concatenate([x[x > 0], y[y > 0]])
    top = float(np.percentile(both, COHIST_TOP_PERCENTILE)) if both.size else 1.0
    top = top or 1.0
    edges = np.linspace(0.0, top, COHIST_BINS + 1)
    joint, _, _ = np.histogram2d(np.clip(x, 0, top), np.clip(y, 0, top), bins=[edges, edges])
    mi = mutual_information(joint)
    a = moving_to_fixed_ras(transform)
    c0 = centre_of_mass_ras(moving)
    c1 = (a @ np.append(c0, 1.0))[:3]
    shift = c1 - c0

    fig = plt.figure(figsize=COHIST_FIGSIZE, dpi=COHIST_DPI)
    gs = fig.add_gridspec(2, 3, width_ratios=[4, 1, 0.18], height_ratios=[1, 4],
                          wspace=0.06, hspace=0.06, left=0.11, right=0.92, top=0.95, bottom=0.31)
    ax = fig.add_subplot(gs[1, 0])
    ax_top = fig.add_subplot(gs[0, 0], sharex=ax)
    ax_right = fig.add_subplot(gs[1, 1], sharey=ax)
    cax = fig.add_subplot(gs[1, 2])
    im = ax.imshow(np.ma.log10(np.ma.masked_equal(joint.T, 0)), origin="lower", cmap="jet",
                   aspect="auto", extent=[0, top, 0, top], interpolation="nearest")
    ax.plot([0, top], [0, top], color="white", lw=0.8, ls="--", alpha=0.7)
    ax.set_xlabel("moving image BEFORE registration (intensity)")
    ax.set_ylabel("moving image AFTER registration (intensity)")
    fig.colorbar(im, cax=cax).set_label("log10 voxel count")
    centres = 0.5 * (edges[:-1] + edges[1:])
    ax_top.bar(centres, joint.sum(axis=1), width=edges[1] - edges[0], color="#4b5563")
    ax_right.barh(centres, joint.sum(axis=0), height=edges[1] - edges[0], color="#4b5563")
    ax_top.set_yscale("log")
    ax_right.set_xscale("log")
    for a_ in (ax_top, ax_right):
        a_.tick_params(labelbottom=False, labelleft=False, labelsize=7)
    ax_top.set_title("Displacement co-histogram of the moving image", fontsize=10)
    rows = "\n".join("  [" + "  ".join(f"{v:9.4f}" for v in r) + " ]" for r in a)
    fmt = lambda v: "(" + ", ".join(f"{u:7.1f}" for u in v) + ")"
    text = (f"Mutual information (before vs after): {mi:.3f} bits\n"
            f"Transform ({mode.split(' (')[0].lower()}; moving -> fixed, RAS mm, 4x4):\n{rows}\n"
            f"Image centre (centre of mass, RAS mm):\n"
            f"  before {fmt(c0)}\n  after  {fmt(c1)}\n"
            f"  shift  {fmt(shift)}   |shift| = {np.linalg.norm(shift):.1f} mm")
    fig.text(0.04, 0.015, text, family="monospace", fontsize=8, va="bottom")
    buf = io.BytesIO()
    fig.savefig(buf, format="png", dpi=COHIST_DPI)
    plt.close(fig)
    return buf.getvalue()


def build() -> gr.Blocks:
    with gr.Blocks(title="Registration service") as demo:
        gr.Markdown("Service for the Registration page; use the page.")
        fixed, moving, seg = gr.File(label="Fixed"), gr.File(label="Moving"), gr.File(label="Segmentation of M")
        mode = gr.Dropdown(list(MODES), value="Affine (12 DOF)", label="Method")
        match_spacing = gr.Checkbox(True, label="Match F's voxel resolution")
        match_size = gr.Checkbox(True, label="Match F's dimension")
        log, result, files = gr.Textbox(label="Log"), gr.JSON(label="Result"), gr.File(file_count="multiple")
        gr.Button("Run").click(register, [fixed, moving, seg, mode, match_spacing, match_size],
                               [log, result, files], api_name="register")
    return demo


if __name__ == "__main__":
    build().launch()
