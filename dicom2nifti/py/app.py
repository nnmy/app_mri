# ============================================================================
# dicom2nifti/py/app.py — DICOM study -> NIfTI with dcm2niix (the page's
# server converter)
# ----------------------------------------------------------------------------
# The page converts uncompressed DICOM itself; this service is for the rest
# (JPEG, JPEG 2000, RLE, vendor mosaics...), which dcm2niix reads. Mounted by
# server.py at /py/dicom2nifti; `python app.py` runs it alone for a check.
#
#   status()    dcm2niix's version, or why it is not available
#   convert()   uploads (a .zip of the study and/or DICOM files) -> one
#               .nii.gz + anonymised .json sidecar per series, a zip of them
#               all, and a table (file, voxels, voxel size, sidecar) the
#               page classifies (T1 / T2) and lists. The uploaded DICOM --
#               the patient's identity is in its headers -- is deleted once
#               converted, from the run folder and from Gradio's upload cache.
# ============================================================================
import json
import shutil
import subprocess
import tempfile
import time
import zipfile
from pathlib import Path

import gradio as gr
import nibabel as nib

# dcm2niix: the one on PATH, else ~/bin/dcm2niix.
DCM2NIIX = Path(shutil.which("dcm2niix") or (Path.home() / "bin" / "dcm2niix"))
# -z y gzip · -b y sidecar · -ba y no name/birth date/IDs in it · -i y skip
# derived, localiser and 2-D images · -f series number + protocol name.
DCM2NIIX_ARGS = ["-z", "y", "-b", "y", "-ba", "y", "-i", "y", "-f", "%s_%p"]
DCM2NIIX_TIMEOUT_S = 15 * 60
MAX_ZIP_MEMBERS = 50_000
# Run folders live here and are removed after this long.
RUNS = Path(tempfile.gettempdir()) / "mri_wlab" / "dicom2nifti"
KEEP_RUNS_S = 2 * 3600


def status() -> str:
    if not DCM2NIIX.is_file():
        return f"unavailable: dcm2niix not found ({DCM2NIIX})"
    try:
        out = subprocess.run([str(DCM2NIIX), "-v"], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired) as exc:
        return f"unavailable: dcm2niix did not run ({exc})"
    version = next((l.strip() for l in (out.stdout + out.stderr).splitlines()
                    if l.strip().startswith("v1")), "?")
    return f"dcm2niix {version}"


def _new_run() -> Path:
    RUNS.mkdir(parents=True, exist_ok=True)
    for old in RUNS.iterdir():
        if time.time() - old.stat().st_mtime > KEEP_RUNS_S:
            shutil.rmtree(old, ignore_errors=True)
    return Path(tempfile.mkdtemp(prefix=time.strftime("%Y%m%d-%H%M%S_"), dir=RUNS))


def _gather(paths, dst: Path) -> int:
    """Zips extracted (members kept inside dst), other files copied."""
    dst.mkdir(parents=True, exist_ok=True)
    root, n = dst.resolve(), 0
    for k, src in enumerate(paths):
        if zipfile.is_zipfile(src):
            with zipfile.ZipFile(src) as zf:
                members = [m for m in zf.infolist() if not m.is_dir()]
                if len(members) > MAX_ZIP_MEMBERS:
                    raise gr.Error(f"{src.name}: {len(members)} files, more than {MAX_ZIP_MEMBERS}.")
                for m in members:
                    target = (root / f"zip{k}" / m.filename).resolve()
                    if root not in target.parents:
                        raise gr.Error(f"{src.name}: member {m.filename!r} would land outside the folder.")
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with zf.open(m) as fi, open(target, "wb") as fo:
                        shutil.copyfileobj(fi, fo)
                    n += 1
        else:
            shutil.copyfile(src, root / f"file{k:05d}_{src.name}")
            n += 1
    return n


def convert(files):
    """Yields (log, table, files) as it goes; the last yield is the result."""
    log = []

    def say(line):
        log.append(line)
        return "\n".join(log)

    paths = [Path(f if isinstance(f, str) else f.name) for f in (files or [])]
    if not paths:
        raise gr.Error("No DICOM uploaded.")
    state = status()
    if state.startswith("unavailable"):
        raise gr.Error(state)
    run = _new_run()
    dicom, out = run / "dicom", run / "nifti"
    out.mkdir()
    try:
        n = _gather(paths, dicom)
        yield say(f"{n} file(s) received; {state} converting…"), None, None
        proc = subprocess.run([str(DCM2NIIX), *DCM2NIIX_ARGS, "-o", str(out), str(dicom)],
                              capture_output=True, text=True, errors="replace",
                              timeout=DCM2NIIX_TIMEOUT_S)
    finally:
        # The DICOM headers identify the patient: keep only NIfTI + sidecars.
        shutil.rmtree(dicom, ignore_errors=True)
        for p in paths:
            p.unlink(missing_ok=True)
    text = (proc.stdout or "") + (proc.stderr or "")
    for line in text.splitlines():
        if line.startswith(("Found", "Convert", "Warning", "Error")):
            say("dcm2niix | " + line.replace(str(out) + "/", ""))
    rows, outputs = [], []
    for nii in sorted(out.glob("*.nii.gz")):
        side = nii.with_name(nii.name[:-7] + ".json")
        img = nib.load(str(nii))
        rows.append({
            "file": nii.name,
            "json": side.name if side.is_file() else None,
            "shape": [int(v) for v in img.shape],
            "zooms": [round(float(v), 4) for v in img.header.get_zooms()[:3]],
            "sidecar": json.loads(side.read_text()) if side.is_file() else {},
        })
        outputs += [nii] + ([side] if side.is_file() else [])
    if not rows:
        raise gr.Error(f"dcm2niix found no convertible series (exit {proc.returncode}).")
    bundle = run / "dicom2nifti_output.zip"
    with zipfile.ZipFile(bundle, "w", zipfile.ZIP_STORED) as zf:
        for p in outputs:
            zf.write(p, p.name)
    say(f"Converted {len(rows)} series.")
    yield "\n".join(log), rows, [str(bundle)] + [str(p) for p in outputs]


def build() -> gr.Blocks:
    with gr.Blocks(title="DICOM → NIfTI service") as demo:
        gr.Markdown("Service for the DICOM → NIfTI page; use the page.")
        files = gr.File(file_count="multiple", label="DICOM / zip")
        log, table = gr.Textbox(label="Log"), gr.JSON(label="Series")
        outputs = gr.File(file_count="multiple", label="Outputs")
        state = gr.Textbox(label="Status")
        gr.Button("Status").click(status, None, state, api_name="status")
        gr.Button("Convert").click(convert, files, [log, table, outputs], api_name="convert")
    return demo


if __name__ == "__main__":
    build().launch()
