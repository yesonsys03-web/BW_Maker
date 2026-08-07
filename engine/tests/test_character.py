import pytest
from pytoshop import enums
from pytoshop.user import nested_layers

from psd_engine.character import COLOUR_GROUP_NAMES, find_views, manual_views
from psd_engine.session import SessionStore

from conftest import make_rgb_image, write_psd


def _session(path):
    store = SessionStore()
    return store.get(store.open(str(path)))


def _view_psd(tmp_path, colour_group_name, line_as_group):
    """뷰 하나짜리 문서. 라인을 잎으로 둘지 그룹으로 둘지 고른다."""
    colours = nested_layers.Group(name=colour_group_name, layers=[
        make_rgb_image("hair", (40, 20, 20), 0, 0, 16, 16),
        make_rgb_image("base", (200, 30, 60), 0, 0, 32, 24),
    ])
    line = (nested_layers.Group(name="LINES", layers=[
        make_rgb_image("LINE", (0, 0, 0), 0, 0, 32, 24)])
        if line_as_group else make_rgb_image("LINES", (0, 0, 0), 0, 0, 32, 24))
    p = tmp_path / f"{colour_group_name}_{line_as_group}.psd"
    write_psd(p, [nested_layers.Group(name="FRONT 3/4", layers=[line, colours])])
    return p


@pytest.mark.parametrize("group_name", sorted(COLOUR_GROUP_NAMES))
def test_every_colour_group_name_in_the_closed_set_is_found(tmp_path, group_name):
    s = _session(_view_psd(tmp_path, group_name, line_as_group=False))
    views = find_views(s)
    assert len(views) == 1
    assert views[0]["name"] == "FRONT 3/4"
    assert len(views[0]["colourIds"]) == 2


def test_a_line_group_is_flattened_to_its_leaves(tmp_path):
    # 실파일에서 lines가 그룹 이름으로만 130회 나온다. 잎만 찾으면 100장 중 22장만 걸렸다.
    s = _session(_view_psd(tmp_path, "COLORS", line_as_group=True))
    views = find_views(s)
    assert len(views) == 1
    assert len(views[0]["lineIds"]) == 1


def test_a_palette_group_is_not_a_colour_group(tmp_path):
    # colour palette 는 46장, color palette 는 36장에 있다. 부분 일치면 전부 오인한다.
    colours = nested_layers.Group(name="COLOUR PALETTE", layers=[
        make_rgb_image("swatch", (200, 30, 60), 0, 0, 8, 8)])
    line = make_rgb_image("LINES", (0, 0, 0), 0, 0, 32, 24)
    p = tmp_path / "palette.psd"
    write_psd(p, [nested_layers.Group(name="TEMPLATE", layers=[line, colours])])
    assert find_views(_session(p)) == []


def test_a_document_with_no_colour_group_yields_no_views(tmp_path):
    # 군중·배치 시트가 이렇다(실폴더 100장 중 17장). 실패가 아니라 대상이 아니다.
    p = tmp_path / "crowd.psd"
    write_psd(p, [nested_layers.Group(name="CROWD", layers=[
        make_rgb_image("figure", (10, 10, 10), 0, 0, 16, 16)])])
    assert find_views(_session(p)) == []


def test_views_are_found_at_any_nesting_depth(tmp_path):
    # 실파일에 TURN/CHARACTER/PROFILE/FILLS 처럼 더 깊은 중첩이 있다.
    inner = nested_layers.Group(name="PROFILE", layers=[
        make_rgb_image("LINES", (0, 0, 0), 0, 0, 32, 24),
        nested_layers.Group(name="FILLS", layers=[
            make_rgb_image("fill", (200, 30, 60), 0, 0, 32, 24)]),
    ])
    p = tmp_path / "deep.psd"
    write_psd(p, [nested_layers.Group(name="TURN", layers=[
        nested_layers.Group(name="CHARACTER", layers=[inner])])])
    views = find_views(_session(p))
    assert [v["name"] for v in views] == ["PROFILE"]


def test_manual_views_group_picked_leaves_by_their_view(tmp_path):
    # 아티스트는 잎을 고른다. 그 잎의 부모가 사실상의 색 그룹이고, 뷰는 그 부모의 부모다.
    inner = nested_layers.Group(name="ODD NAME", layers=[
        make_rgb_image("dark", (40, 20, 20), 0, 0, 16, 16),
        make_rgb_image("base", (200, 30, 60), 0, 0, 32, 24),
    ])
    p = tmp_path / "manual.psd"
    write_psd(p, [nested_layers.Group(name="FRONT", layers=[
        make_rgb_image("LINES", (0, 0, 0), 0, 0, 32, 24), inner])])
    s = _session(p)
    assert find_views(s) == [], "이름이 닫힌 집합에 없으므로 자동은 아무것도 못 찾아야 한다"

    picked = [lid for lid, l in s["layers_by_id"].items() if l.name in ("dark", "base")]
    lines = [lid for lid, l in s["layers_by_id"].items() if l.name == "LINES"]
    views = manual_views(s, picked, included_ids=lines)
    assert len(views) == 1
    assert views[0]["name"] == "FRONT"
    assert sorted(views[0]["colourIds"]) == sorted(picked)
    assert views[0]["lineIds"] == lines


def test_manual_views_only_take_lines_that_are_being_exported(tmp_path):
    # 스펙 3.1: 기존 라인은 "내보내기에 이미 포함된" 라인 레이어를 쓴다.
    inner = nested_layers.Group(name="ODD NAME", layers=[
        make_rgb_image("base", (200, 30, 60), 0, 0, 32, 24)])
    p = tmp_path / "manual_noline.psd"
    write_psd(p, [nested_layers.Group(name="FRONT", layers=[
        make_rgb_image("LINES", (0, 0, 0), 0, 0, 32, 24), inner])])
    s = _session(p)
    picked = [lid for lid, l in s["layers_by_id"].items() if l.name == "base"]
    views = manual_views(s, picked, included_ids=[])
    assert views[0]["lineIds"] == [], "체크하지 않은 라인이 들어왔다"


def test_manual_views_are_empty_when_nothing_is_picked(tmp_path):
    s = _session(_view_psd(tmp_path, "COLORS", line_as_group=False))
    assert manual_views(s, [], included_ids=[1, 2, 3]) == []


@pytest.mark.xfail(strict=True, reason="색 그룹 안에 색 그룹 이름이 중첩되면 가짜 뷰가 하나 더 나온다 — 전수 조사에 없던 모양이라 두고 본다. 고치면 이 테스트가 알려준다.")
def test_a_colour_group_nested_inside_a_colour_group_does_not_make_a_second_view(tmp_path):
    inner = nested_layers.Group(name="FILLS", layers=[
        make_rgb_image("f", (200, 30, 60), 0, 0, 16, 16)])
    colours = nested_layers.Group(name="COLORS", layers=[
        inner, make_rgb_image("base", (40, 20, 20), 0, 0, 32, 24)])
    p = tmp_path / "nested.psd"
    write_psd(p, [nested_layers.Group(name="FRONT", layers=[
        make_rgb_image("LINES", (0, 0, 0), 0, 0, 32, 24), colours])])
    assert len(find_views(_session(p))) == 1
