import json
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageFilter
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


def test_coloured_named_line_layer_is_extracted_without_its_fill(tmp_path):
    fill = np.full((14, 18, 4), [220, 90, 40, 255], dtype=np.uint8)
    line = np.zeros((14, 18, 4), dtype=np.uint8)
    line[3:12, 8, :] = [130, 45, 20, 173]
    path = tmp_path / "coloured-line.psd"
    write_psd(path, [
        _rgba_layer("FILL", fill),
        _rgba_layer("Line", line),
    ], width=18, height=14)
    mask, _ = extract_image_line(_session(path), OPTS)
    assert mask[3:12, 8].min() == 173
    assert np.count_nonzero(mask) == 9


def test_descriptive_line_layer_names_are_extracted(tmp_path):
    layers = []
    for x, name in enumerate(
            ["PalmTree line", "Line 94", "court white lines", "guideline"],
            start=3):
        rgba = np.zeros((12, 12, 4), dtype=np.uint8)
        rgba[2:10, x, :] = [90, 50, 20, 211]
        layers.append(_rgba_layer(name, rgba))
    path = tmp_path / "descriptive-lines.psd"
    write_psd(path, layers, width=12, height=12)
    mask, _ = extract_image_line(_session(path), OPTS)
    assert (mask[2:10, 3:6] == 211).all()
    assert mask[:, 6].max() == 0


def test_generic_layers_inside_a_line_group_are_extracted(tmp_path):
    from pytoshop.user import nested_layers

    line = np.zeros((40, 40, 4), dtype=np.uint8)
    line[3:37, 21, 3] = 193
    fill = np.zeros((40, 40, 4), dtype=np.uint8)
    fill[2:18, 2:10, :] = [40, 80, 120, 255]
    path = tmp_path / "line-group.psd"
    write_psd(path, [
        nested_layers.Group(
            name="LINE",
            layers=[
                _rgba_layer("PoolDeck", line),
                _rgba_layer("Layer 113", fill),
            ],
        ),
    ], width=40, height=40)
    mask, _ = extract_image_line(_session(path), OPTS)
    assert (mask[3:37, 21] == 193).all()
    assert mask[:, 2:10].max() == 0


def test_named_line_under_hidden_group_is_not_extracted(tmp_path):
    from pytoshop.user import nested_layers

    hidden_line = np.zeros((20, 20, 4), dtype=np.uint8)
    hidden_line[2:18, 10, :] = [120, 50, 20, 211]
    visible_line = np.zeros((20, 20, 4), dtype=np.uint8)
    visible_line[2:18, 5, :] = [90, 40, 15, 187]
    path = tmp_path / "hidden-line-group.psd"
    write_psd(path, [
        nested_layers.Group(
            name="hidden artwork",
            visible=False,
            layers=[_rgba_layer("Line", hidden_line)],
        ),
        _rgba_layer("Line", visible_line),
    ], width=20, height=20)
    mask, _ = extract_image_line(_session(path), OPTS)
    assert (mask[2:18, 5] == 187).all()
    assert mask[:, 10].max() == 0


def test_character_height_guides_are_not_extracted_as_line_art(tmp_path):
    character = np.zeros((30, 50, 4), dtype=np.uint8)
    character[4:26, 12, :] = [60, 40, 35, 193]
    height_guide = np.zeros((30, 50, 4), dtype=np.uint8)
    height_guide[15, :, :] = [80, 80, 80, 255]
    note = np.zeros((30, 50, 4), dtype=np.uint8)
    note[27, 5:45, :] = [80, 80, 80, 255]
    path = tmp_path / "character-sheet.psd"
    write_psd(path, [
        _rgba_layer("LINE", character),
        _rgba_layer("CHARACTER HEIGHT LINE", height_guide),
        _rgba_layer("NOTE ABOUT INVISIBLE LINES", note),
    ], width=50, height=30)
    mask, _ = extract_image_line(_session(path), OPTS)
    assert (mask[4:26, 12] == 193).all()
    assert mask[15, 30] == 0
    assert mask[27, 20] == 0


def test_unnamed_canvas_spanning_horizontal_guide_is_removed(tmp_path):
    from pytoshop.user import nested_layers

    character = np.zeros((40, 100, 4), dtype=np.uint8)
    character[5:35, 20, :] = [60, 40, 35, 193]
    guide = np.zeros((40, 100, 4), dtype=np.uint8)
    guide[18, :, :] = [80, 80, 80, 180]
    path = tmp_path / "generic-horizontal-guide.psd"
    write_psd(path, [
        _rgba_layer("LINE", character),
        nested_layers.Group(name="LINES", layers=[
            _rgba_layer("measurement", guide),
        ]),
    ], width=100, height=40)
    mask, _ = extract_image_line(_session(path), OPTS)
    assert (mask[5:35, 20] == 193).all()
    assert mask[18, 70] == 0


def test_horizontal_prop_line_shorter_than_canvas_is_preserved():
    alpha = np.zeros((20, 100), dtype=np.uint8)
    alpha[10, 15:50] = 193
    cleaned = imageline._remove_horizontal_guides(alpha, 100)
    assert (cleaned[10, 15:50] == 193).all()


def test_clean_style_sparse_black_object_layers_are_extracted(tmp_path):
    from pytoshop.user import nested_layers

    line = np.zeros((40, 40, 4), dtype=np.uint8)
    line[3:37, 21, 3] = 187
    fill = np.zeros((40, 40, 4), dtype=np.uint8)
    fill[2:18, 2:10, :] = [0, 0, 0, 255]
    clean = nested_layers.Group(name="CLEAN", layers=[
        _rgba_layer("benches", line),
        _rgba_layer("dark fill", fill),
    ])
    path = tmp_path / "clean-style.psd"
    write_psd(path, [clean], width=40, height=40)
    mask, _ = extract_image_line(_session(path), OPTS)
    assert (mask[3:37, 21] == 187).all()
    assert mask[:, 2:10].max() == 0


def test_sparse_black_detection_is_scoped_to_clean_or_fl102_documents(tmp_path):
    from pytoshop.user import nested_layers

    line = np.zeros((40, 40, 4), dtype=np.uint8)
    line[3:37, 21, 3] = 187
    path = tmp_path / "other-style.psd"
    write_psd(path, [
        nested_layers.Group(
            name="ARTWORK",
            layers=[_rgba_layer("benches", line)],
        ),
    ], width=40, height=40)
    session = _session(path)
    assert imageline._uses_clean_style(session["psd"]) is False
    assert imageline._is_fl102_document(session) is False

    fl102_path = tmp_path / "FL102_BG_A999_TEST.psd"
    write_psd(fl102_path, [
        nested_layers.Group(
            name="ARTWORK",
            layers=[_rgba_layer("benches", line)],
        ),
    ], width=40, height=40)
    mask, _ = extract_image_line(_session(fl102_path), OPTS)
    assert (mask[3:37, 21] == 187).all()


def test_fl102_dark_ink_named_after_its_object_group_is_extracted(tmp_path):
    from pytoshop.user import nested_layers

    line = np.zeros((40, 40, 4), dtype=np.uint8)
    line[3:37, 21, :] = [45, 65, 80, 187]
    fill = np.zeros((40, 40, 4), dtype=np.uint8)
    fill[2:18, 2:10, :] = [190, 120, 80, 255]
    path = tmp_path / "FL102_BG_TEST.psd"
    write_psd(path, [
        nested_layers.Group(name="Statue", layers=[
            _rgba_layer("fill", fill),
            _rgba_layer("Statue", line),
        ]),
    ], width=40, height=40)
    mask, _ = extract_image_line(_session(path), OPTS)
    assert (mask[3:37, 21] == 187).all()
    assert mask[:, 2:10].max() == 0


def test_clean_style_cloud_shape_gets_an_outline_without_filling_it(tmp_path):
    from pytoshop.user import nested_layers

    cloud = np.zeros((40, 48, 4), dtype=np.uint8)
    cloud[10:30, 12:36, :] = [250, 240, 180, 255]
    clean = nested_layers.Group(name="CLEAN", layers=[
        nested_layers.Group(name="bg", layers=[
            nested_layers.Group(
                name="Colouds",
                layers=[_rgba_layer("clouds", cloud)],
            ),
        ]),
    ])
    path = tmp_path / "clean-cloud.psd"
    write_psd(path, [clean], width=48, height=40)
    mask, _ = extract_image_line(_session(path), OPTS)
    assert mask[10, 20] > 100
    assert mask[20, 12] > 100
    assert mask[20, 24] == 0
    assert mask[0, :].max() == 0


def test_unpaired_colour_shapes_get_outlines_without_filling_them(tmp_path):
    from pytoshop.user import nested_layers

    cloud = np.zeros((40, 48, 4), dtype=np.uint8)
    cloud[10:30, 12:36, :] = [120, 165, 225, 255]
    base = np.full((40, 48, 4), [25, 45, 80, 255], dtype=np.uint8)
    path = tmp_path / "colour-shape-bg.psd"
    write_psd(path, [
        nested_layers.Group(name="ART", layers=[
            nested_layers.Group(name="SKY", layers=[
                _rgba_layer("_", base),
                _rgba_layer("fill clouds", cloud),
            ]),
        ]),
    ], width=48, height=40)
    mask, _ = extract_image_line(_session(path), OPTS)
    assert mask[10, 20] > 100
    assert mask[20, 12] > 100
    assert mask[20, 24] == 0
    assert mask[0, :].max() == 0


def test_bounded_opaque_graphic_gets_bbox_and_internal_colour_lines(tmp_path):
    from pytoshop import enums
    from pytoshop.user import nested_layers

    graphic = np.full((36, 40, 4), [225, 145, 75, 255], dtype=np.uint8)
    graphic[:, 20:, :3] = [120, 65, 185]
    layer = nested_layers.Image(
        name="background panel",
        channels={
            i: np.ascontiguousarray(graphic[..., i]) for i in range(3)
        } | {-1: np.ascontiguousarray(graphic[..., 3])},
        top=6,
        left=10,
        opacity=255,
        visible=True,
        blend_mode=enums.BlendMode.normal,
    )
    path = tmp_path / "opaque-graphic.psd"
    write_psd(path, [
        nested_layers.Group(name="DESIGN", layers=[
            layer,
        ]),
    ], width=60, height=48)
    mask, _ = extract_image_line(_session(path), OPTS)
    assert mask[6, 20] > 100
    assert mask[20, 10] > 100
    assert mask[20, 27:33].max() > 100
    assert mask[20, 20] == 0


def test_fill_is_not_outlined_when_group_has_an_authored_line(tmp_path):
    from pytoshop.user import nested_layers

    fill = np.zeros((40, 48, 4), dtype=np.uint8)
    fill[10:30, 12:36, :] = [120, 165, 225, 255]
    line = np.zeros((40, 48, 4), dtype=np.uint8)
    line[4:36, 5, :] = [45, 65, 90, 193]
    path = tmp_path / "paired-fill.psd"
    write_psd(path, [
        nested_layers.Group(name="OBJECT", layers=[
            _rgba_layer("fill", fill),
            _rgba_layer("Line", line),
        ]),
    ], width=48, height=40)
    mask, _ = extract_image_line(_session(path), OPTS)
    assert (mask[4:36, 5] == 193).all()
    assert mask[10:30, 12:36].max() == 0


def test_prop_colour_regions_are_added_to_authored_line_art(tmp_path):
    from pytoshop.user import nested_layers

    fill = np.zeros((48, 60, 4), dtype=np.uint8)
    fill[10:38, 30:50, :] = [190, 65, 95, 255]
    line = np.zeros((48, 60, 4), dtype=np.uint8)
    line[8:40, 12, :] = [65, 25, 40, 193]
    path = tmp_path / "prop-colours.psd"
    write_psd(path, [
        nested_layers.Group(name="PROPS", layers=[
            nested_layers.Group(name="OBJECT", layers=[
                nested_layers.Group(name="COLORS", layers=[
                    _rgba_layer("red fill", fill),
                ]),
                nested_layers.Group(name="LINE", layers=[
                    _rgba_layer("LINE", line),
                ]),
            ]),
        ]),
    ], width=60, height=48)
    mask, _ = extract_image_line(_session(path), OPTS)
    assert (mask[8:40, 12] == 193).all()
    assert mask[10, 35] > 100
    assert mask[20, 30] > 100
    assert mask[20, 40] == 0


def test_full_width_opaque_prop_plate_gets_only_coarse_edges(tmp_path):
    from pytoshop import enums
    from pytoshop.user import nested_layers

    plate = np.full((32, 80, 4), [180, 70, 80, 255], dtype=np.uint8)
    plate[:, 40:, :3] = [45, 35, 55]
    plate_layer = nested_layers.Image(
        name="background plate",
        channels={
            i: np.ascontiguousarray(plate[..., i]) for i in range(3)
        } | {-1: np.ascontiguousarray(plate[..., 3])},
        top=0,
        left=0,
        opacity=255,
        visible=True,
        blend_mode=enums.BlendMode.normal,
    )
    line = np.zeros((40, 80, 4), dtype=np.uint8)
    line[5:35, 12, :] = [65, 25, 40, 193]
    path = tmp_path / "prop-with-background-plate.psd"
    write_psd(path, [
        nested_layers.Group(name="PROP", layers=[
            nested_layers.Group(name="colour", layers=[plate_layer]),
            nested_layers.Group(name="line", layers=[
                _rgba_layer("LINE", line),
            ]),
        ]),
    ], width=80, height=40)
    mask, _ = extract_image_line(_session(path), OPTS)
    assert (mask[5:35, 12] == 193).all()
    assert mask[:, 37:43].max() > 0


def test_large_flattened_reference_character_is_added_to_line_art(
        tmp_path, monkeypatch):
    from pytoshop.user import nested_layers

    character = np.zeros((60, 100, 4), dtype=np.uint8)
    character[8:52, 55:90, :] = [210, 45, 90, 255]
    spear = np.zeros((60, 100, 4), dtype=np.uint8)
    spear[5:55, 20, :] = [35, 35, 35, 193]
    path = tmp_path / "flattened-reference-character.psd"
    write_psd(path, [
        nested_layers.Group(name="TURN", layers=[
            _rgba_layer("LINE", spear),
        ]),
        nested_layers.Group(name="EXTRA REFS", layers=[
            _rgba_layer("character", character),
        ]),
    ], width=100, height=60)
    monkeypatch.setattr(
        imageline,
        "_simplified_character_edges",
        lambda rgba: np.where(rgba[..., 3] >= 8, 211, 0).astype(np.uint8),
    )
    mask, _ = extract_image_line(_session(path), OPTS)
    assert (mask[5:55, 20] == 193).all()
    assert (mask[8:52, 55:90] == 211).all()


def test_flattened_character_ink_is_denoised_and_small_gap_is_closed():
    rgba = np.full((30, 40, 4), [240, 232, 233, 255], dtype=np.uint8)
    rgba[4:14, 20, :] = [38, 30, 56, 255]
    rgba[15:26, 20, :] = [38, 30, 56, 255]
    rgba[5, 5, :] = [38, 30, 56, 255]
    edges = imageline._simplified_character_edges(rgba)
    assert edges[14, 20] == 255
    assert edges[15, 20] == 255
    assert edges[5, 5] == 0


def test_flattened_character_colour_fill_keeps_only_its_boundary():
    rgba = np.zeros((40, 50, 4), dtype=np.uint8)
    rgba[8:32, 12:38, :] = [38, 30, 56, 255]
    edges = imageline._simplified_character_edges(rgba)
    assert edges[8, 20] == 255
    assert edges[20, 12] == 255
    assert edges[20, 25] == 0


def test_flattened_character_coloured_detail_gets_a_line_boundary():
    rgba = np.zeros((48, 60, 4), dtype=np.uint8)
    rgba[5:43, 8:52, :] = [240, 232, 233, 255]
    rgba[14:34, 24:36, :] = [216, 32, 73, 255]
    edges = imageline._simplified_character_edges(rgba)
    assert edges[14, 30] > 100
    assert edges[24, 22:27].max() > 100
    assert edges[24, 30] == 0


def test_flattened_cel_graphic_boundaries_have_fixed_width():
    rgba = np.full((40, 60, 4), [220, 50, 80, 255], dtype=np.uint8)
    rgba[:, 30:, :3] = [45, 30, 55]
    edges = imageline._thin_colour_edges(rgba)
    core_columns = np.flatnonzero(edges[20] == 255)
    assert core_columns.tolist() == [28, 29, 30]
    assert 0 < edges[20, 27] < 255
    assert 0 < edges[20, 31] < 255
    assert edges[20, 10] == 0
    assert edges[20, 45] == 0


def test_low_contrast_turn_boundary_can_be_continuous():
    rgba = np.full((40, 60, 4), [100, 100, 100, 255], dtype=np.uint8)
    rgba[:, 30:, :3] = [108, 108, 108]
    assert imageline._thin_colour_edges(
        rgba,
        include_alpha=False,
        threshold=8,
    )[20, 29] == 255
    assert imageline._thin_colour_edges(
        rgba,
        include_alpha=False,
        threshold=12,
    ).max() == 0


def test_specialized_colour_group_names_are_recognized():
    assert imageline._is_colour_group_name("COLORS")
    assert imageline._is_colour_group_name("HAIR COLOR")
    assert imageline._is_colour_group_name("HAIR COLOUR")
    assert imageline._is_colour_group_name("HEADSCARF COLOR")
    assert not imageline._is_colour_group_name("COLOR PALETTE")


def test_unnamed_reference_line_paired_with_fill_is_extracted(tmp_path):
    from pytoshop.user import nested_layers

    fill = np.zeros((50, 90, 4), dtype=np.uint8)
    fill[8:42, 10:80, :] = [240, 240, 240, 255]
    detail = np.zeros((50, 90, 4), dtype=np.uint8)
    detail[24, 25:65, :] = [153, 153, 153, 193]
    path = tmp_path / "unnamed-reference-line.psd"
    write_psd(path, [
        nested_layers.Group(name="EXTRA REFS", layers=[
            nested_layers.Group(name="CLOSE UP", layers=[
                _rgba_layer("fill", fill),
                _rgba_layer("Layer 12", detail),
            ]),
        ]),
    ], width=90, height=50)
    mask, _ = extract_image_line(_session(path), OPTS)
    assert (mask[24, 25:65] == 255).all()
    assert mask[10, 20] == 0


def test_nested_art_group_coloured_strokes_are_extracted(tmp_path):
    from pytoshop.user import nested_layers

    stroke = np.zeros((50, 70, 4), dtype=np.uint8)
    stroke[5:45, 20, :] = [210, 40, 80, 193]
    fill = np.zeros((50, 70, 4), dtype=np.uint8)
    fill[8:42, 35:60, :] = [20, 20, 20, 255]
    text = np.zeros((50, 70, 4), dtype=np.uint8)
    text[30, 5:30, :] = [220, 45, 90, 193]
    border = np.zeros((50, 70, 4), dtype=np.uint8)
    border[2:48, 2, :] = [220, 45, 90, 193]
    path = tmp_path / "nested-art.psd"
    write_psd(path, [
        nested_layers.Group(name="TURNAROUND", layers=[
            nested_layers.Group(name="ART", layers=[
                _rgba_layer("red", stroke),
                _rgba_layer("black fill", fill),
            ]),
            nested_layers.Group(name="TEXT", layers=[
                _rgba_layer("caption", text),
            ]),
            _rgba_layer("BORDER", border),
        ]),
    ], width=70, height=50)
    mask, _ = extract_image_line(_session(path), OPTS)
    assert (mask[5:45, 20] >= 193).all()
    assert (mask[30, 5:30] >= 193).all()
    assert (mask[2:48, 2] >= 193).all()
    assert mask[8:42, 35:60].max() == 0


def test_visible_composite_edges_fill_semantic_root_line_omissions(
        tmp_path, monkeypatch):
    from pytoshop.user import nested_layers

    line = np.zeros((60, 90, 4), dtype=np.uint8)
    line[8:52, 15, :] = [35, 35, 35, 193]
    detail = np.zeros((60, 90, 4), dtype=np.uint8)
    detail[15:45, 45:75, :] = [220, 40, 90, 255]
    template = np.zeros((60, 90, 4), dtype=np.uint8)
    template[5:55, 84, :] = [255, 0, 0, 255]
    path = tmp_path / "composite-residual.psd"
    write_psd(path, [
        nested_layers.Group(name="TEMPLATE", layers=[
            _rgba_layer("guide", template),
        ]),
        nested_layers.Group(name="DESIGN", layers=[
            _rgba_layer("colour detail", detail),
            _rgba_layer("LINE", line),
        ]),
    ], width=90, height=60)
    rendered = np.full((60, 90, 4), [235, 225, 200, 255], dtype=np.uint8)
    rendered[15:45, 45:75, :3] = [220, 40, 90]
    rendered[8:52, 15, :3] = [35, 35, 35]
    session = _session(path)
    turn = next(layer for layer in session["psd"] if layer.name == "DESIGN")
    monkeypatch.setattr(
        type(turn),
        "composite",
        lambda self: Image.fromarray(rendered.copy(), "RGBA"),
    )
    mask, _ = extract_image_line(session, OPTS)
    assert mask[20, 15] > 0
    assert mask[13:18, 55].max() > 0
    assert mask[30, 43:48].max() > 0
    assert mask[:, 84].max() == 0


def test_hidden_colour_boundary_is_removed_by_rendered_edge_support():
    class Layer:
        bbox = (0, 0, 40, 20)

    outline = np.zeros((20, 40), dtype=np.uint8)
    outline[10, 3:37] = 255
    visible_edges = np.zeros((20, 40), dtype=bool)
    visible_edges[8:13, 3:12] = True
    visible_edges[8:13, 28:37] = True
    cleaned = imageline._keep_visible_outline(
        outline,
        Layer(),
        visible_edges,
    )
    assert cleaned[10, 5] == 255
    assert cleaned[10, 20] == 0
    assert cleaned[10, 32] == 255


def test_colour_shapes_are_scoped_to_top_level_art_group(tmp_path):
    from pytoshop.user import nested_layers

    cloud = np.zeros((40, 48, 4), dtype=np.uint8)
    cloud[10:30, 12:36, :] = [120, 165, 225, 255]
    guide = np.zeros((40, 48, 4), dtype=np.uint8)
    guide[4:36, 4:44, :] = [255, 0, 0, 255]
    path = tmp_path / "art-with-guides.psd"
    write_psd(path, [
        nested_layers.Group(name="*ART", layers=[
            nested_layers.Group(name="SKY", layers=[
                _rgba_layer("fill clouds", cloud),
            ]),
        ]),
        nested_layers.Group(name="*FIELDGUIDES", layers=[
            _rgba_layer("frame", guide),
        ]),
    ], width=48, height=40)
    mask, _ = extract_image_line(_session(path), OPTS)
    assert mask[10, 20] > 100
    assert mask[4, 20] == 0
    assert mask[20, 4] == 0


def test_artwork_render_keeps_raw_art_when_optional_renderer_is_missing(
        tmp_path, monkeypatch):
    from pytoshop.user import nested_layers

    pixels = np.zeros((20, 30, 4), dtype=np.uint8)
    pixels[5:15, 8:22, :] = [90, 120, 180, 255]
    guide = np.zeros((20, 30, 4), dtype=np.uint8)
    guide[2:18, 3, :] = [20, 20, 20, 255]
    path = tmp_path / "vector-art.psd"
    write_psd(path, [
        nested_layers.Group(name="*ART", layers=[
            _rgba_layer("shape", pixels),
        ]),
        nested_layers.Group(name="*FIELDGUIDES", layers=[
            _rgba_layer("frame", guide),
        ]),
    ], width=30, height=20)
    session = _session(path)
    art = next(layer for layer in session["psd"] if layer.name == "*ART")

    def missing_renderer(*args, **kwargs):
        raise ImportError("aggdraw")

    monkeypatch.setattr(
        type(art),
        "composite",
        missing_renderer,
    )
    rendered = imageline._artwork_rgba(session)
    assert (rendered[10, 10] == [90, 120, 180, 255]).all()
    assert rendered[:, 3, 3].max() == 0


def test_clean_style_sign_and_wall_pattern_get_outlines(tmp_path):
    from pytoshop.user import nested_layers

    sign = np.zeros((20, 30, 4), dtype=np.uint8)
    sign[5:15, 8:25, :] = [255, 255, 255, 255]
    bricks = np.zeros((40, 48, 4), dtype=np.uint8)
    bricks[24:30, 6:16, :] = [80, 70, 50, 255]
    full_canvas = np.full((40, 48, 4), [255, 255, 255, 255], dtype=np.uint8)
    clean = nested_layers.Group(name="CLEAN", layers=[
        nested_layers.Group(name="BUILDING", layers=[
            _rgba_layer("brick texture", bricks),
            nested_layers.Group(name="Group 3", layers=[
                _rgba_layer("Text", sign),
                _rgba_layer("full canvas helper", full_canvas),
            ]),
        ]),
    ])
    path = tmp_path / "clean-sign.psd"
    write_psd(path, [clean], width=48, height=40)
    mask, _ = extract_image_line(_session(path), OPTS)
    assert mask[5, 12] > 100
    assert mask[10, 12] == 0
    assert mask[24, 10] > 100
    assert mask[27, 10] < 8
    assert mask[39, 47] == 0


def test_flattened_png_uses_the_line_model_and_exposes_one_layer(
        tmp_path, monkeypatch):
    rgba = np.full((30, 40, 4), [220, 160, 100, 255], dtype=np.uint8)
    rgba[8:22, 10, :3] = [95, 45, 20]
    rgba[5:25, 30, :3] = [255, 0, 0]
    path = tmp_path / "flattened.png"
    Image.fromarray(rgba, "RGBA").save(path)
    store = SessionStore()
    session = store.get(store.open(path))
    assert session["flattened_image"] is True
    assert len(session["tree"]) == 1
    assert session["tree"][0]["name"] == "Flattened image"
    expected = np.zeros((30, 40), dtype=np.uint8)
    expected[8:22, 10] = 201
    monkeypatch.setattr(
        imageline, "_flattened_model_alpha", lambda _: expected.copy())
    monkeypatch.setattr(
        imageline,
        "_missing_colour_edges",
        lambda *_args, **_kwargs: pytest.fail(
            "flattened model output must not gain fragmented colour edges"),
    )
    mask, _ = extract_image_line(session, OPTS)
    assert np.array_equal(mask, expected)


def test_flattened_model_alpha_is_strictly_binary():
    alpha = np.array([
        [0, 8, 63],
        [64, 180, 255],
    ], dtype=np.uint8)
    cleaned = imageline._binarize_flattened_alpha(alpha)
    assert np.array_equal(cleaned, np.array([
        [0, 0, 0],
        [255, 255, 255],
    ], dtype=np.uint8))


def test_flattened_review_guide_mask_rejects_red_but_not_brown_ink():
    rgb = np.full((40, 70, 3), [220, 160, 100], dtype=np.uint8)
    rgb[20, 10] = [95, 45, 20]
    rgb[5:35, 55] = [255, 0, 0]
    zone = imageline._flattened_annotation_zone(rgb)
    assert zone[20, 55]
    assert not zone[20, 10]


def test_red_dominant_artwork_is_not_mistaken_for_sparse_review_marks():
    sparse = np.full((40, 70, 3), [220, 160, 100], dtype=np.uint8)
    sparse[5:35, 55] = [255, 0, 0]
    authored = np.full((40, 70, 3), [230, 20, 35], dtype=np.uint8)
    assert imageline._suppress_flattened_red_annotations(sparse)
    assert not imageline._suppress_flattened_red_annotations(authored)


@pytest.mark.parametrize("size", [3, 5, 7, 21])
@pytest.mark.parametrize("maximum", [False, True])
def test_fast_rank_filter_matches_pillow(size, maximum):
    rng = np.random.default_rng(42)
    source = rng.integers(0, 256, size=(37, 43), dtype=np.uint8)
    pillow_filter = (
        ImageFilter.MaxFilter(size)
        if maximum
        else ImageFilter.MinFilter(size)
    )
    expected = np.array(
        Image.fromarray(source, "L").filter(pillow_filter),
        dtype=np.uint8,
    )
    actual = imageline._rank_filter(source, size, maximum)
    assert np.array_equal(actual, expected)
    boolean = source >= 128
    expected_boolean = np.array(
        Image.fromarray(boolean.astype(np.uint8) * 255, "L").filter(
            pillow_filter
        ),
        dtype=np.uint8,
    ) > 0
    actual_boolean = imageline._rank_filter(boolean, size, maximum)
    assert np.array_equal(actual_boolean, expected_boolean)


@pytest.mark.parametrize("count_area", [False, True])
def test_run_component_filter_matches_pixel_flood_fill(count_area):
    rng = np.random.default_rng(17)
    mask = rng.random((41, 53)) < 0.18
    labels = np.zeros(mask.shape, dtype=np.int32)
    keep = [False]
    next_label = 0
    for y0, x0 in zip(*np.nonzero(mask)):
        if labels[y0, x0]:
            continue
        next_label += 1
        labels[y0, x0] = next_label
        stack = [(int(y0), int(x0))]
        points = []
        while stack:
            y, x = stack.pop()
            points.append((y, x))
            for ny in range(max(0, y - 1), min(mask.shape[0], y + 2)):
                for nx in range(max(0, x - 1), min(mask.shape[1], x + 2)):
                    if mask[ny, nx] and not labels[ny, nx]:
                        labels[ny, nx] = next_label
                        stack.append((ny, nx))
        ys, xs = zip(*points)
        extent = max(max(ys) - min(ys) + 1, max(xs) - min(xs) + 1)
        keep.append(
            max(extent, len(points)) >= 9
            if count_area
            else extent >= 9
        )
    expected = np.asarray(keep, dtype=bool)[labels]
    actual = imageline._remove_short_components(
        mask,
        9,
        count_area=count_area,
    )
    assert np.array_equal(actual, expected)


def test_flattened_model_extracts_sparse_marks_on_black_canvas(monkeypatch):
    rgba = np.zeros((32, 40, 4), dtype=np.uint8)
    rgba[..., 3] = 255
    rgba[12:20, 18:22, :3] = 32

    def model(rgb):
        raise AssertionError("sparse difference images must bypass the model")

    monkeypatch.setattr(imageline, "_run_flattened_line_models", model)
    alpha = imageline._flattened_model_alpha(rgba)
    assert alpha[0, 0] == 0
    assert alpha[15, 20] == 255


def test_large_solid_interiors_are_hollowed_without_erasing_thin_lines():
    alpha = np.zeros((80, 100), dtype=np.uint8)
    alpha[10:15, 5:95] = 255
    alpha[20:75, 20:80] = 255
    cleaned = imageline._remove_large_solid_interiors(alpha)
    assert cleaned[12, 50] == 255
    assert cleaned[22, 50] == 255
    assert cleaned[47, 50] == 0


def test_turnaround_solid_parts_use_a_narrower_hollowing_threshold():
    alpha = np.zeros((40, 50), dtype=np.uint8)
    alpha[10:30, 10:40] = 255
    alpha[33:38, 5:45] = 173
    background_cleaned = imageline._remove_large_solid_interiors(alpha)
    turnaround_cleaned = imageline._remove_large_solid_interiors(
        alpha,
        filter_size=11,
        thin_outline=True,
    )
    assert background_cleaned[20, 25] == 255
    assert turnaround_cleaned[20, 25] == 0
    assert turnaround_cleaned[11, 25] > 0
    assert np.count_nonzero(turnaround_cleaned[20, :40] >= 64) <= 8
    assert np.any(
        (turnaround_cleaned[20] > 0)
        & (turnaround_cleaned[20] < 255)
    )
    assert (turnaround_cleaned[33:38, 5:45] == 173).all()
    assert turnaround_cleaned[32, 25] == 0
    assert turnaround_cleaned[38, 25] == 0


def test_unnamed_turnaround_arm_layer_is_included_as_outline(tmp_path):
    from pytoshop.user import nested_layers

    line = np.zeros((200, 200, 4), dtype=np.uint8)
    line[20:180, 85:115] = [20, 20, 20, 255]
    path = tmp_path / "turn-authored-arm.psd"
    write_psd(path, [
        nested_layers.Group(name="TURN", layers=[
            nested_layers.Group(name="POSE", layers=[
                nested_layers.Group(name="LINES", layers=[
                    _rgba_layer("Layer 2", line),
                ]),
            ]),
        ]),
    ], width=200, height=200)
    mask, _ = extract_image_line(_session(path), OPTS)
    assert mask[100, 100] == 0
    assert mask[100, 86] == 255
    assert mask[100, 113] == 255


def test_turnaround_line_layers_outline_solid_parts_and_keep_thin_strokes(
        tmp_path):
    from pytoshop.user import nested_layers

    line = np.zeros((60, 70, 4), dtype=np.uint8)
    line[10:42, 10:34] = [20, 20, 20, 255]
    line[8:54, 55:58] = [20, 20, 20, 255]
    path = tmp_path / "turn-solid-parts.psd"
    write_psd(path, [
        nested_layers.Group(name="TURN", layers=[
            nested_layers.Group(name="POSE", layers=[
                nested_layers.Group(name="LINES", layers=[
                    _rgba_layer("LINE", line),
                ]),
            ]),
        ]),
    ], width=70, height=60)
    mask, _ = extract_image_line(_session(path), OPTS)
    assert mask[25, 22] == 0
    assert mask[11, 22] > 0
    assert mask[30, 56] > 0


def test_clipped_line_layer_does_not_add_coverage_outside_its_base(tmp_path):
    from pytoshop.user import nested_layers

    base = np.zeros((40, 60, 4), dtype=np.uint8)
    base[5:35, 9:12] = [20, 20, 20, 255]
    clipped = np.zeros((40, 60, 4), dtype=np.uint8)
    clipped[5:35, 39:42] = [220, 20, 40, 255]
    path = tmp_path / "clipped-line.psd"
    write_psd(path, [
        nested_layers.Group(name="TURN", layers=[
            nested_layers.Group(name="POSE", layers=[
                nested_layers.Group(name="LINE", layers=[
                    _rgba_layer("BASE LINE", base),
                    _rgba_layer("CLIPPED LINE", clipped),
                ]),
            ]),
        ]),
    ], width=60, height=40)
    session = _session(path)
    clipped_layer = next(
        layer for layer in session["psd"].descendants()
        if not layer.is_group() and layer.name == "CLIPPED LINE"
    )
    clipped_layer.clipping = True
    result = imageline._named_line_alpha(session)
    assert result is not None
    mask = result[0]
    assert mask[20, 10] > 0
    assert mask[20, 40] == 0


def test_standalone_pose_keeps_authored_sketch_and_ignores_reference_art(
        tmp_path):
    from pytoshop.user import nested_layers

    main_sketch = np.zeros((40, 60, 4), dtype=np.uint8)
    main_sketch[5:30, 9:18] = [10, 10, 10, 255]
    tone = np.zeros((40, 60, 4), dtype=np.uint8)
    tone[3:32, 5:24] = [160, 160, 160, 255]
    reference_sketch = np.zeros((40, 60, 4), dtype=np.uint8)
    reference_sketch[5:30, 29:32] = [10, 10, 10, 255]
    border = np.zeros((40, 60, 4), dtype=np.uint8)
    border[:, 49:52] = [10, 10, 10, 255]
    note = np.zeros((40, 60, 4), dtype=np.uint8)
    note[35:38, 4:14] = [10, 10, 10, 255]
    path = tmp_path / "standalone-pose.psd"
    write_psd(path, [
        nested_layers.Group(name="TEMPLATE", layers=[
            _rgba_layer("border", border),
            _rgba_layer(
                "** invisible lines affected by compo **",
                note,
            ),
        ]),
        nested_layers.Group(name="EXTRA REFS", layers=[
            nested_layers.Group(name="POSE", layers=[
                _rgba_layer("tone", tone),
                _rgba_layer("sketch", reference_sketch),
            ]),
        ]),
        nested_layers.Group(name="SPECIAL POSE", layers=[
            nested_layers.Group(name="POSE", layers=[
                _rgba_layer("tone", tone),
                _rgba_layer("sketch", main_sketch),
            ]),
        ]),
    ], width=60, height=40)
    result = imageline._named_line_alpha(_session(path))
    assert result is not None
    mask = result[0]
    assert result[-1] == "authoredPoseOnly"
    assert mask[20, 13] == 255
    assert mask[20, 30] == 0
    assert mask[20, 50] == 0
    assert mask[36, 8] == 255


def test_sketch_design_keeps_authored_marks_without_paper_or_references(
        tmp_path):
    from pytoshop.user import nested_layers

    paper = np.full((40, 60, 4), [255, 255, 255, 255], dtype=np.uint8)
    marks = np.zeros((40, 60, 4), dtype=np.uint8)
    marks[8:32, 20:23] = [210, 35, 55, 180]
    reference = np.zeros((40, 60, 4), dtype=np.uint8)
    reference[8:32, 40:43] = [10, 10, 10, 255]
    path = tmp_path / "sketch-design.psd"
    write_psd(path, [
        nested_layers.Group(name="EXTRA REFS", layers=[
            _rgba_layer("reference", reference),
        ]),
        nested_layers.Group(name="DESIGN", layers=[
            nested_layers.Group(name="pages", layers=[
                _rgba_layer("paper", paper),
                _rgba_layer("pencil marks", marks),
            ]),
        ]),
    ], width=60, height=40)
    result = imageline._isolated_style_alpha(_session(path)["psd"])
    assert result is not None
    mask, _, mode = result
    assert mode == "sketchDesign"
    assert mask[20, 21] == 180
    assert mask[20, 30] == 0
    assert mask[20, 41] == 0


def test_coloured_sketch_does_not_turn_white_face_fill_into_black_line():
    rgba = np.zeros((20, 30, 4), dtype=np.uint8)
    rgba[3:17, 5:25] = [255, 255, 255, 255]
    rgba[3:17, 5:8] = [20, 20, 20, 255]
    rgba[9:12, 12:15] = [240, 90, 130, 180]
    alpha = imageline._coloured_sketch_alpha(rgba)
    assert alpha[10, 20] == 0
    assert alpha[10, 6] == 255
    assert alpha[10, 13] == 180


def test_coloured_prop_preserves_line_alpha_and_only_outlines_fills(tmp_path):
    from pytoshop.user import nested_layers

    fill = np.zeros((40, 60, 4), dtype=np.uint8)
    fill[8:32, 20:45] = [245, 180, 30, 255]
    line = np.zeros((40, 60, 4), dtype=np.uint8)
    line[5:35, 10:13] = [160, 20, 10, 190]
    path = tmp_path / "coloured-prop.psd"
    write_psd(path, [
        nested_layers.Group(name="PROPS", layers=[
            nested_layers.Group(name="object", layers=[
                nested_layers.Group(name="colours", layers=[
                    _rgba_layer("fill", fill),
                ]),
                nested_layers.Group(name="lines", layers=[
                    _rgba_layer("red ink", line),
                ]),
            ]),
        ]),
    ], width=60, height=40)
    result = imageline._isolated_style_alpha(_session(path)["psd"])
    assert result is not None
    mask, _, mode = result
    assert mode == "colouredProp"
    assert mask[20, 11] == 190
    assert mask[8, 30] > 0
    assert mask[20, 30] == 0


def test_numbered_crowd_silhouettes_export_only_their_outlines(tmp_path):
    from pytoshop.user import nested_layers

    mg = np.zeros((60, 100, 4), dtype=np.uint8)
    mg[10:50, 10:35] = [80, 80, 80, 255]
    fg = np.zeros((60, 100, 4), dtype=np.uint8)
    fg[8:52, 60:90] = [120, 120, 120, 255]
    template = np.zeros((60, 100, 4), dtype=np.uint8)
    template[:, 48:51] = [20, 20, 20, 255]
    path = tmp_path / "crowd-silhouettes.psd"
    write_psd(path, [
        nested_layers.Group(name="TEMPLATE", layers=[
            _rgba_layer("frame", template),
        ]),
        nested_layers.Group(name="CROWD", layers=[
            nested_layers.Group(name="MG", layers=[
                _rgba_layer("05", mg),
            ]),
            nested_layers.Group(name="FG", layers=[
                _rgba_layer("01", fg),
            ]),
        ]),
    ], width=100, height=60)
    result = imageline._named_line_alpha(_session(path))
    assert result is not None
    mask = result[0]
    assert result[-1] == "crowdSilhouettes"
    assert mask[30, 20] == 0
    assert mask[30, 10] > 0
    assert mask[30, 75] == 0
    assert mask[30, 89] > 0
    assert mask[:, 49].max() == 0


def test_crowd_silhouette_hides_lower_outlines_behind_upper_figures(
        tmp_path):
    from pytoshop.user import nested_layers

    upper = np.zeros((50, 80, 4), dtype=np.uint8)
    upper[5:45, 10:50] = [80, 80, 80, 255]
    lower = np.zeros((50, 80, 4), dtype=np.uint8)
    lower[10:40, 30:70] = [120, 120, 120, 255]
    path = tmp_path / "overlapping-crowd.psd"
    write_psd(path, [
        nested_layers.Group(name="CROWD", layers=[
            nested_layers.Group(name="MG", layers=[
                _rgba_layer("05", upper),
                _rgba_layer("04", lower),
            ]),
        ]),
    ], width=80, height=50)
    mask = imageline._crowd_silhouette_alpha(_session(path)["psd"])[0]
    assert mask[25, 10] > 0
    assert mask[25, 49] > 0
    assert mask[25, 30] == 0
    assert mask[25, 69] > 0


def test_crowd_mode_keeps_visible_background_and_foreground_lines(
        tmp_path):
    from pytoshop.user import nested_layers

    crowd = np.zeros((60, 100, 4), dtype=np.uint8)
    crowd[15:45, 30:40] = [80, 80, 80, 255]
    wall = np.zeros((60, 100, 4), dtype=np.uint8)
    wall[29:32, 5:95] = [20, 20, 20, 255]
    neon = np.zeros((60, 100, 4), dtype=np.uint8)
    neon[5:20, 80:83] = [240, 240, 240, 255]
    fence = np.zeros((60, 100, 4), dtype=np.uint8)
    fence[5:55, 45:56] = [120, 120, 120, 255]
    path = tmp_path / "crowd-with-environment.psd"
    write_psd(path, [
        _rgba_layer("FENCE", fence),
        nested_layers.Group(name="CROWD", layers=[
            nested_layers.Group(name="MG", layers=[
                _rgba_layer("01", crowd),
            ]),
        ]),
        nested_layers.Group(name="LAYOUT", layers=[
            _rgba_layer("NEON", neon),
            _rgba_layer("wall line", wall),
        ]),
    ], width=100, height=60)
    mask = imageline._crowd_silhouette_alpha(_session(path)["psd"])[0]
    assert mask[30, 10] > 0
    assert mask[30, 35] == 0
    assert mask[30, 45] > 0
    assert mask[30, 50] == 0
    assert mask[10, 81] > 0


def test_multiple_prop_objects_are_kept_and_template_lines_are_excluded(
        tmp_path):
    from pytoshop.user import nested_layers

    template = np.zeros((40, 80, 4), dtype=np.uint8)
    template[5:35, 70, :] = [20, 20, 20, 255]

    def prop_object(name, x):
        fill = np.zeros((40, 80, 4), dtype=np.uint8)
        fill[10:30, x:x + 12] = [220, 90, 40, 255]
        line = np.zeros((40, 80, 4), dtype=np.uint8)
        line[7:33, x - 3:x] = [130, 45, 20, 190]
        return nested_layers.Group(name=name, layers=[
            nested_layers.Group(name="colours", layers=[
                _rgba_layer("fill", fill),
            ]),
            nested_layers.Group(name="lines", layers=[
                _rgba_layer("ink", line),
            ]),
        ])

    path = tmp_path / "multiple-props.psd"
    write_psd(path, [
        nested_layers.Group(name="TEMPLATE", layers=[
            _rgba_layer("Line", template),
        ]),
        nested_layers.Group(name="PROPS", layers=[
            prop_object("first", 15),
            prop_object("second", 45),
        ]),
    ], width=80, height=40)
    mask, _ = extract_image_line(_session(path), OPTS)
    assert mask[20, 13] >= 190
    assert mask[20, 43] >= 190
    assert mask[:, 70].max() == 0


def test_unnamed_drawing_root_is_extracted_without_template_chrome(tmp_path):
    from pytoshop.user import nested_layers

    template = np.zeros((40, 80, 4), dtype=np.uint8)
    template[5:35, 70, :] = [20, 20, 20, 255]
    drawing = np.full((40, 80, 4), [245, 245, 245, 255], dtype=np.uint8)
    drawing[5:35, 15:18, :3] = 20
    path = tmp_path / "drawing-root.psd"
    write_psd(path, [
        nested_layers.Group(name="TEMPLATE", layers=[
            _rgba_layer("border", template),
        ]),
        nested_layers.Group(name="DRAWINGS", layers=[
            _rgba_layer("Vertical", drawing),
        ]),
    ], width=80, height=40)
    mask, _ = extract_image_line(_session(path), OPTS)
    assert mask[20, 16] > 0
    assert mask[:, 70].max() == 0


def test_drawing_psd_and_matching_png_use_the_same_line_model(
        tmp_path, monkeypatch):
    from pytoshop.user import nested_layers

    template = np.zeros((40, 80, 4), dtype=np.uint8)
    template[5:35, 70, :] = [20, 20, 20, 255]
    drawing = np.zeros((40, 80, 4), dtype=np.uint8)
    drawing[5:35, 10:30, :] = [245, 245, 245, 255]
    drawing[8:32, 15:18, :3] = 20
    psd_path = tmp_path / "paired-drawing.psd"
    write_psd(psd_path, [
        nested_layers.Group(name="TEMPLATE", layers=[
            _rgba_layer("border", template),
        ]),
        nested_layers.Group(name="DRAWINGS", layers=[
            _rgba_layer("Vertical", drawing),
        ]),
    ], width=80, height=40)
    psd_session = _session(psd_path)
    png_path = psd_path.with_suffix(".png")
    Image.fromarray(_document_rgba(psd_session), "RGBA").save(png_path)

    def line_model(rgba):
        alpha = np.zeros(rgba.shape[:2], dtype=np.uint8)
        alpha[np.min(rgba[..., :3], axis=2) < 100] = 201
        return alpha

    monkeypatch.setattr(imageline, "_flattened_model_alpha", line_model)
    psd_mask, _ = extract_image_line(psd_session, OPTS)
    png_mask, _ = extract_image_line(_session(png_path), OPTS)
    assert np.array_equal(psd_mask, png_mask)
    assert psd_mask[20, 16] == 201
    assert psd_mask[:, 70].max() == 0
    assert imageline.image_line_profile(
        psd_session, OPTS)["flattenedStructure"] == "sourcePsd"


def test_full_canvas_color_layer_uses_existing_extractor_without_template(
        tmp_path, monkeypatch):
    from pytoshop.user import nested_layers

    color = np.full((40, 80, 4), [210, 160, 100, 255], dtype=np.uint8)
    color[5:35, 15:18, :3] = 20
    template = np.zeros((40, 80, 4), dtype=np.uint8)
    template[5:35, 70, :] = [20, 20, 20, 255]
    path = tmp_path / "flattened-color-layer.psd"
    write_psd(path, [
        _rgba_layer("Color", color),
        nested_layers.Group(name="TEMPLATE", layers=[
            _rgba_layer("frame", template),
        ]),
    ], width=80, height=40)

    monkeypatch.setattr(
        imageline,
        "_flattened_model_alpha",
        lambda _rgba: pytest.fail(
            "full-canvas Color PSD must keep the established extractor"),
    )
    session = _session(path)
    mask, _ = extract_image_line(session, OPTS)
    assert mask[20, 16] > 0
    assert mask[:, 70].max() == 0
    assert imageline.image_line_profile(
        session, OPTS)["specialLineStyle"] == "flattenedColourLayer"


def test_named_view_roots_are_kept_when_template_has_no_art_root(tmp_path):
    from pytoshop.user import nested_layers

    template = np.zeros((40, 80, 4), dtype=np.uint8)
    template[5:35, 70, :] = [20, 20, 20, 255]
    side = np.zeros((40, 80, 4), dtype=np.uint8)
    side[5:35, 15, :] = [80, 40, 30, 193]
    front = np.zeros((40, 80, 4), dtype=np.uint8)
    front[5:35, 45, :] = [80, 40, 30, 193]
    path = tmp_path / "named-views.psd"
    write_psd(path, [
        nested_layers.Group(name="TEMPLATE", layers=[
            _rgba_layer("Line", template),
        ]),
        nested_layers.Group(name="Fillables", layers=[]),
        nested_layers.Group(name="SIDE 3/4", layers=[
            _rgba_layer("Line", side),
        ]),
        nested_layers.Group(name="SWORD 1", layers=[
            _rgba_layer("Line", front),
        ]),
    ], width=80, height=40)
    mask, _ = extract_image_line(_session(path), OPTS)
    assert mask[20, 15] == 193
    assert mask[20, 45] == 193
    assert mask[:, 70].max() == 0


def test_annotation_groups_inside_production_roots_are_excluded(tmp_path):
    from pytoshop.user import nested_layers

    art = np.zeros((40, 80, 4), dtype=np.uint8)
    art[5:35, 15, :] = [80, 40, 30, 193]
    label = np.zeros((40, 80, 4), dtype=np.uint8)
    label[5:35, 55, :] = [20, 20, 20, 255]
    path = tmp_path / "turnaround-labels.psd"
    write_psd(path, [
        nested_layers.Group(name="TURNAROUND", layers=[
            nested_layers.Group(name="CHARACTER", layers=[
                _rgba_layer("Line", art),
            ]),
            nested_layers.Group(name="LABELS", layers=[
                _rgba_layer("Line", label),
            ]),
        ]),
    ], width=80, height=40)
    mask, _ = extract_image_line(_session(path), OPTS)
    assert mask[20, 15] == 193
    assert mask[:, 55].max() == 0


def test_matching_png_uses_its_psd_sibling_only_as_an_artwork_mask(
        tmp_path, monkeypatch):
    from pytoshop.user import nested_layers

    template = np.zeros((40, 80, 4), dtype=np.uint8)
    template[5:35, 70, :] = [20, 20, 20, 255]
    line = np.zeros((40, 80, 4), dtype=np.uint8)
    line[5:35, 15:18, :] = [80, 40, 30, 193]
    psd_path = tmp_path / "paired.psd"
    write_psd(psd_path, [
        nested_layers.Group(name="TEMPLATE", layers=[
            _rgba_layer("Line", template),
        ]),
        nested_layers.Group(name="PROPS", layers=[
            nested_layers.Group(name="lines", layers=[
                _rgba_layer("ink", line),
            ]),
        ]),
    ], width=80, height=40)
    psd_session = _session(psd_path)
    png_path = psd_path.with_suffix(".png")
    Image.fromarray(_document_rgba(psd_session), "RGBA").save(png_path)

    model = np.zeros((40, 80), dtype=np.uint8)
    model[5:35, 16] = 201
    model[5:35, 40] = 177
    model[5:35, 70] = 201
    monkeypatch.setattr(
        imageline, "_flattened_model_alpha", lambda _: model.copy())
    png_session = _session(png_path)
    png_mask, _ = extract_image_line(png_session, OPTS)
    assert png_mask[20, 16] == 201
    assert png_mask[:, 40].max() == 0
    assert png_mask[:, 70].max() == 0
    assert imageline.image_line_profile(
        png_session, OPTS)["flattenedStructure"] == "matchingSiblingPsd"


def test_changed_png_does_not_use_a_stale_psd_sibling(tmp_path):
    from pytoshop.user import nested_layers

    source = np.full((40, 80, 4), [245, 245, 245, 255], dtype=np.uint8)
    psd_path = tmp_path / "changed.psd"
    write_psd(psd_path, [
        nested_layers.Group(name="PROPS", layers=[
            _rgba_layer("paint", source),
        ]),
    ], width=80, height=40)
    rendered = _document_rgba(_session(psd_path))
    rendered[5:15, 5:15, :3] = [255, 0, 0]
    png_path = psd_path.with_suffix(".png")
    Image.fromarray(rendered, "RGBA").save(png_path)
    assert imageline._matching_sibling_psd_session(
        _session(png_path)) is None


def test_phone_interface_ignores_glow_but_keeps_authored_shapes(tmp_path):
    from pytoshop.user import nested_layers

    base = np.zeros((40, 80, 4), dtype=np.uint8)
    base[5:35, 5:30] = [180, 180, 220, 255]
    icon = np.zeros((40, 80, 4), dtype=np.uint8)
    icon[10:16, 12:18] = [255, 255, 255, 255]
    glow = np.zeros((40, 80, 4), dtype=np.uint8)
    glow[10:16, 34:40] = [255, 255, 255, 255]
    line = np.zeros((40, 80, 4), dtype=np.uint8)
    line[7:33, 7:10] = [10, 10, 10, 200]
    secondary_base = np.zeros((40, 80, 4), dtype=np.uint8)
    secondary_base[5:35, 45:75] = [180, 180, 220, 255]
    secondary_icon = np.zeros((40, 80, 4), dtype=np.uint8)
    secondary_icon[10:16, 55:61] = [255, 255, 255, 255]
    path = tmp_path / "phone.psd"
    write_psd(path, [
        nested_layers.Group(name="PHONE FRONT", layers=[
            nested_layers.Group(name="03 BASE", layers=[
                _rgba_layer("MAIN FILL", base),
            ]),
            nested_layers.Group(name="02 CONTENTS", layers=[
                _rgba_layer("ICON", icon),
                _rgba_layer("GLOWING ICON", glow),
            ]),
            nested_layers.Group(name="01 LINE", layers=[
                _rgba_layer("LINES", line),
            ]),
        ]),
        nested_layers.Group(name="TEMPLATE", layers=[
            nested_layers.Group(name="02 BASE", layers=[
                _rgba_layer("BASE", secondary_base),
            ]),
            nested_layers.Group(name="01 CONTENTS", layers=[
                _rgba_layer("ICON", secondary_icon),
            ]),
        ]),
    ], width=80, height=40)
    result = imageline._isolated_style_alpha(_session(path)["psd"])
    assert result is not None
    mask, _, mode = result
    assert mode == "phoneInterfaceNoGlow"
    assert mask[20, 8] == 200
    assert mask[10, 14] > 0
    assert mask[12, 36] == 0
    assert mask[20, 43:49].max() > 0
    assert mask[8:13, 55:61].max() > 0


def test_drawing_panel_style_fills_only_dark_stroke_interiors():
    mask = np.zeros((30, 50), dtype=np.uint8)
    mask[5:25, 10] = 255
    mask[5:25, 14] = 255
    mask[5:25, 35] = 255
    rgba = np.full((30, 50, 4), 255, dtype=np.uint8)
    rgba[5:25, 10:15, :3] = 20
    rgba[5:25, 35:40, :3] = 20
    result = imageline._fill_drawing_panel_strokes(
        mask,
        rgba,
        [(0, 0, 25, 30)],
    )
    assert result[15, 12] == 255
    assert result[15, 37] == 0


def test_paired_character_colour_and_line_groups_outline_solid_parts(
        tmp_path):
    from pytoshop.user import nested_layers

    line = np.zeros((50, 60, 4), dtype=np.uint8)
    line[10:40, 12:38] = [20, 20, 20, 255]
    fill = np.zeros((50, 60, 4), dtype=np.uint8)
    fill[8:42, 10:40] = [220, 40, 90, 255]
    path = tmp_path / "design-solid-parts.psd"
    write_psd(path, [
        nested_layers.Group(name="DESIGN", layers=[
            nested_layers.Group(name="POSE", layers=[
                nested_layers.Group(name="COLOURS", layers=[
                    _rgba_layer("body colour", fill),
                ]),
                nested_layers.Group(name="LINES", layers=[
                    _rgba_layer("LINE", line),
                ]),
            ]),
        ]),
    ], width=60, height=50)
    mask, _ = extract_image_line(_session(path), OPTS)
    assert mask[25, 25] == 0
    assert mask[11, 25] > 0


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


def test_abrupt_colour_only_boundary_is_added(tmp_path):
    rgba = np.zeros((20, 18, 4), dtype=np.uint8)
    rgba[:, :9] = [220, 20, 20, 255]
    rgba[:, 9:] = [20, 80, 230, 255]
    path = tmp_path / "boundary.psd"
    write_psd(path, [_rgba_layer("art", rgba)], width=18, height=20)
    mask, _ = extract_image_line(_session(path), OPTS)
    assert mask[:, 8:10].max() > 0


def test_tiny_colour_only_speck_is_not_promoted_to_line_art(tmp_path):
    rgba = np.full((28, 28, 4), [235, 225, 200, 255], dtype=np.uint8)
    rgba[11:17, 11:17, :3] = [250, 245, 135]
    path = tmp_path / "colour-speck.psd"
    write_psd(path, [_rgba_layer("art", rgba)], width=28, height=28)
    mask, _ = extract_image_line(_session(path), OPTS)
    assert mask.max() == 0


def test_colour_only_bulb_gets_a_closed_line_without_filling_its_interior(tmp_path):
    rgba = np.full((48, 48, 4), [235, 225, 200, 255], dtype=np.uint8)
    yy, xx = np.ogrid[:48, :48]
    bulb = (xx - 24) ** 2 + (yy - 24) ** 2 <= 12 ** 2
    rgba[bulb, :3] = [250, 245, 135]
    path = tmp_path / "bulb.psd"
    write_psd(path, [_rgba_layer("art", rgba)], width=48, height=48)
    mask, _ = extract_image_line(_session(path), OPTS)
    assert mask[12, 24] > 0
    assert mask[24, 12] > 0
    assert mask[24, 36] > 0
    assert mask[36, 24] > 0
    bulb_inner = np.array(
        Image.fromarray(bulb.astype(np.uint8) * 255, "L").filter(
            ImageFilter.MinFilter(3)
        )
    ) > 0
    solid_nearby = np.array(
        Image.fromarray((mask >= 100).astype(np.uint8) * 255, "L").filter(
            ImageFilter.MaxFilter(3)
        )
    ) > 0
    assert solid_nearby[bulb & ~bulb_inner].all()
    assert mask[24, 24] == 0


def test_smooth_illumination_gradient_does_not_become_a_line(tmp_path):
    yy, xx = np.ogrid[:64, :64]
    radius = np.sqrt((xx - 32) ** 2 + (yy - 32) ** 2)
    value = np.clip(235 + radius * 0.25, 0, 255).astype(np.uint8)
    rgba = np.empty((64, 64, 4), dtype=np.uint8)
    rgba[..., :3] = value[..., None]
    rgba[..., 3] = 255
    path = tmp_path / "glow.psd"
    write_psd(path, [_rgba_layer("art", rgba)], width=64, height=64)
    mask, _ = extract_image_line(_session(path), OPTS)
    assert mask.max() == 0


def test_colour_only_edge_stays_continuous_across_internal_tiles(tmp_path):
    rgba = np.empty((64, 1100, 4), dtype=np.uint8)
    rgba[:, :1024] = [220, 40, 40, 255]
    rgba[:, 1024:] = [40, 80, 220, 255]
    path = tmp_path / "tile-seam.psd"
    write_psd(path, [_rgba_layer("art", rgba)], width=1100, height=64)
    mask, _ = extract_image_line(_session(path), OPTS)
    assert (mask[4:60, 1023:1025].max(axis=1) > 0).all()


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
    assert mask[:, 6].max() <= 5
    assert mask[:, 13].max() <= 5


def test_colour_only_boundary_has_no_transparent_gap_inside_its_stroke(tmp_path):
    rgba = np.empty((24, 32, 4), dtype=np.uint8)
    rgba[:, :16] = [225, 65, 50, 255]
    rgba[:, 16:] = [45, 90, 220, 255]
    path = tmp_path / "solid-colour-boundary.psd"
    write_psd(path, [_rgba_layer("art", rgba)], width=32, height=24)
    mask, _ = extract_image_line(_session(path), OPTS)
    row = mask[12]
    core = np.flatnonzero(row >= 64)
    assert core.size >= 1
    assert row[core[0]:core[-1] + 1].min() >= 64
    assert 100 <= row[core[0]:core[-1] + 1].max() <= 232


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
    assert rendered[6, 10].tolist() == [
        61, 61, 61, int(mask[6, 10]),
    ]


def test_rendered_line_keeps_uniform_rgb_and_antialiased_alpha():
    mask = np.array([[0, 16, 64, 173, 255]], dtype=np.uint8)
    rendered = mask_to_rgba(mask, "#3d3d3d")
    assert (rendered[0, :, :3] == [61, 61, 61]).all()
    assert rendered[0, :, 3].tolist() == [0, 16, 64, 173, 255]


def test_opaque_authored_lines_and_component_lines_are_extracted(tmp_path):
    from pytoshop.user import nested_layers

    body = np.zeros((50, 70, 4), dtype=np.uint8)
    body[5:45, 20, :] = [20, 20, 20, 255]
    mic = np.zeros((50, 70, 4), dtype=np.uint8)
    mic[10:40, 50, :] = [20, 20, 20, 255]
    mic_fill = np.zeros((50, 70, 4), dtype=np.uint8)
    mic_fill[15:35, 45:55, :] = [180, 30, 50, 255]
    path = tmp_path / "authored-turn-lines.psd"
    write_psd(path, [
        nested_layers.Group(name="TURN", layers=[
            nested_layers.Group(name="LINES", layers=[
                _rgba_layer("body", body),
            ]),
            nested_layers.Group(name="MIC", layers=[
                _rgba_layer("mic colors", mic_fill),
                _rgba_layer("mic", mic),
            ]),
        ]),
    ], width=70, height=50)
    mask, _ = extract_image_line(_session(path), OPTS)
    assert mask[5:45, 20].min() == 255
    assert mask[10:40, 50].min() == 255
    assert mask[15:35, 45:55].max() == 255
    assert mask[20, 47] == 0


def test_turn_colour_boundary_reaches_authored_line_without_crossing(
        tmp_path, monkeypatch):
    from pytoshop.user import nested_layers

    line = np.zeros((50, 70, 4), dtype=np.uint8)
    line[25, 25:45, :] = [20, 20, 20, 255]
    left = np.zeros((50, 70, 4), dtype=np.uint8)
    left[5:45, 10:35, :] = [220, 40, 80, 255]
    right = np.zeros((50, 70, 4), dtype=np.uint8)
    right[5:45, 35:60, :] = [60, 30, 45, 255]
    path = tmp_path / "turn-colour-crossing.psd"
    write_psd(path, [
        nested_layers.Group(name="TURN", layers=[
            nested_layers.Group(name="COLORS", layers=[
                _rgba_layer("left", left),
                _rgba_layer("right", right),
            ]),
            nested_layers.Group(name="LINES", layers=[
                _rgba_layer("body", line),
            ]),
        ]),
    ], width=70, height=50)
    rendered = np.zeros((50, 70, 4), dtype=np.uint8)
    rendered[5:45, 10:35, :] = [220, 40, 80, 255]
    rendered[5:45, 35:60, :] = [60, 30, 45, 255]
    final_rendered = rendered.copy()
    final_rendered[26:45, 10:60, :] = [220, 40, 80, 255]
    session = _session(path)
    colors = next(
        layer for layer in session["psd"].descendants()
        if layer.is_group() and layer.name == "COLORS"
    )
    monkeypatch.setattr(
        type(colors),
        "composite",
        lambda self: Image.fromarray(
            (
                rendered.copy()
                if self.name == "COLORS"
                else final_rendered.copy()
            ),
            "RGBA",
        ),
    )
    monkeypatch.setattr(
        imageline,
        "_document_rgba",
        lambda session: final_rendered.copy(),
    )
    mask, _ = extract_image_line(session, OPTS)
    assert mask[20:25, 34].min() > 0
    assert mask[25, 25:45].min() == 255
    assert mask[26:31, 34].max() == 0


def test_occluded_turn_colour_boundary_is_not_added(tmp_path, monkeypatch):
    from pytoshop.user import nested_layers

    line = np.zeros((50, 70, 4), dtype=np.uint8)
    line[25, 25:45, :] = [20, 20, 20, 255]
    colour = np.zeros((50, 70, 4), dtype=np.uint8)
    colour[5:45, 10:35, :] = [220, 40, 80, 255]
    colour[5:45, 35:60, :] = [60, 30, 45, 255]
    path = tmp_path / "occluded-turn-colour.psd"
    write_psd(path, [
        nested_layers.Group(name="TURN", layers=[
            nested_layers.Group(name="HAIR COLOUR", layers=[
                _rgba_layer("hair", colour),
            ]),
            nested_layers.Group(name="LINES", layers=[
                _rgba_layer("body", line),
            ]),
        ]),
    ], width=70, height=50)
    uniform = np.full((50, 70, 4), [120, 80, 90, 255], dtype=np.uint8)
    session = _session(path)
    group_type = type(next(
        layer for layer in session["psd"] if layer.name == "TURN"
    ))

    def composite(group):
        image = colour if group.name == "HAIR COLOUR" else uniform
        return Image.fromarray(image.copy(), "RGBA")

    monkeypatch.setattr(group_type, "composite", composite)
    monkeypatch.setattr(
        imageline,
        "_document_rgba",
        lambda session: uniform.copy(),
    )
    mask, _ = extract_image_line(session, OPTS)
    assert mask[20:25, 34].max() == 0
    assert mask[25, 25:45].min() == 255


def test_visible_colour_boundary_short_gaps_are_bridged():
    edges = np.zeros((30, 20), dtype=np.uint8)
    edges[2:28, 10] = 255
    support = np.zeros((30, 20), dtype=bool)
    support[2:12, 10] = True
    support[17:28, 10] = True
    kept = imageline._retain_visible_edge_runs(edges, support)
    assert kept[2:28, 10].min() == 255


def test_direct_hair_fill_layers_get_internal_boundaries(
        tmp_path, monkeypatch):
    from pytoshop.user import nested_layers

    base = np.zeros((50, 70, 4), dtype=np.uint8)
    base[5:45, 10:60, :] = [220, 120, 90, 255]
    detail = np.zeros((50, 70, 4), dtype=np.uint8)
    detail[5:45, 35:60, :] = [180, 80, 70, 255]
    line = np.zeros((50, 70, 4), dtype=np.uint8)
    line[25, 10:60, :] = [20, 20, 20, 255]
    path = tmp_path / "direct-hair-colour.psd"
    write_psd(path, [
        nested_layers.Group(name="TURN", layers=[
            nested_layers.Group(name="HAIR", layers=[
                _rgba_layer("hair base", base),
                _rgba_layer("hair detail", detail),
                _rgba_layer("hair line", line),
            ]),
        ]),
    ], width=70, height=50)
    rendered = base.copy()
    rendered[5:45, 35:60, :] = [180, 80, 70, 255]
    rendered[25, 10:60, :] = [20, 20, 20, 255]
    session = _session(path)
    hair = next(
        layer for layer in session["psd"].descendants()
        if layer.is_group() and layer.name == "HAIR"
    )
    monkeypatch.setattr(
        type(hair),
        "composite",
        lambda self: Image.fromarray(rendered.copy(), "RGBA"),
    )
    monkeypatch.setattr(
        imageline,
        "_document_rgba",
        lambda session: rendered.copy(),
    )
    mask, _ = extract_image_line(session, OPTS)
    assert mask[10:20, 34].min() > 0
    assert mask[25, 10:60].min() > 0


def test_fill_inside_mixed_line_container_is_hollowed(tmp_path):
    from pytoshop.user import nested_layers

    authored = np.zeros((50, 70, 4), dtype=np.uint8)
    authored[5:45, 15, :] = [20, 20, 20, 255]
    authored[10:40, 35:65, :] = [20, 20, 20, 255]
    fill = np.zeros((50, 70, 4), dtype=np.uint8)
    fill[10:40, 35:65, :] = [100, 40, 60, 255]
    path = tmp_path / "mixed-line-container.psd"
    write_psd(path, [
        nested_layers.Group(name="ART", layers=[
            nested_layers.Group(name="LINE", layers=[
                nested_layers.Group(name="COLOUR", layers=[
                    _rgba_layer("prop fill", fill),
                ]),
                nested_layers.Group(name="drawing", layers=[
                    _rgba_layer("ink", authored),
                ]),
            ]),
        ]),
    ], width=70, height=50)
    mask, _ = extract_image_line(_session(path), OPTS)
    assert mask[5:45, 15].min() >= 240
    assert mask[10, 35:65].min() >= 240
    assert mask[25, 50] == 0


def test_png_export_has_white_paper_background_and_uses_mask_hash(tmp_path):
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
    assert (arr[..., 3] == 255).all()
    assert arr[0, 0].tolist() == [255, 255, 255, 255]
    expected_red = 255
    expected_alpha = mask_to_rgba(expected_mask, "#ff0000")[4, 4, 3]
    expected_other = 255 - expected_alpha
    assert arr[4, 4].tolist() == [
        expected_red, expected_other, expected_other, 255,
    ]


def test_psd_export_has_transparent_line_over_white_background(tmp_path):
    rgba = np.zeros((11, 13, 4), dtype=np.uint8)
    rgba[1:10, 6] = [0, 0, 0, 255]
    path = tmp_path / "src.psd"
    write_psd(path, [_rgba_layer("art", rgba)], width=13, height=11)
    out = tmp_path / "out.psd"
    result = export_image_line(_session(path), out, "psd", OPTS, "#00ff00", overwrite=False)
    psd = PSDImage.open(out)
    layers = list(psd)
    line = np.array(layers[0].topil().convert("RGBA"))
    background = np.array(layers[1].topil().convert("RGBA"))
    composite = np.array(
        psd.composite(force=True, color=1.0, alpha=0.0).convert("RGBA"))
    assert result["layerCount"] == 2
    assert result["verification"]["ok"] is True
    assert (psd.width, psd.height) == (13, 11)
    assert len(layers) == 2
    assert layers[0].name == "color_to_line"
    assert layers[1].name == "Background"
    assert line[0, 0, 3] == 0
    assert line[..., 3].max() > 0
    fringe = (line[..., 3] > 0) & (line[..., 3] < 255)
    assert fringe.any()
    assert (line[line[..., 3] > 0, :3] == [0, 255, 0]).all()
    assert (background == 255).all()
    assert composite[0, 0].tolist() == [255, 255, 255, 255]


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
    assert sample["f1"] >= 0.8
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


def test_color_only_bulb_qa_report_proves_complete_clean_boundary():
    path = Path(__file__).parent / "fixtures" / "color_only_edge_qa_report.json"
    report = json.loads(path.read_text(encoding="utf-8"))
    bulb = report["bulbSegmentation"]
    output = report["output"]
    performance = report["performance"]
    assert bulb["directBoundaryCoverage"] >= 0.95
    assert bulb["twoPixelBoundaryCoverage"] >= 0.99
    assert report["gradientRejection"]["syntheticRegression"] is True
    assert report["gradientRejection"]["realRadialGlowOutlineRejected"] is True
    assert output["pngReadbackVerified"] is True
    assert output["psdReadbackVerified"] is True
    assert output["pngPsdMaskEqual"] is True
    assert output["opaqueCoreRgba"] == [61, 61, 61, 255]
    assert performance["withinBudget"] is True
    assert performance["peakTrackedArrayBytes"] <= performance["steadyBudgetBytes"]
    assert (
        performance["algorithmPeakRssDeltaBytes"]
        <= performance["peakBudgetBytes"]
    )


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
