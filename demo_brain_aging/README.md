# Brain Aging Demo (`demo_brain_aging/`)

A page showing the two "typical subjects" of

> M.N. Nguyen, Y. Kubota, A. Hirata, *Age-related changes in brain fiber pathways based on
> directional decomposition of DTI tractograms*, Neuroscience Informatics 6 (2026) 100255,
> doi:10.1016/j.neuri.2025.100255 (their Fig. 6)

— **IXI051** (25 y, female) and **IXI518** (75 y, female) — side by side: tract density per tissue
(their Fig. 3), the direction composition per tissue (their Fig. 4), the tracts in 3D and on the
slices.

## The page

- **Segments** (left): the paper's four tissues only (cerebral WM, cerebellum, thalamus, brainstem =
  midbrain + pons + medulla, each part listed under it), all ticked, with each subject's tract
  density (tracts/cm³; volume and count on hover). Tracts clipped to the ticked segments (pieces ≥ 20 mm), passing through them,
  or the whole head. **Simplification** and **Method** are folded; simplification starts at keep
  20 %, ≥ 100 mm (viewing only: the numbers use every streamline).
- **Viewer** (right), six tabs, each with only its own controls:
  - *Tracts (3D)*, the first tab: two views that turn, pan and zoom together, labelled Younger /
    Older (× or *More* hides the labels); over each a direction bar (shares on hover, a click
    filters, a second click clears).
  - *Axial / Sagittal / Coronal*: T1 / T2; tracts off, projected (all of them, flattened) or
    intersection (only where they cross the slice); segments off, as a boundary (1–3 px) or filled,
    drawn over the tracts; hover shows the image value, the segment and the tracts there.
  - *Density* and *Directions*: the paper's Figs. 3 and 4 for the ticked segments, drawn from
    `measures.csv` (values on hover; subjects in grays, directions L-R / A-P / S-I in red / green /
    blue, Mixed gray).
- At first only the 3D tab's files are fetched (tracts, native segmentations, heads); the T1, T2 and
  display segmentations when a slice tab is first opened.
- **💾 Save** adds the tab to the saved figures (under the viewer) → **Export** as PDF (one figure
  per page, the paper cited under the last) or PNG.
- On a touch screen, floating ↑ / ↓ buttons scroll the page while the viewer is near.

## The data (`data/`, built by `prep/build_data.py`)

```
~/anaconda3/bin/python demo_brain_aging/prep/build_data.py
```

| file | what it is |
|---|---|
| `manifest.json` | subjects (age, sex), the files, the 4×4 native → common matrix, the tracking settings and counts, the method and the differences from the paper |
| `measures.csv` | per subject and segment: volume (cm³), tract count, the count per direction class (every streamline, native space) |
| `labels.csv` | the tissue names (161718 = Brainstem, the group 16 + 17 + 18) |
| `<id>/tracts.dba.gz` | the tracts in the subject's native space, a point every 1 mm at most, in 1/32 mm (`lib/data.js` decodes it) |
| `<id>/seg_native.nii.gz` | the segmentation on the subject's b0 grid (the paper's, SyN from IXI034) |
| `<id>/seg.nii.gz`, `t1.nii.gz`, `t2.nii.gz` | display volumes: one 1 mm grid over IXI051's b0 field of view |
| `<id>/head.vtk` | the head surface (common space) |
| `qc/*.png` | the registrations: IXI518's b0 on IXI051's (affine), each T2 on its b0 (rigid) |

Sources: the DWIs (`norm-dwi`) and segmentations (`seg/*_voxelized_b0match.nii.gz`) in
`/home/my/nas/FROM DESKTOP/TAM/young-old-tract-data/`; T1, T2, b-values and the demographics in
`/home/my/Documents/archived (non-active proj)/BRAIN PROJECTS (IXI)/data/`. The script reuses
`tractography/py/app.py` (DWI and gradient readers, SynthStrip) and `registration/py/app.py` (its
registration method) without changing them; the tracking settings are its own (the Tractography
tool keeps its own). The slow step (tracking) is cached in the system's temp folder.

## Method, and differences from the paper

Tracking, per subject in native space: SynthStrip brain mask on the b0; DTI (WLS), FA ≥ 0.2
tracking mask; CSA-ODF (SH order 6); deterministic tracking (DIPY LocalTracking, maximum turn 30°,
step 0.5 mm); one random seed per voxel of the tracking mask; streamlines ≥ 20 mm.

Measures, in native space from those streamlines: per segment, the pieces of streamline inside it
(consecutive points whose nearest voxel is in it, ≥ 20 mm); density = pieces per cm³; each piece's
direction class by its mean unit step, τ = 0.7 (the paper's eq. 2–4, also Tract View's rule).

Display only: IXI518's b0 registered onto IXI051's (rigid, then affine; Mattes mutual information),
each subject's T2 onto its b0 and T1 onto its T2 (rigid). IXI518's tracts are moved by the affine
for drawing (exact for a polyline); their lengths and directions are measured where they were
tracked.

Differences from the paper:

- The paper tracked each ROI separately (seeds in the ROI, tracking confined to it); here the whole
  brain is tracked once and the tracts are cropped to the ROI(s).
- Brain mask: SynthStrip here, Otsu on the b0 in the paper.
- Seeds: one random seed per voxel of the whole tracking mask here; random seeds in the ROI voxels
  in the paper.
- Two subjects only: no group-level tractograms and no age correlations (the paper: 200 subjects).
- The page draws the tracts resampled to a point every 1 mm; the measures use the 0.5 mm
  streamlines.

The densities are therefore higher than the paper's means (a streamline crossing an ROI counts as a
piece there), but their order is the paper's: brainstem and thalamus highest, then cerebral WM,
cerebellum lowest.

## Shared code it uses

`common/js/report.js` (multi-page PDF, PNG zip) and `common/js/savelist.js` (the saved figures),
generalised from APP_BRAINE's TMS viewer; `common/js/chart.js` (bar charts on a canvas with hover
values, page and PDF alike); `common/js/scrollpad.js` (the touch-screen scroll buttons); `common/med/linked.js` (3D cameras that follow each other); `common/med/dirbar.js`
(the direction bar); `common/med/tract_select.js` and `tract_simplify.js` (Tract View's selection
and simplification, shared copies).
