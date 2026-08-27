import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image
from psd_tools import PSDImage

from psd_engine import imageline
from psd_engine.imageline import _document_rgba, extract_image_line, mask_to_rgba
from psd_engine.export import export_image_line
from psd_engine.session import SessionStore

from conftest import write_psd

OPTS = {
    "enabled": True,
    "version": 1,
    "darkThreshold": 80,
    "boundaryThreshold": 30,
    "minLength": 3,
    "width": 1,
}


def _session(path):
    store = SessionStore()
    return store.get(store.open(str(path)))


def _rgba_layer(name, rgba):
    from pytoshop import enums
    from pytoshop.user import nested_layers

    return nested_layers.Image(
        name=name,
        channels={i: np.ascontiguousarray(rgba[..., i]) for i in range(3)} | {-1: np.ascontiguousarray(rgba[..., 3])},
        top=0,
        left=0,
        opacity=255,
        visible=True,
        blend_mode=enums.BlendMode.normal,
    )


def test_extract_preserves_canvas_and_alpha_for_transparent_png(tmp_path):
    rgba = np.zeros((12, 16, 4), dtype=np.uint8)
    rgba[5, 2:14] = [20, 20, 20, 255]
    path = tmp_path / "line.psd"
    write_psd(path, [_rgba_layer("art", rgba)], width=16, height=12)
    mask, _ = extract_image_line(_session(path), OPTS)
    out = mask_to_rgba(mask, "#336699")
    assert out.shape == (12, 16, 4)
    assert out[0, 0, 3] == 0
    assert (out[5, 2:14, :3] == [0x33, 0x66, 0x99]).all()
    assert out[5, 2:14, 3].min() > 0
    assert out[5, 2:14, 3].max() > 0


def test_dark_lines_survive_but_large_dark_fills_are_rejected(tmp_path):
    rgba = np.full((24, 24, 4), [240, 240, 240, 255], dtype=np.uint8)
    rgba[3, 2:20, :3] = 0
    rgba[5:23, 5:23, :3] = 0
    path = tmp_path / "dark.psd"
    write_psd(path, [_rgba_layer("art", rgba)], width=24, height=24)
    mask, _ = extract_image_line(_session(path), OPTS)
    assert mask[3, 2:20].min() > 0
    assert mask[12, 12] == 0


def test_dense_but_elongated_dark_stroke_is_not_mistaken_for_a_fill(tmp_path):
    rgba = np.full((24, 30, 4), [255, 255, 255, 255], dtype=np.uint8)
    rgba[8:14, 3:27, :3] = 0
    path = tmp_path / "thick-stroke.psd"
    write_psd(path, [_rgba_layer("art", rgba)], width=30, height=24)
    mask, _ = extract_image_line(_session(path), {**OPTS, "darkThreshold": 254})
    stroke = mask[:, 3:27] > 0
    assert stroke.any(axis=0)[1:-1].all()
    assert stroke.sum(axis=0).max() <= 12


def test_flat_colour_boundaries_are_removed_with_the_colour(tmp_path):
    rgba = np.zeros((14, 18, 4), dtype=np.uint8)
    rgba[:, :9] = [220, 20, 20, 255]
    rgba[:, 9:] = [20, 80, 230, 255]
    path = tmp_path / "boundary.psd"
    write_psd(path, [_rgba_layer("art", rgba)], width=18, height=14)
    mask, _ = extract_image_line(_session(path), OPTS)
    assert mask.max() == 0


def test_colour_boundaries_near_dark_lines_are_suppressed(tmp_path):
    rgba = np.zeros((16, 20, 4), dtype=np.uint8)
    rgba[:, :10] = [230, 60, 60, 255]
    rgba[:, 10:] = [60, 60, 230, 255]
    rgba[:, 9:11, :3] = 0
    path = tmp_path / "suppressed.psd"
    write_psd(path, [_rgba_layer("art", rgba)], width=20, height=16)
    mask, _ = extract_image_line(_session(path), OPTS)
    assert mask[:, 9].max() >= 100
    assert mask[:, 10].max() >= 100
    assert mask[:, 8].max() < mask[:, 9].max()
    assert mask[:, 11].max() < mask[:, 10].max()
    assert mask[:, 6].max() <= 1
    assert mask[:, 13].max() <= 1


def test_gray_source_stroke_is_filled_solid_instead_of_exported_as_two_edges(tmp_path):
    rgba = np.full((14, 24, 4), [255, 255, 255, 255], dtype=np.uint8)
    rgba[5:9, 2:22, :3] = 190
    path = tmp_path / "gray-stroke.psd"
    write_psd(path, [_rgba_layer("art", rgba)], width=24, height=14)
    mask, _ = extract_image_line(_session(path), {
        **OPTS,
        "darkThreshold": 128,
        "boundaryThreshold": 32,
    })
    assert mask[5:9, 4:20].min() > 0
    assert mask[5:9, 4:20].max() >= 100
    assert np.ptp(mask[6, 5:19]) <= 1
    assert 0 < mask[4, 10] < mask[6, 10]
    rendered = mask_to_rgba(mask, "#3d3d3d")
    assert rendered[6, 10].tolist() == [61, 61, 61, 255]


def test_png_export_is_transparent_and_uses_mask_hash(tmp_path):
    rgba = np.zeros((10, 10, 4), dtype=np.uint8)
    rgba[4, 1:9] = [10, 10, 10, 255]
    path = tmp_path / "src.psd"
    write_psd(path, [_rgba_layer("art", rgba)], width=10, height=10)
    session = _session(path)
    expected_mask, expected_hash = extract_image_line(session, OPTS)
    out = tmp_path / "out.png"
    result = export_image_line(session, out, "png", OPTS, "#ff0000", overwrite=False)
    arr = np.array(Image.open(out).convert("RGBA"))
    assert result["maskHash"] == expected_hash
    assert result["verification"]["ok"] is True
    assert result["profile"]["totalSeconds"] >= 0
    assert result["profile"]["peakTrackedArrayBytes"] > 0
    assert np.array_equal(arr[..., 3], expected_mask)
    assert arr[0, 0, 3] == 0
    assert (arr[arr[..., 3] > 0][:, :3] == [255, 0, 0]).all()


def test_psd_export_readback_has_exactly_one_transparent_line_layer(tmp_path):
    rgba = np.zeros((11, 13, 4), dtype=np.uint8)
    rgba[2:9, 6] = [0, 0, 0, 255]
    path = tmp_path / "src.psd"
    write_psd(path, [_rgba_layer("art", rgba)], width=13, height=11)
    out = tmp_path / "out.psd"
    result = export_image_line(_session(path), out, "psd", OPTS, "#00ff00", overwrite=False)
    psd = PSDImage.open(out)
    layers = list(psd)
    arr = np.array(layers[0].topil().convert("RGBA"))
    assert result["layerCount"] == 1
    assert result["verification"]["ok"] is True
    assert (psd.width, psd.height) == (13, 11)
    assert len(layers) == 1
    assert layers[0].name == "color_to_line"
    assert arr[0, 0, 3] == 0
    assert arr[..., 3].max() > 0


def test_quality_crop_manifest_has_stable_bounded_ids():
    path = Path(__file__).parent / "fixtures" / "color_to_line_manifest.json"
    manifest = json.loads(path.read_text(encoding="utf-8"))
    source = manifest["source"]
    ids = [crop["id"] for crop in manifest["crops"]]
    assert manifest["schemaVersion"] == 1
    assert len(ids) == len(set(ids))
    assert {
        "sample_windows_railings_01",
        "sample_brick_ticks_01",
        "sample_foliage_contour_01",
        "sample_long_roof_road_01",
        "sample_blank_sky_01",
        "sample_existing_dark_boundary_01",
        "sample_title_card_01",
    } == set(ids)
    gates = manifest["qualityGates"]
    for crop in manifest["crops"]:
        assert crop["x"] >= 0 and crop["y"] >= 0
        assert crop["x"] + crop["width"] <= source["width"]
        assert crop["y"] + crop["height"] <= source["height"]
        measured = crop["measured"]
        assert measured["falseFillRate"] <= gates["maxFalseFillRate"]
        if crop["purpose"] == "false-filled-alpha":
            continue
        assert gates["widthMedian"][0] <= measured["widthMedian"] <= gates["widthMedian"][1]
        assert gates["widthP90"][0] <= measured["widthP90"] <= gates["widthP90"][1]
        assert measured["pixelRecall"] >= gates["minPixelRecall"]
        assert measured["componentRecall"] >= gates["minComponentRecall"]
        assert measured["continuity"] >= gates["minContinuity"]
        assert measured["referenceOverlap"] >= gates["minReferenceOverlap"]


def test_real_sample_qa_report_records_memory_cache_and_readback_proof():
    path = Path(__file__).parent / "fixtures" / "color_to_line_qa_report.json"
    report = json.loads(path.read_text(encoding="utf-8"))
    verification = report["verification"]
    sample = verification["realSample"]
    profile = sample["stageProfile"]
    assert report["kind"] == "algorithm-boundary-test-report"
    assert sample["canvas"] == [5100, 3351]
    assert len(sample["maskHash"]) == 64
    assert sample["solidSourceStrokeRegression"] is True
    assert sample["sourceGeometryPreservedRegression"] is True
    assert sample["uniformToneRegression"] is True
    assert sample["smoothEdgeRegression"] is True
    assert sample["precision"] >= 0.9
    assert sample["f1"] >= 0.81
    assert sample["compositeMae"] <= 8.0
    assert sample["opaqueCoreRgba"] == [61, 61, 61, 255]
    assert profile["withinBudget"] is True
    assert profile["peakTrackedArrayBytes"] <= profile["steadyBudgetBytes"]
    assert profile["algorithmPeakRssDeltaBytes"] <= profile["peakBudgetBytes"]
    assert profile["pngWriteAndReadbackSeconds"] > 0
    assert profile["psdWriteAndReadbackSeconds"] > 0
    assert verification["cache"]["recomputedComposite"] is False
    assert verification["cache"]["sameMaskHash"] is True
    assert verification["exports"]["pngReadbackVerified"] is True
    assert verification["exports"]["psdReadbackVerified"] is True
    assert verification["exports"]["batchReadbackVerified"] is True
    assert verification["exports"]["pngPsdAlphaEqual"] is True
    assert verification["allCropMetricGatesPassed"] is True


def test_document_rgba_falls_back_only_for_missing_scipy_gradient_support():
    embedded = Image.new("RGBA", (3, 2), (20, 30, 40, 255))

    class Psd:
        def composite(self, *, force, **_kwargs):
            if force:
                raise ImportError("Gradient fills require: scipy")
            return embedded

    with pytest.warns(RuntimeWarning, match="embedded composite"):
        rgba = _document_rgba({"psd": Psd()})
    assert rgba.shape == (2, 3, 4)
    assert (rgba[0, 0] == [20, 30, 40, 255]).all()


def test_document_rgba_reraises_unrelated_import_errors():
    class Psd:
        def composite(self, **_kwargs):
            raise ImportError("unrelated package is broken")

    with pytest.raises(ImportError, match="unrelated package"):
        _document_rgba({"psd": Psd()})


def test_repeated_extraction_reuses_the_full_resolution_mask(tmp_path, monkeypatch):
    rgba = np.full((12, 16, 4), [240, 240, 240, 255], dtype=np.uint8)
    rgba[5, 2:14, :3] = 0
    path = tmp_path / "cached.psd"
    write_psd(path, [_rgba_layer("art", rgba)], width=16, height=12)
    session = _session(path)
    calls = 0
    original = imageline._document_rgba

    def counted(value):
        nonlocal calls
        calls += 1
        return original(value)

    monkeypatch.setattr(imageline, "_document_rgba", counted)
    first = extract_image_line(session, OPTS)
    second = extract_image_line(session, OPTS)
    assert calls == 1
    assert second[1] == first[1]
    assert second[0] is first[0]


def test_extraction_remains_available_without_unix_resource_module(tmp_path, monkeypatch):
    rgba = np.full((8, 10, 4), [240, 240, 240, 255], dtype=np.uint8)
    rgba[3, 1:9, :3] = 0
    path = tmp_path / "windows.psd"
    write_psd(path, [_rgba_layer("art", rgba)], width=10, height=8)
    session = _session(path)
    monkeypatch.setattr(imageline, "_resource", None)
    mask, _ = extract_image_line(session, OPTS)
    assert mask[3, 1:9].max() > 0
    assert imageline.image_line_profile(session, OPTS)["algorithmPeakRssDeltaBytes"] is None
