# SynthStrip (vendored)

FreeSurfer's standalone SynthStrip (Hoopes et al., *NeuroImage* 206, 2022,
119474; https://synthstrip.io), **verbatim**, the same copy as APP_BRAINE's
`vendor/synthstrip/` (downloaded 2026-10-16, copied here 2026-10-27):

| File | Source | sha256 |
|---|---|---|
| `mri_synthstrip` | `raw.githubusercontent.com/freesurfer/freesurfer/dev/mri_synthstrip/mri_synthstrip` | `291c253a…7cc7871` |
| `models/synthstrip.1.pt.00.part`, `.01.part` | `surfer.nmr.mgh.harvard.edu/docs/synthstrip/` (the default model: CSF included in the border), split in two halves for GitHub's 25 MB limit | joined: `37417f80…5c653e33` |
| `cpu.requirements.txt` | `surfer.nmr.mgh.harvard.edu/docs/synthstrip/requirements/` | — |

The two `.part` files are rejoined into `models/synthstrip.1.pt` automatically
by `../app.py` on first use (or by hand: `cat models/synthstrip.1.pt.*.part > models/synthstrip.1.pt`).
The joined file is git-ignored.

Run as a subprocess under its own interpreter, never imported: it pins
torch 2.1.2 + surfa on Python 3.10. Build that env once:

    conda create -n synthstrip python=3.10
    conda run -n synthstrip pip install --extra-index-url https://download.pytorch.org/whl/cpu \
        -r tractography/py/synthstrip/cpu.requirements.txt

`../app.py` looks for `~/anaconda3/envs/synthstrip/bin/python`; set
`MRI_SYNTHSTRIP_PYTHON` to use another. Licence: FreeSurfer's
(https://surfer.nmr.mgh.harvard.edu/fswiki/FreeSurferSoftwareLicense).
