"""타일 디스크 캐시 — 세션 밖에서 디코드 비용을 기억하는지.

여기 세션 헬퍼는 test_render._session과 달리 path/mtime을 넣는다 — 실제
SessionStore.open이 만드는 세션이 그렇고, 디스크 캐시 키가 거기서 나온다.
"""
import os

import numpy as np
import pytest
from PIL import Image
from psd_tools import PSDImage

import psd_engine.render as render_mod
import psd_engine.tilecache as tilecache
from psd_engine.render import render_preview, warm_preview_tiles
from psd_engine.tree import build_tree


@pytest.fixture(autouse=True)
def cache_dir(tmp_path, monkeypatch):
    d = tmp_path / "tilecache"
    monkeypatch.setenv("PSD_ENGINE_TILE_CACHE_DIR", str(d))
    return d


def _session(path):
    psd = PSDImage.open(path)
    built = build_tree(psd)
    return {"psd": psd, "path": str(path), "mtime": os.path.getmtime(path),
            "layers_by_id": built["layers_by_id"]}


def test_preview_survives_a_fresh_session_via_disk(fixture_psd, tmp_path, monkeypatch):
    # 세션이 밀려나면 RAM 타일도 같이 죽는 것이 이 캐시가 푸는 문제다. 새 세션이
    # 디코드 없이(extract_rgba가 터지게 해 둔다) 디스크만으로 같은 그림을 내야 한다.
    s1 = _session(fixture_psd)
    first = np.array(Image.open(render_preview(s1, [2, 5], max_size=256, out_dir=tmp_path)))

    s2 = _session(fixture_psd)

    def boom(layer):
        raise AssertionError("디스크 캐시가 있으면 디코드하면 안 된다")

    monkeypatch.setattr(render_mod, "extract_rgba", boom)
    second = np.array(Image.open(render_preview(s2, [2, 5], max_size=256, out_dir=tmp_path)))
    assert np.array_equal(first, second)


def test_disk_key_includes_mtime(fixture_psd):
    # 포토샵 재저장(같은 경로, 다른 mtime)이면 옛 타일을 읽으면 안 된다.
    s = _session(fixture_psd)
    scale = render_mod.preview_scale(s["psd"], 256)
    render_preview(s, [5], max_size=256, out_dir=fixture_psd.parent)
    assert tilecache.has(s, 5, scale)
    stale = dict(s, mtime=s["mtime"] + 1.0)
    assert not tilecache.has(stale, 5, scale)
    assert tilecache.load(stale, 5, scale) is None


def test_store_purges_old_mtime_of_same_path(fixture_psd, cache_dir):
    # 재저장 한 번마다 폴더가 한 벌씩 늘면 상한이 무의미하다 — 새 판을 처음 쓸 때
    # 같은 경로의 옛 판을 지운다.
    s = _session(fixture_psd)
    scale = render_mod.preview_scale(s["psd"], 256)
    render_preview(s, [5], max_size=256, out_dir=fixture_psd.parent)
    old_dir = tilecache._file_dir(s["path"], s["mtime"])
    assert old_dir.is_dir()

    # dict(s, ...)는 RAM 타일 캐시(preview_tiles)까지 물려받는다 — 떼어내지
    # 않으면 RAM 히트로 끝나 디스크 경로가 아예 안 돈다.
    newer = dict(s, mtime=s["mtime"] + 7.0)
    newer.pop("preview_tiles", None)
    render_mod._preview_tile(newer, 5, scale)
    assert tilecache._file_dir(newer["path"], newer["mtime"]).is_dir()
    assert not old_dir.is_dir()


def test_prune_evicts_least_recently_used_over_cap(fixture_psd, cache_dir, monkeypatch):
    # 상한을 넘으면 오래 안 쓴 파일 디렉터리부터 버린다. 방금 쓴 판은 지킨다.
    monkeypatch.setattr(tilecache, "CACHE_BYTES", 1)
    s = _session(fixture_psd)
    scale = render_mod.preview_scale(s["psd"], 256)
    render_preview(s, [5], max_size=256, out_dir=fixture_psd.parent)
    first_dir = tilecache._file_dir(s["path"], s["mtime"])
    os.utime(first_dir, (1, 1))  # 오래전에 쓴 폴더로 만든다

    other = dict(s, path=str(fixture_psd) + ".copy.psd")
    other.pop("preview_tiles", None)  # RAM 히트로 새면 디스크 경로가 안 돈다
    render_mod._preview_tile(other, 5, scale)
    assert tilecache._file_dir(other["path"], other["mtime"]).is_dir()
    assert not first_dir.is_dir()


def test_disabled_by_env_writes_and_reads_nothing(fixture_psd, cache_dir, monkeypatch):
    monkeypatch.setattr(tilecache, "ENABLED", False)
    s = _session(fixture_psd)
    scale = render_mod.preview_scale(s["psd"], 256)
    render_preview(s, [2, 5], max_size=256, out_dir=fixture_psd.parent)
    assert not cache_dir.exists()
    assert not tilecache.has(s, 5, scale)
    assert tilecache.load(s, 5, scale) is None


def test_session_without_path_is_a_noop(fixture_psd, cache_dir):
    # test_render._session처럼 path/mtime 없는 세션(테스트·계측)은 캐시 없이 돈다.
    psd = PSDImage.open(fixture_psd)
    built = build_tree(psd)
    s = {"psd": psd, "layers_by_id": built["layers_by_id"]}
    render_preview(s, [2, 5], max_size=256, out_dir=fixture_psd.parent)
    assert not cache_dir.exists()


def test_corrupt_tile_degrades_to_miss_and_is_deleted(fixture_psd):
    s = _session(fixture_psd)
    scale = render_mod.preview_scale(s["psd"], 256)
    render_preview(s, [5], max_size=256, out_dir=fixture_psd.parent)
    f = tilecache._tile_path(s["path"], s["mtime"], 5, scale)
    f.write_bytes(b"not a png")
    assert tilecache.load(s, 5, scale) is None
    assert not f.exists()


def test_roundtrip_preserves_negative_origin(fixture_psd):
    # 캔버스 밖(음수 좌표)에 걸친 레이어의 원점도 그대로 돌아와야 한다 — x0/y0는
    # PNG tEXt에 실려 갔다 온다.
    s = _session(fixture_psd)
    img = Image.new("RGBA", (3, 2), (10, 20, 30, 40))
    tilecache.store(s, 42, 0.25, (img, -7, -3))
    got = tilecache.load(s, 42, 0.25)
    assert got is not None
    loaded, x0, y0 = got
    assert (x0, y0) == (-7, -3)
    assert np.array_equal(np.asarray(loaded), np.asarray(img))


def test_warm_treats_disk_hits_as_free(fixture_psd, monkeypatch):
    # WARM_MAX_PREDICTED_S 스킵은 디코드가 오래 걸릴 잎을 시작조차 안 하는
    # 장치다. 디스크에 이미 있는 잎은 디코드가 없으므로 스킵 대상이 아니다 —
    # 이게 없으면 "한 번은 치르고 영원히 기억"이 큰 잎에서 영영 안 통한다.
    monkeypatch.setattr(render_mod, "WARM_MAX_PREDICTED_S", 0.0)
    cold = _session(fixture_psd)
    res = warm_preview_tiles(cold, [2, 4, 5], max_size=256, budget_s=10.0)
    assert res["warmed"] == [] and sorted(res["skipped"]) == [2, 4, 5]

    hot = _session(fixture_psd)
    render_preview(hot, [2, 4, 5], max_size=256, out_dir=fixture_psd.parent)

    fresh = _session(fixture_psd)
    res = warm_preview_tiles(fresh, [2, 4, 5], max_size=256, budget_s=10.0)
    assert sorted(res["warmed"]) == [2, 4, 5] and res["skipped"] == []
