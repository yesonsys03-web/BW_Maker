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
