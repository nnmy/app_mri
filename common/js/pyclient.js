/* ============================================================================
 * common/js/pyclient.js — calling a widget's Python service (window.Viz.py)
 * ----------------------------------------------------------------------------
 * server.py mounts each widget's py/app.py (a Gradio app) at /py/<widget id>,
 * on the same origin as the pages, so a page reaches it with relative URLs
 * and no CORS. Gradio's REST protocol:
 *   POST <base>/gradio_api/upload            multipart "files" -> [server paths]
 *   POST <base>/gradio_api/call/<api_name>   {data:[...]} -> {event_id}
 *   GET  <base>/gradio_api/call/<api_name>/<event_id>
 *        server-sent events: "generating" (a generator's yields), then
 *        "complete" or "error"
 *   GET  <base>/gradio_api/file=<path>       an output file
 *
 * Usage:
 *   const svc = Viz.py.service("registration");
 *   if (!(await svc.available())) …           // show how to start server.py
 *   const out = await svc.call("register", [await svc.upload(file), "Affine"],
 *                              (partial) => console.log(partial));
 *   const blob = await svc.fetchFile(out[2][0]);
 * ========================================================================== */
(function () {
  "use strict";
  const Viz = (window.Viz = window.Viz || {});

  const START_HINT = "Start the server (python server.py in the site folder) and open the page " +
                     "from it, e.g. http://127.0.0.1:7860/";

  function service(widgetId) {
    const root = (document.body.dataset.root || ".").replace(/\/+$/, "");
    const base = `${root}/py/${widgetId}`;

    /** True when the service answers (and the page is served over http). */
    async function available() {
      if (location.protocol === "file:") return false;
      try {
        const r = await fetch(`${base}/gradio_api/info`, { cache: "no-store" });
        return r.ok;
      } catch (e) { return false; }
    }

    /** A File/Blob -> the FileData object a Gradio File input takes. */
    async function upload(file, name) {
      const form = new FormData();
      form.append("files", file, name || file.name || "upload");
      const r = await fetch(`${base}/gradio_api/upload`, { method: "POST", body: form });
      if (!r.ok) throw new Error(`Upload failed (${r.status}).`);
      const [path] = await r.json();
      return { path, orig_name: name || file.name, meta: { _type: "gradio.FileData" } };
    }

    /** Several files, one request. */
    async function uploadMany(files) {
      const form = new FormData();
      files.forEach((f) => form.append("files", f, f.relPath || f.name));
      const r = await fetch(`${base}/gradio_api/upload`, { method: "POST", body: form });
      if (!r.ok) throw new Error(`Upload failed (${r.status}).`);
      const paths = await r.json();
      return paths.map((path, i) => ({ path, orig_name: files[i].name, meta: { _type: "gradio.FileData" } }));
    }

    /**
     * Run `api` with `data`; onPartial(values) for each value a generator
     * yields. Resolves with the final output values.
     */
    async function call(api, data, onPartial) {
      const r = await fetch(`${base}/gradio_api/call/${api}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data }),
      });
      if (!r.ok) throw new Error(`The service refused the call (${r.status}).`);
      const { event_id: id } = await r.json();
      const stream = await fetch(`${base}/gradio_api/call/${api}/${id}`);
      if (!stream.ok || !stream.body) throw new Error(`No answer from the service (${stream.status}).`);
      const reader = stream.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "", last = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (value) buffer += value;
        // Events are separated by a blank line: "event: x\ndata: {...}".
        let cut;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const ev = (block.match(/^event: (.*)$/m) || [])[1];
          const raw = (block.match(/^data: (.*)$/m) || [])[1];
          let payload = null;
          try { payload = raw ? JSON.parse(raw) : null; } catch (e) { payload = raw; }
          if (ev === "generating") { last = payload; if (onPartial) onPartial(payload); }
          else if (ev === "complete") return payload || last;
          else if (ev === "error") {
            const msg = payload && (payload.message || payload.error || (typeof payload === "string" ? payload : null));
            throw new Error(msg || "The service failed (see the server's console).");
          }
        }
        if (done) break;
      }
      if (last) return last;
      throw new Error("The service closed the connection without a result.");
    }

    const fileUrl = (fd) => `${base}/gradio_api/file=${encodeURI(fd.path)}`;
    async function fetchFile(fd) {
      const r = await fetch(fileUrl(fd));
      if (!r.ok) throw new Error(`Could not fetch ${fd.orig_name || fd.path} (${r.status}).`);
      return new File([await r.blob()], fd.orig_name || fd.path.split("/").pop());
    }

    return { base, available, upload, uploadMany, call, fileUrl, fetchFile };
  }

  Viz.py = { service, START_HINT };
})();
