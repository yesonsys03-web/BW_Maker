import numpy as np
import pytest
from psd_tools import PSDImage

from pathlib import Path

from psd_engine.export import export_psd, export_psd_split, split_output_path
from psd_engine.ops import build_export_plan, finalize_names
from psd_engine.session import SessionStore
from psd_engine.verify import verify_export


@pytest.fixture
def session(fixture_psd):
    store = SessionStore()
    return store.get(store.open(fixture_psd))


def _plan(session, included, operations):
    entries = build_export_plan(included, operations)
    return finalize_names(entries, session["nodes_by_id"], "pathPrefix")


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
    entries = _plan(session, [3, 4, 5], [])
    out_path = tmp_path / "out.psd"
    export_psd(session, entries, out_path, line_color="#000000")

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
    export_psd(session, _plan(session, [4], []), b_path, line_color="#123456")

    a = np.array(list(PSDImage.open(a_path))[0].topil().convert("RGBA"))
    b = np.array(list(PSDImage.open(b_path))[0].topil().convert("RGBA"))
    assert np.array_equal(a[..., 3], b[..., 3])
    assert (b[..., :3] == [0x12, 0x34, 0x56]).all()


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
    out_path = tmp_path / "out.psd"
    with pytest.raises(ValueError, match="invalid line color"):
        export_psd(session, _plan(session, [4], []), out_path, line_color="black")
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
    entries = _plan(session, [4, 5], [])
    result = export_psd_split(session, entries, tmp_path / "s.psd", line_color="#000000")
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
def test_verify_accounts_for_the_line_color_that_export_applied(session, tmp_path):
    entries = _plan(session, [3, 4, 5], [])
    out_path = tmp_path / "out.psd"
    export_psd(session, entries, out_path, line_color="#000000")

    v = verify_export(session, entries, out_path, line_color="#000000")

    assert v["ok"] is True
    assert all(c["pixelOk"] for c in v["layers"])


def test_verify_still_catches_a_wrong_color(session, tmp_path):
    # 색을 아는 것과 무엇이든 통과시키는 것은 다르다. 다른 색으로 나갔다면 잡아야 한다.
    entries = _plan(session, [4], [])
    out_path = tmp_path / "out.psd"
    export_psd(session, entries, out_path, line_color="#123456")

    v = verify_export(session, entries, out_path, line_color="#000000")

    assert v["ok"] is False
    assert v["layers"][0]["pixelOk"] is False


def test_verify_without_a_line_color_is_unchanged(session, tmp_path):
    entries = _plan(session, [3, 4], [])
    out_path = tmp_path / "out.psd"
    export_psd(session, entries, out_path)

    assert verify_export(session, entries, out_path)["ok"] is True
