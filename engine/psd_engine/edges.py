"""색으로만 갈린 경계에 획을 만든다 — 캐릭터 모델 전용.

**레이어별 알파 경계가 아니라 합성된 그림의 색 변화를 본다.** 레이어의 알파를 그대로
쓰면 다른 레이어에 가려져 실제로는 보이지 않는 경계까지 후보가 된다. 실측에서 그 방식은
셔츠 전체에 격자 모양 획을 만들었고, 합성 후에는 그것이 통째로 사라졌다.

scipy를 쓰지 않는다(엔진 venv에 없다). 모폴로지는 PIL, 연결 요소는 직접 구현한다.
"""
import numpy as np
from PIL import Image, ImageFilter

# render.py는 psd_engine의 다른 모듈을 import하지 않으므로(edges.py를 포함해)
# 이쪽에서 render를 가져와도 순환 import가 안 생긴다. export.py가 이미 두 모듈을
# 함께 가져오는 것(edges의 _composite_overlay + render의 extract_rgba)이 같은
# 방향이 안전하다는 증거다.
from .render import extract_rgba

#: 실측에 근거한 기본값. 설계 문서 7절 참고.
EDGE_DEFAULTS = {
    "threshold": 24,    # 이웃과의 RGB 최대 채널 차가 이보다 크면 색이 바뀐 것으로 본다
    "gap": 4,           # 기존 선을 이만큼 부풀려 뺀다
    "width": 0,         # 0 = 자동(_auto_width — 그 뷰 자신의 라인 굵기에서 유도).
                         # 고정 굵기가 왜 안 되는지: 파일마다 LINES 실측 중앙값이
                         # 다르다(예: 5,5,5,6 / 6,6,8,6,6,5,10 / 5,5,8) — 하나로
                         # 맞는 상수가 없다. width=5 고정이었을 때 생성 획 중앙값은
                         # 8.0(기존 LINES 중앙값 5.0 대비 60% 굵음)이었다.
    "minLength": 8,     # 이보다 짧은 조각은 선이 아니라 점이다
    "lineAlpha": 64,    # 기존 라인으로 칠 알파 문턱. LINES가 79.7% 반투명이라 낮게 잡는다
}

#: 중앙차분이 몇 px 떨어진 픽셀끼리 비교할지 — 안티에일리어싱 전이가 이 폭
#: 안에 있다고 본다. 문턱(threshold)이 아니라 이 반경이 진짜 손잡이다: 아티스트
#: 파일 실측에서 머리 두 레이어는 RGB (157,140,113)과 (184,164,127)로 채널
#: 최대 차 27이라 문턱 24를 원리상 넘지만, 그 차가 안티에일리어싱으로 2~3px에
#: 걸쳐 퍼져 있어 바로 옆 픽셀끼리는 단계마다 9~13밖에 안 된다 — 문턱을 6까지
#: 낮춰도 검출 수가 거의 안 바뀌었다(스텝 크기의 문제이지 문턱의 문제가
#: 아니다). k=3만큼 떨어진 픽셀끼리 비교하면 전이 전체가 한 번에 잡힌다.
ANTIALIAS_RADIUS = 3


def colour_change(rgba, threshold):
    """
    이웃과 색이 달라지는 자리와, 그 자리에 쓸 색(양쪽 중 어두운 쪽)을 돌려준다.

    양쪽이 모두 불투명한 쌍만 본다. 색 vs 투명(실루엣)은 이미 라인이 그리는 자리이고,
    그것까지 잡으면 캐릭터 윤곽을 통째로 다시 긋게 된다.

    바로 옆 픽셀이 아니라 ANTIALIAS_RADIUS(k)만큼 떨어진 픽셀끼리 비교한다(중앙차분).
    안티에일리어싱에 걸쳐 나뉜 색 단차는 한 걸음씩 보면 문턱을 못 넘지만(모듈 상수
    주석의 실측 참고), 양쪽 끝을 직접 비교하면 단차 전체가 한 번에 잡힌다.

    그런데 이렇게 넓혀 비교하면 문턱을 넘는 자리가 전이 구간 폭만큼(최대 2k px)
    "띠"로 부풀려진다. 그래서 축마다 **비최대 억제**를 거쳐 그 띠를 능선 한 줄로
    되돌린다 — 차이값이 국소최댓값인 자리만 남긴다. 완전히 평평한 계단(안티에일리어싱
    없는 하드 스텝)에서는 문턱을 넘는 값이 폭 2k짜리 고지를 이루어 국소최댓값이 여러
    자리에서 동시에 성립할 수 있으므로, 왼쪽/위쪽 이웃보다는 **엄격히** 크고
    오른쪽/아래쪽 이웃과는 같아도 되도록 비교를 비대칭으로 두어 고지에서 왼쪽/위쪽
    (작은 인덱스) 한 자리만 고른다 — 옛 colour_change가 "차이가 나는 쌍에서 왼쪽/위쪽
    픽셀"을 쓰던 것과 같은 방향이다. 이 비대칭이 없으면(양쪽 다 >=) 하드 스텝조차
    폭 2k px 그대로 남아, 이미 정상 동작하던 파일까지 획 수가 거의 두 배로 뛴다.
    """
    rgb = rgba[..., :3].astype(np.int16)
    solid = rgba[..., 3] > 127
    h, w = solid.shape
    k = ANTIALIAS_RADIUS
    mask = np.zeros((h, w), bool)
    colour = np.zeros((h, w, 3), np.uint8)

    for axis in (0, 1):
        n = h if axis == 0 else w
        if n <= 2 * k:
            continue  # 이 축에는 중앙차분을 계산할 폭이 없다

        a = rgb[:n - 2 * k, :] if axis == 0 else rgb[:, :n - 2 * k]
        b = rgb[2 * k:, :] if axis == 0 else rgb[:, 2 * k:]
        sa = solid[:n - 2 * k, :] if axis == 0 else solid[:, :n - 2 * k]
        sb = solid[2 * k:, :] if axis == 0 else solid[:, 2 * k:]
        diff = np.abs(a - b).max(axis=2)
        ok = sa & sb
        # 어두운 쪽 = 채널 합이 작은 쪽.
        darker = np.where((a.sum(axis=2) <= b.sum(axis=2))[..., None], a, b).astype(np.uint8)

        # 비교한 두 픽셀(k만큼 떨어진)의 가운데 자리에 되돌려 놓는다.
        d = np.zeros((h, w), np.int16)
        d_ok = np.zeros((h, w), bool)
        d_colour = np.zeros((h, w, 3), np.uint8)
        if axis == 0:
            d[k:h - k, :] = diff
            d_ok[k:h - k, :] = ok
            d_colour[k:h - k, :] = darker
        else:
            d[:, k:w - k] = diff
            d_ok[:, k:w - k] = ok
            d_colour[:, k:w - k] = darker

        # 비최대 억제(위 docstring 참고): 왼쪽/위쪽보다 엄격히 크고 오른쪽/아래쪽과는
        # 같아도 되는 비대칭 비교로, 평평한 고지에서 왼쪽/위쪽 한 자리만 남긴다.
        peak = np.zeros((h, w), bool)
        if axis == 0:
            peak[1:-1, :] = (d[1:-1, :] > d[:-2, :]) & (d[1:-1, :] >= d[2:, :])
        else:
            peak[:, 1:-1] = (d[:, 1:-1] > d[:, :-2]) & (d[:, 1:-1] >= d[:, 2:])

        hit = (d > threshold) & d_ok & peak
        mask |= hit
        np.copyto(colour, d_colour, where=hit[..., None])
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


#: gap을 다 되살린 뒤에도 라인 쪽으로 더 파고들 여유(px). LINES는 불투명 픽셀의
#: 79.7%가 반투명이라, lineAlpha 문턱(64)의 등고선은 실제로 눈에 보이는 라인
#: 가장자리보다 안쪽에 있다 — 정확히 그 등고선에서 멈추면 붙어 보이지 않는다.
#: 오버레이는 같은 자리에 같은 색으로 라인 위에 알파 합성되므로 몇 px 겹쳐도
#: 해롭지 않고, 겹치지 않아 흰 틈이 남는 쪽이 더 나쁘다.
RECONNECT_OVERLAP = 2


def reconnect_to_lines(mask_after_drop, removed, lines, gap):
    """
    subtract_lines가 지운 자리 중, 살아남은 조각에서 실제로 이어지는 부분만 되살린다.

    ``removed``(subtract_lines가 지운 자리 = 원래 경계였는데 라인 부풀린 자리와
    겹쳐 빠진 곳)로만 되살리면, 라인과 나란히 오래 깔린 경계는 끝의 gap px만
    살아나고 가운데는 그대로 지워진 채 남는다 — gap이 있는 이유 자체가 그것이므로
    지켜야 한다. 하지만 라인을 가로지르거나 거기서 끝나는 경계는 지금 gap만큼
    짧아진 채로 남아, 교차점·끝점마다 흰 틈이 생긴다(아티스트가 스크린샷으로
    짚은 문제).

    한 번에 반지름 gap짜리 정사각형으로 부풀리는 대신, **1px씩** ``removed |
    lines``(지워진 자리 + 라인 코어 자체) 안으로만 다시 자라게 하고, 매 단계
    그 영역과 다시 교집합을 구한다. 이렇게 하면 이미 살아있는 조각에서 그 영역을
    따라 **실제로 이어진** 자리만 되살아난다 — 굽은 경계도 굽이를 따라간다.
    한 번에 큰 정사각형으로 부풀리면 체비셰프 거리만으로 "가깝다"고 판단하므로,
    영역이 굽어 있거나 끊어져 있을 때(예: 경계가 라인 아래에서 꺾이는 자리) 실제로는
    이어지지 않은 자리까지 거리만 보고 건너뛰어 잘못 붙일 수 있다 — 굽이를 따라
    가는 것이 아니라 가로질러 건너뛰는 것이다.

    gap을 다 쓴 뒤에도 RECONNECT_OVERLAP만큼 더 자라게 둔다. 영역에 라인 코어
    자체가 포함되어 있으므로, 이 마지막 몇 단계는 lineAlpha 등고선을 넘어 라인
    안쪽까지 살짝 겹친다(모듈 상수 설명 참고).
    """
    target = removed | lines
    if not target.any():
        return mask_after_drop
    grown = mask_after_drop
    for _ in range(gap + RECONNECT_OVERLAP):
        grown = mask_after_drop | (_morph(grown, 3, grow=True) & target)
    return grown


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


#: line_alpha에 잴 라인이 하나도 없을 때(뷰에 라인 레이어가 없는 경우) 쓰는
#: 기본값. 비교할 기준이 없을 때 가장 방어적인 선택은 이 기능이 자동 굵기를
#: 갖기 전까지 모든 뷰가 실제로 썼던 굵기(옛 고정 기본값)를 그대로 쓰는 것이다.
AUTO_WIDTH_FALLBACK = 5


def _line_run_lengths(line_alpha, line_alpha_threshold):
    """
    line_alpha에서 문턱을 넘는 가로 런(run)들의 길이. 행마다 훑는다.

    설계 문서 7절·이 파일의 실측 수치들이 전부 이 방법(가로 런 길이의 중앙값)으로
    잰 것이다 — 여기서 잰 값도 그것들과 비교 가능해야 같은 잣대다.
    """
    lines = line_alpha > line_alpha_threshold
    if lines.size == 0 or lines.shape[1] == 0:
        return []
    padded = np.zeros((lines.shape[0], lines.shape[1] + 2), bool)
    padded[:, 1:-1] = lines
    diff = np.diff(padded.astype(np.int8), axis=1)
    # 한 행 안에서는 시작(diff==1)과 끝(diff==-1)이 x 오름차순으로 번갈아 나오므로,
    # np.nonzero가 주는 순서 그대로 같은 행끼리 짝지으면 된다.
    _, starts_x = np.nonzero(diff == 1)
    _, ends_x = np.nonzero(diff == -1)
    return (ends_x - starts_x).tolist()


def _auto_width(line_alpha, line_alpha_threshold):
    """
    width=0(자동)일 때 획 굵기를 정한다 — 그 뷰 자신의 라인 굵기에서 유도한다.

    라인 런 길이의 **중앙값**을 재서 목표로 삼는다. 채워진 영역(선이 아니라
    면)이 섞이면 75%ile 같은 값은 크게 흔들린다 — 실측 한 뷰에서 75%ile이
    57px까지 뛴 적이 있다. 중앙값은 그 자체로 버틴다: 채워진 런이 전체 런의
    절반을 넘어야 중앙값이 그쪽으로 끌려가는데, 실측 뷰들에서 채워진 영역은
    소수였다. 그래서 채워진 런을 따로 걸러내지 않는다 — 중앙값을 쓰는 것 자체가
    그 방어다.

    목표 중앙값에서 실제로 넣을 width로: stroke_rgba가 만드는 획의 중앙값은
    width 자체가 아니라 width−2에 가깝게 나온다(실측: width 1→중앙값3,
    3→5, 5→8 — _auto_width라는 이름과 달리 이 −2는 stroke_rgba 자체의
    성질이 아니라 이 모듈의 경계 마스크가 완전히 1px 두께가 아니기 때문일
    가능성이 높다: colour_change가 두 축을 따로 표시해 2px 두께가 되는
    자리가 있고, 대각선 경계는 계단 모양이 되며, 둘 다 정사각형 팽창을 더
    넓힌다 — 순수 1px 직선 마스크로 만든 합성 픽스처에서는 오프셋이 0이었다.
    안티에일리어싱 폭이 더 넓다는 것도 그럴듯하지만 증명되지 않았고, 이쪽이
    적어도 그만큼 설명이 된다. 원인은 미확정으로 남긴다).
    식: width = odd_floor(round(target) − 2), 최소 1. _morph가 width를
    홀수로 올림하므로(width 2와 3, 4와 5가 같은 결과) 실제로 고를 수 있는
    획 중앙값은 대략 3, 5, 8, 10뿐이다 — 이 knob은 거칠고, 목표에 정확히
    맞힐 수 없는 경우가 대부분이다. 가장 가까운 값을 고른다.
    """
    lengths = _line_run_lengths(line_alpha, line_alpha_threshold)
    if not lengths:
        return AUTO_WIDTH_FALLBACK
    target = float(np.median(lengths))
    candidate = round(target) - 2
    if candidate % 2 == 0:
        candidate -= 1
    return max(1, candidate)


def build_overlay(colour_rgba, line_alpha, opts):
    """
    합성된 색 그림과 그 자리의 기존 라인 알파에서 획 오버레이를 만든다.

    돌려주는 것은 입력과 같은 크기의 RGBA다. 그릴 것이 없으면 알파가 전부 0이다.
    """
    o = {**EDGE_DEFAULTS, **(opts or {})}
    raw_mask, colour = colour_change(colour_rgba, o["threshold"])
    subtracted = subtract_lines(raw_mask, line_alpha, o["gap"], o["lineAlpha"])
    labels, count = label_components(subtracted)
    dropped = drop_small(subtracted, labels, count, o["minLength"])
    # subtract_lines가 지운 자리 중 살아남은 조각과 이어지는 부분을 되살린다
    # (reconnect_to_lines 문서 참고) — 라인에 닿아야 할 경계가 gap만큼 뜬 채로
    # 남는 것을 막는다. 되살아난 픽셀이 새 라벨을 만들 수도 있고(교차 반대편과
    # 합쳐지는 경우) drop_small이 이미 버린 라벨과는 절대 안 이어지므로(그 라벨은
    # dropped에서 이미 빠졌다), 처음부터 다시 라벨을 매겨야 한다 — drop_small
    # 이전 라벨을 재활용하는 옛 최적화는 더 이상 맞지 않는다. 대상 픽셀 수는
    # 여전히 경계 픽셀 규모(수천 개)라 비용은 무시할 만하다.
    removed = raw_mask & ~subtracted
    lines = line_alpha > o["lineAlpha"]
    mask = reconnect_to_lines(dropped, removed, lines, o["gap"])
    labels, count = label_components(mask)
    # width=0(기본값)은 자동 — 이 뷰 자신의 라인 굵기에서 유도한다(_auto_width
    # 문서 참고). 0이 아닌 값은 그대로 강제한다 — 지금까지의 동작 그대로다.
    width = o["width"] or _auto_width(line_alpha, o["lineAlpha"])
    return stroke_rgba(mask, labels, colour, width)


def _union_bbox(layers):
    boxes = [l.bbox for l in layers if l.bbox != (0, 0, 0, 0)]
    if not boxes:
        return None
    return (min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes))


def _paste_alpha(layers, box):
    """레이어들의 알파를 box 좌표계의 한 장으로 모은다(최댓값 합성).

    `layer.topil()`이 아니라 `render.extract_rgba`로 읽는다. `topil()`은 레이어의
    래스터 마스크를 적용하지 않으므로, 마스크로 가려진 자리가 그대로 불투명하게
    나온다 — 실제로는 선이 없는 그 자리를 "이미 선이 있다"고 오판해
    `subtract_lines`가 gap만큼 부풀려 지우고, 그 아래 살아 있어야 할 색 경계까지
    함께 지운다. `extract_rgba`는 마스크를 적용하는 값싼 경로(막히면
    `layer.composite`)를 쓰므로 이 문제가 없고, 덤으로 그 빠른 경로도 공짜로 얻는다.
    """
    left, top, right, bottom = box
    out = np.zeros((bottom - top, right - left), np.uint8)
    for layer in layers:
        if layer.bbox == (0, 0, 0, 0):
            continue
        arr = extract_rgba(layer)[..., 3]
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
    # `layer_filter`를 주면 psd.composite의 기본 필터(`Layer.is_visible`)를
    # **대체**한다 — 더해지는 것이 아니다(psd_tools/composite/composite.py:
    # `layer_filter = layer_filter or Layer.is_visible`). `.visible` 항 없이
    # `id(l) in wanted or l.is_group()`만 쓰면 숨은 레이어도 조건 없이
    # 합성된다: `wanted` 안의 숨은 잎은 그대로 그려지고(꺼진 대체 색상의
    # 실루엣이 색 경계로 오인된다), 숨은 그룹도 전부 통과해 그 자손까지
    # 뚫린다.
    #
    # `.visible`(자신의 플래그, 조상은 안 봄)이면 충분하다. Compositor.apply는
    # 필터를 통과 못 한 레이어에서 그 자리 그대로 반환하고 자식을 아예 보지
    # 않으므로(psd_tools/composite/composite.py의 Compositor.apply 앞부분),
    # 매 단계 자기 플래그만 검사해도 숨은 조상 아래는 재귀가 거기서 멈춰
    # 전부 걸린다 — `is_visible()`로 조상을 직접 훑는 것과 결과가 같다.
    # `render.py`의 기존 BG 경로(render_thumbnails)도 같은 이유로 `.visible`을
    # 쓴다.
    img = session["psd"].composite(
        viewport=box, force=True, color=1.0, alpha=0.0,
        layer_filter=lambda l: l.visible and (id(l) in wanted or l.is_group()),
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
