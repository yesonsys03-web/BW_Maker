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
