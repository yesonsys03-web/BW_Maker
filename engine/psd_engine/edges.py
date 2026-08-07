"""색으로만 갈린 경계에 획을 만든다 — 캐릭터 모델 전용.

**레이어별 알파 경계가 아니라 합성된 그림의 색 변화를 본다.** 레이어의 알파를 그대로
쓰면 다른 레이어에 가려져 실제로는 보이지 않는 경계까지 후보가 된다. 실측에서 그 방식은
셔츠 전체에 격자 모양 획을 만들었고, 합성 후에는 그것이 통째로 사라졌다.

scipy를 쓰지 않는다(엔진 venv에 없다). 모폴로지는 PIL, 연결 요소는 직접 구현한다.
"""
import numpy as np
from PIL import Image, ImageFilter

#: 실측에 근거한 기본값. 설계 문서 7절 참고.
EDGE_DEFAULTS = {
    "threshold": 24,    # 이웃과의 RGB 최대 채널 차가 이보다 크면 색이 바뀐 것으로 본다
    "gap": 4,           # 기존 선을 이만큼 부풀려 뺀다
    "width": 5,         # 획 굵기. LINES 실측 중앙값 4px, 25~75% 4~5px
    "minLength": 8,     # 이보다 짧은 조각은 선이 아니라 점이다
    "lineAlpha": 64,    # 기존 라인으로 칠 알파 문턱. LINES가 79.7% 반투명이라 낮게 잡는다
}


def colour_change(rgba, threshold):
    """
    이웃과 색이 달라지는 자리와, 그 자리에 쓸 색(양쪽 중 어두운 쪽)을 돌려준다.

    양쪽이 모두 불투명한 쌍만 본다. 색 vs 투명(실루엣)은 이미 라인이 그리는 자리이고,
    그것까지 잡으면 캐릭터 윤곽을 통째로 다시 긋게 된다.

    차이가 나는 쌍에서 **왼쪽/위쪽 픽셀**을 경계로 삼는다. 어느 쪽을 골라도 획을
    굵히는 단계에서 같은 자리를 덮으므로, 한쪽으로 정해 두기만 하면 된다.
    """
    rgb = rgba[..., :3].astype(np.int16)
    solid = rgba[..., 3] > 127
    mask = np.zeros(solid.shape, bool)
    colour = np.zeros(rgba.shape[:2] + (3,), np.uint8)

    for axis in (0, 1):
        a = rgb[:-1, :] if axis == 0 else rgb[:, :-1]
        b = rgb[1:, :] if axis == 0 else rgb[:, 1:]
        sa = solid[:-1, :] if axis == 0 else solid[:, :-1]
        sb = solid[1:, :] if axis == 0 else solid[:, 1:]
        hit = (np.abs(a - b).max(axis=2) > threshold) & sa & sb
        # 어두운 쪽 = 채널 합이 작은 쪽.
        darker = np.where((a.sum(axis=2) <= b.sum(axis=2))[..., None], a, b).astype(np.uint8)
        if axis == 0:
            mask[:-1, :] |= hit
            np.copyto(colour[:-1, :], darker, where=hit[..., None])
        else:
            mask[:, :-1] |= hit
            np.copyto(colour[:, :-1], darker, where=hit[..., None])
    return mask, colour


def _morph(mask, size, grow):
    """PIL로 하는 팽창/침식. size는 홀수여야 한다."""
    if size <= 1:
        return mask
    size = size if size % 2 else size + 1
    f = ImageFilter.MaxFilter(size) if grow else ImageFilter.MinFilter(size)
    return np.array(Image.fromarray((mask * 255).astype(np.uint8)).filter(f)) > 127


def subtract_lines(mask, line_alpha, gap, line_alpha_threshold):
    """
    이미 선이 있는 자리를 뺀다.

    알파 문턱으로 먼저 거르는 것이 중요하다. LINES는 불투명 픽셀의 79.7%가
    반투명이라 "0이 아니면 선"으로 치면 흐린 자국까지 선이 되어, 그 아래 살아 있어야
    할 색 경계가 통째로 사라진다.

    gap은 반지름이다 — 선 굵기의 절반쯤을 잡아야 안티에일리어싱 자락까지 덮인다.
    """
    lines = line_alpha > line_alpha_threshold
    if gap > 0:
        lines = _morph(lines, gap * 2 + 1, grow=True)
    return mask & ~lines


def label_components(mask):
    """
    8-이웃 연결 요소. 배경은 0.

    scipy.ndimage.label을 못 쓰므로 직접 훑는다. 대상은 경계 픽셀뿐이라(실측 한 뷰에
    4천 개 수준) 파이썬 반복으로도 부담이 없다 — 캔버스 전체를 도는 것이 아니다.
    """
    labels = np.zeros(mask.shape, np.int32)
    h, w = mask.shape
    count = 0
    ys, xs = np.nonzero(mask)
    for sy, sx in zip(ys.tolist(), xs.tolist()):
        if labels[sy, sx]:
            continue
        count += 1
        stack = [(sy, sx)]
        labels[sy, sx] = count
        while stack:
            y, x = stack.pop()
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not labels[ny, nx]:
                        labels[ny, nx] = count
                        stack.append((ny, nx))
    return labels, count


def drop_small(mask, labels, count, min_length):
    """
    픽셀 수가 min_length 미만인 조각을 버린다.

    경계는 1px 폭이라 픽셀 수가 곧 길이에 가깝다. 길이를 따로 재지 않는 이유다.
    """
    if min_length <= 1 or count == 0:
        return mask
    sizes = np.bincount(labels.ravel(), minlength=count + 1)
    keep = np.zeros(count + 1, bool)
    keep[1:] = sizes[1:] >= min_length
    return keep[labels]


def stroke_rgba(mask, labels, colour, width):
    """
    경계를 width 굵기의 획으로 만든다. 색은 **조각마다 하나**로 정한다.

    조각별로 색을 고르는 것은 굵히면서 생기는 문제를 피하려는 것이다 — 1px 경계에만
    있던 색을 어떻게 바깥으로 퍼뜨릴지 정해야 하는데, 거리 변환은 scipy 없이 비싸다.
    한 조각은 같은 두 색이 만나는 자리이므로 대표색 하나로 충분하다.

    가장자리를 살짝 흐린다. LINES가 79.7% 반투명일 만큼 안티에일리어싱이 강해서,
    딱딱한 획을 나란히 놓으면 그것만 튄다.
    """
    thick = _morph(mask, width, grow=True)
    alpha = np.array(
        Image.fromarray((thick * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.8))
    )
    out = np.zeros(mask.shape + (4,), np.uint8)
    out[..., 3] = alpha
    if not thick.any():
        return out
    # 조각별 대표색을 굵어진 영역 전체에 칠한다. 굵힌 뒤의 라벨은 원본 라벨을 같은
    # 크기로 팽창시켜 얻는다 — MaxFilter가 라벨 번호에도 그대로 통한다.
    grown = np.array(
        Image.fromarray(labels.astype(np.int32), mode="I").filter(
            ImageFilter.MaxFilter(width if width % 2 else width + 1))
    )
    for lab in range(1, labels.max() + 1):
        src = labels == lab
        if not src.any():
            continue
        rep = np.median(colour[src], axis=0).astype(np.uint8)
        out[(grown == lab) & thick, :3] = rep
    return out


def build_overlay(colour_rgba, line_alpha, opts):
    """
    합성된 색 그림과 그 자리의 기존 라인 알파에서 획 오버레이를 만든다.

    돌려주는 것은 입력과 같은 크기의 RGBA다. 그릴 것이 없으면 알파가 전부 0이다.
    """
    o = {**EDGE_DEFAULTS, **(opts or {})}
    mask, colour = colour_change(colour_rgba, o["threshold"])
    mask = subtract_lines(mask, line_alpha, o["gap"], o["lineAlpha"])
    labels, count = label_components(mask)
    mask = drop_small(mask, labels, count, o["minLength"])
    labels, _ = label_components(mask)
    return stroke_rgba(mask, labels, colour, o["width"])


def _union_bbox(layers):
    boxes = [l.bbox for l in layers if l.bbox != (0, 0, 0, 0)]
    if not boxes:
        return None
    return (min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes))


def _paste_alpha(layers, box):
    """레이어들의 알파를 box 좌표계의 한 장으로 모은다(최댓값 합성)."""
    left, top, right, bottom = box
    out = np.zeros((bottom - top, right - left), np.uint8)
    for layer in layers:
        if layer.bbox == (0, 0, 0, 0):
            continue
        arr = np.array(layer.topil().convert("RGBA"))[..., 3]
        lx, ly = layer.bbox[0] - left, layer.bbox[1] - top
        y0, x0 = max(0, ly), max(0, lx)
        y1 = min(out.shape[0], ly + arr.shape[0])
        x1 = min(out.shape[1], lx + arr.shape[1])
        if y1 <= y0 or x1 <= x0:
            continue
        np.maximum(out[y0:y1, x0:x1], arr[y0 - ly:y1 - ly, x0 - lx:x1 - lx],
                   out=out[y0:y1, x0:x1])
    return out


def overlay_for_view(session, colour_ids, line_ids, opts):
    """
    뷰 하나의 획 오버레이. 그릴 것이 없으면 None.

    색 레이어를 **합성해서** 본다. 레이어별 알파 경계를 쓰면 다른 레이어에 가려져
    실제로는 보이지 않는 경계까지 후보가 되기 때문이다(모듈 docstring 참고).

    뷰포트는 색 레이어들의 합집합이다. 기존 라인은 그 좌표계로 옮겨 담는다 —
    라인이 색보다 넓어도 겹치는 부분만 있으면 된다.
    """
    layers_by_id = session["layers_by_id"]
    colour_layers = [layers_by_id[i] for i in colour_ids]
    box = _union_bbox(colour_layers)
    if box is None:
        return None

    wanted = {id(l) for l in colour_layers}
    img = session["psd"].composite(
        viewport=box, force=True, color=1.0, alpha=0.0,
        layer_filter=lambda l: id(l) in wanted or l.is_group(),
    )
    colour_rgba = np.array(img.convert("RGBA"))
    line_alpha = _paste_alpha([layers_by_id[i] for i in line_ids], box)

    out = build_overlay(colour_rgba, line_alpha, opts)
    if out[..., 3].max() == 0:
        return None
    return out, box[0], box[1]


def plan_overlays(session, views, opts):
    """뷰 목록 → 오버레이 목록. 그릴 것이 없는 뷰는 빠진다."""
    plans = []
    for view in views:
        made = overlay_for_view(session, view["colourIds"], view["lineIds"], opts)
        if made is None:
            continue
        rgba, left, top = made
        plans.append({"lineIds": view["lineIds"], "rgba": rgba,
                      "left": left, "top": top})
    return plans
