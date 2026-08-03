import pathlib

import pytest

from psd_engine.session import SessionStore


def test_open_get_close(fixture_psd):
    store = SessionStore()
    sid = store.open(fixture_psd)
    s = store.get(sid)
    assert s["path"] == str(fixture_psd)
    assert s["nodes_by_id"][5]["name"] == "lines"
    store.close(sid)
    with pytest.raises(KeyError):
        store.get(sid)


def test_lru_evicts_oldest(fixture_psd, tmp_path):
    import shutil
    p2 = tmp_path / "b.psd"; shutil.copy(fixture_psd, p2)
    p3 = tmp_path / "c.psd"; shutil.copy(fixture_psd, p3)

    store = SessionStore(max_sessions=2)
    s1 = store.open(fixture_psd)
    s2 = store.open(p2)
    store.get(s1)               # s1을 최근 사용으로
    s3 = store.open(p3)         # s2가 밀려남
    store.get(s1)
    store.get(s3)
    with pytest.raises(KeyError):
        store.get(s2)


def test_rejects_non_rgb8(tmp_path):
    store = SessionStore()
    bad = tmp_path / "bad.psd"
    bad.write_bytes(b"not a psd")
    with pytest.raises(Exception):   # psd-tools 파싱 에러가 그대로 전파되어야 함
        store.open(bad)


# 배경 작업이 파일을 차례로 여는 동안 화면이 보고 있는 세션이 밀려나면, 썸네일과
# 미리보기가 매번 PSD를 다시 읽어야 하고 서로의 재오픈이 상대를 걷어차다 결국
# 'unknown or evicted session'으로 실패한다. 그래서 한 칸을 화면 몫으로 못박는다.
def test_pinned_file_survives_while_others_rotate(fixture_psd, tmp_path):
    others = []
    for i in range(5):
        p = tmp_path / f"other{i}.psd"
        p.write_bytes(pathlib.Path(fixture_psd).read_bytes())
        others.append(p)

    store = SessionStore(max_sessions=2)
    viewing = store.open(fixture_psd)
    store.pin(str(fixture_psd))

    for p in others:          # 배경 작업이 다른 파일들을 차례로 연다
        store.open(p)

    assert store.get(viewing) is not None


# 이것이 세션 id로 고정했을 때 실패했던 경우다. 축출 복구가 새 세션을 만드는
# 순간부터 그 새 id를 다시 고정할 때까지가 무방비였고, 그 사이 배경 작업이 두 번만
# 열면 방금 되살린 세션이 또 사라졌다. 경로로 걸면 다시 고정할 필요 자체가 없다.
def test_a_reopened_pinned_file_stays_protected_without_re_pinning(fixture_psd, tmp_path):
    other = tmp_path / "other.psd"
    other.write_bytes(pathlib.Path(fixture_psd).read_bytes())

    store = SessionStore(max_sessions=2)
    store.pin(str(fixture_psd))
    store.open(other)
    reopened = store.open(fixture_psd)   # 축출 복구가 만드는 새 세션

    for _ in range(4):
        store.open(other)

    assert store.get(reopened) is not None


def test_pinning_does_not_raise_the_memory_ceiling(fixture_psd):
    # 세션 하나가 파일 크기만큼(700MB급) 메모리를 쓰므로 총량이 늘면 안 된다.
    store = SessionStore(max_sessions=2)
    store.pin(str(fixture_psd))
    for _ in range(5):
        store.open(fixture_psd)

    assert len(store._sessions) == 2


def test_only_the_newest_session_of_the_pinned_file_is_kept(fixture_psd):
    # 같은 파일이 두 번 열려 있을 때 둘 다 지키면 버릴 것이 없어 상한이 무너진다.
    store = SessionStore(max_sessions=2)
    store.pin(str(fixture_psd))
    old = store.open(fixture_psd)
    store.open(fixture_psd)
    store.open(fixture_psd)

    assert len(store._sessions) == 2
    with pytest.raises(KeyError):
        store.get(old)


def test_an_unpinned_store_evicts_exactly_as_before(fixture_psd):
    store = SessionStore(max_sessions=2)
    first = store.open(fixture_psd)
    store.open(fixture_psd)
    store.open(fixture_psd)

    with pytest.raises(KeyError):
        store.get(first)


def test_pinning_a_path_that_is_never_opened_changes_nothing(fixture_psd):
    store = SessionStore(max_sessions=2)
    store.pin("/nowhere/none.psd")
    first = store.open(fixture_psd)
    store.open(fixture_psd)
    store.open(fixture_psd)

    with pytest.raises(KeyError):
        store.get(first)
