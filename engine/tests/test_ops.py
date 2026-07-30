import pytest
from psd_tools import PSDImage

from psd_engine.ops import build_export_plan, finalize_names
from psd_engine.tree import build_tree

INCLUDED = [3, 4, 5]  # fixture: hidden line, line, lines (아래→위)


def ids(entries):
    return [e["entryId"] for e in entries]


def test_no_ops_keeps_order():
    assert ids(build_export_plan(INCLUDED, [])) == [3, 4, 5]


def test_exclude():
    plan = build_export_plan(INCLUDED, [{"op": "exclude", "layerIds": [4]}])
    assert ids(plan) == [3, 5]


def test_exclude_unknown_raises():
    with pytest.raises(KeyError):
        build_export_plan(INCLUDED, [{"op": "exclude", "layerIds": [99]}])


def test_rename():
    plan = build_export_plan(INCLUDED, [{"op": "rename", "layerId": 5, "name": "L"}])
    assert plan[2]["name"] == "L"


def test_merge_replaces_at_topmost_and_orders_sources():
    plan = build_export_plan(INCLUDED, [{"op": "merge", "layerIds": [5, 3], "name": "M"}])
    assert ids(plan) == [4, -1]
    merged = plan[1]
    assert merged["sourceIds"] == [3, 5]   # 아래→위 순서 유지
    assert merged["name"] == "M"


def test_merge_result_can_be_merged_again():
    plan = build_export_plan(INCLUDED, [
        {"op": "merge", "layerIds": [3, 4], "name": "A"},
        {"op": "merge", "layerIds": [-1, 5], "name": "B"},
    ])
    assert ids(plan) == [-2]
    assert plan[0]["sourceIds"] == [3, 4, 5]


def test_flatten():
    plan = build_export_plan(INCLUDED, [{"op": "flatten", "name": "F"}])
    assert ids(plan) == [-1]
    assert plan[0]["sourceIds"] == [3, 4, 5]


def test_reorder_above_and_bottom():
    plan = build_export_plan(INCLUDED, [{"op": "reorder", "layerId": 3, "aboveId": 5}])
    assert ids(plan) == [4, 5, 3]
    plan = build_export_plan(INCLUDED, [{"op": "reorder", "layerId": 5, "aboveId": None}])
    assert ids(plan) == [5, 3, 4]


def test_finalize_names(fixture_psd):
    nodes = build_tree(PSDImage.open(fixture_psd))["nodes_by_id"]
    entries = build_export_plan(INCLUDED, [])
    finalize_names(entries, nodes, "pathPrefix")
    # path: *ART/BG/hidden line → BG_hidden line, *ART/BG/line → BG_line, *ART/lines → lines
    assert [e["finalName"] for e in entries] == ["BG_hidden line", "BG_line", "lines"]

    entries = build_export_plan(INCLUDED, [])
    finalize_names(entries, nodes, "original")
    assert [e["finalName"] for e in entries] == ["hidden line", "line", "lines"]


def test_finalize_names_dedup(fixture_psd):
    nodes = build_tree(PSDImage.open(fixture_psd))["nodes_by_id"]
    entries = build_export_plan([4, 7], [])   # 둘 다 원본 이름 'line'
    finalize_names(entries, nodes, "original")
    assert [e["finalName"] for e in entries] == ["line", "line_2"]


def test_finalize_names_dedup_base_base2_base():
    """Regression: base/base_2/base should get unique finalNames."""
    entries = [
        {"entryId": 1, "sourceIds": [1], "name": None},
        {"entryId": 2, "sourceIds": [2], "name": None},
        {"entryId": 3, "sourceIds": [3], "name": None},
    ]
    nodes_by_id = {
        1: {"path": ["base"]},
        2: {"path": ["base_2"]},
        3: {"path": ["base"]},
    }
    finalize_names(entries, nodes_by_id, "original")
    finals = [e["finalName"] for e in entries]
    # All three should be unique despite base/base_2/base pattern
    assert finals == ["base", "base_2", "base_3"]
    assert len(set(finals)) == 3


def test_path_prefix_filters_only_autogen_groups():
    """Regression: Group N (auto-generated) should be filtered, Group Photos (user-named) should not."""
    entries = [
        {"entryId": 1, "sourceIds": [1], "name": None},
        {"entryId": 2, "sourceIds": [2], "name": None},
    ]
    nodes_by_id = {
        1: {"path": ["Group 2", "photo"]},    # Group 2 = auto-gen, should be removed
        2: {"path": ["Group Photos", "image"]},  # Group Photos = user-named, should stay
    }
    finalize_names(entries, nodes_by_id, "pathPrefix")
    assert [e["finalName"] for e in entries] == ["photo", "Group Photos_image"]
