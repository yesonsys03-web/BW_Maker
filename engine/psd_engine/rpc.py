"""줄 단위 JSON-RPC 루프. 모든 예외는 traceback과 함께 반환(흡수 금지)."""
import atexit
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import traceback
from collections import deque
from pathlib import Path

from .export import export_psd as _export
from .export import export_psd_split as _export_split
from .matching import (auto_merge_operations, auto_merge_preview,
                       match_preset, preset_operations)
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
        "open_psd", "close_session", "pin_file", "render_thumbnails",
        "render_preview", "render_document_preview",
        "apply_preset", "auto_merge_operations", "auto_merge_preview",
        "export_psd", "batch_run",
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
            # 파일이 마지막으로 바뀐 시각. UI가 만들어둔 미리보기를 언제까지
            # 재사용해도 되는지 판단하는 근거다 — 세션 id로는 판단할 수 없다.
            # 세션은 LRU에 밀려 수시로 새로 열리지만 그때 파일 내용은 그대로이고,
            # 반대로 아티스트가 포토샵에서 저장하면 내용이 달라진다.
            # 세션이 읽어둔 값을 그대로 쓴다. 여기서 다시 재면, 세션을 재사용하는
            # 경우(SessionStore.open) 트리는 옛 판인데 시각만 새 값이 되어 캐시
            # 키가 실제 내용과 어긋난다.
            "mtime": s["mtime"],
        }

    def close_session(self, sessionId):
        self.store.close(sessionId)
        return {}

    def pin_file(self, path=None):
        """
        화면이 지금 보고 있는 파일을 알린다 — 그 파일의 세션은 축출하지 않는다.
        세션 총량은 그대로이므로 메모리는 늘지 않는다(SessionStore.pin 참고).
        """
        self.store.pin(path)
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

    # 이 둘은 세션이 아니라 트리를 받는다. 이름만 보고 묶는 계산이라 픽셀도 PSD도
    # 필요 없는데, 세션을 요구하면 그것이 축출됐을 때 700MB짜리 파일을 통째로 다시
    # 읽어야 한다 — 버튼 한 번에 3.4초다. 화면은 트리를 이미 들고 있고(FileEntry.tree)
    # 그것은 세션이 밀려나도 남으므로, 그대로 보내면 왕복이 사라진다.
    #
    # 규칙 자체는 여전히 엔진에만 있다. 프런트에 다시 구현하면 배치 실행 결과와
    # 갈라지기 때문이다 — 옮긴 것은 입력이지 규칙이 아니다.
    def auto_merge_operations(self, tree, layerIds, roleTokens=None, rule="role"):
        """레이어 패널의 자동 병합 버튼용. 프리셋 경로와 같은 함수를 쓴다."""
        return {"operations": auto_merge_operations(tree, layerIds, roleTokens, rule=rule)}

    def auto_merge_preview(self, tree, layerIds, roleTokens=None):
        """규칙별 결과 장수. 드롭다운이 누르기 전에 보여준다."""
        return {"rules": auto_merge_preview(tree, layerIds, roleTokens)}

    def render_document_preview(self, sessionId, maxSize=1500):
        s = self.store.get(sessionId)
        out_dir = self._fresh_render_dir("preview")
        return {"pngPath": render_document_preview(s, maxSize, out_dir)}

    def apply_preset(self, sessionId, preset):
        s = self.store.get(sessionId)
        matched, skipped = match_preset(s["tree"], preset)
        return {
            "matchedLayerIds": matched,
            # 규칙에 걸렸지만 그릴 수 없어 뺀 레이어들. 조용히 버리면 화면에서는
            # "원래 안 걸린 것"과 구별되지 않는다.
            "skippedLayers": skipped,
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
                   embedPreview=True, overwrite=False, verify=True, lineColor=None,
                   splitLayers=False):
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

        if splitLayers:
            result = _export_split(s, entries, outputPath, embed_preview=embedPreview,
                                   overwrite=overwrite, progress=progress,
                                   line_color=lineColor)
            if verify:
                # 파일마다 그 파일에 들어간 엔트리 하나로 검증한다.
                for entry, out in zip(entries, result["outputs"]):
                    out["verification"] = verify_export(s, [entry], out["outputPath"], line_color=lineColor)
                result["verification"] = {
                    "ok": all(o["verification"]["ok"] for o in result["outputs"]),
                    "canvasOk": all(o["verification"]["canvasOk"] for o in result["outputs"]),
                    "layerCountOk": all(o["verification"]["layerCountOk"] for o in result["outputs"]),
                    "expectedLayers": len(entries),
                    "actualLayers": sum(o["verification"]["actualLayers"] for o in result["outputs"]),
                    "layers": [l for o in result["outputs"] for l in o["verification"]["layers"]],
                }
            result["outputPath"] = os.path.dirname(result["outputs"][0]["outputPath"])
            return result

        result = _export(s, entries, outputPath, embed_preview=embedPreview,
                         overwrite=overwrite, progress=progress, line_color=lineColor)
        if verify:
            result["verification"] = verify_export(s, entries, outputPath, line_color=lineColor)
        return result

    # ---- dispatch ----
    def handle(self, request):
        method_name = request.get("method", "")
        if method_name not in self._ALLOWED_METHODS:
            raise ValueError(f"unknown method: {method_name!r}")
        method = getattr(self, method_name)
        return method(**request.get("params", {}))


def _as_utf8(stream):
    """
    stdio를 UTF-8로 못박는다.

    프런트(src-tauri/src/engine.rs)는 요청 JSON을 UTF-8 원문 그대로 파이프에
    쓰는데(serde_json은 non-ASCII를 escape하지 않는다), 파이썬은 stdin을
    로케일 인코딩으로 읽는다. 한글 윈도우(cp949)에서는 한글 경로·프리셋 이름·
    레이어 이름이 든 첫 요청에서 `for line in stdin`이 UnicodeDecodeError로
    터졌고, 그 예외는 요청 하나가 아니라 엔진 프로세스 전체를 죽였다.

    응답 쪽은 json.dumps의 ensure_ascii가 한글을 \\uXXXX로 escape해 주므로
    원래도 안전했지만, 나가는 쪽도 같이 고정해 로케일에 기대지 않게 한다.
    """
    reconfigure = getattr(stream, "reconfigure", None)
    if reconfigure is not None:      # 테스트가 넘기는 StringIO 등에는 없다
        reconfigure(encoding="utf-8")
    return stream


def _watch_for_orphaning():
    """
    앱이 사라지면 엔진도 끝낸다.

    앱은 종료할 때 stdin을 닫아 아래 루프가 EOF로 빠져나오게 한다. 그런데 그
    신호는 **루프가 stdin을 읽고 있을 때만** 닿는다. 배치처럼 한 번의 요청이
    수십 분 도는 동안에는 아무도 stdin을 보지 않으므로 EOF가 쌓인 채로 남고,
    엔진은 앱이 없어진 줄 모르고 계속 판다 — 실측으로 CPU 99%·RSS 8.9GB짜리가
    남아 산출물을 계속 썼다.

    그래서 메인 루프 밖에서 부모를 지켜본다. 이 스레드는 긴 작업과 무관하게
    도므로 그때도 동작하고, 앱이 SIGKILL로 죽거나 터미널에서 Ctrl-C로 끊겨
    정리 코드가 아예 안 도는 경우까지 함께 막는다.

    죽는 방식은 os._exit이다. 지금 하던 작업을 중간에 끊는 것이 목적이므로
    정상 종료 절차(atexit의 임시 디렉터리 정리 포함)를 기다리지 않는다 — 부모가
    없는 이상 그 결과를 받을 사람도 없다.
    """
    poll = float(os.environ.get("PSD_ENGINE_ORPHAN_POLL", "2"))
    try:
        original = os.getppid()
    except AttributeError:  # 윈도우 등 getppid가 없는 환경
        return

    def orphaned():
        """
        부모가 사라졌는가.

        "처음 본 부모와 달라졌는가"만 보면 안 된다. 엔진은 psd_tools·pytoshop을
        임포트하느라 시작이 굼떠서, 앱이 그 사이에 죽으면 여기 도달했을 때 이미
        고아다 — 그러면 original이 처음부터 1로 잡혀 비교가 영영 거짓이 되고,
        정확히 "배치 중에 앱을 강제 종료했다"가 그 순서다.
        """
        ppid = os.getppid()
        return ppid == 1 or ppid != original

    def loop():
        while True:
            time.sleep(poll)
            if orphaned():
                os._exit(0)

    threading.Thread(target=loop, daemon=True).start()


def main(stdin=None, stdout=None):
    from .patches import apply_pytoshop_patches
    apply_pytoshop_patches()
    _watch_for_orphaning()
    stdin = stdin or _as_utf8(sys.stdin)
    stdout = stdout or _as_utf8(sys.stdout)
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
