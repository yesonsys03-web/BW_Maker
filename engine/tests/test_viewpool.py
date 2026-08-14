"""판 하나의 뷰를 작업 프로세스로 나눠 굽는 경로.

여기서 재는 것은 두 가지다: **몇 개로 나눌지 정하는 규칙**과, **나눠 구운 결과가
부모가 순차로 구운 것과 같은가**. 뒤쪽은 진짜 자식 프로세스를 띄운다 — 이 기능의
값어치가 프로세스 경계를 넘는 데 있으므로, 흉내로 재면 아무것도 안 지킨다.
"""
import io
import json

import numpy as np
import pytest
from pytoshop.user import nested_layers

from conftest import make_rgb_image, write_psd
from psd_engine import rpc, tilecache, viewpool

GB = 1 << 30


def _two_view_psd(tmp_path):
    """FRONT/BACK 각각 색 경계가 있는 뷰 하나씩 (test_rpc.py의 것과 같은 모양)."""
    def side(name, dark, base):
        return nested_layers.Group(name=name, layers=[
            make_rgb_image("LINES", (0, 0, 0), 0, 0, 4, 24),
            nested_layers.Group(name="COLORS", layers=[
                make_rgb_image("dark", dark, 0, 0, 16, 12),
                make_rgb_image("base", base, 0, 0, 32, 24),
            ]),
        ])
    p = tmp_path / "two_views.psd"
    write_psd(p, [side("FRONT", (40, 20, 20), (200, 30, 60)),
                  side("BACK", (10, 60, 90), (250, 250, 20))])
    return p


# ── 몇 개로 나눌지 ────────────────────────────────────────────────────────

def test_a_single_view_is_never_split(monkeypatch):
    # 판 안의 병렬화 단위는 뷰다. 뷰 하나는 못 쪼갠다 — 파일 병렬화가 판 한 장을
    # 못 쪼개는 것과 같은 이유이고, 거기서는 워커 4개가 오히려 2% 느렸다.
    monkeypatch.delenv(viewpool.WORKERS_ENV, raising=False)
    assert viewpool.worker_count(1, available=512 * GB) == 1


def test_the_worker_count_is_bounded_by_the_memory_left(monkeypatch):
    # 자식마다 판을 한 벌씩 연다. 실측에서 가장 무거운 판의 자식 하나가 4.65 GB였고
    # 넷이면 18.6 GB다 — 32GB 기계에서 앱까지 돌면 이 값을 안 보고 나누면 안 된다.
    monkeypatch.delenv(viewpool.WORKERS_ENV, raising=False)
    per, reserve = viewpool.PER_WORKER_BYTES, viewpool.RESERVE_BYTES
    assert viewpool.worker_count(8, available=reserve + per - 1) == 1
    assert viewpool.worker_count(8, available=reserve + per) == 1
    assert viewpool.worker_count(8, available=reserve + 2 * per) == 2
    assert viewpool.worker_count(8, available=reserve + 3 * per) == 3
    assert viewpool.worker_count(8, available=reserve + 100 * per) == \
        viewpool.MAX_WORKERS


def test_the_worker_count_never_exceeds_the_number_of_views(monkeypatch):
    monkeypatch.delenv(viewpool.WORKERS_ENV, raising=False)
    assert viewpool.worker_count(
        2, available=viewpool.RESERVE_BYTES + 100 * viewpool.PER_WORKER_BYTES) == 2


def test_unreadable_memory_means_do_not_split(monkeypatch):
    # 모르면서 네 벌 여는 것보다 순차가 낫다. available_bytes가 None을 주는 경우
    # (vm_stat이 없는 환경)를 그대로 흉내낸다.
    monkeypatch.delenv(viewpool.WORKERS_ENV, raising=False)
    monkeypatch.setattr(viewpool, "available_bytes", lambda: None)
    assert viewpool.worker_count(8) == 1


def test_the_environment_knob_wins_over_the_memory_rule(monkeypatch):
    # 테스트가 순차 경로를 재려면 자기가 원하는 값을 말할 수 있어야 한다.
    monkeypatch.setenv(viewpool.WORKERS_ENV, "1")
    assert viewpool.worker_count(8, available=512 * GB) == 1
    monkeypatch.setenv(viewpool.WORKERS_ENV, "3")
    assert viewpool.worker_count(8, available=0) == 3
    monkeypatch.setenv(viewpool.WORKERS_ENV, "쓰레기")
    assert viewpool.worker_count(8, available=512 * GB) == 1


def test_available_bytes_reads_something_plausible():
    # 이 기계에서 실제로 읽히는지 본다. 못 읽으면 None이어야 하고(그때는 안 나눈다),
    # 읽히면 0보다 크고 물리 메모리보다 작아야 한다 — 단위를 틀리면 여기서 걸린다.
    got = viewpool.available_bytes()
    if got is None:
        pytest.skip("이 환경에서는 가용 메모리를 못 읽는다")
    assert 0 < got < 4096 * GB


# ── 나눠 구운 결과가 같은가 ───────────────────────────────────────────────

def _overlay_arrays(session, views, opts):
    """뷰마다 디스크 캐시에 있는 오버레이 rgba를 꺼낸다."""
    skey = rpc._edge_settings_key(opts)
    out = []
    for v in views:
        key = tilecache.overlay_key(v["colourIds"], v["lineIds"], skey)
        got = tilecache.load_overlays(session, key)
        out.append(None if got is None else [p["rgba"] for p in got])
    return out


def test_views_baked_by_child_processes_match_what_the_parent_would_bake(
        tmp_path, monkeypatch):
    # 이 기능이 옳은 유일한 근거다 — 자식이 구운 픽셀이 부모가 구웠을 픽셀과
    # 같아야 한다. 키는 뷰 구성과 픽셀 설정이라 부모가 계산했을 때와 비트까지
    # 같아야 하고(그래서 자식도 같은 plan_overlays를 부른다), 그 약속이 깨지면
    # 화면에 다른 그림이 나온다.
    from psd_engine.character import find_views
    from psd_engine.edges import EDGE_DEFAULTS
    from psd_engine.session import SessionStore

    p = _two_view_psd(tmp_path)
    opts = {**EDGE_DEFAULTS}

    # 부모가 순차로 구운 것
    monkeypatch.setenv(viewpool.WORKERS_ENV, "1")
    store = SessionStore()
    s = store.get(store.open(str(p)))
    views = find_views(s)
    assert len(views) >= 2, "픽스처에 뷰가 둘 미만 — 나눌 것이 없어 무의미하다"
    rpc._cached_plan_overlays(s, views, opts)
    want = _overlay_arrays(s, views, opts)
    assert all(w is not None for w in want), "부모가 캐시를 안 남겼다"

    # 같은 판을 자식들이 구운 것 (캐시를 비우고 다시)
    monkeypatch.setenv("PSD_ENGINE_TILE_CACHE_DIR", str(tmp_path / "cache2"))
    monkeypatch.setenv(viewpool.WORKERS_ENV, "2")
    store2 = SessionStore()
    s2 = store2.get(store2.open(str(p)))
    n = viewpool.fill_overlay_cache(s2, views, opts, rpc._edge_settings_key(opts))
    assert n == 2, f"자식을 {n}개 띄웠다 — 나누지 않았다면 이 테스트는 공허하다"
    got = _overlay_arrays(s2, views, opts)

    assert all(g is not None for g in got), "자식이 캐시를 안 남겼다"
    for i, (a, b) in enumerate(zip(want, got)):
        assert len(a) == len(b), f"뷰 {i}의 오버레이 개수가 다르다"
        for j, (x, y) in enumerate(zip(a, b)):
            assert np.array_equal(x, y), f"뷰 {i}의 오버레이 {j}가 픽셀이 다르다"


def test_a_child_that_dies_leaves_the_answer_to_the_parent(tmp_path, monkeypatch):
    # 자식이 죽어도 결과가 바뀌면 안 된다. 자식이 남기는 것은 캐시뿐이므로,
    # 빈 자리는 그냥 미스가 되고 부모가 순차로 굽는다.
    from psd_engine.character import find_views
    from psd_engine.edges import EDGE_DEFAULTS
    from psd_engine.session import SessionStore

    p = _two_view_psd(tmp_path)
    opts = {**EDGE_DEFAULTS}
    monkeypatch.setattr(viewpool, "_child_command",
                        lambda: ["/nonexistent/view-worker-binary"])
    monkeypatch.setenv(viewpool.WORKERS_ENV, "2")

    store = SessionStore()
    s = store.get(store.open(str(p)))
    views = find_views(s)
    plans = rpc._cached_plan_overlays(s, views, opts)
    assert plans, "자식이 못 떴다고 오버레이가 통째로 사라졌다"


def test_the_pool_stays_out_when_the_disk_cache_is_off(tmp_path, monkeypatch):
    # 자식이 결과를 돌려주는 통로가 디스크 캐시다. 꺼져 있으면 나눠 봐야 아무것도
    # 못 받으므로, 띄우면 안 된다(띄우면 그만큼 통째로 낭비다).
    from psd_engine.edges import EDGE_DEFAULTS

    monkeypatch.setattr(tilecache, "ENABLED", False)
    monkeypatch.setenv(viewpool.WORKERS_ENV, "4")
    spawned = []
    monkeypatch.setattr(viewpool, "_child_command",
                        lambda: spawned.append(1) or ["/bin/true"])
    session = {"path": str(tmp_path / "x.psd"), "mtime": 1.0}
    n = viewpool.fill_overlay_cache(
        session, [{"colourIds": [1], "lineIds": [2]},
                  {"colourIds": [3], "lineIds": [4]}], EDGE_DEFAULTS, ("k",))
    assert n == 1 and not spawned, "캐시가 꺼져 있는데 자식을 띄웠다"


def test_the_view_worker_flag_is_dispatched_by_the_shared_entry_point():
    # v0.2.7 사고: `--warm-worker` 분기가 __main__.py에만 있고 동결 진입점은
    # rpc.main()으로 직행이라, 빌드 앱의 워커가 플래그를 무시당한 채 일반 엔진으로
    # 떴다. 새 플래그도 같은 함수를 타야 한다 — entry.main 하나가 유일한 갈림길이다.
    import psd_engine.entry as entry

    called = []

    def fake_child_main(stdin=None):
        called.append(True)
        return 0

    import psd_engine.viewpool as vp
    real = vp.child_main
    vp.child_main = fake_child_main
    try:
        with pytest.raises(SystemExit):
            entry.main(["engine", "--view-worker"])
    finally:
        vp.child_main = real
    assert called == [True], "entry.main이 --view-worker를 자식으로 안 보냈다"


def test_the_child_bakes_only_the_views_it_was_given(tmp_path, monkeypatch):
    # 자식은 자기 몫만 구워야 한다 — 전부 구우면 N개가 같은 일을 N번 한다.
    from psd_engine.character import find_views
    from psd_engine.edges import EDGE_DEFAULTS
    from psd_engine.session import SessionStore

    p = _two_view_psd(tmp_path)
    opts = {**EDGE_DEFAULTS}
    store = SessionStore()
    s = store.get(store.open(str(p)))
    views = find_views(s)
    skey = rpc._edge_settings_key(opts)

    job = json.dumps({"path": str(p), "opts": opts, "settingsKey": list(skey),
                      "views": [{"colourIds": list(views[0]["colourIds"]),
                                 "lineIds": list(views[0]["lineIds"])}]})
    viewpool.child_main(stdin=io.StringIO(job))

    got = _overlay_arrays(s, views, opts)
    assert got[0] is not None, "자기 몫을 안 구웠다"
    assert got[1] is None, "받지도 않은 뷰를 구웠다"


def test_every_view_goes_to_exactly_one_child():
    # 자식들이 같은 뷰를 겹쳐 구우면 결과는 맞고 시간만 통째로 낭비된다 —
    # 둘이 전부 구우면 2.7배가 1배가 된다. 결과 비교로는 절대 안 잡히는 실수라
    # 나눔 자체를 못박는다.
    views = [{"colourIds": [i], "lineIds": [100 + i]} for i in range(7)]
    for n in (2, 3, 4, 7):
        got = viewpool.shares(views, n)
        assert len(got) == n
        flat = [v for share in got for v in share]
        assert len(flat) == len(views), f"n={n}에서 뷰가 겹치거나 빠졌다"
        assert {id(v) for v in flat} == {id(v) for v in views}
        assert max(len(s) for s in got) - min(len(s) for s in got) <= 1, \
            f"n={n}에서 한쪽으로 쏠렸다: {[len(s) for s in got]}"


def test_more_children_than_views_leaves_no_child_empty_handed():
    # 뷰보다 자식이 많으면 빈손인 자식이 생긴다. 띄우지 말아야 한다 —
    # worker_count가 뷰 수로 상한을 두는 이유가 그것이고, 여기서 그것을 확인한다.
    views = [{"colourIds": [0], "lineIds": [1]}, {"colourIds": [2], "lineIds": [3]}]
    assert all(viewpool.shares(views, 2))
