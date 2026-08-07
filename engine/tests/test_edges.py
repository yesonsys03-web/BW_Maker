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
