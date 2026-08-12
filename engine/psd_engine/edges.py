"""색으로만 갈린 경계에 획을 만든다 — 캐릭터 모델 전용.

**레이어별 알파 경계가 아니라 합성된 그림의 색 변화를 본다.** 레이어의 알파를 그대로
쓰면 다른 레이어에 가려져 실제로는 보이지 않는 경계까지 후보가 된다. 실측에서 그 방식은
셔츠 전체에 격자 모양 획을 만들었고, 합성 후에는 그것이 통째로 사라졌다.

scipy를 쓰지 않는다(엔진 venv에 없다). 모폴로지는 PIL, 연결 요소는 직접 구현한다.
"""
from contextlib import contextmanager

import numpy as np
from PIL import Image, ImageFilter

# render.py는 psd_engine의 다른 모듈을 import하지 않으므로(edges.py를 포함해)
# 이쪽에서 render를 가져와도 순환 import가 안 생긴다. export.py가 이미 두 모듈을
# 함께 가져오는 것(edges의 _composite_overlay + render의 extract_rgba)이 같은
# 방향이 안전하다는 증거다.
#
# 모듈째로도 가져온다. `FAST_MERGE`를 값으로 받으면 PSD_ENGINE_FAST_MERGE=0도,
# 테스트의 monkeypatch(test_render.py)도 이쪽까지 닿지 않아 "빠른 경로를 끈
# 상태"가 오버레이에서만 조용히 안 꺼진다 — `render.FAST_MERGE`로 읽는다.
from . import render
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
    "colourMode": "composite",  # 색 그림을 만드는 방법. "paste"는 A/B 비교용 — COLOUR_MODES 참고
    "edgeMode": "region",       # 색 경계를 찾는 방법. EDGE_MODES 참고
}

#: 뷰의 색 그림을 만드는 두 가지 방법.
#:
#: `composite`가 기본이고 지금까지의 동작이다 — `psd.composite(force=True)`로
#: 포토샵의 합성 모델(블렌드 모드·클리핑·마스크·그룹 불투명도)을 그대로 돌린다.
#: 정확하지만 비싸다: 실측 한 뷰(33 Mpx, 잎 16개)에서 **145.5초**였고, 한 파일이
#: 미리보기에서 15분을 먹었다.
#:
#: `paste`는 각 잎의 픽셀을 문서 순서대로 알파 합성만 한다. 같은 뷰에서 **19.2초**
#: (8배), 잎이 적고 클리핑이 없는 뷰에서는 35~45배까지 벌어진다. 대신 **클리핑을
#: 지키지 않는다** — 납품 폴더 83장 중 36장(43%)에 클리핑 잎이 있고, 그런 뷰에서는
#: 색 그림이 실제로 갈린다(실측 한 뷰에서 알파 일치 58.7%, RGB 최대차 249).
#:
#: 그런데 이 기능의 산출물은 색 그림이 아니라 **검은 획**이고, 같은 뷰에서 획
#: 픽셀은 16531 대 16712로 1.09%밖에 차이가 없었다. 그 1%가 가짜 획인지 아니면
#: 무해한 자리인지는 픽셀 수로 가릴 수 없어서, 사람이 두 결과를 눈으로 비교할 수
#: 있도록 옵션으로 둔다. 판정이 끝나면 둘 중 하나만 남기고 이 옵션은 없앤다.
COLOUR_MODES = ("composite", "paste")

#: 뷰의 색 경계를 찾는 두 가지 방법.
#:
#: `region`이 기본이다 — 색 그림을 평평한 색 영역으로 나눠(`segment_colours`) 라벨이
#: 바뀌는 자리를 두른다(`region_boundary`). `change`는 지금까지의 동작으로, 중앙차분
#: 으로 색차를 재고 비최대 억제로 능선을 남긴다(`colour_change`).
#:
#: 그 두 단계가 아티스트가 "지글거린다"고 한 것을 만들었다. **부풀리기 전 1px
#: 마스크를 그리면 갈린다** — `change`의 중심선은 끊기고 겹줄이 나고 가시가 돋는데
#: `region`은 이어진 한 줄이다. 알파만 보면 판정이 기운다: `stroke_rgba`가 마지막에
#: 블러 0.8을 걸어 `change`의 계단을 이미 덮어 놓기 때문이다.
#:
#: 실측 세 파일에서 `region` 마스크는 `change`가 잡던 것의 89.3~97.7%를 담고, 최종
#: 경계 픽셀은 +5% / +50% / +91%로 늘어난다. 늘어난 폭이 파일마다 크게 다르고 그
#: 초과분이 진짜 경계인지는 눈으로 봐야 하므로, `change`를 남겨 같은 세션에서 비교할
#: 수 있게 둔다. 판정이 끝나면 둘 중 하나만 남기고 이 옵션은 없앤다.
EDGE_MODES = ("region", "change")

#: 중앙차분이 몇 px 떨어진 픽셀끼리 비교할지 — 안티에일리어싱 전이가 이 폭
#: 안에 있다고 본다. 문턱(threshold)이 아니라 이 반경이 진짜 손잡이다: 아티스트
#: 파일 실측에서 머리 두 레이어는 RGB (157,140,113)과 (184,164,127)로 채널
#: 최대 차 27이라 문턱 24를 원리상 넘지만, 그 차가 안티에일리어싱으로 2~3px에
#: 걸쳐 퍼져 있어 바로 옆 픽셀끼리는 단계마다 9~13밖에 안 된다 — 문턱을 6까지
#: 낮춰도 검출 수가 거의 안 바뀌었다(스텝 크기의 문제이지 문턱의 문제가
#: 아니다). k=3만큼 떨어진 픽셀끼리 비교하면 전이 전체가 한 번에 잡힌다.
ANTIALIAS_RADIUS = 3


#: 평평한 색으로 칠 최소 점유율 — 그 뷰 불투명 픽셀 대비.
#:
#: **상위 N개로 자르면 안 된다.** 상위 12색이 화면의 95.0~98.6%를 덮지만, 못 덮는
#: 1.4~5.0%가 곧 리본·작은 별 같은 작은 것들이고 지글거린다고 지목된 대상이 정확히
#: 그것들이다. 개수 바닥값으로 자르면 작아도 평평하면 살아남는다.
#:
#: 실측 세 파일(뷰 0)에서 서로 다른 색 2632~3696개 중 이 값이 평평한 색 12~21개를
#: 남긴다. 프리셋 키로 노출하지 않는다 — 아티스트가 돌릴 손잡이가 하나 더 느는
#: 값어치가 없다. ANTIALIAS_RADIUS와 같은 성격의 상수다.
FLAT_COLOUR_FLOOR = 0.0005


#: region 검출의 색차 게이트에 곱하는 배율. `region_boundary`의 문턱을 `change`의
#: threshold와 그대로 공유하면 안 된다 — 둘이 재는 것 자체가 다른 양이다. `change`는
#: 실제 픽셀 두 개(ANTIALIAS_RADIUS만큼 떨어진)를 직접 비교하는데, `region`은
#: `segment_colours`가 뭉친 두 영역의 **평평한 대표색**을 비교한다. 완만한
#: 그라데이션을 가로지르는 경계에서는 분할이 양 끝의 극단값을 대표색 안으로
#: 흡수해 버리므로, 같은 경계라도 region이 재는 단차는 change가 raw 픽셀로 재는
#: 것보다 작다 — 같은 문턱을 쓰면 region 쪽이 부당하게 더 잘 기각한다.
#:
#: 공유했을 때의 대가는 실측했다. 납품 캐릭터 폴더 100장·342뷰 전수에서 16개
#: 뷰(5.6%, 파일 7/83)가 획 픽셀의 절반 넘게, 8개는 3/4 넘게, 3개는 95% 넘게
#: region에서 잃는다. 최악은 change가 그리는 2257px짜리 최종 경계가 region에서
#: 35px로 준다 — 부드럽게 음영진 그림에서 change가 긋는 경계를 region이 통째로
#: 기각한다는 뜻이다.
#:
#: 2/3이라는 배율은 **점 하나짜리 눈금**에서 나왔다. 최악 뷰 둘에서 문턱을
#: 24→16→12→4로 훑어가며 region 마스크가 change 마스크를 얼마나 담는지 쟀더니
#: 16에서 82.7%/93.5%로 회복하고 그 아래로는 평평하다(12·4에서 거의 안 바뀐다).
#: 즉 24가 16이 되어야 한다는 것만 알고, 참 관계가 **비율**인지 **고정폭 뺄셈**
#: (예: threshold−8)인지는 이 점 하나로는 못 가른다. 그래도 비율을 골랐다 —
#: 프리셋의 threshold가 낮아져도(예: 6) 게이트가 계속 양수로 남는다. 고정폭
#: 뺄셈이었다면 threshold가 그 폭보다 작아지는 지점에서 게이트가 0 이하로
#: 떨어져, 낮은 문턱을 쓰는 프리셋일수록 먼저 무너진다.
#:
#: 16이 안전한지는 따로 쟀다 — 그라데이션 얼굴 실측에서 문턱 0이면 93,860px가
#: 걸리지만 문턱 2 이상이면 하나도 안 걸린다. 16은 그 위험 지점(2)의 여덟 배라,
#: 이 배율이 실제로 등고선을 다시 열 만큼 낮지는 않다.
#:
#: 고정된 16을 그냥 쓰지 않고 배율로 두는 이유: 그러면 프리셋의 threshold가
#: region 모드에서 조용히 아무 일도 안 하는 손잡이가 된다. 이 저장소는 그
#: 결함을 이미 한 번 냈다 — 엔진에서는 width=0이 "자동"인데 프런트는 항상
#: 5를 보내서 자동이 한 번도 안 돌았고, 그런데도 테스트 양쪽 다 통과했다.
REGION_GATE_SCALE = 2 / 3


def _pack_rgb(rgb):
    return ((rgb[..., 0].astype(np.uint32) << 16)
            | (rgb[..., 1].astype(np.uint32) << 8)
            | rgb[..., 2].astype(np.uint32))


def _unpack_rgb(keys):
    return np.stack([(keys >> 16) & 255, (keys >> 8) & 255, keys & 255],
                    -1).astype(np.int16)


def segment_colours(rgba, floor=FLAT_COLOUR_FLOOR):
    """
    합성된 색 그림을 평평한 색 영역으로 나눈다. (labels, flats)를 돌려준다.

    labels는 입력과 같은 크기의 int32이고 **투명한 자리는 -1**이다. 나머지는 flats의
    행 번호이고 flats는 (F,3) int16이다.

    평평한 색 = 개수가 floor 이상인 색(FLAT_COLOUR_FLOOR 참고). 나머지는 대부분
    1픽셀짜리 안티에일리어싱 잔여이고, **가장 가까운 평평한 색**에 붙인다. 거리는
    채널 최대차 — threshold와 같은 척도라 region_boundary의 게이트와 어긋나지 않는다.

    33 Mpx를 픽셀마다 재지 않는다. 한 뷰의 서로 다른 색은 2600~3700개뿐이므로 **색마다
    한 번** 재고 역인덱스로 펼친다 — 실측 11717x2820 뷰에서 분할이 2.4초다.
    """
    solid = rgba[..., 3] > 127
    labels = np.full(solid.shape, -1, np.int32)
    if not solid.any():
        return labels, np.zeros((0, 3), np.int16)
    keys = _pack_rgb(rgba[..., :3])[solid]
    vals, inv, counts = np.unique(keys, return_inverse=True, return_counts=True)
    cut = max(1, int(round(floor * int(solid.sum()))))
    keep = np.nonzero(counts >= cut)[0]
    if len(keep) == 0:
        # 바닥값이 그 뷰에 비해 너무 높다 — 제일 흔한 색 하나라도 남겨야 라벨이 선다.
        keep = np.array([int(counts.argmax())])
    flats = _unpack_rgb(vals[keep])
    nearest = np.abs(_unpack_rgb(vals)[:, None, :] - flats[None, :, :]).max(2).argmin(1)
    labels[solid] = nearest[inv].astype(np.int32)
    return labels, flats


def region_boundary(labels, flats, threshold):
    """
    라벨이 바뀌는 자리와, 그 자리에 쓸 색(두 대표색 중 어두운 쪽)을 돌려준다.

    `colour_change`와 같은 모양을 돌려주므로 `build_overlay`의 하류가 그대로 붙는다.
    자리는 두 픽셀 중 왼쪽/위쪽, 색은 어두운 쪽(채널 합이 작은 쪽)으로 규칙도 같다.

    **비최대 억제가 없다.** 라벨 경계는 이미 1px이다 — 중앙차분으로 띠를 부풀린 뒤
    억제로 능선을 되찾는 두 단계가 여기서는 필요 없고, 계단과 잔가시가 그 두 단계의
    부산물이었다.

    **색차 게이트는 빼면 안 된다.** 분할은 완만한 그라데이션을 양자화 단계마다 갈라
    놓으므로, 게이트가 없으면 아티스트가 아무 경계도 못 보는 자리에 등고선을 긋는다.
    지금까지의 colour_change에는 원리상 없던 결함이다(걸음당 색차가 문턱을 못 넘어
    아무것도 안 그렸다). 실측에서 인접 쌍 92~308개 중 6~118개를 기각한다.

    투명(라벨 -1)과 맞닿은 자리는 실루엣이라 잡지 않는다. 이미 라인이 그리는 자리다.
    """
    h, w = labels.shape
    mask = np.zeros((h, w), bool)
    colour = np.zeros((h, w, 3), np.uint8)
    if len(flats) == 0:
        return mask, colour
    pair = np.abs(flats[:, None, :] - flats[None, :, :]).max(2)
    sums = flats.sum(1)
    darker = np.where((sums[:, None] <= sums[None, :])[..., None],
                      flats[:, None, :], flats[None, :, :]).astype(np.uint8)
    for axis in (0, 1):
        a = labels[:-1, :] if axis == 0 else labels[:, :-1]
        b = labels[1:, :] if axis == 0 else labels[:, 1:]
        # 경계 픽셀에서만 색차를 조회한다. 전체 크기로 pair[a, b]를 만들면 33 Mpx
        # 뷰에서 수십 MB짜리 중간 배열이 축마다 생긴다.
        ys, xs = np.nonzero((a >= 0) & (b >= 0) & (a != b))
        if len(ys) == 0:
            continue
        av, bv = a[ys, xs], b[ys, xs]
        hit = pair[av, bv] > threshold
        if not hit.any():
            continue
        ys, xs, av, bv = ys[hit], xs[hit], av[hit], bv[hit]
        mask[ys, xs] = True
        colour[ys, xs] = darker[av, bv]
    return mask, colour


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
    """
    적분영상으로 하는 팽창/침식. size는 홀수여야 한다.

    정사각 커널이면 팽창은 "창 안에 켜진 픽셀이 하나라도 있는가"와 같은 말이고,
    창의 합은 적분영상 네 귀퉁이의 덧뺄셈이라 **커널이 커져도 비용이 늘지 않는다**.
    침식은 여집합의 팽창이다.

    전에는 PIL의 `MaxFilter(size)`였다. 랭크 필터는 커널 넓이의 제곱으로 드는데
    (폭 21이면 픽셀당 441회), 자동 굵기가 큰 파일에서 이것이 터졌다 — 실측으로
    납품 파일 한 장이 이 함수 안에서 16분을 보냈고, 그동안 프로세스는 CPU 98%에
    RSS는 1MB도 움직이지 않았다. 12 Mpx / 폭 21 기준 11.19초가 0.38초가 된다.

    가장자리 규칙까지 PIL과 같다. PIL은 여백을 복사하는 것이 아니라 창을 이미지
    안으로 잘라서 계산하고, 제로 패딩한 적분영상이 같은 답을 낸다 — 팽창에서는
    바깥이 꺼진 픽셀이고, 침식에서는 여집합을 취하므로 바깥이 켜진 픽셀이라
    양쪽 다 "이미지 밖은 창에 없는 것과 같다"가 된다. `test_morph_matches_the_
    pil_rank_filter_pixel_for_pixel`이 옛 구현을 기준자로 두고 이것을 잰다.
    """
    if size <= 1:
        return mask
    size = size if size % 2 else size + 1
    r = size // 2
    src = mask if grow else ~mask
    h, w = src.shape
    # 위·왼쪽에 한 줄 더 있는 제로 패딩 적분영상. 창 합은 네 귀퉁이로 얻는다.
    padded = np.zeros((h + 2 * r + 1, w + 2 * r + 1), np.int32)
    padded[r + 1:r + 1 + h, r + 1:r + 1 + w] = src
    total = padded.cumsum(0).cumsum(1)
    window = (total[2 * r + 1:, 2 * r + 1:] - total[:h, 2 * r + 1:]
              - total[2 * r + 1:, :w] + total[:h, :w])
    hit = window > 0
    return hit if grow else ~hit


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

    scipy.ndimage.label을 못 쓰므로 직접 훑는다. 대상은 경계 픽셀뿐이고(캔버스 전체를
    도는 것이 아니다), region 검출로 바뀐 뒤에도 그 규모다 — 납품 폴더 실측에서 가장 큰
    원본 경계가 54,847px(3826×2363 뷰)였고, 그 뷰의 분할·경계 검출·가늘게 하기 전체
    (segment_colours부터 reconnect_to_lines까지)가 2.12초였다. 이 함수만 따로 재면
    경계 픽셀당 2.5~3µs에 33 Mpx 캔버스 기준 고정 비용 약 60ms가 더해지고, 모양과
    무관하게 픽셀 수에 선형이다 — 여기서만 1초를 채우려면 경계 픽셀이 약 38만 개
    있어야 하는데, 이는 실측한 가장 큰 경계의 31배다.
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


#: 알파에 거는 가우시안 블러가 thick 밖으로 번지는 폭(px).
#:
#: 라벨을 이만큼 더 키우지 않으면 그 자락이 색 없이 (0,0,0)으로 남아 모든 생성 획에
#: 검은 후광이 둘린다 — 실측 한 뷰에서 알파>0 픽셀의 42.1%가 그랬고 평균 알파 32.4,
#: 그 100%가 thick 밖이었다. 지금 획이 진해 보이는 이유의 일부가 이것이라, 고치면
#: 획이 **옅어진다**. 그건 의도된 결과다.
#:
#: STROKE_BLUR를 0.8에서 0.6으로 내려도 이 값은 그대로 둔다 — 번짐이 줄었으니
#: 2px는 여전히 넉넉하고, 모자라면 후광이 돌아온다. 줄여서 아낄 것도 없다.
BLUR_REACH = 2


#: 획 알파에 거는 가우시안 블러의 σ. 아티스트 선의 안티에일리어싱이 강해서
#: (LINES 불투명 픽셀의 79.7%가 반투명) 딱딱한 획을 나란히 놓으면 그것만 튄다.
#:
#: 0.8 → 0.6 → 0.4로 두 번 내렸다. 아티스트가 "생성 라인이 30%쯤 두껍다"고 한 것의
#: 절반이 이 자락이었고, 0.6을 확인한 뒤 "조금 더 얇게"를 요청했다.
#: 실측(그 아티스트가 보던 파일, 뷰 0, 아티스트 선 중앙 6.0px):
#:
#:     사각3  + σ0.8 (처음)  심 6.0  중간 9.0  자락 14.0  알파중앙 175  선접촉 396
#:     마름모1 + σ0.6        심 5.0  중간 7.0  자락 10.0  알파중앙 190  선접촉 347
#:     마름모1 + σ0.4 (지금)  심 5.0  중간 6.0  자락  9.0  알파중앙 221  선접촉 336
#:
#: 자락이 얇아지면서 **알파는 오히려 진해진다**(175 → 221). 심은 5.0으로 고정이다.
#:
#: **더 얇게 가려면 자락이 아니라 심을 건드려야 하고, 거기가 절벽이다.** 팽창을
#: 없애면(width 1과 같다) 심 5.0 → 2.0, 알파 중앙값 190 → 41로 획이 흐려지고,
#: 기존 선과 맞닿는 픽셀이 347 → 175로 절반이 되어 접합부가 뜬다. width로 줄이는
#: 길도 막혀 있다 — width 2는 _morph의 홀수 올림 때문에 3과 완전히 같다.
#:
#: 그래도 더 얇게 해야 한다면 다음 후보는 알파 감마다(기하는 그대로 두고 곡선만
#: 건다). 실측 σ0.4 + 감마1.5에서 중간 5.0 / 자락 7.0 / 알파중앙 227 / 최대 255 —
#: 심과 접합은 지키면서 자락만 더 준다. 손잡이가 하나 더 느는 값이라 요청 전까지는
#: 넣지 않는다.
STROKE_BLUR = 0.4


def _grow_diamond(mask, radius):
    """마름모(4-이웃) 팽창. 정사각(_morph)보다 대각선으로 덜 자란다.

    획을 굵히는 데에만 쓴다. `_morph`는 그대로 둔다 — `subtract_lines`가 기존 선을
    gap만큼 부풀릴 때 쓰고, 거기서 모양을 바꾸면 "이미 선이 있다"의 뜻이 달라진다.

    **왜 모양을 바꿨나.** 굵기 노브(width)는 `_morph`가 커널을 홀수로 올림해서
    띄엄띄엄하다 — width 2는 3과 같은 그림이고, 3에서 1로 내리면 심이 절반이 되면서
    획이 흐려진다(STROKE_BLUR 주석의 실측). 아티스트가 원한 30%는 그 사이에 있다.
    같은 반지름에서 L∞(정사각) 대신 L1(마름모)로 자라면 그 중간이 나온다.

    반지름만큼 4방향으로 한 겹씩 넓힌다. 획 반지름은 1~7 수준이라(자동 굵기 3~15)
    루프가 짧고, 각 겹은 시프트 OR 네 번이라 적분영상까지 갈 것이 없다.
    """
    if radius <= 0:
        return mask
    out = mask
    for _ in range(radius):
        grown = out.copy()
        grown[1:, :] |= out[:-1, :]
        grown[:-1, :] |= out[1:, :]
        grown[:, 1:] |= out[:, :-1]
        grown[:, :-1] |= out[:, 1:]
        out = grown
    return out


def stroke_rgba(mask, labels, colour, width):
    """
    경계를 width 굵기의 획으로 만든다. 색은 **조각마다 하나**로 정한다.

    조각별로 색을 고르는 것은 굵히면서 생기는 문제를 피하려는 것이다 — 1px 경계에만
    있던 색을 어떻게 바깥으로 퍼뜨릴지 정해야 하는데, 거리 변환은 scipy 없이 비싸다.
    한 조각은 같은 두 색이 만나는 자리이므로 대표색 하나로 충분하다.

    가장자리를 살짝 흐린다. LINES가 79.7% 반투명일 만큼 안티에일리어싱이 강해서,
    딱딱한 획을 나란히 놓으면 그것만 튄다.

    팽창은 마름모다(`_grow_diamond`) — 아티스트 요청으로 굵기를 한 단계 줄이는데
    width로는 갈 수 없는 중간값이 필요했다. 아래 라벨 키우기는 **정사각 그대로**
    둔다: 정사각은 마름모를 포함하므로 색이 항상 획을 덮고, 덜 덮어서 생기는 검은
    후광(BLUR_REACH 주석)이 이 변경으로 되살아나지 않는다.
    """
    thick = _grow_diamond(mask, width // 2)
    alpha = np.array(
        Image.fromarray((thick * 255).astype(np.uint8))
        .filter(ImageFilter.GaussianBlur(STROKE_BLUR))
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
    # thick를 채우는 (홀수로 올림한 width) // 2회에 BLUR_REACH를 더 돈다(기본
    # width=5면 2+2=4회) — 알파가 블러로 thick 밖까지 번지므로, 색이 그 자락까지
    # 따라가려면 라벨도 그만큼 더 자라야 한다(BLUR_REACH 주석 참고).
    size = width if width % 2 else width + 1
    grown = labels
    for _ in range(size // 2 + BLUR_REACH):
        step = np.array(
            Image.fromarray(grown.astype(np.int32), mode="I").filter(ImageFilter.MaxFilter(3))
        )
        grown = np.where(grown == 0, step, grown)
    painted = alpha > 0
    for lab in range(1, labels.max() + 1):
        src = labels == lab
        if not src.any():
            continue
        rep = np.median(colour[src], axis=0).astype(np.uint8)
        out[(grown == lab) & painted, :3] = rep
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
    if o.get("edgeMode") == "change":
        raw_mask, colour = colour_change(colour_rgba, o["threshold"])
    else:
        # region의 게이트는 threshold를 그대로 쓰지 않는다 — REGION_GATE_SCALE
        # 주석 참고.
        gate = max(1, round(o["threshold"] * REGION_GATE_SCALE))
        raw_mask, colour = region_boundary(*segment_colours(colour_rgba), gate)
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


def _paste_colour(colour_layers, box):
    """색 잎들을 문서 순서대로 알파 합성한다 — `psd.composite`의 값싼 대체.

    `colourMode="paste"`일 때만 쓴다. 무엇을 얻고 무엇을 잃는지는 COLOUR_MODES 참고.

    `_paste_alpha`와 같은 이유로 `layer.topil()`이 아니라 `render.extract_rgba`를
    쓴다 — `topil()`은 래스터 마스크를 적용하지 않아 가려진 자리가 불투명하게
    남고, 그러면 실제로는 없는 색 경계가 생겨 그 자리에 가짜 획이 그어진다.
    비교를 공정하게 하려면 이쪽도 마스크를 지켜야 한다.

    바탕은 `psd.composite(color=1.0, alpha=0.0)`과 맞춰 흰색·투명으로 둔다.
    """
    left, top, right, bottom = box
    canvas = Image.new("RGBA", (right - left, bottom - top), (255, 255, 255, 0))
    for layer in colour_layers:
        if not layer.visible or layer.bbox == (0, 0, 0, 0):
            continue
        arr = extract_rgba(layer)
        lx, ly = layer.bbox[0] - left, layer.bbox[1] - top
        # 잎이 박스 밖으로 나갈 수 있다(뷰포트는 합집합이지만 숨은 잎이 빠지면
        # 어긋난다). alpha_composite는 범위를 벗어나면 예외를 내므로 겹치는
        # 부분만 잘라 얹는다 — render.render_preview가 타일에 하는 것과 같다.
        y0, x0 = max(0, ly), max(0, lx)
        y1 = min(canvas.height, ly + arr.shape[0])
        x1 = min(canvas.width, lx + arr.shape[1])
        if y1 <= y0 or x1 <= x0:
            continue
        tile = Image.fromarray(arr[y0 - ly:y1 - ly, x0 - lx:x1 - lx], "RGBA")
        canvas.alpha_composite(tile, dest=(x0, y0))
    return np.array(canvas)


#: 라인 잎 하나가 뷰 박스의 이 비율을 넘게 덮으면 선화가 아니라 채우기로 본다.
#:
#: 납품 폴더 100장을 전수로 재서 고른 값이다. `character._line_leaves`가 이름으로
#: 채색 잎을 걸러낸 뒤, 뷰 339개 중 338개의 라인 cover는 최대 **32.0%**였고
#: (중앙값 4.8%, p99 29.5%) 남은 하나가 **100.0%**였다 — 그 사이가 통째로 비어
#: 있어 어디를 잡아도 오분류가 없다. 가운데를 잡는다.
#:
#: 이름으로 못 거르는 경우가 있어서 이 가드가 따로 필요하다. 남은 그 하나는 잎
#: 이름이 `Layer 27`/`Layer 28`이고, 그중 `Layer 28`이 문서 전체 크기(9899x3240)의
#: 채우기였다. 같은 뷰의 진짜 라인은 6.5%라 잎 단위로 재면 정확히 갈린다 —
#: 뷰 단위로 재면 그 진짜 라인까지 함께 버리게 된다.
FILL_COVERAGE = 0.5


def _drop_filled(line_layers, box, alpha_threshold):
    """뷰 박스를 너무 많이 덮는 라인 잎을 뺀다. 선화는 몇 %를 덮는다.

    채우기가 라인 알파에 섞이면 두 가지가 함께 망가진다 — `_auto_width`가 그
    알파의 가로 런 중앙값에서 굵기를 유도하므로 획이 캐릭터 몸통만큼 굵어지고,
    `subtract_lines`가 그 자리를 "이미 선이 있다"로 보고 이 기능이 그려야 할
    색 경계를 지운다.
    """
    kept = []
    for layer in line_layers:
        alpha = _paste_alpha([layer], box)
        if float((alpha > alpha_threshold).mean()) > FILL_COVERAGE:
            continue
        kept.append(layer)
    return kept


def _composite_colour(psd, colour_layers, box):
    """뷰의 색 그림 — 지금까지와 **같은 픽셀**을, 문서 전체를 훑지 않고 만든다.

    `merge_rgba`가 내보내기에서 쓰는 두 단을 그대로 쓴다. 여기 따로 쓰는 이유는
    가시성 규약이 정반대이기 때문이다: `merge_rgba`는 **숨은 조상 아래 잎도 일부러
    포함**하고(사용자가 확정한 동작), 오버레이는 반대로 빼야 한다 — 꺼진 대체
    색상의 실루엣이 색 경계로 오인되기 때문이다
    (test_overlay_for_view_ignores_a_hidden_colour_layer). 그래서 잎을
    `is_visible()`로 먼저 거른다. 이것이 옛 필터의 `l.visible` 항과 같은 것을
    고른다 — Compositor.apply는 필터를 통과 못 한 그룹에서 재귀를 멈추므로,
    단계마다 자기 플래그만 보는 것이 조상을 훑는 것과 결과가 같다.

    **뷰포트(box)는 숨은 잎까지 포함한 합집합 그대로 둔다.** 이 함수가 좁히는 것은
    무엇을 합성하느냐뿐이고, 돌려주는 배열의 좌표는 호출부가 그대로 쓴다.

    **배포되는 산출물로 잰 값이 결론이다** — 샘플 #001~#004의 뷰 17개에서
    `overlay_for_view`가 돌려주는 획 RGBA를 옛 경로와 직접 겨뤘다: 합 55.01초 →
    15.79초(**3.48배**), 좌표까지 **17/17 바이트 동일**.

    두 단, 실측(같은 17개 뷰):

    - **빠른 경로** — 잎을 뷰포트로 부풀리지 않는다. 처음엔 12뷰만 통과해 5.2~9.5배
      였고, 나머지 5뷰를 막던 것은 전부 `clipping`이었다(뷰당 잎 1~3장).
      `allow_clipping=True`로 열어 **17뷰 전부** 이 경로가 됐다.

      **이 옵트인은 여기에만 준다. `merge_rgba`(내보내기)는 안 준다.** 이유는
      클리핑이 아니라 빠른 경로 자체가 psd.composite와 원리적으로 비트 동일이
      아니어서다 — 잎을 평평하게 접느냐 그룹마다 접느냐로 float32의 마지막 비트가
      갈린다(`_fast_mergeable` docstring에 한 픽셀짜리 증거가 있다). 내보내기는
      납품 26장 대조가 계약이라 인구를 넓히지 않고, 여기는 산출물이 획 RGBA이고
      샘플 넷·뷰 17개에서 17/17 바이트 동일로 실측됐다. **관측이지 보증이 아니다** —
      캐릭터 파일에서 획이 달라 보이면 이것을 먼저 의심할 것.
    - **좁은 필터** — 그래도 남겨 둔 대비책이다. 옛 필터는
      `id(l) in wanted or l.is_group()`이라 **문서의 보이는 그룹을 전부** 통과시켰고,
      그러면 이 뷰가 아무것도 원하지 않는 그룹까지 뷰포트 크기로 매번 다시 합성됐다
      (#001은 그룹이 32개다). 조상만 남기면 **1.4~2.2배**, 잰 7뷰 전부 바이트 동일.

    타일링(`_merge_rgba_tiled`)은 재고 뺐다 — 당시 막혀 있던 5뷰에서 3.72→3.49초,
    3.34→3.35초로 이득이 없었다. 뷰포트가 0.1~3.1 Mpx라 2048px 타일로는 갈리지
    않는다. 내보내기에서 2.38배였던 것은 거기 뷰포트가 54 Mpx급이기 때문이다.
    """
    visible = [l for l in colour_layers if l.is_visible() and l.bbox != (0, 0, 0, 0)]
    if visible and render.FAST_MERGE and render._fast_mergeable(
            psd, visible, allow_clipping=True):
        return render._merge_rgba_fast(psd, visible, box)[0]
    # 조상까지 포함해야 한다. 잎만 통과시키면 그 위 그룹이 필터에서 걸려 재귀가
    # 거기서 멈추고, 잎에 닿지도 못한다.
    #
    # `.visible` 항은 남겨야 한다. `layer_filter`를 주면 psd.composite의 기본
    # 필터(`Layer.is_visible`)를 **대체**한다 — 더해지는 것이 아니다
    # (psd_tools/composite/composite.py: `layer_filter = layer_filter or
    # Layer.is_visible`). 빼면 `wanted` 안의 숨은 잎이 그대로 그려지고, 숨은
    # 조상 그룹도 통과해 그 아래가 통째로 뚫린다.
    #
    # 자기 플래그만 봐도 충분한 이유는 위 docstring과 같다 — 재귀가 숨은
    # 그룹에서 멈춘다. `render.py`의 BG 경로(render_thumbnails)도 같은 이유로
    # `.visible`을 쓴다.
    wanted = render._wanted_ids(psd, colour_layers)
    img = psd.composite(
        viewport=box, force=True, color=1.0, alpha=0.0,
        layer_filter=lambda l: l.visible and id(l) in wanted,
    )
    return np.array(img.convert("RGBA"))


def _view_ancestors(psd, layer):
    out = []
    cur = layer.parent
    while cur is not None and cur is not psd:
        out.append(cur)
        cur = cur.parent
    return out


@contextmanager
def _opacity_neutralised(psd, layers):
    """레이어들과 그 조상의 불투명도를 잠시 255로 — 검출용 색 그림 전용.

    아티스트는 색 참조를 선화 위에 **반투명으로** 얹어 두곤 한다 — 실납품에서
    캐릭터 그룹 36/255(14%)짜리 판이 나왔다. 화면 미리보기·내보내기는 불투명도를
    평평하게 무시하므로 색이 선명해 보이는데, 검출용 합성만 원본 불투명도를
    적용하면 알파 14%짜리 유령 그림이 검출기에 들어가 획이 0이 된다 — 증상은
    "구조(캐릭터 그룹/COLORS/LINES)가 맞는데 라인 생성이 안 됨"이고, 화면에선
    색이 선명해서 원인이 안 보인다.

    전수 감사(HH0305 캐릭터 100장 + 신고 판 2장, 뷰 346개, 2026-08-12,
    .superpowers/sdd/opacity-neutral-colour/): 불투명도 전부 255인 **337개 뷰는
    바이트 동일**, 변화는 반투명이 낀 3개 파일뿐이고 전부 "반투명 때문에 문턱
    아래로 묻혔던 경계에 획이 생기는" 방향이었다(0→81k px 둘, 기존 획 +5% 하나).

    fill 불투명도(BLEND_FILL_OPACITY)는 건드리지 않는다 — 같은 감사에서 255가
    아닌 것이 0건이라, 없는 인구를 위해 tagged block 쓰기를 얹지 않는다.

    복원은 finally다. 세션의 psd 객체는 뒤이은 요청들이 그대로 읽으므로(stdin
    직렬이라 겹치지는 않는다), 합성 도중 예외가 나도 원값이 남아야 한다.
    """
    targets, seen = [], set()
    for l in layers:
        for node in [l] + _view_ancestors(psd, l):
            if id(node) not in seen:
                seen.add(id(node))
                targets.append(node)
    saved = [(node, node.opacity) for node in targets]
    try:
        for node in targets:
            node.opacity = 255
        yield
    finally:
        for node, op in saved:
            node.opacity = op


def overlay_for_view(session, colour_ids, line_ids, opts):
    """
    뷰 하나의 획 오버레이. 그릴 것이 없으면 None.

    색 레이어를 **합성해서** 본다. 레이어별 알파 경계를 쓰면 다른 레이어에 가려져
    실제로는 보이지 않는 경계까지 후보가 되기 때문이다(모듈 docstring 참고).

    합성할 때 색 레이어·조상의 불투명도는 무시한다(_opacity_neutralised) —
    미리보기·내보내기와 같은 눈으로 봐야, 반투명 색 참조 판에서 검출이 조용히
    죽지 않는다.

    뷰포트는 색 레이어들의 합집합이다. 기존 라인은 그 좌표계로 옮겨 담는다 —
    라인이 색보다 넓어도 겹치는 부분만 있으면 된다.
    """
    layers_by_id = session["layers_by_id"]
    colour_layers = [layers_by_id[i] for i in colour_ids]
    box = _union_bbox(colour_layers)
    if box is None:
        return None

    o = {**EDGE_DEFAULTS, **(opts or {})}
    with _opacity_neutralised(session["psd"], colour_layers):
        if o.get("colourMode") == "paste":
            # paste는 원본 픽셀을 그대로 붙여 원래도 불투명도를 안 읽지만,
            # 두 모드가 같은 규약 아래 있다는 것을 코드 모양으로 남긴다.
            colour_rgba = _paste_colour(colour_layers, box)
        else:
            colour_rgba = _composite_colour(session["psd"], colour_layers, box)
    line_alpha = _paste_alpha(
        _drop_filled(
            [layers_by_id[i] for i in line_ids], box, o["lineAlpha"]),
        box)

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
