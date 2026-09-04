import os

import numpy as np
import pytest
from psd_tools import PSDImage

from pathlib import Path

from psd_engine.export import (export_psd, export_psd_split, output_extension,
                               split_output_path)
from psd_engine.ops import build_export_plan, finalize_names
from psd_engine.render import assign_line_color
from psd_engine.session import SessionStore
from psd_engine.verify import verify_export


@pytest.fixture
def wide_session(wide_psb):
    store = SessionStore()
    return store.get(store.open(wide_psb))


@pytest.fixture
def off_canvas_session(off_canvas_psd):
    store = SessionStore()
    return store.get(store.open(off_canvas_psd))


def _plan(session, included, operations, line_color=None, line_color_ids=None):
    """conftest의 `plan` 픽스처와 같은 일 — 세션을 인자로 받는 판이다."""
    entries = build_export_plan(included, operations)
    finalize_names(entries, session["nodes_by_id"], "pathPrefix")
    return assign_line_color(entries, line_color, line_color_ids)


def _ids(session, *names):
    by_name = {l.name: lid for lid, l in session["layers_by_id"].items()}
    return [by_name[n] for n in names]


def test_export_copies_and_merge(session, tmp_path):
    # line(50, 0..32/24) 위에 lines(200, 10..30/10..20) — 병합 결과에 둘 다 보인다
    entries = _plan(session, [3, 4, 5], [{"op": "merge", "layerIds": [4, 5], "name": "M"}])
    out_path = tmp_path / "out.psd"
    stats = export_psd(session, entries, out_path)
    assert stats == {"outputPath": str(out_path), "layerCount": 2}

    out = PSDImage.open(out_path)
    layers = list(out)  # 아래→위
    assert [l.name for l in layers] == ["BG_hidden line", "M"]
    m = np.array(layers[1].topil().convert("RGBA"))
    assert layers[1].bbox == (0, 0, 32, 24)     # union bbox
    assert (m[0, 0, :3] == 50).all()            # line만 있는 곳
    assert (m[15, 15, :3] == 200).all()         # lines가 위를 덮은 곳
    # 복사 검증: hidden line 원본 위치 그대로
    assert layers[0].bbox == (5, 5, 9, 9)


def test_export_empty_entries_raises(session, tmp_path):
    out_path = tmp_path / "out.psd"
    with pytest.raises(ValueError, match="no entries to export"):
        export_psd(session, [], out_path)


def test_export_refuses_overwrite(session, tmp_path):
    entries = _plan(session, [4], [])
    out_path = tmp_path / "out.psd"
    export_psd(session, entries, out_path)
    with pytest.raises(FileExistsError):
        export_psd(session, entries, out_path)
    export_psd(session, entries, out_path, overwrite=True)  # OK


def test_verify_passes_for_copies(session, tmp_path):
    entries = _plan(session, [3, 4, 5], [])
    out_path = tmp_path / "out.psd"
    export_psd(session, entries, out_path)
    v = verify_export(session, entries, out_path)
    assert v["ok"] is True and v["canvasOk"] is True
    assert [c["pixelChecked"] for c in v["layers"]] == [True, True, True]
    assert all(c["pixelOk"] for c in v["layers"])


def test_verify_detects_corruption(session, tmp_path):
    entries = _plan(session, [4], [])
    out_path = tmp_path / "out.psd"
    export_psd(session, entries, out_path)
    # 다른 내용으로 바꿔치기 → 검증 실패해야 함
    entries2 = _plan(session, [5], [{"op": "rename", "layerId": 5, "name": "BG_line"}])
    export_psd(session, entries2, out_path, overwrite=True)
    v = verify_export(session, entries, out_path)
    assert v["ok"] is False


def test_verify_detects_layer_count_mismatch(session, tmp_path):
    # Export 2 layers
    entries = _plan(session, [4, 5], [])
    out_path = tmp_path / "out.psd"
    export_psd(session, entries, out_path)
    # Verify with 1 entry — should detect mismatch
    entries_wrong = _plan(session, [4], [])
    v = verify_export(session, entries_wrong, out_path)
    assert v["ok"] is False
    assert v["layerCountOk"] is False
    assert v["expectedLayers"] == 1
    assert v["actualLayers"] == 2


def test_export_normalizes_line_color_across_layers(session, tmp_path):
    # 소스 라인은 요소마다 다른 색으로 그려져 있다(픽스처는 50 / 200). 색 통일을
    # 켜면 내보낸 PSD의 모든 레이어가 한 색이 되고, 알파는 손대지 않는다.
    entries = _plan(session, [3, 4, 5], [], line_color="#000000")
    out_path = tmp_path / "out.psd"
    export_psd(session, entries, out_path)

    out = PSDImage.open(out_path)
    for layer in out:
        arr = np.array(layer.topil().convert("RGBA"))
        painted = arr[..., 3] > 0
        assert painted.any(), f"{layer.name}에 그려진 픽셀이 없다"
        assert (arr[painted][:, :3] == 0).all(), f"{layer.name}의 RGB가 통일되지 않았다"


def test_export_keeps_alpha_when_normalizing_color(session, tmp_path):
    # 안티에일리어싱은 전부 알파에 들어있으므로, 색을 덮어도 알파는 그대로여야 한다.
    plain = _plan(session, [4], [])
    a_path, b_path = tmp_path / "plain.psd", tmp_path / "black.psd"
    export_psd(session, plain, a_path)
    export_psd(session, _plan(session, [4], [], line_color="#123456"), b_path)

    a = np.array(list(PSDImage.open(a_path))[0].topil().convert("RGBA"))
    b = np.array(list(PSDImage.open(b_path))[0].topil().convert("RGBA"))
    assert np.array_equal(a[..., 3], b[..., 3])
    assert (b[..., :3] == [0x12, 0x34, 0x56]).all()


def test_export_keeps_the_color_of_a_layer_the_rule_did_not_match(session, tmp_path):
    # 미리보기와 같은 규칙(test_render_preview_only_normalizes_the_matched_line_layers).
    # 손으로 체크해 넣은 색 레이어(id 2 = fill, 128)는 원본 색으로 나가야 한다.
    entries = _plan(session, [2, 4], [], line_color="#000000", line_color_ids=[4])
    out_path = tmp_path / "out.psd"
    export_psd(session, entries, out_path)

    by_name = {l.name: np.array(l.topil().convert("RGBA")) for l in PSDImage.open(out_path)}
    line = by_name["BG_line"]
    fill = by_name["BG_fill"]
    assert (line[line[..., 3] > 0][:, :3] == 0).all(), "라인이 색 통일되지 않았다"
    assert (fill[fill[..., 3] > 0][:, :3] == 128).all(), "규칙에 걸리지 않은 레이어가 덮였다"


def test_merged_entry_keeps_its_colors_when_only_some_sources_matched(session, tmp_path):
    # 라인(id 4, 50)과 색 레이어(id 2, 128)를 손으로 한 엔트리에 묶은 경우.
    # 병합 뒤 한 번에 덮는 방식으로는 라인만 골라낼 수 없으므로 원본 색을 지킨다.
    entries = _plan(session, [2, 4], [{"op": "merge", "layerIds": [2, 4], "name": "M"}],
                    line_color="#000000", line_color_ids=[4])
    out_path = tmp_path / "out.psd"
    export_psd(session, entries, out_path)

    arr = np.array(list(PSDImage.open(out_path))[0].topil().convert("RGBA"))
    assert set(np.unique(arr[..., 0]).tolist()) == {50, 128}


def test_export_without_line_color_keeps_source_colors(session, tmp_path):
    entries = _plan(session, [4, 5], [])
    out_path = tmp_path / "out.psd"
    export_psd(session, entries, out_path)
    values = {
        layer.name: int(np.array(layer.topil().convert("RGBA"))[..., 0].max())
        for layer in PSDImage.open(out_path)
    }
    assert set(values.values()) == {50, 200}


def test_export_rejects_a_malformed_line_color_before_writing(session, tmp_path):
    # 형식 오류는 파일을 절반 쓰다 터지는 게 아니라 시작 전에 드러나야 한다.
    # 이제 그 지점은 계획을 세우는 assign_line_color이므로 내보내기가 시작조차 하지 않는다.
    out_path = tmp_path / "out.psd"
    with pytest.raises(ValueError, match="invalid line color"):
        _plan(session, [4], [], line_color="black")
    assert not out_path.exists()


def test_split_export_writes_one_file_per_entry(session, tmp_path):
    entries = _plan(session, [3, 4, 5], [{"op": "merge", "layerIds": [4, 5], "name": "M"}])
    out = tmp_path / "shot_LINE.psd"
    result = export_psd_split(session, entries, out)

    paths = [o["outputPath"] for o in result["outputs"]]
    assert [Path(p).name for p in paths] == ["shot_LINE_BG_hidden line.psd", "shot_LINE_M.psd"]
    assert all(Path(p).exists() for p in paths)
    assert result["layerCount"] == 2


def test_each_split_file_keeps_the_document_canvas(session, tmp_path):
    # 나중에 합성할 때 좌표가 맞아야 하므로 레이어 bbox로 자르지 않는다.
    entries = _plan(session, [4, 5], [])
    result = export_psd_split(session, entries, tmp_path / "s.psd")
    src = session["psd"]
    for out in result["outputs"]:
        psd = PSDImage.open(out["outputPath"])
        assert (psd.width, psd.height) == (src.width, src.height)
        assert len(list(psd)) == 1


def test_split_export_checks_every_target_before_writing_any(session, tmp_path):
    entries = _plan(session, [4, 5], [])
    out = tmp_path / "s.psd"
    result = export_psd_split(session, entries, out)
    second = Path(result["outputs"][1]["outputPath"])
    first = Path(result["outputs"][0]["outputPath"])
    first.unlink()                      # 첫 번째만 지우고 두 번째는 남겨둔다

    with pytest.raises(FileExistsError, match=second.name):
        export_psd_split(session, entries, out)
    # 절반 쓰다 멈추면 안 되므로, 지웠던 첫 파일이 다시 생겨 있으면 안 된다.
    assert not first.exists()


def test_split_export_overwrites_when_asked(session, tmp_path):
    entries = _plan(session, [4], [])
    out = tmp_path / "s.psd"
    export_psd_split(session, entries, out)
    export_psd_split(session, entries, out, overwrite=True)


def test_split_output_path_sanitizes_a_layer_name():
    # 레이어 이름이 그대로 파일명이 되므로 경로 구분자 등을 정리한다.
    assert Path(split_output_path("/tmp/a_LINE.psd", "BG/OL")).name == "a_LINE_BG_OL.psd"
    assert Path(split_output_path("/tmp/a_LINE.psd", "")).name == "a_LINE_layer.psd"


def test_split_export_applies_line_color_like_the_single_file_path(session, tmp_path):
    entries = _plan(session, [4, 5], [], line_color="#000000")
    result = export_psd_split(session, entries, tmp_path / "s.psd")
    for out in result["outputs"]:
        arr = np.array(list(PSDImage.open(out["outputPath"]))[0].topil().convert("RGBA"))
        painted = arr[..., 3] > 0
        assert (arr[painted][:, :3] == 0).all()


def test_split_export_rejects_an_empty_plan(session, tmp_path):
    with pytest.raises(ValueError, match="no entries to export"):
        export_psd_split(session, [], tmp_path / "s.psd")


# 색 통일을 켠 채 배치를 돌렸더니 파일마다 "실패"가 떴는데, 나온 PSD는 멀쩡했다.
# 틀린 것은 내보내기가 아니라 검증이었다: export는 모든 레이어의 RGB를 지정한
# 색으로 덮어 쓰는데(알파는 그대로), verify는 line_color를 모른 채 원본의 원래
# 색과 대조했다. 실측으로 알파 차이 0, RGB 차이 255 — 색만 통째로 어긋났다.
# 이제 둘은 같은 엔트리의 `lineRgb`를 읽으므로 인자를 빠뜨려 갈라질 수 없다.
def test_verify_accounts_for_the_line_color_that_export_applied(session, tmp_path):
    entries = _plan(session, [3, 4, 5], [], line_color="#000000")
    out_path = tmp_path / "out.psd"
    export_psd(session, entries, out_path)

    v = verify_export(session, entries, out_path)

    assert v["ok"] is True
    assert all(c["pixelOk"] for c in v["layers"])


def test_verify_still_catches_a_wrong_color(session, tmp_path):
    # 색을 아는 것과 무엇이든 통과시키는 것은 다르다. 다른 색으로 나갔다면 잡아야 한다.
    # 산출물은 #123456으로 쓰고, 기대값은 #000000인 계획으로 대조한다.
    out_path = tmp_path / "out.psd"
    export_psd(session, _plan(session, [4], [], line_color="#123456"), out_path)

    v = verify_export(session, _plan(session, [4], [], line_color="#000000"), out_path)

    assert v["ok"] is False
    assert v["layers"][0]["pixelOk"] is False


def test_verify_without_a_line_color_is_unchanged(session, tmp_path):
    entries = _plan(session, [3, 4], [])
    out_path = tmp_path / "out.psd"
    export_psd(session, entries, out_path)

    assert verify_export(session, entries, out_path)["ok"] is True


# 파일 버전은 확장자를 따르고, 30,000px을 넘는 문서는 그것을 강제한다.
# 둘이 어긋난 파일은 포토샵이 열지 못하므로 쓰기 전에 갈라야 한다.
def test_export_writes_version_1_for_an_ordinary_document(session, tmp_path):
    out_path = tmp_path / "out.psd"
    export_psd(session, _plan(session, [4], []), out_path)
    assert PSDImage.open(out_path).version == 1


def test_export_follows_a_psb_extension_even_when_the_document_is_small(session, tmp_path):
    # 산출물 확장자는 원본을 물려받는다. 작다고 안쪽을 version 1로 쓰면 확장자와
    # 어긋난 파일이 나간다.
    out_path = tmp_path / "out.psb"
    export_psd(session, _plan(session, [4], []), out_path)
    assert PSDImage.open(out_path).version == 2


def test_export_writes_version_2_for_a_document_over_30000(wide_session, tmp_path):
    out_path = tmp_path / "out.psb"
    export_psd(wide_session, _plan(wide_session, _ids(wide_session, "line"), []), out_path)
    assert PSDImage.open(out_path).version == 2


def test_export_refuses_to_write_an_oversized_document_as_psd(wide_session, tmp_path):
    # pytoshop도 결국은 막지만("width must be in range 1-30000"), 그 메시지로는
    # 어느 파일을 무엇으로 저장해야 하는지 알 수 없다.
    out_path = tmp_path / "out.psd"
    with pytest.raises(ValueError, match=r"32510x300.*write it as \.psb"):
        export_psd(wide_session, _plan(wide_session, _ids(wide_session, "line"), []),
                   out_path)
    assert not out_path.exists()


def test_psb_round_trip_keeps_the_pixels_past_the_30000_mark(wide_session, tmp_path):
    # 한계 너머의 좌표가 살아남는지는 그 지점 **뒤에** 있는 그림으로만 확인된다.
    ids = _ids(wide_session, "line", "line far")
    out_path = tmp_path / "out.psb"
    export_psd(wide_session, _plan(wide_session, ids, []), out_path)

    out = PSDImage.open(out_path)
    assert out.version == 2
    assert (out.width, out.height) == (32510, 300)
    far = next(l for l in out if l.name.endswith("line far"))
    assert far.bbox == (30010, 40, 32510, 140)
    arr = np.array(far.topil().convert("RGBA"))
    assert (arr[..., :3] == 200).all() and (arr[..., 3] == 255).all()


def test_export_keeps_off_canvas_merge_coordinates_in_a_psd(off_canvas_session, tmp_path):
    # 캔버스 밖까지 뻗은 레이어를 병합해도 좌표를 자르지 않는다 — 그 좌표는 나중에
    # 합성할 때 그대로 맞아야 하고(export_psd_split의 docstring 참고), 기준선 25장
    # 195엔트리 중 37개가 이미 이 모양으로 나가 있다.
    ids = _ids(off_canvas_session, "spills left", "spills right")
    entries = _plan(off_canvas_session, ids,
                    [{"op": "merge", "layerIds": ids, "name": "M"}])
    out_path = tmp_path / "out.psd"
    export_psd(off_canvas_session, entries, out_path)

    out = PSDImage.open(out_path)
    assert out.version == 1
    merged = next(l for l in out if l.name == "M")
    assert merged.bbox == (-12, -9, 89, 38)


# 산출물 확장자는 원본을 따른다. 이 규칙은 프런트엔드 src/lib/exportFlow.ts의
# outputExtension과 글자 그대로 같아야 한다 — 그쪽이 계산한 경로가 덮어쓰기 사전
# 검사와 UI에 쓰이고, 실제로 파일이 나가는 경로는 batch.py라, 둘이 갈라지면
# 검사한 적 없는 경로에 파일을 쓰게 된다.
@pytest.mark.parametrize("src, want", [
    ("/a/b/shot.psd", ".psd"),
    ("/a/b/shot.psb", ".psb"),
    ("/a/b/shot.PSB", ".psb"),          # 대소문자 무시, 결과는 소문자로 정규화
    ("/a/b/shot.PsB", ".psb"),
    ("/a/b/shot.PSD", ".psd"),
    ("/a/b/shot.tiff", ".psd"),         # 무관한 확장자
    ("/a/b/shot", ".psd"),              # 확장자 없음
    ("/a/b/shot.", ".psd"),             # 점만 있고 비어 있음
    ("/a.psb/shot", ".psd"),            # 점이 디렉터리 쪽에만 있음
    ("/a/b/archive.tar.psb", ".psb"),   # 마지막 점만 본다
    ("/a/b/.psb", ".psd"),              # 점으로 시작하는 이름은 확장자가 아니다
])
def test_output_extension_matches_the_frontend_rule(src, want):
    assert output_extension(src) == want


@pytest.mark.parametrize("src,fmt,expected", [
    ("a.psd", "png", ".png"),
    ("a.psb", "png", ".png"),
    ("a.PSD", "jpg", ".jpg"),
    ("a.tiff", "jpg", ".jpg"),
    ("no_extension", "png", ".png"),
    ("a.psd", "psd", ".psd"),
    ("a.psb", "psd", ".psb"),
    ("a.PSB", "psd", ".psb"),
])
def test_output_extension_takes_an_explicit_format(src, fmt, expected):
    assert output_extension(src, fmt) == expected


def test_output_extension_defaults_to_following_the_source():
    # 인자를 안 주면 지금까지의 동작 그대로여야 한다. 기존 호출부가 전부 이 경로다.
    assert output_extension("a.psb") == ".psb"
    assert output_extension("a.psd") == ".psd"


def test_split_output_path_inherits_a_psb_extension():
    # 레이어별 내보내기는 건네받은 경로의 확장자를 그대로 물려받아야 한다 —
    # .psb 원본이 레이어마다 .psd로 쪼개지면 안쪽 버전과 확장자가 어긋난다.
    assert Path(split_output_path("/tmp/a_LINE.psb", "BG")).name == "a_LINE_BG.psb"
    assert Path(split_output_path("/tmp/a_LINE.psd", "BG")).name == "a_LINE_BG.psd"


def test_export_refuses_an_overlong_filename(session, tmp_path):
    entries = _plan(session, [3, 4, 5], [])
    out = tmp_path / ("가" * 300 + ".psd")
    with pytest.raises(ValueError, match="파일 이름이 너무 깁니다"):
        export_psd(session, entries, out)
    # pathlib의 Path.exists()는 ENAMETOOLONG을 그대로 다시 던진다(macOS/Linux
    # 공통) — "없다"와 "이름 자체가 파일시스템 한계를 넘는다"를 구분하지 않는
    # os.path.exists로 확인한다. 프로덕션 코드가 os.path.exists(long_path(...))를
    # 쓰는 것과 같은 이유다.
    assert not os.path.exists(str(out))


def test_split_export_checks_every_name_before_writing_any(session, tmp_path):
    # 세 엔트리 중 하나만 이름이 길어도 한 장도 나가면 안 된다.
    entries = _plan(session, [3, 4, 5], [])
    entries[1]["finalName"] = "나" * 300
    out = tmp_path / "X_LINE.psd"
    # tmp_path는 session(→fixture_psd)이 이미 fixture.psd를 써 둔 디렉터리이므로
    # "비어 있다"가 아니라 "이 호출로 새로 생긴 파일이 없다"를 본다.
    before = set(tmp_path.iterdir())
    with pytest.raises(ValueError, match="파일 이름이 너무 깁니다"):
        export_psd_split(session, entries, out)
    assert set(tmp_path.iterdir()) == before


def test_edge_overlay_is_composited_into_the_line_entry(session, tmp_path):
    # 생성된 획은 그 뷰의 라인 엔트리에 합쳐 뷰당 한 장으로 나간다(설계 5절).
    import numpy as np
    from psd_engine.edges import attach_overlays

    entries = _plan(session, [4], [])
    overlay = np.zeros((6, 6, 4), np.uint8)
    overlay[..., :3] = [10, 20, 30]
    overlay[..., 3] = 255
    attach_overlays(entries, [{"lineIds": [4], "rgba": overlay, "left": 0, "top": 0}])
    assert entries[0]["edgeOverlay"] is not None

    out_path = tmp_path / "out.psd"
    export_psd(session, entries, out_path)
    arr = np.array(list(PSDImage.open(out_path))[0].topil().convert("RGBA"))
    assert (arr[0, 0, :3] == [10, 20, 30]).all(), "획이 합성되지 않았다"


def test_an_overlay_outside_the_layer_bbox_widens_the_entry(session, tmp_path):
    # 획은 라인 레이어 bbox 밖에도 생길 수 있다. 잘라내면 그만큼 사라진다.
    import numpy as np
    from psd_engine.edges import attach_overlays

    entries = _plan(session, [4], [])
    src = session["layers_by_id"][4]
    overlay = np.zeros((4, 4, 4), np.uint8)
    overlay[..., 3] = 255
    attach_overlays(entries, [{"lineIds": [4], "rgba": overlay,
                               "left": src.bbox[2] + 2, "top": src.bbox[1]}])
    out_path = tmp_path / "wide.psd"
    export_psd(session, entries, out_path)
    layer = list(PSDImage.open(out_path))[0]
    assert layer.bbox[2] >= src.bbox[2] + 6


def test_attach_overlays_skips_a_view_whose_lines_are_not_exported(session, tmp_path):
    # 라인을 체크하지 않았으면 합칠 엔트리가 없다. 조용히 건너뛴다.
    import numpy as np
    from psd_engine.edges import attach_overlays

    entries = _plan(session, [4], [])
    overlay = np.ones((4, 4, 4), np.uint8) * 255
    attach_overlays(entries, [{"lineIds": [999], "rgba": overlay, "left": 0, "top": 0}])
    assert entries[0].get("edgeOverlay") is None


def test_export_is_byte_identical_when_the_feature_is_off(session, tmp_path):
    # 기본값 꺼짐. 켜지 않으면 기존 산출물과 같아야 한다.
    a, b = tmp_path / "a.psd", tmp_path / "b.psd"
    export_psd(session, _plan(session, [3, 4, 5], []), a)
    entries = _plan(session, [3, 4, 5], [])
    from psd_engine.edges import attach_overlays
    attach_overlays(entries, [])
    export_psd(session, entries, b)
    assert a.read_bytes() == b.read_bytes()


def test_verify_passes_when_an_edge_overlay_widens_the_entry(session, tmp_path):
    # edgeOverlay가 소스 레이어 bbox 밖으로 엔트리를 넓혀도, entry_pixels를 통해
    # 기대값을 다시 조립하므로 올바른 산출물은 통과해야 한다. entry_pixels를
    # 거치기 전에는 원본 레이어(src.bbox, extract_rgba)와 그대로 대조해 bbox와
    # 픽셀이 둘 다 어긋나 보였다 — verify.py 모듈 docstring이 적어 둔 색 통일
    # 사고와 같은 모양의 두 번째 사고였다.
    from psd_engine.edges import attach_overlays

    entries = _plan(session, [4], [])
    src = session["layers_by_id"][4]
    overlay = np.zeros((4, 4, 4), np.uint8)
    overlay[..., :3] = [1, 2, 3]
    overlay[..., 3] = 255
    attach_overlays(entries, [{"lineIds": [4], "rgba": overlay,
                               "left": src.bbox[2] + 2, "top": src.bbox[1]}])
    out_path = tmp_path / "out.psd"
    export_psd(session, entries, out_path)

    v = verify_export(session, entries, out_path)
    assert v["ok"] is True
    assert v["layers"][0]["pixelOk"] is True


def test_verify_still_catches_a_mismatched_edge_overlay(session, tmp_path):
    # entry_pixels로 기대값을 조립한다고 무엇이든 통과시키면 안 된다 — 오버레이
    # 내용이 실제 산출물과 다르면 여전히 잡아야 한다.
    from psd_engine.edges import attach_overlays

    entries_a = _plan(session, [4], [])
    overlay_a = np.zeros((4, 4, 4), np.uint8)
    overlay_a[..., :3] = [1, 2, 3]
    overlay_a[..., 3] = 255
    attach_overlays(entries_a, [{"lineIds": [4], "rgba": overlay_a, "left": 0, "top": 0}])
    out_path = tmp_path / "out.psd"
    export_psd(session, entries_a, out_path)

    entries_b = _plan(session, [4], [])
    overlay_b = np.zeros((4, 4, 4), np.uint8)
    overlay_b[..., :3] = [9, 9, 9]
    overlay_b[..., 3] = 255
    attach_overlays(entries_b, [{"lineIds": [4], "rgba": overlay_b, "left": 0, "top": 0}])

    v = verify_export(session, entries_b, out_path)
    assert v["ok"] is False
    assert v["layers"][0]["pixelOk"] is False


def test_attach_overlays_merges_two_plans_that_land_on_the_same_entry(session, tmp_path):
    # merge 하나가 두 뷰의 라인을 한 엔트리로 합치면(오늘도 일어난다) 뒤 플랜이
    # 앞 플랜을 덮어써 지워버리면 안 된다 — 둘 다 살아남아야 한다.
    import numpy as np
    from psd_engine.edges import attach_overlays

    entries = _plan(session, [4, 5], [{"op": "merge", "layerIds": [4, 5], "name": "M"}])
    first = np.zeros((4, 4, 4), np.uint8)
    first[..., :3] = [11, 22, 33]
    first[..., 3] = 255
    second = np.zeros((4, 4, 4), np.uint8)
    second[..., :3] = [44, 55, 66]
    second[..., 3] = 255
    attach_overlays(entries, [
        {"lineIds": [4], "rgba": first, "left": 0, "top": 0},
        {"lineIds": [5], "rgba": second, "left": 20, "top": 0},
    ])

    overlay, left, top = entries[0]["edgeOverlay"]
    # 단순 덮어쓰기라면 결과는 second 하나(4x4, left=20)뿐이라 이 너비에 못 미친다.
    assert overlay.shape[1] >= 24
    assert left == 0 and top == 0
    assert tuple(overlay[0, 0, :3]) == (11, 22, 33) and overlay[0, 0, 3] == 255
    assert tuple(overlay[0, 20, :3]) == (44, 55, 66) and overlay[0, 20, 3] == 255


def test_two_overlays_on_one_entry_are_combined_not_replaced(session, tmp_path):
    # 스펙 3.1: 수동은 자동에 보탠다. 덮어쓰면 자동 결과가 조용히 사라진다.
    import numpy as np
    from psd_engine.edges import attach_overlays

    entries = _plan(session, [4], [])
    a = np.zeros((4, 4, 4), np.uint8); a[..., 3] = 255; a[..., :3] = [10, 0, 0]
    b = np.zeros((4, 4, 4), np.uint8); b[2:, :, 3] = 255; b[..., :3] = [0, 10, 0]
    attach_overlays(entries, [
        {"lineIds": [4], "rgba": a, "left": 0, "top": 0},
        {"lineIds": [4], "rgba": b, "left": 0, "top": 8},
    ])
    rgba, left, top = entries[0]["edgeOverlay"]
    assert rgba[..., 3].max() == 255
    # 두 오버레이가 세로로 떨어져 있으므로 합친 것은 둘을 다 담을 만큼 커야 한다.
    assert rgba.shape[0] >= 12, "두 번째 오버레이가 첫 번째를 덮어썼다"
