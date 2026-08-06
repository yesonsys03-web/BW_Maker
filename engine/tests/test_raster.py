import numpy as np
import pytest
from PIL import Image

from psd_engine.raster import export_raster, export_raster_split


def test_jpg_with_line_color_is_not_a_solid_block(session, plan, tmp_path):
    """
    apply_line_color는 알파 0인 픽셀의 RGB까지 라인 색으로 채운다(의도적).
    그 배열의 알파를 그냥 버리면 전면이 단색인 이미지가 나온다 — 기본 라인 색이
    #000000이므로 새까만 사각형이다. 흰 캔버스에 합성한 뒤 RGB로 바꿔야 한다.
    """
    entries = plan([3, 4, 5])
    out = tmp_path / "a.jpg"
    export_raster(session, entries, out, "jpg", line_color="#000000")
    arr = np.array(Image.open(out).convert("RGB"))
    assert len(np.unique(arr.reshape(-1, 3), axis=0)) > 1, "단색 이미지가 나왔다"
    # 라인이 없는 자리는 흰 배경이어야 한다.
    assert arr.max() > 200


def test_png_keeps_a_transparent_background(session, plan, tmp_path):
    entries = plan([3, 4, 5])
    out = tmp_path / "a.png"
    export_raster(session, entries, out, "png", line_color="#000000")
    img = Image.open(out)
    assert img.mode == "RGBA"
    alpha = np.array(img)[..., 3]
    assert alpha.min() == 0, "투명한 자리가 없다"


def test_jpg_is_opaque(session, plan, tmp_path):
    out = tmp_path / "a.jpg"
    export_raster(session, plan([3, 4, 5]), out, "jpg")
    assert Image.open(out).mode == "RGB"


def test_raster_canvas_is_the_document_size(session, plan, tmp_path):
    out = tmp_path / "a.png"
    export_raster(session, plan([3, 4, 5]), out, "png")
    assert Image.open(out).size == (session["psd"].width, session["psd"].height)


def test_raster_refuses_to_overwrite(session, plan, tmp_path):
    out = tmp_path / "a.png"
    out.write_bytes(b"")
    with pytest.raises(FileExistsError):
        export_raster(session, plan([3, 4, 5]), out, "png")


def test_raster_rejects_a_bad_line_color_before_writing(session, plan, tmp_path):
    out = tmp_path / "a.png"
    with pytest.raises(ValueError):
        export_raster(session, plan([3, 4, 5]), out, "png", line_color="빨강")
    assert not out.exists()


def test_raster_rejects_an_empty_plan(session, tmp_path):
    with pytest.raises(ValueError, match="no entries"):
        export_raster(session, [], tmp_path / "a.png", "png")


def test_raster_split_writes_one_file_per_entry(session, plan, tmp_path):
    entries = plan([3, 4, 5])
    result = export_raster_split(session, entries, tmp_path / "X_LINE.png", "png")
    assert len(result["outputs"]) == len(entries)
    for out in result["outputs"]:
        assert Image.open(out["outputPath"]).size == (
            session["psd"].width, session["psd"].height)


def test_raster_split_checks_every_target_before_writing_any(session, plan, tmp_path):
    from pathlib import Path

    from psd_engine.export import split_output_path

    entries = plan([3, 4, 5])
    base = str(tmp_path / "X_LINE.png")
    Path(split_output_path(base, entries[1]["finalName"])).write_bytes(b"")
    with pytest.raises(FileExistsError):
        export_raster_split(session, entries, base, "png")
    # 첫 엔트리의 파일이 나가 있으면 안 된다.
    assert not Path(split_output_path(base, entries[0]["finalName"])).exists()
