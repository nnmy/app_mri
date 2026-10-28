/* ============================================================================
 * common/js/pdf.js — a canvas as a one-page PDF, or as PNG (window.Viz.pdf)
 * ----------------------------------------------------------------------------
 * The page holds the canvas as one lossless (Flate) RGB image -- written here
 * rather than with a PDF library, since a figure page is all the widgets
 * need. Page: "a4-landscape", "a4-portrait", or "fit" (the page is the
 * image, at 150 dpi).
 *
 *   const blob = await Viz.pdf.pdf(canvas, "a4-portrait", "Title");
 *   const blob = await Viz.pdf.png(canvas);
 * ========================================================================== */
(function () {
  "use strict";
  const Viz = (window.Viz = window.Viz || {});

  async function deflate(u8) {
    if (typeof CompressionStream === "undefined") return null;
    const s = new Blob([u8]).stream().pipeThrough(new CompressionStream("deflate"));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }

  const pdfText = (s) => String(s).replace(/[^\x20-\x7e]/g, "?").replace(/([()\\])/g, "\\$1");

  /**
   * One page holding the canvas. page: "a4-landscape" | "a4-portrait" |
   * "fit" (the page is the image, at 150 dpi). Returns a Blob.
   */
  async function pdf(canvas, page, title) {
    const w = canvas.width, h = canvas.height;
    const px = canvas.getContext("2d").getImageData(0, 0, w, h).data;
    const rgb = new Uint8Array(w * h * 3);
    for (let i = 0, j = 0; i < px.length; i += 4, j += 3) { rgb[j] = px[i]; rgb[j + 1] = px[i + 1]; rgb[j + 2] = px[i + 2]; }
    const packed = await deflate(rgb);
    const body = packed || rgb;

    let pw, ph;
    if (page === "a4-portrait") [pw, ph] = [595.28, 841.89];
    else if (page === "a4-landscape") [pw, ph] = [841.89, 595.28];
    else [pw, ph] = [(w * 72) / 150, (h * 72) / 150];
    const margin = page === "fit" ? 0 : 28;
    const s = Math.min((pw - 2 * margin) / w, (ph - 2 * margin) / h);
    const dw = w * s, dh = h * s, dx = (pw - dw) / 2, dy = (ph - dh) / 2;
    const content = `q ${dw.toFixed(3)} 0 0 ${dh.toFixed(3)} ${dx.toFixed(3)} ${dy.toFixed(3)} cm /Im0 Do Q`;

    const enc = new TextEncoder();
    const chunks = [];
    let size = 0;
    const offsets = [];
    const put = (x) => { const b = typeof x === "string" ? enc.encode(x) : x; chunks.push(b); size += b.length; };
    const obj = (n, head, stream) => {
      offsets[n] = size;
      put(`${n} 0 obj\n${head}\n`);
      if (stream) { put("stream\n"); put(stream); put("\nendstream\n"); }
      put("endobj\n");
    };
    put("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n");
    obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
    obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
    obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw.toFixed(2)} ${ph.toFixed(2)}] ` +
           "/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>");
    obj(4, `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB ` +
           `/BitsPerComponent 8${packed ? " /Filter /FlateDecode" : ""} /Length ${body.length} >>`, body);
    obj(5, `<< /Length ${content.length} >>`, enc.encode(content));
    obj(6, `<< /Title (${pdfText(title || "Mosaic")}) /Producer (MRI WLAB) >>`);
    const xref = size;
    put(`xref\n0 7\n0000000000 65535 f \n`);
    for (let n = 1; n <= 6; n++) put(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
    put(`trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    return new Blob(chunks, { type: "application/pdf" });
  }

  const png = (canvas) => new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The browser could not encode the PNG (too large?)."))), "image/png"));

  Viz.pdf = { pdf, png };
})();
