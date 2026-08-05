"""픽셀 추출/병합/썸네일/미리보기.

병합(merge_rgba)은 psd-tools 합성을 그대로 쓴다 — 원본 스택 안에서 블렌드/클리핑을
그대로 살려야 하는 연산이기 때문이다.

미리보기(render_preview)는 다르다. export.py가 각 레이어를 `opacity=255,
blend_mode=normal`로 기록하므로 **내보낸 PSD는 블렌드·클리핑·불투명도가 제거된
평평한 스택**이고, 그 파일의 내장 미리보기도 alpha_composite 누적으로 만들어진다.
따라서 미리보기가 재현해야 할 대상은 원본 합성이 아니라 그 평평한 알파 합성이다.
"""
import os
import re
from collections import OrderedDict

import numpy as np
from PIL import Image

_HEX_COLOR = re.compile(r"#[0-9a-fA-F]{6}\Z")

#: 병합 빠른 경로를 쓸지. 끄면 예전처럼 psd.composite 한 번으로 간다.
#:
#: 끄는 길을 남겨 두는 이유는 두 가지다. 하나는 scripts/export-baseline.py로
#: "고치기 전 결과"를 더 떠야 할 때(PSD_ENGINE_FAST_MERGE=0), 다른 하나는 빠른
#: 경로가 어떤 파일에서 어긋났을 때 코드를 되돌리지 않고 앱만 되돌리기 위해서다.
FAST_MERGE = os.environ.get("PSD_ENGINE_FAST_MERGE", "1") != "0"

#: 병합 뷰포트를 이 크기의 정사각 타일로 나눠 합성한다. 뷰포트가 타일 하나에
#: 들어가면 호출은 한 번뿐이고, 그때는 예전과 완전히 같은 호출이 된다.
#:
#: U자 곡선이다. 타일을 줄이면 합성이 줄지만 psd-tools가 디코딩을 캐싱하지 않아
#: (numpy()가 매번 다시 푼다) 여러 타일에 걸친 레이어를 반복해서 푼다. 실측
#: (022bSlime의 92장/54.4Mpx 병합, 결과는 전 크기에서 픽셀 동일):
#:
#:     타일   256 512 768 1024 1536 2048 4096 8192
#:     시간   385 148 133  117  116  119  166  220 (초)
#:     디코딩 49.9 14.2 8.3  4.9  2.7  1.7  0.6  0.4 (Gpx)
#:
#: 1024~2048이 잡음 안에서 평평하다. 그중 2048을 고른 것은 시간이 1536과 3%
#: 차이인데 디코딩 작업이 1/3이어서다 — 캔버스가 더 크거나 메모리가 빠듯할 때
#: 그쪽이 덜 위험하다.
MERGE_TILE_SIZE = 2048

#: 세션당 미리보기 타일 캐시 상한(바이트). 640MB급 PSD를 최대 2세션 열어두는
#: 상황이라 무제한 캐싱은 곧 메모리 압박이 된다. 초과하면 LRU로 버린다.
PREVIEW_TILE_BUDGET_BYTES = 192 * 1024 * 1024

#: 예전 경로(psd.composite 한 번)를 포기하고 축소 합성기로 넘어가는 지점.
#: 단위는 **Mpx·leaf** — 그룹 bbox 넓이 × 보이는 잎 수다.
#:
#: **넓이가 아니라 비용 모델인 이유.** 넓이는 시간을 예측하지 못한다 — 실측에서
#: 13.4Mpx가 29.4초인데 더 큰 38.3Mpx는 27.8초였다. 시간을 정하는 것은 잎의 수다.
#: 예전 경로는 잎마다 그룹 bbox 크기의 float32 버퍼를 훑으므로 비용이 넓이 × 잎
#: 수에 붙는다. 0fbbeef의 8Mpx는 메모리 예산에서 나온 값이라 성질이 다르다.
#:
#: 시간 예산 5초에서 역산한다. 썸네일은 보이는 행만 청크로 만들고 엔진은 stdin을
#: 순서대로 처리하므로, 썸네일 한 장이 도는 동안 사람이 누른 것이 전부 뒤에 선다.
#:
#: 실측 처리율(HH0306 02_Color, 2026-08-05): 그룹당 별도 프로세스, 48px 한 장.
#:
#:     Hallway    15.9Mpx x   5 =   80 Mpx·leaf    12.0초   6.6 Mpx·leaf/s
#:     Group 5     2.3Mpx x 165 =  375 Mpx·leaf    30.0초  12.5 Mpx·leaf/s
#:     WARDROBE    6.9Mpx x  64 =  440 Mpx·leaf    42.0초  10.5 Mpx·leaf/s
#:     WALLPAPER  97.9Mpx x   6 =  587 Mpx·leaf   105.3초   5.6 Mpx·leaf/s
#:     LT         24.4Mpx x  64 = 1562 Mpx·leaf   149.0초  10.5 Mpx·leaf/s
#:     BG         47.4Mpx x 140 = 6630 Mpx·leaf  1004.9초   6.6 Mpx·leaf/s
#:
#: 비용이 83배 퍼진 구간에서 처리율은 5.6~12.5로 2.2배 안에 든다. 비용 모델이
#: 시간을 정확히 맞히지는 않지만 자릿수를 맞히고, 임계값에 필요한 것은 그것이다.
#:
#: **가장 느린 점으로 역산한다.** 예산은 시간의 상한이므로 평균으로 잡으면 절반이
#: 예산을 넘는다. 5.6 × 5초 = 28. 잎이 적고 큰 쪽(WALLPAPER: 97.9Mpx에 6장)이 가장
#: 느린데, 그쪽이 잎마다 그룹 크기 버퍼를 훑는 비용을 가장 크게 치르기 때문이다.
#:
#: 값이 작을수록 축소 합성기로 더 많이 보낸다. 틀리는 방향은 그쪽이 안전하다 —
#: 축소 합성기는 어떤 그룹이든 빠르고, 예전 경로는 큰 그룹에서 분 단위로 간다.
THUMBNAIL_EXACT_BUDGET = 28   # Mpx·leaf

#: 축소 합성기가 쓰는 중간 캔버스의 상한(픽셀 수).
#:
#: **처음 적어 둔 "다섯 장, 픽셀당 80B"는 재귀를 세지 않은 값이라 너무 작다.**
#: `draw`는 중첩 그룹마다 자기 몫의 (색+알파) 캔버스를 스택에 쌓아 둔 채 재귀하고
#: (그룹 하나가 부모에 얹히기 전까지 자식 결과가 살아 있어야 한다), 잎을 그리는
#: 동안에는 거기에 잎용 (색+알파), 클리핑이 있으면 클리핑용 (색+알파), 그리고
#: `_over`가 만드는 몇 개의 임시 배열까지 겹친다. 대략 픽셀당 16B짜리 캔버스가
#: 중첩 깊이만큼 쌓이고 거기에 그 순간의 작업분(수십~100B대)이 더해지므로, 깊이
#: 3에서 대략 픽셀당 200B, 8Mpx면 약 1.6GB 안팎이다(정확한 재귀 깊이·클리핑 유무에
#: 따라 흔들리는 어림값이지, 측정해 못박은 숫자는 아니다). 잎은 한 번에 한 장만
#: 살아 있으므로 여기 안 든다.
#:
#: **이 값이 묶는 것은 메모리이고, 화질은 그 부산물로 따라온다.** 원본 bbox가 이
#: 예산보다 작은 그룹은 배율이 1.0이 되어 전해상도에서 합성된다 — 그때 이 경로는
#: "잎을 그룹 bbox로 부풀리지 않는 _merge_rgba_fast"와 같은 일을 한다.
THUMBNAIL_SUPERSAMPLE_PX = 8 * 1024 * 1024

#: PSD(version 1)가 한 축에 담을 수 있는 최대 크기. pytoshop core.py의
#: max_size_mapping, psd-tools api/utils.py의 MAX_DIMENSION_PSD와 같은 값이다.
PSD_MAX_DIMENSION = 30000


def parse_line_color(value):
    """
    프리셋의 lineColor("#RRGGBB")를 (r, g, b)로. None이면 원본 색을 그대로 둔다.

    형식이 어긋나면 조용히 무시하지 않고 예외를 낸다 — 오타 하나로 색 통일이
    적용되지 않은 채 수백 장이 배치 처리되는 편이 훨씬 나쁘다.
    """
    if value is None:
        return None
    s = str(value).strip()
    if not _HEX_COLOR.match(s):
        raise ValueError(f"invalid line color: {value!r} (expected #RRGGBB)")
    return (int(s[1:3], 16), int(s[3:5], 16), int(s[5:7], 16))


def apply_line_color(rgba, rgb):
    """
    RGB만 단색으로 덮고 알파는 건드리지 않는다. 라인의 안티에일리어싱은 전부
    알파 채널에 들어있으므로 이렇게 해야 가장자리 부드러움이 보존된다.

    투명한 픽셀까지 같은 RGB로 채우는 것은 의도적이다 — 알파 0인 자리에 남아
    있던 원본 색이 나중에 리샘플링될 때 가장자리로 번지지 않는다.
    """
    if rgb is None:
        return rgba
    out = rgba.copy()
    out[..., 0], out[..., 1], out[..., 2] = rgb
    return out


def _mask_fast_ok(layer):
    """
    값싼 마스크 경로가 psd.composite와 같은 그림을 내는 것이 보장되는 형태인가.

    _plain과 같은 규율이다 — 하나라도 걸리면 예전 경로로 떨어진다. 빠르게 하려다
    그림을 바꾸는 것보다 느린 편이 낫다. 판단 근거는 Compositor.apply가 실제로
    읽는 값들이고, 그쪽이 바뀌면 여기도 같이 봐야 한다.
    """
    from psd_tools.composite import utils
    from psd_tools.constants import BlendMode, ColorMode, Tag

    # _get_mask(621행)는 마스크가 없거나 꺼져 있으면 아무것도 걸지 않는다. 값싼
    # 경로는 반대로 무조건 거는 식이라, 그 두 경우를 여기서 빼야 꺼진 마스크를
    # 실수로 적용하지 않는다. extract_rgba는 어차피 이 조건에서만 부르지만,
    # 이 함수만 직접 부르는 호출자(테스트·계측)가 조용히 틀리지 않게 막아 둔다.
    if layer.mask is None or layer.mask.disabled:
        return False
    # composite()는 layer_filter를 안 주면 Layer.is_visible로 채운다(composite.py
    # 206행). 그래서 숨은 레이어는 apply가 첫 줄에서 되돌아가고(321행) 결과가
    # 손대지 않은 배경, 즉 전부 [255,255,255,0]이 된다 — 자기 visible이 켜져
    # 있어도 조상 그룹이 꺼져 있으면 그렇다. 값싼 경로는 가시성을 모르므로 실제
    # 픽셀을 그려 낸다. 실납품에서 이것 하나가 어긋난 유일한 원인이었다
    # ('Shelf light 2', visible=True인데 부모 'light wardrobe'가 꺼져 있다.
    # 필터를 끄고 대조하면 최대차 0으로 같다).
    if not layer.is_visible():
        return False
    # 클리핑 레이어는 composite가 본 패스에서 통째로 건너뛴다(composite.py 329행,
    # `if not clip_compositing and layer.clipping: return` — Layer.composite는
    # clip_compositing을 넘기지 않는다). 그래서 결과가 손대지 않은 배경이 되고,
    # 값싼 경로가 그것을 그리면 없던 그림이 생긴다. _plain(373~388행)이 병합 쪽에서
    # 이미 같은 이유로 막고 있고, 같은 설명을 적어 두었다.
    if layer.clipping:
        return False
    # 반대쪽. 이 레이어에 클리핑 레이어가 **붙어 있으면** composite가 그것들을 이
    # 레이어 색 위에 합성해 준다(345~346행의 _apply_clip_layers). 값싼 경로는 자기
    # 색만 내므로 그 그림이 빠진다.
    #
    # _plain은 이것을 일부러 허용하지만(377~386행) 그 근거는 layer_filter에 달려
    # 있다 — merge_rgba는 병합 대상과 조상만 통과시키는 필터를 주므로, 물려받은
    # 하위 Compositor가 아무것도 적용하지 못한다. **extract_rgba는 필터를 주지
    # 않는다.** 그러면 필터가 Layer.is_visible로 채워져(206행) 보이는 클리핑 자식이
    # 전부 실제로 합성된다. 그래서 _plain의 면제는 여기로 넘어오지 않는다.
    if layer.has_clip_layers():
        return False
    # 마무리 양자화가 "RGBA"로 고정이다. 회색조·CMYK 문서는 채널 수가 달라 같은
    # 그림을 만들 수 없으므로 예전 경로에 둔다(_fast_mergeable도 같은 이유로 막는다).
    if layer._psd.color_mode != ColorMode.RGB:
        return False
    # 효과·획·칠·벡터마스크는 composite가 그린다. 값싼 경로는 그리지 않는다.
    if any(getattr(e, "enabled", True) for e in layer.effects):
        return False
    if layer.stroke is not None and layer.stroke.enabled:
        return False
    if utils.has_fill(layer) or layer.has_vector_mask():
        return False
    # 픽셀이 없으면 numpy("color")가 None이고 composite는 다른 것을 그린다.
    if not layer.has_pixels():
        return False
    # 블렌드는 이 함수의 관심사가 아니다 — extract_rgba는 배경 없이 한 장만 뽑고,
    # 투명한 배경 위에서는 어떤 블렌드도 normal과 결과가 같다. 그래도 knockout은
    # 식을 바꾸므로 막는다.
    if layer.blend_mode == BlendMode.PASS_THROUGH:
        return False
    if layer.tagged_blocks.get_data(Tag.KNOCKOUT_SETTING, 0):
        return False
    # real mask(사용자+벡터 결합)는 별도의 배열이다. force=False인 composite가
    # 그쪽을 읽으므로, 있으면 값싼 경로가 다른 마스크를 보게 된다.
    if layer.mask is not None and layer.mask.has_real():
        return False
    return True


def _extract_rgba_masked(layer):
    """
    마스크 달린 레이어를 layer.composite 없이 읽는다. 가드를 못 넘으면 None.

    **왜 있는가.** composite는 psd-tools의 float32 전체 경로다. 실측(2026-08-05,
    HH03_BG-RosieEmporiumINTShop017_CO_v01.psd의 BG 그룹, 잎 140장):

        마스크 없는 잎  ~50 Mpx/s   29.9Mpx 0.52초, 메모리 미미
        마스크 있는 잎   ~4 Mpx/s   39.6Mpx 10.07초, +5.06GB

    잎 139장 중 마스크 달린 2장이 디코딩 시간의 63%와 peak 13.4GB 전부를 만들었다.
    이 함수는 export.py와 verify.py, 미리보기, 썸네일이 함께 쓴다.

    **식은 Compositor.apply를 그대로 줄인 것이다.** 배경이 color=1.0, alpha=0.0이라
    alpha_b가 0이고, 그때 _apply_source는 color_t = alpha*color 로 줄어든다.
    divide가 0/0을 1.0으로 만들기 때문에 알파 0인 자리의 RGB가 흰색이 된다 —
    그것이 배경이 드러난 것이고, 값싼 경로도 같은 값을 내야 한다.

    대수적으로 더 줄이지 않는다. _merge_rgba_fast의 docstring이 이유를 적어 두었다.
    """
    from psd_tools.composite import utils
    from psd_tools.composite.composite import paste
    from psd_tools.constants import Tag

    if not _mask_fast_ok(layer):
        return None

    color = layer.numpy("color")
    if color is None:
        return None
    shape = layer.numpy("shape")
    if shape is None:
        shape = np.ones(color.shape[:2] + (1,), dtype=np.float32)

    # _get_mask(621행)를 그대로 옮긴다. 뷰포트가 레이어 bbox인 경우다.
    mask_arr = layer.numpy("mask", real_mask=False)
    shape_mask = 1.0
    if mask_arr is not None:
        shape_mask = paste(layer.bbox, layer.mask.bbox, mask_arr,
                           layer.mask.background_color / 255.0)
    if layer.mask.parameters:
        density = layer.mask.parameters.user_mask_density
        if density is None:
            density = layer.mask.parameters.vector_mask_density
        if density is None:
            density = 255
        density = float(density) / 255.0
        shape_mask = density * shape_mask + (1 - density)

    # _get_const(675행).
    shape_const = layer.tagged_blocks.get_data(Tag.BLEND_FILL_OPACITY, 255) / 255.0
    opacity_const = layer.opacity / 255.0

    # apply(348~372행). 배경이 비어 있으므로 alpha 계산만 남는다.
    alpha = shape * (shape_mask * opacity_const) * shape_const
    out_color = utils.clip(utils.divide(alpha * color, alpha))

    merged = np.concatenate((out_color, alpha), axis=2)
    return _quantize_like_psd_tools(layer._psd, merged)


def _quantize_like_psd_tools(psd, merged):
    """
    float32 [0,1] 배열을 composite_pil(22행)과 같은 순서로 uint8 RGBA로 만든다.

    절삭이지 반올림이 아니다. 그리고 문서에 ICC 프로파일이 있으면 같은 후처리를
    태운다 — _merge_rgba_fast의 마무리와 같다.
    """
    from psd_tools.api import pil_io
    from psd_tools.constants import Resource

    img = Image.fromarray((255 * merged).astype(np.uint8), "RGBA")
    icc = None
    if Resource.ICC_PROFILE in psd.image_resources:
        icc = psd.image_resources.get_data(Resource.ICC_PROFILE)
    return np.array(pil_io.post_process(img, None, icc).convert("RGBA"))


def extract_rgba(layer):
    if layer.mask is not None and not layer.mask.disabled:
        fast = _extract_rgba_masked(layer)
        if fast is not None:
            return fast
        img = layer.composite(viewport=layer.bbox)
    else:
        img = layer.topil()
    if img is None:
        raise ValueError(f"layer {layer.name!r} has no pixels")
    return np.array(img.convert("RGBA"))


def _wanted_ids(psd, layers):
    wanted = set()
    for layer in layers:
        cur = layer
        while cur is not psd:
            wanted.add(id(cur))
            cur = cur.parent
    return wanted


def _overlaps(bbox, tile):
    return not (bbox[2] <= tile[0] or tile[2] <= bbox[0]
                or bbox[3] <= tile[1] or tile[3] <= bbox[1])


def _ancestors(psd, layer):
    out = []
    cur = layer.parent
    while cur is not None and cur is not psd:
        out.append(cur)
        cur = cur.parent
    return out


def _tileable(psd, layers):
    """
    뷰포트를 잘라 합성해도 되는가.

    psd.composite는 뷰포트에 걸치지 않는 레이어를 건너뛴다(apply의 교집합 검사).
    보통은 그것이 정확히 우리가 원하는 절약이지만, 그림자·글로우·획처럼 레이어
    bbox **밖에** 그려지는 효과가 있으면 얘기가 다르다 — 그 레이어를 건너뛴 타일
    에서는 효과가 통째로 사라져 타일 경계에 자국이 남는다. 그런 문서는 자르지
    않고 예전처럼 한 번에 합성한다.
    """
    for layer in layers:
        for node in [layer] + _ancestors(psd, layer):
            if any(getattr(e, "enabled", True) for e in node.effects):
                return False
            if node.stroke is not None and node.stroke.enabled:
                return False
    return True


def _merge_rgba_tiled(psd, layers, viewport):
    """
    뷰포트를 타일로 나눠 psd.composite를 부르고 이어붙인다.

    타일마다 **그 타일에 걸치는 레이어만** 통과시키는 것이 요점이다. 뷰포트만 잘라
    놓고 필터를 그대로 두면 거의 빨라지지 않는다 — Compositor.apply의 뷰포트 밖
    건너뛰기는 그룹을 면제하기 때문에(`not isinstance(layer, GroupMixin)`), 조상
    그룹 전부가 타일마다 다시 합성된다. 실측에서 타일 크기를 1024~8192로 바꿔도
    시간이 250초에서 평평했던 것이 그 때문이다. layer_filter는 그 검사보다 먼저
    걸리므로, 필터를 좁히면 그 그룹들이 통째로 빠진다.
    """
    left, top, right, bottom = viewport
    out = np.empty((bottom - top, right - left, 4), dtype=np.uint8)
    for y in range(top, bottom, MERGE_TILE_SIZE):
        for x in range(left, right, MERGE_TILE_SIZE):
            tile = (x, y, min(x + MERGE_TILE_SIZE, right), min(y + MERGE_TILE_SIZE, bottom))
            here = [l for l in layers if _overlaps(l.bbox, tile)]
            # here가 비면 wanted도 비어 전부 필터에서 걸린다 — 합성기는 초기
            # 버퍼(흰색/투명)를 그대로 돌려주고, ICC 후처리도 평소대로 걸린다.
            wanted = _wanted_ids(psd, here)
            img = psd.composite(
                viewport=tile,
                force=True,
                color=1.0,
                alpha=0.0,
                layer_filter=lambda l: id(l) in wanted,
            )
            out[y - top:tile[3] - top, x - left:tile[2] - left] = \
                np.array(img.convert("RGBA"))
    return out, left, top


def _composite_order(psd):
    """psd.composite가 레이어를 훑는 순서(문서 아래→위). id(layer) -> 순번."""
    order = {}

    def walk(group):
        for layer in group:
            order[id(layer)] = len(order)
            if layer.is_group():
                walk(layer)

    walk(psd)
    return order


def _plain(layer, allow_passthrough=False):
    """
    psd.composite가 이 레이어에 하는 일 중 빠른 경로가 재현하지 않는 것이 하나라도
    있으면 False. 하나라도 걸리면 예전 경로로 떨어진다 — 빠르게 하려다 그림을
    바꾸는 것보다 느린 편이 낫다.

    판단 근거는 psd_tools/composite/composite.py의 Compositor.apply와 _get_mask /
    _get_const가 실제로 읽는 값들이다. 그쪽이 바뀌면 여기도 같이 봐야 한다.
    """
    from psd_tools.composite import utils
    from psd_tools.constants import BlendMode, Tag

    blend_ok = layer.blend_mode == BlendMode.NORMAL or (
        allow_passthrough and layer.blend_mode == BlendMode.PASS_THROUGH
    )
    if not blend_ok:
        return False
    if layer.opacity != 255:
        return False
    if layer.tagged_blocks.get_data(Tag.BLEND_FILL_OPACITY, 255) != 255:
        return False
    # psd.composite는 본 패스에서 클리핑 레이어를 통째로 건너뛴다(apply의
    # `if not clip_compositing and layer.clipping: return`). 빠른 경로가 그것을
    # 그리면 없던 그림이 생긴다.
    #
    # 반대로 이 레이어에 **붙어 있는** 클리핑 레이어(layer.clip_layers)는 막지
    # 않는다. merge_rgba의 layer_filter가 병합 대상과 조상만 통과시키므로 그것들은
    # 어차피 걸러지고, _apply_clip_layers가 만드는 하위 Compositor도 같은 filter를
    # 물려받아 아무것도 적용하지 못한 채 backdrop 배열을 그대로 돌려준다. 그리고
    # 클리핑 레이어는 정의상 clipping=True라, 만약 그것이 병합 대상이거나 조상이면
    # 바로 위 검사에서 이미 걸린다 — 그래서 통과한 경우에는 no-op이 보장된다.
    #
    # 이 구분이 이득의 대부분이다. 처음에는 has_clip_layers()도 막았는데, 실제
    # 납품 PSD에서 병합 4건에 걸린 가드 316건 중 309건이 그것이어서 빠른 경로를
    # 탄 병합이 하나도 없었다(1.4배에 그쳤다).
    if layer.clipping:
        return False
    if layer.mask is not None and not layer.mask.disabled:
        return False
    if layer.vector_mask is not None and not layer.vector_mask.disabled:
        return False
    if any(getattr(e, "enabled", True) for e in layer.effects):
        return False
    if layer.stroke is not None and layer.stroke.enabled:
        return False
    # merge_rgba는 force=True로 부른다. 그때 psd.composite는 칠(fill) 레이어를
    # 채널 대신 다시 그리고 벡터 마스크에 획을 입힌다.
    if utils.has_fill(layer) or layer.has_vector_mask():
        return False
    return True


def _fast_mergeable(psd, layers):
    """레이어들과 그 조상 그룹이 전부 '평범'하면 빠른 경로를 쓸 수 있다."""
    from psd_tools.constants import ColorMode

    if psd.color_mode != ColorMode.RGB:
        return False
    for layer in layers:
        if layer.is_group() or not _plain(layer):
            return False
        cur = layer.parent
        while cur is not None and cur is not psd:
            # 그룹의 마스크·불투명도는 psd.composite가 자식에 적용한다.
            if not _plain(cur, allow_passthrough=True):
                return False
            cur = cur.parent
    return True


def _merge_rgba_fast(psd, layers, viewport):
    """
    psd.composite와 같은 그림을, 레이어를 뷰포트 크기로 부풀리지 않고 만든다.

    비싼 것은 합성식이 아니라 psd-tools가 레이어마다 하는 paste다 — 0.1Mpx짜리
    트림 한 장도 병합 그룹의 합집합 뷰포트(실측 54Mpx)로 늘린 뒤 float32로 열댓
    번 훑는다. 여기서는 각 레이어의 bbox 안에서만 같은 계산을 한다.

    식은 Compositor._apply_source의 normal 블렌드 경우를 그대로 옮긴 것이다.
    대수적으로 줄이지 않는다 — float32에서 (1-a)*c + a*c 는 c 와 같은 값이
    아니고, 그 마지막 비트가 절삭 경계에 걸리면 픽셀 값이 1 달라진다.
    """
    from psd_tools.api import pil_io
    from psd_tools.composite import utils
    from psd_tools.constants import Resource

    left, top, right, bottom = viewport
    # psd.composite(color=1.0, alpha=0.0)의 시작 상태와 같다.
    color = np.ones((bottom - top, right - left, 3), dtype=np.float32)
    alpha_g = np.zeros((bottom - top, right - left, 1), dtype=np.float32)

    order = _composite_order(psd)
    for layer in sorted(layers, key=lambda l: order[id(l)]):
        bbox = layer.bbox
        if bbox == (0, 0, 0, 0):
            continue
        src = layer.numpy("color")
        if src is None:
            continue
        shape = layer.numpy("shape")
        if shape is None:
            shape = np.ones(src.shape[:2] + (1,), dtype=np.float32)
        h, w = src.shape[:2]
        y0, x0 = bbox[1] - top, bbox[0] - left
        # merge_rgba가 뷰포트를 캔버스로 자른 경우에는 레이어가 뷰포트 밖으로
        # 걸칠 수 있다. 겹치는 부분만 남긴다 — 음수로 슬라이스하면 예외 없이 배열
        # 반대쪽 끝을 집어 엉뚱한 자리에 그린다.
        cy0, cx0 = max(0, -y0), max(0, -x0)
        cy1 = h - max(0, y0 + h - (bottom - top))
        cx1 = w - max(0, x0 + w - (right - left))
        if cy1 <= cy0 or cx1 <= cx0:
            continue
        if (cy0, cx0, cy1, cx1) != (0, 0, h, w):
            src, shape = src[cy0:cy1, cx0:cx1], shape[cy0:cy1, cx0:cx1]
            h, w = src.shape[:2]
            y0, x0 = y0 + cy0, x0 + cx0
        box = (slice(y0, y0 + h), slice(x0, x0 + w))

        alpha_s = shape          # 평범한 레이어는 shape == alpha
        color_b = color[box]
        alpha_b = alpha_g[box]
        alpha_new = utils.union(alpha_b, alpha_s)
        color_t = (alpha_s - alpha_s) * alpha_b * color_b + alpha_s * (
            (1.0 - alpha_b) * src + alpha_b * src
        )
        color[box] = utils.clip(
            utils.divide((1.0 - alpha_s) * alpha_b * color_b + color_t, alpha_new)
        )
        alpha_g[box] = alpha_new

    # 마무리도 composite_pil과 같은 순서로 한다 — 절삭 양자화, 그리고 문서에
    # ICC 프로파일이 있으면 같은 후처리를 태운다.
    merged = np.concatenate((color, alpha_g), axis=2)
    img = Image.fromarray((255 * merged).astype(np.uint8), "RGBA")
    icc = None
    if Resource.ICC_PROFILE in psd.image_resources:
        icc = psd.image_resources.get_data(Resource.ICC_PROFILE)
    img = pil_io.post_process(img, None, icc)
    return np.array(img.convert("RGBA")), left, top


def merge_rgba(psd, layers):
    boxes = [l.bbox for l in layers if l.bbox != (0, 0, 0, 0)]
    if not boxes:
        raise ValueError("merge: all source layers are empty")
    left = min(b[0] for b in boxes)
    top = min(b[1] for b in boxes)
    right = max(b[2] for b in boxes)
    bottom = max(b[3] for b in boxes)
    # 캔버스 밖으로 나간 레이어 bbox는 그대로 둔다. PSD는 그런 bbox를 정상적으로
    # 들고 있고(납품 25장 중 13장이 그렇다), 합집합이 캔버스보다 커지는 것도 정상이다.
    # 잘라내면 산출물 좌표가 원본과 어긋나는데, 그 좌표는 나중에 합성할 때 그대로
    # 맞아야 한다(export_psd_split 참고).
    #
    # 단 합집합이 30,000px를 넘으면 합성 자체를 못 한다 — 캔버스가 11901x7297인
    # 한 장이 32510x9335 뷰포트를 만들어 내보내기가 통째로 죽은 적이 있다. 그때만
    # 마지막 수단으로 캔버스까지 자른다. 캔버스가 이 한계 안에 있는 한 자르고 나면
    # 반드시 통과하고, 버려지는 것은 포토샵에서 어차피 보이지 않는 영역이다.
    if right - left > PSD_MAX_DIMENSION or bottom - top > PSD_MAX_DIMENSION:
        left, top = max(0, left), max(0, top)
        right, bottom = min(psd.width, right), min(psd.height, bottom)
        if right <= left or bottom <= top:
            # 전부 캔버스 밖이면 그릴 것이 없다 — 빈 레이어와 같이 다룬다. 0x0 배열을
            # 돌려주면 export가 그것을 레이어로 기록하려다 훨씬 뒤에서 터진다.
            raise ValueError("merge: all source layers are outside the canvas")
    if FAST_MERGE and _fast_mergeable(psd, layers):
        return _merge_rgba_fast(psd, layers, (left, top, right, bottom))
    wanted = _wanted_ids(psd, layers)
    # 빠른 경로를 못 쓰는 병합(마스크·클리핑·효과가 낀 것)이라도, 뷰포트를 잘라
    # 부르면 부풀림은 줄일 수 있다. 합성은 psd-tools가 그대로 하므로 마스크·
    # 그룹 semantics를 여기서 재현하지 않는다.
    if FAST_MERGE and _tileable(psd, layers):
        return _merge_rgba_tiled(psd, layers, (left, top, right, bottom))
    img = psd.composite(
        viewport=(left, top, right, bottom),
        force=True,
        color=1.0,
        alpha=0.0,
        layer_filter=lambda l: id(l) in wanted,
    )
    return np.array(img.convert("RGBA")), left, top


def _save_png(img, out_dir, stem):
    path = str(out_dir / f"{stem}.png") if hasattr(out_dir, "__truediv__") \
        else f"{out_dir}/{stem}.png"
    img.save(path)
    return path


def _scaled_leaf(layer, scale, origin):
    """
    잎 하나를 그룹 배율로 줄여 프리멀티플라이드 float32 RGBA로 돌려준다.

    비싼 것은 여기다 — 실측에서 그룹 썸네일 시간의 89%가 이 디코딩이었다. 그래서
    잎마다 **한 번만** 디코딩하고 곧바로 줄인 뒤 전해상도 배열을 버린다. peak
    메모리가 가장 큰 잎 한 장에 묶이는 이유가 그것이다.

    프리멀티플라이드로 바꾼 뒤에 줄인다. 스트레이트 알파로 채널을 따로 줄이면
    알파 0인 자리의 색이 가장자리로 번진다.
    """
    if layer.width <= 0 or layer.height <= 0:
        return None
    rgba = extract_rgba(layer).astype(np.float32) / 255.0
    h, w = rgba.shape[:2]
    x0 = round((layer.left - origin[0]) * scale)
    y0 = round((layer.top - origin[1]) * scale)
    tw = max(1, round((layer.left - origin[0] + w) * scale) - x0)
    th = max(1, round((layer.top - origin[1] + h) * scale) - y0)

    alpha = rgba[..., 3:4]
    premul = np.concatenate((rgba[..., :3] * alpha, alpha), axis=2)
    if (tw, th) != (w, h):
        img = Image.fromarray((255 * premul).astype(np.uint8), "RGBA")
        img = img.resize((tw, th), Image.LANCZOS)
        premul = np.asarray(img).astype(np.float32) / 255.0
    return premul, x0, y0


def _group_rgba_scaled(psd, group, bbox):
    """
    그룹을 **메모리 예산이 허락하는 해상도에서** 합성한다. 잎을 그룹 bbox 크기로
    부풀리지 않는 것이 요점이고, 최종 축소는 호출자가 마지막에 한 번만 한다.

    **왜 이 모양인가.** 실측(2026-08-05, HH0306 02_Color): 47.4Mpx / 잎 140장짜리
    그룹이 예전 경로로 1004.9초다. 잎마다 그룹 bbox 크기의 float32 버퍼를 훑기
    때문이고, 여기서는 각 잎을 자기 bbox 안에서 한 번만 디코딩해 곧바로 줄인다.
    디코딩이 시간의 대부분이라(실측 89%) 잎당 한 번이라는 성질이 이 경로의 전부다.

    블렌드·불투명도·클리핑·중첩 그룹·**레이어/그룹 자신의 (래스터) 마스크**·
    **pass-through 그룹의 부모-배경 상속**을 전부 재현한다. 합성은 잎 디코딩에
    비하면 싸고, 근사해서 얻을 것이 없다.

    그리고 그것이 필요하다. 8Mpx 넘는 그룹 322개 중 평범한 것은 20%뿐이고, 비용
    상위 30개 중 29개가 클리핑을 갖는다. 평탄화했다면 사람이 기다리는 거의 모든
    그룹의 그림이 틀렸을 것이다. pass-through는 예외가 아니라 기본값이다 —
    실측(2026-08-05, 레코드만, 픽셀 디코딩 없음): 보이는 중첩 그룹 1367개 중
    1318개(96%)가 pass-through이고, 748개(55%)가 non-normal 자손을 가져 실제로
    그림이 갈린다.

    **pass-through 그룹은 격리해서 그린 뒤 얹지 않는다.** `Compositor._get_group`
    (composite.py 516~563행)은 pass-through 그룹의 하위 컴포지터를 부모의 **현재**
    색·알파를 배경으로 만든다(`isolated=False`) — 그래서 그 안의 첫 레이어부터 진짜
    부모 배경과 블렌드된다. `own_mask_and_opacity`(아래)로 얻은 그룹 자신의
    마스크·불투명도는 `_apply_passthrough_source`(387~408행)로 그 결과를 부모
    누적치에 되접는다. `draw()`가 `(color_0, alpha_0)`를 받는 것이 이 때문이다 —
    격리된 자손은 빈 캔버스(`blank_color(), 0`)를, pass-through 자손은 부모의
    지금 상태를 그대로 물려받는다.

    **재현하지 않는 것은 효과(그림자·글로우·획)·벡터마스크·`isolate_adjustments`
    보정·최상위 그룹 자신에게 붙은 클리핑 레이어뿐이다.** extract_rgba가 잎을
    topil()로 읽으므로 잎의 효과는 구조적으로 빠지고(8Mpx 초과 그룹에서 261건),
    `own_mask_and_opacity`는 레이어/그룹 자신의 **래스터** 마스크만 옮긴다 —
    벡터마스크는 force=True에서 매번 다시 그려야 하는 별도 경로라
    (vector.draw_vector_mask) 옮기지 않았다. `Compositor._get_group`의
    `isolate_adjustments`(자신의 fill<255거나 자기 클리핑 레이어가 있는 그룹이
    `.color` 프로퍼티의 보정항을 타는 경우, 534행)도 옮기지 않았다 — 이 보정은
    `alpha_0=0`인 격리 경로에서는 대수적으로 no-op이라(divide(0,alpha_g)-0=0) 순수
    isolated 그룹에는 영향이 없고, pass-through 그룹 **자신**이 fill<255거나 자기
    클리핑 레이어를 가진, 더 좁은 교집합에서만 남는다. 그리고 최상위 `group` 자신에게
    (그 부모 컨테이너 안에서) 붙은 클리핑 레이어는 **의도적으로 건너뛴다** — 아래
    최상위 병합 자리의 주석 참고. 넷 다 render_thumbnails의 layer_filter가 배제하는
    것과 같은 자리이거나, 4.3의 "평범한 그룹" 정의(마스크·클리핑·효과·획 없음) 밖의
    손실이다.

    식은 Compositor._apply_source/_apply_passthrough_source를 프리멀티플라이드
    좌표로 옮긴 것이다. 클리핑 레이어가 베이스의 **색만** 바꾸고 알파는 바꾸지
    않는 것도 psd-tools와 같다(_apply_clip_layers가 하위 Compositor의 _color만
    돌려준다).

    캔버스로 자르지 않는다. 캔버스 밖의 그림도 그 그룹의 내용이고 썸네일에 보이는
    것이 맞다.
    """
    from psd_tools.composite import utils
    from psd_tools.composite.composite import paste
    from psd_tools.constants import BlendMode, Tag

    left, top, right, bottom = bbox
    # 48px가 아니라 **메모리 예산이 허락하는 만큼 큰 중간 캔버스**에서 합성하고,
    # 줄이는 것은 호출자가 마지막에 한 번만 한다.
    #
    # 처음에는 곧바로 48px 격자에서 합성했다가 사전 선언한 막대(≤4)를 크게
    # 넘겼다 — 평범한 그룹 42개 중 39개, 최악 255. 원인은 합성식이 아니라
    # 표본화였다. 잎마다 따로 줄여 **정수 썸네일 격자에 스냅**하면, 5343x1008을
    # 48x9로 넣는 111배 축소에서 잎 위치가 썸네일 픽셀 절반(원본 55px)까지 밀리고
    # 크기가 9px 높이에서 ±1px 흔들린다. 흐려지는 것이 아니라 다른 그림이 된다.
    # 내부 해상도를 K배로 올리면 오차가 단조로 줄고 한 그룹은 K=16에서 최대차 0에
    # 닿았다 — 블렌드·클리핑·불투명도·중첩 그룹이 전부 맞다는 증거다.
    #
    # 고정 K로는 안 된다. 스냅 오차를 정하는 것은 썸네일 대비가 아니라 **원본 대비**
    # 중간 해상도의 비율이라, 13배 축소 그룹에서 충분한 K가 111배에서는 어림없다.
    # 예산으로 묶으면 원본이 예산보다 작은 그룹은 저절로 전해상도에서 합성된다.
    src_px = (right - left) * (bottom - top)
    if src_px <= 0:
        # 빈 그룹. render_thumbnails는 cost가 0이라 여기까지 오지 않지만, 직접
        # 부르는 쪽(측정 스크립트가 그랬다)이 0으로 나누고 죽지 않게 막는다.
        # 호출자는 크기가 0인 결과를 "썸네일 대상 아님"으로 이미 걸러낸다.
        return np.zeros((1, 1, 4), dtype=np.uint8)
    scale = min(1.0, (THUMBNAIL_SUPERSAMPLE_PX / src_px) ** 0.5)
    pw = max(1, round((right - left) * scale))
    ph = max(1, round((bottom - top) * scale))

    def blank_color():
        return np.ones((ph, pw, 3), dtype=np.float32)

    def blank_scalar():
        return np.zeros((ph, pw, 1), dtype=np.float32)

    def own_mask_and_opacity(layer):
        """
        레이어/그룹 **자신**의 마스크(공간, (ph,pw,1) 배열이거나 마스크가 없으면
        스칼라 1.0) · 불투명도 · fill 불투명도(둘 다 스칼라).

        세 값을 따로 돌려주는 이유는 `Compositor.apply`(349~353, 361~372행)가
        `shape`와 `alpha`에 서로 다른 계수를 곱하기 때문이다 — `shape *= shape_mask`
        (fill은 나중에 shape_const로 별도로 곱한다), `alpha *= shape_mask *
        opacity_const`(그리고 마찬가지로 shape_const). pass-through 그룹을 부모에
        되접는 `_apply_passthrough_source`는 이 shape/alpha 몫을 각각 다른 자리에
        쓰므로(아래 `_apply_passthrough` 참고), 합쳐서 하나의 계수로 주면 안 된다.
        격리 경로(`_over`)는 shape가 대수적으로 지워지므로(_over의 docstring) 호출자가
        `mask_shape * opacity_const * shape_const`를 alpha에만 곱하면 된다.

        `Compositor.apply`가 `_get_mask`/`_get_const`로 얻는 값과 같다. 이 계산은
        `layer`가 잎이든 그룹이든 똑같이 적용된다 — `Group.composite`가 기본으로
        `as_layer=True`라(api/layers.py:1447) `render_thumbnails`가 부르는
        `layer.composite(force=True, ...)`는 최상위 그룹도 "마스크·불투명도가 있는
        하나의 레이어"로 다룬다(그 부모의 배경이 비어 있을 뿐이다). 그래서 이
        함수는 draw()의 자식 루프와 최상위 그룹(`[group]`로 감싼 합성 루프) 양쪽에서
        같은 모양으로 불린다.

        마스크 tile은 `layer.bbox` 범위에서만 값을 갖고 그 밖은 1.0으로 둔다 — 그
        밖에서는 이 레이어 자신의 shape/alpha가 이미 0이다(잎은 `_place`가, 그룹은
        재귀적인 `draw`가 자기 bbox 밖에 아무것도 놓지 않는다), 그러니 거기서 무엇을
        곱하든 결과가 같다. `_extract_rgba_masked`(237행)와 같은 트릭이다 — 진짜
        컴포지터의 뷰포트(보통 훨씬 큰 조상 그룹 bbox)로 폈다 잘라내나 처음부터
        `layer.bbox`로 붓나, 우리가 실제로 쓰는 자리에서는 같은 값이 나온다.

        `_extract_rgba_masked`와 정확히 같은 이유로 `real_mask=False`를 쓴다 —
        `render_thumbnails`의 기준은 항상 `force=True`이고, `_get_mask`(composite.py
        627행)는 그때 `real_mask=not force=False`를 쓴다. `_mask_fast_ok`가 잎 쪽에서
        `mask.has_real()`를 막는 이유(extract_rgba가 force=False로도 불릴 수 있어서)는
        여기엔 적용되지 않는다 — 이 함수는 오직 이 force=True 경로에서만 불린다.

        벡터마스크는 옮기지 않는다(함수 docstring 참고) — 여기서는 `layer.mask`
        (래스터)만 본다.
        """
        opacity_const = layer.opacity / 255.0
        shape_const = layer.tagged_blocks.get_data(Tag.BLEND_FILL_OPACITY, 255) / 255.0
        if layer.mask is None or layer.mask.disabled or layer.bbox == (0, 0, 0, 0):
            return 1.0, opacity_const, shape_const

        # _extract_rgba_masked(237~249행)의 마스크 계산을 그대로 옮긴다.
        mask_arr = layer.numpy("mask", real_mask=False)
        shape_mask = 1.0
        if mask_arr is not None:
            shape_mask = paste(layer.bbox, layer.mask.bbox, mask_arr,
                               layer.mask.background_color / 255.0)
        if layer.mask.parameters:
            density = layer.mask.parameters.user_mask_density
            if density is None:
                density = layer.mask.parameters.vector_mask_density
            if density is None:
                density = 255
            density = float(density) / 255.0
            shape_mask = density * shape_mask + (1 - density)
        if isinstance(shape_mask, float):
            # 마스크 배열이 없었다 — density만으로는 실질적으로 1.0.
            return 1.0, opacity_const, shape_const

        h, w = shape_mask.shape[:2]
        x0 = round((layer.left - left) * scale)
        y0 = round((layer.top - top) * scale)
        tw = max(1, round((layer.left - left + w) * scale) - x0)
        th = max(1, round((layer.top - top + h) * scale) - y0)
        if (tw, th) != (w, h):
            img = Image.fromarray((255 * shape_mask[..., 0]).astype(np.uint8), "L")
            img = img.resize((tw, th), Image.LANCZOS)
            shape_mask = (np.asarray(img).astype(np.float32) / 255.0)[..., None]

        mask_shape = np.ones((ph, pw, 1), dtype=np.float32)
        sx0, sy0 = max(0, -x0), max(0, -y0)
        sx1 = tw - max(0, x0 + tw - pw)
        sy1 = th - max(0, y0 + th - ph)
        if sx1 > sx0 and sy1 > sy0:
            dy, dx = y0 + sy0, x0 + sx0
            mask_shape[dy:dy + (sy1 - sy0), dx:dx + (sx1 - sx0)] = shape_mask[sy0:sy1, sx0:sx1]
        return mask_shape, opacity_const, shape_const

    def draw(container, color_0, alpha_0):
        """
        container의 자손을 아래→위로, (color_0, alpha_0) 배경 위에 합성한다.

        돌려주는 것은 이 container **자신의 몫**이다: `color`는 배경과 이미 블렌드된
        실제 값이지만, `shape_g`/`alpha_g`는 항상 0에서 시작하는 누적치다
        (`Compositor.__init__`의 `_shape_g`/`_alpha_g`가 isolated 여부와 무관하게
        항상 0인 것과 같다 — "부모에 얼마나 더 보탰는가"를 재는 것이지 "배경까지
        합친 최종 그림"이 아니다).

        격리된(pass-through가 아닌) 자손은 `blank_color(), 0`을 배경으로 받는다 —
        `Compositor`의 `isolated=True`와 같다, 자기 안에서는 부모의 내용이 보이지
        않는다. pass-through 그룹은 **호출한 쪽의 현재 (color, alpha_0∪alpha_g)**를
        그대로 받는다 — `_get_group`의 `is_passthrough` 분기(`isolated=False`,
        `viewport=self._viewport`)와 같다. 그래서 그 안의 첫 레이어부터 진짜 부모
        배경과 블렌드된다.
        """
        color = color_0
        shape_g = blank_scalar()
        alpha_g = blank_scalar()

        for layer in container:                      # psd-tools는 아래→위로 준다
            if not layer.visible:
                continue
            if layer.clipping:
                continue                             # 베이스를 그릴 때 함께 처리한다
            is_pass = layer.is_group() and layer.blend_mode == BlendMode.PASS_THROUGH

            # extract_rgba는 마스크 달린 잎을 _extract_rgba_masked나
            # layer.composite()로 이미 완전히 합성해 둔다 — 마스크·불투명도·fill
            # 불투명도뿐 아니라, 클리핑 레이어가 붙어 있으면 그것까지도.
            # _mask_fast_ok가 클리핑 있는 레이어는 항상 후자(layer.composite)로
            # 떨어뜨리므로(has_clip_layers 가드), "마스크가 있다"는 것 자체가
            # "클리핑까지 이미 반영됐다"는 뜻이다. 아래서 own_mask_and_opacity나
            # 클리핑 루프를 또 태우면 두 번 적용하는 것이 된다 — 그래서 잎만 이
            # 플래그로 건너뛴다. 그룹은 이런 사전 합성이 없으므로 매번 그대로 태운다.
            leaf_baked = False
            if layer.is_group():
                if is_pass:
                    raw_color, raw_shape, raw_alpha = draw(
                        layer, color, utils.union(alpha_0, alpha_g))
                else:
                    raw_color, raw_shape, raw_alpha = draw(
                        layer, blank_color(), blank_scalar())
            else:
                got = _scaled_leaf(layer, scale, (left, top))
                if got is None:
                    continue
                premul, x0, y0 = got
                raw_color, raw_alpha = blank_color(), blank_scalar()
                _place(raw_color, raw_alpha, premul, x0, y0)
                leaf_baked = layer.mask is not None and not layer.mask.disabled
                # 마스크 없는 잎: extract_rgba가 topil()이라 shape==alpha(자기
                # 불투명도를 아직 안 곱한 raw 값)다.
                raw_shape = raw_alpha

            if leaf_baked:
                # own_mask_and_opacity를 부르면 안 된다 — 마스크·불투명도·fill이
                # extract_rgba에서 이미 alpha에 반영됐다. shape는 거기서 opacity_const만
                # 나눠 되돌린다 — psd-tools의 shape는 fill(shape_const)은 포함하되
                # opacity(opacity_const)는 포함하지 않기 때문이다(Compositor.apply
                # 349~353행). opacity_const가 0이면(레이어가 완전히 투명) alpha도 이미
                # 0이므로 shape를 0으로 둬도 결과에 영향이 없다.
                opacity_const = layer.opacity / 255.0
                if opacity_const > 0:
                    shape_s = raw_alpha / opacity_const
                else:
                    shape_s = np.zeros_like(raw_alpha)
                alpha_s = raw_alpha
                own_mask = 1.0    # is_pass는 항상 False다(마스크 소진은 잎만 해당).
            else:
                # 클리핑 레이어들은 베이스의 색만 바꾼다.
                for clip in layer.clip_layers:
                    if not clip.visible:
                        continue
                    got = _scaled_leaf(clip, scale, (left, top))
                    if got is None:
                        continue
                    c_premul, cx, cy = got
                    c_color, c_alpha = blank_color(), blank_scalar()
                    _place(c_color, c_alpha, c_premul, cx, cy)
                    raw_color = _over(raw_color, raw_alpha, c_color, c_alpha,
                                      clip.blend_mode)[0]
                mask_shape, opacity_const, shape_const = own_mask_and_opacity(layer)
                shape_s = raw_shape * mask_shape * shape_const
                alpha_s = raw_alpha * mask_shape * (opacity_const * shape_const)
                own_mask = mask_shape * (opacity_const * shape_const)

            if is_pass:
                color, shape_g, alpha_g = _apply_passthrough(
                    color, shape_g, alpha_g, raw_color, shape_s, alpha_s, own_mask)
            else:
                color, _ = _over(color, utils.union(alpha_0, alpha_g),
                                 raw_color, alpha_s, layer.blend_mode)
                shape_g = utils.union(shape_g, shape_s)
                alpha_g = utils.union(alpha_g, alpha_s)
        return color, shape_g, alpha_g

    # 최상위 그룹도 부모 배경이 빈 컨테이너의 자식 하나처럼 돈다 — render_thumbnails가
    # 부르는 layer.composite(force=True, ...)의 as_layer=True와 같은 모양이다. 자기
    # 마스크·불투명도·(그리고 자신이 pass-through면 그 처리까지) 그대로 적용한다.
    # 배경이 항상 비어 있으므로(호출자가 color=1.0, alpha=0.0으로 부른다) 최상위
    # 그룹 자신의 blend_mode는 결과에 영향이 없다 — own_mask_and_opacity의
    # docstring이 같은 근거를 쓴다.
    #
    # **draw()의 일반 루프를 그대로 재사용하지 않는다.** 그 루프는 layer.clip_layers를
    # 무조건 처리하는데, 최상위 그룹 **자신**에게 클리핑된 레이어(있다면)는 이 그룹의
    # **부모** 컨테이너에 속해 있다 — render_thumbnails의 layer_filter(조상+자손만
    # 통과)가 애초에 걸러내는 자리다. 실측(2026-08-05, HH0306 02_Color): 'LINES'
    # 그룹 자신에게(그 부모 'TV' 안에서) 클리핑된 형제 'Layer 621' 하나가 이 경로로
    # 새 나가 플레인 그룹 108개 기준 premultiplied 최대가 10.0에서 103.7로 뛰었다.
    # psd-tools의 정확 기준(Compositor._apply_clip_layers)은 같은 필터를 그 클리핑
    # 레이어에도 물려주므로 필터 밖이면 그 레이어를 걸러 no-op이 되는데, 여기는
    # `_group_rgba_scaled`에 애초에 그런 필터가 없다 — 그래서 처리 자체를 하지
    # 않는다(이 자리에서만). 자손 쪽 레이어는 이 문제가 없다 — 클리핑 레이어는
    # 항상 자기 베이스와 같은 컨테이너의 형제이므로, 베이스가 이 그룹의 자손이면
    # 그 클리핑 레이어도 같은 부모를 통해 이 그룹의 자손이다.
    raw_color, raw_shape, raw_alpha = draw(group, blank_color(), blank_scalar())
    mask_shape, opacity_const, shape_const = own_mask_and_opacity(group)
    shape_s = raw_shape * mask_shape * shape_const
    alpha_s = raw_alpha * mask_shape * (opacity_const * shape_const)
    own_mask = mask_shape * (opacity_const * shape_const)
    if group.is_group() and group.blend_mode == BlendMode.PASS_THROUGH:
        color, _, alpha_g = _apply_passthrough(
            blank_color(), blank_scalar(), blank_scalar(),
            raw_color, shape_s, alpha_s, own_mask)
    else:
        color, alpha_g = _over(blank_color(), blank_scalar(), raw_color, alpha_s,
                               group.blend_mode)
    merged = np.concatenate((color, alpha_g), axis=2)
    return _quantize_like_psd_tools(psd, merged)


def _place(color, alpha_g, premul, x0, y0):
    """프리멀티플라이드 타일을 캔버스 좌표에 놓는다. 넘치는 부분은 잘라낸다."""
    ph, pw = color.shape[:2]
    h, w = premul.shape[:2]
    sx0, sy0 = max(0, -x0), max(0, -y0)
    sx1 = w - max(0, x0 + w - pw)
    sy1 = h - max(0, y0 + h - ph)
    if sx1 <= sx0 or sy1 <= sy0:
        return
    tile = premul[sy0:sy1, sx0:sx1]
    dy, dx = y0 + sy0, x0 + sx0
    box = (slice(dy, dy + tile.shape[0]), slice(dx, dx + tile.shape[1]))
    a = tile[..., 3:4]
    # 프리멀티플라이드를 스트레이트 색으로 되돌려 놓는다 — 합성식이 스트레이트를
    # 받는다. 알파 0인 자리는 divide 규약대로 1.0(흰색)이 된다.
    with np.errstate(divide="ignore", invalid="ignore"):
        straight = np.true_divide(tile[..., :3], a)
    straight[~np.isfinite(straight)] = 1.0
    color[box] = np.clip(straight, 0.0, 1.0)
    alpha_g[box] = a


def _over(color_b, alpha_b, color_s, alpha_s, blend_mode):
    """
    _apply_source(410행)의 배경 있는 경우. shape 인자를 따로 받지 않고 shape ==
    alpha_s로 다룬다 — `(shape - alpha) * alpha_b * color_b` 항이 늘 0이 되도록
    적어 뒀다는 뜻이다(437행 참고).

    **호출자는 이 가정을 실제로 깬다.** `own_mask_and_opacity`가 alpha에 자기 마스크·
    불투명도를 곱한 뒤에도 `shape`는 따로 줄지 않으므로 `shape != alpha_s`인 채로
    이 함수에 들어온다. 그런데도 결과는 여전히 정확하다 — psd-tools의 원식에서
    `shape`가 나타나는 두 항, `(1-shape)*alpha_previous*color_prev`(440행)와
    `(shape-alpha)*alpha_b*color_b`(437행)를 더하면 `shape`가 대수적으로 지워진다:
    `(1-shape)*A + (shape-alpha)*A = A*(1-alpha)`. 이 함수가 `(1-alpha_s)*alpha_b*
    color_b`로 적은 항이 바로 그 결과이므로, `shape`가 실제로 무엇이든(knockout이
    아닌 한) 최종 색이 같다. 그래서 shape를 별도로 옮겨 받을 필요가 없다 — knockout은
    `_group_rgba_scaled`가 다루지 않는 별도의 경우다. **이 지워짐은 pass-through로는
    이어지지 않는다** — `_apply_passthrough`가 옮기는 `_apply_passthrough_source`는
    `shape_b`를 `color_support` 계산에 직접 쓰고, 거기엔 상쇄되는 짝이 없다. 그래서
    `draw()`는 pass-through 그룹을 만날 자리를 위해 `shape_g`를 이 함수와 별도로
    누적해 둔다.

    대수적으로 줄이지 않는다 — 줄이면 float32에서 마지막 비트가 달라진다.
    """
    from psd_tools.composite import utils
    from psd_tools.composite.blend import BLEND_FUNC, normal

    alpha_new = utils.union(alpha_b, alpha_s)
    blend_fn = BLEND_FUNC.get(blend_mode, normal)
    color_t = (alpha_s - alpha_s) * alpha_b * color_b + alpha_s * (
        (1.0 - alpha_b) * color_s + alpha_b * blend_fn(color_b, color_s)
    )
    out = utils.clip(utils.divide(
        (1.0 - alpha_s) * alpha_b * color_b + color_t, alpha_new))
    return out, alpha_new


def _apply_passthrough(color_b, shape_b, alpha_b, color_s, shape_s, alpha_s, own_mask):
    """
    `Compositor._apply_passthrough_source`(387~408행)를 그대로 옮긴다. pass-through
    그룹이 자기 몫을 부모의 누적 상태에 얹을 때 `_over` 대신 쓴다.

    `_over`와의 차이가 이 함수의 존재 이유다. `_over`는 격리해서 그린 그림을 배경
    위에 "덮는" 연산이지만, `color_s`(pass-through 재귀 `draw()`가 돌려준 색)는 이미
    **부모 배경(`color_b`) 위에서 블렌드된 채로** 돌아온다 — 재귀 자체가 `color_b`를
    시드로 받기 때문이다(`_group_rgba_scaled`의 `draw()` docstring 참고). 그래서 여기서
    또 `_over`로 덮으면 배경을 두 번 반영하게 된다. 대신 `own_mask`(이 그룹 자신의
    마스크×불투명도×fill)만큼 `color_s`를 취하고, 나머지는 `color_support`로
    정규화한 값(부모가 이미 덮인 자리는 부모 색을, 아직 안 덮인 자리는 그룹 자신의
    색을 우선하는 가중 평균)을 취한다. `own_mask=1`(그룹 자신에 마스크·불투명도
    감쇠가 없음)이면 `color_support` 항이 통째로 사라져 `color_s`가 곧 결과가 된다 —
    이미 배경을 반영해 왔으니 그것으로 충분하다는 뜻이다.

    `shape_b`가 상쇄되지 않는 이유는 `_over`의 docstring에 적어 두었다.

    대수적으로 줄이지 않는다.
    """
    from psd_tools.composite import utils

    new_shape = utils.union(shape_b, shape_s)
    color_support = utils.clip(utils.divide(
        color_s * own_mask * (1.0 - shape_b) + color_b * shape_b, new_shape))
    color_new = utils.clip(color_s * own_mask + (1.0 - own_mask) * color_support)
    alpha_new = utils.union(alpha_b, alpha_s)
    return color_new, new_shape, alpha_new


def render_thumbnails(session, layer_ids, max_size, out_dir):
    psd = session["psd"]
    result = {}
    for lid in layer_ids:
        layer = session["layers_by_id"][lid]
        if layer.is_group():
            # For groups: include group + ancestors (hidden group override),
            # but respect visible flag on descendants
            ancestors_and_self = set()
            cur = layer
            while cur is not psd:
                ancestors_and_self.add(id(cur))
                cur = cur.parent
            # Collect visible descendants
            descendant_ids = {id(desc) for desc in layer.descendants() if desc.visible}
            bbox = layer.bbox
            leaves = [d for d in layer.descendants()
                      if d.visible and not d.is_group()]
            cost = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) * len(leaves) \
                / (1024 * 1024)
            if cost > THUMBNAIL_EXACT_BUDGET:
                # 아래의 img.thumbnail이 이 경로의 **유일한** 축소가 된다 —
                # _group_rgba_scaled는 중간 해상도로 돌려주므로 no-op이 아니다.
                img = Image.fromarray(
                    _group_rgba_scaled(psd, layer, bbox), "RGBA")
            else:
                img = layer.composite(
                    force=True,
                    color=1.0,
                    alpha=0.0,
                    layer_filter=lambda l: id(l) in ancestors_and_self or id(l) in descendant_ids,
                )
            if img is None or img.width <= 0 or img.height <= 0:
                # Group has no visible pixel content (e.g. all descendants are
                # themselves empty/hidden) — not a thumbnail target.
                continue
        else:
            # Artist created the layer but never painted it (empty bbox);
            # extract_rgba()/PIL would raise on a 0x0 image. Not a thumbnail
            # target — omit it rather than failing the whole batch. Note:
            # layer.width/height here is the leaf's own record-based bbox,
            # unaffected by its (or an ancestor's) visible flag — unlike a
            # group's bbox, which is computed from visible descendants.
            if layer.width <= 0 or layer.height <= 0:
                continue
            img = Image.fromarray(extract_rgba(layer))
        img = img.convert("RGBA")
        img.thumbnail((max_size, max_size))
        result[str(lid)] = _save_png(img, out_dir, f"thumb_{lid}")
    return result


def preview_scale(psd, max_size):
    """문서 좌표 → 미리보기 좌표 배율. 확대는 하지 않는다."""
    return min(max_size / psd.width, max_size / psd.height, 1.0)


def _tile_bytes(entry):
    if entry is None:
        return 0
    img = entry[0]
    return img.width * img.height * 4


def _evict_tiles(cache):
    total = sum(_tile_bytes(v) for v in cache.values())
    while total > PREVIEW_TILE_BUDGET_BYTES and len(cache) > 1:
        _, dropped = cache.popitem(last=False)
        total -= _tile_bytes(dropped)


def _preview_tile(session, layer_id, scale):
    """
    레이어를 미리보기 배율로 축소한 RGBA 타일 + 배치 좌표. 세션에 LRU 캐싱한다.

    비싼 부분은 PSD 채널 압축을 푸는 extract_rgba이고, 체크박스를 누를 때마다
    그걸 다시 하는 것이 느림의 근원이었다. 픽셀은 레이어당 한 번만 디코딩하고
    이후 토글은 캐시된 타일을 합성만 한다.

    좌표 원점은 export.py와 동일하게 layer.left/top이고 크기는 extract_rgba가
    돌려준 배열에서 가져온다 — 미리보기가 내보내기와 어긋나지 않게 하려면 두
    경로가 같은 픽셀·같은 원점을 써야 한다.
    """
    cache = session.setdefault("preview_tiles", OrderedDict())
    key = (layer_id, round(scale, 6))
    if key in cache:
        cache.move_to_end(key)
        return cache[key]

    layer = session["layers_by_id"][layer_id]
    # 그린 적 없는 빈 레이어(0x0). extract_rgba/PIL이 터지므로 렌더 대상이 아니다.
    if layer.width <= 0 or layer.height <= 0:
        entry = None
    else:
        rgba = extract_rgba(layer)
        h, w = rgba.shape[:2]
        left, top = layer.left, layer.top
        x0, y0 = round(left * scale), round(top * scale)
        tw = max(1, round((left + w) * scale) - x0)
        th = max(1, round((top + h) * scale) - y0)
        img = Image.fromarray(rgba, "RGBA")
        if (tw, th) != img.size:
            img = img.resize((tw, th), Image.LANCZOS)
        entry = (img, x0, y0)

    cache[key] = entry
    _evict_tiles(cache)
    return entry


def render_preview(session, visible_layer_ids, max_size, out_dir, line_color=None):
    """
    내보내기 결과 미리보기: 선택된 레이어의 픽셀을 문서 순서(아래→위)대로
    알파 합성한다. export_psd가 모든 레이어를 normal/255로 기록하므로 이것이
    내보낸 PSD가 실제로 보이게 될 모습이다.

    line_color가 주어지면 합성이 끝난 뒤 한 번만 덮는다. 레이어마다 덮고 합성한
    것과 결과가 동일하기 때문이다 — 모든 원본 RGB가 같은 값 C면 알파 오버의
    결과도 항상 C다. 타일 캐시를 색깔별로 나눌 필요도 없어진다.

    배경은 투명하게 둔다 — 흰색/체커/검정은 UI가 뒤에 깔아 고른다.
    """
    rgb = parse_line_color(line_color)
    psd = session["psd"]
    scale = preview_scale(psd, max_size)
    pw = max(1, round(psd.width * scale))
    ph = max(1, round(psd.height * scale))
    canvas = Image.new("RGBA", (pw, ph), (0, 0, 0, 0))

    for lid in visible_layer_ids:
        entry = _preview_tile(session, lid, scale)
        if entry is None:
            continue
        img, x0, y0 = entry
        # 반올림 때문에 타일이 캔버스를 1px 넘길 수 있다. alpha_composite는
        # 범위를 벗어나면 예외를 내므로 겹치는 부분만 잘라 얹는다.
        sx0, sy0 = max(0, -x0), max(0, -y0)
        sx1 = img.width - max(0, x0 + img.width - pw)
        sy1 = img.height - max(0, y0 + img.height - ph)
        if sx1 <= sx0 or sy1 <= sy0:
            continue
        if (sx0, sy0, sx1, sy1) != (0, 0, img.width, img.height):
            img = img.crop((sx0, sy0, sx1, sy1))
        canvas.alpha_composite(img, dest=(x0 + sx0, y0 + sy0))

    if rgb is not None:
        canvas = Image.fromarray(apply_line_color(np.asarray(canvas), rgb), "RGBA")

    return _save_png(canvas, out_dir, "preview")


def render_document_preview(session, max_size, out_dir):
    """
    원본 문서를 그대로 보여주는 미리보기. PSD에 저장돼 있는 병합 이미지를 쓰므로
    레이어 수와 무관하게 즉시 끝난다(165장짜리 문서에서 전체 재합성 200초 대
    0.2초). 파일을 막 열어 아직 아무것도 고르지 않은 상태에서 쓴다.

    저장된 병합 이미지가 없는 PSD면 전체 합성 말고는 방법이 없으므로 그때만
    force=True로 떨어진다 — 느리지만 조용히 빈 화면을 주지는 않는다.
    """
    psd = session["psd"]
    img = psd.composite(force=False)
    if img is None:
        img = psd.composite(force=True, color=1.0, alpha=0.0)
    img = img.convert("RGBA")
    img.thumbnail((max_size, max_size))
    return _save_png(img, out_dir, "document")
