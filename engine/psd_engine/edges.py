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
    # 크기로 팽창시켜 얻는다.
    #
    # 한 번에 큰 MaxFilter를 걸면 이웃 안에서 "가장 가까운" 라벨이 아니라 "가장 큰"
    # 라벨이 이긴다. label_components가 라벨을 래스터 순서(위→아래, 왼→오른쪽)로
    # 매기므로, 두 조각이 width px 안으로 붙어 있으면 이 편향은 늘 같은 방향으로
    # 나타난다 — 항상 아래/오른쪽 조각이 경계 중간의 애매한 자리까지 차지한다.
    # 대신 3×3 MaxFilter를 반경만큼 한 칸씩 돌리면서, 이미 라벨이 붙은 자리는
    # 다시 덮지 않는다(`np.where(grown == 0, ...)`). 한 링(ring)씩 퍼지므로 어느
    # 라벨이 먼저 도착하느냐가 곧 체비셰프 거리로 "더 가까운" 라벨이다 — thick를
    # 만들 때 쓴 정사각형 커널과 같은 거리 척도라 서로 어긋나지 않는다. 반경은
    # thick와 똑같이 (홀수로 올림한 width) // 2번 반복하면 된다(기본 width=5면 2회).
    size = width if width % 2 else width + 1
    grown = labels
    for _ in range(size // 2):
        step = np.array(
            Image.fromarray(grown.astype(np.int32), mode="I").filter(ImageFilter.MaxFilter(3))
        )
        grown = np.where(grown == 0, step, grown)
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
    # drop_small이 돌려준 mask는 이미 "살아남은 라벨의 픽셀만 True"다. 다시
    # label_components를 불러 처음부터 훑을 필요 없이, 곱해서 지워진 조각의 라벨만
    # 0으로 죽이면 된다. 번호가 듬성듬성해져도 stroke_rgba는 존재하지 않는 라벨을
    # 건너뛰므로(range 반복에서 빈 라벨은 continue) 문제가 없다.
    labels = labels * mask
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


def _composite_overlay(rgba, left, top, overlay, ox, oy):
    """
    두 RGBA를 캔버스 좌표 기준으로 알파 합성한다. 필요하면 캔버스를 넓힌다.

    export.py의 entry_pixels(엔트리 픽셀 위에 획을 얹을 때)와 attach_overlays(같은
    엔트리를 노리는 두 플랜을 합칠 때) 양쪽에서 쓰는, 배열 두 장과 오프셋만 다루는
    순수 연산이다. 배열을 다루는 쪽은 edges.py이므로 여기 둔다 — export.py가
    이것을 가져다 쓴다.

    넓히는 것이 요점이다. 한쪽이 다른 쪽 bbox 밖으로 나가면, 잘라내는 대신 결과
    캔버스를 두 bbox의 합집합으로 키운다.
    """
    from PIL import Image

    h, w = rgba.shape[:2]
    oh, ow = overlay.shape[:2]
    nl, nt = min(left, ox), min(top, oy)
    nr, nb = max(left + w, ox + ow), max(top + h, oy + oh)
    canvas = Image.new("RGBA", (nr - nl, nb - nt), (0, 0, 0, 0))
    canvas.alpha_composite(Image.fromarray(rgba, "RGBA"), dest=(left - nl, top - nt))
    canvas.alpha_composite(Image.fromarray(overlay, "RGBA"), dest=(ox - nl, oy - nt))
    return np.array(canvas), nl, nt


def attach_overlays(entries, plans):
    """
    오버레이를 그 뷰의 라인 엔트리에 실어 둔다. 판단은 여기 한 번뿐이고
    entry_pixels는 읽기만 한다 — 색 통일(lineRgb)과 같은 방식이다.

    라인이 내보내기에 포함되지 않았으면 합칠 자리가 없으므로 그 뷰는 건너뛴다.
    아티스트가 라인을 체크하지 않았다는 뜻이고, 그때 획만 따로 내보내는 것은
    "최종 라인 레이어에 넣는다"는 이 기능의 목적과 어긋난다.

    두 플랜이 같은 엔트리를 가리킬 수 있다 — 두 뷰의 라인 레이어를 한 엔트리로
    합치는 merge 프리셋은 지금도 흔하고(예: LINE 하나로 병합), 수동 지정이 들어오면
    자동 감지와 수동 지정이 같은 뷰를 각각 플랜으로 만들어 이 충돌이 일상이 된다.
    그때 그냥 대입(`=`)하면 나중에 온 플랜이 먼저 온 플랜을 조용히 지운다 — 화면에
    아무 표시도 없이 한 뷰의 획이 통째로 사라진다. 그래서 이미 오버레이가 있는
    엔트리는 알파 합성으로 **더한다**. 합성은 같은 자리를 두 번 계산해 겹쳐도
    획이 굵어지거나 짙어지지 않는다는 부수 효과도 준다 — 픽셀 최댓값이 아니라
    알파로 섞이므로 이중 계산된 경계가 두꺼워지지 않는다.
    """
    for entry in entries:
        entry.setdefault("edgeOverlay", None)
    for plan in plans:
        wanted = set(plan["lineIds"])
        # 문서 순서상 처음 걸리는 엔트리 하나에만 건다 — 잃는 획은 없다. 오버레이는
        # 뷰 하나를 통째로 덮는 RGBA 한 장이고, 설계상 뷰당 출력 시트도 하나다.
        # 그 뷰의 라인이 여러 엔트리에 나뉘어 있어도 어느 엔트리가 획을 실을지
        # 결정될 뿐이지 획 자체가 어느 쪽에서도 사라지지 않는다.
        target = next((e for e in entries if wanted & set(e["sourceIds"])), None)
        if target is None:
            continue
        existing = target.get("edgeOverlay")
        if existing is None:
            target["edgeOverlay"] = (plan["rgba"], plan["left"], plan["top"])
        else:
            target["edgeOverlay"] = _composite_overlay(
                existing[0], existing[1], existing[2],
                plan["rgba"], plan["left"], plan["top"],
            )
    return entries
