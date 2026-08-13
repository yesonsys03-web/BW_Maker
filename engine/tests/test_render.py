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


def test_merge_rgba_fast_path_takes_masked_and_faded_layers(masked_psd, monkeypatch):
    """
    마스크와 불투명도가 붙은 잎끼리의 병합도 빠른 경로를 타야 한다.

    실측 2026-08-06, 납품 25장의 병합 55건 인구조사에서 잎 마스크가 가장 큰
    가드였다(레이어 19장이 332.3 Mpx를 예전 경로에 묶고 있었다). 풀고 나니
    빠른 경로가 32건 → 36건이 되고 풀린 4건이 3~6배 빨라졌다.
    """
    s = _session(masked_psd)
    layers = [l for l in s["layers_by_id"].values() if not l.is_group()]
    assert len(layers) == 4
    monkeypatch.setattr(render_mod, "FAST_MERGE", True)
    calls = _spy_on_composite(s["psd"])
    merge_rgba(s["psd"], layers)
    assert calls == [], "마스크·불투명도만으로 예전 경로에 떨어졌다"


def test_merge_rgba_fast_matches_slow_on_masked_and_faded_layers(masked_psd, monkeypatch):
    """
    마스크·불투명도가 낀 병합도 psd.composite 경로와 **바이트로** 같아야 한다.

    네 장이 같은 자리에 겹쳐 있어(0,0,32,24) 배경이 빈 경우와 이미 쌓인 경우를
    한 번에 지나간다. 이 조합이 shape != alpha를 만드는 전부다 — 마스크 bbox가
    레이어보다 좁고 배경이 255인 것(bg255_mask), 마스크 밀도(dense_mask),
    opacity 128(half_opacity_mask).

    가드를 넓힌 방향이라 ±1도 실패다. 다만 이 픽스처는 (shape - alpha) 항을
    지운 예전 식으로도 통과한다 — 불투명도가 다른 한 장이 맨 아래라 alpha_b가
    0이어서 그 항이 사라지기 때문이다. 그것을 가르는 것은
    faded_over_solid_psd 쪽이다.
    """
    s = _session(masked_psd)
    layers = [l for l in s["layers_by_id"].values() if not l.is_group()]

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


def test_merge_rgba_fast_matches_slow_for_a_masked_layer_inside_a_group(
        masked_clip_psd, monkeypatch):
    """
    마스크 달린 잎이 그룹 안에 있고 거기에 클리핑 레이어까지 붙은 경우.

    빠른 경로는 잎을 평평하게 그리는데 psd.composite는 그룹마다 하위 Compositor를
    세운다(_get_group, 715행). 그 하위 Compositor는 isolated=True라 _alpha_0가 0이고,
    그래서 그룹이 도관처럼 투명해지는 것이 빠른 경로가 성립하는 근거다 — 마스크가
    붙어도 그대로인지 여기서 확인한다.
    """
    s = _session(masked_clip_psd)
    base = next(l for l in s["layers_by_id"].values() if l.name == "base")
    assert base.mask is not None and base.has_clip_layers()
    layers = [base]

    monkeypatch.setattr(render_mod, "FAST_MERGE", False)
    slow, slow_left, slow_top = merge_rgba(s["psd"], layers)

    monkeypatch.setattr(render_mod, "FAST_MERGE", True)
    calls = _spy_on_composite(s["psd"])
    fast, fast_left, fast_top = merge_rgba(s["psd"], layers)

    assert calls == [], "그룹 안의 마스크 달린 잎이 예전 경로로 떨어졌다"
    assert (fast_left, fast_top) == (slow_left, slow_top)
    assert np.array_equal(fast, slow), (
        f"최대차 {np.abs(fast.astype(int) - slow.astype(int)).max()}, "
        f"다른 성분 {(fast != slow).sum()}/{fast.size}"
    )


def test_merge_rgba_fast_matches_slow_when_a_faded_leaf_sits_on_another(
        faded_over_solid_psd, monkeypatch):
    """
    불투명도가 있는 잎이 다른 잎 **위에** 얹히는 경우. 여기가 shape != alpha의 값이
    실제로 결과를 바꾸는 유일한 자리다.

    _apply_source의 (shape - alpha) * alpha_b * color_b 항은 alpha_b가 0이면
    사라진다. 그래서 병합의 첫 장에서는 옛 식과 새 식이 같고, 이미 무언가 쌓인
    위에 반투명한 장이 올 때만 갈린다. 갈리는 크기는 float32 반올림 한 자리뿐이라
    (두 식은 대수적으로 같다) 픽스처가 절삭 경계를 실제로 밟아야 한다 —
    faded_over_solid_psd가 (배경색, 마스크) 65,536쌍을 다 깔아 80픽셀을 밟는다.
    """
    s = _session(faded_over_solid_psd)
    layers = [l for l in s["layers_by_id"].values() if not l.is_group()]
    assert {l.name for l in layers} == {"solid", "fade"}

    monkeypatch.setattr(render_mod, "FAST_MERGE", False)
    slow, slow_left, slow_top = merge_rgba(s["psd"], layers)

    monkeypatch.setattr(render_mod, "FAST_MERGE", True)
    calls = _spy_on_composite(s["psd"])
    fast, fast_left, fast_top = merge_rgba(s["psd"], layers)

    assert calls == [], "불투명도만으로 예전 경로에 떨어졌다"
    assert (fast_left, fast_top) == (slow_left, slow_top)
    assert np.array_equal(fast, slow), (
        f"최대차 {np.abs(fast.astype(int) - slow.astype(int)).max()}, "
        f"다른 성분 {(fast != slow).sum()}/{fast.size}"
    )


def test_mask_and_opacity_are_exempted_for_leaves_only(masked_psd):
    """
    마스크·불투명도 면제는 병합 대상 잎에만 준다. 조상 규율은 예전 그대로다.

    그룹의 마스크·불투명도는 자식마다 따로 걸리는 값이 아니라 자식들을 다 합성한
    결과 한 장에 걸린다(_get_group, 715행). 겹치는 자식이 있으면 두 순서의 결과가
    다르므로 잎에 준 면제를 조상으로 옮길 수 없다. _fast_mergeable이 두 호출을
    구분해서 하는지를 여기서 못박는다.
    """
    psd = PSDImage.open(masked_psd)
    faded = next(l for l in psd.descendants() if l.name == "half_opacity_mask")
    assert faded.mask is not None and faded.opacity == 128
    assert render_mod._plain(faded, allow_mask_opacity=True), \
        "잎은 마스크·불투명도가 있어도 통과해야 한다"
    assert not render_mod._plain(faded, allow_passthrough=True), \
        "조상 자리에서는 같은 레이어가 걸려야 한다"


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


def _opt_in_fast(s, layers):
    """오버레이가 하는 것과 같은 호출 — allow_clipping을 켠 빠른 경로.

    `merge_rgba`로는 이것을 못 잰다. 내보내기는 `allow_clipping`을 주지 않으므로
    클리핑이 낀 병합이 언제나 느린 경로로 떨어지고, 그러면 아래 비교가 같은 코드
    끼리가 되어 아무것도 지키지 못한다.
    """
    boxes = [l.bbox for l in layers if l.bbox != (0, 0, 0, 0)]
    vp = (min(b[0] for b in boxes), min(b[1] for b in boxes),
          max(b[2] for b in boxes), max(b[3] for b in boxes))
    ok = render_mod._fast_mergeable(s["psd"], layers, allow_clipping=True)
    return ok, vp


def _whole_composite(s, layers, vp):
    wanted = render_mod._wanted_ids(s["psd"], layers)
    return np.array(s["psd"].composite(
        viewport=vp, force=True, color=1.0, alpha=0.0,
        layer_filter=lambda l: id(l) in wanted).convert("RGBA"))


def test_fast_merge_lays_a_clipping_target_onto_its_base(clip_layer_psd):
    """
    병합 대상 안에 base와 그 클리핑 잎이 함께 있으면, 빠른 경로가 그 잎을 본
    패스에서 빼고 base의 색 위에 얹는다 — psd.composite의 _apply_clip_layers
    (606행)와 같은 자리다.

    세 가지를 한꺼번에 본다 — 빠른 경로가 이 집합을 받는가, psd-tools와 픽셀이
    같은가, 그리고 클리핑 잎이 실제로 그림을 바꾸는가. 마지막 하나가 없으면 이
    픽스처가 아무 차이도 만들지 않을 때 앞의 둘이 조용히 통과한다.
    """
    s = _session(clip_layer_psd)
    base, clip = _by_name(s, "line", "shade")   # shade가 line에 클리핑돼 있다

    ok, vp = _opt_in_fast(s, [base, clip])
    assert ok, "빠른 경로가 이 집합을 안 받는다 — 비교가 공허하다"
    fast, _, _ = render_mod._merge_rgba_fast(s["psd"], [base, clip], vp)
    whole = _whole_composite(s, [base, clip], vp)
    base_only = _whole_composite(s, [base], vp)

    assert np.array_equal(fast, whole), (
        f"최대차 {np.abs(fast.astype(int) - whole.astype(int)).max()}, "
        f"다른 성분 {(fast != whole).sum()}/{fast.size}"
    )
    assert not np.array_equal(whole, base_only), \
        "클리핑 잎이 그림을 안 바꾼다 — 이 픽스처로는 아무것도 지키지 못한다"


def test_fast_merge_lays_a_masked_clipping_target_onto_a_masked_base(masked_clip_psd):
    """
    클리핑 잎에도 base에도 마스크가 걸린 경우. 이 코드에서 가장 어려운 조합이다.

    마스크가 붙으면 `shape_s`와 `alpha_s`가 갈라지고(_layer_source의 주석),
    `_clipped_colour`가 하위 Compositor의 `_alpha_0`로 쓰는 base의 shape는 **마스크
    전** 값이어야 한다 — _get_object가 `alpha = shape * 1.0`을 마스크보다 먼저 뜨기
    때문이다. 마스크 없는 픽스처로는 이 순서가 틀려도 결과가 같아 안 드러난다.

    두 마스크가 다 0..255 그라데이션이라 (base 알파, 클리핑 알파) 조합이 넓게 깔린다.
    """
    s = _session(masked_clip_psd)
    base, clip = _by_name(s, "base", "shade")

    ok, vp = _opt_in_fast(s, [base, clip])
    assert ok, "빠른 경로가 이 집합을 안 받는다 — 비교가 공허하다"
    fast, _, _ = render_mod._merge_rgba_fast(s["psd"], [base, clip], vp)
    whole = _whole_composite(s, [base, clip], vp)
    base_only = _whole_composite(s, [base], vp)

    assert np.array_equal(fast, whole), (
        f"최대차 {np.abs(fast.astype(int) - whole.astype(int)).max()}, "
        f"다른 성분 {(fast != whole).sum()}/{fast.size}"
    )
    assert not np.array_equal(whole, base_only), \
        "마스크 낀 클리핑 잎이 그림을 안 바꾼다 — 지키는 게 없다"


def test_merge_rgba_still_falls_back_when_a_merged_layer_is_itself_clipping(
        clip_layer_psd, monkeypatch):
    """
    **내보내기는 클리핑이 낀 병합을 계속 느린 경로로 보낸다.** 위 두 테스트가 보이듯
    클리핑 재현 자체는 psd-tools와 픽셀이 같은데도 그렇게 둔다.

    이유는 클리핑이 아니라 빠른 경로 자체다 — 잎을 평평하게 union하느냐 그룹마다
    union하느냐로 float32의 마지막 비트가 갈려, psd.composite와 **원리적으로** 비트
    동일이 아니다(_fast_mergeable docstring에 한 픽셀짜리 증거가 있다). 내보내기에
    이 문을 열었더니 납품 26장 중 3장이 즉시 갈렸다(271/1210/124px, 대부분 알파).
    그래서 내보내기의 인구는 이미 기준선으로 검증된 것만 유지한다.
    """
    s = _session(clip_layer_psd)
    base, clip = _by_name(s, "line", "shade")

    monkeypatch.setattr(render_mod, "FAST_MERGE", True)
    calls = _spy_on_composite(s["psd"])
    merge_rgba(s["psd"], [base, clip])
    assert calls, "내보내기가 클리핑 낀 병합을 빠른 경로로 보냈다"
    assert not render_mod._fast_mergeable(s["psd"], [base, clip]), \
        "allow_clipping 없이도 통과한다 — 옵트인이 아무 일도 안 한다"


def test_fast_merge_refuses_a_clipping_target_clipped_to_a_group(clipped_group_psd):
    """
    클리핑 잎의 base가 병합 대상 밖의 **그룹**이면 `allow_clipping`이어도 거절한다.

    psd.composite는 그 그룹을 통째로 합성한 뒤 그 결과 위에 잎을 얹지만
    (_apply_clip_layers, 606행) 빠른 경로에는 그런 중간 결과가 없다 — 잎만 차례로
    캔버스에 얹기 때문이다. 그대로 태우면 그 잎이 조용히 빠진다.

    **옵트인을 켜고 봐야 한다.** `merge_rgba`로 재면 `allow_clipping`이 없어서
    어차피 거절되므로, 이 가드를 지워도 테스트가 통과한다.

    그리고 그 잎이 실제로 그림을 바꾸는지도 같이 본다. 그것이 없으면 잎이 빠져도
    티가 안 나 가드가 지키는 것이 없다 — clip_layer_psd로 쓴 첫 판이 정확히
    그랬다(거기서는 base가 잎이라 빠른 경로가 옳게 재현했다).
    """
    s = _session(clipped_group_psd)
    base, clip = _by_name(s, "line", "shade")

    assert not render_mod._fast_mergeable(s["psd"], [base, clip], allow_clipping=True), \
        "그룹에 물린 클리핑 잎인데 빠른 경로가 받았다"

    boxes = [l.bbox for l in [base, clip]]
    vp = (min(b[0] for b in boxes), min(b[1] for b in boxes),
          max(b[2] for b in boxes), max(b[3] for b in boxes))
    whole = _whole_composite(s, [base, clip], vp)
    base_only = _whole_composite(s, [base], vp)
    assert not np.array_equal(whole, base_only), \
        "이 클리핑 잎이 그림을 안 바꾼다 — 빠져도 티가 안 나므로 지키는 게 없다"


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


def test_merge_rgba_tiles_the_viewport_when_fast_path_is_unavailable(faded_group_psd,
                                                                     monkeypatch):
    """
    빠른 경로를 못 쓰는 병합은 뷰포트를 타일로 나눠 합성하고, 결과는 한 번에
    합성한 것과 같아야 한다.

    느림의 원인은 합성식이 아니라 뷰포트였다 — psd.composite는 병합에 참여하는
    레이어를 전부 합집합 뷰포트 크기로 부풀린다. 뷰포트를 잘라 부르면 psd-tools가
    타일에 걸치지 않는 레이어를 스스로 건너뛰므로(apply의 viewport 교집합 검사)
    그 부풀림이 사라진다. 합성 자체는 psd-tools가 그대로 하므로 마스크·클리핑·
    그룹 semantics를 다시 구현하지 않는다 — 그것이 이 방식을 고른 이유다.
    """
    s = _session(faded_group_psd)
    # 조상 그룹 'ART'의 불투명도가 128이라 빠른 경로가 거부한다 -> 타일 경로로 간다.
    # (클리핑으로 막던 것을 바꿨다 — 빠른 경로가 이제 클리핑을 재현한다.
    #  faded_group_psd docstring 참고.)
    layers = _by_name(s, "line", "line2")

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


def _thumb_png(s, gid, max_size, out_dir):
    out_dir.mkdir()
    paths = render_thumbnails(s, [gid], max_size=max_size, out_dir=out_dir)
    return np.array(Image.open(paths[str(gid)]).convert("RGBA"))


def _count_tiled_calls(monkeypatch):
    """
    타일 경로를 실제로 탔는지, 그리고 타일이 **몇 장**이었는지 기록한다.

    호출 여부만 세면 부족하다 — 타일이 한 장이면 이어붙이기가 일어나지 않아
    "타일로 나눠도 같다"는 비교가 공허해진다. 실제로 그런 적이 있다: 헬퍼가
    THUMBNAIL_TILE_SIZE를 쓰게 바꾼 뒤에도 테스트는 MERGE_TILE_SIZE를 낮추고
    있어서, 64x48 픽스처가 2048 타일 한 장으로 처리되고 있었다.
    """
    calls = []
    real = render_mod._group_rgba_tiled

    def counted(psd, group, bbox, leaves, always_wanted):
        step = render_mod.THUMBNAIL_TILE_SIZE
        nx = -(-(bbox[2] - bbox[0]) // step)
        ny = -(-(bbox[3] - bbox[1]) // step)
        calls.append(nx * ny)
        return real(psd, group, bbox, leaves, always_wanted)

    monkeypatch.setattr(render_mod, "_group_rgba_tiled", counted)
    return calls


def test_large_group_thumbnail_matches_the_single_composite(fixture_psd, tmp_path, monkeypatch):
    """
    타일 경로가 내는 썸네일은 예전 한 번 합성과 **픽셀로** 같아야 한다.

    이 경로의 약속은 "같은 그림을 싸게"이지 "다른 그림"이 아니다. 전해상도로 이어
    붙인 뒤 축소를 마지막에 한 번만 하는 이유가 그것이다 — 타일마다 축소하면
    리샘플링이 갈리고, 그 차이가 여기서 걸린다.

    임계값을 낮춰 작은 픽스처로 타일 경로를 태운다. 여기서 확인하는 성질(결과가
    같다)은 임계값이 얼마든 성립해야 하는 것이므로, 임계값 자체가 쟁점이던 클램프
    테스트와 달리 상수를 낮춰도 확인하려는 것을 잃지 않는다.
    """
    s = _session(fixture_psd)
    gid = next(lid for lid, l in s["layers_by_id"].items() if l.is_group())

    plain = _thumb_png(s, gid, 16, tmp_path / "plain")

    calls = _count_tiled_calls(monkeypatch)
    monkeypatch.setattr(render_mod, "THUMBNAIL_TILE_PX", 0)     # 타일 경로 강제
    monkeypatch.setattr(render_mod, "THUMBNAIL_TILE_SIZE", 8)   # 64x48 -> 8x6 = 48장
    tiled = _thumb_png(s, gid, 16, tmp_path / "tiled")

    assert calls, "타일 경로를 타지 않아 비교가 공허하다"
    assert calls[0] > 1, f"타일이 {calls[0]}장뿐이라 이어붙이기를 확인하지 못한다"
    assert tiled.shape == plain.shape
    assert np.array_equal(tiled, plain), (
        f"최대차 {np.abs(tiled.astype(int) - plain.astype(int)).max()}, "
        f"다른 성분 {(tiled != plain).sum()}/{tiled.size}"
    )


def test_a_small_group_thumbnail_keeps_the_old_single_composite(fixture_psd, tmp_path, monkeypatch):
    # 타일 경로는 큰 그룹만 위한 것이다. 잘 나오고 있는 썸네일은 코드 경로까지
    # 예전 그대로여야 한다 — 결과만 같으면 되는 것이 아니라, 들르지도 말아야 한다.
    s = _session(fixture_psd)
    gid = next(lid for lid, l in s["layers_by_id"].items() if l.is_group())
    calls = _count_tiled_calls(monkeypatch)

    assert _thumb_png(s, gid, 16, tmp_path / "small").size

    assert calls == [], "작은 그룹인데 타일 경로로 갔다"


def test_a_large_group_tiles_even_when_merge_would_refuse_to(
        fixture_psd, tmp_path, monkeypatch):
    """
    썸네일은 _tileable에 걸리지 않는다 — 병합과 달리 그 가드를 쓰지 않기 때문이다.

    이 구분이 이 변경의 요점이다. Bar027의 *ART는 잎 559장 중 1장에 효과가 있다는
    이유로 _tileable이 False가 되는데, 그 한 장 때문에 예전 경로로 떨어지면 290Mpx가
    통째로 부풀어 24GB를 넘긴다. 근거는 _group_rgba_tiled의 docstring에 실측으로
    적어 두었다(효과가 있는 그룹 5건, 타일을 4배로 잘게 썰어도 최대차 0).
    """
    s = _session(fixture_psd)
    gid = next(lid for lid, l in s["layers_by_id"].items() if l.is_group())
    calls = _count_tiled_calls(monkeypatch)
    monkeypatch.setattr(render_mod, "THUMBNAIL_TILE_PX", 0)
    monkeypatch.setattr(render_mod, "_tileable", lambda psd, layers: False)

    assert _thumb_png(s, gid, 16, tmp_path / "fx").size

    assert calls, "_tileable이 썸네일 타일 경로를 막았다"


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


# 아티스트가 라인이 아닌 색 레이어를 손으로 체크해 넣으면, 미리보기가 그것까지
# 라인 색으로 칠해 화면에서 새까맣게 보였다(썸네일은 원본 색이라 더 헷갈렸다).
# 색 통일은 프리셋 규칙에 걸린 라인 레이어에만 걸려야 한다.
def test_render_preview_only_normalizes_the_matched_line_layers(fixture_psd, tmp_path):
    from PIL import Image
    s = _session(fixture_psd)
    # id 2 = fill(128, 캔버스 전체), id 4 = line(50, 0,0..32,24). 배율은 1.0이다
    # (문서 64x48이 max_size 256보다 작아 확대하지 않는다).
    im = Image.open(render_preview(
        s, [2, 4], max_size=256, out_dir=tmp_path,
        line_color="#FF0000", line_color_ids=[4],
    )).convert("RGBA")
    arr = np.array(im)
    assert tuple(arr[5, 5][:3]) == (255, 0, 0), "라인이 색 통일되지 않았다"
    assert tuple(arr[40, 40][:3]) == (128, 128, 128), "규칙에 걸리지 않은 레이어가 덮였다"


def test_render_preview_normalizes_everything_when_no_ids_are_given(fixture_psd, tmp_path):
    # line_color_ids가 None이면 예전대로 전부 건다 — 규칙을 모르는 호출자용 기본값.
    from PIL import Image
    s = _session(fixture_psd)
    im = Image.open(render_preview(
        s, [2, 4], max_size=256, out_dir=tmp_path, line_color="#FF0000",
    )).convert("RGBA")
    arr = np.array(im)
    painted = arr[..., 3] > 0
    assert (arr[painted][:, 0] == 255).all()
    assert (arr[painted][:, 1] == 0).all()


def test_assign_line_color_marks_only_the_matched_sources():
    from psd_engine.render import assign_line_color

    entries = [{"sourceIds": [4]}, {"sourceIds": [2]}]
    assign_line_color(entries, "#000000", [4])
    assert entries[0]["lineRgb"] == (0, 0, 0)
    assert entries[1]["lineRgb"] is None


def test_assign_line_color_skips_a_merge_that_mixes_matched_and_unmatched():
    # 색은 병합이 끝난 뒤 한 번에 덮으므로, 소스가 섞이면 라인만 골라 덮을 수
    # 없다. 그때는 색 통일을 포기하고 원본 색을 지킨다(지우는 쪽이 아니라 남기는 쪽).
    from psd_engine.render import assign_line_color

    entries = [{"sourceIds": [4, 5]}, {"sourceIds": [4, 2]}]
    assign_line_color(entries, "#000000", [4, 5])
    assert entries[0]["lineRgb"] == (0, 0, 0)
    assert entries[1]["lineRgb"] is None


def test_assign_line_color_without_a_color_marks_nothing():
    from psd_engine.render import assign_line_color

    entries = [{"sourceIds": [4]}]
    assign_line_color(entries, None, [4])
    assert entries[0]["lineRgb"] is None


def test_render_preview_draws_the_edge_overlays_it_is_given(fixture_psd, tmp_path):
    # 화면에서 확인할 수 없으면 내보내기 전에 알 방법이 없다.
    from PIL import Image
    s = _session(fixture_psd)
    overlay = np.zeros((8, 8, 4), np.uint8)
    overlay[..., :3] = [255, 0, 0]
    overlay[..., 3] = 255
    png = render_preview(s, [4], max_size=256, out_dir=tmp_path,
                         edge_overlays=[{"rgba": overlay, "left": 0, "top": 0,
                                         "lineIds": [4]}])
    arr = np.array(Image.open(png).convert("RGBA"))
    assert tuple(arr[2, 2][:3]) == (255, 0, 0)


def test_render_preview_a_fully_transparent_overlay_leaves_the_canvas_unchanged(
        fixture_psd, tmp_path):
    # None과 []는 둘 다 루프를 0번 돈다 — 루프 본문이 무슨 짓을 해도 통과하는
    # 공허한 대조였다. 알파가 전부 0인 진짜 오버레이를 실제로 루프에 태우고도
    # (필터 통과, 리사이즈, 합성까지 다 거치고) 결과가 바뀌지 않아야 한다.
    from PIL import Image
    s = _session(fixture_psd)
    transparent = np.zeros((8, 8, 4), np.uint8)  # alpha 전부 0
    a = np.array(Image.open(render_preview(s, [4, 5], 256, tmp_path)).convert("RGBA"))
    b = np.array(Image.open(render_preview(
        s, [4, 5], 256, tmp_path,
        edge_overlays=[{"rgba": transparent, "left": 0, "top": 0, "lineIds": [4]}],
    )).convert("RGBA"))
    assert np.array_equal(a, b)


def test_render_preview_hides_an_overlay_whose_view_is_not_on_screen(fixture_psd, tmp_path):
    # 눈 아이콘으로 뷰의 라인을 끄면(=visible_layer_ids에서 빠지면) 그 뷰의 생성된
    # 획도 같이 사라져야 한다 — 안 그러면 화면에 없는 레이어의 획이 캔버스에
    # 떠 있게 된다(결함 1).
    from PIL import Image
    s = _session(fixture_psd)
    shown = np.zeros((4, 4, 4), np.uint8)
    shown[..., :3] = [0, 255, 0]
    shown[..., 3] = 255
    hidden = np.zeros((4, 4, 4), np.uint8)
    hidden[..., :3] = [0, 0, 255]
    hidden[..., 3] = 255
    png = render_preview(s, [4], max_size=256, out_dir=tmp_path, edge_overlays=[
        {"rgba": shown, "left": 0, "top": 0, "lineIds": [4]},   # lineIds가 화면에 있다
        {"rgba": hidden, "left": 40, "top": 0, "lineIds": [5]},  # lineIds가 화면에 없다
    ])
    arr = np.array(Image.open(png).convert("RGBA"))
    assert tuple(arr[2, 2][:3]) == (0, 255, 0), "화면에 있는 뷰의 획이 그려지지 않았다"
    assert arr[2, 42, 3] == 0, "화면에 없는 뷰의 획이 그려졌다"


def test_render_preview_only_recolors_overlays_whose_view_is_in_the_color_scope(
        fixture_psd, tmp_path):
    # 색 통일이 일부 레이어에만 걸릴 때(line_color_ids로 범위를 좁혔을 때), 그
    # 범위 밖 뷰의 획은 원본 색을 지켜야 한다 — assign_line_color가 규칙에
    # 걸리지 않은 엔트리의 lineRgb를 None으로 남기는 것과 같은 규칙이다(결함 2).
    from PIL import Image
    s = _session(fixture_psd)
    original = np.zeros((4, 4, 4), np.uint8)
    original[..., :3] = [100, 100, 100]
    original[..., 3] = 255
    png = render_preview(
        s, [4, 5], max_size=256, out_dir=tmp_path,
        line_color="#FF0000", line_color_ids=[4],
        edge_overlays=[
            {"rgba": original.copy(), "left": 0, "top": 0, "lineIds": [4]},   # 범위 안
            {"rgba": original.copy(), "left": 40, "top": 0, "lineIds": [5]},  # 범위 밖
        ],
    )
    arr = np.array(Image.open(png).convert("RGBA"))
    assert tuple(arr[2, 2][:3]) == (255, 0, 0), "범위 안 뷰의 획이 통일색으로 칠해지지 않았다"
    assert tuple(arr[2, 42][:3]) == (100, 100, 100), "범위 밖 뷰의 획이 통일색으로 칠해졌다"


def test_leaf_thumbnails_reuse_preview_tiles_instead_of_decoding(fixture_psd, tmp_path, monkeypatch):
    # 참고 그룹(TEMPLATE 등)을 펼칠 때마다 56.9Mpx 잎이 47초씩 다시 디코드되던
    # 회귀 방지 — 잎 썸네일은 미리보기·전체 캐시가 데워 둔 타일에서 줄인다.
    s = _session(fixture_psd)
    render_mod._preview_tile(s, 2, 1.0)  # 미리보기 배율(캔버스 64px < 1500 → 1.0)

    def boom(layer):
        raise AssertionError("타일이 있으면 디코드하면 안 된다")

    monkeypatch.setattr(render_mod, "extract_rgba", boom)
    thumbs = render_thumbnails(s, [2], max_size=32, out_dir=tmp_path)
    assert "2" in thumbs


def test_leaf_thumbnails_fall_back_to_full_res_when_the_tile_is_too_small(fixture_psd, tmp_path, monkeypatch):
    # 작은 잎 × 큰 캔버스 축소에서는 타일이 썸네일보다 작아 확대 흐림이 생긴다 —
    # 그때만 원본 디코드로 간다(그런 잎은 어차피 싸다). 원본 경로면 64x48
    # 잎에서 32px 썸네일이 나오고, 8px짜리 타일을 억지로 키웠다면 8px다.
    from PIL import Image
    monkeypatch.setattr(render_mod, "THUMBNAIL_SOURCE_MAX_SIZE", 8)
    s = _session(fixture_psd)
    thumbs = render_thumbnails(s, [2], max_size=32, out_dir=tmp_path)
    assert max(Image.open(thumbs["2"]).size) == 32


def test_thumbnailing_does_not_shrink_the_cached_tile(fixture_psd, tmp_path):
    # 썸네일은 캐시된 타일의 **사본**에서 줄여야 한다 — 제자리에서 줄이면 다음
    # 미리보기가 48px 뭉개진 그림으로 그려진다.
    s = _session(fixture_psd)
    w = render_mod._preview_tile(s, 2, 1.0)[0].width
    render_thumbnails(s, [2], max_size=16, out_dir=tmp_path)
    assert render_mod._preview_tile(s, 2, 1.0)[0].width == w


def test_render_preview_keeps_a_thin_stroke_visible_at_a_small_scale(fixture_psd, tmp_path):
    # 12,000px짜리 소품 시트는 미리보기 배율이 ~0.125라, 자동 굵기 몇 px짜리
    # 획이 LANCZOS 평균에 녹아 사라져 보였다 — "생성됐는데 화면에 없다"로 두 번
    # 신고된 증상. 축소 전에 획을 두껍게 만들어 축소 후에도 진한 획이 남아야
    # 한다. 64px 캔버스에 max_size=8이면 배율 0.125로 그 조건이 재현된다.
    from PIL import Image
    s = _session(fixture_psd)
    overlay = np.zeros((48, 64, 4), np.uint8)
    overlay[24, :, :3] = [255, 0, 0]      # 폭 1px짜리 가로 획
    overlay[24, :, 3] = 255
    png = render_preview(s, [4], max_size=8, out_dir=tmp_path,
                         edge_overlays=[{"rgba": overlay, "left": 0, "top": 0,
                                         "lineIds": [4]}])
    arr = np.array(Image.open(png).convert("RGBA")).astype(np.int32)
    # 캔버스에는 레이어 픽셀(알파 255)도 있으므로 알파만으로는 획을 못 집고,
    # 투명 배경 위 안개 픽셀도 RGB는 순빨강이라 색만으로도 못 집는다 — 눈에
    # 보이는 양은 (빨강 우세) × 알파다. 무보정이면 알파가 ~22라 이 값이 22에
    # 머문다(실측).
    redness = (arr[..., 0] - np.maximum(arr[..., 1], arr[..., 2])) * arr[..., 3] // 255
    assert int(redness.max()) >= 100, \
        f"축소 후 획이 안개가 됐다 — 보이는 빨강 {int(redness.max())}"
