"""
FLORIDA 배경 파일의 color_to_line 경로(inklayers) — 그려진 라인 레이어만 합치고
아무것도 생성하지 않는다. 프리셋은 color_to_line 하나이고, 파일 이름 규칙으로
이 경로에 들어온다. `profile: "inkLayers"`는 이름과 무관하게 강제하는 엔진 내부
스위치(테스트·계측용)다.
"""
import numpy as np
import pytest
from pytoshop import enums
from pytoshop.user import nested_layers

from psd_engine import imageline, inklayers
from psd_engine.imageline import extract_image_line
from psd_engine.session import SessionStore

from conftest import write_psd

INK = {"enabled": True, "version": 1, "profile": "inkLayers"}
AUTO = {"enabled": True, "version": 1}


def _session(path):
    store = SessionStore()
    return store.get(store.open(str(path)))


def _layer(name, rgba, opacity=255, visible=True,
           blend_mode=enums.BlendMode.normal, top=0, left=0):
    return nested_layers.Image(
        name=name,
        channels={i: np.ascontiguousarray(rgba[..., i]) for i in range(3)}
        | {-1: np.ascontiguousarray(rgba[..., 3])},
        top=top, left=left, opacity=opacity, visible=visible,
        blend_mode=blend_mode,
    )


SIZE = 128


def _stroke(size=SIZE, colour=(90, 50, 30), alpha=200):
    """대각선 한 획 + 가로 한 획(각 2px) — 잉크."""
    rgba = np.zeros((size, size, 4), dtype=np.uint8)
    for i in range(4, size - 4):
        rgba[i, i, :] = [*colour, alpha]
        rgba[i, i + 1, :] = [*colour, alpha]
    rgba[100:102, 4:size - 4, :] = [*colour, alpha]
    return rgba


def _fill(size=SIZE, colour=(200, 120, 80)):
    """칠한 면 — 잉크가 아니다."""
    rgba = np.zeros((size, size, 4), dtype=np.uint8)
    rgba[16:112, 16:112, :] = [*colour, 255]
    return rgba


def _speckles(size=SIZE, seed=1):
    """먼지 질감 — 짧은 성분뿐."""
    rng = np.random.default_rng(seed)
    rgba = np.zeros((size, size, 4), dtype=np.uint8)
    for _ in range(200):
        y, x = rng.integers(2, size - 3, size=2)
        rgba[y:y + 2, x:x + 2, :] = [40, 40, 40, 255]
    return rgba


def test_profile_is_normalized_and_unknown_values_are_rejected():
    assert imageline.normalize_options(AUTO)["profile"] == "auto"
    assert imageline.normalize_options(INK)["profile"] == "inkLayers"
    with pytest.raises(ValueError, match="profile"):
        imageline.normalize_options({**AUTO, "profile": "bogus"})


def _flat_colour_doc(tmp_path, name):
    """색 경계만 있고 라인 레이어가 없는 문서 — 일반 경로는 경계선을 만들고
    inklayers 경로는 빈 그림을 낸다. 두 경로를 가르는 리트머스."""
    left = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
    left[:, :64, :] = [220, 40, 40, 255]
    right = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
    right[:, 64:, :] = [40, 40, 220, 255]
    return write_psd(tmp_path / name, [
        nested_layers.Group(name="ART", layers=[
            _layer("red", left), _layer("blue", right),
        ]),
    ], width=SIZE, height=SIZE)


def _inked_doc(tmp_path, name):
    """잉크 잎이 있는 문서 + 색 경계만 있는 그룹. 잉크 경로는 획만 내고
    (색 경계 그룹은 잉크가 없으니 실루엣도 없다 — 캔버스를 채우므로), 일반
    경로는 색 경계선을 만든다."""
    left = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
    left[:, :64, :] = [220, 40, 40, 255]
    right = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
    right[:, 64:, :] = [40, 40, 220, 255]
    return write_psd(tmp_path / name, [
        nested_layers.Group(name="Chair", layers=[_layer("LINE", _stroke())]),
        nested_layers.Group(name="ART", layers=[
            _layer("red", left), _layer("blue", right),
        ]),
    ], width=SIZE, height=SIZE)


@pytest.mark.parametrize("name", [
    "FL102_BG_fixture_a.psd", "fl102_bg.psd", "FL103_BG_fixture_b.psd",
])
def test_florida_bg_files_take_the_ink_path_under_color_to_line(tmp_path, name):
    # 프리셋은 color_to_line 그대로(profile 없음). 파일 이름이 경로를 가른다.
    path = _inked_doc(tmp_path, name)
    session = _session(path)
    assert imageline._is_fl102_document(session) is True
    mask, _ = extract_image_line(session, AUTO)
    assert mask[10, 10] == 200      # 잉크
    assert mask[30, 64] == 0        # 빨강/파랑 경계에는 선을 만들지 않는다
    assert imageline.image_line_profile(session, AUTO)["inkLayerProfile"] == "inkLayers"


def test_lineless_florida_file_keeps_the_ink_result_when_the_general_path_sprays(tmp_path):
    # 라인 없는 하늘 판: 일반 경로는 그러데이션·질감을 검은 스프레이로 덮는다.
    # 그 결과는 선화가 아니므로 버리고 잉크 경로(구름 윤곽)를 쓴다.
    rng = np.random.default_rng(7)
    noise = rng.integers(0, 256, size=(SIZE, SIZE, 3), dtype=np.uint8)
    plate = np.dstack([noise, np.full((SIZE, SIZE), 255, dtype=np.uint8)])
    path = write_psd(tmp_path / "FL102_BG_sky.psd", [
        nested_layers.Group(name="Sky", layers=[_layer("Layer 133", plate)]),
        nested_layers.Group(name="Clouds", layers=[_shape("clouds")]),
    ], width=SIZE, height=SIZE)
    session = _session(path)
    general = np.zeros((SIZE, SIZE), dtype=np.uint8)
    general[::2, :] = 255  # 캔버스의 절반을 덮는 잡티 — 선화가 아니다
    assert imageline._looks_like_line_art(general) is False
    mask, _ = extract_image_line(session, AUTO)
    profile = imageline.image_line_profile(session, AUTO)
    if profile.get("generalPathRejected"):
        assert profile["inkLayerProfile"] == "inkLayers"
        assert mask[30, 45] > 0 and mask[42, 45] == 0  # 구름 윤곽만
    else:
        # 잡음 픽스처가 우연히 선화 검사를 통과하면 일반 결과여야 한다.
        assert imageline._looks_like_line_art(mask)


def test_line_art_check_accepts_strokes_and_rejects_speckle_and_fill():
    strokes = np.zeros((256, 256), dtype=np.uint8)
    strokes[100:103, 10:250] = 255
    strokes[10:250, 60:63] = 255
    assert imageline._looks_like_line_art(strokes) is True
    rng = np.random.default_rng(1)
    speckle = np.zeros((256, 256), dtype=np.uint8)
    for _ in range(300):
        y, x = rng.integers(0, 254, size=2)
        speckle[y:y + 2, x:x + 2] = 255
    assert imageline._looks_like_line_art(speckle) is False
    fill = np.zeros((256, 256), dtype=np.uint8)
    fill[20:236, 20:236] = 255
    assert imageline._looks_like_line_art(fill) is False
    assert imageline._looks_like_line_art(np.zeros((8, 8), dtype=np.uint8)) is False


def _painted_bg_doc(tmp_path, name, addition):
    """칠한 배경 파일 흉내: 물체 그룹(밑칠 + 클리핑 음영 S/HL + 잉크 LINE) +
    일반 경로가 잉크 위에 무언가 더하게 만드는 층(addition)."""
    fill = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
    fill[20:110, 20:110, :] = [200, 150, 90, 255]
    shade = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
    shade[60:110, 20:110, :] = [40, 30, 20, 120]
    hl = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
    hl[20:40, 20:110, :] = [255, 255, 240, 90]
    return write_psd(tmp_path / name, [
        nested_layers.Group(name="Wall", layers=[
            _layer("Layer 13", fill),
            _layer("S", shade, blend_mode=enums.BlendMode.multiply),
            _layer("HL", hl),
            _layer("LINE", _stroke()),
        ]),
        nested_layers.Group(name="Extra", layers=[_layer("Layer 40", addition)]),
    ], width=SIZE, height=SIZE, clipping=("S", "HL"))


def test_painted_bg_detection_needs_fill_plus_clipped_shading(tmp_path):
    addition = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
    path = _painted_bg_doc(tmp_path, "painted.psd", addition)
    assert inklayers.has_painted_object_groups(_session(path)["psd"]) is True
    plain = write_psd(tmp_path / "plain.psd", [
        nested_layers.Group(name="Chair", layers=[_layer("LINE", _stroke())]),
    ], width=SIZE, height=SIZE)
    assert inklayers.has_painted_object_groups(_session(plain)["psd"]) is False


def test_painted_bg_of_any_name_takes_the_ink_path(tmp_path):
    # 이름은 다른데 스타일이 같은 파일 — 구조로 판별해 잉크 경로로 간다. 일반
    # 경로가 만들었을 색 경계선은 없다.
    addition = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
    addition[10:120, 4:60, :] = [220, 40, 40, 255]
    addition[10:120, 60:124, :] = [40, 40, 220, 255]
    path = _painted_bg_doc(tmp_path, "other_show_bg.psd", addition)
    session = _session(path)
    assert imageline._is_fl102_document(session) is False
    mask, _ = extract_image_line(session, AUTO)
    profile = imageline.image_line_profile(session, AUTO)
    assert profile["inkLayerProfile"] == "inkLayers"
    assert mask[10, 10] == 200 and mask[12:18, 56:65].max() == 0


def test_turnaround_sheet_with_clipped_shading_stays_on_the_general_path(tmp_path):
    # 캐릭터 턴어라운드는 음영 구조가 같아도 배경이 아니다 — 색 경계선 생성이
    # 필요한 파일이라 일반 경로 그대로.
    fill = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
    fill[20:110, 20:110, :] = [200, 150, 90, 255]
    shade = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
    shade[60:110, 20:110, :] = [40, 30, 20, 120]
    hl = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
    hl[20:40, 20:110, :] = [255, 255, 240, 90]
    path = write_psd(tmp_path / "turnaround.psd", [
        nested_layers.Group(name="TURN", layers=[
            nested_layers.Group(name="FRONT", layers=[
                _layer("Layer 13", fill),
                _layer("S", shade, blend_mode=enums.BlendMode.multiply),
                _layer("HL", hl),
                _layer("LINE", _stroke()),
            ]),
        ]),
    ], width=SIZE, height=SIZE, clipping=("S", "HL"))
    session = _session(path)
    assert inklayers.has_painted_object_groups(session["psd"]) is False
    extract_image_line(session, AUTO)
    assert "inkLayerProfile" not in imageline.image_line_profile(session, AUTO)


def test_florida_named_file_without_any_ink_layer_falls_back_to_the_general_path(tmp_path):
    # 라인 없는 그림(액자 속 포스터)은 이 스타일이 아니다 — 일반 경로가
    # 전부터 내던 색 경계선 그대로. 강제 profile은 빈 결과를 돌려준다.
    path = _flat_colour_doc(tmp_path, "FL102_BG_painting.psd")
    session = _session(path)
    mask, _ = extract_image_line(session, AUTO)
    assert mask.max() > 0
    assert "inkLayerProfile" not in imageline.image_line_profile(session, AUTO)
    forced, _ = extract_image_line(session, INK)
    assert forced.max() == 0


@pytest.mark.parametrize("name", [
    "other-style.psd", "FL102_CH_turn.psd", "HH0306_BG_x.psd", "afl102_bg_x.psd",
])
def test_other_files_keep_the_general_color_to_line_path(tmp_path, name):
    path = _flat_colour_doc(tmp_path, name)
    session = _session(path)
    assert imageline._is_fl102_document(session) is False
    mask, _ = extract_image_line(session, AUTO)
    assert mask.max() > 0
    assert "inkLayerProfile" not in imageline.image_line_profile(session, AUTO)


def test_florida_named_png_stays_on_the_flattened_image_path(tmp_path, monkeypatch):
    # 평면 이미지(PNG)는 레이어가 없다 — 이름이 FLORIDA여도 inklayers로 보내면
    # 빈 그림이 된다. 평면 경로(모델)를 그대로 탄다.
    from PIL import Image as PILImage

    png = tmp_path / "FL102_BG_flat.png"
    PILImage.new("RGB", (SIZE, SIZE), "white").save(png)
    session = _session(png)
    assert session["flattened_image"] is True
    opts = imageline.normalize_options(AUTO)
    assert imageline._uses_ink_layers(session, opts) is False


def test_named_line_layer_is_kept_and_fill_is_not(tmp_path):
    stroke = _stroke()
    path = write_psd(tmp_path / "named.psd", [
        nested_layers.Group(name="Chair", layers=[
            _layer("LINE", stroke),
            _layer("Fill", _fill()),
        ]),
    ], width=SIZE, height=SIZE)
    mask, _ = extract_image_line(_session(path), INK)
    assert (mask[10, 10], mask[10, 11]) == (200, 200)
    assert mask[100, 30] == 200  # 가로 획
    assert mask[30, 60] == 0  # 칠한 면 안쪽은 비어 있다
    assert mask[20, 20] == 200  # 획이 지나는 칸(대각선)


def test_object_named_ink_is_found_by_stroke_shape(tmp_path):
    # FL102는 잉크를 물체 이름(chair·table·Layer 106)으로 부른다 — 이름이 아니라
    # 획 모양으로 잡아야 한다. 칠한 면과 먼지 질감은 잡히면 안 된다.
    path = write_psd(tmp_path / "object.psd", [
        nested_layers.Group(name="Chair", layers=[
            _layer("chair", _stroke()),
            _layer("Dirt", _speckles()),
            _layer("Layer 13", _fill()),
        ]),
    ], width=SIZE, height=SIZE)
    found = inklayers.collect_ink_layers(_session(path)["psd"])
    assert [item["name"] for item in found["accepted"]] == ["chair"]
    assert found["accepted"][0]["reason"] == "strokes"
    reasons = {item["name"]: item["reason"] for item in found["rejected"]}
    assert reasons["Dirt"] == "shadingName"
    assert reasons["Layer 13"] == "paint"


def test_unnamed_speckle_texture_is_rejected_by_long_component_ratio(tmp_path):
    path = write_psd(tmp_path / "speckle.psd", [
        nested_layers.Group(name="Wall", layers=[
            _layer("Layer 40", _speckles()),
        ]),
    ], width=SIZE, height=SIZE)
    found = inklayers.collect_ink_layers(_session(path)["psd"])
    assert found["accepted"] == []
    (rejected,) = found["rejected"]
    assert rejected["reason"] == "paint"
    assert rejected["features"]["longRatio"] < inklayers.LONG_RATIO_MIN


def test_nothing_is_generated_from_colour_boundaries(tmp_path):
    # auto 프로파일은 색 경계로 선을 만든다. inkLayers는 만들지 않는다 — 라인
    # 레이어가 없는 문서는 빈 그림이다.
    left = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
    left[:, :64, :] = [220, 40, 40, 255]
    right = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
    right[:, 64:, :] = [40, 40, 220, 255]
    path = write_psd(tmp_path / "flat.psd", [
        nested_layers.Group(name="ART", layers=[
            _layer("red", left),
            _layer("blue", right),
        ]),
    ], width=SIZE, height=SIZE)
    mask, _ = extract_image_line(_session(path), INK)
    assert mask.max() == 0


def test_hidden_groups_reference_groups_and_text_are_skipped(tmp_path):
    from pytoshop.user import nested_layers as nl

    path = write_psd(tmp_path / "skip.psd", [
        nl.Group(name="ROUGH CH SCALE", layers=[_layer("LINE", _stroke())],
                 visible=False),
        nl.Group(name="PERSP GUIDES", layers=[_layer("grid line", _stroke())]),
        nl.Group(name="Table", layers=[
            _layer("horizon line", _stroke()),
        ]),
    ], width=SIZE, height=SIZE)
    mask, _ = extract_image_line(_session(path), INK)
    assert mask.max() == 0


def test_overlay_blend_strokes_are_not_ink_unless_named(tmp_path):
    # 얇은 오버레이 획은 하이라이트다. 이름이 line이면 블렌드와 무관하게 잉크다.
    path = write_psd(tmp_path / "overlay.psd", [
        nested_layers.Group(name="Roof", layers=[
            _layer("Layer 77", _stroke(), blend_mode=enums.BlendMode.overlay),
            _layer("roof line", _stroke(), blend_mode=enums.BlendMode.overlay),
        ]),
    ], width=SIZE, height=SIZE)
    found = inklayers.collect_ink_layers(_session(path)["psd"])
    assert [item["name"] for item in found["accepted"]] == ["roof line"]
    reasons = {item["name"]: item["reason"] for item in found["rejected"]}
    assert reasons["Layer 77"] == "blend:OVERLAY"


def test_clipped_colour_plate_over_ink_keeps_the_ink_antialiasing(tmp_path):
    # LINE 그룹 안의 색 판(클리핑, 전부 불투명)은 잉크 알파를 그대로 물려받아야
    # 한다 — 문턱으로 자르면 가장자리가 255로 덮여 선이 굵어진다.
    plate = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
    plate[:, :, :] = [90, 50, 30, 255]
    path = write_psd(tmp_path / "plate-clip.psd", [
        nested_layers.Group(name="LINE", layers=[
            _layer("Layer 113", plate),
            _layer("RESORT", _stroke(alpha=120)),
        ]),
    ], width=SIZE, height=SIZE, clipping=("Layer 113",))
    mask, _ = extract_image_line(_session(path), INK)
    assert mask[10, 10] == 120
    assert mask[50, 60] == 0


def test_clipped_named_line_is_limited_to_its_base(tmp_path):
    base = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
    base[:, :64, :] = [200, 200, 200, 255]  # 왼쪽 반만 바탕
    path = write_psd(tmp_path / "clip.psd", [
        nested_layers.Group(name="photo", layers=[
            _layer("LINE", _stroke()),
            _layer("Layer 536", base),
        ]),
    ], width=SIZE, height=SIZE, clipping=("LINE",))
    mask, _ = extract_image_line(_session(path), INK)
    assert mask[10, 10] == 200
    assert mask[100, 20] == 200
    assert mask[100, 100] == 0


def test_layer_and_group_opacity_scale_the_ink(tmp_path):
    path = write_psd(tmp_path / "opacity.psd", [
        nested_layers.Group(name="Rail", layers=[
            _layer("Line", _stroke(alpha=255), opacity=128),
        ]),
    ], width=SIZE, height=SIZE)
    mask, _ = extract_image_line(_session(path), INK)
    assert mask[10, 10] == 128


def test_named_solid_plate_is_not_ink(tmp_path):
    plate = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
    plate[:, :, :] = [120, 60, 160, 255]
    path = write_psd(tmp_path / "plate.psd", [
        nested_layers.Group(name="FLOOR", layers=[_layer("line", plate)]),
    ], width=SIZE, height=SIZE)
    found = inklayers.collect_ink_layers(_session(path)["psd"])
    assert found["accepted"] == []
    assert found["rejected"][0]["reason"] == "namedPlate"


def test_profiles_are_cached_separately(tmp_path):
    left = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
    left[:, :64, :] = [220, 40, 40, 255]
    right = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
    right[:, 64:, :] = [40, 40, 220, 255]
    path = write_psd(tmp_path / "cache.psd", [
        nested_layers.Group(name="ART", layers=[
            _layer("red", left), _layer("blue", right),
        ]),
    ], width=SIZE, height=SIZE)
    session = _session(path)
    auto_mask, auto_hash = extract_image_line(session, AUTO)
    ink_mask, ink_hash = extract_image_line(session, INK)
    assert auto_hash != ink_hash
    assert auto_mask.max() > 0 and ink_mask.max() == 0
    profile = imageline.image_line_profile(session, INK)
    assert profile["inkLayerProfile"] == "inkLayers"
    assert profile["inkLayerCount"] == 0


def _shape(name, colour=(250, 240, 180), alpha=255):
    """구름 — 잉크 없이 칠로만 그린 모양. 캔버스 (30,20)에 24x50으로 놓인다
    (실제 파일처럼 bbox가 내용에 맞게 잘려 있어야 실루엣 규칙이 보고, 문서의
    15%를 넘지 않아야 배경 판이 아니라 물체로 본다)."""
    rgba = np.zeros((24, 50, 4), dtype=np.uint8)
    rgba[:, :, :] = [*colour, alpha]
    return _layer(name, rgba, top=30, left=20)


def test_lineless_painted_shape_gets_a_silhouette_outline(tmp_path):
    path = write_psd(tmp_path / "cloud.psd", [
        nested_layers.Group(name="Clouds", layers=[_shape("clouds")]),
    ], width=SIZE, height=SIZE)
    session = _session(path)
    found = inklayers.collect_ink_layers(session["psd"])
    assert [item["name"] for item in found["silhouettes"]] == ["clouds"]
    mask, _ = extract_image_line(session, INK)
    assert mask[30, 45] > 0 and mask[53, 45] > 0  # 위·아래 가장자리
    assert mask[42, 45] == 0  # 안쪽은 비어 있다
    profile = imageline.image_line_profile(session, INK)
    assert profile["inkSilhouetteLayerCount"] == 1


def test_shape_cropped_by_the_canvas_top_gets_no_line_along_the_edge(tmp_path):
    # 위쪽이 캔버스에 잘린 구름: 캔버스 위 변을 따라 직선이 생기면 안 된다.
    cloud = np.zeros((30, 50, 4), dtype=np.uint8)
    cloud[:, :, :] = [250, 240, 180, 255]
    path = write_psd(tmp_path / "cropped-cloud.psd", [
        nested_layers.Group(name="Clouds", layers=[
            _layer("clouds", cloud, top=0, left=40),
        ]),
    ], width=SIZE, height=SIZE)
    mask, _ = extract_image_line(_session(path), INK)
    assert mask[0:3, 50:80].max() == 0      # 캔버스 위 변: 선 없음
    assert mask[29, 65] > 0 and mask[15, 40] > 0  # 아래 변·왼쪽 변은 남는다


def test_painted_shape_in_an_inked_group_is_not_outlined(tmp_path):
    # 잉크가 있는 물체의 라인은 아티스트가 그렸다 — 칠 밑판에 윤곽을 겹치지 않는다.
    path = write_psd(tmp_path / "inked.psd", [
        nested_layers.Group(name="Chair", layers=[
            _layer("chair", _stroke()),
            _shape("Layer 13"),
        ]),
    ], width=SIZE, height=SIZE)
    found = inklayers.collect_ink_layers(_session(path)["psd"])
    assert found["silhouettes"] == []
    reasons = {item["name"]: item["reason"] for item in found["rejected"]}
    assert reasons["Layer 13"] == "shapeInInkedGroup"


def test_canvas_filling_plates_and_soft_glows_get_no_silhouette(tmp_path):
    plate = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
    plate[:, :, :] = [120, 160, 220, 255]
    path = write_psd(tmp_path / "sky.psd", [
        nested_layers.Group(name="Sky", layers=[
            _layer("Layer 60", plate),
            _shape("Layer 116", colour=(255, 240, 200), alpha=120),
        ]),
    ], width=SIZE, height=SIZE)
    found = inklayers.collect_ink_layers(_session(path)["psd"])
    assert found["silhouettes"] == []
    reasons = {item["name"]: item["reason"] for item in found["rejected"]}
    assert reasons["Layer 116"] == "shapeNoCore"
    assert reasons["Layer 60"] == "paint"


def test_multiply_scanned_line_layer_contributes_its_darkness_not_its_alpha(tmp_path):
    # 흰 종이째 곱하기로 얹은 스캔 선화: 알파는 전부 255다. 어두움만 선이다.
    scan = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
    scan[:, :, :] = [255, 255, 255, 255]
    scan[40:42, 8:120, :3] = 0          # 검정 획
    scan[80:82, 8:120, :3] = 128        # 회색 획 → 반만
    path = write_psd(tmp_path / "scan.psd", [
        nested_layers.Group(name="photo", layers=[
            _layer("LINE", scan, blend_mode=enums.BlendMode.multiply),
        ]),
    ], width=SIZE, height=SIZE)
    mask, _ = extract_image_line(_session(path), INK)
    assert mask[41, 60] == 255
    assert 120 <= mask[81, 60] <= 135
    assert mask[60, 60] == 0  # 흰 종이는 비어 있다


def test_opaque_named_plate_with_dark_strokes_is_read_as_darkness(tmp_path):
    # 이름은 line인데 NORMAL 블렌드의 불투명 판 — 스캔을 그대로 붙인 것.
    scan = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
    scan[:, :, :] = [255, 255, 255, 255]
    scan[40:42, 8:120, :3] = 0
    path = write_psd(tmp_path / "plate-scan.psd", [
        nested_layers.Group(name="photo", layers=[_layer("line", scan)]),
    ], width=SIZE, height=SIZE)
    found = inklayers.collect_ink_layers(_session(path)["psd"])
    assert [item["reason"] for item in found["accepted"]] == ["namedDarkness"]
    mask, _ = extract_image_line(_session(path), INK)
    assert mask[41, 60] == 255 and mask[60, 60] == 0


def test_misspelled_clipped_line_layer_is_still_ink(tmp_path):
    base = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
    base[:, :, :] = [200, 200, 200, 255]
    path = write_psd(tmp_path / "typo.psd", [
        nested_layers.Group(name="manny mom", layers=[
            _layer("LIKNE", _stroke()),
            _layer("Layer 542", base),
        ]),
    ], width=SIZE, height=SIZE, clipping=("LIKNE",))
    mask, _ = extract_image_line(_session(path), INK)
    assert mask[10, 10] == 200


def test_background_sized_paint_and_strokes_get_no_silhouette(tmp_path):
    # 하늘·수면처럼 문서의 15%를 넘는 칠은 배경이다. 획 모양의 잎은 잉크로
    # 받거나 말거나 윤곽을 씌우지 않는다(이중선).
    sky = np.zeros((SIZE - 8, SIZE - 8, 4), dtype=np.uint8)
    sky[:, :, :] = [120, 160, 220, 255]
    path = write_psd(tmp_path / "sky-strokes.psd", [
        nested_layers.Group(name="Sky", layers=[
            _layer("Layer 45", sky, top=4, left=4),
        ]),
        nested_layers.Group(name="Pole", layers=[
            _layer("Layer 23", _stroke(), opacity=51),
        ]),
    ], width=SIZE, height=SIZE)
    found = inklayers.collect_ink_layers(_session(path)["psd"])
    assert found["silhouettes"] == [] and found["accepted"] == []
    reasons = {item["name"]: item["reason"] for item in found["rejected"]}
    assert reasons["Layer 45"] == "paint"
    assert reasons["Layer 23"] == "faint"


def test_spray_texture_in_a_lineless_group_gets_no_silhouette(tmp_path):
    # 벽의 스프레이 질감: 작은 점 수백 개. 점마다 윤곽을 그리면 검은 덩어리다.
    rng = np.random.default_rng(3)
    spray = np.zeros((60, 60, 4), dtype=np.uint8)
    for _ in range(400):
        y, x = rng.integers(0, 58, size=2)
        spray[y:y + 2, x:x + 2, :] = [90, 80, 70, 255]
    path = write_psd(tmp_path / "spray.psd", [
        nested_layers.Group(name="Walls", layers=[
            _layer("Layer 157", spray, top=30, left=30),
        ]),
    ], width=SIZE, height=SIZE)
    found = inklayers.collect_ink_layers(_session(path)["psd"])
    assert found["silhouettes"] == []
    reasons = {item["name"]: item["reason"] for item in found["rejected"]}
    assert reasons["Layer 157"] in {"shapeNotSolid", "paint"}


def test_tightly_boxed_thin_pole_is_ink_despite_high_coverage(tmp_path):
    pole = np.zeros((SIZE, 3, 4), dtype=np.uint8)
    pole[:, :, :] = [60, 40, 30, 255]
    path = write_psd(tmp_path / "pole.psd", [
        nested_layers.Group(name="flagpole", layers=[
            _layer("flagpole", pole, top=0, left=60),
        ]),
    ], width=SIZE, height=SIZE)
    found = inklayers.collect_ink_layers(_session(path)["psd"])
    assert [item["reason"] for item in found["accepted"]] == ["strokes"]
    assert found["accepted"][0]["features"]["coverage"] > inklayers.COVERAGE_MAX


def test_wide_painted_band_in_a_line_layer_becomes_its_outline(tmp_path):
    # 카메라 가까이의 코트 선은 60px 띠로 칠해져 있다(이름은 line). 그대로 두면
    # 검은 쐐기가 된다 — 예전 경로처럼 넓은 칠은 윤곽만 남긴다. 보통 굵기의
    # 획(2px)은 손대지 않는다.
    band = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
    band[20:80, 4:124, :] = [0, 0, 0, 255]     # 60px 띠
    band[100:102, 4:124, :] = [0, 0, 0, 255]   # 보통 획
    path = write_psd(tmp_path / "band.psd", [
        nested_layers.Group(name="court", layers=[_layer("court white lines", band)]),
    ], width=SIZE, height=SIZE)
    mask, _ = extract_image_line(_session(path), INK)
    assert mask[50, 60] == 0          # 띠 안쪽은 비었다
    assert mask[20, 60] == 255 and mask[79, 60] == 255  # 띠의 두 가장자리
    assert mask[100, 60] == 255 and mask[101, 60] == 255  # 보통 획 그대로


@pytest.mark.parametrize("name,expected", [
    ("LIKNE", True), ("linne", True), ("LINEES", True),
    ("lime", False), ("lane", False), ("pine", False), ("linen", False),
])
def test_line_typo_rule(name, expected):
    assert inklayers.is_named_ink_layer(name) is expected


@pytest.mark.parametrize("name,expected", [
    ("LINE", True), ("flower line", True), ("Lines", True), ("outline", True),
    # 붙여 쓴 것과 식물 이름은 이름으로는 안 받는다(굵기 검사가 판단).
    ("courtlines", False), ("waterline", False), ("Cordyline shrub", False),
    ("barrier OL", False), ("linen", False), ("Layer 12", False),
    ("horizon line", False), ("height line", False), ("chair", False),
])
def test_ink_name_rule(name, expected):
    assert inklayers.is_named_ink_layer(name) is expected


def _field_guide_bg_doc(tmp_path, name):
    """배경 판 흉내: *ART(칠한 물체 그룹 + 잉크) 옆에 *FIELDGUIDES(카메라 필드
    틀 FLGD·십자선·보드 캐릭터) — 실제 HH03 배경 판의 최상위 구조."""
    fill = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
    fill[20:110, 20:110, :] = [200, 150, 90, 255]
    shade = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
    shade[60:110, 20:110, :] = [40, 30, 20, 120]
    hl = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
    hl[20:40, 20:110, :] = [255, 255, 240, 90]
    # 필드 틀: 2px 사각 테두리 — 굵기 검사로는 완벽한 획이다.
    frame = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
    frame[8:120, 8:10, :] = [0, 0, 0, 255]
    frame[8:120, 118:120, :] = [0, 0, 0, 255]
    frame[8:10, 8:120, :] = [0, 0, 0, 255]
    frame[118:120, 8:120, :] = [0, 0, 0, 255]
    cross = np.zeros((SIZE, SIZE, 4), dtype=np.uint8)
    cross[62:64, 40:88, :] = [0, 0, 0, 255]
    cross[40:88, 62:64, :] = [0, 0, 0, 255]
    # 보드 캐릭터: 잉크 없는 그룹 안의 덩어리 — 실루엣 후보다.
    board = np.zeros((40, 40, 4), dtype=np.uint8)
    board[:, :, :] = [50, 50, 50, 255]
    return write_psd(tmp_path / name, [
        nested_layers.Group(name="*FIELDGUIDES", layers=[
            nested_layers.Group(name="HH0309_050_0050", layers=[
                nested_layers.Group(name="field a", layers=[
                    nested_layers.Group(name="fieldguide", layers=[
                        _layer("FLGD", frame),
                        _layer("Crosshairs", cross),
                    ]),
                ]),
                nested_layers.Group(name="board char", layers=[
                    _layer("a", board, top=70, left=70),
                ]),
            ]),
        ]),
        nested_layers.Group(name="*ART", layers=[
            nested_layers.Group(name="Wall", layers=[
                _layer("Layer 13", fill),
                _layer("S", shade, blend_mode=enums.BlendMode.multiply),
                _layer("HL", hl),
                _layer("LINE", _stroke()),
            ]),
        ]),
    ], width=SIZE, height=SIZE, clipping=("S", "HL"))


def test_field_guides_beside_art_stay_out_of_the_ink_result(tmp_path):
    # 배경 판은 *ART 옆에 *FIELDGUIDES를 둔다. 일반 경로는 제작 루트(*ART)만
    # 보는데 잉크 경로가 문서 전체를 걸어, 필드 틀은 획 모양이라 잉크로 받고
    # 보드 캐릭터는 실루엣이 됐다(HH03 라운지 판, 2026-09-07). 라인은 *ART의
    # 잉크뿐이어야 한다.
    path = _field_guide_bg_doc(tmp_path, "lounge_bg.psd")
    session = _session(path)
    assert inklayers.has_painted_object_groups(session["psd"]) is True
    found = inklayers.collect_ink_layers(session["psd"])
    taken = [item["path"] for item in found["accepted"] + found["silhouettes"]]
    assert taken == ["*ART/Wall/LINE"]
    mask, _ = extract_image_line(session, AUTO)
    assert imageline.image_line_profile(session, AUTO)["inkLayerProfile"] == "inkLayers"
    assert mask[10, 10] == 200 and mask[100, 50] == 200
    assert mask[20:90, 8:10].max() == 0 and mask[62:64, 40:60].max() == 0
    assert mask[69:72, 74:106].max() == 0
