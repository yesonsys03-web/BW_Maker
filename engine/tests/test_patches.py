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


def test_patched_pytoshop_writes_zero_length_mask_for_default_layers(tmp_path):
    """Verify that pytoshop patch writes zero-length mask section for layers without masks.
    This ensures psd-tools reads layer.mask as None instead of an empty Mask object."""
    from psd_engine.patches import apply_pytoshop_patches

    apply_pytoshop_patches()

    from psd_tools import PSDImage
    from pytoshop import enums
    from pytoshop.user import nested_layers

    a = np.full((10, 10), 200, np.uint8)
    img = nested_layers.Image(
        name="test_layer", channels={0: a, 1: a, 2: a, -1: a},
        top=0, left=0, opacity=255, visible=True,
        blend_mode=enums.BlendMode.normal,
    )
    psd = nested_layers.nested_layers_to_psd(
        [img], color_mode=enums.ColorMode.rgb, size=(10, 10)
    )
    path = tmp_path / "test_mask.psd"
    with open(path, "wb") as f:
        psd.write(f)

    # Re-open and verify layer.mask is None (not just empty)
    out = PSDImage.open(path)
    layer = list(out)[0]
    assert layer.mask is None, "Layer without mask data should have layer.mask = None"


def test_numpy_decode_prediction_matches_psd_tools_byte_for_byte():
    """cumsum 경로가 원 구현과 **바이트** 동일한지 — 8/16비트, 여러 모양.

    16비트에서 무작위 데이터가 중요하다: 출력이 빅엔디언이어야 하는데,
    0x0000·0xFFFF 위주 데이터(그라데이션류)는 바이트 순서에 불변이라
    네이티브로 내보내는 변이를 못 잡는다.
    """
    import random

    from psd_engine import patches

    assert patches._original_decode_prediction is not None  # conftest가 이미 걸었다
    rng = random.Random(20260818)
    for depth in (8, 16):
        for w, h in ((1, 5), (7, 3), (256, 2), (11717, 2)):
            data = bytes(rng.randrange(256) for _ in range(w * h * (depth // 8)))
            got = patches._fast_decode_prediction(data, w, h, depth)
            ref = patches._original_decode_prediction(data, w, h, depth)
            assert got == ref, (depth, w, h)


def test_numpy_decode_prediction_is_what_decompress_calls():
    """패치가 실제로 걸려 있고, 압축→해제 왕복이 원본 바이트를 돌려준다."""
    import psd_tools.compression as compression
    from psd_tools.constants import Compression

    from psd_engine import patches

    assert compression.decode_prediction is patches._fast_decode_prediction

    row = bytes(range(256)) * 4
    comp = compression.compress(row, Compression.ZIP_WITH_PREDICTION, 512, 2, 8)
    assert compression.decompress(comp, Compression.ZIP_WITH_PREDICTION, 512, 2, 8) == row


def test_numpy_decode_prediction_leaves_odd_shapes_to_the_original():
    """길이 불일치·미지원 깊이는 원 구현으로 — 오류 경로까지 그대로."""
    import random

    import pytest

    from psd_engine import patches

    rng = random.Random(7)
    # depth 32는 _restore_byte_order까지 있는 원 구현 몫이다
    data32 = bytes(rng.randrange(256) for _ in range(4 * 3 * 2))
    got = patches._fast_decode_prediction(data32, 3, 2, 32)
    ref = patches._original_decode_prediction(data32, 3, 2, 32)
    assert got == ref
    # 16비트 홀수 길이: array.array('H', ...)의 ValueError 그대로
    with pytest.raises(ValueError):
        patches._fast_decode_prediction(b"\x00" * 5, 2, 2, 16)
    # 8비트 짧은 데이터: 델타 루프의 IndexError 그대로
    with pytest.raises(IndexError):
        patches._fast_decode_prediction(b"\x00" * 3, 4, 2, 8)


def test_apply_psd_tools_decode_patch_is_idempotent():
    import psd_tools.compression as compression

    from psd_engine import patches
    from psd_engine.patches import apply_psd_tools_decode_patch

    apply_psd_tools_decode_patch()
    apply_psd_tools_decode_patch()
    assert compression.decode_prediction is patches._fast_decode_prediction
    # 두 번 걸어도 원본이 패치 함수로 덮이지 않는다
    assert patches._original_decode_prediction is not patches._fast_decode_prediction
