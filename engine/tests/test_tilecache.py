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


def test_overlay_roundtrip_preserves_pixels_and_metadata(fixture_psd):
    # 오버레이는 뷰당 RGBA 한 장 + 배치 정보다. npz 한 파일로 갔다 와야 한다.
    s = _session(fixture_psd)
    arr = np.arange(2 * 3 * 4, dtype=np.uint8).reshape(2, 3, 4)
    key = tilecache.overlay_key([2], [5], (24, 4, 0, 8, 64, "composite", "region"))
    tilecache.store_overlays(s, key, [{"lineIds": [5], "left": -3, "top": 7, "rgba": arr}])
    got = tilecache.load_overlays(s, key)
    assert got is not None and len(got) == 1
    assert got[0]["lineIds"] == [5] and got[0]["left"] == -3 and got[0]["top"] == 7
    assert np.array_equal(got[0]["rgba"], arr)


def test_overlay_remembers_an_empty_result(fixture_psd):
    # "이 뷰는 그릴 것 없음"도 계산 한 번의 결론이다 — None(미스)과 구분해
    # 기억해야 세션마다 같은 헛계산을 반복하지 않는다.
    s = _session(fixture_psd)
    key = tilecache.overlay_key([2], [5], (24, 4, 0, 8, 64, "composite", "region"))
    assert tilecache.load_overlays(s, key) is None
    tilecache.store_overlays(s, key, [])
    assert tilecache.load_overlays(s, key) == []


def test_overlay_key_varies_with_settings_and_format(monkeypatch):
    base = tilecache.overlay_key([1], [2], (24, 4, 0))
    assert tilecache.overlay_key([1], [2], (24, 4, 5)) != base  # 설정이 다르면
    assert tilecache.overlay_key([1], [3], (24, 4, 0)) != base  # 뷰가 다르면
    # 알고리즘 판이 바뀌면 같은 설정이라도 옛 그림을 쓰면 안 된다. 지금 판이
    # 몇이든 성립해야 하므로 +1로 민다 — 상수를 하드코딩하면 실제 판이 그 값에
    # 도달하는 순간 no-op이 된다(OVERLAY_FORMAT 2 범프에서 실제로 그랬다).
    monkeypatch.setattr(tilecache, "OVERLAY_FORMAT", tilecache.OVERLAY_FORMAT + 1)
    assert tilecache.overlay_key([1], [2], (24, 4, 0)) != base


# ---- 미리보기 PNG 캐시 ----

def _png(tmp_path, name, value=90):
    p = tmp_path / name
    Image.new("RGBA", (8, 6), (value, value, value, 255)).save(p)
    return p


def test_preview_roundtrip_copies_the_same_bytes(fixture_psd, tmp_path):
    s = _session(fixture_psd)
    src = _png(tmp_path, "src.png")
    key = tilecache.preview_key([256, [1, 2], None, None, "off"])
    tilecache.store_preview(s, key, src)
    dest = tmp_path / "out" ; dest.mkdir()
    got = tilecache.load_preview(s, key, str(dest / "preview.png"))
    assert got == str(dest / "preview.png")
    assert (dest / "preview.png").read_bytes() == src.read_bytes()


def test_preview_miss_and_corruption_degrade_to_none(fixture_psd, tmp_path, cache_dir):
    s = _session(fixture_psd)
    key = tilecache.preview_key([256, [1], None, None, "off"])
    assert tilecache.load_preview(s, key, str(tmp_path / "a.png")) is None
    # 손상 파일은 지우고 미스로 강등한다 — 화면에 깨진 그림을 올리지 않는다.
    tilecache.store_preview(s, key, _png(tmp_path, "ok.png"))
    broken = next(cache_dir.rglob("p*.png"))
    broken.write_bytes(b"not a png")
    assert tilecache.load_preview(s, key, str(tmp_path / "b.png")) is None
    assert not broken.exists()


def test_preview_key_changes_with_any_input(fixture_psd):
    base = [256, [1, 2], "#000000", [1], "off"]
    variants = [
        [512, [1, 2], "#000000", [1], "off"],          # 배율
        [256, [2, 1], "#000000", [1], "off"],          # 합성 순서
        [256, [1, 2], None, [1], "off"],               # 색 통일
        [256, [1, 2], "#000000", [2], "off"],          # 색 통일 대상
        [256, [1, 2], "#000000", [1], [["a"], [], []]],  # 경계선 설정
    ]
    keys = {tilecache.preview_key(m) for m in [base] + variants}
    assert len(keys) == len(variants) + 1


def test_preview_cache_disabled_is_a_clean_miss(fixture_psd, tmp_path, monkeypatch):
    monkeypatch.setattr(tilecache, "ENABLED", False)
    s = _session(fixture_psd)
    key = tilecache.preview_key([256, [1], None, None, "off"])
    tilecache.store_preview(s, key, _png(tmp_path, "src.png"))
    assert tilecache.load_preview(s, key, str(tmp_path / "o.png")) is None


def test_warm_disk_only_never_decodes_a_cold_leaf(fixture_psd, monkeypatch):
    # 디스크 전용 모드는 타일 자식들이 굽는 동안 프런트가 폴링하는 길이다.
    # 여기서 디코드가 새면 부모가 자식과 같은 잎을 겹으로 굽는다 — 나눈 뜻이
    # 사라진다. 콜드 잎은 건드리지 말고 remaining으로 돌려줘야 한다.
    def boom(layer):
        raise AssertionError(f"디스크 전용인데 디코드했다: {layer.name}")

    monkeypatch.setattr(render_mod, "extract_rgba", boom)
    cold = _session(fixture_psd)
    res = warm_preview_tiles(cold, [2, 4, 5], max_size=256, budget_s=10.0,
                             disk_only=True)
    assert res["warmed"] == [] and sorted(res["remaining"]) == [2, 4, 5]


def test_warm_disk_only_sweeps_what_is_already_on_disk(fixture_psd, monkeypatch):
    # 자식이 구워 둔 잎은 디스크→RAM으로 쓸어담아야 한다 — 이게 진행바를
    # 움직이는 값이고, 그 뒤 토글이 핫인 이유다.
    hot = _session(fixture_psd)
    render_preview(hot, [2, 4, 5], max_size=256, out_dir=fixture_psd.parent)

    def boom(layer):
        raise AssertionError(f"디스크에 있는데 디코드했다: {layer.name}")

    monkeypatch.setattr(render_mod, "extract_rgba", boom)
    fresh = _session(fixture_psd)
    res = warm_preview_tiles(fresh, [2, 4, 5], max_size=256, budget_s=10.0,
                             disk_only=True)
    assert sorted(res["warmed"]) == [2, 4, 5] and res["remaining"] == []
