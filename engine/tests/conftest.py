import numpy as np
import pytest
from pytoshop import enums
from pytoshop.user import nested_layers

from psd_engine.patches import apply_pytoshop_patches

CANVAS_W, CANVAS_H = 64, 48


def make_image(name, value, x, y, w, h, alpha=255, visible=True, blend=None):
    px = np.full((h, w), value, np.uint8)
    a = np.full((h, w), alpha, np.uint8)
    return nested_layers.Image(
        name=name, channels={0: px, 1: px, 2: px, -1: a},
        top=y, left=x, opacity=255, visible=visible,
        blend_mode=blend or enums.BlendMode.normal,
    )


def write_psd(path, layers_top_first, width=CANVAS_W, height=CANVAS_H):
    apply_pytoshop_patches()
    psd = nested_layers.nested_layers_to_psd(
        layers_top_first, color_mode=enums.ColorMode.rgb, size=(width, height)
    )
    with open(path, "wb") as f:
        psd.write(f)
    return str(path)


@pytest.fixture
def fixture_psd(tmp_path):
    # 리스트는 index 0 = 최상단. 문서 아래→위 = *ART(fill, hidden line, line, lines), -REF(line)
    art = nested_layers.Group(name="*ART", layers=[
        make_image("lines", 200, 10, 10, 20, 10),
        nested_layers.Group(name="BG", layers=[
            make_image("line", 50, 0, 0, 32, 24),
            make_image("hidden line", 77, 5, 5, 4, 4, visible=False),
            make_image("fill", 128, 0, 0, 64, 48),
        ]),
    ])
    ref = nested_layers.Group(name="-REF", layers=[
        make_image("line", 10, 0, 0, 8, 8),
    ])
    p = tmp_path / "fixture.psd"
    write_psd(p, [ref, art])
    return p


@pytest.fixture
def blend_mode_psd(tmp_path):
    """
    아래에 흰 'base'(255), 그 위에 MULTIPLY 'shade'(64)가 얹힌 문서.

    원본 스택 안에서 합성하면 곱연산이 적용돼 어두워지지만, export_psd는 모든
    레이어를 normal/255로 기록하므로 내보낸 PSD에서는 shade가 그냥 그대로
    덮인다. 미리보기가 어느 쪽을 재현하는지 가르는 픽스처다.
    """
    p = tmp_path / "blend.psd"
    write_psd(p, [
        make_image("shade", 64, 0, 0, 16, 16, blend=enums.BlendMode.multiply),
        make_image("base", 255, 0, 0, 32, 32),
    ], width=32, height=32)
    return p
