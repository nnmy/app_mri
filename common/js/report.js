/* ============================================================================
 * common/js/report.js — saved figures as one PDF, or as PNG (window.Viz.report)
 * ----------------------------------------------------------------------------
 * A figure is { title, caption: [lines], canvas }. Export:
 *
 *   const blob = await Viz.report.pdf(figures, {
 *     header: "APP_MRI - Brain Aging Demo",   // on every page, top left
 *     right: "IXI051 · IXI518",               // top right (optional)
 *     infoTitle: "Data and settings",
 *     meta: "exported 2026-10-28 14:02",      // under the info title
 *     info: [{ title, rows: [[key, value], …] }, …],
 *     infoPage: false,                         // no settings page (optional)
 *     cite: "Author, Title, Journal (2026)",   // a reference under the last figure (optional)
 *   });
 *   const { blob, name } = await Viz.report.png(figures, "stem");
 *
 *   PDF  a settings page first (the info sections and the list of figures,
 *        flowing onto more pages if needed; unless infoPage is false), then
 *        one page per figure, landscape for a wide one; the reference (cite)
 *        at the foot of the last; footed "Page i of N".
 *   PNG  one figure: its .png; several: a .zip of them, numbered in the
 *        order saved (common/js/zip.js).
 *
 * The PDF is written here (no library): text in the standard Helvetica
 * fonts (WinAnsi: ×, µ, °, ², ³, · and the dashes survive; other symbols are
 * spelled out), images as JPEG (DCTDecode) straight from the canvas.
 * Generalised from APP_BRAINE's TMS viewer (tms_view/lib/report.js).
 * ========================================================================== */
(function () {
  "use strict";
  const Viz = (window.Viz = window.Viz || {});

  const A4 = [595.28, 841.89];
  const M = 42;                                     // page margin, pt
  const JPEG_QUALITY = 0.93;

  // --- Text -----------------------------------------------------------------------
  const WIN = { "–": 0x96, "—": 0x97, "…": 0x85, "•": 0x95, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "€": 0x80, "™": 0x99 };
  const SPELL = { "→": "->", "←": "<-", "≤": "<=", "≥": ">=", "σ": "sigma", "τ": "tau", "μ": "µ", "≈": "~", "⌖": "", "💾": "" };
  function win(s) {
    let out = "";
    for (const ch of String(s)) {
      const c = SPELL[ch] != null ? SPELL[ch] : ch;
      for (const x of c) {
        const code = x.codePointAt(0);
        if (WIN[x]) out += String.fromCharCode(WIN[x]);
        else if (code < 0x80 || (code >= 0xa0 && code <= 0xff)) out += x;
        else out += "?";
      }
    }
    return out.replace(/([()\\])/g, "\\$1");
  }
  const measurer = document.createElement("canvas").getContext("2d");
  function width(s, size, bold) {
    measurer.font = `${bold ? "bold " : ""}${size}px Helvetica, Arial, sans-serif`;
    return measurer.measureText(String(s)).width;
  }
  function wrap(s, size, maxW, bold) {
    const words = String(s).split(/\s+/), lines = [];
    let line = "";
    for (const w of words) {
      const t = line ? line + " " + w : w;
      if (width(t, size, bold) > maxW && line) { lines.push(line); line = w; } else line = t;
    }
    if (line) lines.push(line);
    return lines.length ? lines : [""];
  }

  // --- Pages ------------------------------------------------------------------------
  /** A page under construction: text and images in PDF operators. */
  function newPage(landscape) {
    const [w, h] = landscape ? [A4[1], A4[0]] : A4;
    const ops = [], images = [];
    return {
      w, h, ops, images,
      text(x, y, s, size, bold, gray) {
        ops.push(`BT /${bold ? "F2" : "F1"} ${size} Tf ${gray != null ? gray + " g " : "0 g "}${x.toFixed(2)} ${y.toFixed(2)} Td (${win(s)}) Tj ET`);
      },
      line(x0, y0, x1, y1, gray) { ops.push(`${gray} G 0.6 w ${x0} ${y0} m ${x1} ${y1} l S`); },
      image(img, x, y, dw, dh) {
        const name = "Im" + images.length;
        images.push({ name, img });
        ops.push(`q ${dw.toFixed(2)} 0 0 ${dh.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /${name} Do Q`);
      },
    };
  }
  function frame(p, i, n, header, right) {
    p.text(M, p.h - 28, header, 10, true, 0.15);
    if (right) p.text(p.w - M - width(right, 8.5), p.h - 28, right, 8.5, false, 0.35);
    p.line(M, p.h - 36, p.w - M, p.h - 36, 0.7);
    const foot = `Page ${i} of ${n}`;
    p.text((p.w - width(foot, 9)) / 2, 22, foot, 9, false, 0.3);
  }

  async function jpeg(canvas) {
    const blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("The browser could not encode the image."))), "image/jpeg", JPEG_QUALITY));
    return { bytes: new Uint8Array(await blob.arrayBuffer()), w: canvas.width, h: canvas.height };
  }

  /** The settings page(s): sections of key / value rows, then the figure list. */
  function infoPages(o, figures) {
    const pages = [];
    let p = newPage(false), y = p.h - 70;
    pages.push(p);
    const need = (dy) => { if (y - dy < 50) { p = newPage(false); pages.push(p); y = p.h - 64; } };
    p.text(M, y, o.infoTitle || "Data and settings", 16, true); y -= 20;
    if (o.meta) {
      for (const l of wrap(o.meta, 9.5, p.w - 2 * M)) { p.text(M, y, l, 9.5, false, 0.35); y -= 12.5; }
      y -= 9.5;
    }
    const keyW = o.keyWidth || 150, valX = M + keyW + 8, valW = p.w - M - valX;
    for (const sec of o.info || []) {
      if (!sec.rows || !sec.rows.length) continue;
      need(34);
      p.text(M, y, sec.title, 11.5, true); y -= 5;
      p.line(M, y, p.w - M, y, 0.85); y -= 13;
      for (const [k, v] of sec.rows) {
        const full = !k;                               // a row without a key: text across the page
        const lines = wrap(v, 9.5, full ? p.w - 2 * M : valW);
        need(lines.length * 12.5 + 2);
        if (!full) p.text(M + (k.startsWith("  ") ? 10 : 0), y, k.trim(), 9.5, false, 0.3);
        lines.forEach((l, i) => p.text(full ? M : valX, y - i * 12.5, l, 9.5));
        y -= lines.length * 12.5 + 2.5;
      }
      y -= 10;
    }
    need(30);
    p.text(M, y, "Saved figures", 11.5, true); y -= 5;
    p.line(M, y, p.w - M, y, 0.85); y -= 13;
    figures.forEach((v, i) => {
      need(13);
      p.text(M, y, `${i + 1}.`, 9.5, false, 0.3);
      p.text(M + 18, y, wrap(v.title, 9.5, p.w - 2 * M - 60)[0], 9.5);
      y -= 12.5;
    });
    return pages;
  }

  async function pdf(figures, o) {
    o = o || {};
    const header = o.header || "APP_MRI";
    const pages = o.infoPage === false ? [] : infoPages(o, figures);
    for (const [i, v] of figures.entries()) {
      const img = await jpeg(v.canvas);
      const p = newPage(img.w / img.h > 1.15);
      let y = p.h - 62;
      p.text(M, y, v.title, 12.5, true); y -= 15;
      for (const c of v.caption || []) for (const l of wrap(c, 9, p.w - 2 * M)) { p.text(M, y, l, 9, false, 0.3); y -= 11.5; }
      let bottom = 40;
      if (o.cite && i === figures.length - 1) {
        // The reference at the foot of the last page; the figure above it.
        const lines = wrap(o.cite, 9, p.w - 2 * M - 62);
        p.line(M, bottom + 14 + lines.length * 11.5, p.w - M, bottom + 14 + lines.length * 11.5, 0.85);
        p.text(M, bottom + 2 + (lines.length - 1) * 11.5, "Reference", 9, true, 0.3);
        lines.forEach((l, k) => p.text(M + 62, bottom + 2 + (lines.length - 1 - k) * 11.5, l, 9, false, 0.2));
        bottom += 26 + lines.length * 11.5;
      }
      const top = y - 6, availW = p.w - 2 * M, availH = top - bottom;
      const s = Math.min(availW / img.w, availH / img.h);
      const dw = img.w * s, dh = img.h * s;
      p.image(img, (p.w - dw) / 2, top - dh, dw, dh);
      pages.push(p);
    }
    pages.forEach((p, i) => frame(p, i + 1, pages.length, header, o.right));

    // --- Serialise ---------------------------------------------------------------
    const enc = (s) => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 0xff; return u; };
    const chunks = [], offsets = [];
    let size = 0;
    const put = (x) => { const b = typeof x === "string" ? enc(x) : x; chunks.push(b); size += b.length; };
    let next = 5;                                   // 1 catalog, 2 pages, 3-4 fonts
    const plan = pages.map((p) => ({ page: next++, content: next++, images: p.images.map(() => next++) }));
    const obj = (n, head, stream) => {
      offsets[n] = size;
      put(`${n} 0 obj\n${head}\n`);
      if (stream) { put("stream\n"); put(stream); put("\nendstream\n"); }
      put("endobj\n");
    };
    put("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
    obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    obj(2, `<< /Type /Pages /Kids [${plan.map((q) => q.page + " 0 R").join(" ")}] /Count ${pages.length} >>`);
    obj(3, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    obj(4, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    pages.forEach((p, i) => {
      const q = plan[i];
      const xo = p.images.map((im, k) => `/${im.name} ${q.images[k]} 0 R`).join(" ");
      obj(q.page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${p.w.toFixed(2)} ${p.h.toFixed(2)}] ` +
                  `/Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xo ? ` /XObject << ${xo} >>` : ""} >> /Contents ${q.content} 0 R >>`);
      const content = enc(p.ops.join("\n"));
      obj(q.content, `<< /Length ${content.length} >>`, content);
      p.images.forEach((im, k) => obj(q.images[k],
        `<< /Type /XObject /Subtype /Image /Width ${im.img.w} /Height ${im.img.h} /ColorSpace /DeviceRGB ` +
        `/BitsPerComponent 8 /Filter /DCTDecode /Length ${im.img.bytes.length} >>`, im.img.bytes));
    });
    const infoObj = next;
    obj(infoObj, `<< /Title (${win(o.title || header)}) /Producer (APP_MRI) >>`);
    const xref = size;
    put(`xref\n0 ${infoObj + 1}\n0000000000 65535 f \n`);
    for (let n = 1; n <= infoObj; n++) put(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
    put(`trailer\n<< /Size ${infoObj + 1} /Root 1 0 R /Info ${infoObj} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(chunks, { type: "application/pdf" });
  }

  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);

  /** PNG: one file, or a .zip of several. Returns { blob, name }. */
  async function png(figures, stem) {
    const files = [];
    for (let i = 0; i < figures.length; i++) {
      const b = await Viz.pdf.png(figures[i].canvas);
      files.push({ name: `${stem}_${String(i + 1).padStart(2, "0")}_${slug(figures[i].title)}.png`, data: new Uint8Array(await b.arrayBuffer()) });
    }
    if (files.length === 1) return { blob: new Blob([files[0].data], { type: "image/png" }), name: files[0].name };
    return { blob: Viz.zip(files), name: `${stem}_figures.zip` };
  }

  Viz.report = { pdf, png };
})();
