import numpy as np
import pytest
from psd_tools import PSDImage

from psd_engine.export import export_psd
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
