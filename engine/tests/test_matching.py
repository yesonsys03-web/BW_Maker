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
    #
    # 둘을 각자의 그룹에 두는 것은 빈 레이어 보고 규칙 때문이다 — 한 그룹에 두면
    # pixel 쪽이 결과를 내므로 smartobject 쪽 보고가 접혀, 이 테스트가 보려는
    # "빠졌고 사유는 noPixels"가 가려진다.
    old_pixel = {"id": 0, "name": "line", "kind": "pixel", "visible": True, "path": ["A", "line"]}
    old_smart = {"id": 1, "name": "line2", "kind": "smartobject", "visible": True,
                 "path": ["B", "line2"]}
    tree = [
        {"id": 10, "name": "A", "kind": "group", "path": ["A"], "children": [old_pixel]},
        {"id": 11, "name": "B", "kind": "group", "path": ["B"], "children": [old_smart]},
    ]

    matched, skipped = match_preset(tree, _preset())

    assert matched == [0]
    assert [s["reason"] for s in skipped] == ["noPixels"]


# --- 규칙 ④: 합성 모드 (설계 문서 3절) ---

def test_a_line_named_layer_on_overlay_is_not_line_art():
    """
    'LINE WIN'은 창문에 흰 빛을 얹는 overlay 패스다 — 렌더해서 확인했다
    (순백색 단색). 같은 그룹의 'LINE BLD'가 진짜 라인이다.
    """
    tree = [
        _node(0, "LINE WIN", "pixel", True, blendMode="overlay"),
        _node(1, "LINE BLD", "pixel", True, blendMode="normal"),
    ]
    matched, skipped = match_preset(tree, _preset())
    assert matched == [1]
    assert [(s["id"], s["reason"]) for s in skipped] == [(0, "blendMode")]


def test_a_tree_built_before_blend_mode_existed_is_treated_as_normal():
    tree = [_node(0, "LINE", "pixel", True)]  # blendMode 필드 없음
    assert match_preset(tree, _preset()) == ([0], [])


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


# 규칙 ②가 일괄 포함을 끄는 근거는 "그 leaf들이 알아서 걸린다"이다. 그러니 뒤의
# 게이트에서 빠질 leaf는 근거가 될 수 없다 — 그것 하나 때문에 일괄 포함이 꺼지면
# 단서 없는 형제들까지 같이 사라져 그룹에서 아무것도 안 나온다. 게이트마다 하나씩.

def _clueless_group_plus(offender):
    """단서 없는 자식 `1`, `2` 곁에 문제의 leaf 하나를 둔 `CHAIR1_LINE` 그룹."""
    return [_group(0, "CHAIR1_LINE", [], [
        _node(1, "1", "pixel", True, path=["CHAIR1_LINE", "1"]),
        _node(2, "2", "pixel", True, path=["CHAIR1_LINE", "2"]),
        offender,
    ])]


def test_a_colour_layer_does_not_switch_off_the_group_blanket():
    tree = _clueless_group_plus(
        _node(3, "line col", "pixel", True, path=["CHAIR1_LINE", "line col"]))

    matched, skipped = match_preset(tree, _preset())

    assert matched == [1, 2]
    assert [(s["id"], s["reason"]) for s in skipped] == [(3, "excludedToken")]


def test_an_overlay_pass_does_not_switch_off_the_group_blanket():
    tree = _clueless_group_plus(
        _node(3, "LINE WIN", "pixel", True, blendMode="overlay",
              path=["CHAIR1_LINE", "LINE WIN"]))

    matched, skipped = match_preset(tree, _preset())

    assert matched == [1, 2]
    assert [(s["id"], s["reason"]) for s in skipped] == [(3, "blendMode")]


def test_a_work_note_does_not_switch_off_the_group_blanket():
    # 현실적으로 가장 흔한 경우다 — *_LINE 그룹 안에 단서 없는 자식들과 나란히
    # 작업 메모를 남기는 것은 작업자에게 평범한 일이다(NON_ART_KINDS 주석 참조).
    tree = _clueless_group_plus(
        _node(3, "NOTE FOR LINE: repaint", "type", True,
              path=["CHAIR1_LINE", "NOTE FOR LINE: repaint"]))

    matched, skipped = match_preset(tree, _preset())

    assert matched == [1, 2]
    assert [(s["id"], s["reason"]) for s in skipped] == [(3, "text")]


def test_a_hidden_line_does_not_switch_off_the_group_blanket():
    tree = _clueless_group_plus(
        _node(3, "line", "pixel", True, visible=False, path=["CHAIR1_LINE", "line"]))

    matched, skipped = match_preset(tree, _preset(includeHidden=False))

    assert matched == [1, 2]
    # 숨겨서 뺀 것은 예나 지금이나 skip 기록을 남기지 않는다.
    assert skipped == []


# --- 규칙 ③: 색 지정 레이어 제외 (설계 문서 3절) ---

def test_colour_layers_named_line_are_not_line_art():
    tree = [
        _node(0, "line col", "pixel", True),
        _node(1, "Line Colour", "pixel", True),
        _node(2, "Wall_Line_Col", "pixel", True),
        _node(3, "LINE", "pixel", True),
    ]
    matched, skipped = match_preset(tree, _preset())
    assert matched == [3]
    assert [(s["id"], s["reason"]) for s in skipped] == [
        (0, "excludedToken"), (1, "excludedToken"), (2, "excludedToken"),
    ]


def test_exclude_tokens_can_be_emptied_by_the_preset():
    tree = [_node(0, "line col", "pixel", True)]
    assert match_preset(tree, _preset(excludeTokens=[])) == ([0], [])


def test_exclude_tokens_can_be_replaced_by_the_preset():
    tree = [_node(0, "line col", "pixel", True), _node(1, "NEON LINE", "pixel", True)]
    assert match_preset(tree, _preset(excludeTokens=["neon"])) == ([0], [
        {"id": 1, "path": "NEON LINE", "kind": "pixel", "reason": "excludedToken"},
    ])


# --- 빈 레이어를 언제 알릴 것인가 ---
# 카드의 존재 이유는 "이름은 LINE인데 결과에 없으면 사람이 이유를 알 방법이
# 없다"이다. 그런데 실파일 24개에서 47장이 올라왔고, 열어보니 대부분 알릴 것이
# 아니었다. 21장은 그룹 이름에 딸려온 자식이라 애초에 라인으로 지목된 적이 없고,
# 다수는 같은 그룹의 형제가 결과에 들어가 그 자리의 그림이 멀쩡히 나왔다. 남길
# 것은 "그 자리에서 라인이 하나도 안 나왔다" 하나뿐이다.
#
# 실측: HH0305 24개 47 → 11장, 납품 HH0306 25개 4 → 4장(그대로).

def test_an_empty_child_pulled_in_by_the_group_name_is_not_reported():
    """
    실제 파일의 `LINE KEY BOARD` 그룹이다 — 라인이 아니라 열쇠 보드다. 자식
    이름에 단서가 없어 그룹 이름으로 일괄 포함됐는데 그 자식들이 비어 있었고,
    한 파일에서만 20장이 이 경로로 카드에 올라왔다. 사용자는 `bell`이나
    `KEYS`를 라인이라고 기대한 적이 없다.
    """
    tree = [_group(0, "LINE KEY BOARD", [], [
        _node(1, "BOARD", "pixel", False, path=["LINE KEY BOARD", "BOARD"]),
        _node(2, "bell", "pixel", False, path=["LINE KEY BOARD", "bell"]),
    ])]

    matched, skipped = match_preset(tree, _preset())

    assert matched == []
    assert skipped == []


def test_an_empty_line_is_not_reported_when_a_sibling_line_came_through():
    """
    `secondary_line`이 비어 있어도 형제 `Line`이 결과에 들어갔으면 그 자리의
    그림은 나온 것이다. 복제 템플릿의 안 쓰는 슬롯이 이렇게 생긴다 — 한 파일에서
    복제본마다 하나씩 5장이 나왔다.
    """
    tree = [_group(0, "Packets", [], [
        _node(1, "Line", "pixel", True, path=["Packets", "Line"]),
        _node(2, "secondary_line", "pixel", False, path=["Packets", "secondary_line"]),
    ])]

    matched, skipped = match_preset(tree, _preset())

    assert matched == [1]
    assert skipped == []


def test_an_empty_line_is_reported_when_the_group_produced_nothing():
    """
    남겨야 할 단 하나의 경우다. 복제 꼬리(`TRIM copy 29`)가 통째로 비어 그
    자리에서 라인이 한 장도 안 나왔다 — 이건 파일을 열어볼 이유가 된다.
    """
    tree = [_group(0, "TRIM copy 29", [], [
        _node(1, "GRAD", "pixel", True, path=["TRIM copy 29", "GRAD"]),
        _node(2, "LINES", "pixel", False, path=["TRIM copy 29", "LINES"]),
    ])]

    matched, skipped = match_preset(tree, _preset())

    assert matched == []
    assert [(s["id"], s["reason"]) for s in skipped] == [(2, "noPixels")]


def test_a_line_from_another_group_does_not_silence_this_one():
    """
    형제로 치는 범위는 같은 그룹뿐이다. 옆 그룹에서 나왔다고 이쪽의 빈자리를
    덮으면, 복제본이 스무 벌인 파일에서 한 벌의 라인이 통째로 빠져도 아무도
    모르게 된다.
    """
    tree = [
        _group(0, "TRIM copy 2", [], [
            _node(1, "LINES", "pixel", True, path=["TRIM copy 2", "LINES"]),
        ]),
        _group(2, "TRIM copy 3", [], [
            _node(3, "LINES", "pixel", False, path=["TRIM copy 3", "LINES"]),
        ]),
    ]

    matched, skipped = match_preset(tree, _preset())

    assert matched == [1]
    assert [(s["id"], s["reason"]) for s in skipped] == [(3, "noPixels")]


def test_height_reference_lines_are_excluded_but_real_lines_are_kept():
    """
    키 기준선(`CHARACTER HEIGHT LINE` 등)은 이름에 line이 들어 있어 include 규칙에
    걸리지만 선화가 아니다. 아티스트가 2026-08-10에 지목했고, 그때 실제로 납품
    캐릭터 36장이 이것을 선화로 내보내고 있었다(잎 72개).

    **상수 목록만 보는 테스트로는 이걸 못 지킨다** — `excludeTokens`가 실제로
    걸러내는지는 매칭을 돌려봐야 안다. 그리고 같은 이름의 진짜 선화를 데려가지
    않는지도 같이 본다: 걸러내기만 하는 규칙은 전부 걸러내도 통과한다.

    구가 아니라 단일 토큰이어야 한다는 것도 여기서 걸린다 — has_any_token은
    토큰 하나씩만 비교하므로 "height line"을 넣으면 아무것도 안 걸러진다.
    """
    tree = [
        _group(0, "EXTRA REFS", [], [
            _node(1, "CHARACTER HEIGHT LINE", "pixel", True,
                  path=["EXTRA REFS", "CHARACTER HEIGHT LINE"]),
            _node(2, "HEIGHT LINE", "pixel", True,
                  path=["EXTRA REFS", "HEIGHT LINE"]),
        ]),
        _group(3, "FRONT", [], [
            _node(4, "LINES", "pixel", True, path=["FRONT", "LINES"]),
            _node(5, "MOUTH LINE", "pixel", True, path=["FRONT", "MOUTH LINE"]),
        ]),
    ]

    matched, skipped = match_preset(tree, _preset(excludeGroupPrefixes=[]))

    assert matched == [4, 5], "진짜 선화가 함께 걸러졌다"
    assert {s["id"] for s in skipped} == {1, 2}, "키 기준선이 안 걸러졌다"


def test_note_box_divide_lines_are_excluded_but_the_diagram_lines_stay():
    """
    주석 상자의 칸막이 선(`divide lines`)은 이름에 lines가 들어 있어 매칭되지만
    캐릭터 라인이 아니다(2026-08-21 아티스트 판단). CH 74판 전수 실측에서
    **33장이 전부 매칭되어 라인판에 나가고 있었다** — 실측 823x8 픽셀 가로 띠라
    침식 생존율 0.99, 굵기로는 선이 아니라 면이다.

    키 기준선(height)과 같은 모양이지만, 여기서는 **같은 그룹 안에** 진짜 도해
    선화가 함께 있다는 것이 핵심이다: 같은 `NOTES BOX` 아래 `LINE`·`PAW LINE`
    48장은 납품 대상이라 데려가면 안 된다. 그래서 그룹이 아니라 잎 이름 토큰으로
    가른다.
    """
    tree = [
        _group(0, "NOTES BOX", [], [
            _node(1, "divide lines", "pixel", True,
                  path=["NOTES BOX", "divide lines"]),
            _node(2, "divide lines copy", "pixel", True,
                  path=["NOTES BOX", "divide lines copy"]),
            _node(3, "LINE", "pixel", True, path=["NOTES BOX", "LINE"]),
            _node(4, "PAW LINE", "pixel", True, path=["NOTES BOX", "PAW LINE"]),
        ]),
    ]

    matched, skipped = match_preset(tree, _preset(excludeGroupPrefixes=[]))

    assert matched == [3, 4], "같은 상자의 진짜 도해 선화가 함께 걸러졌다"
    assert {s["id"] for s in skipped} == {1, 2}, "칸막이 선이 안 걸러졌다"


def test_include_takes_a_comma_list_so_lineart_can_be_caught():
    """
    `lineart`는 토크나이저가 소문자 덩어리를 토큰 하나로 보기 때문에 `line`으로는
    영영 안 걸린다. 그 규칙은 옳다 — 부분 문자열로 보면 `LINEAR DODGE`가 걸린다.
    그래서 규칙을 무르지 않고 어휘를 늘렸다.

    실제로 이것 때문에 납품 캐릭터 100장에서 `lineart -` 83개가 빠져 있었고,
    **판이 실패하지도 않아 눈에 안 띄었다** — 같은 판의 `divide lines`(823x8px
    주석 구분선)가 대신 걸려 "1장"으로 나가고 있었다.

    `LINEAR`가 계속 빠지는 것까지 같이 본다. 늘린 어휘가 그 방어를 무너뜨리면
    고친 것보다 잃는 것이 크다.
    """
    tree = [
        _node(1, "lineart - ", "pixel", True),
        _node(2, "LINES", "pixel", True),
        _node(3, "LINEAR DODGE", "pixel", True),
        _node(4, "lineless note", "pixel", True),
    ]
    inc = {"type": "contains", "value": "line, lineart", "caseSensitive": False}

    matched, _ = match_preset(tree, _preset(include=inc))
    assert matched == [1, 2], "lineart를 못 잡았거나 LINEAR/lineless까지 잡았다"

    # 쉼표가 없으면 예전과 똑같아야 한다 — 저장된 프리셋이 전부 그 모양이다.
    one = {"type": "contains", "value": "line", "caseSensitive": False}
    matched_one, _ = match_preset(tree, _preset(include=one))
    assert matched_one == [2]
