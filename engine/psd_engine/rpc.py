"""줄 단위 JSON-RPC 루프. 모든 예외는 traceback과 함께 반환(흡수 금지)."""
import atexit
import json
import shutil
import sys
import tempfile
import traceback
from pathlib import Path

from .export import export_psd as _export
from .matching import match_preset, preset_operations
from .ops import build_export_plan, finalize_names
from .render import render_preview, render_thumbnails
from .session import SessionStore
from .verify import verify_export


def _emit(obj, out):
    out.write(json.dumps(obj) + "\n")
    out.flush()


class Engine:
    _ALLOWED_METHODS = {
        "open_psd", "close_session", "render_thumbnails",
        "render_preview", "apply_preset", "export_psd", "batch_run",
    }

    def __init__(self, out=None):
        self.store = SessionStore()
        self.out = out or sys.stdout
        self.tmp = Path(tempfile.mkdtemp(prefix="psd_engine_"))
        # Most-recent render dir per kind ("thumbnails"/"preview") — a fresh
        # call deletes its predecessor rather than accumulating forever.
        # atexit alone isn't enough: kill_engine (src-tauri/src/engine.rs)
        # SIGKILLs the process on app exit, which skips atexit entirely, so a
        # 400ms-debounced preview session can otherwise leave hundreds of
        # PNGs behind in a single afternoon.
        self._last_render_dirs: dict[str, Path] = {}
        atexit.register(shutil.rmtree, self.tmp, ignore_errors=True)

    def _fresh_render_dir(self, kind):
        prev = self._last_render_dirs.get(kind)
        if prev is not None:
            shutil.rmtree(prev, ignore_errors=True)
        out_dir = Path(tempfile.mkdtemp(dir=self.tmp))
        self._last_render_dirs[kind] = out_dir
        return out_dir

    # ---- RPC methods ----
    def open_psd(self, path):
        sid = self.store.open(path)
        s = self.store.get(sid)
        psd = s["psd"]
        return {
            "sessionId": sid, "width": psd.width, "height": psd.height,
            "colorMode": psd.color_mode.name, "depth": psd.depth, "tree": s["tree"],
        }

    def close_session(self, sessionId):
        self.store.close(sessionId)
        return {}

    def render_thumbnails(self, sessionId, layerIds, maxSize=128):
        s = self.store.get(sessionId)
        out_dir = self._fresh_render_dir("thumbnails")
        return {"thumbs": render_thumbnails(s, layerIds, maxSize, out_dir)}

    def render_preview(self, sessionId, visibleLayerIds, maxSize=1500):
        s = self.store.get(sessionId)
        out_dir = self._fresh_render_dir("preview")
        return {"pngPath": render_preview(s, visibleLayerIds, maxSize, out_dir)}

    def apply_preset(self, sessionId, preset):
        s = self.store.get(sessionId)
        matched = match_preset(s["tree"], preset)
        return {
            "matchedLayerIds": matched,
            "operations": preset_operations(s["tree"], matched, preset),
        }

    def batch_run(self, paths, preset, outputDir=None, overwrite=False):
        from .batch import run_batch

        def progress(path, stage, current, total):
            _emit({"event": "progress", "path": path, "stage": stage,
                   "current": current, "total": total}, self.out)

        return run_batch(paths, preset, output_dir=outputDir,
                         overwrite=overwrite, progress=progress)

    def export_psd(self, sessionId, includedIds, operations, naming, outputPath,
                   embedPreview=True, overwrite=False, verify=True):
        s = self.store.get(sessionId)
        included = sorted(includedIds)
        for lid in included:
            node = s["nodes_by_id"][lid]
            if node["kind"] != "pixel":
                raise ValueError(
                    f"includedIds contains non-pixel layer {node['name']!r} "
                    f"(kind={node['kind']})"
                )
        entries = finalize_names(
            build_export_plan(included, operations), s["nodes_by_id"], naming
        )

        def progress(stage, current, total):
            _emit({"event": "progress", "stage": stage,
                   "current": current, "total": total}, self.out)

        result = _export(s, entries, outputPath, embed_preview=embedPreview,
                         overwrite=overwrite, progress=progress)
        if verify:
            result["verification"] = verify_export(s, entries, outputPath)
        return result

    # ---- dispatch ----
    def handle(self, request):
        method_name = request.get("method", "")
        if method_name not in self._ALLOWED_METHODS:
            raise ValueError(f"unknown method: {method_name!r}")
        method = getattr(self, method_name)
        return method(**request.get("params", {}))


def main(stdin=None, stdout=None):
    from .patches import apply_pytoshop_patches
    apply_pytoshop_patches()
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    engine = Engine(out=stdout)
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except Exception as e:  # noqa: BLE001 — traceback 그대로 노출이 정책
            _emit({"id": None,
                   "error": {"message": str(e),
                             "traceback": traceback.format_exc()}}, stdout)
            continue
        if not isinstance(request, dict):
            _emit({"id": None,
                   "error": {"message": f"request must be a JSON object, got {type(request).__name__}",
                             "traceback": ""}}, stdout)
            continue
        try:
            _emit({"id": request.get("id"), "result": engine.handle(request)}, stdout)
        except Exception as e:  # noqa: BLE001 — traceback 그대로 노출이 정책
            _emit({"id": request.get("id"),
                   "error": {"message": str(e),
                             "traceback": traceback.format_exc()}}, stdout)
