"""전체 캐시 워커 — 타일 디스크 캐시를 채우는 것만 하는 별도 프로세스.

왜 별도 프로세스인가. 메인 엔진은 stdin이 직렬이라 워밍업 요청 하나가 나가
있는 동안 사용자 렌더가 그 뒤에서 기다린다 — 그래서 엔진 내 스윕은 요청을
잘게 자르고 양보 규칙을 얹어야 했고, 큰 드로잉 레이어(예상 10초 초과)는
시작조차 못 했다(render.WARM_MAX_PREDICTED_S). 워커는 자기 프로세스라 그런
제약이 없다: **건너뛰기 없이 전부** 치르고, 여럿 띄우면 파일 단위로 병렬이
된다(i9-9900K 실측 기준 워커 4~6개면 4~5배). 산출물은 tilecache의 디스크
캐시뿐이므로 메인 엔진과 겹쳐 돌아도 서로 밟지 않는다 — 쓰기가 원자적이고
(tilecache.store), 같은 타일을 두 번 쓰면 같은 내용이 두 번 놓일 뿐이다.

프로토콜은 메인 엔진과 같은 줄 단위 JSON이다.
  stdin  : {"path": "<PSD 경로>", "edgeLines"?, "presets"?} 한 줄에 하나. EOF면 끝낸다.
  stdout : {"event": "ready"}                                  기동 직후 한 번
           {"event": "progress", "path", "done", "total"}      단위 작업 하나마다
           {"event": "file", "path", "ok": true, "total"}      파일 완료
           {"event": "file", "path", "ok": false, "message"}   파일 실패(다음 줄 계속)

`presets`는 앱의 프리셋 목록(BG·CHAR가 기본)이다. 있으면 타일·오버레이에 더해
**프리셋마다 "갓 적용한 화면"의 미리보기 PNG까지** 디스크 캐시에 미리 굽는다 —
타일이 다 있어도 클릭 순간의 미리보기 합성(타일 수백 장 + PNG 인코딩, 실측
최악 41초)은 남아 있었고, 그것까지 치러야 "전체 캐시 완료 = 어떤 파일이든,
어느 프리셋이든 즉시"가 참이 된다. `edgeLines`는 presets 이전의 프로토콜로,
오버레이 워밍업만 한다 — presets가 있으면 무시된다.

`export`가 있으면 그 줄은 워밍업이 아니라 **배치 내보내기 한 파일**이다:
  {"path", "export": {"preset", "outputDir"?, "overwrite"?, "manualLineIds"?}}
batch._process_one을 그대로 돌리므로 산출물·검증·색 통일 규칙이 메인 엔진의
배치와 비트까지 같다 — 워커는 파일을 나눠 드는 것뿐이다. 진행은 배치의 stage
이벤트({"event":"progress","path","stage","current","total"}), 완료는
{"event":"file","path","ok","result"}로 나간다. result는 run_batch의 항목과
같은 모양이라(실패면 error.traceback 포함) 프런트가 기존 배치 보고서에 그대로
합친다.

진행을 단위 작업 하나마다 알리는 것은 낭비가 아니다 — 진행이 안 보이면
사용자는 멈췄다고 보고 아무거나 누른다. 파일 실패는 그 파일만 접고 다음 줄을
기다린다: 한 장이 깨졌다고 폴더 전체 캐시가 끊기면 안 된다.
"""
import json
import os
import shutil
import sys
import tempfile

from psd_tools import PSDImage
from psd_tools.constants import ColorMode

from .matching import match_preset
from .render import _preview_tile, preview_scale
from .tree import build_tree


def _pixel_leaf_ids(nodes, included=None, initial=False):
    """
    문서 순서의 픽셀 잎 id. included가 있으면 그 안의 것만, initial이면
    자기 visible 플래그가 켜진 것만(파일을 연 직후 보이는 잎 — isDocumentView의
    initial과 같은 뜻).

    프런트 visibleIdsForPreview(src/lib/preview.ts)와 같은 걷기·같은 순서여야
    한다 — 이 목록이 미리보기 캐시 키(rpc._preview_key_material)에 순서째
    들어가므로, 순서가 다르면 같은 그림에 다른 키가 붙는다.
    """
    out = []
    for node in nodes:
        if node["kind"] == "group":
            out.extend(_pixel_leaf_ids(node.get("children") or [],
                                       included, initial))
        elif node["kind"] == "pixel":
            if included is not None and node["id"] not in included:
                continue
            if initial and not node["visible"]:
                continue
            out.append(node["id"])
    return out


def _preset_preview_args(tree, preset):
    """
    "이 프리셋을 갓 적용한 화면"이 render_preview에 보낼 인자와 **정확히 같은**
    값. 미리 구울 것이 없으면 None.

    프런트의 세 계산을 그대로 옮긴 것이라 그쪽이 바뀌면 여기도 같이 봐야 한다.
      - includedIds: applyPresetResult(src/state/appStore.tsx)가 매칭 결과를
        숫자 오름차순으로 정렬해 넣는다.
      - visibleIds: visibleIdsForPreview(src/lib/preview.ts) — 눈·솔로가 없는
        갓 적용 상태이므로 "포함된 픽셀 잎, 문서 순서"다.
      - lineColorIds: lineColorIdsFor(src/lib/previewCache.ts) — visibleIds 중
        매칭에 걸린 것.
    edgeLines의 manualColourIds는 빈 목록이다 — 수동 지정은 파일별 작업 상태라
    갓 적용 상태에는 없다(engine.ts renderPreview가 payload를 만드는 방식과
    같다). 수동 지정·눈·솔로가 있는 화면은 키가 달라 캐시를 그냥 지나친다 —
    그런 화면은 예전처럼 그 자리에서 합성한다.

    None이 되는 두 경우도 프런트를 따른다: 그릴 것이 없으면(매칭 0장) 화면도
    합성하지 않고, 매칭이 "파일을 연 직후 보이는 전부"와 같으면 화면은
    render_document_preview(저장된 병합 이미지, 즉시)로 가므로 구울 것이 없다.
    """
    matched, _skipped = match_preset(tree, preset)
    matched_set = set(matched)
    visible = _pixel_leaf_ids(tree, matched_set)
    if not visible:
        return None
    initial = _pixel_leaf_ids(tree, initial=True)
    if len(initial) == len(visible) and set(initial) == set(visible):
        return None
    edge = preset.get("edgeLines")
    line_color = preset.get("lineColor")
    return {
        "visible": visible,
        "included": sorted(matched),
        "lineColor": line_color,
        "lineColorIds": None if line_color is None
            else [i for i in visible if i in matched_set],
        "edgeLines": {**edge, "manualColourIds": []} if edge else None,
    }


def _emit(obj, out):
    out.write(json.dumps(obj) + "\n")
    out.flush()


def warm_file(path, max_size, out, edge_lines=None, presets=None):
    """
    파일 하나의 모든 드로잉 레이어 타일을, 경계선이 켜진 설정이 있으면 각 뷰의
    오버레이까지, 그리고 presets가 오면 **프리셋마다 갓 적용한 화면의 미리보기
    PNG까지** 디스크에 쌓는다. "전체 캐시 완료"가 "어떤 파일을 눌러도 즉시"를
    뜻하려면 오버레이(뷰당 실측 9~36초)와 클릭 순간의 미리보기 합성까지 미리
    치러야 한다 — 타일만 쌓으면 파일마다 첫 렌더가 그 비용을 그 자리에서 낸다.

    경계선 설정은 presets가 있으면 거기서 뽑는다(켜진 edgeLines, 픽셀 설정이
    같은 것은 한 번 — BG는 꺼져 있어 CHAR 하나만 남는 것이 기본이다). presets가
    없으면 예전 프로토콜대로 edge_lines 하나다.

    뷰는 자동 검출(find_views)만 다룬다. 수동 지정 뷰는 앱의 작업 상태라 워커가
    모르고, 그런 파일은 드물어서 첫 렌더 한 번을 그냥 치른다. 미리보기도 같은
    이유로 갓 적용 상태만 굽는다 — 눈·솔로·수동 지정이 낀 화면은 키가 달라
    캐시를 지나치고, 그 자리에서 합성한다(_preset_preview_args 참고).
    """
    from . import tilecache
    from .character import find_views
    from .edges import EDGE_DEFAULTS, plan_overlays
    from .rpc import _edge_settings_key, render_preview_cached

    mtime = os.path.getmtime(path)
    psd = PSDImage.open(path)
    # 메인 엔진(session.open)과 같은 제한 — 거기서 못 여는 파일을 여기서 데워도
    # 쓸 사람이 없다.
    if psd.color_mode != ColorMode.RGB:
        raise ValueError(f"unsupported color mode: {psd.color_mode!r} (RGB only)")
    built = build_tree(psd)
    session = {"psd": psd, "path": str(path), "mtime": mtime,
               "tree": built["tree"], "layers_by_id": built["layers_by_id"]}
    scale = preview_scale(psd, max_size)
    leaves = [lid for lid, layer in built["layers_by_id"].items()
              if not layer.is_group()]
    # 키가 렌더 경로(rpc._cached_plan_overlays)와 비트까지 같아야 한다 —
    # 그래서 병합도 키 추출도 그쪽 코드를 그대로 쓴다.
    variants, seen = [], set()
    for e in ([p.get("edgeLines") for p in presets] if presets
              else [edge_lines]):
        if not (e and e.get("enabled")):
            continue
        opts = {**EDGE_DEFAULTS, **e}
        skey = _edge_settings_key(opts)
        if skey not in seen:
            seen.add(skey)
            variants.append(opts)
    views = find_views(session) if variants else []
    previews = [args for p in (presets or [])
                for args in [_preset_preview_args(built["tree"], p)]
                if args is not None]
    total = len(leaves) + len(views) * len(variants) + len(previews)
    done = 0
    for lid in leaves:
        # _preview_tile이 디스크 우선 → 디코드 → 디스크 저장까지 다 한다.
        # 세션 RAM 캐시는 예산(192MB) LRU가 걸려 있고, 파일이 끝나면 session
        # 딕셔너리와 함께 통째로 버려진다.
        _preview_tile(session, lid, scale)
        done += 1
        _emit({"event": "progress", "path": path, "done": done, "total": total},
              out)
    for opts in variants:
        skey = _edge_settings_key(opts)
        for view in views:
            vkey = tilecache.overlay_key(view["colourIds"], view["lineIds"], skey)
            if tilecache.load_overlays(session, vkey) is None:
                made = plan_overlays(session, [view], opts)
                tilecache.store_overlays(session, vkey, made)
            done += 1
            _emit({"event": "progress", "path": path, "done": done,
                   "total": total}, out)
    if previews:
        # render_preview_cached가 out_dir에 PNG를 쓰고 캐시로 복사한다 —
        # 남는 사본은 파일이 끝나면 통째로 버린다(메인 엔진의 렌더 링과 달리
        # 여기 PNG는 아무도 다시 읽지 않는다).
        out_dir = tempfile.mkdtemp(prefix="warm_preview_")
        try:
            for args in previews:
                render_preview_cached(
                    session, out_dir, args["visible"], max_size,
                    line_color=args["lineColor"],
                    line_color_ids=args["lineColorIds"],
                    edge_lines=args["edgeLines"],
                    included_ids=args["included"])
                done += 1
                _emit({"event": "progress", "path": path, "done": done,
                       "total": total}, out)
        finally:
            shutil.rmtree(out_dir, ignore_errors=True)
    return total


def export_file(path, job, out, store):
    """
    배치 내보내기 한 파일. 규칙 전부를 batch._process_one에 위임한다 — 매칭,
    수동 라인 합류, 색 통일, 경계선, 분할, 검증이 메인 엔진의 배치와 같은 함수
    하나를 타야 워커로 나눠 돌린 산출물이 순차 배치와 갈리지 않는다.

    실패도 run_batch와 같은 모양의 항목으로 돌려보낸다(에러를 흡수하지 않는다
    — traceback째 result.error에 싣는다). 호출자는 이 함수가 던지지 않는다고
    믿어도 된다: 한 파일의 실패로 워커가 죽으면 안 되는 것은 워밍업과 같다.
    """
    import traceback

    from .batch import _process_one

    def progress(p, stage, current, total):
        _emit({"event": "progress", "path": p, "stage": stage,
               "current": current, "total": total}, out)

    try:
        result = _process_one(store, path, job["preset"], job.get("outputDir"),
                              job.get("overwrite", False), progress,
                              manual_line_ids=job.get("manualLineIds") or ())
        _emit({"event": "file", "path": path, "ok": result["ok"],
               "result": result}, out)
    except Exception as e:  # noqa: BLE001 — run_batch와 같은 항목별 기록 정책
        _emit({"event": "file", "path": path, "ok": False,
               "message": f"{type(e).__name__}: {e}",
               "result": {"path": path, "ok": False,
                          "error": {"message": str(e),
                                    "traceback": traceback.format_exc()}}}, out)


def main(stdin=None, stdout=None, max_size=1500):
    """
    워커 루프. max_size는 앱의 미리보기 배율(PREVIEW_MAX_SIZE=1500)과 같아야
    같은 키의 타일이 쌓인다 — 배율이 캐시 키에 들어간다(tilecache._tile_path).
    """
    from .rpc import _as_utf8, _watch_for_orphaning
    from .session import SessionStore

    # 프로세스 손질은 진짜 워커로 떴을 때만(stdin 미주입 = __main__ 경로).
    # 테스트가 스트림을 주입해 부르는 경우까지 pytest 프로세스를 nice로 내리면
    # 안 된다.
    if stdin is None:
        # 메인 엔진·UI에 CPU를 양보한다. 워커는 몇 시간짜리 배경 작업이므로
        # 사람이 누른 렌더보다 늘 뒤여야 한다. (윈도우에는 os.nice가 없다.)
        try:
            os.nice(10)
        except (AttributeError, OSError):
            pass
        # 앱이 죽으면 워커도 끝낸다 — 배치에서 실측된 "부모 없이 CPU 99%로
        # 계속 파는 파이썬"의 재발 방지. rpc.py의 같은 장치를 그대로 쓴다.
        _watch_for_orphaning()

    stdin = stdin or _as_utf8(sys.stdin)
    stdout = stdout or _as_utf8(sys.stdout)
    _emit({"event": "ready"}, stdout)
    #: 내보내기 잡용 세션 저장소. run_batch(max_sessions=1)와 같은 규율 —
    #: 파일당 열고-처리-닫기라 워커의 메모리 곡선이 순차 배치와 같다.
    #: (워커의 nice(10)는 내보내기에도 그대로 둔다: 배치 중에도 사람이 누른
    #: 미리보기·UI가 먼저다. 노는 기계에서는 nice가 속도를 깎지 않는다.)
    export_store = None
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        path = msg["path"]
        if "export" in msg:
            # 실패 항목도 export_file이 만들어 보낸다 — 여기서 또 감싸지 않는다.
            if export_store is None:
                export_store = SessionStore(max_sessions=1)
            export_file(path, msg["export"], stdout, export_store)
            continue
        try:
            mtime = os.path.getmtime(path)
            total = warm_file(path, max_size, stdout, msg.get("edgeLines"),
                              msg.get("presets"))
            # mtime을 실어 보낸다 — 프런트는 앱에서 아직 안 연 파일도 워커에
            # 맡기므로, "이 판을 쓸었다"는 기록(path+mtime)의 mtime을 워커가
            # 재서 알려 줘야 한다.
            _emit({"event": "file", "path": path, "ok": True, "total": total,
                   "mtime": mtime}, stdout)
        except Exception as e:  # 파일 하나의 실패로 워커를 죽이지 않는다
            _emit({"event": "file", "path": path, "ok": False,
                   "message": f"{type(e).__name__}: {e}"}, stdout)
