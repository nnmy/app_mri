# dicom2nifti/py — the server converter (dcm2niix)

For DICOM the browser cannot decode (JPEG, JPEG 2000, RLE, vendor mosaics).
Mounted by `server.py` at `/py/dicom2nifti`.

| Endpoint | In | Out |
|---|---|---|
| `status` | — | `"dcm2niix v1…"`, or `"unavailable: …"` |
| `convert` | files: a `.zip` of the study and/or DICOM files | (log, series table, files) — streamed |

`convert` runs `dcm2niix -z y -b y -ba y -i y -f %s_%p`: gzipped NIfTI, a JSON
sidecar per series without the patient's name, birth date or IDs, derived /
localiser / 2-D images skipped. The table gives each series' file, voxels,
voxel size and sidecar; the page classifies them (T1 / T2) and lists them. The
files: a zip of everything, then each `.nii.gz` and `.json`. The uploaded DICOM
is deleted once converted.

dcm2niix: on PATH, else `~/bin/dcm2niix` (https://github.com/rordenlab/dcm2niix).
