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
