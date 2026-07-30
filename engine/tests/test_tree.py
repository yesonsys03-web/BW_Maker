from psd_tools import PSDImage

from psd_engine.tree import build_tree


def test_build_tree_ids_and_fields(fixture_psd):
    built = build_tree(PSDImage.open(fixture_psd))
    n = built["nodes_by_id"]

    assert [n[i]["name"] for i in range(8)] == [
        "*ART", "BG", "fill", "hidden line", "line", "lines", "-REF", "line",
    ]
    assert n[0]["kind"] == "group" and "children" in n[0]
    assert n[2]["kind"] == "pixel" and "children" not in n[2]
    assert n[3]["visible"] is False
    assert n[4]["path"] == ["*ART", "BG", "line"]
    assert n[4]["bbox"] == [0, 0, 32, 24]
    assert n[2]["blendMode"] == "normal"
    assert n[2]["opacity"] == 255
    assert n[2]["hasMask"] is False
    assert built["layers_by_id"][5].name == "lines"
    # 트리 루트는 최상위 노드 2개
    assert [t["name"] for t in built["tree"]] == ["*ART", "-REF"]
