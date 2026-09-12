import numpy as np
import pytest
from PIL import Image

from psd_engine.raster import export_raster
from psd_engine.verify_raster import verify_raster


def test_png_verification_compares_pixels_exactly(session, plan, tmp_path):
    entries = plan([3, 4, 5])
    out = tmp_path / "a.png"
    export_raster(session, entries, out, "png")
    v = verify_raster(session, entries, out, "png")
    assert v["ok"] is True
    assert v["canvasOk"] is True
    assert v["layers"][0]["pixelChecked"] is True
    assert v["layers"][0]["pixelOk"] is True


def test_png_verification_catches_a_corrupted_output(session, plan, tmp_path):
    entries = plan([3, 4, 5])
    out = tmp_path / "a.png"
    export_raster(session, entries, out, "png")
    arr = np.array(Image.open(out))
    arr[0, 0] = [255, 0, 0, 255]
    Image.fromarray(arr).save(out)
    v = verify_raster(session, entries, out, "png")
    assert v["ok"] is False
    assert v["layers"][0]["pixelOk"] is False


def test_jpg_verification_does_not_claim_a_pixel_check(session, plan, tmp_path):
    entries = plan([3, 4, 5])
    out = tmp_path / "a.jpg"
    export_raster(session, entries, out, "jpg")
    v = verify_raster(session, entries, out, "jpg")
    assert v["ok"] is True
    assert v["layers"][0]["pixelChecked"] is False
    assert v["layers"][0]["pixelOk"] is None


def test_verification_reports_a_canvas_mismatch(session, plan, tmp_path):
    entries = plan([3, 4, 5])
    out = tmp_path / "a.png"
    Image.new("RGBA", (7, 9)).save(out)
    v = verify_raster(session, entries, out, "png")
    assert v["canvasOk"] is False
    assert v["ok"] is False


def test_verification_shape_matches_verify_export(session, plan, tmp_path):
    entries = plan([3, 4, 5])
    out = tmp_path / "a.png"
    export_raster(session, entries, out, "png")
    v = verify_raster(session, entries, out, "png")
    assert set(v) == {"ok", "canvasOk", "layerCountOk", "expectedLayers",
                      "actualLayers", "layers"}
    assert set(v["layers"][0]) == {"name", "nameOk", "pixelChecked", "pixelOk"}
    # 평탄화 1장이므로 레이어 수 이야기는 나오지 않아야 한다.
    assert v["layerCountOk"] is True
    assert v["expectedLayers"] == 1 and v["actualLayers"] == 1
