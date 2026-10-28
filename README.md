# APP_MRI — MRI WLAB

A website of small tools — **widgets** — for medical images: viewing DICOM
series, NIfTI and NRRD volumes, segmentations, surfaces and tractograms, and
processing them (conversion, registration, resampling, DWI series).

**How to deploy and use it, with every widget described: [`doc/guide.html`](doc/guide.html)**
(open it in a browser). This README is for developers.

Most widgets run **client-side** (HTML, CSS, JavaScript): the files the user
opens are read in the browser and never uploaded. Python (Gradio) is used
only for jobs JavaScript cannot do well; those run in one local server,
`server.py` (see [Python services](#5-python-services)).

---

## 1. Quick start

```bash
cd APP_MRI
python server.py                   # the site and every Python service
# open http://127.0.0.1:8001/
```

`server.py` needs a Python with each service's `py/requirements.txt`
installed (gradio, SimpleITK, nibabel, numpy, matplotlib, dipy; dcm2niix on PATH or
in `~/bin` for the server DICOM converter). Tractography's optional SynthStrip
brain mask runs under its own conda env, `synthstrip` (Python 3.10; see
[`tractography/py/synthstrip/VERSION.md`](tractography/py/synthstrip/VERSION.md)).
The client-side widgets need no
server at all: any static file server works, and so does opening
`index.html` straight from the disk (`file://`) — all scripts are classic
`<script>` files with no `fetch()` of local files.

---

## 2. Folder layout

```
APP_MRI/
├── README.md                 this file
├── index.html                home page: the widget tiles (Metro style)
├── server.py                 serves the site + mounts every <widget>/py/app.py
├── common/                   code shared by the pages
│   ├── registry.js           THE list of groups and widgets (home page + navbar)
│   ├── css/
│   │   ├── base.css          colour tokens (light/dark), type, navbar, footer,
│   │   │                     sections, buttons, form controls, drop zones
│   │   ├── metro.css         the home page's tile grid
│   │   └── med.css           imaging pages: slice panels, the 3D stage, segment
│   │                         and series tables, file lists, console, forms
│   ├── js/
│   │   ├── chrome.js         injects the navbar and footer
│   │   ├── ui.js             general UI helpers (window.Viz.ui)
│   │   ├── home.js           draws the tiles from registry.js
│   │   ├── zip.js            write a .zip of outputs, read a .zip input (Viz.zip)
│   │   ├── pdf.js            a canvas as a one-page PDF, or PNG (Viz.pdf)
│   │   └── pyclient.js       call a widget's Python service (Viz.py)
│   ├── med/                  the imaging library (window.Med)
│   │   ├── volume.js         a volume in world space; grids, slices, statistics
│   │   ├── io.js             gzip, typed arrays, which reader a file goes to
│   │   ├── io_nifti.js       NIfTI-1/2 reader and NIfTI-1 writer
│   │   ├── io_nrrd.js        NRRD reader (3D Slicer .seg.nrrd segment names)
│   │   ├── io_dicom.js       DICOM series -> volume, anonymised sidecar
│   │   ├── labels.js         segment names and colours, label tables
│   │   ├── render.js         slices -> RGBA (colour maps, label fill/outline)
│   │   ├── viewer.js         hover panels: linked crosshair, values, lock
│   │   ├── sliceview.js      plane tabs + slice slider + panels, ready-made
│   │   ├── gl3d.js           WebGL2 3D: ray-cast volume, slices, meshes, lines
│   │   ├── surface.js        a label map's segments as smooth surfaces
│   │   ├── io_vtk.js         legacy VTK: surfaces and polylines in, polylines out
│   │   └── tracts.js         streamlines for the 3D view: direction colours, line segments, a lighter copy to draw
│   ├── vendor/               third-party code, pinned, with licences
│   └── img/                  site-wide images (favicon)
│
└── <widget_id>/              one folder per widget (snake_case)
    ├── index.html            the widget's entry page (required)
    ├── <sub_page>.html       further pages, when the widget has sub-widgets
    ├── lib/                  the widget's own JavaScript and CSS
    ├── py/                   (optional) its Python/Gradio service
    └── asset/                icon, sample images, lookup tables, ...
```

### Widgets in this repository

| Group | Widget | Folder | Runs |
|---|---|---|---|
| Viewing | **Volume Slices** — a DICOM series / NIfTI volume / segmentation and its metadata, slice by slice; mosaic export (PNG, PDF) | [`vol_view/`](vol_view/) | browser |
| Viewing | **Volume 3D** — a volume rendered in 3D (volume, MIP, isosurface) with its segmentation as surfaces and VTK meshes | [`vol_3d/`](vol_3d/) | browser |
| Processing | **DICOM → NIfTI** — one NIfTI + anonymised sidecar per series, T1/T2 recognised | [`dicom2nifti/`](dicom2nifti/) | browser; dcm2niix on the server for compressed DICOM |
| Processing | **Resampling** — to an isotropic voxel size, same field of view | [`resample/`](resample/) | browser |
| Processing | **Registration** — rigid or affine, mutual information (SimpleITK) | [`registration/`](registration/) | server |
| dMRI | **Tract View** — a whole-brain tractogram (VTK, PLY, TRK, TCK) within the ticked segments (clipped or passing through; with tissue names, those outside the brain are left out and white matter, brainstem, cerebellum and ids over 14 ticked), by direction (L-R, A-P, S-I, Mixed: tabs as wide as their share); simplification (thin to 50 % of each bundle, smooth, heal when ticked; automatic above 30,000 streamlines or 3 M points, with a notice); 3D view inside the head surface (VTK / PLY) with line thickness and opacities, projections on three planes; save as VTK / TRK; view + info as PDF | [`tract_view/`](tract_view/) | browser |
| dMRI | **DWI 3D ⇄ 4D** — 3D DWI volumes into one 4D NIfTI or back, with .bval / .bvec; drop b0s (keep one, or average) and gradients (by hand, by shell, or the n best-spread); 3D file names from a pattern; the gradients on a sphere, or a volume's slices | [`dwi_4d/`](dwi_4d/) | browser |
| dMRI | **Tractography** — whole-brain streamlines from a DWI series (3D volumes in file-name order, or one 4D) + .bval/.bvec, by the lab's method (PROJ_DCONDNET b6: Otsu brain mask, or SynthStrip skull stripping on the b0; WLS DTI, FA ≥ 0.2 tracking mask, CSA-ODF peaks, deterministic tracking, ≥ 80 mm, no healing); volumes beyond the b-values left out; VTK (LPS) / PLY (RAS) with direction colours, a simplified copy alike for every subject (≥ 80 mm, 30 % at random, 2 mm steps), brain mask; preview in 3D and FA + mask slices | [`tractography/`](tractography/) | server (DIPY) |
| Resources | **Sample Data** — one IXI subject (IXI034) to try the widgets with: T1, T2, DWI + .bval/.bvec, segmentations and tissue names, head surface, whole-brain tracts; one by one or zipped in its study folders | [`sample_data/`](sample_data/) | browser (the zip needs http) |
| Resources | **Brain Aging Demo** — the two typical subjects of Nguyen, Kubota & Hirata (Neuroscience Informatics 2026): IXI051 (25 y) and IXI518 (75 y) side by side; tract density and direction composition per tissue (the paper's four ROIs first), slices with T1/T2 and the tract projection or density, linked 3D views, saved figures to PDF / PNG; its data built by `prep/build_data.py` (see its README) | [`demo_brain_aging/`](demo_brain_aging/) | browser (needs http) |

---

## 3. Rules

### 3.1 The home page

* `index.html` shows every widget as a **tile** in the Windows 8 "Metro"
  layout: a white tile with an outline, title and icon in the widget's
  `color` (as APP_BRAINE's home page, Tiles mode; a faint tint of that colour
  under the pointer). A wide tile shows its icon on the left and its title +
  one-sentence description on the right; a tile without a description shows
  its icon above its title; both centred in the tile. Draw a new widget's `asset/icon.svg` with its
  lines in that same `color` (not white).
* Tiles are **grouped by function** (now: Viewing, Processing, dMRI, Resources). A group is a
  column of tiles with a heading. Groups flow left to right on a wide screen
  and stack on a narrow one.
* **Within a group, widgets that need the server come last** (after every
  browser-only widget), on the home page and in the navbar menu alike.
  `Viz.registry.inGroup()` enforces it from the `server` flag; list them last
  in `registry.js` too, so the file reads in display order.
* The home page holds no widget-specific code. It draws the tiles from
  `common/registry.js`.

### 3.2 Registering a widget

Add one entry to `common/registry.js`. Nothing else has to change for the
widget to appear on the home page and in the navbar.

```js
{
  id: "vol_view",                   // = folder name
  group: "viewing",                 // a group id from Viz.registry.groups
  title: "Volume Slices",           // the only text on the tile
  description: "…",                 // ONE short sentence: tooltip and wide-tile text
  href: "vol_view/index.html",      // relative to APP_MRI/
  icon: "vol_view/asset/icon.svg",
  color: "#2d89ef",                 // the tile colour
  size: "wide",                     // small | medium | wide | large
  server: false,                    // true when the widget cannot work without server.py
  pages: [                          // optional: the widget's sub-widgets
    { title: "…", href: "vol_view/other.html" }
  ]
}
```

* The description is **one short sentence**; no keyword line under the title.
* Tile sizes are in grid cells: `small` 1×1, `medium` 2×2, `wide` 4×2,
  `large` 4×4.
* `server: true` puts a "needs server.py" badge on the tile and moves it to
  the end of its group ([3.1](#31-the-home-page)). A widget whose service is
  optional (DICOM → NIfTI) says `false`.

### 3.3 The common folder

Use `common/` for anything more than one widget needs: the page frame
(navbar, footer), colour tokens, form controls, section boxes, drop zones,
download and zip helpers, the Python client — and the imaging library in
`common/med/`. A widget must never copy that code into its own folder. If two
widgets need the same thing, move it into `common/`.

Every page loads the common files and marks its root:

```html
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Volume Slices</title>
  <link rel="icon" href="../common/img/favicon.svg">
  <link rel="stylesheet" href="../common/css/base.css">
  <link rel="stylesheet" href="../common/css/med.css">   <!-- imaging pages -->
</head>
<body data-root=".." data-widget="vol_view">
  <main class="page"> … </main>
  <script src="../common/registry.js"></script>
  <script src="../common/js/chrome.js"></script>
  <script src="../common/js/ui.js"></script>
  <script src="../common/med/volume.js"></script>        <!-- what the page needs -->
  <script src="lib/app.js"></script>
</body>
</html>
```

* `data-root` is the relative path from the page to `APP_MRI/`. `chrome.js`
  builds the navbar links from it, and `pyclient.js` the service URLs, so a
  page works at any folder depth.
* `data-widget` is the page's registry id: the navbar highlights it, and it
  names the page's service (`/py/<id>`).
* `chrome.js` inserts the navbar at the top of `<body>` and the footer
  ("Hirata Laboratory. NITech JP.") at the bottom. A page never writes its
  own.

### 3.4 A widget's folder

| Item | Required | Content |
|---|---|---|
| `index.html` | yes | the entry page; for a widget with sub-widgets, it may be a menu of them |
| other `*.html` | no | sub-widget pages, side by side with `index.html` |
| `lib/` | yes | the widget's own scripts and stylesheet |
| `py/` | no | its Python service ([section 5](#5-python-services)) |
| `asset/` | yes | at least `icon.svg` (the tile icon); also sample data, colour tables, documentation images |

### 3.5 Page layout

Every widget page follows the same order, so the user always knows where to
look:

1. **Title and a one-line intro** (the registry description), small and grey
   (`.page-head`).
2. **Sections**, each in a box with a bold label (`<section class="sec">`).
   * `Input` is outlined in the accent colour: the uploads and the run action.
   * `Viewer` is outlined in the text colour: the main display.
   * Other sections (Output, Console, Metadata, Export, …) have a thin grey
     outline. Secondary ones (Metadata, Export, Console when idle) start
     folded (`class="sec collapsed"`).
   * Clicking a section's label folds it away and back.
3. Input (and outputs) on the left, the viewer on the right on a wide screen;
   stacked on a narrow one.

* A control's longer explanation goes in a tooltip (`data-tip="…"`) on its
  label, not in a paragraph under it. No hint paragraphs on the page.
* **Every page works on a computer and on a smartphone.** Nothing may be
  wider than the screen: no fixed widths beyond ~320 px, grids that wrap or
  stack (the two columns stack below 960 px; the home page's groups wrap and
  never scroll sideways), sizes from the container (`%`, `fr`, `cqi`), not
  from `100vw`. Text fields are 16 px on a phone (smaller ones make iOS
  Safari zoom the page in), buttons finger-sized, drop zones also clickable,
  and canvases take touch: one finger to drag or rotate, two to pinch-zoom
  and pan. Check a new page at 360 px and 768 px wide.
* Slices are shown **neurological** (the subject's left on the screen's left).
* Every output is offered as a download link; several outputs also as one
  `.zip`.

### 3.6 Code style

* Plain JavaScript (ES2020), no build step, no framework. Each file is a
  classic script wrapped in an IIFE that adds to one namespace:
  `window.Viz` for common UI code, `window.Med` for the imaging library
  (`common/med/`), and one short namespace per widget (`VV` Volume Slices, `V3`
  Volume 3D, `D2N` DICOM → NIfTI, `RS` Resampling, `TV` Tract View, `DW`
  DWI 3D ⇄ 4D, `SD` Sample Data, `DBA` Brain Aging Demo).
* Each file starts with a header comment saying what it is for. Comments
  explain *why*, not *what*.
* Third-party libraries are vendored into `common/vendor/` at a pinned
  version, with the licence file next to them (`VERSION.md` lists them). Do
  not load scripts from a CDN at run time: the site must work offline.
* Colours come from the CSS variables in `common/css/base.css`
  (`--bg`, `--fg`, `--accent`, …), so light and dark themes both work (the
  theme follows the system's preference).
* Use browser storage (`localStorage`) only for small conveniences, and wrap
  every access in `try/catch`.
* World space is **RAS millimetres**. Every reader turns its file into a
  `Med.Volume` (voxels + affine to RAS); volumes and meshes meet in world
  space through their own headers, never by voxel index.

---

## 4. Adding a widget, step by step

1. Create the folder `APP_MRI/<widget_id>/` with `index.html`, `lib/` and
   `asset/icon.svg` (a white, single-colour icon on a transparent background).
2. Copy the page skeleton from [3.3](#33-the-common-folder) and set
   `data-widget`.
3. Add the entry to `common/registry.js`, in an existing group or a new one.
4. Put any code another widget could use into `common/` rather than `lib/`.
5. If it needs Python, add `py/app.py` ([section 5](#5-python-services)).
6. Add a row to the widget table in [section 2](#2-folder-layout).

---

## 5. Python services

Some jobs are not for the browser: registration (SimpleITK's optimisers), a
decoder with no JavaScript port (compressed DICOM -> dcm2niix), a model that
needs PyTorch, a file too big for browser memory. A widget that needs one
keeps it in its own `py/` folder:

```
<widget_id>/py/
├── app.py              build() -> a gr.Blocks; its events have api_name=…
├── requirements.txt    its Python dependencies
└── README.md           what it computes, its endpoints
```

Rules:

* **The page comes first.** The HTML page is the widget; the service only
  computes and returns files and numbers; the page shows them (its own slice
  views, tables, downloads).
* **One server for all widgets**: start `python server.py` once; it serves
  the site at `/` and mounts every `<widget>/py/app.py` at `/py/<widget>`, on
  one port. A widget never gets a server, port or launch command of its own:
  adding `py/app.py` (with `build()`) is all it takes to join. Pages and services
  share one origin, so a page calls its service with relative URLs and no
  CORS. A service whose imports fail is skipped; the others still start.
* Pages call services with `Viz.py.service("<widget>")` (`common/js/pyclient.js`,
  Gradio's REST API: upload, call, server-sent progress, files). A
  generator's yields reach the page as they happen — use them to stream a
  log to the page's Console.
* The page must say clearly how to start `server.py` when the service is not
  reachable (opened from `file://`, or the server is down), and disable the
  action — never a blank page or a silent failure.
* Inputs the service received are deleted once used; run folders live in the
  system temp folder (`mri_wlab/<widget>/`) and are removed after two hours.
* No usage reports: `server.py` turns Gradio's analytics off.
* `python <widget>/py/app.py` runs one service alone (its own minimal Gradio
  page) for a check.

---

## 6. Browser support

Use current Chrome, Edge, Firefox or Safari (16.4 or later). Widgets rely on
`DecompressionStream` / `CompressionStream` (gzip, zip), `canvas.toBlob`,
CSS container queries, and — for Volume 3D — WebGL2 with hardware graphics.
