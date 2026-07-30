import numpy as np
from psd_tools import PSDImage

from psd_engine.render import extract_rgba, merge_rgba, render_preview, render_thumbnails
from psd_engine.tree import build_tree


def _session(path):
    psd = PSDImage.open(path)
    built = build_tree(psd)
    return {"psd": psd, "layers_by_id": built["layers_by_id"]}


def test_extract_rgba(fixture_psd):
    s = _session(fixture_psd)
    arr = extract_rgba(s["layers_by_id"][4])   # 'line' value=50, 32x24
    assert arr.shape == (24, 32, 4)
    assert (arr[..., :3] == 50).all() and (arr[..., 3] == 255).all()


def test_merge_rgba_overlap(fixture_psd):
    s = _session(fixture_psd)
    # 'fill'(128, 전체) 위에 'lines'(200, (10,10)-(30,20))
    arr, left, top = merge_rgba(s["psd"], [s["layers_by_id"][2], s["layers_by_id"][5]])
    assert (left, top) == (0, 0)
    assert arr.shape == (48, 64, 4)
    assert (arr[0, 0, :3] == 128).all()        # fill만 있는 곳
    assert (arr[15, 15, :3] == 200).all()      # lines가 위에 있는 곳
    assert (arr[..., 3] == 255)[0, 0]


def test_merge_rgba_respects_hidden_source(fixture_psd):
    # merge 대상으로 명시한 레이어는 원본 visible=False여도 포함되어야 한다
    s = _session(fixture_psd)
    arr, left, top = merge_rgba(s["psd"], [s["layers_by_id"][3]])
    assert (left, top) == (5, 5)
    assert (arr[..., :3] == 77).all()


def test_render_thumbnails_and_preview(fixture_psd, tmp_path):
    s = _session(fixture_psd)
    thumbs = render_thumbnails(s, [4, 5], max_size=16, out_dir=tmp_path)
    from PIL import Image
    im = Image.open(thumbs["4"])
    assert im.size[0] <= 16 and im.size[1] <= 16

    preview = render_preview(s, [2, 5], max_size=32, out_dir=tmp_path)
    im = Image.open(preview)
    assert max(im.size) <= 32


def test_render_thumbnails_group_not_empty(fixture_psd, tmp_path):
    # Group thumbnails should not be transparent (have alpha>0 pixels)
    s = _session(fixture_psd)
    # BG group (id 1) contains fill layer (128, full canvas)
    thumbs = render_thumbnails(s, [1], max_size=16, out_dir=tmp_path)
    from PIL import Image
    im = Image.open(thumbs["1"])
    arr = np.array(im)
    # Should have pixels with alpha > 0
    assert (arr[..., 3] > 0).any()


def test_render_thumbnails_hidden_group(fixture_psd, tmp_path):
    # Hidden groups should still render their content when explicitly requested
    s = _session(fixture_psd)
    # BG group (id 1) - make it hidden then render
    layer_bg = s["layers_by_id"][1]
    layer_bg.visible = False
    thumbs = render_thumbnails(s, [1], max_size=16, out_dir=tmp_path)
    from PIL import Image
    im = Image.open(thumbs["1"])
    arr = np.array(im)
    # Should still have pixels with alpha > 0 despite being hidden
    assert (arr[..., 3] > 0).any()


def test_render_thumbnails_respects_child_visibility(fixture_psd, tmp_path):
    # Child layer visibility should be respected in group thumbnails
    # BG group (id 1) contains: line (id 4, value 50), hidden_line (id 3, value 77), fill (id 2, value 128)
    s = _session(fixture_psd)
    # Hide the 'line' layer (id 4) then render BG group
    layer_line = s["layers_by_id"][4]
    layer_line.visible = False
    # Use large max_size to preserve original pixel coordinates
    thumbs = render_thumbnails(s, [1], max_size=128, out_dir=tmp_path)
    from PIL import Image
    im = Image.open(thumbs["1"])
    arr = np.array(im)
    # At position (6,6) which is inside the line's bbox (0,0,32,24)
    # but since line is hidden, should show fill value (128) instead
    assert arr[6, 6, 0] == 128  # R channel should be fill value
