import types

import numpy as np
import pytest
from psd_tools import PSDImage

from psd_engine import render as render_mod
from psd_engine.render import (extract_rgba, merge_rgba, render_document_preview,
                               render_preview, render_thumbnails)
from psd_engine.tree import build_tree


def _session(path):
    psd = PSDImage.open(path)
    built = build_tree(psd)
    return {"psd": psd, "layers_by_id": built["layers_by_id"]}


def test_extract_rgba(fixture_psd):
    s = _session(fixture_psd)
    arr = extract_rgba(s["layers_by_id"][4])   # 'line' value=50, 32x24
    assert arr.shape == (24, 32, 4)
    assert (arr[..., :3] == 50).all() and (arr[..., 3] == 255).all()


def test_extract_rgba_empty_layer_raises():
    # psd-tools' topil() returns None for layers with no pixels
    layer = types.SimpleNamespace(mask=None, name="empty", topil=lambda: None)
    with pytest.raises(ValueError, match="no pixels"):
        extract_rgba(layer)


def test_merge_rgba_overlap(fixture_psd):
    s = _session(fixture_psd)
    # 'fill'(128, 전체) 위에 'lines'(200, (10,10)-(30,20))
    arr, left, top = merge_rgba(s["psd"], [s["layers_by_id"][2], s["layers_by_id"][5]])
    assert (left, top) == (0, 0)
    assert arr.shape == (48, 64, 4)
    assert (arr[0, 0, :3] == 128).all()        # fill만 있는 곳
    assert (arr[15, 15, :3] == 200).all()      # lines가 위에 있는 곳
    assert (arr[..., 3] == 255)[0, 0]


def test_merge_rgba_respects_hidden_source(fixture_psd):
    # merge 대상으로 명시한 레이어는 원본 visible=False여도 포함되어야 한다
    s = _session(fixture_psd)
    arr, left, top = merge_rgba(s["psd"], [s["layers_by_id"][3]])
    assert (left, top) == (5, 5)
    assert (arr[..., :3] == 77).all()


def _spy_on_composite(psd):
    """psd.composite 호출을 기록한다(실제 동작은 그대로)."""
    calls = []
    real = psd.composite

    def spy(*args, **kwargs):
        calls.append(kwargs)
        return real(*args, **kwargs)

    psd.composite = spy
    return calls


def test_merge_rgba_plain_layers_skip_document_composite(alpha_overlap_psd):
    """
    평범한 레이어(normal/불투명도 255/마스크 없음)끼리의 병합은 문서 전체 합성을
    부르지 않는다.

    psd.composite는 병합에 참여하는 레이어를 전부 합집합 뷰포트 크기로 부풀린 뒤
    float32로 훑는다. 실측에서 109장짜리 병합 하나가 5,009 Mpx를 만지고 19.5GB를
    썼다 — 레이어들이 실제로 차지하는 넓이는 98 Mpx뿐인데도.
    """
    s = _session(alpha_overlap_psd)
    calls = _spy_on_composite(s["psd"])
    merge_rgba(s["psd"], [s["layers_by_id"][0], s["layers_by_id"][1]])
    assert calls == [], "평범한 병합인데 문서 전체 합성을 불렀다"


def test_merge_rgba_fast_matches_slow_on_overlapping_alpha(alpha_overlap_psd, monkeypatch):
    """
    빠른 경로의 결과는 psd.composite 경로와 픽셀 단위로 같아야 한다.

    같게 만드는 조건이 세 가지다(전부 실측으로 확인했다): 알파 0인 자리는 흰색
    (psd.composite(color=1.0)), 합성 순서는 문서 순서(아래→위), 양자화는 반올림이
    아니라 절삭((255 * color).astype(uint8)). 하나라도 어긋나면 값이 갈린다.
    """
    s = _session(alpha_overlap_psd)
    layers = [s["layers_by_id"][0], s["layers_by_id"][1]]

    monkeypatch.setattr(render_mod, "FAST_MERGE", False)
    slow, slow_left, slow_top = merge_rgba(s["psd"], layers)

    monkeypatch.setattr(render_mod, "FAST_MERGE", True)
    fast, fast_left, fast_top = merge_rgba(s["psd"], layers)

    assert (fast_left, fast_top) == (slow_left, slow_top)
    assert fast.shape == slow.shape
    assert np.array_equal(fast, slow), (
        f"최대차 {np.abs(fast.astype(int) - slow.astype(int)).max()}, "
        f"다른 성분 {(fast != slow).sum()}/{fast.size}"
    )


def test_merge_rgba_fast_path_ignores_clip_layers_outside_the_merge(clip_layer_psd, monkeypatch):
    """
    병합 대상에 클리핑 레이어가 붙어 있어도 빠른 경로를 쓴다.

    merge_rgba는 layer_filter로 병합 대상과 그 조상만 통과시키므로, 그들에게
    클리핑된 레이어는 psd.composite에서 이미 걸러진다(_apply_clip_layers가 만드는
    하위 Compositor도 같은 filter를 물려받고, 아무것도 적용되지 않으면 backdrop
    배열을 그대로 돌려준다). 결과에 영향이 없는 것을 이유로 빠른 경로를 막으면
    실제 납품 PSD에서는 이득이 거의 사라진다 — 실측에서 걸린 가드 316건 중
    309건이 이것이었다.
    """
    s = _session(clip_layer_psd)
    assert s["layers_by_id"][2].clipping, "픽스처가 클리핑 플래그를 못 세웠다"
    layers = [s["layers_by_id"][1], s["layers_by_id"][3]]   # line, line2

    monkeypatch.setattr(render_mod, "FAST_MERGE", False)
    slow, slow_left, slow_top = merge_rgba(s["psd"], layers)

    monkeypatch.setattr(render_mod, "FAST_MERGE", True)
    calls = _spy_on_composite(s["psd"])
    fast, fast_left, fast_top = merge_rgba(s["psd"], layers)

    assert calls == [], "합성에 끼지도 못하는 클리핑 레이어 때문에 빠른 경로를 막았다"
    assert (fast_left, fast_top) == (slow_left, slow_top)
    assert np.array_equal(fast, slow), (
        f"최대차 {np.abs(fast.astype(int) - slow.astype(int)).max()}, "
        f"다른 성분 {(fast != slow).sum()}/{fast.size}"
    )


def test_merge_rgba_falls_back_when_a_merged_layer_is_itself_clipping(clip_layer_psd, monkeypatch):
    """
    병합 대상 자체가 클리핑 레이어면 예전 경로로 떨어진다.

    psd.composite는 본 패스에서 클리핑 레이어를 통째로 건너뛴다(apply의
    `if not clip_compositing and layer.clipping: return`). 빠른 경로가 그것을
    그리면 지금까지 없던 그림이 산출물에 생긴다.
    """
    s = _session(clip_layer_psd)
    layers = [s["layers_by_id"][1], s["layers_by_id"][2]]   # line, shade(클리핑)

    monkeypatch.setattr(render_mod, "FAST_MERGE", True)
    calls = _spy_on_composite(s["psd"])
    merge_rgba(s["psd"], layers)
    assert calls, "클리핑 레이어가 병합 대상인데 빠른 경로로 갔다"


def test_merge_rgba_draws_a_layer_under_a_hidden_group(hidden_group_psd):
    """
    숨겨진 그룹 안의 레이어도, 병합 대상으로 지정했으면 그려진다.

    프리셋의 includeHidden이 그런 레이어를 매칭에 넣으므로 여기서 조용히 빠지면
    "병합되면 사라지고 단독으로 나가면 나온다"는 상태가 된다 — 실제 납품 파일에서
    바 스툴 6개 중 하나가 그렇게 통째로 빠져 있었다(HotelINTLobbyBarMMESS002의
    CHAIR06). 옛 경로가 떨어뜨린 이유는 psd.composite가 isolated 그룹의 뷰포트를
    그 그룹 bbox와 교차시키는데, 숨겨진 조상 탓에 그 bbox가 (0,0,0,0)이어서다.
    """
    s = _session(hidden_group_psd)
    hidden_line = next(l for lid, l in s["layers_by_id"].items()
                       if not l.is_group() and l.left == 34)
    visible_line = next(l for lid, l in s["layers_by_id"].items()
                        if not l.is_group() and l.left == 4)

    arr, left, top = merge_rgba(s["psd"], [visible_line, hidden_line])

    assert (left, top) == (4, 4)
    # 숨겨진 그룹 쪽 레이어(문서 x 34~54)가 결과에 있어야 한다
    assert arr[..., 3][:, 34 - left:54 - left].max() == 255, "숨겨진 그룹 안의 라인이 빠졌다"
    assert arr[..., 3][:, 0:20].max() == 255, "보이는 라인까지 빠졌다"


def test_merge_rgba_tiles_the_viewport_when_fast_path_is_unavailable(clip_layer_psd, monkeypatch):
    """
    빠른 경로를 못 쓰는 병합은 뷰포트를 타일로 나눠 합성하고, 결과는 한 번에
    합성한 것과 같아야 한다.

    느림의 원인은 합성식이 아니라 뷰포트였다 — psd.composite는 병합에 참여하는
    레이어를 전부 합집합 뷰포트 크기로 부풀린다. 뷰포트를 잘라 부르면 psd-tools가
    타일에 걸치지 않는 레이어를 스스로 건너뛰므로(apply의 viewport 교집합 검사)
    그 부풀림이 사라진다. 합성 자체는 psd-tools가 그대로 하므로 마스크·클리핑·
    그룹 semantics를 다시 구현하지 않는다 — 그것이 이 방식을 고른 이유다.
    """
    s = _session(clip_layer_psd)
    # shade는 클리핑이라 float32 빠른 경로가 거부한다 -> 타일 경로로 간다.
    layers = [s["layers_by_id"][1], s["layers_by_id"][2]]

    monkeypatch.setattr(render_mod, "FAST_MERGE", False)
    whole, whole_left, whole_top = merge_rgba(s["psd"], layers)

    monkeypatch.setattr(render_mod, "FAST_MERGE", True)
    monkeypatch.setattr(render_mod, "MERGE_TILE_SIZE", 8)
    calls = _spy_on_composite(s["psd"])
    tiled, tiled_left, tiled_top = merge_rgba(s["psd"], layers)

    assert len(calls) > 1, f"타일로 나누지 않았다(합성 호출 {len(calls)}회)"
    assert (tiled_left, tiled_top) == (whole_left, whole_top)
    assert tiled.shape == whole.shape
    assert np.array_equal(tiled, whole), (
        f"최대차 {np.abs(tiled.astype(int) - whole.astype(int)).max()}, "
        f"다른 성분 {(tiled != whole).sum()}/{tiled.size}"
    )


def test_render_thumbnails_and_preview(fixture_psd, tmp_path):
    s = _session(fixture_psd)
    thumbs = render_thumbnails(s, [4, 5], max_size=16, out_dir=tmp_path)
    from PIL import Image
    im = Image.open(thumbs["4"])
    assert im.size[0] <= 16 and im.size[1] <= 16

    preview = render_preview(s, [2, 5], max_size=32, out_dir=tmp_path)
    im = Image.open(preview)
    assert max(im.size) <= 32


def test_render_thumbnails_group_not_empty(fixture_psd, tmp_path):
    # Group thumbnails should not be transparent (have alpha>0 pixels)
    s = _session(fixture_psd)
    # BG group (id 1) contains fill layer (128, full canvas)
    thumbs = render_thumbnails(s, [1], max_size=16, out_dir=tmp_path)
    from PIL import Image
    im = Image.open(thumbs["1"])
    arr = np.array(im)
    # Should have pixels with alpha > 0
    assert (arr[..., 3] > 0).any()


def test_render_thumbnails_hidden_group(fixture_psd, tmp_path):
    # Hidden groups should still render their content when explicitly requested
    s = _session(fixture_psd)
    # BG group (id 1) - make it hidden then render
    layer_bg = s["layers_by_id"][1]
    layer_bg.visible = False
    thumbs = render_thumbnails(s, [1], max_size=16, out_dir=tmp_path)
    from PIL import Image
    im = Image.open(thumbs["1"])
    arr = np.array(im)
    # Should still have pixels with alpha > 0 despite being hidden
    assert (arr[..., 3] > 0).any()


def test_render_thumbnails_skips_empty_layer(fixture_psd, tmp_path):
    # Regression: a real PSD can contain pixel layers an artist created but
    # never painted (bbox (0,0,0,0), topil() -> None). One such layer must not
    # take down the whole batch — it's simply omitted from the result.
    s = _session(fixture_psd)
    empty_layer = types.SimpleNamespace(
        mask=None, name="reflections", topil=lambda: None,
        width=0, height=0, is_group=lambda: False,
    )
    s["layers_by_id"][999] = empty_layer
    thumbs = render_thumbnails(s, [4, 999, 5], max_size=16, out_dir=tmp_path)
    assert "999" not in thumbs
    assert set(thumbs) == {"4", "5"}


def test_render_preview_handles_empty_visible_set(fixture_psd, tmp_path):
    # render_preview's viewport is the document canvas, not any layer's bbox,
    # so an empty (or all-empty) visible set must not raise the "Image
    # dimensions must be positive" PIL error render_thumbnails was hit by.
    s = _session(fixture_psd)
    preview = render_preview(s, [], max_size=32, out_dir=tmp_path)
    from PIL import Image
    im = Image.open(preview)
    assert im.size[0] > 0 and im.size[1] > 0


def test_render_preview_stacks_selected_layers_bottom_to_top(fixture_psd, tmp_path):
    # 'fill'(128, 전체 캔버스) 아래, 'lines'(200, (10,10)-(30,20)) 위. max_size를
    # 캔버스보다 크게 줘 축소 없이 원본 좌표로 확인한다.
    from PIL import Image
    s = _session(fixture_psd)
    im = Image.open(render_preview(s, [2, 5], max_size=256, out_dir=tmp_path)).convert("RGBA")
    arr = np.array(im)
    assert arr[0, 0, 0] == 128        # fill만 있는 곳
    assert arr[15, 15, 0] == 200      # lines가 위에 겹친 곳


def test_render_preview_leaves_unselected_area_transparent(fixture_psd, tmp_path):
    # 배경은 UI가 흰색/체커/검정 중에 골라 깔기 때문에 엔진은 투명하게 남긴다.
    from PIL import Image
    s = _session(fixture_psd)
    im = Image.open(render_preview(s, [5], max_size=256, out_dir=tmp_path)).convert("RGBA")
    arr = np.array(im)
    assert arr[0, 0, 3] == 0          # 'lines' bbox 밖
    assert arr[15, 15, 3] == 255      # 'lines' 안


def test_render_preview_ignores_source_blend_mode(blend_mode_psd, tmp_path):
    # export_psd가 모든 레이어를 normal/255로 기록하므로, 내보낸 PSD에서 MULTIPLY
    # 레이어는 곱해지지 않고 그대로 덮인다. 미리보기도 그 결과를 보여야 한다 —
    # 원본 스택대로 곱해서 보여주면 실제 산출물과 다른 그림이 된다.
    from PIL import Image
    s = _session(blend_mode_psd)
    ids = sorted(s["layers_by_id"])
    im = Image.open(render_preview(s, ids, max_size=256, out_dir=tmp_path)).convert("RGBA")
    value = np.array(im)[8, 8, 0]
    assert value == 64, f"shade 픽셀이 그대로 덮여야 하는데 {value} (MULTIPLY 적용 시 64*255/255=64보다 어두워짐)"


def test_render_preview_reuses_decoded_tiles_across_calls(fixture_psd, tmp_path):
    # 체크박스 토글마다 PSD 채널을 다시 푸는 것이 느림의 근원이었다. 두 번째
    # 호출은 캐시만으로 그려져야 한다 — layers_by_id에서 레이어를 없애버려도
    # 같은 그림이 나오는 것으로 확인한다.
    from PIL import Image
    s = _session(fixture_psd)
    first = np.array(Image.open(render_preview(s, [2, 5], max_size=256, out_dir=tmp_path)))
    assert len(s["preview_tiles"]) == 2

    s["layers_by_id"] = {}          # 캐시 미스가 나면 KeyError로 드러난다
    second = np.array(Image.open(render_preview(s, [2, 5], max_size=256, out_dir=tmp_path)))
    assert np.array_equal(first, second)


def test_preview_tile_cache_is_keyed_by_scale(fixture_psd, tmp_path):
    # 배율이 다르면 타일도 달라야 한다 — 같은 키로 재사용하면 엉뚱한 크기로 그려진다.
    s = _session(fixture_psd)
    render_preview(s, [5], max_size=256, out_dir=tmp_path)
    render_preview(s, [5], max_size=16, out_dir=tmp_path)
    assert len(s["preview_tiles"]) == 2


def test_preview_tile_cache_evicts_over_budget(fixture_psd, tmp_path, monkeypatch):
    # 640MB급 PSD를 두 세션까지 열어두므로 캐시는 상한이 있어야 한다.
    monkeypatch.setattr(render_mod, "PREVIEW_TILE_BUDGET_BYTES", 1)
    s = _session(fixture_psd)
    render_preview(s, [2, 4, 5], max_size=256, out_dir=tmp_path)
    assert len(s["preview_tiles"]) == 1


def test_render_preview_skips_empty_layer(fixture_psd, tmp_path):
    # 그린 적 없는 빈 레이어(0x0)가 섞여도 전체가 죽지 않고 건너뛴다.
    from PIL import Image
    s = _session(fixture_psd)
    s["layers_by_id"][999] = types.SimpleNamespace(
        mask=None, name="reflections", topil=lambda: None,
        width=0, height=0, left=0, top=0, is_group=lambda: False,
    )
    im = Image.open(render_preview(s, [2, 999, 5], max_size=256, out_dir=tmp_path))
    assert np.array(im)[15, 15, 0] == 200


def test_render_document_preview_uses_stored_composite(fixture_psd, tmp_path):
    # 레이어 수와 무관하게 저장된 병합 이미지를 쓰는 경로. 파일을 막 연 시점의
    # 첫 화면용이라 크기만 맞으면 된다.
    from PIL import Image
    s = _session(fixture_psd)
    im = Image.open(render_document_preview(s, max_size=32, out_dir=tmp_path))
    assert max(im.size) <= 32
    assert im.size[0] > 0 and im.size[1] > 0


def test_render_thumbnails_respects_child_visibility(fixture_psd, tmp_path):
    # Child layer visibility should be respected in group thumbnails
    # BG group (id 1) contains: line (id 4, value 50), hidden_line (id 3, value 77), fill (id 2, value 128)
    s = _session(fixture_psd)
    # Hide the 'line' layer (id 4) then render BG group
    layer_line = s["layers_by_id"][4]
    layer_line.visible = False
    # Use large max_size to preserve original pixel coordinates
    thumbs = render_thumbnails(s, [1], max_size=128, out_dir=tmp_path)
    from PIL import Image
    im = Image.open(thumbs["1"])
    arr = np.array(im)
    # At position (6,6) which is inside the line's bbox (0,0,32,24)
    # but since line is hidden, should show fill value (128) instead
    assert arr[6, 6, 0] == 128  # R channel should be fill value


def test_parse_line_color_accepts_hex_and_none():
    from psd_engine.render import parse_line_color
    assert parse_line_color(None) is None
    assert parse_line_color("#000000") == (0, 0, 0)
    assert parse_line_color("#1A2b3C") == (26, 43, 60)
    assert parse_line_color("  #FFFFFF  ") == (255, 255, 255)


@pytest.mark.parametrize("bad", ["black", "#FFF", "#GGGGGG", "000000", "#1234567", ""])
def test_parse_line_color_rejects_malformed_values(bad):
    # 오타 하나 때문에 색 통일이 조용히 빠진 채 배치가 도는 것이 최악이다.
    from psd_engine.render import parse_line_color
    with pytest.raises(ValueError, match="invalid line color"):
        parse_line_color(bad)


def test_apply_line_color_replaces_rgb_and_keeps_alpha():
    # 라인의 안티에일리어싱은 알파에 들어있으므로 알파는 그대로여야 한다.
    from psd_engine.render import apply_line_color
    src = np.zeros((2, 2, 4), np.uint8)
    src[..., :3] = [200, 100, 50]
    src[..., 3] = [[0, 77], [128, 255]]
    out = apply_line_color(src, (0, 0, 0))
    assert (out[..., :3] == 0).all()
    assert out[..., 3].tolist() == [[0, 77], [128, 255]]
    assert (src[..., 0] == 200).all(), "원본 배열을 제자리에서 바꾸면 안 된다"


def test_apply_line_color_none_is_a_passthrough():
    from psd_engine.render import apply_line_color
    src = np.full((2, 2, 4), 123, np.uint8)
    assert apply_line_color(src, None) is src


def test_render_preview_normalizes_line_color(fixture_psd, tmp_path):
    # 소스 레이어 색이 서로 달라도(50 / 200) 한 색으로 통일되고, 알파 경계는 유지된다.
    from PIL import Image
    s = _session(fixture_psd)
    im = Image.open(
        render_preview(s, [4, 5], max_size=256, out_dir=tmp_path, line_color="#FF0000")
    ).convert("RGBA")
    arr = np.array(im)
    painted = arr[..., 3] > 0
    assert painted.any()
    assert (arr[painted][:, 0] == 255).all()
    assert (arr[painted][:, 1] == 0).all()
    assert (arr[painted][:, 2] == 0).all()


def test_render_preview_without_line_color_keeps_source_colors(fixture_psd, tmp_path):
    from PIL import Image
    s = _session(fixture_psd)
    im = Image.open(render_preview(s, [2, 5], max_size=256, out_dir=tmp_path)).convert("RGBA")
    arr = np.array(im)
    assert arr[0, 0, 0] == 128
    assert arr[15, 15, 0] == 200
