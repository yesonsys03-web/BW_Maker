import numpy as np

from psd_engine.edges import EDGE_DEFAULTS, colour_change


def _rgba(rows, alpha=255):
    """rows: HxWx3 리스트 → RGBA 배열."""
    arr = np.array(rows, np.uint8)
    a = np.full(arr.shape[:2] + (1,), alpha, np.uint8)
    return np.concatenate([arr, a], axis=2)


def test_colour_change_marks_the_seam_between_two_flat_regions():
    # 왼쪽 두 칸 빨강, 오른쪽 두 칸 검정. 경계는 x=1 (차이가 나는 쌍의 왼쪽 픽셀).
    red, black = [200, 20, 40], [10, 10, 10]
    rgba = _rgba([[red, red, black, black]] * 3)
    mask, _ = colour_change(rgba, EDGE_DEFAULTS["threshold"])
    assert mask[:, 1].all(), "색이 갈리는 자리가 경계로 잡히지 않았다"
    assert not mask[:, [0, 2, 3]].any(), "같은 색끼리 붙은 자리가 경계로 잡혔다"


def test_colour_change_ignores_a_difference_under_the_threshold():
    a, b = [100, 100, 100], [110, 110, 110]      # 차이 10 < 24
    rgba = _rgba([[a, a, b, b]] * 3)
    mask, _ = colour_change(rgba, EDGE_DEFAULTS["threshold"])
    assert not mask.any()


def test_colour_change_ignores_edges_against_transparency():
    # 실루엣(색 vs 투명)은 이미 라인이 그려주는 자리다. 여기서 잡으면 안 된다.
    red = [200, 20, 40]
    rgba = _rgba([[red, red, red, red]] * 3)
    rgba[:, 2:, 3] = 0
    mask, _ = colour_change(rgba, EDGE_DEFAULTS["threshold"])
    assert not mask.any()


def test_colour_change_reports_the_darker_side_colour():
    # 시안의 빨간 획이 전부 어두운 영역 가장자리에 놓여 있었다 — 어두운 쪽을 쓴다.
    light, dark = [200, 200, 200], [30, 20, 10]
    rgba = _rgba([[light, light, dark, dark]] * 3)
    mask, colour = colour_change(rgba, EDGE_DEFAULTS["threshold"])
    assert (colour[mask] == dark).all()


from psd_engine.edges import (build_overlay, drop_small, label_components,
                              stroke_rgba, subtract_lines)


def test_subtract_lines_removes_the_boundary_that_already_has_a_line():
    mask = np.zeros((9, 9), bool)
    mask[4, :] = True                       # 가로 경계 한 줄
    line = np.zeros((9, 9), np.uint8)
    line[4, 0:3] = 255                      # 그중 왼쪽 세 칸에만 이미 선이 있다
    out = subtract_lines(mask, line, gap=1, line_alpha_threshold=64)
    assert not out[4, 0:3].any(), "이미 선이 있는 자리가 남았다"
    assert out[4, 6:].any(), "선이 없는 자리까지 지워졌다"


def test_subtract_lines_uses_the_alpha_threshold_not_mere_presence():
    # LINES는 불투명 픽셀의 79.7%가 반투명이다. 문턱을 넘지 못하는 흐린 자국은
    # 선으로 치지 않아야 그 아래 색 경계가 살아남는다.
    mask = np.zeros((5, 5), bool)
    mask[2, :] = True
    faint = np.full((5, 5), 10, np.uint8)
    out = subtract_lines(mask, faint, gap=0, line_alpha_threshold=64)
    assert out[2, :].all()


def test_label_components_separates_two_disconnected_runs():
    mask = np.zeros((5, 9), bool)
    mask[1, 0:3] = True
    mask[3, 5:9] = True
    labels, count = label_components(mask)
    assert count == 2
    assert labels[1, 0] != labels[3, 5]
    assert labels[0, 0] == 0, "배경이 라벨을 받았다"


def test_drop_small_removes_specks_and_keeps_real_strokes():
    mask = np.zeros((5, 20), bool)
    mask[1, 0:2] = True                     # 2px 점
    mask[3, 5:18] = True                    # 13px 획
    labels, count = label_components(mask)
    out = drop_small(mask, labels, count, min_length=8)
    assert not out[1, :].any()
    assert out[3, 5:18].all()


def test_stroke_rgba_thickens_the_line_and_carries_the_component_colour():
    mask = np.zeros((11, 11), bool)
    mask[5, 2:9] = True
    colour = np.zeros((11, 11, 3), np.uint8)
    colour[5, 2:9] = [30, 20, 10]
    labels, _ = label_components(mask)
    out = stroke_rgba(mask, labels, colour, width=5)
    assert out.shape == (11, 11, 4)
    assert out[3, 5, 3] > 0 and out[7, 5, 3] > 0, "굵어지지 않았다"
    assert out[0, 0, 3] == 0, "빈 곳까지 칠해졌다"
    assert tuple(out[5, 5, :3]) == (30, 20, 10)


def test_stroke_rgba_assigns_contested_ground_to_the_nearer_component_not_the_larger_label():
    # 라벨 1은 x=1, 라벨 2는 x=8. width=9(반지름 4)라 두 조각이 서로의 반경 안에 든다.
    # x=4는 라벨 1까지 3px, 라벨 2까지 4px — 라벨 1이 더 가깝다. 그런데 한 번에 크게
    # MaxFilter를 걸면 "가장 가까운" 라벨이 아니라 "가장 큰" 라벨이 이겨서 x=4가
    # 라벨 2(아래/오른쪽) 색으로 칠해진다. label_components는 래스터 순서로 번호를
    # 매기므로 이 편향은 늘 같은 방향(아래/오른쪽 라벨 승)으로 나타난다.
    mask = np.zeros((1, 11), bool)
    mask[0, 1] = True
    mask[0, 8] = True
    colour = np.zeros((1, 11, 3), np.uint8)
    colour_a, colour_b = [10, 20, 30], [200, 210, 220]
    colour[0, 1] = colour_a
    colour[0, 8] = colour_b
    labels, _ = label_components(mask)
    assert labels[0, 1] != labels[0, 8]
    out = stroke_rgba(mask, labels, colour, width=9)
    assert tuple(out[0, 4, :3]) == tuple(colour_a), \
        "라벨 1(x=1)에 더 가까운 x=4가 라벨 2(x=8)의 색으로 칠해졌다"


def test_build_overlay_is_empty_when_every_boundary_already_has_a_line():
    red, black = [200, 20, 40], [10, 10, 10]
    rgba = _rgba([[red] * 6 + [black] * 6] * 12)
    line = np.zeros((12, 12), np.uint8)
    line[:, 3:9] = 255                       # 경계(x=5)를 넉넉히 덮는다
    out = build_overlay(rgba, line, EDGE_DEFAULTS)
    assert out[..., 3].max() == 0


def test_build_overlay_draws_where_no_line_covers_the_colour_change():
    red, black = [200, 20, 40], [10, 10, 10]
    rgba = _rgba([[red] * 6 + [black] * 6] * 20)
    line = np.zeros((20, 12), np.uint8)
    out = build_overlay(rgba, line, EDGE_DEFAULTS)
    assert out[..., 3].max() > 0
    assert out[10, 5, 3] > 0


from psd_engine.character import find_views
from psd_engine.edges import overlay_for_view, plan_overlays
from psd_engine.session import SessionStore
from pytoshop.user import nested_layers

from conftest import make_rgb_image, write_psd


def _two_tone_session(tmp_path):
    """빨강 바탕 위에 어두운 조각이 얹힌 뷰 하나. 그 경계에는 선이 없다."""
    colours = nested_layers.Group(name="COLORS", layers=[
        make_rgb_image("dark", (40, 20, 20), 0, 0, 32, 12),
        make_rgb_image("base", (200, 30, 60), 0, 0, 32, 24),
    ])
    line = make_rgb_image("LINES", (0, 0, 0), 0, 0, 4, 24)
    p = tmp_path / "twotone.psd"
    write_psd(p, [nested_layers.Group(name="FRONT 3/4", layers=[line, colours])])
    store = SessionStore()
    return store.get(store.open(str(p)))


def test_overlay_for_view_draws_the_unlined_colour_seam(tmp_path):
    s = _two_tone_session(tmp_path)
    view = find_views(s)[0]
    rgba, left, top = overlay_for_view(s, view["colourIds"], view["lineIds"], EDGE_DEFAULTS)
    assert rgba[..., 3].max() > 0, "경계에 획이 생기지 않았다"
    assert rgba.shape[2] == 4


def test_overlay_for_view_ignores_a_hidden_colour_layer(tmp_path):
    # 꺼진 대체 색상(예: 꺼진 'hair red (alt)')은 포토샵에서 안 보이고 내보내기
    # 에도 안 들어가지만, layer_filter가 group만 무조건 통과시키고 visible을
    # 안 보면 wanted 안의 숨은 잎이 base 위에 그대로 합성돼 그 실루엣이 색
    # 경계로 오인된다.
    #
    # find_views가 아니라 id를 직접 모아 넘긴다 — character._pixel_leaves(Fix 1의
    # 다른 절반)가 이미 숨은 레이어를 걸러내므로, find_views를 거치면 이 필터가
    # 없어도 같은 결과가 나와 무엇을 지키는 테스트인지 알 수 없어진다.
    colours = nested_layers.Group(name="COLORS", layers=[
        make_rgb_image("alt", (10, 200, 10), 4, 4, 8, 8, visible=False),
        make_rgb_image("base", (200, 30, 60), 0, 0, 32, 24),
    ])
    line = make_rgb_image("LINES", (0, 0, 0), 0, 0, 4, 24)
    p = tmp_path / "hidden_colour.psd"
    write_psd(p, [nested_layers.Group(name="FRONT 3/4", layers=[line, colours])])
    store = SessionStore()
    s = store.get(store.open(str(p)))
    alt_id = next(lid for lid, l in s["layers_by_id"].items() if l.name == "alt")
    base_id = next(lid for lid, l in s["layers_by_id"].items() if l.name == "base")
    line_id = next(lid for lid, l in s["layers_by_id"].items() if l.name == "LINES")
    result = overlay_for_view(s, [alt_id, base_id], [line_id], EDGE_DEFAULTS)
    assert result is None, "숨은 색 레이어의 실루엣이 경계로 잡혔다"


def test_overlay_for_view_is_none_when_there_is_no_unlined_boundary(tmp_path):
    # 색이 한 가지뿐이면 색 변화가 없다.
    colours = nested_layers.Group(name="COLORS", layers=[
        make_rgb_image("base", (200, 30, 60), 0, 0, 32, 24)])
    line = make_rgb_image("LINES", (0, 0, 0), 0, 0, 4, 24)
    p = tmp_path / "flat.psd"
    write_psd(p, [nested_layers.Group(name="FRONT 3/4", layers=[line, colours])])
    store = SessionStore()
    s = store.get(store.open(str(p)))
    view = find_views(s)[0]
    assert overlay_for_view(s, view["colourIds"], view["lineIds"], EDGE_DEFAULTS) is None


def test_plan_overlays_carries_the_line_ids_it_belongs_to(tmp_path):
    s = _two_tone_session(tmp_path)
    plans = plan_overlays(s, find_views(s), EDGE_DEFAULTS)
    assert len(plans) == 1
    assert plans[0]["lineIds"] == find_views(s)[0]["lineIds"]


from pytoshop import enums as _pt_enums

from psd_engine.edges import _paste_alpha
from psd_engine.patches import apply_pytoshop_patches

from conftest import attach_mask


def test_paste_alpha_applies_the_layers_mask(tmp_path):
    # layer.topil()은 래스터 마스크를 적용하지 않는다 — 마스크로 가려진 자리가
    # 그대로 불투명하게 나와 subtract_lines가 "이미 선이 있다"고 오판하고, 그
    # 아래 살아 있어야 할 색 경계까지 함께 지운다. render.extract_rgba는 마스크를
    # 적용하는 경로를 쓰므로 이 문제가 없다.
    apply_pytoshop_patches()
    line = make_rgb_image("LINES", (0, 0, 0), 0, 0, 8, 8)
    psd = nested_layers.nested_layers_to_psd(
        [line], color_mode=_pt_enums.ColorMode.rgb, size=(8, 8))
    mask = np.zeros((8, 8), np.uint8)
    mask[:, :4] = 255                      # 왼쪽 절반만 보이게, 오른쪽 절반은 가린다
    attach_mask(psd, "LINES", mask, left=0, top=0, default_color=0)
    p = tmp_path / "masked_line.psd"
    with open(p, "wb") as f:
        psd.write(f)
    store = SessionStore()
    s = store.get(store.open(str(p)))
    layer = next(l for l in s["layers_by_id"].values() if l.name == "LINES")
    out = _paste_alpha([layer], (0, 0, 8, 8))
    assert out[:, 4:].max() == 0, "마스크로 가려진 자리가 topil()의 불투명 알파로 남았다"
    assert out[:, :4].max() > 0, "마스크로 가려지지 않은 자리까지 지워졌다"
