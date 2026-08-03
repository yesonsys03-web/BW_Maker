import pytest
from psd_tools import PSDImage

from psd_engine.matching import (auto_merge_operations, auto_merge_preview,
                                 match_preset, preset_operations)
from psd_engine.tree import build_tree


def _preset(**over):
    p = {
        "include": {"type": "contains", "value": "line", "caseSensitive": False},
        "excludeGroupPrefixes": ["-"],
        "matchGroups": True,
        "includeHidden": True,
        "merge": "none",
        "naming": "pathPrefix",
        "outputSuffix": "_LINE",
        "embedPreview": True,
    }
    p.update(over)
    return p


@pytest.fixture
def tree(fixture_psd):
    return build_tree(PSDImage.open(fixture_psd))["tree"]


def test_contains_with_exclude_prefix(tree):
    # 'hidden line'(3), 'line'(4), 'lines'(5). -REF의 line(7)은 제외
    assert match_preset(tree, _preset()) == ([3, 4, 5], [])


def test_include_hidden_false(tree):
    assert match_preset(tree, _preset(includeHidden=False)) == ([4, 5], [])


def test_no_exclude_prefix_includes_ref(tree):
    assert match_preset(tree, _preset(excludeGroupPrefixes=[])) == ([3, 4, 5, 7], [])


def test_regex(tree):
    p = _preset(include={"type": "regex", "value": r"^line$", "caseSensitive": False})
    assert match_preset(tree, p) == ([4], [])


def test_matched_group_pulls_descendants(tree):
    # 'BG'가 매치되는 규칙 → BG 하위 픽셀 전부 포함. BG 안에는 이름이 'bg'인
    # leaf가 없으므로 그룹 이름이 유일한 단서고, 일괄 포함이 유지된다.
    p = _preset(include={"type": "contains", "value": "bg", "caseSensitive": False})
    assert match_preset(tree, p) == ([2, 3, 4], [])


def test_preset_operations_merge_all(tree):
    ids, _ = match_preset(tree, _preset())
    ops = preset_operations(tree, ids, _preset(merge="all"))
    assert ops == [{"op": "merge", "layerIds": [3, 4, 5], "name": "merged"}]


def test_preset_operations_per_group(tree):
    ids, _ = match_preset(tree, _preset())
    ops = preset_operations(tree, ids, _preset(merge="perGroup"))
    # BG 그룹 안의 3,4만 2개 이상 → 병합. 'lines'(5)는 단독이라 그대로.
    assert ops == [{"op": "merge", "layerIds": [3, 4], "name": "BG"}]


def _node(node_id, name, kind, has_pixels, **over):
    node = {
        "id": node_id, "name": name, "kind": kind, "visible": True,
        "path": [name], "hasPixels": has_pixels,
    }
    node.update(over)
    return node


# 실제 작업 파일에서 온 이름들이다. 예전에는 이런 레이어 하나가 파일 전체의
# 프리셋 적용을 실패시켜 아무것도 못 뽑았다.
def test_text_note_is_skipped_even_though_photoshop_rasterized_it():
    tree = [_node(0, "NOTE FOR LINE: apply penthouse wallpaper", "type", True)]

    matched, skipped = match_preset(tree, _preset())

    assert matched == []
    assert skipped == [{
        "id": 0,
        "path": "NOTE FOR LINE: apply penthouse wallpaper",
        "kind": "type",
        "reason": "text",
    }]


def test_a_smart_object_with_pixels_is_line_art_and_comes_through():
    tree = [_node(0, "LINES", "smartobject", True, path=["LayOut", "BG", "trims", "LINES"])]

    matched, skipped = match_preset(tree, _preset())

    assert matched == [0]
    assert skipped == []


def test_a_shape_layer_with_pixels_comes_through_too():
    assert match_preset([_node(0, "line", "shape", True)], _preset()) == ([0], [])


def test_a_layer_with_nothing_to_draw_is_skipped_and_named():
    # 조정 레이어처럼 그릴 채널이 없는 것. 종류가 아니라 픽셀 유무로 가른다.
    tree = [_node(0, "line curves", "curves", False)]

    matched, skipped = match_preset(tree, _preset())

    assert matched == []
    assert skipped[0]["reason"] == "noPixels"
    assert skipped[0]["path"] == "line curves"


def test_a_tree_from_before_hasPixels_still_matches_pixel_layers_only():
    # 이 필드가 생기기 전의 트리(예: 옛 세션)에서도 동작이 달라지면 안 된다.
    old_pixel = {"id": 0, "name": "line", "kind": "pixel", "visible": True, "path": ["line"]}
    old_smart = {"id": 1, "name": "line2", "kind": "smartobject", "visible": True, "path": ["line2"]}

    matched, skipped = match_preset([old_pixel, old_smart], _preset())

    assert matched == [0]
    assert [s["reason"] for s in skipped] == ["noPixels"]


def test_unknown_include_type_raises_valueerror():
    # 알 수 없는 include type → ValueError
    tree = [
        {
            "id": 0,
            "name": "line",
            "kind": "pixel",
            "visible": True,
            "path": ["line"],
        }
    ]
    p = _preset(include={"type": "unknown", "value": "line", "caseSensitive": False})
    with pytest.raises(ValueError, match="unknown include type"):
        match_preset(tree, p)


def test_unknown_merge_mode_raises_valueerror():
    # 알 수 없는 merge mode → ValueError
    tree = [
        {
            "id": 0,
            "name": "line",
            "kind": "pixel",
            "visible": True,
            "path": ["line"],
        }
    ]
    ids = [0]
    p = _preset(merge="unknown")
    with pytest.raises(ValueError, match="unknown merge mode"):
        preset_operations(tree, ids, p)


# ---- byElement: 요소별 자동 병합 ----

def _leaf(i, name, path):
    return {"id": i, "name": name, "kind": "pixel", "path": path + [name]}


def _group(i, name, path, children):
    return {"id": i, "name": name, "kind": "group", "path": path + [name],
            "children": children}


# 실제 소스의 형태: 요소 그룹 이름 접미사가 역할(UL/OL)을 나타내고, 접미사가
# 없으면 BG. 문서 순서상 BG 요소(TABLE)가 OL 요소보다 위에 오는 것도 실제와 같다.
ROLE_TREE = [
    _group(100, "*ART", [], [
        _group(110, "ROOM", ["*ART"], [_leaf(1, "LINE", ["*ART", "ROOM"])]),
        _group(120, "CHAIR2_UL", ["*ART"], [_leaf(2, "LINE", ["*ART", "CHAIR2_UL"])]),
        _group(130, "CHAIR2_OL", ["*ART"], [_leaf(3, "LINE", ["*ART", "CHAIR2_OL"])]),
        _group(140, "SOFA_UL", ["*ART"], [_leaf(4, "LINE", ["*ART", "SOFA_UL"])]),
        _group(150, "TABLE", ["*ART"], [_leaf(5, "LINE", ["*ART", "TABLE"])]),
    ]),
]
ROLE_MATCHED = [1, 2, 3, 4, 5]


def _ops(matched=ROLE_MATCHED, tree=ROLE_TREE, tokens=None):
    return auto_merge_operations(tree, matched, tokens)


def _merges(ops):
    return [(op["name"], op["layerIds"]) for op in ops if op["op"] == "merge"]


def test_auto_merge_joins_the_ul_and_ol_of_one_element():
    # CHAIR2_UL과 CHAIR2_OL은 한 요소(CHAIR2)의 앞뒤 파트다.
    assert _merges(_ops()) == [
        ("BG", [1, 5]),        # ROOM, TABLE — 접미사 없음
        ("CHAIR2", [2, 3]),    # CHAIR2_UL + CHAIR2_OL
        ("SOFA", [4]),
    ]


def test_auto_merge_puts_bg_at_the_bottom_then_the_elements_in_document_order():
    # 소스에서는 BG 요소(TABLE)가 요소들보다 위에 있다. 문서 순서를 그대로 쓰면
    # BG가 위로 올라가므로 reorder로 못박는다.
    reorders = [(op["layerId"], op["aboveId"]) for op in _ops() if op["op"] == "reorder"]
    assert reorders == [(-1, None), (-2, -1), (-3, -2)]


def test_auto_merge_skips_empty_buckets_so_entry_ids_stay_aligned():
    ops = _ops(matched=[2, 3])          # BG에 해당하는 레이어가 없다
    assert _merges(ops) == [("CHAIR2", [2, 3])]
    assert [(op["layerId"], op["aboveId"]) for op in ops if op["op"] == "reorder"] == [(-1, None)]


def test_element_name_strips_the_longest_token_first():
    tree = [_group(200, "PROP_OL_UL", [], [_leaf(9, "LINE", ["PROP_OL_UL"])])]
    assert _merges(_ops(matched=[9], tree=tree)) == [("PROP", [9])]


def test_a_name_that_merely_contains_a_token_is_not_an_element():
    # WALL_OLD는 OL이 아니다 — 포함이 아니라 접미사로 봐야 한다.
    tree = [_group(200, "WALL_OLD", [], [_leaf(9, "LINE", ["WALL_OLD"])])]
    assert _merges(_ops(matched=[9], tree=tree)) == [("BG", [9])]


def test_element_name_accepts_hyphen_and_space_separators():
    tree = [
        _group(200, "CHAIR-UL", [], [_leaf(9, "LINE", ["CHAIR-UL"])]),
        _group(210, "CHAIR OL", [], [_leaf(10, "LINE", ["CHAIR OL"])]),
    ]
    # 구분자가 달라도 같은 요소 이름으로 모인다.
    assert _merges(_ops(matched=[9, 10], tree=tree)) == [("CHAIR", [9, 10])]


def test_element_uses_the_nearest_ancestor_carrying_a_token():
    tree = [_group(200, "SET_OL", [], [
        _group(210, "CHAIR_UL", ["SET_OL"], [_leaf(9, "LINE", ["SET_OL", "CHAIR_UL"])]),
    ])]
    assert _merges(_ops(matched=[9], tree=tree)) == [("CHAIR", [9])]


def test_a_group_named_only_by_its_role_keeps_that_name():
    # 접미사를 떼면 아무것도 안 남는 경우(그룹 이름이 그냥 "OL") — 빈 이름 대신
    # 원래 이름을 쓴다.
    tree = [_group(200, "OL", [], [_leaf(9, "LINE", ["OL"])])]
    assert _merges(_ops(matched=[9], tree=tree)) == [("OL", [9])]


def test_custom_role_tokens_are_honored():
    tree = [_group(200, "DOOR_FRONT", [], [_leaf(9, "LINE", ["DOOR_FRONT"])])]
    assert _merges(_ops(matched=[9], tree=tree, tokens=["FRONT"])) == [("DOOR", [9])]


def test_auto_merge_with_no_matches_emits_nothing():
    assert _ops(matched=[]) == []


def test_preset_by_element_mode_uses_the_same_rule():
    # 레이어 패널 버튼과 프리셋(배치 실행)이 갈라지면 화면과 결과가 달라진다.
    from_preset = preset_operations(ROLE_TREE, ROLE_MATCHED, _preset(merge="byElement"))
    assert from_preset == _ops()


# ---- 규칙별 자동 병합: role / group / plane ----
# 어느 규칙이 맞는지는 컷마다 다르다. 실제 파일 셋에서 같은 라인이
# 규칙에 따라 1~11장으로 갈렸다.

# *ART 아래 depth-2 그룹이 의미 단위인 구조 (실제 Alley 파일의 축소판).
PLANE_TREE = [
    _group(100, "*ART", [], [
        _group(110, "GROUND", ["*ART"], [
            _group(111, "ground", ["*ART", "GROUND"],
                   [_leaf(1, "LINE", ["*ART", "GROUND", "ground"])]),
        ]),
        _group(120, "MG L BUILDING", ["*ART"], [
            _group(121, "bldg", ["*ART", "MG L BUILDING"],
                   [_leaf(2, "Line", ["*ART", "MG L BUILDING", "bldg"])]),
            _group(122, "clothes", ["*ART", "MG L BUILDING"],
                   [_leaf(3, "Line", ["*ART", "MG L BUILDING", "clothes"])]),
        ]),
        _group(130, "FG R", ["*ART"], [
            _group(131, "balcony", ["*ART", "FG R"],
                   [_leaf(4, "Line", ["*ART", "FG R", "balcony"])]),
        ]),
    ]),
]
PLANE_MATCHED = [1, 2, 3, 4]


def _rule_merges(rule, matched=PLANE_MATCHED, tree=PLANE_TREE):
    ops = auto_merge_operations(tree, matched, None, rule=rule)
    return [(op["name"], op["layerIds"]) for op in ops if op["op"] == "merge"]


def test_group_rule_buckets_by_the_group_under_the_top_level():
    assert _rule_merges("group") == [
        ("GROUND", [1]),
        ("MG L BUILDING", [2, 3]),
        ("FG R", [4]),
    ]


def test_plane_rule_buckets_by_the_bg_mg_fg_prefix():
    # 평면 접두사가 없는 GROUND는 BG로 떨어진다.
    assert _rule_merges("plane") == [
        ("BG", [1]),
        ("MG", [2, 3]),
        ("FG", [4]),
    ]


def test_plane_rule_ignores_a_name_that_merely_starts_with_the_letters():
    # "MGRAIN"은 MG가 아니다 — 토큰 뒤에 구분자가 와야 한다.
    tree = [_group(200, "*ART", [], [
        _group(210, "MGRAIN", ["*ART"], [_leaf(9, "Line", ["*ART", "MGRAIN"])]),
    ])]
    assert _rule_merges("plane", [9], tree) == [("BG", [9])]


def test_role_rule_is_unchanged_by_the_new_rules():
    assert _rule_merges("role", ROLE_MATCHED, ROLE_TREE) == [
        ("BG", [1, 5]), ("CHAIR2", [2, 3]), ("SOFA", [4]),
    ]


def test_group_rule_falls_back_to_the_only_ancestor_it_has():
    tree = [_group(200, "*ART", [], [_leaf(9, "Line", ["*ART"])])]
    assert _rule_merges("group", [9], tree) == [("*ART", [9])]


def test_unknown_rule_is_rejected_rather_than_silently_defaulted():
    with pytest.raises(ValueError, match="unknown merge rule"):
        auto_merge_operations(PLANE_TREE, PLANE_MATCHED, None, rule="bogus")


def test_preview_reports_every_rule_with_the_counts_the_merge_would_produce():
    pv = auto_merge_preview(PLANE_TREE, PLANE_MATCHED)
    assert pv["group"]["layerCount"] == 3
    assert pv["plane"]["layerCount"] == 3
    assert pv["role"]["layerCount"] == 1          # 접미사가 없어 전부 BG
    assert pv["plane"]["names"] == ["BG", "MG", "FG"]


def test_preview_counts_match_what_the_merge_actually_produces():
    # 표시된 숫자와 결과가 갈라지면 고르는 의미가 없다.
    pv = auto_merge_preview(PLANE_TREE, PLANE_MATCHED)
    for rule in ("role", "group", "plane"):
        assert pv[rule]["layerCount"] == len(_rule_merges(rule))


def test_preset_by_element_honours_the_merge_rule():
    ops = preset_operations(PLANE_TREE, PLANE_MATCHED,
                            _preset(merge="byElement", mergeRule="plane"))
    assert [op["name"] for op in ops if op["op"] == "merge"] == ["BG", "MG", "FG"]


# --- 규칙 ①: 이름을 토큰으로 본다 (설계 문서 3절) ---

def test_linear_dodge_is_not_a_line_and_says_why_it_was_dropped():
    tree = [_node(0, "Layer 866 (LINEAR DODGE)", "pixel", True)]
    matched, skipped = match_preset(tree, _preset())
    assert matched == []
    assert skipped == [{
        "id": 0, "path": "Layer 866 (LINEAR DODGE)",
        "kind": "pixel", "reason": "notLineWord",
    }]


def test_underscore_and_camel_case_names_are_still_lines():
    # 정규식 \blines?\b 였다면 이것들이 전부 날아간다 — \b는 _에서 끊기지 않는다.
    tree = [
        _node(0, "Wall_Line", "pixel", True),
        _node(1, "CurtainsLine", "pixel", True),
        _node(2, "Ring_Line", "pixel", True),
        _node(3, "line2", "pixel", True),
    ]
    assert match_preset(tree, _preset()) == ([0, 1, 2, 3], [])


def test_a_value_with_no_tokens_falls_back_to_substring():
    # "-"는 토큰을 만들지 못한다. 그럴 때까지 규칙을 못 쓰게 만들 이유는 없다.
    tree = [_node(0, "-guides", "pixel", True)]
    p = _preset(include={"type": "contains", "value": "-", "caseSensitive": False},
                excludeGroupPrefixes=[])
    assert match_preset(tree, p) == ([0], [])


# --- 규칙 ②: 걸린 그룹 안에 진짜 라인이 있으면 그것만 (설계 문서 3절) ---
# 그룹 생성에는 위쪽 byElement 절의 _group(i, name, path, children)을 그대로
# 쓴다 — path=[]를 주면 최상위 그룹(path == [name])이 된다.

def test_a_matched_group_takes_only_the_lines_it_actually_contains():
    """
    실제 파일의 'lines' 그룹이다. 이름이 규칙에 걸리는 바람에 안의 합성
    레이어까지 전부 딸려왔지만, 진짜 라인은 'lines' leaf 하나뿐이다.
    """
    tree = [_group(0, "lines", [], [
        _node(1, "fill", "pixel", True, path=["lines", "fill"]),
        _node(2, "GRAIN_OVERLAY", "pixel", True, path=["lines", "GRAIN_OVERLAY"]),
        _node(3, "lines", "pixel", True, path=["lines", "lines"]),
        _node(4, "h", "pixel", True, path=["lines", "h"]),
    ])]
    matched, skipped = match_preset(tree, _preset())
    assert matched == [3]
    assert [(s["id"], s["reason"]) for s in skipped] == [
        (1, "groupHasOwnLine"), (2, "groupHasOwnLine"), (4, "groupHasOwnLine"),
    ]


def test_a_matched_group_still_pulls_everything_when_nothing_inside_is_named():
    """
    matchGroups가 존재하는 이유다 — 자식 이름에 아무 단서가 없으면 그룹
    이름만이 유일한 단서다.
    """
    tree = [_group(0, "CHAIR1_LINE", [], [
        _node(1, "1", "pixel", True, path=["CHAIR1_LINE", "1"]),
        _node(2, "2", "pixel", True, path=["CHAIR1_LINE", "2"]),
    ])]
    assert match_preset(tree, _preset()) == ([1, 2], [])


def test_match_groups_off_ignores_the_group_name_entirely():
    tree = [_group(0, "lines", [], [
        _node(1, "fill", "pixel", True, path=["lines", "fill"]),
        _node(2, "lines", "pixel", True, path=["lines", "lines"]),
    ])]
    assert match_preset(tree, _preset(matchGroups=False)) == ([2], [])
