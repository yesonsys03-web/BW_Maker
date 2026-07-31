import pytest
from psd_tools import PSDImage

from psd_engine.matching import match_preset, preset_operations
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


# ---- byRole: 애니메이션 BG 역할별 자동 병합 ----

def _leaf(i, name, path):
    return {"id": i, "name": name, "kind": "pixel", "path": path + [name]}


def _group(i, name, path, children):
    return {"id": i, "name": name, "kind": "group", "path": path + [name],
            "children": children}


# 실제 소스의 형태: 요소 그룹 이름 접미사가 역할을 나타내고, 접미사가 없으면 BG.
# 문서 순서상 BG 요소(TABLE)가 OL 요소보다 위에 오는 것도 실제 파일 그대로다.
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


def _by_role(matched=ROLE_MATCHED, tree=ROLE_TREE, stem=None, **over):
    return preset_operations(tree, matched, _preset(merge="byRole", **over), source_stem=stem)


def _merges(ops):
    return [(op["name"], op["layerIds"]) for op in ops if op["op"] == "merge"]


def test_by_role_buckets_layers_by_their_group_suffix():
    assert _merges(_by_role()) == [
        ("BG", [1, 5]),      # ROOM, TABLE — 접미사 없음
        ("UL", [2, 4]),      # CHAIR2_UL, SOFA_UL
        ("OL", [3]),         # CHAIR2_OL
    ]


def test_by_role_stacks_bg_at_the_bottom_then_the_token_order():
    # 소스에서는 BG 요소(TABLE)가 OL 요소보다 위에 있다. 문서 순서를 그대로 쓰면
    # BG가 OL 위로 올라가버리므로 reorder로 순서를 못박는다.
    ops = _by_role()
    reorders = [(op["layerId"], op["aboveId"]) for op in ops if op["op"] == "reorder"]
    assert reorders == [(-1, None), (-2, -1), (-3, -2)]


def test_by_role_prefixes_the_source_file_name_when_given():
    names = [n for n, _ in _merges(_by_role(stem="HH03_BG-Room"))]
    assert names == ["HH03_BG-Room_BG", "HH03_BG-Room_UL", "HH03_BG-Room_OL"]


def test_by_role_skips_roles_with_no_layers_so_entry_ids_stay_aligned():
    # OL이 없는 파일. 병합 항목 id는 merge 연산 순서대로 -1, -2가 되어야 하고
    # reorder가 그 id를 가리켜야 한다 — 빈 역할까지 세면 어긋난다.
    ops = _by_role(matched=[1, 2, 4])
    assert _merges(ops) == [("BG", [1]), ("UL", [2, 4])]
    assert [(op["layerId"], op["aboveId"]) for op in ops if op["op"] == "reorder"] == [
        (-1, None), (-2, -1),
    ]


def test_by_role_matches_the_longest_token_first():
    tree = [_group(200, "PROP_OL_UL", [], [_leaf(9, "LINE", ["PROP_OL_UL"])])]
    assert _merges(_by_role(matched=[9], tree=tree)) == [("OL_UL", [9])]


def test_by_role_does_not_mistake_a_name_that_merely_contains_a_token():
    # WALL_OLD는 OL이 아니다 — 포함이 아니라 접미사로 봐야 한다.
    tree = [_group(200, "WALL_OLD", [], [_leaf(9, "LINE", ["WALL_OLD"])])]
    assert _merges(_by_role(matched=[9], tree=tree)) == [("BG", [9])]


def test_by_role_accepts_hyphen_and_space_separators():
    tree = [
        _group(200, "CHAIR-UL", [], [_leaf(9, "LINE", ["CHAIR-UL"])]),
        _group(210, "SOFA UL", [], [_leaf(10, "LINE", ["SOFA UL"])]),
    ]
    assert _merges(_by_role(matched=[9, 10], tree=tree)) == [("UL", [9, 10])]


def test_by_role_takes_the_nearest_ancestor_when_several_carry_tokens():
    # 바깥 그룹이 OL이고 안쪽이 UL이면 가까운 쪽(UL)이 이긴다.
    tree = [_group(200, "SET_OL", [], [
        _group(210, "CHAIR_UL", ["SET_OL"], [_leaf(9, "LINE", ["SET_OL", "CHAIR_UL"])]),
    ])]
    assert _merges(_by_role(matched=[9], tree=tree)) == [("UL", [9])]


def test_by_role_token_list_sets_both_matching_and_stacking_order():
    ops = _by_role(roleTokens=["OL", "UL"])
    assert [n for n, _ in _merges(ops)] == ["BG", "OL", "UL"]


def test_by_role_with_a_single_layer_in_a_role_still_names_it():
    # 한 장짜리 역할도 이름이 붙어야 산출물이 일관된다.
    assert _merges(_by_role(matched=[3], stem="S")) == [("S_OL", [3])]


def test_by_role_with_no_matches_emits_nothing():
    assert _by_role(matched=[]) == []
