"""가는 획과 채색 면이 굵기 특징으로 갈라지는지 — 문턱의 최소 계약.

실측 보정(납품 BG 26장)은 코드로 재현할 수 없으므로, 여기서는 방향만
잠근다: 1픽셀 획은 침식에 전멸하고, 채움은 대부분 살아남는다. 이 관계가
깨지면 프런트의 문턱(detectDrawnLines.ts) 전체가 무의미해진다.
"""
import io

import numpy as np
import pytest
from pytoshop import enums
from pytoshop.user import nested_layers

from psd_engine import rpc

from conftest import CANVAS_H, CANVAS_W, make_image, write_psd


def make_hatch(name, x=0, y=0, w=CANVAS_W, h=CANVAS_H):
    """1픽셀 대각 빗금 — 로프 디테일류의 최소 재현."""
    a = np.zeros((h, w), np.uint8)
    for i in range(h):
        a[i, (np.arange(0, w, 8) + i) % w] = 255
    px = np.full((h, w), 30, np.uint8)
    return nested_layers.Image(
        name=name, channels={0: px, 1: px, 2: px, -1: a},
        top=y, left=x, opacity=255, visible=True,
        blend_mode=enums.BlendMode.normal,
    )


@pytest.fixture
def psd_path(tmp_path):
    path = tmp_path / "strokes.psd"
    write_psd(path, [
        make_hatch("rope details"),
        make_image("fill", 200, 4, 4, 40, 32),
    ])
    return str(path)


def open_session(psd_path):
    engine = rpc.Engine(out=io.StringIO())
    opened = engine.open_psd(psd_path)
    ids = {n["name"]: n["id"] for n in opened["tree"]}
    return engine, opened["sessionId"], ids


def test_hatch_dies_under_erosion_and_fill_survives(psd_path):
    engine, sid, ids = open_session(psd_path)
    result = engine.measure_leaf_strokes(sid, [ids["rope details"], ids["fill"]])
    hatch = result["features"][str(ids["rope details"])]
    fill = result["features"][str(ids["fill"])]
    # 1픽셀 획은 한 번 깎으면 전멸한다. 채움은 테두리 2픽셀만 잃는다.
    assert hatch["survive1"] == 0.0
    assert hatch["survive2"] == 0.0
    assert fill["survive2"] > 0.7
    # 칠 면적: 빗금은 bbox의 극히 일부, 채움은 전부.
    assert hatch["coverage"] < 0.2
    assert fill["coverage"] == 1.0
    assert hatch["nNative"] >= 20
    assert fill["nNative"] == 40 * 32


def test_features_are_cached_per_session(psd_path):
    engine, sid, ids = open_session(psd_path)
    lid = ids["rope details"]
    first = engine.measure_leaf_strokes(sid, [lid])["features"][str(lid)]
    # 캐시를 부순 값으로 바꿔치기 — 두 번째 호출이 디코드를 다시 하면 이 값이
    # 덮여서 테스트가 잡는다.
    engine.store.get(sid)["stroke_features"][lid] = {"survive2": -1.0}
    second = engine.measure_leaf_strokes(sid, [lid])["features"][str(lid)]
    assert first["survive2"] == 0.0
    assert second == {"survive2": -1.0}


def test_unknown_and_unmeasurable_ids_come_back_null(psd_path):
    engine, sid, ids = open_session(psd_path)
    result = engine.measure_leaf_strokes(sid, [9999])
    assert result["features"]["9999"] is None


def test_measure_strokes_rgba_core_matches_layer_wrapper(psd_path):
    """스윕은 타일 디코드에서 얻은 rgba로 코어를 직접 부른다 — 레이어 래퍼와
    수치가 비트까지 같아야 문턱(detectDrawnLines.ts)이 두 경로에 하나로 선다."""
    from psd_tools import PSDImage

    from psd_engine.linedetect import measure_strokes, measure_strokes_rgba
    from psd_engine.render import extract_rgba
    from psd_engine.tree import build_tree

    built = build_tree(PSDImage.open(psd_path))
    for layer in built["layers_by_id"].values():
        if layer.is_group():
            continue
        assert measure_strokes(layer) == measure_strokes_rgba(extract_rgba(layer))
