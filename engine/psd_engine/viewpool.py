"""판 하나의 뷰를 여러 작업 프로세스로 나눠 굽는다.

## 왜 프로세스인가 — 스레드는 재고 버렸다

납품 판으로 실측했다(2026-08-14). 뷰를 스레드로 나누면 **1.09배**이고 4개가 2개보다
낫지도 않다. 이유는 계측이 그대로 말한다: 중복 디코드 제거와 그리기 범위 좁히기를
얹은 뒤 남은 시간의 **87%가 psd-tools의 레이어 디코드**이고, 그 디코드는 파이썬으로
도는 대목이라 GIL을 놓지 않는다. 같은 판을 프로세스로 나누면 2.5~2.7배가 나온다.

    판 44(뷰 19개)  스레드4 1.09배 / 프로세스2 1.68배 / 프로세스4 2.71배
    판 20(뷰 10개)  프로세스2 1.92배 / 프로세스4 2.50배

**디코드를 더 줄일 여지는 없다.** 같은 계측에서 색 드로잉 레이어 98장이 각각 정확히
한 번씩만 읽혔다(중복 0). 남은 것은 나누는 일뿐이다.

## 값은 메모리다

자식마다 판을 한 벌씩 연다. 가장 무거운 판에서 자식 하나가 최대 4.65 GB를 썼고
넷이면 18.6 GB다(자식별 최대의 합이라 동시 최대는 이보다 작다). 그래서 개수를
**그때 남아 있는 메모리로** 정한다. 이 방식은 폴더 준비가 도는 중에도 저절로 맞는다 —
그때는 파일 작업 프로세스들이 이미 메모리를 쓰고 있어 가용량이 낮고, 여기서 고르는
개수가 자연히 1로 떨어진다. 따로 신호를 주고받을 필요가 없다.

## 결과는 어떻게 돌아오나

새 프로토콜을 만들지 않는다. 자식은 이미 있는 **디스크 타일 캐시**에 굽고, 부모는
평소처럼 거기서 읽는다(`tilecache.store_overlays`/`load_overlays`). 키는 뷰 구성과
픽셀 설정이라 부모가 계산했을 때와 비트까지 같다. 캐시가 꺼져 있으면(`PSD_ENGINE_
TILE_CACHE=0`) 돌려줄 통로가 없으므로 나누지 않고 부모가 순차로 굽는다.
"""
import json
import os
import re
import subprocess
import sys

from . import tilecache

#: 한 판을 나눌 최대 작업 프로세스 수. 실측 천장이 3.24배인데 4개에서 2.5~2.7배로
#: 이미 그 86%에 닿는다 — 더 늘려도 얻는 것보다 메모리로 잃는 것이 크다.
MAX_WORKERS = 4

#: 자식 하나가 쓸 것으로 보는 메모리. 실측에서 가장 무거운 판의 자식 하나가
#: 4.65 GB였다. 넉넉히 잡아도 손해는 "덜 나눈다"뿐이다.
PER_WORKER_BYTES = 5 << 30

#: 앱·OS·파일 작업 프로세스에게 남겨 두는 몫. 이만큼을 뺀 나머지로만 나눈다.
RESERVE_BYTES = 8 << 30


def available_bytes():
    """지금 쓸 수 있는 물리 메모리(바이트). 못 읽으면 None.

    macOS에는 SC_AVPHYS_PAGES가 없어 `vm_stat`을 읽는다. free만 세면 실제보다 훨씬
    작게 나온다 — inactive/purgeable은 필요하면 즉시 회수되는 몫이라 함께 센다.
    """
    try:
        out = subprocess.run(["vm_stat"], capture_output=True, text=True,
                             timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.search(r"page size of (\d+)", out)
    if not m:
        return None
    page = int(m.group(1))
    total = 0
    for name in ("Pages free", "Pages inactive", "Pages purgeable"):
        hit = re.search(rf"^{name}:\s+(\d+)", out, re.M)
        if hit:
            total += int(hit.group(1))
    return total * page if total else None


#: 개수를 손으로 못박는 손잡이. 자동(메모리 기준)이 기본이고, `1`이면 안 나눈다.
#: 테스트가 순차 경로를 재려면 이걸로 **자기가 원하는 값을 말한다** — 아무도 안 적어둔
#: 기본값에 얹혀 있다가 기본이 바뀌자 무더기로 빨개졌던 일이 이 저장소에 이미 있다
#: (기본 작업 프로세스 1→2 착지 보고).
WORKERS_ENV = "PSD_ENGINE_VIEW_WORKERS"


def worker_count(n_views, available=None):
    """이 판을 몇 개로 나눌지. 1이면 나누지 않는다는 뜻이다.

    뷰가 하나뿐이면 나눌 것이 없다 — 판 안의 병렬화는 뷰 단위이고 뷰 하나는 못 쪼갠다.
    메모리를 못 읽으면 나누지 않는다: 모르면서 4벌 여는 것보다 느린 쪽이 낫다.
    """
    if n_views < 2:
        return 1
    forced = os.environ.get(WORKERS_ENV, "").strip()
    if forced:
        try:
            return max(1, min(int(forced), n_views))
        except ValueError:
            return 1
    if available is None:
        available = available_bytes()
    if available is None:
        return 1
    room = available - RESERVE_BYTES
    if room < PER_WORKER_BYTES:
        return 1
    return max(1, min(MAX_WORKERS, n_views, room // PER_WORKER_BYTES))


def shares(views, n):
    """뷰를 자식 n명에게 **겹치지 않게** 나눈다.

    겹치면 그만큼 통째로 낭비다 — 둘이 같은 뷰를 구우면 2.7배가 1배가 된다.
    돌아가며 주는 것(`views[i::n]`)은 무거운 뷰가 몰려 있을 때 한쪽으로 쏠리지
    않게 하는 값싼 방법이다. 뷰별 예상 비용을 모르므로 그보다 잘할 근거가 없다.
    """
    return [views[i::n] for i in range(n)]


def _child_command():
    """자식을 띄우는 명령. 개발과 동결본이 같은 분기(entry.main)를 타야 한다."""
    if getattr(sys, "frozen", False):
        return [sys.executable, "--view-worker"]
    return [sys.executable, "-m", "psd_engine", "--view-worker"]


def fill_overlay_cache(session, views, opts, settings_key, count=None):
    """`views`의 오버레이를 자식들에게 나눠 굽게 하고, 디스크 캐시에 채운다.

    돌려주는 값은 실제로 띄운 자식 수다(1이면 나누지 않았다는 뜻). 부모는 이 뒤에
    평소대로 캐시에서 읽으면 되고, 자식이 실패해 빈 자리가 남아도 그 뷰는 그냥
    캐시 미스라 부모가 순차로 굽는다 — 실패가 결과를 바꾸지 않는다.
    """
    if not tilecache.ENABLED or not views:
        return 1
    path, mtime = session.get("path"), session.get("mtime")
    if not path or mtime is None:
        return 1
    n = worker_count(len(views), None) if count is None else count
    if n < 2:
        return 1

    procs = []
    for share in shares(views, n):
        if not share:
            continue
        job = json.dumps({"path": str(path), "opts": opts,
                          "settingsKey": list(settings_key),
                          "views": [{"colourIds": list(v["colourIds"]),
                                     "lineIds": list(v["lineIds"])}
                                    for v in share]})
        try:
            # 자식에게는 1을 물려준다. 자식은 `plan_overlays`를 직접 부르므로 지금
            # 구조에서 손자가 생길 길이 없지만, 그 사실이 이 파일 밖에 있다 —
            # 나중에 자식이 `_cached_plan_overlays`를 타게 되면 그때는 프로세스가
            # 기하급수로 늘어난다. 한 줄로 그 문을 닫아 둔다.
            p = subprocess.Popen(_child_command(), stdin=subprocess.PIPE,
                                 stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL,
                                 env={**os.environ, WORKERS_ENV: "1"})
        except OSError:
            break                      # 못 띄우면 부모가 순차로 굽는다
        try:
            p.stdin.write(job.encode("utf-8"))
            p.stdin.close()
        except OSError:
            p.kill()
            continue
        procs.append(p)
    failed = 0
    for p in procs:
        try:
            failed += bool(p.wait())
        except KeyboardInterrupt:      # pragma: no cover - 부모가 죽는 경우
            p.kill()
            raise
    if failed:
        # 결과는 안 바뀐다(부모가 그 뷰를 순차로 굽는다). 바뀌는 것은 속도뿐이고,
        # 그래서 아무도 모르게 지나간다 — 남겨야 진단할 수 있다.
        print(json.dumps({"event": "warn", "what": "view_worker_failed",
                          "failed": failed, "of": len(procs)}),
              file=sys.stderr, flush=True)
    return len(procs) or 1


def child_main(stdin=None):
    """`--view-worker`로 뜬 자식. 받은 뷰만 구워 디스크 캐시에 넣고 끝난다."""
    from psd_tools import PSDImage
    from psd_tools.constants import ColorMode

    from .edges import EDGE_DEFAULTS, plan_overlays
    from .tree import build_tree

    # stdin을 **UTF-8로 못박아** 읽는다. 부모는 잡을 UTF-8 바이트로 써 보내는데
    # 파이썬은 stdin을 로케일 인코딩으로 읽으므로, 한글 윈도우(cp949)에서는
    # 한글 경로가 깨져 `PSDImage.open`이 FileNotFoundError로 죽는다. 실제로 났다 —
    # 0.3.2 빌드의 윈도우 러너에서 이 자식이 그렇게 죽었고, 자식이 죽어도 부모가
    # 대신 구우므로 **그림은 멀쩡한 채 속도만 조용히 사라졌다.**
    # 메인 엔진(rpc.main)과 전체 캐시 워커(warmworker.main)가 쓰는 것과 같은 장치다.
    if stdin is None:
        from .rpc import _as_utf8

        stdin = _as_utf8(sys.stdin)
    raw = stdin.read()
    if not raw.strip():
        return 0
    job = json.loads(raw)
    path = job["path"]
    psd = PSDImage.open(path)
    if psd.color_mode != ColorMode.RGB:
        raise ValueError(f"unsupported color mode: {psd.color_mode!r} (RGB only)")
    built = build_tree(psd)
    session = {"psd": psd, "path": str(path), "mtime": os.path.getmtime(path),
               "tree": built["tree"], "layers_by_id": built["layers_by_id"]}
    opts = {**EDGE_DEFAULTS, **(job.get("opts") or {})}
    skey = tuple(job["settingsKey"])
    for view in job["views"]:
        vkey = tilecache.overlay_key(view["colourIds"], view["lineIds"], skey)
        if tilecache.load_overlays(session, vkey) is not None:
            continue
        made = plan_overlays(session, [view], opts)
        tilecache.store_overlays(session, vkey, made)
    return 0
