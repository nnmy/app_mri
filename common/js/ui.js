/* ============================================================================
 * common/js/ui.js — UI helpers every widget shares (window.Viz.ui)
 * ----------------------------------------------------------------------------
 *   sections()      a click on a section's label folds it away and back
 *   tooltips()      [data-tip="…"] shows its text in a tooltip on hover
 *   tip(e, text)    the same tooltip at a pointer event (a canvas' hover); null hides it
 *   dropZone()      a click-or-drop upload box; folders too (recursively)
 *   tabs()          a .tabs strip of buttons acting as one radio group
 *   status(), toast(), download(), busy()
 *   fmt             number / size formatting
 * Markup and look are in common/css/base.css.
 * ========================================================================== */
(function () {
  "use strict";
  const Viz = (window.Viz = window.Viz || {});

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // --- Sections -------------------------------------------------------------
  function sections(scope) {
    (scope || document).querySelectorAll(".sec > .sec-label").forEach((label) => {
      if (label._fold) return;
      label._fold = true;
      label.addEventListener("click", (e) => {
        if (e.target.closest("button, input, select, a, label:not(.sec-label)")) return;
        if (label.parentElement.classList.contains("locked")) return;     // a page keeps it shut for now
        label.parentElement.classList.toggle("collapsed");
      });
    });
  }

  // --- Tooltips -------------------------------------------------------------
  let tipEl = null;
  function tipElement() {
    if (!tipEl) {
      tipEl = document.createElement("div");
      tipEl.className = "tip hidden";
      document.body.appendChild(tipEl);
    }
    return tipEl;
  }
  function place(e) {
    const pad = 12, r = tipEl.getBoundingClientRect();
    let x = e.clientX + pad, y = e.clientY + pad;
    if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - pad;
    tipEl.style.left = Math.max(8, x) + "px";
    tipEl.style.top = Math.max(8, y) + "px";
  }
  function tip(e, text) {
    tipElement();
    if (!text) { tipEl.classList.add("hidden"); return; }
    tipEl.textContent = text;
    tipEl.classList.remove("hidden");
    place(e);
  }
  let tipsOn = false;
  function tooltips() {
    if (tipsOn) return;
    tipsOn = true;
    tipElement();
    document.addEventListener("mouseover", (e) => {
      const t = e.target.closest && e.target.closest("[data-tip]");
      if (!t) { if (!e.target.closest || !e.target.closest("[data-hover-tip]")) tipEl.classList.add("hidden"); return; }
      tipEl.textContent = t.dataset.tip;
      tipEl.classList.remove("hidden");
      place(e);
    });
    document.addEventListener("mousemove", (e) => {
      if (!tipEl.classList.contains("hidden")) place(e);
    });
  }

  // --- Files from a drop: folders are walked (a DICOM series is a folder) ----
  async function droppedFiles(dataTransfer) {
    const items = Array.from(dataTransfer.items || []);
    const entries = items.map((it) => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
    if (!entries.length) return Array.from(dataTransfer.files || []);
    const out = [];
    const readAll = (reader) => new Promise((resolve, reject) => {
      const all = [];
      const next = () => reader.readEntries((batch) => {
        if (!batch.length) resolve(all);
        else { all.push(...batch); next(); }      // readEntries returns ≤100 at a time
      }, reject);
      next();
    });
    async function walk(entry, path) {
      if (entry.isFile) {
        const file = await new Promise((res, rej) => entry.file(res, rej));
        try { Object.defineProperty(file, "relPath", { value: path + file.name }); } catch (e) { /* frozen */ }
        out.push(file);
      } else if (entry.isDirectory) {
        for (const child of await readAll(entry.createReader())) await walk(child, path + entry.name + "/");
      }
    }
    for (const entry of entries) await walk(entry, "");
    return out;
  }

  /**
   * A click-or-drop upload box.
   *   el        a .drop element; its markup is built here
   *   opts      { title, sub, accept, multiple, directory, required, tip,
   *               onFiles(files[]) , onClear() }
   * Returns { setInfo(text), clear() }.
   */
  function dropZone(el, opts) {
    el.classList.add("drop");
    el.innerHTML =
      `<span class="drop-title${opts.required ? " req" : ""}"${opts.tip ? ` data-tip="${esc(opts.tip)}"` : ""}>${esc(opts.title)}</span>` +
      `<span class="drop-sub">${esc(opts.sub || "Drop here or click")}</span>` +
      `<button type="button" class="drop-x" title="Clear" aria-label="Clear">×</button>` +
      `<input type="file"${opts.accept ? ` accept="${esc(opts.accept)}"` : ""}${opts.multiple ? " multiple" : ""}>` +
      (opts.directory ? `<input type="file" class="drop-dir" webkitdirectory multiple>` : "");
    el.tabIndex = 0;
    const sub = el.querySelector(".drop-sub");
    const input = el.querySelector('input[type="file"]:not(.drop-dir)');
    const dirInput = el.querySelector(".drop-dir");
    const defaultSub = sub.textContent;

    const take = (files) => {
      files = Array.from(files || []).filter((f) => f.size > 0);
      if (files.length) opts.onFiles(files);
    };
    el.addEventListener("click", (e) => {
      if (e.target.closest(".drop-x")) return;
      if (e.target.closest("a")) return;
      // Shift-click: pick a folder instead of files.
      (e.shiftKey && dirInput ? dirInput : input).click();
    });
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } });
    input.addEventListener("change", () => { take(input.files); input.value = ""; });
    if (dirInput) dirInput.addEventListener("change", () => { take(dirInput.files); dirInput.value = ""; });
    el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("over"); });
    el.addEventListener("dragleave", () => el.classList.remove("over"));
    el.addEventListener("drop", async (e) => {
      e.preventDefault();
      el.classList.remove("over");
      take(await droppedFiles(e.dataTransfer));
    });
    const api = {
      setInfo(text) { sub.textContent = text; el.classList.add("has"); },
      clear() { sub.textContent = defaultSub; el.classList.remove("has"); },
      pickFolder() { if (dirInput) dirInput.click(); },
    };
    el.querySelector(".drop-x").addEventListener("click", (e) => {
      e.stopPropagation();
      api.clear();
      if (opts.onClear) opts.onClear();
    });
    return api;
  }

  // --- Tabs -----------------------------------------------------------------
  /** el: a .tabs container; values: [{value, label}]; returns {get, set}. */
  function tabs(el, values, value, onChange) {
    el.classList.add("tabs");
    el.setAttribute("role", "tablist");
    el.innerHTML = values.map((v) =>
      `<button type="button" role="tab" data-value="${esc(v.value)}">${esc(v.label)}</button>`).join("");
    const set = (v, fire) => {
      value = v;
      el.querySelectorAll("button").forEach((b) => {
        const on = b.dataset.value === String(v);
        b.classList.toggle("on", on);
        b.setAttribute("aria-selected", on);
      });
      if (fire && onChange) onChange(v);
    };
    el.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-value]");
      if (b && b.dataset.value !== String(value)) set(b.dataset.value, true);
    });
    set(value, false);
    return { get: () => value, set: (v) => set(v, false) };
  }

  // --- Feedback -------------------------------------------------------------
  function status(el, text, kind) {
    el.className = "status" + (kind ? " " + kind : "");
    el.textContent = text || "";
  }

  let toastTimer = null;
  function toast(text, kind, ms) {
    let el = document.querySelector(".toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "toast";
      el.setAttribute("role", "status");
      document.body.appendChild(el);
    }
    el.className = "toast" + (kind ? " " + kind : "");
    el.textContent = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), ms || (kind === "err" ? 8000 : 3500));
  }

  /** Lets the browser paint (a status line, a spinner) before heavy work. */
  const busy = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

  function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  // --- Formatting -----------------------------------------------------------
  const fmt = {
    bytes(n) {
      if (n < 1024) return n + " B";
      const u = ["KB", "MB", "GB"];
      let i = -1;
      do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
      return n.toFixed(n < 10 ? 1 : 0) + " " + u[i];
    },
    int: (n) => Number(n).toLocaleString("en-US"),
    /** A value to `digits` significant decimals, without trailing zeros. */
    num(v, digits) {
      if (!Number.isFinite(v)) return "—";
      const d = digits == null ? 3 : digits;
      const a = Math.abs(v);
      if (a !== 0 && (a >= 1e6 || a < 1e-3)) return v.toExponential(2);
      return String(+v.toFixed(a >= 100 ? Math.min(d, 1) : d));
    },
    mm: (values) => values.map((v) => String(+v.toFixed(2))).join(" × ") + " mm",
  };

  Viz.ui = { esc, sections, tooltips, tip, dropZone, droppedFiles, tabs, status, toast, busy, download, fmt };

  document.addEventListener("DOMContentLoaded", () => { sections(); tooltips(); });
  if (document.readyState !== "loading") { sections(); tooltips(); }
})();
