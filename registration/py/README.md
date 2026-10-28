# registration/py — SimpleITK registration

Mounted by `server.py` at `/py/registration`.

| Endpoint | In | Out |
|---|---|---|
| `register` | fixed, moving, segmentation of moving (optional), method, match F's voxel size, match F's dimension | (log, result, files) — the log streamed while it runs |

Mattes mutual information, regular-step gradient descent, coarse to fine
(shrink 4-2-1, smoothing 2-1-0 mm), from the image centres aligned; "Affine"
runs a rigid stage first. The moving image is resampled linearly (float32),
the segmentation nearest-neighbour (type kept), on the fixed grid or — per
the two boxes — the fixed orientation at the moving image's voxel size and/or
a size holding the whole registered moving image.

Result: the method, the metric before and after, the 4×4 moving → fixed
transform in RAS mm, the output grid. Files: `<moving>_reg.nii.gz`,
`<seg>_reg.nii.gz`, `<moving>_cohistogram.png` (moving image before vs after,
voxel by voxel on the fixed grid), `transform.json`.
