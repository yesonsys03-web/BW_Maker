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


def test_op_naming_a_layer_outside_the_included_set_is_skipped():
    # included_ids가 기준이므로, 거기 없는 레이어를 가리키는 작업은 적용할 대상이
    # 없다. 예전에는 KeyError를 던져 내보내기 전체가 실패했다 — 병합에 쓰인
    # 레이어의 체크를 푸는 것만으로 재현된다.
    assert ids(build_export_plan(INCLUDED, [{"op": "exclude", "layerIds": [99]}])) == INCLUDED
    assert ids(build_export_plan(INCLUDED, [{"op": "rename", "layerId": 99, "name": "x"}])) == INCLUDED


def test_merge_drops_sources_that_are_not_included():
    # 3과 4를 병합해뒀다가 3의 체크를 푼 상태. 남은 4가 병합의 이름을 이어받는다.
    plan = build_export_plan([4, 5], [{"op": "merge", "layerIds": [3, 4], "name": "M"}])
    merged = [e for e in plan if 4 in e["sourceIds"]][0]
    assert merged["name"] == "M"
    assert merged["sourceIds"] == [4]
    assert len(plan) == 2


def test_merge_with_no_included_sources_left_does_nothing():
    plan = build_export_plan([5], [{"op": "merge", "layerIds": [3, 4], "name": "M"}])
    assert plan == [{"entryId": 5, "sourceIds": [5], "name": None}]


def test_a_merge_reduced_to_one_source_keeps_its_merged_entry_id():
    # 뒤따르는 작업이 병합 결과를 가리킬 수 있어야 한다.
    plan = build_export_plan(
        [4, 5],
        [
            {"op": "merge", "layerIds": [3, 4], "name": "M"},
            {"op": "rename", "layerId": -1, "name": "RENAMED"},
        ],
    )
    assert [e for e in plan if 4 in e["sourceIds"]][0]["name"] == "RENAMED"


def test_reorder_is_skipped_when_its_reference_is_not_included():
    plan = build_export_plan([4, 5], [{"op": "reorder", "layerId": 5, "aboveId": 3}])
    assert ids(plan) == [4, 5]


def test_engine_and_ui_agree_on_a_merge_missing_one_source():
    # src/lib/opsReducer.ts의 같은 시나리오와 결과가 일치해야 한다. 어긋나면
    # 화면에서는 멀쩡한데 내보내기만 실패한다.
    plan = build_export_plan([1, 5], [{"op": "merge", "layerIds": [1, 2], "name": "M"}])
    survivor = [e for e in plan if 1 in e["sourceIds"]][0]
    assert (survivor["name"], survivor["sourceIds"]) == ("M", [1])


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


def test_unmerge_pulls_one_layer_out_and_leaves_the_rest_merged():
    plan = build_export_plan(INCLUDED, [
        {"op": "merge", "layerIds": [3, 4, 5], "name": "BG"},
        {"op": "unmerge", "layerIds": [4]},
    ])
    merged = [e for e in plan if len(e["sourceIds"]) > 1][0]
    assert merged["sourceIds"] == [3, 5] and merged["name"] == "BG"
    assert {"entryId": 4, "sourceIds": [4], "name": None} in plan


def test_unmerge_keeps_the_layer_in_the_export():
    plan = build_export_plan(INCLUDED, [
        {"op": "merge", "layerIds": [3, 4, 5], "name": "BG"},
        {"op": "unmerge", "layerIds": [4]},
    ])
    assert sorted(i for e in plan for i in e["sourceIds"]) == [3, 4, 5]


def test_unmerging_every_source_dissolves_the_merge():
    plan = build_export_plan(INCLUDED, [
        {"op": "merge", "layerIds": [3, 4, 5], "name": "BG"},
        {"op": "unmerge", "layerIds": [3, 4, 5]},
    ])
    assert sorted(ids(plan)) == [3, 4, 5]
    assert all(e["name"] is None for e in plan)


def test_unmerge_on_an_unmerged_layer_does_nothing():
    assert build_export_plan(INCLUDED, [{"op": "unmerge", "layerIds": [4]}]) == \
        build_export_plan(INCLUDED, [])


def test_engine_and_ui_agree_on_unmerge():
    # src/lib/opsReducer.ts의 같은 시나리오와 결과가 일치해야 한다.
    plan = build_export_plan(INCLUDED, [
        {"op": "merge", "layerIds": [3, 4, 5], "name": "BG"},
        {"op": "unmerge", "layerIds": [4]},
    ])
    merged_idx = next(i for i, e in enumerate(plan) if len(e["sourceIds"]) > 1)
    assert plan[merged_idx + 1]["entryId"] == 4
