import numpy as np

from psd_engine.edges import (
    EDGE_DEFAULTS, EDGE_MODES, REGION_GATE_SCALE, colour_change,
    region_boundary, segment_colours)


def _rgba(rows, alpha=255):
    """rows: HxWx3 리스트 → RGBA 배열."""
    arr = np.array(rows, np.uint8)
    a = np.full(arr.shape[:2] + (1,), alpha, np.uint8)
    return np.concatenate([arr, a], axis=2)


def test_colour_change_marks_the_seam_between_two_flat_regions():
    # 왼쪽 6칸 빨강, 오른쪽 6칸 검정(옛 4칸 픽스처는 k=3 중앙차분이 계산할 폭이
    # 없어 넓혔다 — "경계가 정확히 한 칸에 선다"는 동작 자체는 그대로다). 경계는
    # x=3에 선다: 문턱을 넘는 값이 x=3..8(폭 2k=6) 고지를 이루고, 비최대 억제가
    # 왼쪽/위쪽(작은 인덱스) 한 칸만 남긴다.
    red, black = [200, 20, 40], [10, 10, 10]
    rgba = _rgba([[red] * 6 + [black] * 6] * 3)
    mask, _ = colour_change(rgba, EDGE_DEFAULTS["threshold"])
    assert mask[:, 3].all(), "색이 갈리는 자리가 경계로 잡히지 않았다"
    other_cols = [c for c in range(12) if c != 3]
    assert not mask[:, other_cols].any(), "같은 색끼리 붙은 자리가 경계로 잡혔다"


def test_colour_change_ignores_a_difference_under_the_threshold():
    # 4칸씩(옛 2칸 픽스처는 k=3 창이 계산될 폭이 없어 넓혔다) — 차이는 10 < 24로
    # 어느 폭에서 비교하든 그대로다.
    a, b = [100, 100, 100], [110, 110, 110]      # 차이 10 < 24
    rgba = _rgba([[a] * 4 + [b] * 4] * 3)
    mask, _ = colour_change(rgba, EDGE_DEFAULTS["threshold"])
    assert not mask.any()


def test_colour_change_ignores_edges_against_transparency():
    # 실루엣(색 vs 투명)은 이미 라인이 그려주는 자리다. 여기서 잡으면 안 된다.
    # 8칸(옛 4칸 픽스처는 k=3 창이 계산될 폭이 없어 넓혔다).
    red = [200, 20, 40]
    rgba = _rgba([[red] * 8] * 3)
    rgba[:, 4:, 3] = 0
    mask, _ = colour_change(rgba, EDGE_DEFAULTS["threshold"])
    assert not mask.any()


def test_segment_colours_splits_two_flat_regions():
    red, black = [200, 20, 40], [10, 10, 10]
    rgba = _rgba([[red] * 6 + [black] * 6] * 4)
    labels, flats = segment_colours(rgba)
    assert len(flats) == 2, f"평평한 색이 둘이 아니다: {flats.tolist()}"
    assert (labels[:, :6] == labels[0, 0]).all(), "왼쪽이 한 영역으로 안 묶였다"
    assert (labels[:, 6:] == labels[0, 11]).all(), "오른쪽이 한 영역으로 안 묶였다"
    assert labels[0, 0] != labels[0, 11], "다른 두 색이 같은 영역이 됐다"


def test_segment_colours_leaves_transparent_pixels_unlabelled():
    # 실루엣(색 vs 투명)은 이미 라인이 그리는 자리다. 영역이 되면 안 된다.
    red = [200, 20, 40]
    rgba = _rgba([[red] * 8] * 4)
    rgba[:, 4:, 3] = 0
    labels, _ = segment_colours(rgba)
    assert (labels[:, 4:] == -1).all(), "투명한 자리에 라벨이 붙었다"
    assert (labels[:, :4] >= 0).all(), "불투명한 자리에 라벨이 안 붙었다"


def test_segment_colours_assigns_an_antialiased_pixel_to_the_nearer_flat():
    # 안티에일리어싱 잔여는 개수가 적어 평평한 색이 못 된다(한 뷰에 600~1900개).
    # 가까운 쪽에 붙어야 경계가 전이 한가운데에 선다.
    dark, light, blend = [100, 100, 100], [200, 200, 200], [120, 120, 120]
    rgba = _rgba([[dark] * 5 + [blend] + [light] * 5])
    labels, flats = segment_colours(rgba, floor=0.15)
    assert len(flats) == 2, f"전이색이 자기 영역을 차지했다: {flats.tolist()}"
    assert labels[0, 5] == labels[0, 0], "전이 픽셀이 먼 쪽에 붙었다"


def test_segment_colours_handles_a_fully_transparent_view():
    rgba = _rgba([[[0, 0, 0]] * 4] * 4, alpha=0)
    labels, flats = segment_colours(rgba)
    assert (labels == -1).all()
    assert flats.shape == (0, 3)


def test_region_boundary_marks_one_pixel_at_the_seam():
    # 라벨 경계는 이미 1px이다 — 비최대 억제가 필요 없고, 계단과 잔가시를 만들던
    # 두 단계가 여기서 통째로 사라진다. 경계는 두 색이 실제로 맞닿는 x=5에 선다
    # (colour_change는 중앙차분 k=3의 고지 왼쪽 끝인 x=3에 세운다).
    red, black = [200, 20, 40], [10, 10, 10]
    rgba = _rgba([[red] * 6 + [black] * 6] * 4)
    labels, flats = segment_colours(rgba)
    mask, _ = region_boundary(labels, flats, EDGE_DEFAULTS["threshold"])
    assert mask[:, 5].all(), "색이 갈리는 자리가 경계로 잡히지 않았다"
    other = [c for c in range(12) if c != 5]
    assert not mask[:, other].any(), "경계가 한 칸을 넘어 번졌다"


def test_region_boundary_gates_a_difference_under_the_threshold():
    # 게이트가 없으면 분할은 완만한 그라데이션을 양자화 단계마다 갈라, 아티스트가
    # 아무 경계도 못 보는 자리에 등고선을 긋는다 — colour_change에는 원리상 없던
    # 결함이다. 실측에서 이 게이트는 인접 쌍 92~308개 중 6~118개를 기각한다.
    a, b = [100, 100, 100], [110, 110, 110]      # 차이 10 < 24
    rgba = _rgba([[a] * 6 + [b] * 6] * 4)
    labels, flats = segment_colours(rgba)
    assert len(flats) == 2, "두 색이 각자 영역이 돼야 게이트를 시험할 수 있다"
    mask, _ = region_boundary(labels, flats, EDGE_DEFAULTS["threshold"])
    assert not mask.any(), "문턱 아래인데 획을 그었다 — 그라데이션에 등고선이 생긴다"


def test_region_boundary_ignores_the_silhouette():
    red = [200, 20, 40]
    rgba = _rgba([[red] * 8] * 4)
    rgba[:, 4:, 3] = 0
    labels, flats = segment_colours(rgba)
    mask, _ = region_boundary(labels, flats, EDGE_DEFAULTS["threshold"])
    assert not mask.any(), "실루엣을 경계로 잡았다 — 캐릭터 윤곽을 다시 긋게 된다"


def test_region_boundary_uses_the_darker_of_the_two_regions():
    # colour_change와 같은 규칙이라 하류(stroke_rgba의 조각별 대표색)가 그대로 붙는다.
    red, black = [200, 20, 40], [10, 10, 10]
    rgba = _rgba([[red] * 6 + [black] * 6] * 4)
    labels, flats = segment_colours(rgba)
    mask, colour = region_boundary(labels, flats, EDGE_DEFAULTS["threshold"])
    assert mask.any(), "픽스처에 경계가 없다 — 빈 마스크에서는 색 단언이 공허하게 통과한다"
    assert (colour[mask] == np.array(black, np.uint8)).all(), "어두운 쪽을 안 골랐다"


def test_region_boundary_handles_a_view_with_no_flat_colours():
    rgba = _rgba([[[0, 0, 0]] * 4] * 4, alpha=0)
    labels, flats = segment_colours(rgba)
    mask, colour = region_boundary(labels, flats, EDGE_DEFAULTS["threshold"])
    assert not mask.any()
    assert colour.shape == (4, 4, 3)


def test_edge_mode_defaults_to_region():
    # 아티스트가 신고한 결함이 change의 동작이다. 기본을 결함 쪽에 두면 고친 것을
    # 보려고 스위치를 찾아야 한다.
    assert EDGE_DEFAULTS["edgeMode"] == "region"
    assert set(EDGE_MODES) == {"region", "change"}


def test_edge_mode_picks_which_detection_runs():
    # 중앙차분(k=3)은 문턱을 넘는 고지의 왼쪽 끝인 x=3에, 라벨 경계는 두 색이 실제로
    # 맞닿는 x=5에 획을 세운다. 어느 자리에 섰는지로 어느 검출이 돌았는지 갈린다.
    red, black = [200, 20, 40], [10, 10, 10]
    rgba = _rgba([[red] * 6 + [black] * 6] * 8)
    line = np.zeros((8, 12), np.uint8)
    opts = {**EDGE_DEFAULTS, "width": 1, "gap": 0, "minLength": 1}
    change = build_overlay(rgba, line, {**opts, "edgeMode": "change"})
    region = build_overlay(rgba, line, {**opts, "edgeMode": "region"})
    assert int(change[..., 3].sum(0).argmax()) == 3, "change가 옛 검출을 안 썼다"
    assert int(region[..., 3].sum(0).argmax()) == 5, "region이 라벨 경계를 안 썼다"


def test_edge_mode_absent_behaves_as_region():
    # 프런트가 이 키를 안 실어 보내도 기본 동작이어야 한다.
    red, black = [200, 20, 40], [10, 10, 10]
    rgba = _rgba([[red] * 6 + [black] * 6] * 8)
    line = np.zeros((8, 12), np.uint8)
    opts = {k: v for k, v in EDGE_DEFAULTS.items() if k != "edgeMode"}
    opts = {**opts, "width": 1, "gap": 0, "minLength": 1}
    without = build_overlay(rgba, line, opts)
    explicit = build_overlay(rgba, line, {**opts, "edgeMode": "region"})
    assert (without == explicit).all(), "키가 없을 때와 region을 줬을 때가 다르다"


def test_build_overlay_region_gate_catches_a_seam_the_raw_threshold_would_reject():
    # region의 게이트는 threshold(24)가 아니라 REGION_GATE_SCALE을 곱인 값(16)이다
    # (REGION_GATE_SCALE 주석 참고) — 두 평평한 대표색이 20만큼 갈리는 경계를
    # 준다. 16 < 20 < 24라 스케일된 게이트는 잡고, 스케일 안 된 원 문턱이었다면
    # 놓쳤을 자리다.
    gate = round(EDGE_DEFAULTS["threshold"] * REGION_GATE_SCALE)
    assert gate == 16, f"이 테스트가 겨눈 게이트 값 자체가 달라졌다: {gate}"

    a, b = [100, 100, 100], [120, 100, 100]        # 채널 최대차 20
    rgba = _rgba([[a] * 6 + [b] * 6] * 8)
    # 픽스처가 실제로 20만큼 갈리는지는 만든 값을 믿지 않고 segment_colours의
    # 산출물로 확인한다.
    labels, flats = segment_colours(rgba)
    assert len(flats) == 2, "두 색이 각자 영역이 돼야 게이트를 시험할 수 있다"
    diff = int(np.abs(flats[0].astype(np.int16) - flats[1].astype(np.int16)).max())
    assert diff == 20, f"픽스처의 대표색 차가 20이 아니다: {diff}"
    assert gate < diff < EDGE_DEFAULTS["threshold"], (
        "픽스처가 게이트(16)와 원 문턱(24) 사이를 안 겨눴다")

    line = np.zeros((8, 12), np.uint8)
    opts = {**EDGE_DEFAULTS, "width": 1, "gap": 0, "minLength": 1}
    region = build_overlay(rgba, line, {**opts, "edgeMode": "region"})
    assert region[..., 3].max() > 0, (
        "region이 20짜리 경계를 놓쳤다 — 게이트가 원 문턱처럼 동작하고 있다")

    # change는 이 변경과 무관해야 한다. 20은 change의 raw 문턱(24) 아래라
    # change 방식(k=3 중앙차분)으로 재도 원래부터 기각된다 — 이 변경 전후로
    # 똑같이 아무것도 못 찾아야 한다.
    change = build_overlay(rgba, line, {**opts, "edgeMode": "change"})
    assert change[..., 3].max() == 0, "change의 동작이 이 변경으로 달라졌다"


def test_build_overlay_region_gate_still_rejects_a_seam_below_it():
    # 게이트를 낮췄다고 다 열리면 안 된다 — 10은 스케일된 게이트(16)에도 원
    # 문턱(24)에도 못 미친다. 이 테스트는 이 변경 전에도 이미 통과해야 한다.
    a, b = [100, 100, 100], [110, 100, 100]        # 채널 최대차 10
    rgba = _rgba([[a] * 6 + [b] * 6] * 8)
    labels, flats = segment_colours(rgba)
    assert len(flats) == 2, "두 색이 각자 영역이 돼야 게이트를 시험할 수 있다"
    diff = int(np.abs(flats[0].astype(np.int16) - flats[1].astype(np.int16)).max())
    assert diff == 10, f"픽스처의 대표색 차가 10이 아니다: {diff}"

    line = np.zeros((8, 12), np.uint8)
    opts = {**EDGE_DEFAULTS, "width": 1, "gap": 0, "minLength": 1}
    region = build_overlay(rgba, line, {**opts, "edgeMode": "region"})
    assert region[..., 3].max() == 0, "게이트 아래인데 획을 그었다"


def test_colour_change_reports_the_darker_side_colour():
    # 시안의 빨간 획이 전부 어두운 영역 가장자리에 놓여 있었다 — 어두운 쪽을 쓴다.
    # 6칸씩(옛 4칸 픽스처는 k=3 중앙차분이 계산할 폭이 없어 넓혔다) — 경계는
    # x=3 한 칸(고지의 왼쪽 끝)에만 선다.
    light, dark = [200, 200, 200], [30, 20, 10]
    rgba = _rgba([[light] * 6 + [dark] * 6] * 3)
    mask, colour = colour_change(rgba, EDGE_DEFAULTS["threshold"])
    assert (colour[mask] == dark).all()


def test_colour_change_detects_a_step_blurred_across_three_pixels():
    # 아티스트 파일 실측(머리 두 레이어 RGB (157,140,113)/(184,164,127), 채널
    # 최대 차 27로 문턱 24를 넘지만 안티에일리어싱으로 3px에 걸쳐 있어 인접
    # 단계는 9~13밖에 안 된다)을 본뜬 픽스처. A→B 사이에 중간값 셋을 두어
    # 인접 픽셀 단계는 전부 8(<24)이지만 A-B 총 차는 32(>24)다.
    #
    # RED(이 테스트를 고치기 전 옛 인접-비교 colour_change로 실측):
    # mask.any() == False — 옛 코드는 인접 쌍만 보므로 8 < 24를 넘는 쌍이
    # 하나도 없어 아무것도 못 찾는다. 이것이 아티스트 파일에서 머리가 빈
    # 면으로 나가던 바로 그 버그다.
    a, b = [100, 100, 100], [132, 100, 100]
    mid = [[108, 100, 100], [116, 100, 100], [124, 100, 100]]   # 단계마다 8
    row = [a] * 3 + mid + [b] * 3
    rgba = _rgba([row] * 3)
    mask, colour = colour_change(rgba, EDGE_DEFAULTS["threshold"])
    assert mask.any(), "안티에일리어싱에 걸친 색 단차를 놓쳤다 — 아티스트의 버그"
    # 어두운 쪽(채널 합이 작은 쪽) = a(300) < b(332).
    assert (colour[mask] == a).all(), "경계 색이 어두운 쪽이 아니다"


def test_colour_change_keeps_a_hard_step_thin_not_a_band_two_k_wide():
    # 안티에일리어싱이 전혀 없는 완전한 계단에서도 경계는 얇아야 한다. 중앙차분만
    # 쓰고 비최대 억제가 없으면, 문턱을 넘는 자리가 2*ANTIALIAS_RADIUS(=6)px 폭
    # 고지를 이뤄 이미 정상 동작하던 파일까지 획 수가 거의 두 배로 뛴다(설계
    # 문서 참고) — 비최대 억제가 그 고지를 능선 한 줄로 되돌린다.
    red, black = [200, 20, 40], [10, 10, 10]
    rgba = _rgba([[red] * 6 + [black] * 6] * 3)
    mask, _ = colour_change(rgba, EDGE_DEFAULTS["threshold"])
    hit_cols = np.nonzero(mask[0])[0]
    assert hit_cols.size == 1, (
        f"경계가 얇지 않다 — {hit_cols.size}칸이 걸렸다"
        f"(2*ANTIALIAS_RADIUS={2 * ANTIALIAS_RADIUS}px 고지가 그대로 남았다는 신호)"
    )


def test_colour_change_still_ignores_colour_against_transparency_even_with_a_real_difference():
    # 기존 실루엣 테스트는 양쪽이 우연히 같은 색이라(투명 쪽도 명목상 "red") 그
    # 자체로는 색이 다른 게 아니어서 실루엣 판정을 강하게 겨누지 못한다. 여기서는
    # 실제로 색이 갈리는 자리를 투명과 맞붙인다 — 반대쪽이 불투명이었다면 경계로
    # 잡혔을 만큼 큰 차(190)를 준다.
    red, black = [200, 20, 40], [10, 10, 10]
    rgba = _rgba([[red] * 6 + [black] * 6] * 3)
    rgba[:, 6:, 3] = 0                     # 검정 쪽 절반을 투명하게
    mask, _ = colour_change(rgba, EDGE_DEFAULTS["threshold"])
    assert not mask.any(), "불투명-투명 경계가 색 경계로 잡혔다"


from psd_engine.edges import (ANTIALIAS_RADIUS, _grow_diamond, _morph,
                              build_overlay, drop_small, label_components,
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


# 이 두 테스트는 reconnect_to_lines(커밋 1의 주제)만 겨눈다 — width는 5로 고정해
# 둔다. EDGE_DEFAULTS를 그대로 쓰면(커밋 2 이후 width 기본값 0 = 자동) 여기서
# "라인" 대신 쓴 두꺼운 사각 블록(예: 아래 60px짜리)이 진짜 라인처럼 측정되어
# _auto_width가 아주 굵은 획을 고르고, 그 굵기 자체의 팽창만으로 두 어서션이 뜻과
# 다른 이유로 통과/실패하게 된다 — reconnect 여부와 무관한 잡음이 섞인다. 커밋
# 1 당시 실측한 RED/GREEN(고치기 전 out[13,9,3]==7, 고친 뒤 255)도 width=5에서 잰
# 값이므로, 그 증거와 맞는 채로 두려면 여기서 width를 고정해야 한다.
_RECONNECT_OPTS = {**EDGE_DEFAULTS, "width": 5}


def test_build_overlay_reconnects_a_boundary_that_crosses_a_line():
    # 세로 색 경계(x=9)가 가로 라인(행 14~18, 5px)을 가로지른다. subtract_lines만
    # 쓰면 gap=4로 부풀린 행 10~22(13행) 전체가 지워져 양쪽 토막이 라인에서 gap만큼
    # 뜬 채로 남는다 — 아티스트가 스크린샷으로 짚은 그 흰 틈이다. 고치기 전 실측:
    # out[13,9,3]와 out[19,9,3] 모두 7 (거의 안 보이는 블러 자락일 뿐, 진짜 획이
    # 아니다). 고친 뒤에는 255 — 라인 위아래 양쪽 모두 라인에 실제로 닿는다.
    red, black = [200, 20, 40], [10, 10, 10]
    height, width = 32, 20
    row = [red] * 10 + [black] * 10       # 경계는 x=9 (colour_change: 다른 쌍의 왼쪽 픽셀)
    rgba = _rgba([row] * height)
    line = np.zeros((height, width), np.uint8)
    line[14:19, :] = 255                  # 5px 두께 가로 라인, 전체 폭을 덮는다
    out = build_overlay(rgba, line, _RECONNECT_OPTS)
    assert out[13, 9, 3] > 200, "라인 위쪽에서 경계가 gap만큼 뜬 채로 남았다"
    assert out[19, 9, 3] > 200, "라인 아래쪽에서 경계가 gap만큼 뜬 채로 남았다"


def test_build_overlay_does_not_redraw_a_boundary_running_parallel_under_a_line():
    # 가로 색 경계(행 14)가 그 위를 덮는 라인(행 12~16) 아래, 폭 100 중 60px
    # (열 20~79)을 나란히 깔려 지나간다. gap이 있는 이유 자체가 이 구간을 다시
    # 긋지 않는 것이다 — reconnect가 이 제약을 깨면 "지우지 않는다"로 퇴화한
    # 것이다. 이 테스트는 고치기 전에도 이미 통과한다(그때도 여기는 안 그렸다) —
    # 지키려는 것은 회귀이지, 재현하려는 버그가 아니다. 열 50(라인이 시작·끝나는
    # 자리에서 각각 30px 이상 떨어진, 되살아난 가장자리보다 훨씬 안쪽)은 이 구간의
    # 한가운데다.
    red, black = [200, 20, 40], [10, 10, 10]
    height, width = 30, 100
    rgba = _rgba([[red] * width] * 15 + [[black] * width] * 15)   # 경계는 행14
    line = np.zeros((height, width), np.uint8)
    line[12:17, 20:80] = 255
    out = build_overlay(rgba, line, _RECONNECT_OPTS)
    assert out[14, 50, 3] == 0, "라인 아래 나란히 깔린 경계 한가운데가 되살아났다"
    assert out[..., 3].max() > 0, "다른 자리(라인 밖 구간)까지 사라졌다"


def test_reconnect_to_lines_follows_the_removed_path_back_to_a_surviving_piece():
    # reconnect_to_lines를 직접 겨눈다 — stroke_rgba의 폭 팽창과 블러가 섞이면
    # 살아난 마스크 자체와 그 언저리의 흐린 자락을 구분하기 어렵다. removed는
    # 열 9의 행 10~22 (subtract_lines가 gap=4로 부풀려 지운 자리), lines는 그중
    # 코어인 행 14~18. gap=4, overlap=2라 6단계 자란다: 아래쪽 살아남은 행9에서
    # 행10~15까지, 위쪽 살아남은 행23에서 행22~17까지 — 가운데 행16만 lines 코어
    # 안이라 이미 실제 라인이 덮고 있으므로 못 미쳐도 상관없다.
    from psd_engine.edges import reconnect_to_lines

    mask_after_drop = np.zeros((32, 20), bool)
    mask_after_drop[0:10, 9] = True
    mask_after_drop[23:32, 9] = True
    removed = np.zeros((32, 20), bool)
    removed[10:23, 9] = True
    lines = np.zeros((32, 20), bool)
    lines[14:19, :] = True
    out = reconnect_to_lines(mask_after_drop, removed, lines, gap=4)
    assert out[9:16, 9].all(), "라인 위쪽으로 이어진 부분이 되살아나지 않았다"
    assert out[17:23, 9].all(), "라인 아래쪽으로 이어진 부분이 되살아나지 않았다"
    # removed도 lines도 아닌 자리는 절대 되살아나지 않는다(다른 열).
    assert not out[10:23, 5].any(), "removed/lines 밖까지 되살아났다"


def test_build_overlay_auto_width_makes_a_thicker_stroke_for_thicker_line_art():
    # width=0(기본, 자동)일 때 획 굵기는 그 뷰 자신의 라인 굵기에서 나온다. 같은
    # 색 경계(x=5)에, "그 뷰의 라인"에 해당하는 참고용 라인만 다르게 둔다 — 가로
    # 런 길이 5px짜리(문서화한 실측: target 5 → width 3) vs 8px짜리(target 8 →
    # width 5). 경계와 겹치지 않는 열(20~)에 둬서 subtract_lines/reconnect
    # 결과 자체는 두 경우가 같고, 굵기 선택만 달라지게 한다.
    red, black = [200, 20, 40], [10, 10, 10]
    height, width = 40, 40
    row = [red] * 6 + [black] * 34        # 경계는 x=5, 전체 높이
    rgba = _rgba([row] * height)

    thin = np.zeros((height, width), np.uint8)
    thick = np.zeros((height, width), np.uint8)
    for r in range(5, 35, 5):
        thin[r, 20:25] = 255              # 5px 런
        thick[r, 20:28] = 255             # 8px 런

    assert _auto_width(thin, EDGE_DEFAULTS["lineAlpha"]) == 3
    assert _auto_width(thick, EDGE_DEFAULTS["lineAlpha"]) == 5

    out_thin = build_overlay(rgba, thin, EDGE_DEFAULTS)
    out_thick = build_overlay(rgba, thick, EDGE_DEFAULTS)

    def run_length(alpha_row, threshold=EDGE_DEFAULTS["lineAlpha"]):
        idx = np.nonzero(alpha_row > threshold)[0]
        return int(idx.max() - idx.min() + 1) if idx.size else 0

    row_idx = 2   # 참고용 라인이 없는 행 — 경계 자체의 획 굵기만 잰다
    thin_run = run_length(out_thin[row_idx, :, 3])
    thick_run = run_length(out_thick[row_idx, :, 3])
    assert thick_run > thin_run, (
        f"굵은 라인art({thick_run}px) 획이 얇은 것({thin_run}px)보다 굵지 않았다"
    )


def test_build_overlay_a_nonzero_width_forces_that_value_regardless_of_line_art():
    # width가 0이 아니면(오늘까지의 동작 그대로) 그 값을 그대로 강제한다 — 뷰의
    # 라인 굵기가 무엇이든 무시한다. 위 테스트와 똑같은 얇은/굵은 참고 라인
    # 두 장을 쓰되, 이번엔 opts에 명시적으로 width=3을 준다. 자동이었다면
    # 서로 다른 굵기(3 vs 5)를 골랐을 두 입력이, 강제된 width에서는 완전히
    # 같은 출력을 내야 한다 — 자동 로직이 아예 참조되지 않았다는 뜻이다.
    red, black = [200, 20, 40], [10, 10, 10]
    height, width = 40, 40
    row = [red] * 6 + [black] * 34
    rgba = _rgba([row] * height)

    thin = np.zeros((height, width), np.uint8)
    thick = np.zeros((height, width), np.uint8)
    for r in range(5, 35, 5):
        thin[r, 20:25] = 255
        thick[r, 20:28] = 255

    opts = {**EDGE_DEFAULTS, "width": 3}
    out_thin = build_overlay(rgba, thin, opts)
    out_thick = build_overlay(rgba, thick, opts)
    assert np.array_equal(out_thin, out_thick), (
        "명시적 width가 라인 굵기 자동 감지에 영향을 받았다"
    )


from psd_engine.edges import _auto_width
from psd_engine.character import find_views
from psd_engine import render as render_mod
from psd_engine.edges import _composite_colour, _union_bbox
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


def _gradient_colour_session(tmp_path, extra_top=()):
    """색 잎 둘이 **그라데이션 알파로 겹치는** 뷰 하나.

    _two_tone_session으로는 아래 비교를 못 한다 — 거기 알파가 전부 255라 어떤
    합성식을 써도 같은 값이 나와, 빠른 경로가 psd-tools와 어긋나도 "동일"이
    나온다(conftest의 alpha_overlap_psd가 같은 이유로 있다).
    """
    grad = np.tile(np.linspace(0, 255, 24, dtype=np.uint8), (20, 1))
    colours = nested_layers.Group(name="COLORS", layers=[
        make_rgb_image("dark", (40, 20, 20), 4, 2, 24, 20,
                       alpha=grad[:, ::-1].copy()),
        make_rgb_image("base", (200, 30, 60), 0, 0, 32, 24, alpha=200),
    ])
    line = make_rgb_image("LINES", (0, 0, 0), 0, 0, 4, 24)
    p = tmp_path / "gradient_colour.psd"
    write_psd(p, list(extra_top) + [
        nested_layers.Group(name="FRONT 3/4", layers=[line, colours])])
    store = SessionStore()
    return store.get(store.open(str(p)))


def test_composite_colour_fast_path_matches_psd_tools(tmp_path, monkeypatch):
    # 빠른 경로는 잎을 뷰포트로 부풀리지 않고 같은 그림을 만든다(실측 5.2~9.5배).
    # 계약은 **바이트 동일**이므로 두 경로를 직접 겨룬다.
    #
    # 두 호출이 정말 **다른 경로**였는지를 psd.composite 호출 횟수로 확인한다.
    # 이것 없이 배열만 비교하면 두 가지가 조용히 통과한다: 빠른 경로가 애초에
    # 안 걸린 경우, 그리고 edges가 FAST_MERGE를 `from .render import`로 가져와
    # monkeypatch가 안 닿는 경우. 둘 다 같은 코드를 두 번 돌므로 "동일"이 나온다.
    s = _gradient_colour_session(tmp_path)
    psd = s["psd"]
    view = find_views(s)[0]
    colour_layers = [s["layers_by_id"][i] for i in view["colourIds"]]
    box = _union_bbox(colour_layers)

    calls = []
    real = psd.composite
    monkeypatch.setattr(psd, "composite",
                        lambda **kw: (calls.append(1), real(**kw))[1])

    fast = _composite_colour(psd, colour_layers, box)
    assert not calls, "빠른 경로가 안 걸렸다 — psd.composite로 떨어졌다"

    monkeypatch.setattr(render_mod, "FAST_MERGE", False)
    slow = _composite_colour(psd, colour_layers, box)
    assert calls, "FAST_MERGE=False가 edges까지 닿지 않았다 — 두 호출이 같은 경로다"
    assert np.array_equal(fast, slow), "빠른 경로가 psd-tools와 다른 픽셀을 냈다"


def test_composite_colour_takes_the_fast_path_with_a_clipping_colour_leaf(tmp_path,
                                                                          monkeypatch):
    """
    색 잎 하나가 다른 색 잎에 클리핑돼 있어도 빠른 경로로 간다.

    납품 캐릭터 파일에서 이것이 **유일하게 남은 가드**였다 — 샘플 넷의 뷰 17개 중
    5개가 여기 걸려 3.7~4.7배를 놓치고 있었다. `merge_rgba`(내보내기)는 같은 문을
    안 여는데, 그 이유는 클리핑이 아니라 빠른 경로가 psd.composite와 원리적으로
    비트 동일이 아니어서다(render._fast_mergeable docstring). 그래서 이 옵트인은
    edges 쪽에만 있고, 그것이 실제로 걸려 있는지 여기서 지킨다.

    psd.composite 호출 횟수로 경로를 확인한다 — 픽셀만 비교하면 느린 경로로 떨어져도
    같은 값이 나와 옵트인을 지워도 통과한다.
    """
    # base는 32x24라 알파 그라데이션도 (h=24, w=32)여야 한다. 전부 255면 합성
    # 산술이 어긋나도 결과가 같아 비교가 무뎌진다(conftest의 alpha_overlap_psd 참고).
    grad = np.tile(np.linspace(0, 255, 32, dtype=np.uint8), (24, 1))
    colours = nested_layers.Group(name="COLORS", layers=[
        make_rgb_image("shade", (40, 20, 20), 4, 2, 24, 20, alpha=200),
        make_rgb_image("base", (200, 30, 60), 0, 0, 32, 24, alpha=grad),
    ])
    line = make_rgb_image("LINES", (0, 0, 0), 0, 0, 4, 24)
    p = tmp_path / "clipped_colour.psd"
    write_psd(p, [nested_layers.Group(name="FRONT 3/4", layers=[line, colours])],
              clipping=("shade",))
    store = SessionStore()
    s = store.get(store.open(str(p)))
    psd = s["psd"]
    view = find_views(s)[0]
    colour_layers = [s["layers_by_id"][i] for i in view["colourIds"]]
    assert any(l.clipping for l in colour_layers), \
        "픽스처에 클리핑 색 잎이 없다 — 이 테스트가 재는 게 없다"
    box = _union_bbox(colour_layers)

    calls = []
    real = psd.composite
    monkeypatch.setattr(psd, "composite",
                        lambda **kw: (calls.append(1), real(**kw))[1])
    fast = _composite_colour(psd, colour_layers, box)
    assert not calls, "클리핑 색 잎 때문에 느린 경로로 떨어졌다"

    monkeypatch.setattr(render_mod, "FAST_MERGE", False)
    slow = _composite_colour(psd, colour_layers, box)
    assert calls, "대비책이 psd.composite를 안 불렀다 — 비교가 공허하다"
    assert np.array_equal(fast, slow), "빠른 경로가 다른 색 그림을 냈다"


def test_composite_colour_leaves_unrelated_groups_out_of_the_composite(tmp_path,
                                                                       monkeypatch):
    # 옛 필터는 `id(l) in wanted or l.is_group()`이라 문서의 **보이는 그룹을 전부**
    # 통과시켰다. 그런 그룹은 픽셀에 아무것도 보태지 않으면서(자기 잎은 wanted에
    # 없어 걸린다) 뷰마다 뷰포트 크기로 다시 합성됐고, 그것이 이 단계 시간의
    # 절반이었다(실측 한 뷰 7.1초 → 3.6초, 그림은 바이트 동일).
    #
    # 픽셀로는 드러나지 않는 회귀라 필터 자체를 본다. 픽셀 비교로 쓰면 옛 코드
    # 에서도 통과해 아무것도 지키지 못한다.
    other = nested_layers.Group(name="OTHER", layers=[
        make_rgb_image("noise", (10, 220, 10), 0, 0, 32, 24)])
    s = _gradient_colour_session(tmp_path, extra_top=[other])
    psd = s["psd"]
    view = find_views(s)[0]
    colour_layers = [s["layers_by_id"][i] for i in view["colourIds"]]
    box = _union_bbox(colour_layers)

    # 빠른 경로는 psd.composite를 아예 안 부른다 — 필터를 보려면 대비책으로 민다.
    monkeypatch.setattr(render_mod, "FAST_MERGE", False)
    captured = {}
    real = psd.composite

    def spy(**kw):
        captured["filter"] = kw["layer_filter"]
        return real(**kw)

    monkeypatch.setattr(psd, "composite", spy)
    _composite_colour(psd, colour_layers, box)

    keep = captured["filter"]
    unrelated = next(l for l in psd.descendants() if l.name == "OTHER")
    assert not keep(unrelated), "이 뷰와 상관없는 그룹이 합성에 들어간다"
    assert all(keep(l) for l in colour_layers), "색 잎이 필터에서 걸렸다"
    assert keep(next(l for l in psd.descendants() if l.name == "COLORS")), \
        "색 잎의 조상 그룹이 걸리면 재귀가 거기서 멈춰 잎에 닿지도 못한다"


def test_composite_colour_skips_a_leaf_under_a_hidden_group(tmp_path):
    # 잎 자신의 플래그는 켜져 있고 **조상 그룹만** 꺼진 모양. 빠른 경로는 넘겨받은
    # 잎을 조건 없이 그리므로, 거기 넘길 목록을 `.visible`(자기 플래그)로 고르면
    # 이 잎이 그려진다 — 꺼진 대체 색상의 실루엣이 색 경계로 오인되는 바로 그
    # 결함이다(test_overlay_for_view_ignores_a_hidden_colour_layer의 조상판).
    #
    # find_views를 안 쓰고 id를 직접 넘긴다 — character._pixel_leaves가 숨은
    # 조상 아래로 내려가지 않으므로, find_views를 거치면 이 필터가 없어도 같은
    # 결과가 나와 무엇을 지키는 테스트인지 알 수 없어진다.
    colours = nested_layers.Group(name="COLORS", layers=[
        nested_layers.Group(name="ALT", visible=False, layers=[
            make_rgb_image("alt", (10, 200, 10), 4, 4, 8, 8)]),
        make_rgb_image("base", (200, 30, 60), 0, 0, 32, 24),
    ])
    p = tmp_path / "hidden_group_colour.psd"
    write_psd(p, [nested_layers.Group(name="FRONT 3/4", layers=[colours])])
    store = SessionStore()
    s = store.get(store.open(str(p)))
    by_name = {l.name: l for l in s["psd"].descendants()}
    both = [by_name["alt"], by_name["base"]]
    box = _union_bbox(both)

    with_alt = _composite_colour(s["psd"], both, box)
    without = _composite_colour(s["psd"], [by_name["base"]], box)
    assert np.array_equal(with_alt, without), \
        "숨은 그룹 아래의 색 잎이 그려졌다"


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


from PIL import Image as _PILImage  # noqa: E402
from PIL import ImageFilter as _PILImageFilter  # noqa: E402

from psd_engine.edges import _morph  # noqa: E402


def _pil_morph(mask, size, grow):
    """_morph의 옛 구현 그대로 — 새 구현이 갈라지지 않았음을 재는 기준자다."""
    if size <= 1:
        return mask
    size = size if size % 2 else size + 1
    f = (_PILImageFilter.MaxFilter(size) if grow
         else _PILImageFilter.MinFilter(size))
    return np.array(
        _PILImage.fromarray((mask * 255).astype(np.uint8)).filter(f)) > 127


def test_morph_matches_the_pil_rank_filter_pixel_for_pixel():
    # PIL의 랭크 필터는 커널 넓이의 제곱으로 드는데(21px면 픽셀당 441회), 실제
    # 납품 파일 한 장이 이 안에서 16분을 보냈다. 정사각 커널이면 팽창은 "창 안에
    # 켜진 픽셀이 하나라도 있는가"와 같은 말이고 그건 적분영상 네 귀퉁이로 O(1)에
    # 답할 수 있다 — 커널이 커져도 비용이 늘지 않는다.
    #
    # 바꾼 것은 속도뿐이어야 하므로 옛 구현을 그대로 기준자로 두고 한 픽셀도
    # 다르지 않은지 잰다. 특히 가장자리를 조심해서 본다: PIL은 여백을 복사하는
    # 것이 아니라 창을 이미지 안으로 잘라 계산하고, 제로 패딩한 적분영상이 그와
    # 같은 답을 내는지가 이 테스트의 핵심이다.
    rng = np.random.default_rng(20260807)
    cases = []

    # 가장자리·모서리에 정확히 걸친 것들 — 여백 규칙이 갈리면 여기서 갈린다.
    for h, w in ((9, 9), (12, 7)):
        for spot in ((0, 0), (0, w - 1), (h - 1, 0), (h - 1, w - 1),
                     (0, w // 2), (h // 2, 0), (h // 2, w // 2)):
            m = np.zeros((h, w), bool)
            m[spot] = True
            cases.append(m)
        edge = np.zeros((h, w), bool)
        edge[0, :] = True                      # 위쪽 변 전체
        edge[:, -1] = True                     # 오른쪽 변 전체
        cases.append(edge)
        cases.append(np.ones((h, w), bool))    # 전부 켜짐 — 침식이 전부 지우는지
        cases.append(np.zeros((h, w), bool))   # 전부 꺼짐

    # 밀도가 다른 무작위 마스크. 성긴 쪽이 실제 경계 마스크에 가깝고, 빽빽한
    # 쪽은 침식이 실제로 깎을 것이 있는 경우를 만든다.
    for density in (0.02, 0.2, 0.8):
        for _ in range(6):
            cases.append(rng.random((13, 17)) < density)

    for size in (1, 2, 3, 5, 9, 11, 21):
        for grow in (True, False):
            for i, m in enumerate(cases):
                got = _morph(m, size, grow=grow)
                want = _pil_morph(m, size, grow=grow)
                assert got.dtype == want.dtype, f"size={size} grow={grow} 케이스 {i}"
                assert (got == want).all(), (
                    f"size={size} grow={grow} 케이스 {i}에서 갈렸다 "
                    f"({int((got != want).sum())}px)")


def test_morph_cost_does_not_grow_with_the_kernel():
    # 이 함수를 바꾼 이유 자체를 지킨다. 옛 구현은 폭 21이 폭 5의 열 배쯤 들었다.
    # 새 구현은 창 크기와 무관해야 하므로, 넓은 커널이 좁은 커널의 세 배를 넘으면
    # 제곱 비용이 어딘가로 돌아온 것이다.
    import time

    rng = np.random.default_rng(11)
    mask = rng.random((900, 900)) < 0.01

    def elapsed(size):
        best = float("inf")
        for _ in range(3):                     # 최솟값을 쓴다 — 잡음에 흔들리지 않게
            t0 = time.perf_counter()
            _morph(mask, size, grow=True)
            best = min(best, time.perf_counter() - t0)
        return best

    narrow, wide = elapsed(5), elapsed(21)
    assert wide < narrow * 3, (
        f"넓은 커널이 여전히 비싸다 (폭 5 {narrow*1000:.1f}ms, 폭 21 {wide*1000:.1f}ms)")


from psd_engine.edges import FILL_COVERAGE, _drop_filled  # noqa: E402


class _FakeLayer:
    """_paste_alpha가 보는 것만 흉내 낸다 — 좌표와 알파."""

    def __init__(self, name, left, top, alpha):
        self.name = name
        self.left, self.top = left, top
        self._alpha = alpha
        self.width, self.height = alpha.shape[1], alpha.shape[0]

    def numpy(self, channel=None):                      # pragma: no cover - 대역폭용
        raise NotImplementedError


def test_drop_filled_removes_a_fill_and_keeps_the_real_line(monkeypatch):
    # 납품 폴더에서 이름으로는 못 거르는 경우가 하나 남았다: 라인 그룹 안의
    # 잎이 `Layer 27`/`Layer 28`인데 `Layer 28`이 문서 전체 크기(9899x3240)의
    # 채우기였다. 그 알파가 뷰 박스를 100% 덮으니 획 굵기가 343px로 나왔다.
    # 같은 뷰의 진짜 라인은 6.5%다 — 잎 단위로 재야 이 둘이 갈린다.
    import psd_engine.edges as edges_module

    box = (0, 0, 100, 100)
    thin = np.zeros((100, 100), np.uint8)
    thin[50, :] = 255                                   # 한 줄짜리 선: 1% 커버
    fill = np.full((100, 100), 255, np.uint8)           # 박스를 다 덮는 채우기

    alphas = {"thin": thin, "fill": fill}
    monkeypatch.setattr(edges_module, "_paste_alpha",
                        lambda layers, _box: alphas[layers[0].name])

    kept = _drop_filled([_FakeLayer("thin", 0, 0, thin),
                         _FakeLayer("fill", 0, 0, fill)], box, 64)
    assert [l.name for l in kept] == ["thin"], \
        f"채우기가 남았거나 선이 함께 버려졌다: {[l.name for l in kept]}"


def test_drop_filled_keeps_a_line_that_is_dense_but_under_the_bound(monkeypatch):
    # 문턱 바로 아래는 반드시 남아야 한다. 실측에서 정상 뷰의 최대 cover가
    # 32.0%였고(머리카락 선이 빽빽한 뷰들) 그것들이 잘리면 이 기능이 그 뷰에서
    # 기존 선 위에 획을 덧그린다.
    import psd_engine.edges as edges_module

    dense = np.zeros((100, 100), np.uint8)
    dense[:int(FILL_COVERAGE * 100) - 5, :] = 255       # 문턱보다 5%p 아래
    monkeypatch.setattr(edges_module, "_paste_alpha", lambda layers, _box: dense)

    kept = _drop_filled([_FakeLayer("dense", 0, 0, dense)], (0, 0, 100, 100), 64)
    assert len(kept) == 1, "문턱 아래인데 버려졌다"


def test_colour_mode_paste_gives_the_same_strokes_when_nothing_is_clipped(tmp_path):
    # 두 방법이 같은 답에 도달해야 하는 경우를 못 박는다. 잎이 전부 Normal·
    # 불투명도 255·클리핑 없음이면 포토샵의 합성 모델은 단순 source-over로
    # 환원되므로, paste가 합성기와 같은 획을 내야 한다.
    #
    # 실파일에서는 이 조건이 늘 성립하지는 않는다 — 납품 폴더 83장 중 36장에
    # 클리핑 잎이 있고, 그런 뷰에서는 색 그림이 실제로 갈린다(실측 알파 일치
    # 58.7%). 그 경우 어느 쪽 획이 옳은지는 사람이 봐야 하므로 옵션으로 뒀다.
    s = _two_tone_session(tmp_path)
    view = find_views(s)[0]
    a = overlay_for_view(s, view["colourIds"], view["lineIds"],
                         {**EDGE_DEFAULTS, "colourMode": "composite"})
    b = overlay_for_view(s, view["colourIds"], view["lineIds"],
                         {**EDGE_DEFAULTS, "colourMode": "paste"})
    assert a is not None and b is not None, "한쪽이 획을 아예 못 그렸다"
    assert (a[0][..., 3] > 0).sum() > 0, "픽스처에 획이 없다 — 테스트가 무의미하다"
    assert ((a[0][..., 3] > 0) == (b[0][..., 3] > 0)).all(), (
        "클리핑이 없는데도 두 방법의 획이 갈렸다 "
        f"(합성 {(a[0][..., 3] > 0).sum()}px, paste {(b[0][..., 3] > 0).sum()}px)")
    assert (a[1], a[2]) == (b[1], b[2]), "오버레이 위치가 달라졌다"


def test_colour_mode_defaults_to_the_composite_path(tmp_path):
    # 기본값이 지금까지의 동작이어야 한다. 옵션을 안 주면 예전 결과 그대로다 —
    # 프런트가 이 키를 안 실어 보내도 안전하다는 뜻이기도 하다.
    assert EDGE_DEFAULTS["colourMode"] == "composite"
    s = _two_tone_session(tmp_path)
    view = find_views(s)[0]
    opts_without = {k: v for k, v in EDGE_DEFAULTS.items() if k != "colourMode"}
    a = overlay_for_view(s, view["colourIds"], view["lineIds"], opts_without)
    b = overlay_for_view(s, view["colourIds"], view["lineIds"],
                         {**EDGE_DEFAULTS, "colourMode": "composite"})
    assert (a[0] == b[0]).all(), "키가 없을 때와 composite를 줬을 때가 다르다"


def test_stroke_rgba_paints_every_pixel_it_makes_visible():
    # 알파는 블러로 thick 밖까지 넓어지는데 색은 thick 안에만 칠하면, 자락이
    # (0,0,0)으로 남아 모든 생성 획에 **검은 후광**이 둘린다. 실측 한 뷰에서
    # 알파>0 픽셀 10204개 중 4296개(42.1%)가 그랬고 전부 thick 밖이었다.
    from psd_engine.edges import label_components, stroke_rgba

    mask = np.zeros((16, 16), bool)
    mask[:, 8] = True
    labels, _ = label_components(mask)
    colour = np.zeros((16, 16, 3), np.uint8)
    colour[mask] = [150, 140, 110]
    out = stroke_rgba(mask, labels, colour, 5)
    visible = out[..., 3] > 0
    unpainted = visible & (out[..., :3].max(2) == 0)
    assert visible.any(), "픽스처에 획이 없다 — 테스트가 무의미하다"
    assert not unpainted.any(), (
        f"알파는 있는데 색이 안 칠해진 픽셀이 {int(unpainted.sum())}개다 — 검은 후광")


def test_stroke_rgba_paints_a_fringe_pixel_from_the_nearer_fragment():
    # 위 테스트는 "칠해지긴 했다"만 본다 — BLUR_REACH이 늘린 링이 실제로
    # 쓰이는지, 그 자리에서 색이 **맞는** 조각(더 가까운 쪽) 걸로 칠해지는지는
    # 안 본다. 기존 "contested ground" 테스트(폭 11 배열, 라벨 간격 7px)로는
    # 이걸 못 잰다 — 배열이 좁아 3번째 링(=size//2, BLUR_REACH 이전)에서 이미
    # 다 채워지고, BLUR_REACH가 더한 링은 리포트가 확인한 대로 그 픽스처에서
    # 아무것도 안 바꾼다.
    #
    # 그래서 두 조각을 thick끼리 안 닿을 만큼 떼어(gap), 그 사이 픽셀이 r=2
    # 링만으로는 못 닿고 r+BLUR_REACH=4 링이어야만 닿게 잡는다. 라벨 1은
    # x=20, 라벨 2는 x=27 — 간격 7px(홀수라 정확히 가운데서 동점이 안 난다).
    # width=5 -> r=2, thick는 [18,22]와 [25,29]. 그 사이 x=23,24가
    # no-man's-land: x=23은 라벨1까지 3px·라벨2까지 4px(라벨1이 더 가깝다),
    # x=24는 그 반대(라벨2가 더 가깝다) — 둘 다 r=2보다 멀어(3px, 4px)
    # BLUR_REACH 없이는 절대 안 닿고, r+BLUR_REACH=4 안에는 들어와 실제로
    # 칠해진다(실측: 두 자리 모두 alpha=65, BLUR_REACH=0으로 되돌리면 두 자리
    # 다 알파는 그대로 65인데 색은 (0,0,0)으로 남는다 — task-4-report.md의
    # BLUR_REACH=0 실행 기록 참고).
    N = 47
    xa, xb = 20, 27
    mask = np.zeros((1, N), bool)
    mask[0, xa] = True
    mask[0, xb] = True
    labels, _ = label_components(mask)
    colour_a, colour_b = [10, 20, 30], [200, 210, 220]
    colour = np.zeros((1, N, 3), np.uint8)
    colour[0, xa] = colour_a
    colour[0, xb] = colour_b
    out = stroke_rgba(mask, labels, colour, width=5)
    thick = _morph(mask, 5, grow=True)
    assert not thick[0, 23] and not thick[0, 24], "픽스처가 thick 밖을 안 겨눴다"
    assert out[0, 23, 3] > 0 and out[0, 24, 3] > 0, (
        "이 자리에 알파가 없다 — 테스트가 무의미하다")
    assert tuple(out[0, 23, :3]) == tuple(colour_a), \
        "라벨1(x=20)에 더 가까운 x=23이 검거나 라벨2 색으로 칠해졌다"
    assert tuple(out[0, 24, :3]) == tuple(colour_b), \
        "라벨2(x=27)에 더 가까운 x=24가 검거나 라벨1 색으로 칠해졌다"


def test_stroke_rgba_paints_a_diagonal_junction_with_no_black_halo():
    # 위 두 후광 테스트(수직/수평 픽스처)는 축에 나란한 마스크만 겨눈다. 실제
    # region_boundary 출력은 굽고 대각선이고, 세 영역이 만나는 자리에는 이음매가
    # 생긴다 — _morph의 정사각 커널과 stroke_rgba의 링 팽창이 대각선으로 꺾이는
    # 자리에서도 검은 후광 없이 칠하는지는 축에 나란한 픽스처로는 안 잰다.
    #
    # 조각 A는 (5,5)에서 (11,11)까지 내려가는 대각선, 조각 B는 (13,11)에서
    # (19,5)까지 반대 방향으로 꺾이는 대각선이다 — 둘이 꼭짓점 근처에서 각을
    # 이루며 만나되(두 끝점이 (11,11)·(13,11)로 가깝다) 서로 안 닿아 label_
    # components가 둘을 별개 조각으로 가른다(실측: count==2). width=5(반지름 2)라
    # thick끼리도 안 닿고, 그 사이는 BLUR_REACH가 더한 링이 있어야만 칠해진다
    # (실측: BLUR_REACH=0으로 두면 이 마스크에서 271개 보이는 픽셀 중 129개가
    # 알파는 있는데 색은 (0,0,0)인 채로 남는다).
    red_side, blue_side = [10, 20, 30], [200, 210, 220]
    h, w = 40, 40
    mask = np.zeros((h, w), bool)
    colour = np.zeros((h, w, 3), np.uint8)
    seg_a = [(r, r) for r in range(5, 12)]
    seg_b = [(r, 24 - r) for r in range(13, 20)]
    for r, c in seg_a:
        mask[r, c] = True
        colour[r, c] = red_side
    for r, c in seg_b:
        mask[r, c] = True
        colour[r, c] = blue_side

    labels, count = label_components(mask)
    assert count == 2, "픽스처가 한 조각으로 붙었다 — 두 대표색을 겨눌 수 없다"

    out = stroke_rgba(mask, labels, colour, width=5)
    visible = out[..., 3] > 0
    unpainted = visible & (out[..., :3].max(2) == 0)
    assert visible.any(), "픽스처에 획이 없다 — 테스트가 무의미하다"
    assert not unpainted.any(), (
        f"대각선 이음매에 알파는 있는데 색이 안 칠해진 픽셀이 {int(unpainted.sum())}개다"
        " — 검은 후광")


def test_paste_colour_applies_the_layers_mask(tmp_path):
    # topil()은 래스터 마스크를 적용하지 않는다. paste가 그걸 쓰면 가려진 자리가
    # 불투명하게 남아, 실제로는 없는 색 경계가 생기고 그 자리에 가짜 획이 그어진다
    # (_paste_alpha가 라인 쪽에서 이미 당한 것과 같은 함정이다).
    from psd_engine.edges import _paste_colour

    apply_pytoshop_patches()
    fill = make_rgb_image("base", (200, 30, 60), 0, 0, 8, 8)
    psd = nested_layers.nested_layers_to_psd(
        [fill], color_mode=_pt_enums.ColorMode.rgb, size=(8, 8))
    mask = np.zeros((8, 8), np.uint8)
    mask[:, :4] = 255                      # 왼쪽 절반만 보이게
    attach_mask(psd, "base", mask, left=0, top=0, default_color=0)
    p = tmp_path / "masked_colour.psd"
    with open(p, "wb") as f:
        psd.write(f)
    store = SessionStore()
    s = store.get(store.open(str(p)))
    layer = next(l for l in s["layers_by_id"].values() if l.name == "base")
    out = _paste_colour([layer], (0, 0, 8, 8))
    assert out[:, 4:, 3].max() == 0, "마스크로 가려진 자리가 불투명하게 남았다"
    assert out[:, :4, 3].max() > 0, "마스크로 가려지지 않은 자리까지 지워졌다"


def test_grow_diamond_stays_inside_the_square_of_the_same_radius():
    """
    마름모 팽창은 같은 반지름의 정사각 팽창에 **포함**되고, 대각선에서 실제로 덜
    자란다. 두 조건이 다 필요하다 — 포함만 보면 아무것도 안 자라는 구현이 통과하고,
    "덜 자란다"만 보면 엉뚱한 자리로 자라는 구현이 통과한다.

    포함 관계가 곧 `stroke_rgba`가 라벨 키우기를 정사각으로 남겨둔 근거다: 색이 획을
    항상 덮으므로 검은 후광(BLUR_REACH 주석)이 되살아나지 않는다.

    **`stroke_rgba`가 실제로 이걸 쓰는지도 여기서 본다.** 함수만 따로 재면 호출부를
    정사각으로 되돌려도 통과한다 — 첫 판이 그랬다. 그리고 갈리는 자리는 대각선뿐이다:
    수평선의 세로 단면은 두 방식이 **완전히 같아서**, 직선으로 재는 테스트는 아무것도
    못 가른다.
    """
    mask = np.zeros((9, 9), bool)
    mask[4, 4] = True
    dia = _grow_diamond(mask, 1)
    sq = _morph(mask, 3, grow=True)
    assert (dia & ~sq).sum() == 0, "마름모가 정사각 밖으로 자랐다"
    assert dia[3, 4] and dia[4, 3], "상하좌우로 안 자랐다"
    assert not dia[3, 3], "대각선까지 자랐다 — 정사각과 다를 게 없다"
    assert sq[3, 3], "픽스처가 잘못됐다: 정사각이 대각선으로 안 자란다"

    colour = np.zeros((9, 9, 3), np.uint8)
    colour[4, 4] = [10, 10, 10]
    labels, _ = label_components(mask)
    alpha = stroke_rgba(mask, labels, colour, width=3)[..., 3]
    axis, diag = int(alpha[3, 4]), int(alpha[3, 3])
    # 이 비율은 팽창 모양과 STROKE_BLUR 둘 다에 걸린다 — 어느 쪽을 건드려도 여기서
    # 걸리므로, 굵기가 조용히 움직이는 일은 없다. 실측: 마름모+σ0.6은 56/161=0.35,
    # 정사각+σ0.6은 184/213=0.86, 마름모+σ0.8도 0.5를 넘는다.
    assert diag < axis * 0.5, (
        f"획이 대각선으로 더 자랐다 (축 {axis}, 대각 {diag}) — 팽창 모양이 정사각으로 "
        "돌아갔거나 STROKE_BLUR가 커졌다. 둘 다 획을 굵게 만든다")


def test_stroke_rgba_keeps_an_opaque_core_when_it_thins_the_stroke():
    """
    획을 얇게 만들되 **흐려지면 안 된다** — 아티스트가 요구한 것은 굵기이지 농도가
    아니다.

    굵기를 width로 줄이는 길이 여기서 막힌다. width 1은 팽창이 없어 1px 마스크에
    블러만 걸리므로 심이 옅어진다. 실제 경계에서는 알파 중앙값이 190에서 41까지
    떨어졌고, 기존 선과 맞닿는 픽셀도 347에서 175로 절반이 됐다.

    **대각선으로 잰다.** 수평선은 이 성질을 못 잡는다 — 깨끗한 가로 1px 선은 작은
    블러를 잘 견뎌서, STROKE_BLUR를 0.4로 내린 뒤에는 팽창 없이도 217이 나왔다(첫
    판이 그래서 깨졌다). 실제 색 경계는 대부분 대각이거나 계단이고, 거기서는 팽창이
    있고 없고가 251 대 187로 갈린다.

    블러가 걸리므로 심도 정확히 255는 아니다.
    """
    mask = np.zeros((11, 21), bool)
    for i in range(1, 10):
        mask[i, i + 2] = True
    colour = np.zeros((11, 21, 3), np.uint8)
    colour[mask] = [10, 10, 10]
    labels, _ = label_components(mask)

    out = stroke_rgba(mask, labels, colour, width=3)[..., 3]
    assert int(out.max()) >= 240, "획의 심이 옅어졌다"

    bare = stroke_rgba(mask, labels, colour, width=1)[..., 3]
    assert int(bare.max()) < int(out.max()) * 0.85, (
        f"팽창이 있으나 없으나 심의 농도가 같다 (있음 {int(out.max())}, "
        f"없음 {int(bare.max())}) — 이 픽스처는 농도 손실을 못 잡는다")


def _two_tone_psd(tmp_path, name, colours_opacity=255, view_opacity=255):
    """_two_tone_session과 같은 판. 색 그룹/뷰 그룹의 불투명도만 손잡이로 뺐다."""
    colours = nested_layers.Group(name="COLORS", opacity=colours_opacity, layers=[
        make_rgb_image("dark", (40, 20, 20), 0, 0, 32, 12),
        make_rgb_image("base", (200, 30, 60), 0, 0, 32, 24),
    ])
    line = make_rgb_image("LINES", (0, 0, 0), 0, 0, 4, 24)
    p = tmp_path / name
    write_psd(p, [nested_layers.Group(name="FRONT 3/4", opacity=view_opacity,
                                      layers=[line, colours])])
    store = SessionStore()
    return store.get(store.open(str(p)))


def test_overlay_ignores_translucent_colour_ancestors(tmp_path):
    # 아티스트는 색 참조를 선화 위에 반투명으로 얹어 두곤 한다(실납품에서 캐릭터
    # 그룹 36/255짜리 판). 검출용 색 합성이 그 불투명도를 그대로 적용하면 알파
    # 14% 유령 그림이 검출기에 들어가 획이 0이 된다 — 획은 불투명 쌍둥이 판과
    # **바이트까지 같아야** 한다(전수 감사 337/337 동일이 이 계약의 근거다).
    opaque = _two_tone_psd(tmp_path, "불투명.psd")
    translucent = _two_tone_psd(tmp_path, "반투명.psd",
                                colours_opacity=36, view_opacity=128)
    ov = find_views(opaque)[0]
    tv = find_views(translucent)[0]
    o_rgba, o_left, o_top = overlay_for_view(opaque, ov["colourIds"],
                                             ov["lineIds"], EDGE_DEFAULTS)
    t_rgba, t_left, t_top = overlay_for_view(translucent, tv["colourIds"],
                                             tv["lineIds"], EDGE_DEFAULTS)
    assert o_rgba[..., 3].max() > 0
    assert (t_left, t_top) == (o_left, o_top)
    assert t_rgba.tobytes() == o_rgba.tobytes(), \
        "반투명 판의 획이 불투명 판과 다르다 — 불투명도 중화가 안 먹은 것"


def test_overlay_restores_opacities_afterwards(tmp_path):
    # 세션의 psd 객체는 뒤이은 요청들이 그대로 읽는다 — 중화는 합성 동안만이고
    # 원값이 반드시 되돌아와야 한다(내보내기·병합은 원본 불투명도 의미를 쓴다).
    s = _two_tone_psd(tmp_path, "복원.psd", colours_opacity=36, view_opacity=128)
    view = find_views(s)[0]
    layers = list(s["layers_by_id"].values())
    before = [(l.name, l.opacity) for l in layers]
    overlay_for_view(s, view["colourIds"], view["lineIds"], EDGE_DEFAULTS)
    assert [(l.name, l.opacity) for l in layers] == before
