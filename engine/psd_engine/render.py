"""픽셀 추출/병합/썸네일/미리보기.

병합(merge_rgba)은 psd-tools 합성을 그대로 쓴다 — 원본 스택 안에서 블렌드/클리핑을
그대로 살려야 하는 연산이기 때문이다.

미리보기(render_preview)는 다르다. export.py가 각 레이어를 `opacity=255,
blend_mode=normal`로 기록하므로 **내보낸 PSD는 블렌드·클리핑·불투명도가 제거된
평평한 스택**이고, 그 파일의 내장 미리보기도 alpha_composite 누적으로 만들어진다.
따라서 미리보기가 재현해야 할 대상은 원본 합성이 아니라 그 평평한 알파 합성이다.
"""
import re
from collections import OrderedDict

import numpy as np
from PIL import Image

_HEX_COLOR = re.compile(r"#[0-9a-fA-F]{6}\Z")

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


def merge_rgba(psd, layers):
    boxes = [l.bbox for l in layers if l.bbox != (0, 0, 0, 0)]
    if not boxes:
        raise ValueError("merge: all source layers are empty")
    left = min(b[0] for b in boxes)
    top = min(b[1] for b in boxes)
    right = max(b[2] for b in boxes)
    bottom = max(b[3] for b in boxes)
    wanted = _wanted_ids(psd, layers)
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
