/* ============================================================================
 * sample_data/lib/manifest.js — the sample subject's files (window.SD)
 * ----------------------------------------------------------------------------
 * One IXI subject (IXI034, from the public IXI dataset), laid out as its
 * study folder is: ana/ (anatomy), dwi_processed/ (DWI, one 3D volume per
 * gradient, with FSL b-values and vectors), seg/ (segmentations and the head
 * surface), tract/ (the whole-brain tractogram). The DWI, the DWI-space
 * segmentation and the tracts share one scanner space, and the T1 / T2
 * overlay them through their headers.
 *
 * Files live in asset/IXI034/<folder>/<name>; sizes in bytes. `short`: the
 * name as listed when the full one only repeats its neighbours'; `layout`
 * "grid": the files in two columns, name and size only.
 * ========================================================================== */
(function () {
  "use strict";
  const SD = (window.SD = window.SD || {});
  const DWI_SIZES = [2456713, 2352702, 2353458, 2351855, 2352202, 2354134, 2354011, 2350829, 2354341, 2352620,
                     2353000, 2352992, 2353758, 2354761, 2352725, 2354210];

  SD.subject = "IXI034";
  SD.groups = [
    { title: "Anatomy", folder: "ana", files: [
      { name: "IXI034_t1.nii.gz", size: 7346408, what: "T1, 0.94 × 0.94 × 1.2 mm" },
      { name: "IXI034_t2.nii.gz", size: 5999951, what: "T2, 0.94 × 0.94 × 1.2 mm" },
    ] },
    { title: "Diffusion", folder: "dwi_processed", collapsed: true, layout: "grid",
      note: "1 b0 + 15 at b = 1000 · 112 × 112 × 64, 2 mm", files: [
      ...DWI_SIZES.map((size, i) => {
        const n = String(i).padStart(2, "0");
        return { name: `IXI034-HH-1260-DTI-${n}_processed.nii.gz`, short: `IXI034-...-DTI-${n}_....nii.gz`, size,
                 what: i === 0 ? "b0" : "" };
      }),
      { name: "IXI034_bval", size: 76, what: "b-values" },
      { name: "IXI034_bvec", size: 259, what: "directions" },
    ] },
    { title: "Segmentation", folder: "seg", files: [
      { name: "IXI034_seg_match_dwi.nii.gz", size: 64886, what: "14 tissues, DWI grid (2 mm)" },
      { name: "IXI034_voxseg.nii.gz", size: 3530840, what: "14 tissues, head model (0.5 mm)" },
      { name: "IXI034_labels.csv", size: 203, what: "tissue names" },
      { name: "IXI034_head.vtk", size: 439178, what: "head surface" },
    ] },
    { title: "Tractography", folder: "tract", files: [
      { name: "IXI034_wb_tracts.vtk", size: 12953609, what: "whole-brain tracts (VTK, LPS)" },
    ] },
  ];
  for (const g of SD.groups) for (const f of g.files) f.path = `${g.folder}/${f.name}`;
  SD.files = SD.groups.flatMap((g) => g.files);
})();
