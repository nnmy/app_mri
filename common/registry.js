/* ============================================================================
 * common/registry.js — every group and widget of the site
 * ----------------------------------------------------------------------------
 * The home page's tiles and the navbar's menu are both drawn from this one
 * list, so registering a widget is one entry here (README, section 3.2).
 * A classic script, not JSON: a page opened from file:// cannot fetch().
 * ========================================================================== */
(function () {
  "use strict";
  const Viz = (window.Viz = window.Viz || {});

  Viz.registry = {
    // Display order on the home page, left to right.
    groups: [
      { id: "viewing", title: "Viewing" },
      { id: "processing", title: "Processing" },
      { id: "dmri", title: "dMRI" },
      { id: "resources", title: "Resources" },
    ],

    // server: true when the widget cannot work without its py/ service
    // (server.py); a widget whose service is optional says false.
    // Within a group, widgets show in this order -- except that those with
    // server: true always come last (inGroup() below), so they are listed
    // last here too.
    widgets: [
      {
        id: "vol_view",
        group: "viewing",
        title: "Volume Slices",
        description: "View a DICOM series / NIfTI volume / segmentation and its metadata.",
        href: "vol_view/index.html",
        icon: "vol_view/asset/icon.svg",
        color: "#3e5c76",
        size: "wide",
        server: false,
      },
      {
        id: "vol_3d",
        group: "viewing",
        title: "Volume 3D",
        description: "Render a volume in 3D, with its segmentation or VTK surfaces.",
        href: "vol_3d/index.html",
        icon: "vol_3d/asset/icon.svg",
        color: "#4b5a82",
        size: "wide",
        server: false,
      },
      {
        id: "dicom2nifti",
        group: "processing",
        title: "DICOM → NIfTI",
        description: "Convert a DICOM study to one NIfTI per series.",
        href: "dicom2nifti/index.html",
        icon: "dicom2nifti/asset/icon.svg",
        color: "#4a6b5d",
        size: "medium",
        server: false,
      },
      {
        id: "resample",
        group: "processing",
        title: "Resampling",
        description: "Resample volumes to an isotropic voxel size.",
        href: "resample/index.html",
        icon: "resample/asset/icon.svg",
        color: "#3f6a6e",
        size: "medium",
        server: false,
      },
      {
        id: "registration",
        group: "processing",
        title: "Registration",
        description: "Register a moving image onto a fixed one (rigid or affine).",
        href: "registration/index.html",
        icon: "registration/asset/icon.svg",
        color: "#5e6b4a",
        size: "medium",
        server: true,
      },
      {
        id: "tract_view",
        group: "dmri",
        title: "Tract View",
        description: "View whole-brain tracts within chosen segments, by direction.",
        href: "tract_view/index.html",
        icon: "tract_view/asset/icon.svg",
        color: "#7d4e57",
        size: "wide",
        server: false,
      },
      {
        id: "dwi_4d",
        group: "dmri",
        title: "DWI 3D ⇄ 4D",
        description: "Merge or split DWI volumes, and pick the gradients to keep.",
        href: "dwi_4d/index.html",
        icon: "dwi_4d/asset/icon.svg",
        color: "#8a6d3f",
        size: "medium",
        server: false,
      },
      {
        id: "tractography",
        group: "dmri",
        title: "Tractography",
        description: "Track whole-brain streamlines from a DWI series.",
        href: "tractography/index.html",
        icon: "tractography/asset/icon.svg",
        color: "#5e5486",
        size: "medium",
        server: true,
      },
      {
        id: "sample_data",
        group: "resources",
        title: "Sample Data",
        description: "Files of one subject to try the widgets with.",
        href: "sample_data/index.html",
        icon: "sample_data/asset/icon.svg",
        color: "#5c5868",
        size: "medium",
        server: false,
      },
      {
        id: "demo_brain_aging",
        group: "resources",
        title: "Brain Aging Demo",
        description: "Tracts of a younger and an older subject, by tissue and direction (Nguyen et al. 2026).",
        href: "demo_brain_aging/index.html",
        icon: "demo_brain_aging/asset/icon.svg",
        color: "#6b5a7a",
        size: "medium",
        server: false,
      },
    ],
    /** True on a static host (GitHub Pages), where server.py cannot run, so
     *  widgets with server: true are left out of the home page and the menu.
     *  Locally, on a LAN or from file://, they show. */
    staticHost: /\.github\.io$/i.test(location.hostname),

    /** A group's widgets in display order: the browser-only ones first,
     *  then those that need server.py (each part in registry order). */
    inGroup(groupId) {
      const ws = this.widgets.filter((w) => w.group === groupId && !(w.server && this.staticHost));
      return [...ws.filter((w) => !w.server), ...ws.filter((w) => w.server)];
    },
  };
})();
