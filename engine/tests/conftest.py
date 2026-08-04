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


def write_psd(path, layers_top_first, width=CANVAS_W, height=CANVAS_H, clipping=()):
    """
    clipping: 클리핑 플래그를 켤 레이어 이름들. nested_layers.Image에는 그 인자가
    없어서 변환이 끝난 레코드에 직접 세운다.
    """
    apply_pytoshop_patches()
    psd = nested_layers.nested_layers_to_psd(
        layers_top_first, color_mode=enums.ColorMode.rgb, size=(width, height)
    )
    if clipping:
        for record in psd.layer_and_mask_info.layer_info.layer_records:
            if record.name in clipping:
                record.clipping = True
    with open(path, "wb") as f:
        psd.write(f)
    return str(path)


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
