import numpy as np


def test_patched_pytoshop_writes_rle_psd_with_clean_names(tmp_path):
    from psd_engine.patches import apply_pytoshop_patches

    apply_pytoshop_patches()
    apply_pytoshop_patches()  # 멱등성

    from psd_tools import PSDImage
    from pytoshop import enums
    from pytoshop.user import nested_layers

    a = np.full((10, 10), 200, np.uint8)
    img = nested_layers.Image(
        name="한글layer", channels={0: a, 1: a, 2: a, -1: a},
        top=2, left=3, opacity=255, visible=True,
        blend_mode=enums.BlendMode.normal,
    )
    psd = nested_layers.nested_layers_to_psd(
        [img], color_mode=enums.ColorMode.rgb, size=(20, 15)
    )
    path = tmp_path / "out.psd"
    with open(path, "wb") as f:
        psd.write(f)

    out = PSDImage.open(path)
    assert (out.width, out.height) == (20, 15)
    layer = list(out)[0]
    assert layer.name == "한글layer"          # 후행 NUL 없음
    assert layer.bbox == (3, 2, 13, 12)
    arr = np.array(layer.topil().convert("RGBA"))
    assert arr.shape == (10, 10, 4)
    assert (arr == 200).all()
