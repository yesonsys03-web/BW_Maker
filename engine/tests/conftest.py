import numpy as np
import pytest
from pytoshop import enums
from pytoshop.user import nested_layers

from psd_engine.patches import apply_pytoshop_patches

CANVAS_W, CANVAS_H = 64, 48


def make_image(name, value, x, y, w, h, alpha=255, visible=True, blend=None):
    px = np.full((h, w), value, np.uint8)
    a = np.full((h, w), alpha, np.uint8)
    return nested_layers.Image(
        name=name, channels={0: px, 1: px, 2: px, -1: a},
        top=y, left=x, opacity=255, visible=visible,
        blend_mode=blend or enums.BlendMode.normal,
    )


def make_image16(name, value, x, y, w, h, alpha=65535, visible=True):
    """16비트 채널을 든 레이어. 실제 납품 폴더에 16비트 PSD가 섞여 있다."""
    px = np.full((h, w), value, np.uint16)
    a = np.full((h, w), alpha, np.uint16)
    return nested_layers.Image(
        name=name, channels={0: px, 1: px, 2: px, -1: a},
        top=y, left=x, opacity=255, visible=visible,
        blend_mode=enums.BlendMode.normal,
    )


def write_psd(path, layers_top_first, width=CANVAS_W, height=CANVAS_H, clipping=(),
              version=enums.Version.version_1):
    """
    clipping: 클리핑 플래그를 켤 레이어 이름들. nested_layers.Image에는 그 인자가
    없어서 변환이 끝난 레코드에 직접 세운다.

    version: 30,000px을 넘는 픽스처는 PSB(version 2)로만 쓸 수 있다.
    """
    apply_pytoshop_patches()
    psd = nested_layers.nested_layers_to_psd(
        layers_top_first, color_mode=enums.ColorMode.rgb, version=version,
        size=(width, height),
    )
    if clipping:
        for record in psd.layer_and_mask_info.layer_info.layer_records:
            if record.name in clipping:
                record.clipping = True
    with open(path, "wb") as f:
        psd.write(f)
    return str(path)


def attach_mask(psd, name, mask_array, left, top, default_color=0,
                user_mask_density=None):
    """
    변환이 끝난 레코드에 사용자 마스크를 붙인다.

    nested_layers.Image에 마스크 인자가 없어서 write_psd의 clipping과 같은 방식으로
    레코드를 직접 고친다. 채널 -2가 PSD의 사용자 레이어 마스크다.

    default_color는 psd-tools 쪽에서 mask.background_color로 읽히고, 마스크 bbox
    **밖**을 그 값으로 채운다 — 그 조합이 실납품 데이터에서 값싼 경로와 어긋난
    자리라 픽스처가 반드시 덮어야 한다.
    """
    import pytoshop.layers as pl
    from pytoshop import enums as pe

    h, w = mask_array.shape
    for record in psd.layer_and_mask_info.layer_info.layer_records:
        if record.name != name:
            continue
        record.mask = pl.LayerMask(
            top=top, left=left, bottom=top + h, right=left + w,
            default_color=default_color, user_mask_density=user_mask_density,
        )
        record.channels[-2] = pl.ChannelImageData(
            image=mask_array, compression=pe.Compression.raw)
        return
    raise AssertionError(f"layer {name!r} not found")


@pytest.fixture
def fixture_psd(tmp_path):
    # 리스트는 index 0 = 최상단. 문서 아래→위 = *ART(fill, hidden line, line, lines), -REF(line)
    art = nested_layers.Group(name="*ART", layers=[
        make_image("lines", 200, 10, 10, 20, 10),
        nested_layers.Group(name="BG", layers=[
            make_image("line", 50, 0, 0, 32, 24),
            make_image("hidden line", 77, 5, 5, 4, 4, visible=False),
            make_image("fill", 128, 0, 0, 64, 48),
        ]),
    ])
    ref = nested_layers.Group(name="-REF", layers=[
        make_image("line", 10, 0, 0, 8, 8),
    ])
    p = tmp_path / "fixture.psd"
    write_psd(p, [ref, art])
    return p


@pytest.fixture
def blend_mode_psd(tmp_path):
    """
    아래에 흰 'base'(255), 그 위에 MULTIPLY 'shade'(64)가 얹힌 문서.

    원본 스택 안에서 합성하면 곱연산이 적용돼 어두워지지만, export_psd는 모든
    레이어를 normal/255로 기록하므로 내보낸 PSD에서는 shade가 그냥 그대로
    덮인다. 미리보기가 어느 쪽을 재현하는지 가르는 픽스처다.
    """
    p = tmp_path / "blend.psd"
    write_psd(p, [
        make_image("shade", 64, 0, 0, 16, 16, blend=enums.BlendMode.multiply),
        make_image("base", 255, 0, 0, 32, 32),
    ], width=32, height=32)
    return p


@pytest.fixture
def alpha_overlap_psd(tmp_path):
    """
    반투명이 서로 겹치는 두 레이어.

    다른 픽스처는 전부 alpha=255라 어떤 합성식을 쓰든 결과가 같다 — 병합 경로를
    바꿔도 차이가 드러나지 않는다. 여기서는 알파가 0..255로 훑고 지나가며 겹치므로
    합성 산술과 양자화가 조금만 달라도 값이 갈린다(라인아트의 안티에일리어싱
    가장자리가 겹치는 상황의 축소판이다).
    """
    grad = np.tile(np.linspace(0, 255, 40, dtype=np.uint8), (30, 1))
    p = tmp_path / "alpha_overlap.psd"
    write_psd(p, [
        make_image("top", 210, 15, 10, 40, 30, alpha=grad[:, ::-1].copy()),
        make_image("bottom", 90, 5, 5, 40, 30, alpha=grad),
    ])
    return str(p)


@pytest.fixture
def clip_layer_psd(tmp_path):
    """
    그룹 안에서 'shade'가 'line'에 클리핑된 문서. 병합 대상은 line / line2 둘뿐이다.

    실제 납품 PSD에서 압도적으로 흔한 모양이다 — 병합 4건에 걸린 가드 316건 중
    309건이 이 'base 레이어에 클리핑 레이어가 붙어 있음'이었다. merge_rgba는
    layer_filter로 병합 대상과 조상만 통과시키므로 shade는 애초에 합성에 끼지
    못한다. 그런데도 빠른 경로를 막으면 아무 이득도 못 본다.
    """
    grad = np.tile(np.linspace(0, 255, 24, dtype=np.uint8), (20, 1))
    p = tmp_path / "clip.psd"
    write_psd(p, [
        nested_layers.Group(name="ART", layers=[
            make_image("line2", 30, 12, 8, 24, 20, alpha=grad[:, ::-1].copy()),
            make_image("shade", 180, 4, 4, 24, 20),
            make_image("line", 120, 4, 4, 24, 20, alpha=grad),
        ]),
    ], clipping=("shade",))
    return str(p)


@pytest.fixture
def masked_clip_psd(tmp_path):
    """
    클리핑이 걸린 두 모양을 **마스크와 함께** 든 문서. 'shade'가 'base'에 클리핑된다.

    clip_layer_psd로는 이것을 못 한다 — 그쪽은 마스크가 없다. extract_rgba는
    마스크가 있을 때만 값싼 경로를 부르므로, 마스크 없는 레이어로 "값싼 경로가
    거부한다"를 확인하면 거부 이유가 클리핑이 아니라 '마스크 없음'이라서 테스트가
    공허해진다. 그리고 clip_layer_psd에 마스크를 붙일 수도 없다 — 그 픽스처는
    _plain / merge_rgba 쪽에서 '마스크 없는 클리핑 base'를 재는 데 쓰이고 있다.

    한 장으로 두 가지를 덮는다:
      shade  clipping=True        — composite가 본 패스에서 통째로 건너뛴다
      base   has_clip_layers=True — composite가 shade를 이 위에 합성해 준다
    """
    apply_pytoshop_patches()
    psd = nested_layers.nested_layers_to_psd([
        nested_layers.Group(name="ART", layers=[
            make_image("shade", 180, 4, 4, 24, 20),
            make_image("base", 120, 4, 4, 24, 20),
        ]),
    ], color_mode=enums.ColorMode.rgb, size=(CANVAS_W, CANVAS_H))
    for record in psd.layer_and_mask_info.layer_info.layer_records:
        if record.name == "shade":
            record.clipping = True

    grad = np.tile(np.linspace(0, 255, 24, dtype=np.uint8), (20, 1))
    attach_mask(psd, "shade", grad, left=4, top=4, default_color=0)
    attach_mask(psd, "base", grad, left=4, top=4, default_color=0)

    path = tmp_path / "masked_clip.psd"
    with open(path, "wb") as f:
        psd.write(f)
    return str(path)


@pytest.fixture
def hidden_group_psd(tmp_path):
    """
    숨겨진 그룹(HIDDEN, pass-through) 안에 보이는 NORMAL 그룹, 그 안에 'line'.

    실제 납품 파일(HotelINTLobbyBarMMESS002의 CHAIR06)의 모양이다. 숨겨진 조상
    때문에 안쪽 그룹의 bbox가 (0,0,0,0)이 되고, 그 그룹이 pass-through가 아니면
    psd.composite가 뷰포트를 그 빈 bbox와 교차시켜 내용을 통째로 떨어뜨린다.
    """
    p = tmp_path / "hidden_group.psd"
    write_psd(p, [
        nested_layers.Group(name="HIDDEN", visible=False, layers=[
            nested_layers.Group(name="inner", blend_mode=enums.BlendMode.normal, layers=[
                make_image("line", 40, 34, 4, 20, 16),
            ]),
        ]),
        make_image("line", 90, 4, 4, 20, 16),
    ])
    return str(p)


#: 30,000px을 넘는 PSB 픽스처의 캔버스. 폭만 넘기고 높이는 낮게 잡아, 한계를
#: 넘는 좌표를 실제로 쓰면서도 테스트가 몇 MB / 몇 초 안에 끝나게 한다.
WIDE_W, WIDE_H = 32510, 300


@pytest.fixture
def wide_psb(tmp_path):
    """
    폭이 PSD 한계(30,000)를 넘는 PSB. 'line far'는 통째로 30,000 뒤에 있다.

    한계를 넘긴 뒤로도 좌표와 픽셀이 살아남는지 보려면 그 지점 **너머에** 그림이
    있어야 한다. 캔버스만 크고 내용이 전부 앞쪽에 있으면, 좌표를 32비트로 잘라먹는
    종류의 버그가 아무 흔적도 남기지 않고 지나간다.

    납품 폴더에는 이런 파일이 없다 — PSB 31장의 축을 전부 재보니 가장 큰 것이
    16558x10148이었다. 그래도 픽스처로 두는 이유는, 산출물이 원본 확장자를 물려받는
    이상 언젠가 들어올 수 있는 모양이고, 그때 무엇이 되고 무엇이 안 되는지를
    (test_render.py의 psd-tools 상한 테스트) 코드로 남겨두기 위해서다.
    """
    p = tmp_path / "wide.psb"
    write_psd(p, [
        nested_layers.Group(name="*ART", layers=[
            make_image("line far", 200, 30010, 40, 2500, 100),
            make_image("line", 50, 100, 20, 5000, 200),
        ]),
    ], width=WIDE_W, height=WIDE_H, version=enums.Version.psb)
    return str(p)


@pytest.fixture
def off_canvas_psd(tmp_path):
    """
    레이어 bbox가 캔버스 밖으로 나갔지만 합집합은 30,000 아래인 문서 — 즉 **자르면
    안 되는** 쪽이다.

    실제 납품 PSD에서 예외가 아니라 다수다: 기준선 25장 195엔트리 중 37엔트리(19%)가
    캔버스 밖으로 나가 있고, 그중 26개가 병합이며, 전부 30,000 근처에도 못 간다
    (가장 큰 캔버스가 ~10,000px). 이것들이 지금 그대로 잘 나가고 있으므로 좌표가
    한 픽셀이라도 움직이면 회귀다.

    알파를 그라데이션으로 둔 것은 의도적이다 — 전부 255면 합성 산술이 어긋나도
    결과가 같아 보인다.
    """
    grad = np.tile(np.linspace(0, 255, 40, dtype=np.uint8), (30, 1))
    p = tmp_path / "off_canvas.psd"
    write_psd(p, [
        make_image("outside", 30, -200, 10, 40, 30, alpha=grad),
        make_image("spills right", 210, CANVAS_W - 15, 8, 40, 30,
                   alpha=grad[:, ::-1].copy()),
        make_image("spills left", 90, -12, -9, 40, 30, alpha=grad),
    ])
    return str(p)


@pytest.fixture
def oversize_union_psd(tmp_path):
    """
    합집합이 30,000을 넘는 문서 — 즉 자르기가 실제로 걸리는 쪽이다.

    'far right'를 x=30500에 두어 합집합 폭을 30,550으로 벌린다. 픽셀은 40x30짜리
    세 장뿐이라 진짜 30,000px 배열을 만들지 않고도 진짜 임계값을 지나간다
    (상수를 monkeypatch로 낮추면 임계값 자체가 맞는지는 확인하지 못한다).

    자른 뒤 남는 모양이 세 갈래를 한꺼번에 덮는다: 통째로 밖이라 빠지는 것
    ('far right'), 오른쪽이 잘리는 것('spills right'), 왼쪽/위가 잘리는 것
    ('spills left').
    """
    grad = np.tile(np.linspace(0, 255, 40, dtype=np.uint8), (30, 1))
    p = tmp_path / "oversize_union.psd"
    write_psd(p, [
        make_image("far right", 30, 30500, 10, 40, 30, alpha=grad),
        make_image("spills right", 210, 40, 8, 40, 30, alpha=grad[:, ::-1].copy()),
        make_image("spills left", 90, -10, -6, 40, 30, alpha=grad),
    ])
    return str(p)


@pytest.fixture
def all_outside_union_psd(tmp_path):
    """
    두 레이어가 전부 캔버스 왼쪽 밖에 있고, 그 합집합만 30,000을 넘는 문서.

    자르기가 걸리는데(합집합 30,940) 자르고 나면 아무것도 남지 않는 유일한 모양이다.
    한쪽만 밖으로 나가서는 이 상태를 만들 수 없다 — 캔버스와 겹치는 구간이 남기
    때문이다.
    """
    grad = np.tile(np.linspace(0, 255, 40, dtype=np.uint8), (30, 1))
    p = tmp_path / "all_outside.psd"
    write_psd(p, [
        make_image("way left", 30, -31000, 10, 40, 30, alpha=grad),
        make_image("near left", 90, -100, 10, 40, 30, alpha=grad),
    ])
    return str(p)


@pytest.fixture
def fixture_psd16(tmp_path):
    """16비트 RGB PSD. 8비트와 같은 모양이되 채널만 uint16이다."""
    apply_pytoshop_patches()
    layers = [nested_layers.Group(name="*ART", layers=[
        make_image16("line", 3000, 0, 0, 16, 12),
        make_image16("fill", 30000, 0, 0, 32, 24),
    ])]
    psd = nested_layers.nested_layers_to_psd(
        layers, color_mode=enums.ColorMode.rgb,
        depth=enums.ColorDepth.depth16, size=(CANVAS_W, CANVAS_H),
    )
    path = tmp_path / "depth16.psd"
    with open(path, "wb") as f:
        psd.write(f)
    return str(path)


@pytest.fixture
def masked_psd(tmp_path):
    """
    값싼 마스크 경로가 psd-tools와 같은 픽셀을 내는지 겨루는 픽스처.

    네 장은 각각 실측에서 어긋난 원인을 하나씩 짚는다:
      plain_mask         마스크 bbox == 레이어 bbox, 배경 0 — 가장 쉬운 경우
      bg255_mask         배경 255 + 마스크 bbox < 레이어 bbox — 실납품에서 어긋난 조합
      dense_mask         user_mask_density — _get_mask가 shape에 거는 항
      half_opacity_mask  opacity != 255 — composite는 걸고 topil()은 안 건다
    """
    layers = [
        make_image("plain_mask", 200, 0, 0, 32, 24),
        make_image("bg255_mask", 180, 0, 0, 32, 24),
        make_image("dense_mask", 160, 0, 0, 32, 24),
        make_image("half_opacity_mask", 140, 0, 0, 32, 24),
    ]
    for lyr in layers:
        lyr.opacity = 128 if lyr.name == "half_opacity_mask" else 255
    apply_pytoshop_patches()
    psd = nested_layers.nested_layers_to_psd(
        layers, color_mode=enums.ColorMode.rgb, size=(CANVAS_W, CANVAS_H))

    gradient = np.tile(np.linspace(0, 255, 32, dtype=np.uint8), (24, 1))
    attach_mask(psd, "plain_mask", gradient, left=0, top=0, default_color=0)
    # 마스크가 레이어보다 좁고 배경이 255 — 덮이지 않은 오른쪽 절반이 불투명해진다.
    attach_mask(psd, "bg255_mask", gradient[:, :16], left=0, top=0, default_color=255)
    attach_mask(psd, "dense_mask", gradient, left=0, top=0, default_color=0,
                user_mask_density=128)
    attach_mask(psd, "half_opacity_mask", gradient, left=0, top=0, default_color=0)

    path = tmp_path / "masked.psd"
    with open(path, "wb") as f:
        psd.write(f)
    return str(path)


@pytest.fixture
def blend_group_psd(tmp_path):
    """
    그룹 안에서 blend가 재현되는지 가르는 픽스처.

    값을 고른 이유가 전부다. base 64 위에 shade 192를 multiply로 얹으면
    겹치는 자리가 64*192/255 = 48이 되고, 블렌드를 버리고 알파 오버로 겹치면
    192가 된다 — **차이가 144**라 테스트가 실수를 놓칠 수 없다.

    blend_mode_psd로는 이것을 못 한다. 그쪽은 그룹이 없고, base가 흰색(255)이라
    255*64/255 = 64로 곱연산과 알파 오버의 결과가 같다.
    """
    p = tmp_path / "blend_group.psd"
    write_psd(p, [
        nested_layers.Group(name="BLEND", layers=[
            make_image("shade", 192, 0, 0, 16, 16, blend=enums.BlendMode.multiply),
            make_image("base", 64, 0, 0, 32, 32),
        ]),
    ], width=32, height=32)
    return str(p)


#: masked_group_psd/masked_leaf_group_psd/masked_clip_multiply_psd가 공유하는 잎 크기.
_MG_W, _MG_H = 24, 20


@pytest.fixture
def masked_group_psd(tmp_path):
    """
    그룹 자신에 마스크·불투명도가 걸린 문서 — 최상위(OUTER)와 중첩(INNER) 두 자리
    모두에서.

    _group_rgba_scaled는 한동안 그룹 자신의 마스크를 어디서도 읽지 않았고(값은
    불투명도만, 그것도 draw()의 for-루프 안에서 **자식으로 방문될 때만** 곱했다),
    최상위 그룹은 어느 부모의 for-루프에도 안 걸리므로 자기 불투명도조차 반영되지
    않았다. 실측(2026-08-05): 이 픽스처에서 옛 코드는 알파 최대차 180이었다.

    OUTER·INNER 둘 다 blend_mode를 명시적으로 normal로 둔다 — pytoshop Group의
    기본값은 pass_through라, 그룹 자신에 마스크·불투명도(<255)가 걸린 채로
    pass_through를 남겨두면 psd-tools가 `_apply_source` 대신
    `_apply_passthrough_source`(부분 커버리지를 "color_support"로 섞는 별도 식)를
    타 이 픽스처가 재려는 것과는 다른, 별개의(문서화되고 이번 라운드에서 다루지
    않는 — pass-through 하위그룹의 blend) 오차를 보탠다.

    마스크는 OUTER·INNER의 bbox와 정확히 같은 크기·위치로 붙인다 — 패딩·
    background_color 조합은 masked_psd가 이미 재고 있으므로 여기서는 "그룹 자신의
    마스크가 아예 안 걸린다"는 것 하나만 가른다.
    """
    apply_pytoshop_patches()
    psd = nested_layers.nested_layers_to_psd([
        nested_layers.Group(name="OUTER", opacity=200,
                            blend_mode=enums.BlendMode.normal, layers=[
            nested_layers.Group(name="INNER", opacity=180,
                                blend_mode=enums.BlendMode.normal, layers=[
                make_image("base", 90, 4, 4, _MG_W, _MG_H),
            ]),
        ]),
    ], color_mode=enums.ColorMode.rgb, size=(CANVAS_W, CANVAS_H))
    grad = np.tile(np.linspace(0, 255, _MG_W, dtype=np.uint8), (_MG_H, 1))
    attach_mask(psd, "OUTER", grad, left=4, top=4, default_color=0)
    attach_mask(psd, "INNER", grad, left=4, top=4, default_color=0)
    path = tmp_path / "masked_group.psd"
    with open(path, "wb") as f:
        psd.write(f)
    return str(path)


@pytest.fixture
def masked_leaf_group_psd(tmp_path):
    """
    마스크 달린 잎이 그룹 안에 있고, 그 잎 자신의 불투명도도 128인 문서(클리핑 없음).

    extract_rgba는 마스크 달린 잎의 불투명도·fill 불투명도를 이미 반영해 돌려준다
    (_extract_rgba_masked 또는 layer.composite 경유 — 둘 다). draw()가 그 위에
    own_alpha_factor를 무조건 또 곱하면 128/255가 아니라 (128/255)^2이 되어버린다
    (실측: 이 픽스처에서 옛 코드는 알파 최대차 64 — 128 대신 64 근처가 나왔다).

    클리핑이 없는 것이 요점이다 — 클리핑까지 낀 이중 적용은
    masked_clip_multiply_psd가 따로 잰다.
    """
    leaf = make_image("masked_leaf", 200, 4, 4, _MG_W, _MG_H)
    leaf.opacity = 128
    apply_pytoshop_patches()
    psd = nested_layers.nested_layers_to_psd(
        [nested_layers.Group(name="G", blend_mode=enums.BlendMode.normal, layers=[leaf])],
        color_mode=enums.ColorMode.rgb, size=(CANVAS_W, CANVAS_H))
    grad = np.tile(np.linspace(0, 255, _MG_W, dtype=np.uint8), (_MG_H, 1))
    attach_mask(psd, "masked_leaf", grad, left=4, top=4, default_color=0)
    path = tmp_path / "masked_leaf_group.psd"
    with open(path, "wb") as f:
        psd.write(f)
    return str(path)


@pytest.fixture
def masked_clip_multiply_psd(tmp_path):
    """
    마스크 달린 베이스에 **곱연산** 클리핑 레이어가 붙은 문서.

    masked_clip_psd로는 이 이중 적용을 못 잡는다 — 그쪽 클리핑 레이어(shade)가
    normal 블렌드에 완전 불투명이라, 한 번 덮으나 두 번 덮으나 결과가 같다(완전
    불투명한 normal 오버레이는 몇 번을 다시 그려도 멱등이다). 곱연산은 멱등이 아니다
    — 64/255를 두 번 곱하면 값이 계속 준다.

    extract_rgba는 클리핑 있는 마스크 레이어를 항상 layer.composite()로 떨어뜨려
    (has_clip_layers 가드) 클리핑까지 이미 합성해 돌려준다. draw()가 클리핑 루프를
    또 태우면 곱연산이 두 번 걸린다: 200(base) -> 50(1차, 200*64/255) -> 12(2차,
    50*64/255). 실측: 이 픽스처에서 옛 코드는 시각적 RGB 최대차 38(정확 50 vs
    옛 코드 12), 고친 코드는 1(반올림 수준).
    """
    apply_pytoshop_patches()
    psd = nested_layers.nested_layers_to_psd([
        nested_layers.Group(name="G", blend_mode=enums.BlendMode.normal, layers=[
            make_image("clip_shade", 64, 4, 4, _MG_W, _MG_H, blend=enums.BlendMode.multiply),
            make_image("masked_base", 200, 4, 4, _MG_W, _MG_H),
        ]),
    ], color_mode=enums.ColorMode.rgb, size=(CANVAS_W, CANVAS_H))
    for record in psd.layer_and_mask_info.layer_info.layer_records:
        if record.name == "clip_shade":
            record.clipping = True
    grad = np.tile(np.linspace(0, 255, _MG_W, dtype=np.uint8), (_MG_H, 1))
    attach_mask(psd, "masked_base", grad, left=4, top=4, default_color=0)
    path = tmp_path / "masked_clip_multiply.psd"
    with open(path, "wb") as f:
        psd.write(f)
    return str(path)


@pytest.fixture
def sibling_clip_group_psd(tmp_path):
    """
    썸네일 대상 그룹 **자신**에게, 그 그룹의 부모 컨테이너 안에서 클리핑 레이어가
    붙은 문서 — 실납품에서 실제로 걸린 모양이다('LINES' 그룹에 형제 'Layer 621'이
    클리핑되어 있었다, HH0306 02_Color).

    render_thumbnails가 쓰는 layer_filter(조상+자손만 통과)는 GROUP의 **부모**에
    속한 이 클리핑 레이어를 걸러 no-op으로 만든다(psd-tools의
    Compositor._apply_clip_layers도 같은 필터를 물려받는다) — 그런데
    `_group_rgba_scaled`가 최상위 그룹을 draw()의 일반 자식 루프에 태워 자기
    clip_layers를 무조건 처리하면, 필터가 없는 이 경로가 그 클리핑을 그대로
    그려버린다. 실측: 이 회귀로 평범한 그룹 108개 기준 최악 premultiplied 차이가
    10.0에서 103.7로 뛰었다. clip_multiply는 곱연산이라 걸렸을 때와 안 걸렸을 때의
    차이가 크다 — masked_clip_multiply_psd와 같은 이유로 진하게 고른 값이다.

    GROUP 자신에게 자손 쪽 클리핑도 하나 둔다("inner_base"에 "inner_clip") — 그건
    GROUP의 자손이라 필터 안에 있으므로 그대로 반영돼야 한다. 이 픽스처는 "그룹
    바깥의 클리핑은 무시하되 안쪽 클리핑은 반영한다"를 한 번에 가른다.
    """
    apply_pytoshop_patches()
    psd = nested_layers.nested_layers_to_psd([
        nested_layers.Group(name="TV", layers=[
            make_image("sibling_clip", 64, 0, 0, 32, 32, blend=enums.BlendMode.multiply),
            nested_layers.Group(name="LINES", blend_mode=enums.BlendMode.normal, layers=[
                make_image("inner_clip", 64, 0, 0, 32, 32, blend=enums.BlendMode.multiply),
                make_image("inner_base", 200, 0, 0, 32, 32),
            ]),
        ]),
    ], color_mode=enums.ColorMode.rgb, size=(CANVAS_W, CANVAS_H))
    for record in psd.layer_and_mask_info.layer_info.layer_records:
        if record.name in ("sibling_clip", "inner_clip"):
            record.clipping = True
    path = tmp_path / "sibling_clip_group.psd"
    with open(path, "wb") as f:
        psd.write(f)
    return str(path)


@pytest.fixture
def passthrough_subgroup_psd(tmp_path):
    """
    pass-through 하위그룹 안의 곱연산 레이어가 **부모의 형제**와 블렌드돼야 한다.

    OUTER(정상 그룹) 안에 PT(pass-through) 하위그룹과 형제 base가 있다. PT 안의
    'mult'가 곱연산인데, pass-through는 격리하지 않으므로 mult는 자기만의 빈
    캔버스가 아니라 base 위에서 곱해져야 한다: base 64 위에 mult 192를 곱하면
    64*192/255 = 48 근처가 나온다. 격리해서 그리면(예전 방식) mult가 흰 배경
    위에서 곱해져 그대로 192가 남는다 — **차이가 144**라 판별력이 crisp하다.

    review 실측(2026-08-05)과 같은 모양이다: exact 50 vs 격리 64.
    """
    p = tmp_path / "passthrough_subgroup.psd"
    write_psd(p, [
        nested_layers.Group(name="OUTER", blend_mode=enums.BlendMode.normal, layers=[
            nested_layers.Group(name="PT", blend_mode=enums.BlendMode.pass_through, layers=[
                make_image("mult", 192, 0, 0, 32, 32, blend=enums.BlendMode.multiply),
            ]),
            make_image("base", 64, 0, 0, 32, 32),
        ]),
    ], width=32, height=32)
    return str(p)
