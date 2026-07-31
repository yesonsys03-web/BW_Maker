import pytest
from psd_tools import PSDImage

from psd_engine.matching import auto_merge_operations, match_preset, preset_operations
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
    assert match_preset(tree, _preset()) == [3, 4, 5]


def test_include_hidden_false(tree):
    assert match_preset(tree, _preset(includeHidden=False)) == [4, 5]


def test_no_exclude_prefix_includes_ref(tree):
    assert match_preset(tree, _preset(excludeGroupPrefixes=[])) == [3, 4, 5, 7]


def test_regex(tree):
    p = _preset(include={"type": "regex", "value": r"^line$", "caseSensitive": False})
    assert match_preset(tree, p) == [4]


def test_matched_group_pulls_descendants(tree):
    # 'BG'가 매치되는 규칙 → BG 하위 픽셀 전부 포함
    p = _preset(include={"type": "contains", "value": "bg", "caseSensitive": False})
    assert match_preset(tree, p) == [2, 3, 4]


def test_preset_operations_merge_all(tree):
    ids = match_preset(tree, _preset())
    ops = preset_operations(tree, ids, _preset(merge="all"))
    assert ops == [{"op": "merge", "layerIds": [3, 4, 5], "name": "merged"}]


def test_preset_operations_per_group(tree):
    ids = match_preset(tree, _preset())
    ops = preset_operations(tree, ids, _preset(merge="perGroup"))
    # BG 그룹 안의 3,4만 2개 이상 → 병합. 'lines'(5)는 단독이라 그대로.
    assert ops == [{"op": "merge", "layerIds": [3, 4], "name": "BG"}]


def test_matched_non_pixel_layer_raises_valueerror():
    # non-pixel 레이어 매치 → ValueError
    tree = [
        {
            "id": 0,
            "name": "line",
            "kind": "type",  # not "pixel"
            "visible": True,
            "path": ["line"],
        }
    ]
    with pytest.raises(ValueError, match="non-pixel layer"):
        match_preset(tree, _preset())


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
