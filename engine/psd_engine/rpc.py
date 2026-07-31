"""줄 단위 JSON-RPC 루프. 모든 예외는 traceback과 함께 반환(흡수 금지)."""
import atexit
import json
import shutil
import sys
import tempfile
import traceback
from collections import deque
from pathlib import Path

from .export import export_psd as _export
from .matching import auto_merge_operations, match_preset, preset_operations
from .ops import build_export_plan, finalize_names
from .render import render_document_preview, render_preview, render_thumbnails
from .session import SessionStore
from .verify import verify_export


#: 종류별로 살려두는 렌더 디렉터리 세대 수.
#:
#: 1이면(= 새 렌더가 직전 렌더를 즉시 삭제) 실사용에서 미리보기가 깨진다.
#: 프런트는 render_preview 응답을 받은 뒤 pngPath를 **두 번째 왕복**
#: (read_file_b64, src-tauri/src/engine.rs)으로 읽는데, 엔진은 stdin 큐를
#: 순차 처리하므로 그 사이 다음 render_preview가 시작되면서 방금 돌려준
#: PNG를 지워버린다 — 프런트에는 "preview.png: No such file or directory"로
#: 뜬다. 프런트가 읽는 경로는 항상 "가장 최근에 받은 응답"의 것이므로 2면
#: 원리상 충분하고, 렌더가 연달아 두 번 끼어드는 최악의 경우까지 감안해 3을
#: 둔다. 상한이 있으므로 누수는 여전히 없다.
RENDER_DIR_GENERATIONS = 3


def _emit(obj, out):
    out.write(json.dumps(obj) + "\n")
    out.flush()


class Engine:
    _ALLOWED_METHODS = {
        "open_psd", "close_session", "render_thumbnails",
        "render_preview", "render_document_preview",
        "apply_preset", "auto_merge_operations", "export_psd", "batch_run",
    }

    def __init__(self, out=None):
        self.store = SessionStore()
        self.out = out or sys.stdout
        self.tmp = Path(tempfile.mkdtemp(prefix="psd_engine_"))
        # 종류("thumbnails"/"preview")별 최근 렌더 디렉터리 링. 새 호출이
        # RENDER_DIR_GENERATIONS세대 이전 것을 지워, 호출당 하나씩 무한히 쌓이는
        # 것을 막는다. atexit만으로는 부족하다: kill_engine
        # (src-tauri/src/engine.rs)이 앱 종료 시 SIGKILL을 보내 atexit를 통째로
        # 건너뛰므로, 400ms 디바운스 미리보기 세션은 하루 만에 수백 장의 PNG를
        # 남길 수 있다.
        self._render_dirs: dict[str, deque[Path]] = {}
        atexit.register(shutil.rmtree, self.tmp, ignore_errors=True)

    def _fresh_render_dir(self, kind):
        ring = self._render_dirs.setdefault(kind, deque())
        out_dir = Path(tempfile.mkdtemp(dir=self.tmp))
        ring.append(out_dir)
        while len(ring) > RENDER_DIR_GENERATIONS:
            shutil.rmtree(ring.popleft(), ignore_errors=True)
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

    def render_preview(self, sessionId, visibleLayerIds, maxSize=1500, lineColor=None):
        s = self.store.get(sessionId)
        out_dir = self._fresh_render_dir("preview")
        return {"pngPath": render_preview(s, visibleLayerIds, maxSize, out_dir,
                                          line_color=lineColor)}

    def auto_merge_operations(self, sessionId, layerIds, roleTokens=None):
        """레이어 패널의 '요소별 병합' 버튼용. 프리셋 경로와 같은 함수를 쓴다."""
        s = self.store.get(sessionId)
        return {"operations": auto_merge_operations(s["tree"], layerIds, roleTokens)}

    def render_document_preview(self, sessionId, maxSize=1500):
        s = self.store.get(sessionId)
        out_dir = self._fresh_render_dir("preview")
        return {"pngPath": render_document_preview(s, maxSize, out_dir)}

    def apply_preset(self, sessionId, preset):
        s = self.store.get(sessionId)
        matched = match_preset(s["tree"], preset)
        return {
            "matchedLayerIds": matched,
            "operations": preset_operations(s["tree"], matched, preset,
                                            source_stem=Path(s["path"]).stem),
        }

    def batch_run(self, paths, preset, outputDir=None, overwrite=False):
        from .batch import run_batch

        def progress(path, stage, current, total):
            _emit({"event": "progress", "path": path, "stage": stage,
                   "current": current, "total": total}, self.out)

        return run_batch(paths, preset, output_dir=outputDir,
                         overwrite=overwrite, progress=progress)

    def export_psd(self, sessionId, includedIds, operations, naming, outputPath,
                   embedPreview=True, overwrite=False, verify=True, lineColor=None):
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
                         overwrite=overwrite, progress=progress, line_color=lineColor)
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
