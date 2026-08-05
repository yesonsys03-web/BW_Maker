import types

import numpy as np
import pytest
from PIL import Image
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


def test_masked_fixture_really_carries_masks(masked_psd):
    """
    픽스처가 무엇을 확인하는지부터 확인한다. 마스크가 안 붙으면 아래 동등성
    테스트가 전부 마스크 없는 경로를 재고도 통과한다 — 0fbbeef에서 타일 수를
    안 세서 공허해졌던 테스트와 같은 함정이다.
    """
    psd = PSDImage.open(masked_psd)
    by_name = {l.name: l for l in psd.descendants()}
    assert set(by_name) >= {"plain_mask", "bg255_mask", "dense_mask",
                            "half_opacity_mask"}
    for name in ("plain_mask", "bg255_mask", "dense_mask", "half_opacity_mask"):
        m = by_name[name].mask
        assert m is not None and not m.disabled, f"{name}에 마스크가 없다"
    assert by_name["bg255_mask"].mask.background_color == 255
    assert by_name["bg255_mask"].mask.bbox != by_name["bg255_mask"].bbox
    assert by_name["dense_mask"].mask.parameters is not None
    assert by_name["half_opacity_mask"].opacity == 128


@pytest.mark.parametrize("name", ["plain_mask", "bg255_mask", "dense_mask",
                                  "half_opacity_mask"])
def test_masked_extract_is_byte_identical_to_composite(masked_psd, name):
    """
    값싼 경로는 psd-tools의 합성과 **바이트로** 같아야 한다.

    ±1도 실패다. export.py가 이 함수를 쓰므로 계약이 바이트 동일이고, ±1은
    보통 float32 산술이나 uint8 절삭을 psd-tools와 다르게 했다는 신호다.
    """
    psd = PSDImage.open(masked_psd)
    layer = next(l for l in psd.descendants() if l.name == name)
    reference = np.array(layer.composite(viewport=layer.bbox).convert("RGBA"))

    fast = render_mod._extract_rgba_masked(layer)

    assert fast is not None, f"{name}이 가드를 못 넘어 값싼 경로를 타지 못했다"
    assert fast.shape == reference.shape
    assert np.array_equal(fast, reference), (
        f"최대차 {np.abs(fast.astype(int) - reference.astype(int)).max()}, "
        f"다른 성분 {(fast != reference).sum()}/{fast.size}"
    )


def test_masked_clip_fixture_really_clips_and_masks(masked_clip_psd):
    """
    아래 거부 테스트가 공허하지 않은지부터 확인한다. 마스크가 없으면 값싼 경로는
    클리핑과 무관하게 거부하고, 클리핑이 안 걸리면 잴 것이 없다.
    """
    psd = PSDImage.open(masked_clip_psd)
    by_name = {l.name: l for l in psd.descendants()}
    assert set(by_name) >= {"shade", "base"}
    for name in ("shade", "base"):
        m = by_name[name].mask
        assert m is not None and not m.disabled, f"{name}에 마스크가 없다"
        assert by_name[name].is_visible(), f"{name}이 숨어 있다"
    assert by_name["shade"].clipping
    assert by_name["base"].has_clip_layers()


@pytest.mark.parametrize("name", ["shade", "base"])
def test_clipping_shapes_fall_back_instead_of_taking_the_fast_path(
        masked_clip_psd, name, monkeypatch):
    """
    클리핑이 낀 두 모양은 값싼 경로가 거부하고 예전 경로로 떨어져야 한다.

    shade(clipping=True)는 composite가 통째로 건너뛰어 배경만 남고, base는
    composite가 shade를 위에 합성해 준다. 값싼 경로는 둘 다 재현하지 않는다.
    """
    psd = PSDImage.open(masked_clip_psd)
    layer = next(l for l in psd.descendants() if l.name == name)
    reference = np.array(layer.composite(viewport=layer.bbox).convert("RGBA"))

    assert render_mod._extract_rgba_masked(layer) is None, "가드가 걸러야 한다"
    assert np.array_equal(extract_rgba(layer), reference), \
        "fallback이 예전과 같은 그림을 내야 한다"

    # 가드를 빼면 실제로 그림이 달라진다 — 이 테스트가 무언가를 지키고 있다는 증거다.
    # 이것이 없으면 값싼 경로가 우연히 같은 값을 내는 경우와 구별되지 않는다.
    monkeypatch.setattr(render_mod, "_mask_fast_ok", lambda l: True)
    unguarded = render_mod._extract_rgba_masked(layer)
    assert unguarded is not None
    assert not np.array_equal(unguarded, reference), \
        "가드를 빼도 같다면 이 가드는 아무것도 지키지 않는 것이다"


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


def _by_name(s, *names):
    return [next(l for l in s["layers_by_id"].values() if l.name == n) for n in names]


def test_merge_rgba_keeps_an_off_canvas_viewport_that_still_fits(off_canvas_psd):
    """
    캔버스 밖으로 나갔더라도 담을 수 있는 뷰포트는 그대로 둔다.

    납품 25장 중 13장이 이런 모양이고, 그 26개 병합의 좌표는 지금까지 나간 산출물에
    그대로 들어 있다. 여기서 자르면 그 전부가 어긋난다 — 자르기는 담을 수 없을 때의
    마지막 수단이지 기본 동작이 아니다.
    """
    s = _session(off_canvas_psd)
    layers = _by_name(s, "spills left", "spills right")

    arr, left, top = merge_rgba(s["psd"], layers)

    assert (left, top) == (-12, -9)          # 합집합 (-12,-9)-(89,38)
    assert arr.shape == (47, 101, 4)


def test_merge_rgba_clamps_a_viewport_that_cannot_be_composited(oversize_union_psd):
    """
    합집합이 30,000을 넘으면 그때는 캔버스까지 자른다.

    캔버스가 11901x7297인 납품 PSB 한 장이 32510x9335 합집합을 만들어 병합이
    "exceeds the PSD maximum of 30000 px per axis"로 죽은 적이 있다. 버려지는 것은
    포토샵에서 어차피 보이지 않는 영역이다.

    상수를 monkeypatch로 낮추지 않고 진짜 임계값을 지나간다 — 낮추면 자르는 산술만
    확인하고 임계값 자체가 맞는지는 확인하지 못한다.
    """
    s = _session(oversize_union_psd)
    psd = s["psd"]
    layers = _by_name(s, "spills left", "spills right", "far right")

    arr, left, top = merge_rgba(psd, layers)

    # 자르기 전 합집합은 (-10,-6)-(30540,40) = 30550x46 이다.
    assert (left, top) == (0, 0)
    assert arr.shape == (40, psd.width, 4)
    assert left + arr.shape[1] <= psd.width and top + arr.shape[0] <= psd.height


def test_merge_rgba_fast_matches_slow_on_a_clamped_viewport(
        oversize_union_psd, monkeypatch):
    """
    뷰포트를 잘랐어도 빠른 경로와 psd.composite 경로의 픽셀이 같아야 한다.

    자르지 않은 뷰포트는 합집합이라 모든 레이어가 그 안에 통째로 들어가지만, 자르고
    나면 걸쳐 나갈 수 있다. 그때 빠른 경로가 원본 배열을 그대로 얹으면 오프셋이
    음수가 되는데, numpy는 예외를 내지 않고 배열 반대쪽 끝을 집어 엉뚱한 자리에
    그린다 — 조용히 틀리는 종류라 여기서 잡아야 한다.
    """
    s = _session(oversize_union_psd)
    layers = _by_name(s, "spills left", "spills right", "far right")

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


def test_merge_rgba_fast_matches_slow_when_nothing_is_clamped(off_canvas_psd, monkeypatch):
    """
    자르기가 걸리지 않는 평범한 경우에도 두 경로가 같아야 한다.

    _merge_rgba_fast의 걸침 자르기는 이 경우 no-op이어야 한다 — 그것이 납품 파일
    대부분이 지나가는 길이고, 여기서 한 픽셀이라도 움직이면 기준선이 깨진다.
    """
    s = _session(off_canvas_psd)
    layers = _by_name(s, "spills left", "spills right", "outside")

    monkeypatch.setattr(render_mod, "FAST_MERGE", False)
    slow, slow_left, slow_top = merge_rgba(s["psd"], layers)

    monkeypatch.setattr(render_mod, "FAST_MERGE", True)
    fast, fast_left, fast_top = merge_rgba(s["psd"], layers)

    assert (fast_left, fast_top) == (slow_left, slow_top) == (-200, -9)
    assert np.array_equal(fast, slow), (
        f"최대차 {np.abs(fast.astype(int) - slow.astype(int)).max()}, "
        f"다른 성분 {(fast != slow).sum()}/{fast.size}"
    )


def test_merge_rgba_tiled_matches_slow_on_a_clamped_viewport(
        oversize_union_psd, monkeypatch):
    """
    타일 경로도 잘린 뷰포트에서 같은 그림을 내야 한다.

    실제 납품 PSD의 병합은 마스크·클리핑이 끼어 빠른 경로를 못 쓰는 것이 많아서
    이쪽이 오히려 흔한 길이다. 여기서는 걸침을 psd-tools가 처리하지만(타일마다
    viewport로 잘라 부른다), 이어붙이는 인덱스는 우리가 계산하므로 확인이 필요하다.
    """
    s = _session(oversize_union_psd)
    layers = _by_name(s, "spills left", "spills right", "far right")

    monkeypatch.setattr(render_mod, "FAST_MERGE", False)
    whole, whole_left, whole_top = merge_rgba(s["psd"], layers)

    monkeypatch.setattr(render_mod, "FAST_MERGE", True)
    monkeypatch.setattr(render_mod, "_fast_mergeable", lambda psd, layers: False)
    monkeypatch.setattr(render_mod, "MERGE_TILE_SIZE", 8)
    tiled, tiled_left, tiled_top = merge_rgba(s["psd"], layers)

    assert (tiled_left, tiled_top) == (whole_left, whole_top)
    assert tiled.shape == whole.shape
    assert np.array_equal(tiled, whole), (
        f"최대차 {np.abs(tiled.astype(int) - whole.astype(int)).max()}, "
        f"다른 성분 {(tiled != whole).sum()}/{tiled.size}"
    )


def test_what_a_psb_over_30000_can_and_cannot_do(wide_psb, tmp_path):
    """
    30,000을 넘는 PSB에서 되는 것과 안 되는 것의 경계를 못박아 둔다.

    psd-tools는 PSB에도 PSD v1의 30,000px 축 상한을 건다 — 스펙이 아니라 메모리
    보호가 이유라고 자기 주석에 적어 두었다(api/utils.py). 그 상한을 풀어줄까
    고민했지만 풀지 않기로 했다: 납품 파일 26장의 캔버스·그룹 bbox·마스크 리프
    bbox를 전부 재보니 30,000을 넘는 축이 하나도 없었다(가장 큰 것이 Bar027의
    *ART 그룹 26367x11024). 닿지 않는 경로를 위해 남의 라이브러리 가드를 전역으로
    바꾸는 것은 값이 비싸다.

    그래서 경계는 이렇게 남는다. 열기·레이어 단위 추출·병합은 되고(내보내기가
    쓰는 길은 전부 이쪽이다), 문서 전체를 한 번에 합성하는 것만 막힌다.
    """
    from psd_engine.session import SessionStore

    store = SessionStore()
    s = store.get(store.open(wide_psb))
    assert s["psd"].version == 2 and s["psd"].width == 32510

    leaves = [l for l in s["layers_by_id"].values() if not l.is_group()]
    lids = [lid for lid, l in s["layers_by_id"].items() if not l.is_group()]

    # 되는 것 — 내보내기가 실제로 쓰는 길
    assert extract_rgba(leaves[0]).shape[2] == 4
    assert render_thumbnails(s, lids, max_size=64, out_dir=tmp_path)
    arr, left, top = merge_rgba(s["psd"], leaves)
    assert (left, top) == (100, 20)
    assert left + arr.shape[1] == 32510, "30,000 뒤의 픽셀이 뷰포트에서 잘렸다"

    # 안 되는 것 — 문서 전체 합성. 배치 내보내기는 여기를 지나지 않는다.
    with pytest.raises(ValueError, match="exceeds the PSD maximum"):
        render_document_preview(s, max_size=64, out_dir=tmp_path)


def test_merge_rgba_rejects_a_clamped_merge_with_nothing_left(all_outside_union_psd):
    # 자른 결과 그릴 것이 하나도 남지 않으면 빈 레이어와 같이 다룬다. 0x0 배열을
    # 돌려주면 export가 그것을 레이어로 기록하려다 훨씬 뒤에서 터진다.
    s = _session(all_outside_union_psd)
    layers = _by_name(s, "way left", "near left")   # 합집합 30,940 > 30,000, 전부 캔버스 왼쪽
    with pytest.raises(ValueError, match="outside the canvas"):
        merge_rgba(s["psd"], layers)


def test_scaled_leaf_premultiplies_before_resizing(fixture_psd):
    """
    축소는 프리멀티플라이드 알파에서 해야 한다.

    스트레이트 알파로 R/G/B/A를 따로 줄이면 알파가 0인 자리에 남아 있는 색이
    가장자리로 번진다. 라인아트는 안티에일리어싱이 전부 알파에 들어 있어서 그
    번짐이 그대로 보인다 — apply_line_color의 주석이 같은 이유를 적고 있다.
    """
    s = _session(fixture_psd)
    leaf = s["layers_by_id"][4]          # 'line' value=50, 32x24, 알파 255
    out = render_mod._scaled_leaf(leaf, 0.25, (0, 0))
    assert out is not None
    rgba, x0, y0 = out
    assert rgba.dtype == np.float32
    assert rgba.shape == (6, 8, 4)
    assert (x0, y0) == (0, 0)
    # 알파가 전부 1이므로 프리멀티플라이드 색은 원본과 같다: 50/255
    assert np.allclose(rgba[..., 3], 1.0, atol=1e-3)
    assert np.allclose(rgba[..., :3], 50 / 255, atol=2e-3)


def _exact_group_thumbnail(psd, group):
    """
    render_thumbnails가 '비싼 그룹' 갈래에서 정확 기준으로 실제로 쓰는 것과 같은
    layer_filter로 그룹을 합성한다(render.py의 render_thumbnails 참고: 조상은
    강제로 통과시키고 — 숨은 그룹 오버라이드 — 보이는 자손만 넣는다).

    필터 없이 group.composite(force=True, color=1.0, alpha=0.0)를 부르면 다른
    그림이 나온다 — 실측(설계 문서 §4.3)에서 두 기준이 LINES 33.9, wall2 53.5만큼
    달랐고, 그 차이를 축소 합성기의 오차로 잘못 읽을 뻔했다. 이 테스트 스위트의
    두 기존 테스트가 그 실수를 그대로 물려받고 있었다 — 여기로 옮겨 한 곳에서
    고친다.
    """
    ancestors_and_self = set()
    cur = group
    while cur is not psd:
        ancestors_and_self.add(id(cur))
        cur = cur.parent
    descendant_ids = {id(d) for d in group.descendants() if d.visible}
    return group.composite(
        force=True, color=1.0, alpha=0.0,
        layer_filter=lambda l: id(l) in ancestors_and_self or id(l) in descendant_ids,
    )


def test_scaled_group_reproduces_blend_modes(blend_group_psd):
    """
    축소 합성기는 평탄화가 아니다.

    실납품에서 8Mpx 넘는 그룹의 80%가 블렌드나 클리핑을 갖고 있고, 비용 상위
    30개 중 29개가 클리핑을 갖는다. 알파 오버로 겹쳐 버리면 정작 사람이 기다리는
    그룹의 그림이 전부 틀린다 — 이 테스트가 그 회귀를 잡는다.

    48px 캔버스 합성은 시간이 0에 가까우므로 이 충실도는 공짜다.

    픽스처가 판별력을 갖는 것을 확인해 두었다: base 64에 shade 192를 multiply로
    얹으면 겹치는 자리가 **48**, 알파 오버로 겹치면 **192**다(실측). 그래서 이
    테스트는 평탄화 구현에서 반드시 실패한다.
    """
    s = _session(blend_group_psd)
    gid = next(lid for lid, l in s["layers_by_id"].items() if l.is_group())
    group = s["layers_by_id"][gid]

    exact_img = _exact_group_thumbnail(s["psd"], group).convert("RGBA")
    exact_img.thumbnail((16, 16))
    exact_small = np.array(exact_img)

    # production과 같은 순서로 줄인다 — _group_rgba_scaled는 중간 해상도로
    # 돌려주고, 축소는 render_thumbnails의 img.thumbnail 한 번뿐이다.
    scaled_img = Image.fromarray(
        render_mod._group_rgba_scaled(s["psd"], group, group.bbox), "RGBA")
    scaled_img.thumbnail((16, 16))
    scaled = np.array(scaled_img)

    assert scaled.shape == exact_small.shape
    diff = np.abs(scaled.astype(int) - exact_small.astype(int)).max()
    assert diff <= 24, f"블렌드가 재현되지 않았다 — 최대차 {diff} (평탄화면 144 근처)"
    # 막대가 실제로 판별하는지 여기서 함께 못박는다 — 겹치는 자리가 곱연산 값이어야
    # 한다. 위 최대차만 보면 축소 때문에 우연히 통과하는 구현을 놓칠 수 있다.
    assert scaled[2, 2, 0] < 120, (
        f"겹치는 자리가 {scaled[2, 2, 0]} — 곱연산(48)이 아니라 알파 오버(192)다")


def test_scaled_group_reproduces_clipping(clip_layer_psd, tmp_path):
    """
    클리핑 레이어는 베이스의 **색만** 바꾸고 알파는 바꾸지 않는다 —
    _apply_clip_layers가 하위 Compositor의 _color만 돌려주기 때문이다.

    평탄화 구현은 클리핑 레이어를 베이스 밖에까지 그려서 알파가 넓어진다.
    그래서 알파를 비교하면 그 실수가 잡힌다.
    """
    s = _session(clip_layer_psd)
    gid = next(lid for lid, l in s["layers_by_id"].items() if l.is_group())
    group = s["layers_by_id"][gid]

    exact_img = _exact_group_thumbnail(s["psd"], group).convert("RGBA")
    exact_img.thumbnail((16, 16))
    exact_small = np.array(exact_img)

    scaled_img = Image.fromarray(
        render_mod._group_rgba_scaled(s["psd"], group, group.bbox), "RGBA")
    scaled_img.thumbnail((16, 16))
    scaled = np.array(scaled_img)

    assert scaled.shape == exact_small.shape
    alpha_diff = np.abs(scaled[..., 3].astype(int) - exact_small[..., 3].astype(int)).max()
    assert alpha_diff <= 24, f"클리핑이 알파를 넓혔다 — 최대차 {alpha_diff}"


def test_scaled_group_reproduces_its_own_mask_and_opacity(masked_group_psd):
    """
    그룹 **자신**의 마스크·불투명도가 최상위/중첩 어느 자리에서도 반영돼야 한다.

    _group_rgba_scaled는 한동안 own_alpha_factor 없이 draw()의 for-루프 안에서
    불투명도만(그것도 자식으로 방문될 때만) 곱했다 — 그룹 자신의 마스크는 어디서도
    읽지 않았고, 최상위 그룹은 어느 부모의 for-루프에도 안 걸리므로 자기
    불투명도조차 반영되지 않았다. 알파를 비교하면 그 둘 다 잡힌다 — 마스크가
    걸린 자리는 완전히 다른 값이 나온다(실측: 옛 코드에서 이 픽스처의 알파
    최대차 180).
    """
    s = _session(masked_group_psd)
    outer = next(l for l in s["layers_by_id"].values()
                if l.is_group() and l.name == "OUTER")

    exact = np.array(outer.composite(force=True, color=1.0, alpha=0.0).convert("RGBA"))
    scaled = render_mod._group_rgba_scaled(s["psd"], outer, outer.bbox)

    assert scaled.shape == exact.shape
    alpha_diff = np.abs(scaled[..., 3].astype(int) - exact[..., 3].astype(int)).max()
    assert alpha_diff <= 4, (
        f"그룹 자신의 마스크·불투명도가 반영되지 않았다 — 최대차 {alpha_diff}")


def test_scaled_leaf_opacity_is_not_double_applied_when_masked(masked_leaf_group_psd):
    """
    마스크 달린 잎의 불투명도를 두 번 곱하지 않는다.

    extract_rgba는 마스크 달린 잎의 불투명도·fill 불투명도를 이미 반영해 돌려준다
    (_extract_rgba_masked 또는 layer.composite 경유). own_alpha_factor가 무조건 또
    곱하면 128/255가 아니라 (128/255)^2이 되어, 캔버스 전체 알파가 낮게 나온다
    (실측: 옛 코드에서 이 픽스처의 알파 최대차 64).
    """
    s = _session(masked_leaf_group_psd)
    group = next(l for l in s["layers_by_id"].values() if l.is_group())

    exact = np.array(group.composite(force=True, color=1.0, alpha=0.0).convert("RGBA"))
    scaled = render_mod._group_rgba_scaled(s["psd"], group, group.bbox)

    assert scaled.shape == exact.shape
    alpha_diff = np.abs(scaled[..., 3].astype(int) - exact[..., 3].astype(int)).max()
    assert alpha_diff <= 4, (
        f"불투명도가 두 번 적용된 것으로 보인다 — 최대차 {alpha_diff} "
        f"(두 번 곱하면 128/255가 아니라 (128/255)^2, 즉 128 대신 64 근처가 된다)")


def test_scaled_group_does_not_double_apply_a_masked_clip_layer(masked_clip_multiply_psd):
    """
    마스크 달린 베이스에 곱연산 클리핑 레이어가 붙은 경우도 두 번 합성하지 않는다.

    extract_rgba는 클리핑 있는 마스크 레이어를 항상 layer.composite()로 떨어뜨려
    (has_clip_layers 가드) 클리핑까지 이미 합성해 돌려준다. draw()가 클리핑 루프를
    또 태우면 곱연산이 두 번 걸린다 — 곱연산은 멱등이 아니라서(normal과 달리) 두
    번째로 갈수록 값이 계속 준다(실측: 옛 코드에서 정확 50, 옛 코드 12; 시각적
    RGB 최대차 38).
    """
    s = _session(masked_clip_multiply_psd)
    group = next(l for l in s["layers_by_id"].values() if l.is_group())

    exact = np.array(group.composite(force=True, color=1.0, alpha=0.0).convert("RGBA")).astype(int)
    scaled = render_mod._group_rgba_scaled(s["psd"], group, group.bbox).astype(int)

    assert scaled.shape == exact.shape
    both_visible = (exact[..., 3] > 0) & (scaled[..., 3] > 0)
    assert both_visible.any(), "픽스처에 겹치는 자리가 없다 — 판별력을 잃었다"
    rgb_diff = np.abs(scaled[..., :3] - exact[..., :3]).max(axis=2)
    visible_diff = rgb_diff[both_visible].max()
    assert visible_diff <= 4, (
        f"클리핑 레이어가 두 번 합성된 것으로 보인다 — 시각적 RGB 최대차 "
        f"{visible_diff}(두 번 곱하면 38 근처가 된다)")


def test_scaled_group_ignores_a_clip_layer_that_lives_outside_it(sibling_clip_group_psd):
    """
    썸네일 대상 그룹 **자신**에게, 그 그룹의 부모 컨테이너 안에서 붙은 클리핑
    레이어는 무시해야 한다 — 실납품에서 실제로 걸린 회귀다(HH0306 02_Color의
    'LINES' 그룹에 형제 'Layer 621'이 클리핑돼 있었다).

    render_thumbnails의 layer_filter(조상+자손만 통과)는 GROUP의 부모에 속한 그
    클리핑 레이어를 걸러 no-op으로 만든다. `_group_rgba_scaled`가 최상위 그룹을
    draw()의 일반 자식 루프에 태워 자기 clip_layers를 필터 없이 처리하면, 이
    자리에서만 그 클리핑이 새 나간다 — 실측: 이 회귀로 평범한 그룹 108개 기준
    최악 premultiplied 차이가 10.0에서 103.7로 뛰었다.

    같은 그룹 **안쪽**의 클리핑('inner_clip'이 'inner_base'에 곱연산으로 클리핑)은
    자손끼리라 필터 안에 들어오므로 그대로 반영돼야 한다 — 이 테스트는 "그룹 밖
    클리핑은 무시, 그룹 안 클리핑은 반영"을 한 번에 가른다.
    """
    s = _session(sibling_clip_group_psd)
    lines = next(l for l in s["layers_by_id"].values() if l.is_group() and l.name == "LINES")

    exact = np.array(_exact_group_thumbnail(s["psd"], lines).convert("RGBA")).astype(int)
    scaled = render_mod._group_rgba_scaled(s["psd"], lines, lines.bbox).astype(int)

    assert scaled.shape == exact.shape
    diff = np.abs(scaled.astype(int) - exact.astype(int)).max()
    assert diff <= 4, (
        f"그룹 밖 클리핑이 새 나간 것으로 보인다 — 최대차 {diff}")

    # 픽스처가 실제로 판별력을 갖는지 — sibling_clip을 걸렀을 때와 안 걸렀을 때가
    # 달라야 한다. 안 그러면 위 assert가 우연히 통과했을 뿐일 수 있다.
    unfiltered = np.array(lines.composite(force=True, color=1.0, alpha=0.0).convert("RGBA"))
    unfiltered_diff = np.abs(exact.astype(int) - unfiltered.astype(int)).max()
    assert unfiltered_diff > 4, (
        "필터를 걸고 안 걸고가 그림에서 차이가 안 난다 — 이 픽스처가 sibling_clip "
        "제외를 판별하지 못한다")

    # 안쪽 클리핑(inner_clip)은 여전히 반영돼야 한다 — 곱연산이라 겹치는 자리가
    # 200이 아니라 200*64/255=50 근처여야 한다.
    assert scaled[16, 16, 0] < 120, (
        f"안쪽 클리핑이 반영되지 않았다 — {scaled[16, 16, 0]} (반영되면 50 근처, "
        f"안 되면 200)")


def test_scaled_group_gives_a_passthrough_subgroup_the_real_backdrop(passthrough_subgroup_psd):
    """
    pass-through 하위그룹은 격리해서 그린 뒤 얹으면 안 된다 — 그 안의 블렌드가
    부모(형제 base)가 아니라 자기만의 빈 캔버스를 배경으로 계산돼 버린다.

    이 픽스처는 판별력이 crisp하다: base 64 위에 pass-through 하위그룹 안의
    mult(곱연산) 192가 곱해지면 겹치는 자리가 **48 근처**(64*192/255)여야 한다.
    격리해서 그리면 mult가 흰 배경 위에서 곱해져 그대로 **192**가 남는다 — 차이 144.

    review 실측(2026-08-05)과 같은 모양: exact 50 vs 격리 64.
    """
    s = _session(passthrough_subgroup_psd)
    outer = next(l for l in s["layers_by_id"].values() if l.is_group() and l.name == "OUTER")

    exact = np.array(_exact_group_thumbnail(s["psd"], outer).convert("RGBA"))
    scaled = render_mod._group_rgba_scaled(s["psd"], outer, outer.bbox)

    assert scaled.shape == exact.shape
    diff = np.abs(scaled.astype(int) - exact.astype(int)).max()
    assert diff <= 4, f"pass-through 하위그룹이 부모 배경을 못 받았다 — 최대차 {diff}"
    # 막대가 실제로 판별하는지 여기서 못박는다 — 겹치는 자리가 곱연산 값이어야 한다.
    assert scaled[16, 16, 0] < 120, (
        f"겹치는 자리가 {scaled[16, 16, 0]} — 곱연산(48 근처)이 아니라 격리해서 그린 "
        f"값(192)이다")


def test_a_cheap_group_keeps_the_exact_composite(fixture_psd, tmp_path, monkeypatch):
    """
    축소 합성기는 비싼 그룹만 위한 것이다. 잘 나오고 있는 썸네일은 결과만 같으면
    되는 것이 아니라 들르지도 말아야 한다 — 근사 경로가 조용히 기본이 되면
    바이트 동일이라는 성질을 잃고도 아무도 모른다.
    """
    calls = []
    real = render_mod._group_rgba_scaled
    monkeypatch.setattr(render_mod, "_group_rgba_scaled",
                        lambda *a, **k: calls.append(1) or real(*a, **k))
    s = _session(fixture_psd)
    gid = next(lid for lid, l in s["layers_by_id"].items() if l.is_group())

    render_thumbnails(s, [gid], max_size=16, out_dir=tmp_path)

    assert calls == [], "싼 그룹인데 축소 합성기로 갔다"


def test_an_expensive_group_uses_the_scaled_compositor(fixture_psd, tmp_path, monkeypatch):
    calls = []
    real = render_mod._group_rgba_scaled
    monkeypatch.setattr(render_mod, "_group_rgba_scaled",
                        lambda *a, **k: calls.append(1) or real(*a, **k))
    monkeypatch.setattr(render_mod, "THUMBNAIL_EXACT_BUDGET", 0)
    s = _session(fixture_psd)
    gid = next(lid for lid, l in s["layers_by_id"].items() if l.is_group())

    paths = render_thumbnails(s, [gid], max_size=16, out_dir=tmp_path)

    assert calls, "예산을 0으로 낮췄는데도 축소 합성기를 타지 않았다"
    assert Image.open(paths[str(gid)]).size[0] <= 16


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
