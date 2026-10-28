# tractography/py — DIPY whole-brain tractography

Mounted by `server.py` at `/py/tractography`.

| Endpoint | In | Out |
|---|---|---|
| `track` | DWI volumes (several 3D, or one 4D), .bval + .bvec, FA threshold, seeds per voxel, step (mm), minimum length (mm), formats (`vtk`, `ply`), brain mask (`synthstrip`, the default / `b6`), SynthStrip border (mm), simplified copy (true) | (log, result, files) — the log streamed while it runs |
| `options` | — | `{synthstrip: {available, message, border_mm, border_range_mm}}` |

The lab's method (PROJ_DCONDNET `b6_dti_wholebrain_tractography.py`, with
`core/med/lib_dwi.py` and `lib_tract.py`): a median-Otsu brain mask on the
b0, dilated by 5 % of the smallest dimension; a WLS DTI fit in it, FA ≥ the
threshold as the tracking mask; CSA-ODF peaks (SH order 6, repulsion724,
relative threshold 0.5, ≥ 45° apart); deterministic local tracking, binary
stopping at the mask edge; streamlines under the minimum length dropped.
Defaults: FA 0.2, 1 seed per voxel, 0.875 mm, 80 mm (b6: 20 mm; no
streamline is healed); the brain mask is
SynthStrip's (below), b6's the lab's original.

**Brain mask `synthstrip`**: SynthStrip (vendored verbatim in `synthstrip/`,
see its `VERSION.md`) on the b0, run under its own interpreter
(`~/anaconda3/envs/synthstrip/bin/python`, or `MRI_SYNTHSTRIP_PYTHON`); the
mask is its distance map below the border (1 mm, its own default; negative
moves inwards). b6's 3-voxel dilation reaches skull and scalp, where noise
fits a high FA: on IXI034, 31 % of the FA ≥ 0.2 voxels lay on non-brain
tissue (by its segmentation), 9 % with SynthStrip. Streamlines, b6 →
SynthStrip: IXI034 88,196 → 68,936; IXI051 130,540 → 108,909; IXI518
76,017 → 69,033. The static server does not serve `py/` folders.

3D volumes are stacked in file-name order (natural: `-DTI-2` before
`-DTI-10`). Volumes beyond the b-values are left out (IXI's `DTI-16`, a QC
image), as the lab's `b3_nii_preprocessing.py` does.

Result: counts (seeds, tracked, kept, points), lengths, the grid, mask
sizes, settings and times. Files: `<subject>_wb_tracts.vtk` (binary legacy,
LPS, tagged `SPACE=LPS`) and/or `<subject>_wb_tracts.ply` (binary, vertices
+ edges, RAS, `comment SPACE=RAS`), the simplified copy, and
`<subject>_brainmask.nii.gz`; for the page's viewer only, `preview.vtk`
(every k-th streamline, at most 20,000) and `preview_fa.nii.gz`. `<subject>` is the DWI file names' part
before `-DTI` / `_dwi` (`IXI051-HH-1328-DTI-00_norm` → `IXI051-HH-1328`).

On IXI051 (128 × 128 × 64, 1.75 × 1.75 × 2 mm, 1 b0 + 15 at b = 1000):
202,017 seeds → 130,540 streamlines in 82 s (DTI 6 s, peaks 51 s, tracking
24 s).

**Simplified copy** (`tract_simplify.py`; `<stem>_wb_tracts_simplified.vtk` /
`.ply`): a lighter tractogram for viewing and figures, made with fixed
settings so subjects are simplified alike: streamlines under 80 mm dropped,
30 % of the rest kept, a uniform random sample (seed 0; not Tract View's
per-cluster share, which keeps at least one per cluster and so depends on
the subject), a point every 2 mm at most; no healing, no smoothing. The counts come back in the result (`simplified`). For
files already saved:

    python tract_simplify.py <subject>_wb_tracts.vtk ... [-o DIR]

With the defaults (80 mm): IXI051 24,715 streamlines (59 MB) → 7,415 kept
(7.8 MB); IXI518 12,773 (30 MB) → 3,832 (4.0 MB).
