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
