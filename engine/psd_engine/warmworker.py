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
  stdin  : {"path": "<PSD 경로>"} 한 줄에 하나. EOF면 끝낸다.
  stdout : {"event": "ready"}                                  기동 직후 한 번
           {"event": "progress", "path", "done", "total"}      드로잉 레이어 하나마다
           {"event": "file", "path", "ok": true, "total"}      파일 완료
           {"event": "file", "path", "ok": false, "message"}   파일 실패(다음 줄 계속)

진행을 드로잉 레이어 한 장마다 알리는 것은 낭비가 아니다 — 진행이 안 보이면
사용자는 멈췄다고 보고 아무거나 누른다. 파일 실패는 그 파일만 접고 다음 줄을
기다린다: 한 장이 깨졌다고 폴더 전체 캐시가 끊기면 안 된다.
"""
import json
import os
import sys

from psd_tools import PSDImage
from psd_tools.constants import ColorMode

from .render import _preview_tile, preview_scale
from .tree import build_tree


def _emit(obj, out):
    out.write(json.dumps(obj) + "\n")
    out.flush()


def warm_file(path, max_size, out, edge_lines=None):
    """
    파일 하나의 모든 드로잉 레이어 타일을, 그리고 경계선이 켜져 있으면 각 뷰의
    오버레이까지 디스크에 쌓는다. "전체 캐시 완료"가 "어떤 파일을 눌러도 즉시"를
    뜻하려면 오버레이(뷰당 실측 9~36초)까지 미리 치러야 한다 — 타일만 쌓으면
    파일마다 첫 경계선 렌더가 그 비용을 그 자리에서 낸다.

    뷰는 자동 검출(find_views)만 다룬다. 수동 지정 뷰는 앱의 작업 상태라 워커가
    모르고, 그런 파일은 드물어서 첫 렌더 한 번을 그냥 치른다.
    """
    from . import tilecache
    from .character import find_views
    from .edges import EDGE_DEFAULTS, plan_overlays
    from .rpc import _edge_settings_key

    mtime = os.path.getmtime(path)
    psd = PSDImage.open(path)
    # 메인 엔진(session.open)과 같은 제한 — 거기서 못 여는 파일을 여기서 데워도
    # 쓸 사람이 없다.
    if psd.color_mode != ColorMode.RGB:
        raise ValueError(f"unsupported color mode: {psd.color_mode!r} (RGB only)")
    built = build_tree(psd)
    session = {"psd": psd, "path": str(path), "mtime": mtime,
               "layers_by_id": built["layers_by_id"]}
    scale = preview_scale(psd, max_size)
    leaves = [lid for lid, layer in built["layers_by_id"].items()
              if not layer.is_group()]
    views, opts = [], None
    if edge_lines and edge_lines.get("enabled"):
        views = find_views(session)
        # 키가 렌더 경로(rpc._cached_plan_overlays)와 비트까지 같아야 한다 —
        # 그래서 병합도 키 추출도 그쪽 코드를 그대로 쓴다.
        opts = {**EDGE_DEFAULTS, **edge_lines}
    total = len(leaves) + len(views)
    done = 0
    for lid in leaves:
        # _preview_tile이 디스크 우선 → 디코드 → 디스크 저장까지 다 한다.
        # 세션 RAM 캐시는 예산(192MB) LRU가 걸려 있고, 파일이 끝나면 session
        # 딕셔너리와 함께 통째로 버려진다.
        _preview_tile(session, lid, scale)
        done += 1
        _emit({"event": "progress", "path": path, "done": done, "total": total},
              out)
    if views:
        skey = _edge_settings_key(opts)
        for view in views:
            vkey = tilecache.overlay_key(view["colourIds"], view["lineIds"], skey)
            if tilecache.load_overlays(session, vkey) is None:
                made = plan_overlays(session, [view], opts)
                tilecache.store_overlays(session, vkey, made)
            done += 1
            _emit({"event": "progress", "path": path, "done": done,
                   "total": total}, out)
    return total


def main(stdin=None, stdout=None, max_size=1500):
    """
    워커 루프. max_size는 앱의 미리보기 배율(PREVIEW_MAX_SIZE=1500)과 같아야
    같은 키의 타일이 쌓인다 — 배율이 캐시 키에 들어간다(tilecache._tile_path).
    """
    from .rpc import _as_utf8, _watch_for_orphaning

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
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        path = msg["path"]
        try:
            mtime = os.path.getmtime(path)
            total = warm_file(path, max_size, stdout, msg.get("edgeLines"))
            # mtime을 실어 보낸다 — 프런트는 앱에서 아직 안 연 파일도 워커에
            # 맡기므로, "이 판을 쓸었다"는 기록(path+mtime)의 mtime을 워커가
            # 재서 알려 줘야 한다.
            _emit({"event": "file", "path": path, "ok": True, "total": total,
                   "mtime": mtime}, stdout)
        except Exception as e:  # 파일 하나의 실패로 워커를 죽이지 않는다
            _emit({"event": "file", "path": path, "ok": False,
                   "message": f"{type(e).__name__}: {e}"}, stdout)
