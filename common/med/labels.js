/* ============================================================================
 * common/med/labels.js — segment names and colours
 * ----------------------------------------------------------------------------
 * A label's name and colour come from, in order: a label table the user
 * adds (CSV, ITK-SNAP, FreeSurfer / 3D Slicer colour table), the
 * segmentation's own header (Slicer's .seg.nrrd), else "Label <id>" and a
 * fixed palette -- the same id always gets the same colour, so two files
 * labelled alike look alike.
 * ========================================================================== */
(function () {
  "use strict";
  const Med = (window.Med = window.Med || {});

  // 20 distinct colours (Trubetskoy), then golden-angle hues.
  const PALETTE = [
    [230, 25, 75], [60, 180, 75], [255, 225, 25], [0, 130, 200], [245, 130, 48],
    [145, 30, 180], [70, 240, 240], [240, 50, 230], [210, 245, 60], [250, 190, 212],
    [0, 128, 128], [220, 190, 255], [170, 110, 40], [255, 250, 200], [128, 0, 0],
    [170, 255, 195], [128, 128, 0], [255, 215, 180], [0, 0, 128], [128, 128, 128],
  ];
  function hsl(h, s, l) {
    const f = (n) => {
      const k = (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return [f(0), f(8), f(4)];
  }
  const defaultColor = (id) => (id >= 1 && id <= PALETTE.length ? PALETTE[id - 1]
                                                                : hsl((id * 137.508) % 360, 0.7, 0.55));

  const MAX_ID = 1 << 20;

  /**
   * The label table of a segmentation: one row per id present, with its
   * name, colour, voxel count and volume (mL). `table`: a Map from a
   * user's label file, overriding the header's.
   */
  function segments(seg, stats, table) {
    return stats.ids.map((id) => {
      const fromTable = table && table.get(id);
      const fromHeader = seg.labelInfo && seg.labelInfo.get(id);
      const name = (fromTable && fromTable.name) || (fromHeader && fromHeader.name) || `Label ${id}`;
      const color = (fromTable && fromTable.color) || (fromHeader && fromHeader.color) || defaultColor(id);
      const voxels = stats.count.get(id);
      return { id, name, color, voxels, ml: voxels * seg.voxelMl };
    });
  }

  /** id -> rgb and visibility, as flat arrays for drawing a slice fast. */
  function lookup(segs, visible) {
    const max = segs.reduce((m, s) => Math.max(m, s.id), 0);
    if (max >= MAX_ID) throw new Error(`Label ids up to ${MAX_ID - 1} are supported; this file has ${max}.`);
    const rgb = new Uint8Array((max + 1) * 3), on = new Uint8Array(max + 1);
    for (const s of segs) {
      rgb.set(s.color, s.id * 3);
      on[s.id] = visible.has(s.id) ? 1 : 0;
    }
    return { max, rgb, on };
  }

  /**
   * A label table file -> Map(id -> {name, color|null}). Accepts
   *   CSV / TSV         id,name[,r,g,b]   (a header row is skipped)
   *   ITK-SNAP          IDX R G B A VIS MSH "LABEL"
   *   FreeSurfer LUT /
   *   3D Slicer .ctbl   id name r g b a
   * Colours 0–255, or 0–1 when all three are ≤ 1.
   */
  function parseTable(text) {
    const out = new Map();
    for (let line of text.split(/\r?\n/)) {
      line = line.trim();
      if (!line || line[0] === "#") continue;
      let name = null, tokens;
      const quoted = line.match(/"([^"]*)"/);
      if (quoted) {
        name = quoted[1];
        tokens = line.replace(quoted[0], " ").trim().split(/[\s,;]+/);
      } else {
        tokens = line.split(line.includes(",") ? /\s*,\s*/ : line.includes("\t") ? /\t+/ : /\s+/);
      }
      const id = Number(tokens[0]);
      if (!Number.isInteger(id) || id < 0) continue;          // header row
      let rgb = null;
      if (quoted) {
        rgb = tokens.slice(1, 4).map(Number);
      } else {
        const rest = tokens.slice(1);
        const firstText = rest.findIndex((t) => t !== "" && !Number.isFinite(Number(t)));
        if (firstText < 0) continue;
        name = rest[firstText];
        rgb = rest.slice(firstText + 1, firstText + 4).map(Number);
      }
      let color = null;
      if (rgb.length === 3 && rgb.every(Number.isFinite)) {
        const unit = rgb.every((c) => c <= 1) && rgb.some((c) => c % 1 !== 0);
        color = rgb.map((c) => Math.max(0, Math.min(255, Math.round(unit ? c * 255 : c))));
      }
      out.set(id, { name: name || `Label ${id}`, color });
    }
    if (!out.size) throw new Error("No label rows found (expected e.g. “1,Liver,255,0,0”).");
    return out;
  }

  const css = (rgb) => `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;

  Med.labels = { PALETTE, defaultColor, segments, lookup, parseTable, css };
})();
