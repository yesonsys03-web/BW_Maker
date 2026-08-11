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
from collections import OrderedDict, deque
from pathlib import Path

from .character import find_views, manual_views
from .edges import EDGE_DEFAULTS, attach_overlays, plan_overlays
from .export import export_psd as _export
from .export import export_psd_split as _export_split
from .matching import (auto_merge_operations, auto_merge_preview,
                       match_preset, preset_operations)
from .ops import build_export_plan, finalize_names
from .raster import export_raster as _export_raster
from .raster import export_raster_split as _export_raster_split
from .render import (_perf, assign_line_color, render_document_preview,
                     render_preview, render_thumbnails, warm_preview_tiles)
from .session import SessionStore
from .verify import verify_export
from .verify_raster import verify_raster


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


#: 오버레이 캐시가 세션당 들고 있는 항목 수 상한. **소프트 캡이다** — 지금
#: 렌더가 쓰는 뷰들은 축출하지 않으므로, 뷰가 상한보다 많은 판에서는 그 렌더
#: 동안 상한을 넘긴다(_cached_plan_overlays 참고).
#:
#: 오버레이 한 장은 그 뷰의 bbox 크기짜리 RGBA 배열이다. 컨트롤러 실측으로 뷰
#: 박스가 최대 약 3.1 Mpx였으니 한 장이 3.1e6px * 4B(RGBA) ≈ 12.4MB를 넘을 수
#: 있다. "실사용 파일은 뷰가 최대 7장"(설계 문서 9절)이라는 이 값의 원래 근거는
#: 2026-08-11 실측으로 깨졌다 — 납품 캐릭터 폴더에 뷰 15개짜리 판이 있고, 그
#: 판에서 하드 캡 LRU는 순차 삽입 때문에 매 렌더 100% 미스였다(뷰당 ~9초 ×
#: 15뷰 = 토글마다 134초). 소프트 캡의 최악 메모리는 "한 파일의 실제 뷰 수 ×
#: 12.4MB × 세션 2"로, 뷰 15개면 ≈ 372MB — 무한정 쌓이던 예전 썸네일 OOM과
#: 달리 파일 구조가 묶는 값이고, 설정을 바꿔가며 쌓이는 옛 항목에는 여전히
#: 상한이 든다.
OVERLAY_CACHE_PER_SESSION = 8

#: opts 중 실제로 그려지는 픽셀을 바꾸는 설정만 뽑아 캐시 키로 쓴다
#: (edges.EDGE_DEFAULTS·build_overlay가 읽는 것과 정확히 같은 일곱 개).
#: "enabled"는 이 값이 캐시 키에 들어갈 필요가 없다 — _cached_plan_overlays는
#: 호출부가 이미 enabled를 확인한 뒤에만 부른다. "manualColourIds"도 뺀다 —
#: 그게 바뀌면 뷰 자체(view["colourIds"]/view["lineIds"])가 달라지므로 뷰
#: 키에서 이미 갈린다.
#:
#: width는 다른 에이전트가 지금 "0 = 파일 자체 선 굵기에서 두께를 유도한다"는
#: 뜻으로 의미를 바꾸는 중이다. 유도된 값이 아니라 **넘어온 값 그대로**(0이든
#: 5든) 키에 쓴다 — 유도는 edges.py 안에서 일어나므로, 여기서 미리 계산해
#: 끼워 넣으면 그 작업과 어긋날 수 있고 넘어온 값 그대로 쓰면 의미가 어느
#: 쪽이든 항상 옳다.
#: colourMode도 여기 들어간다. 그리는 픽셀을 바꾸는 설정이면 예외 없이 키에 있어야
#: 한다 — 빠진 채로 두면 같은 세션에서 모드만 바꿨을 때 이전 모드의 오버레이가 캐시에서
#: 그대로 나오고, 두 방법을 비교하려던 사람은 "차이 없음"이라는 틀린 판정을 얻는다.
#: 비교하려고 만든 옵션이 비교를 막는 셈이다. edgeMode도 같은 이유로 들어간다 —
#: region/change 두 검출을 같은 세션에서 비교하려고 만든 옵션이니, 키에서 빠지면
#: 그 비교 자체가 막힌다.
_PIXEL_SETTINGS = ("threshold", "gap", "width", "minLength", "lineAlpha",
                   "colourMode", "edgeMode")


def _edge_settings_key(opts):
    return tuple(opts.get(k) for k in _PIXEL_SETTINGS)


def _cached_plan_overlays(session, views, opts):
    """
    plan_overlays를 세션당 메모이즈해서 부른다.

    오버레이 하나는 그 뷰의 색 레이어·라인 레이어와 픽셀에 영향을 주는 설정
    (threshold/gap/width/minLength/lineAlpha)만으로 정해진다 — 지금 화면에 뭐가
    보이는지(visibleLayerIds)는 그 값에 관여하지 않는다. 눈은 "그려진 오버레이
    중 무엇을 합성하는지"만 정할 뿐이다(render_preview의 시점-필터, render.py가
    그리기 직전에 lineIds & visible로 한 번 더 거르는 것과는 다른 층이다). 그래서
    같은 뷰·같은 설정이면 레이어 눈을 켰다 껐다 다시 렌더해도 결과가 같고, 다시
    계산할 이유가 없다 — 이 캐시가 옳은 이유가 그것이다.

    캐시는 세션 딕셔너리 위에 얹는다(session.py를 건드리지 않고 여기서 attach).
    SessionStore.open은 경로와 mtime이 둘 다 같을 때만 세션을 재사용하고,
    아티스트가 포토샵에서 저장하면 mtime이 바뀌어 완전히 새 세션 딕셔너리가
    만들어진다(session.py의 open 참고) — 그러니 여기서 따로 무효화를 챙길 필요가
    없다. 옛 세션이 LRU에 밀려 사라지면 그 딕셔너리를 참조하는 곳이 없어져
    캐시도 함께 GC된다. 상한(OVERLAY_CACHE_PER_SESSION)은 그와 별개로, 같은
    세션 안에서 설정을 계속 바꿔가며 미리보기를 켜켜이 쌓는 경우를 막는다.
    """
    cache = session.setdefault("_overlay_cache", OrderedDict())
    settings_key = _edge_settings_key(opts)
    # 이번 렌더가 쓰는 뷰들의 키. 축출에서 지킨다 — 상한(8)보다 뷰가 많은 판
    # (실측 #44: 뷰 15개)에서 순차 삽입 LRU가 매 렌더 100% 미스가 되는 것을
    # 막는다. 캐시가 전혀 안 듣는 그 상태로 뷰당 ~9초 × 15뷰 = 토글마다 134초가
    # 실측됐다. 지킬 것만 남으면 상한을 넘긴 채 둔다 — SessionStore._evict가
    # 고정된 세션 하나만 남았을 때 내리는 판단과 같다: 상한 초과가 스래싱보다 낫다.
    wanted = {(tuple(v["colourIds"]), tuple(v["lineIds"]), settings_key)
              for v in views}
    plans = []
    for view in views:
        key = (tuple(view["colourIds"]), tuple(view["lineIds"]), settings_key)
        cached = cache.get(key)
        if cached is not None:
            cache.move_to_end(key)
            plans.extend(cached)
            continue
        t0 = time.perf_counter()
        made = plan_overlays(session, [view], opts)
        _perf(perf="overlay_view", s=round(time.perf_counter() - t0, 4))
        cache[key] = made
        while len(cache) > OVERLAY_CACHE_PER_SESSION:
            victim = next((k for k in cache if k not in wanted), None)
            if victim is None:
                break
            del cache[victim]
        plans.extend(made)
    return plans


def _emit(obj, out):
    out.write(json.dumps(obj) + "\n")
    out.flush()


class Engine:
    _ALLOWED_METHODS = {
        "open_psd", "psd_mtimes", "close_session", "pin_file", "render_thumbnails",
        "render_preview", "render_document_preview", "warm_preview_tiles",
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
        t0 = time.perf_counter()
        sid = self.store.open(path)
        _perf(perf="open_psd", s=round(time.perf_counter() - t0, 4))
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

    def psd_mtimes(self, paths):
        """
        경로마다 디스크의 수정시각. 프로젝트를 열 때 "이 PSD가 저장 이후에
        바뀌었나"를 판정하는 근거다(설계 4절). PSD를 파싱하지 않으므로 세션을
        만들지 않고, 100장을 물어도 stat 100번이다.

        **없는 파일은 키 자체를 빼고 돌려준다.** 0 같은 값으로 채우면 호출부가
        "안 바뀐 파일"로 오판할 수 있다 — 없는 것과 안 바뀐 것은 다르다.

        초 단위로 자른다. open_psd가 돌려주는(그래서 프로젝트에 저장되는) mtime은
        session.py의 os.path.getmtime 그대로라 소수점 이하가 있는 float이므로,
        여기서 자른 값을 그대로 비교하면 안 바뀐 파일이 전부 "바뀜"이 된다.
        실제 비교는 reconcileProject가 양쪽을 다 Math.floor로 자르는 한 곳에서만
        한다(src/lib/project.ts) — 여기서 자르는 것은 두 곳이 같은 단위를
        말하게 두려는 것이지, 판정을 여기로 옮기려는 것이 아니다.
        """
        out = {}
        for p in paths:
            try:
                out[str(p)] = int(os.path.getmtime(p))
            except OSError:
                pass
        return out

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

    def warm_preview_tiles(self, sessionId, layerIds, maxSize=1500, budgetMs=2000):
        """
        미리보기 타일 워밍업. 프런트가 유휴 시간에 잘게 나눠 부른다 —
        maxSize는 render_preview와 같아야 같은 배율의 타일이 데워진다
        (배율이 키에 들어간다, render._preview_tile 참고).
        """
        s = self.store.get(sessionId)
        return warm_preview_tiles(s, layerIds, maxSize, budgetMs / 1000.0)

    def render_preview(self, sessionId, visibleLayerIds, maxSize=1500, lineColor=None,
                       lineColorIds=None, edgeLines=None, includedIds=None):
        t_start = time.perf_counter()
        overlay_s = 0.0
        s = self.store.get(sessionId)
        out_dir = self._fresh_render_dir("preview")
        overlays = None
        if edgeLines and edgeLines.get("enabled"):
            opts = {**EDGE_DEFAULTS, **edgeLines}
            visible = set(visibleLayerIds)
            # 수동은 자동에 **보탠다**(설계 3.1). 자동 결과를 지우지 않는다.
            #
            # manual_views의 included_ids는 "내보내기에 이미 포함된 라인"을
            # 뜻한다(character.manual_views 참고) — export_psd는 실제 includedIds를
            # 준다. render_preview도 이제 같은 것을 includedIds로 받는다
            # (src/lib/engine.ts의 renderPreview → PreviewCanvas/App.tsx의
            # ops.includedIds가 그대로 여기까지 온다).
            #
            # 이걸 visibleLayerIds(체크 ∩ 눈, 솔로 중이면 솔로 목록)로 대신하면
            # 안 된다 — 체크는 됐지만 눈으로만 숨긴 라인이 "빠진" 것으로 보여,
            # 이 앱 다른 곳에서는 눈이 무엇이 그려지는지만 바꾸는데(export_psd는
            # 눈을 아예 안 본다) 여기서만 계산 자체가 눈에 따라 달라지는 예외가
            # 생긴다. 반대로 그 버그를 피하려고 세션의 모든 레이어 id를 넘기면
            # (전 버전이 그랬다) 교집합이 사실상 무력화돼, 아티스트가 체크를
            # 해제해 실제로는 내보내기에 없는 라인까지 "이미 있다"고 보아 획을
            # 덜 그린다 — 미리보기가 내보내기보다 획이 적어 보이는 정확히 그
            # 라인이 지워진다.
            #
            # includedIds가 있으면 그것을 그대로 쓴다. 없는 옛 호출(직접
            # render_preview를 부르는 기존 테스트 등)은 이전처럼 세션의 모든
            # 레이어 id로 근사한다 — 하위 호환을 위한 기본값일 뿐, 새 호출은
            # 전부 진짜 목록을 넘긴다.
            #
            # visibleLayerIds(위 visible)는 이 계산에 관여하지 않는다 — 그건
            # 무엇이 그려지는지(눈 포함)를 정하고, includedIds는 무엇이 "이미
            # 있는 라인"인지를 정한다. 서로 다른 질문이라 한 값으로 합치면
            # 안 된다.
            included = includedIds if includedIds is not None else s["layers_by_id"].keys()
            views = find_views(s) + manual_views(
                s, edgeLines.get("manualColourIds") or [], included)
            # render.render_preview가 그리기 직전에 이미 하는 lineIds & visible
            # 필터를 여기로 앞당긴다. plan_overlays 하나가 뷰당 0.9~11.6초라
            # (설계 9절) 다섯 뷰 모델에서 하나만 솔로해도 나머지 넷을 합성해
            # 버리고 버리는 낭비가 있었다 — 요청이 stdin 큐에서 순차 처리되므로
            # 그 낭비가 뒤에 온 다른 요청까지 물고 늘어진다. 그리기 시점 필터는
            # 그대로 둔다 — 호출자가 잊을 수 없는 안전망이다.
            views = [v for v in views if set(v["lineIds"]) & visible]
            t_overlay = time.perf_counter()
            overlays = _cached_plan_overlays(s, views, opts)
            overlay_s = time.perf_counter() - t_overlay
        png_path = render_preview(s, visibleLayerIds, maxSize, out_dir,
                                  line_color=lineColor,
                                  line_color_ids=lineColorIds,
                                  edge_overlays=overlays)
        _perf(perf="rpc.render_preview", n=len(visibleLayerIds),
              overlay_plan_s=round(overlay_s, 4),
              total_s=round(time.perf_counter() - t_start, 4))
        return {"pngPath": png_path}

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

    def batch_run(self, paths, preset, outputDir=None, overwrite=False,
                  manualLineIds=None):
        from .batch import run_batch

        def progress(path, stage, current, total):
            _emit({"event": "progress", "path": path, "stage": stage,
                   "current": current, "total": total}, self.out)

        return run_batch(paths, preset, output_dir=outputDir,
                         overwrite=overwrite, progress=progress,
                         manual_line_ids=manualLineIds)

    def export_psd(self, sessionId, includedIds, operations, naming, outputPath,
                   embedPreview=True, overwrite=False, verify=True, lineColor=None,
                   splitLayers=False, outputFormat="psd", lineColorIds=None,
                   edgeLines=None):
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
        # 색 통일을 여기서 한 번만 정한다. 아래 내보내기·검증은 그 판단을 읽기만
        # 하므로 둘이 갈라질 수 없다(assign_line_color 참고). 형식이 틀린 색은
        # 파일을 만들기 전인 여기서 걸린다.
        assign_line_color(entries, lineColor, lineColorIds)
        # 색 경계선. 켜져 있을 때만 돈다 — 꺼져 있으면 엔트리가 그대로이므로
        # 산출물이 이 기능 이전과 바이트 단위로 같다.
        if edgeLines and edgeLines.get("enabled"):
            opts = {**EDGE_DEFAULTS, **edgeLines}
            # 수동은 자동에 **보탠다**(설계 3.1). 자동 결과를 지우지 않는다.
            #
            # 여기서는 `included`(진짜 includedIds, 눈 상태와 무관) 그대로 준다 —
            # render_preview 쪽과 달리 이 메서드는 진짜 포함 목록을 이미 갖고
            # 있으므로 근사할 이유가 없다. 눈(previewHiddenIds)은 여기 관여하지
            # 않는다 — export_psd 전체가 애초에 눈을 보지 않는다.
            views = find_views(s) + manual_views(
                s, edgeLines.get("manualColourIds") or [], included)
            attach_overlays(entries, _cached_plan_overlays(s, views, opts))
        else:
            attach_overlays(entries, [])

        def progress(stage, current, total):
            _emit({"event": "progress", "stage": stage,
                   "current": current, "total": total}, self.out)

        if outputFormat in ("png", "jpg"):
            if splitLayers:
                result = _export_raster_split(s, entries, outputPath, outputFormat,
                                              overwrite=overwrite, progress=progress)
                if verify:
                    # 파일마다 그 파일에 들어간 엔트리 하나로 검증한다.
                    for entry, out in zip(entries, result["outputs"]):
                        out["verification"] = verify_raster(
                            s, [entry], out["outputPath"], outputFormat)
                    result["verification"] = {
                        "ok": all(o["verification"]["ok"] for o in result["outputs"]),
                        "canvasOk": all(o["verification"]["canvasOk"] for o in result["outputs"]),
                        "layerCountOk": True,
                        "expectedLayers": len(result["outputs"]),
                        "actualLayers": len(result["outputs"]),
                        "layers": [l for o in result["outputs"] for l in o["verification"]["layers"]],
                    }
                result["outputPath"] = os.path.dirname(result["outputs"][0]["outputPath"])
                return result
            result = _export_raster(s, entries, outputPath, outputFormat,
                                    overwrite=overwrite, progress=progress)
            if verify:
                result["verification"] = verify_raster(s, entries, outputPath,
                                                       outputFormat)
            return result

        if splitLayers:
            result = _export_split(s, entries, outputPath, embed_preview=embedPreview,
                                   overwrite=overwrite, progress=progress)
            if verify:
                # 파일마다 그 파일에 들어간 엔트리 하나로 검증한다.
                for entry, out in zip(entries, result["outputs"]):
                    out["verification"] = verify_export(s, [entry], out["outputPath"])
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
