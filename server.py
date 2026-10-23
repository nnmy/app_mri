#!/usr/bin/env python3
# ============================================================================
# server.py — the site and every widget's Python service, on one port
# ----------------------------------------------------------------------------
#     python server.py                       # http://127.0.0.1:7860/
#     python server.py --host 0.0.0.0 --port 7860
#
# Serves the static site (index.html, common/, every widget folder) at /, and
# mounts each widget's Gradio service -- <widget>/py/app.py, its build()
# returning a gr.Blocks -- at /py/<widget>. Pages and services share one
# origin, so a page calls its service with relative URLs
# (common/js/pyclient.js) and the browser needs no CORS.
#
# The client-side widgets do not need this server; any static file server,
# or opening index.html from the disk, works for them.
#
# INTERPRETER: a Python with every widget's py/requirements.txt installed
# (gradio, SimpleITK, nibabel, numpy, matplotlib). A widget whose imports
# fail is skipped with a warning; the rest still start.
# ============================================================================
import argparse
import importlib.util
import logging
import os
import sys
from pathlib import Path

# No usage reports to Gradio's servers: this server handles medical images.
os.environ.setdefault("GRADIO_ANALYTICS_ENABLED", "False")

import gradio as gr
import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent
logger = logging.getLogger("server")


class SiteFiles(StaticFiles):
    """The site's files, minus the Python sources (services run, not read)."""

    async def get_response(self, path, scope):
        if path.endswith((".py", ".pyc")) or "/__pycache__/" in f"/{path}":
            raise HTTPException(status_code=404)
        return await super().get_response(path, scope)


def load_service(app_py: Path):
    """<widget>/py/app.py as a module (its folder first on sys.path, so it
    can import its own helpers)."""
    folder = str(app_py.parent)
    if folder not in sys.path:
        sys.path.insert(0, folder)
    spec = importlib.util.spec_from_file_location(f"svc_{app_py.parent.parent.name}", app_py)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build_app() -> FastAPI:
    app = FastAPI(title="MRI WLAB")
    for app_py in sorted(ROOT.glob("*/py/app.py")):
        widget = app_py.parent.parent.name
        try:
            blocks = load_service(app_py).build()
        except Exception:                      # noqa: BLE001 - one bad service must not stop the rest
            logger.exception("Skipping %s: its service did not load", widget)
            continue
        app = gr.mount_gradio_app(app, blocks, path=f"/py/{widget}")
        logger.info("Service /py/%s", widget)
    app.mount("/", SiteFiles(directory=str(ROOT), html=True), name="site")
    return app


def main() -> None:
    parser = argparse.ArgumentParser(description="MRI WLAB: the site and its Python services")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8001)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s: %(message)s")
    app = build_app()
    logger.info("Open http://%s:%d/", "127.0.0.1" if args.host == "0.0.0.0" else args.host, args.port)
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
