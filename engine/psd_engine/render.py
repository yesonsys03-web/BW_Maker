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


def extract_rgba(layer):
    if layer.mask is not None and not layer.mask.disabled:
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
