"""
FLORIDA 배경 파일의 color_to_line — 그려진 라인 레이어만으로 라인 그림을 만든다.

color_to_line의 일반 경로(imageline.py)는 문서 구조를 추측해 라인 레이어를
모으고, 빠진 곳을 렌더 이미지의 색 경계·명암 대비로 **생성**해 채운다. 그 생성
단계가 이 스타일의 칠 질감·무늬·글자에서 얼룩을 만든다(2026-09-04, FL102 BG
129장 실측: 기둥의 나뭇결 반점, 벽지 무늬의 굵은 검정 띠, 간판 글자 윤곽).
아티스트 지시는 "프리셋은 color_to_line 하나, 다른 파일의 라인은 그대로, 이
스타일 배경만 다르게" — 그래서 imageline.extract_image_line이 FLORIDA 배경
파일(이름 규칙 _is_fl102_document)만 이 경로로 보낸다. 프리셋 설정은 바뀌지
않는다.

이 프로파일은 생성 단계가 없다. 아티스트가 실제로 그린 잉크 레이어의 알파를
그대로 합칠 뿐이다 — 이름이 line인 레이어(LINE·Line·flower line·courtlines·OL)
와, 이름은 물체(chair·table·Layer 106)인데 픽셀이 가는 획인 레이어. 뒤쪽은
굵기 검사로 가른다: 1픽셀씩 두 번 깎았을 때 살아남는 비율(survive2)이 낮고,
자기 bbox 안의 칠 비율(coverage)이 작고, 긴 획 성분에 픽셀이 몰려 있어야
한다(long_ratio — 먼지·질감 반점은 전부 짧은 성분이라 여기서 떨어진다).

잉크가 없는 물체 하나만 예외다: 구름·태양·원경 건물처럼 **잉크 없이 칠로만
그린 모양**은 그 잎의 알파 실루엣을 윤곽선으로 만든다(아티스트가 준 기준
그림 FL102_BG_LINE_fixed7.png에 구름·태양 윤곽이 있다). 렌더 이미지의 색
경계가 아니라 잎 알파의 경계라서 질감·음영 얼룩이 나오지 않는다. 잉크가 있는
물체(그룹 안 어디든 잉크 잎이 있으면)는 실루엣을 만들지 않는다 — 그 물체의
라인은 아티스트가 그렸다.

그 밖에는 아무것도 만들지 않으므로, 잉크도 칠 모양도 없는 파일(사진·무늬·
스마트 오브젝트만 있는 판)은 빈 그림이 된다. 그것이 이 프로파일의 약속이다 —
"이미지의 라인만".
"""
import re

import numpy as np
from PIL import Image

from .imageline import (
    _composite_layer_alpha,
    _is_non_art_line_layer,
    _keep_visible_outline,
    _remove_large_solid_interiors,
    _remove_short_components,
    _rendered_edge_support,
    _shape_outline_alpha,
)

PROFILE = "inkLayers"

#: 이름만으로 잉크로 받는 낱말. 복수형은 아래 _has_ink_word가 받는다.
#: `OL`은 넣지 않는다 — FL102에서 `barrier OL`은 앞쪽 물체 **그룹** 이름이라
#: (칠·음영·먼지가 다 들어 있다) 잉크 낱말로 받으면 그 그룹 전체가 라인이 된다.
#: 그 안의 잉크 잎 `barrier ol`은 굵기 검사가 잡는다.
INK_WORDS = frozenset({"line", "lineart", "outline", "ink"})
#: 참고·안내 그룹 — 보이더라도 아래는 안 본다. 이름이 line인 잎이 그 안에
#: 있어도 마찬가지다(안내선·러프 스케치).
EXCLUDED_GROUP_WORDS = frozenset({
    "persp", "guide", "guides", "grid", "ref", "refs", "rough", "template",
    "note", "notes", "screenshot", "sketch",
})
#: 이름이 없는 잎(Layer 12)이 아니라 채색 어휘로 불리는 잎은 굵기 검사도 하지
#: 않는다 — 검사 비용을 아끼고, 얇은 하이라이트 획이 잉크로 새는 문을 닫는다.
SHADING_WORDS = frozenset({
    "fill", "fills", "color", "colour", "colors", "colours", "shad", "shade",
    "shadow", "shadows", "s", "hl", "highlight", "highlights", "light",
    "lights", "grad", "gradient", "glow", "dirt", "texture", "textures",
    "grain", "noise", "atmosphere", "atmo", "fog", "haze",
})

#: 굵기 검사 문턱. FL102 BG 129장의 잎 전수 측정(2026-09-04)으로 정한 값 —
#: 근거와 경계 사례는 .superpowers/sdd/fl102-bg-line-style/ 에 있다.
#:
#: 측정 배율은 **문서** 크기로 정한다(잎 크기가 아니라). 한 문서의 잉크 굵기는
#: 물체가 작든 크든 같으므로, 잎마다 제 크기로 줄이면 작은 물체(의자·마이크)의
#: 잉크만 굵게 재어져 떨어진다 — 실제로 그렇게 떨어진 것을 보고 바꿨다.
MEASURE_SIDE = 2048
#: 두 띠: 아주 가늘면(survive2<0.10) 칠 비율과 무관하게 획이다 — 깃대·전선처럼
#: bbox가 꽉 끼는 가는 잎은 coverage가 0.5를 넘는다. 덜 가늘면(<0.25) 칠 비율이
#: 작아야 한다. 이름 line인 잎 690장의 coverage 99퍼센타일이 0.39였다.
SURVIVE2_THIN = 0.10
SURVIVE2_MAX = 0.25
COVERAGE_MAX = 0.20
LONG_RATIO_MIN = 0.50
LONG_EXTENT = 16
#: 이름 없는 획 잎이 실효 불투명도 50% 미만이면 러프·안내 스케치다(실측 9장,
#: 20~43%). 이름이 line이면 아티스트가 일부러 옅게 둔 것이라 그대로 받는다.
FAINT_OPACITY = 128
#: 부스러기 가드 — 문서 넓이에 비례한다(5100x3300에서 약 420픽셀). 작은 픽스처
#: 문서에서도 같은 규칙이 성립하도록 절대값 대신 비율로 둔다.
MIN_NATIVE_RATIO = 2.5e-5
MIN_NATIVE_FLOOR = 20
#: 이름이 line이어도 통째로 칠한 판(보라 바닥 같은 것)은 뺀다.
PLATE_SURVIVE2_MIN = 0.85
PLATE_COVERAGE_MIN = 0.50
#: 잉크 없는 물체의 실루엣. 캔버스를 거의 다 덮는 판(하늘·바닥 밑칠)은 모양이
#: 아니라 배경이라 빼고, 불투명한 심(≥SILHOUETTE_CORE_ALPHA)이 있어야 한다 —
#: 글로·안개처럼 흐린 잎은 심이 없어 저절로 빠진다.
SILHOUETTE_BOUNDED = 0.98
SILHOUETTE_CORE_ALPHA = 200
SILHOUETTE_MIN_CORE_RATIO = 0.01
#: 실루엣은 **물체**에만 — 문서의 15%를 넘는 칠(하늘·수면·바닥판·회색 배경판)은
#: 배경이라 윤곽을 만들면 지평선 같은 가짜 선이 생긴다(실측: 구름·원경 건물·
#: 덤불은 6% 이하, 하늘·수면은 20~78%).
SILHOUETTE_MAX_AREA_RATIO = 0.15
#: 윤곽 픽셀이 심 픽셀의 이 비율을 넘으면 덩어리가 아니다 — 스프레이·점묘
#: 질감(윤곽 ≈ 심의 2배)이나 가는 틀. 구름·건물·덤불 같은 덩어리는 2~8%다.
SILHOUETTE_MAX_OUTLINE_RATIO = 0.35
#: 실루엣 심의 최소 픽셀 — 문서 넓이 비례(5100x3300에서 약 2,000픽셀).
SILHOUETTE_MIN_CORE_AREA_RATIO = 1.2e-4
SILHOUETTE_MIN_CORE_FLOOR = 50

_WORD = re.compile(r"[^\W_]+")


def _words(name):
    return [w.casefold() for w in _WORD.findall(name)]


def _is_line_typo(word):
    """글자 하나가 끼어든 오타(LIKNE·linne). 실제 파일에 있었다(사진 그룹의 LIKNE).

    글자 하나를 빼서 line/lines가 되는 낱말만 받는다 — 바꿔치기(lime·lane·pine·
    vine)는 다른 뜻의 진짜 낱말이 너무 많아 받지 않는다. linen은 뺀다."""
    if word == "linen" or len(word) not in (5, 6):
        return False
    target = "line" if len(word) == 5 else "lines"
    return any(word[:i] + word[i + 1:] == target for i in range(len(word)))


def _has_ink_word(name):
    """
    낱말 단위로만 본다. 부분 문자열(`courtlines`·`waterline`)은 받지 않는다 —
    `Cordyline shrub`(식물 이름)이 라인 그룹으로 읽혀 덤불 칠이 통째로 검게
    나왔다(실측 #043). 붙여 쓴 진짜 라인은 굵기 검사가 잡는다.
    """
    for word in _words(name):
        if word in INK_WORDS or (word.endswith("s") and word[:-1] in INK_WORDS):
            return True
        if _is_line_typo(word):
            return True
    return False


def is_named_ink_layer(name):
    """이름이 그려진 라인을 가리키는가. 안내선(horizon line 등)은 아니다."""
    return _has_ink_word(name) and not _is_non_art_line_layer(name)


def _is_excluded_group(name):
    return any(word in EXCLUDED_GROUP_WORDS for word in _words(name))


def _is_shading_name(name):
    words = _words(name)
    return bool(words) and all(word in SHADING_WORDS or word.isdigit()
                               for word in words) and not all(
        word.isdigit() for word in words)


def stroke_features(alpha, document_side=None):
    """
    잎 알파 하나의 굵기 특징. 잴 수 없으면(거의 빈 잎) None.

    - coverage: bbox 안의 불투명 비율. 잉크는 작다.
    - survive2: 가장자리를 1픽셀씩 두 번 깎고 남는 비율. 가는 획은 전멸한다.
    - long_ratio: 긴 성분(extent ≥ LONG_EXTENT)에 속한 불투명 픽셀 비율.
      먼지·질감 반점은 전부 짧은 성분이라 낮고, 획은 높다.
    - nNative: 원본 해상도 기준 불투명 픽셀 수(부스러기 가드).

    document_side가 있으면 그 긴 변이 MEASURE_SIDE가 되는 배율로 잎을 줄인다
    (없으면 잎 자신의 긴 변 기준).
    """
    h, w = alpha.shape
    if w == 0 or h == 0:
        return None
    scale = min(1.0, MEASURE_SIDE / max(document_side or 0, w, h))
    if scale < 1.0:
        alpha = np.asarray(Image.fromarray(alpha, "L").resize(
            (max(1, int(w * scale)), max(1, int(h * scale))),
            Image.Resampling.BOX,
        ))
    # bbox 가장자리는 투명이다 — 안 두르면 bbox에 꽉 끼는 가는 잎(깃대·전선)의
    # 테두리 픽셀이 깎이지 않아 굵은 것으로 잰다.
    solid = np.pad(alpha > 32, 1)
    n = int(solid.sum())
    if n < 20:
        return None
    core = solid.copy()
    core[1:] &= solid[:-1]
    core[:-1] &= solid[1:]
    core[:, 1:] &= solid[:, :-1]
    core[:, :-1] &= solid[:, 1:]
    core2 = core.copy()
    core2[1:] &= core[:-1]
    core2[:-1] &= core[1:]
    core2[:, 1:] &= core[:, :-1]
    core2[:, :-1] &= core[:, 1:]
    long_components = _remove_short_components(
        solid, LONG_EXTENT, count_area=False)
    return {
        "coverage": round(n / solid.size, 4),
        "survive2": round(int(core2.sum()) / n, 4),
        "longRatio": round(int(long_components.sum()) / n, 4),
        "nNative": int(n / (scale * scale)) if scale < 1.0 else n,
    }


def _looks_like_ink(feats, min_native):
    thin = (
        feats["survive2"] < SURVIVE2_THIN
        or (feats["survive2"] < SURVIVE2_MAX
            and feats["coverage"] < COVERAGE_MAX)
    )
    return (
        thin
        and feats["longRatio"] >= LONG_RATIO_MIN
        and feats["nNative"] >= min_native
    )


def _looks_like_strokes(feats):
    """획 모양인가(부스러기·불투명도와 무관). 실루엣은 획에 씌우지 않는다 —
    획의 윤곽은 이중선이다."""
    return feats["survive2"] < SURVIVE2_MAX and feats["longRatio"] >= LONG_RATIO_MIN


def _looks_like_plate(feats):
    return (
        feats["survive2"] >= PLATE_SURVIVE2_MIN
        and feats["coverage"] >= PLATE_COVERAGE_MIN
    )


#: 획 모양만으로 잉크로 받을 수 있는 블렌드. 오버레이·스크린 따위의 얇은 획은
#: 하이라이트지 잉크가 아니다(이름이 line이면 블렌드와 무관하게 받는다).
INK_BLEND_MODES = frozenset({"NORMAL", "MULTIPLY", "DARKEN", "LINEAR_BURN"})


def _blend_name(layer):
    return str(layer.blend_mode).split(".")[-1]


def _layer_rgba(layer):
    if layer.has_mask() and not getattr(layer.mask, "disabled", False):
        # 마스크가 있으면 마스크가 적용된 모양이 화면의 모양이다(129장 중 13잎).
        try:
            image = layer.composite()
        except (ImportError, NotImplementedError):
            image = layer.topil()
    else:
        image = layer.topil()
    if image is None:
        return None
    return np.array(image.convert("RGBA"), dtype=np.uint8)


def _layer_alpha(layer):
    rgba = _layer_rgba(layer)
    return None if rgba is None else rgba[..., 3]


def _darkness_alpha(rgba):
    """
    곱하기(MULTIPLY) 잎의 실제 기여 — 알파 × 어두움.

    스캔한 선화를 흰 종이째 곱하기로 얹은 잎은 알파가 전부 255다. 알파를 그대로
    쓰면 사진 한 장이 검은 판이 된다(사진 그룹의 `LINE` MULTIPLY 잎이 그랬다).
    곱하기에서 흰색은 아무 영향이 없고 검정만 남으므로, 어두움이 곧 선이다.
    """
    rgb = rgba[..., :3].astype(np.uint16)
    lum = (rgb[..., 0] * 77 + rgb[..., 1] * 150 + rgb[..., 2] * 29) >> 8
    return (
        (rgba[..., 3].astype(np.uint16) * (255 - lum) + 127) // 255
    ).astype(np.uint8)


def _clip_base(siblings, index):
    """클리핑 잎의 바탕 — 아래쪽으로 가장 가까운 비클리핑 잎(psd-tools는 아래→위 순서)."""
    for candidate in reversed(siblings[:index]):
        if not candidate.clipping:
            return candidate
    return None


def _intersect_with_base(alpha, layer, base):
    """
    클리핑 잎은 바탕의 알파만큼만 보인다 — 포토샵처럼 두 알파를 곱한다.

    ≥8 같은 문턱으로 자르면 잉크 위의 색 판(전부 불투명)이 잉크의 안티에일리어싱
    가장자리를 255로 덮어 선이 굵고 계단지게 나온다. 곱하면 색 판은 정확히 잉크
    알파가 되고, 사진 위의 LINE은 사진이 있는 곳에서만 남는다.
    """
    base_alpha = _layer_alpha(base)
    if base_alpha is None:
        return np.zeros_like(alpha)
    left, top, _, _ = layer.bbox
    b_left, b_top, _, _ = base.bbox
    out = np.zeros_like(alpha)
    x0 = max(left, b_left)
    y0 = max(top, b_top)
    x1 = min(left + alpha.shape[1], b_left + base_alpha.shape[1])
    y1 = min(top + alpha.shape[0], b_top + base_alpha.shape[0])
    if x1 <= x0 or y1 <= y0:
        return out
    region = alpha[y0 - top:y1 - top, x0 - left:x1 - left].astype(np.uint16)
    support = base_alpha[
        y0 - b_top:y1 - b_top, x0 - b_left:x1 - b_left].astype(np.uint16)
    out[y0 - top:y1 - top, x0 - left:x1 - left] = (
        (region * support + 127) // 255).astype(np.uint8)
    return out


def collect_ink_layers(psd):
    """
    잉크 잎을 고른다. 결과는 판단 기록이다 — 채택·기각 모두 이유와 특징을 남겨
    전수 검사 스크립트가 그대로 표로 만든다.

    반환: {"accepted": [...], "rejected": [...]} 각 항목은
    {"path", "name", "reason", "features", "opacity", "layer", "alpha"}.
    """
    accepted = []
    rejected = []
    silhouettes = []
    document_side = max(psd.width, psd.height)
    document_area = psd.width * psd.height
    min_native = max(MIN_NATIVE_FLOOR, round(document_area * MIN_NATIVE_RATIO))
    min_core = max(SILHOUETTE_MIN_CORE_FLOOR,
                   round(document_area * SILHOUETTE_MIN_CORE_AREA_RATIO))
    #: 그룹마다 "안에 잉크 잎이 있는가" — 실루엣은 잉크 없는 물체에만 만든다.
    ink_inside = {}
    edge_support = [None]

    accepted_ids = set()

    def note(bucket, layer, path, reason, feats, opacity=255, alpha=None):
        bucket.append({
            "path": path, "name": layer.name, "reason": reason,
            "features": feats, "opacity": opacity, "layer": layer,
            "alpha": alpha,
        })
        if bucket is accepted:
            accepted_ids.add(id(layer))

    def mark_ink(ancestors):
        for group in ancestors:
            ink_inside[id(group)] = True

    def silhouette(layer, layer_path, alpha, feats):
        core = np.where(alpha >= SILHOUETTE_CORE_ALPHA, alpha, 0)
        core_pixels = int(np.count_nonzero(core))
        if (
            core_pixels < min_core
            or core_pixels < core.size * SILHOUETTE_MIN_CORE_RATIO
        ):
            note(rejected, layer, layer_path, "shapeNoCore", feats)
            return
        outline = _shape_outline_alpha(core)
        _clear_canvas_edge(outline, layer, psd)
        if (
            int(np.count_nonzero(outline >= 128))
            > core_pixels * SILHOUETTE_MAX_OUTLINE_RATIO
        ):
            # 벽의 스프레이 질감이 실루엣이 되면 점 수천 개의 윤곽이 검은
            # 덩어리로 뭉친다(실측 #026·#029).
            note(rejected, layer, layer_path, "shapeNotSolid", feats)
            return
        if edge_support[0] is None:
            edge_support[0] = _composite_edge_support(psd)
        if edge_support[0] is not None:
            # 앞 물체에 가려진 부분의 윤곽은 렌더에 없다 — 거기 선을 긋지 않는다.
            _keep_visible_outline(outline, layer, edge_support[0])
        if not np.any(outline):
            note(rejected, layer, layer_path, "shapeHidden", feats)
            return
        note(silhouettes, layer, layer_path, "silhouette", feats, 255, outline)

    def walk(group, path, inherited_line, opacity, ancestors):
        siblings = list(group)
        #: 이 그룹의 실루엣 후보(칠 모양). 그룹 걷기가 끝나면 안에 잉크가
        #: 있는지 확정되므로 그때 판단하고 알파를 버린다 — 파일 전체의 칠
        #: 잎을 다 들고 있으면 큰 판에서 메모리가 GB 단위로 오른다.
        shapes = []
        for index, layer in enumerate(siblings):
            layer_path = f"{path}/{layer.name}" if path else layer.name
            if not layer.is_visible():
                continue
            if layer.is_group():
                if _is_excluded_group(layer.name):
                    continue
                child_opacity = (opacity * int(layer.opacity) + 127) // 255
                ink_inside.setdefault(id(layer), False)
                walk(layer, layer_path,
                     inherited_line or is_named_ink_layer(layer.name),
                     child_opacity, ancestors + [layer])
                continue
            if layer.bbox == (0, 0, 0, 0):
                continue
            if layer.kind != "pixel":
                # 글자(type)·스마트 오브젝트·단색 채우기는 그린 라인이 아니다.
                note(rejected, layer, layer_path, f"kind:{layer.kind}", None)
                continue
            if _is_non_art_line_layer(layer.name):
                # horizon line·height line·notes — 이름이 안내선이라고 말하면
                # 획 모양이 어떻든 라인이 아니다.
                note(rejected, layer, layer_path, "guideName", None)
                continue
            named = inherited_line or is_named_ink_layer(layer.name)
            if layer.clipping and not named:
                # 클리핑 잎은 바탕에 색을 입힐 뿐이다(라인 색 판).
                continue
            if not named and _is_shading_name(layer.name):
                note(rejected, layer, layer_path, "shadingName", None)
                continue
            if not named and _blend_name(layer) not in INK_BLEND_MODES:
                note(rejected, layer, layer_path,
                     f"blend:{_blend_name(layer)}", None)
                continue
            base = _clip_base(siblings, index) if layer.clipping else None
            if layer.clipping and base is None:
                continue
            if base is not None and id(base) in accepted_ids:
                # 잉크 위의 클리핑 잎(라인 색 판)은 바탕보다 넓게 보일 수 없다 —
                # 바탕이 이미 들어갔으니 더할 것이 없다. 합치면 안티에일리어싱
                # 가장자리가 두 번 겹쳐 선이 굵어진다.
                note(rejected, layer, layer_path, "clipOverInk", None)
                continue
            rgba = _layer_rgba(layer)
            if rgba is None:
                continue
            multiply = _blend_name(layer) in {"MULTIPLY", "DARKEN",
                                              "LINEAR_BURN"}
            alpha = _darkness_alpha(rgba) if multiply else rgba[..., 3]
            if base is not None:
                alpha = _intersect_with_base(alpha, layer, base)
            feats = stroke_features(alpha, document_side)
            if feats is None:
                note(rejected, layer, layer_path, "empty", None)
                continue
            effective = (opacity * int(layer.opacity) + 127) // 255
            if named:
                if _looks_like_plate(feats):
                    # 불투명한 판인데 이름이 line — 흰 종이째 붙인 스캔 선화일 수
                    # 있다. 어두움을 선으로 보고 다시 재서 획이면 받는다.
                    dark = _darkness_alpha(rgba)
                    if base is not None:
                        dark = _intersect_with_base(dark, layer, base)
                    dark_feats = stroke_features(dark, document_side)
                    if dark_feats is not None and _looks_like_ink(
                            dark_feats, min_native):
                        note(accepted, layer, layer_path, "namedDarkness",
                             dark_feats, effective, dark)
                        mark_ink(ancestors)
                        continue
                    note(rejected, layer, layer_path, "namedPlate", feats)
                    continue
                note(accepted, layer, layer_path, "named", feats, effective,
                     alpha)
                mark_ink(ancestors)
                continue
            if _looks_like_ink(feats, min_native):
                if effective < FAINT_OPACITY:
                    note(rejected, layer, layer_path, "faint", feats)
                    continue
                note(accepted, layer, layer_path, "strokes", feats, effective,
                     alpha)
                mark_ink(ancestors)
                continue
            if (
                group is not psd
                and not layer.clipping
                and _blend_name(layer) == "NORMAL"
                and _is_bounded_shape(layer, psd)
                and not _looks_like_strokes(feats)
                and feats["nNative"] <= document_area * SILHOUETTE_MAX_AREA_RATIO
            ):
                shapes.append((layer, layer_path, alpha, feats))
            else:
                note(rejected, layer, layer_path, "paint", feats)
        group_has_ink = group is not psd and ink_inside.get(id(group), False)
        for layer, layer_path, alpha, feats in shapes:
            if group_has_ink:
                note(rejected, layer, layer_path, "shapeInInkedGroup", feats)
            else:
                silhouette(layer, layer_path, alpha, feats)
        shapes.clear()

    walk(psd, "", False, 255, [])
    return {"accepted": accepted, "rejected": rejected,
            "silhouettes": silhouettes}


#: 캔버스 가장자리에서 잘린 모양(위쪽이 잘린 구름)은 그 가장자리를 따라 직선
#: 윤곽이 생긴다 — 그림에 없는 선이다. 캔버스 경계에 닿은 변은 지운다.
CANVAS_EDGE_TRIM = 3


def _clear_canvas_edge(outline, layer, psd):
    left, top, right, bottom = layer.bbox
    if top <= 0:
        outline[:CANVAS_EDGE_TRIM - top if top < 0 else CANVAS_EDGE_TRIM, :] = 0
    if left <= 0:
        outline[:, :CANVAS_EDGE_TRIM - left if left < 0 else CANVAS_EDGE_TRIM] = 0
    if bottom >= psd.height:
        cut = CANVAS_EDGE_TRIM + (bottom - psd.height)
        outline[-cut:, :] = 0
    if right >= psd.width:
        cut = CANVAS_EDGE_TRIM + (right - psd.width)
        outline[:, -cut:] = 0


def _is_bounded_shape(layer, psd):
    return (
        layer.width < psd.width * SILHOUETTE_BOUNDED
        and layer.height < psd.height * SILHOUETTE_BOUNDED
    )


def _composite_edge_support(psd):
    """포토샵이 저장한 합성 이미지의 눈에 보이는 경계(가림 판정용)."""
    embedded = psd.composite(force=False)
    if embedded is None:
        return None
    rgba = np.array(embedded.convert("RGBA"), dtype=np.uint8)
    if not np.any(rgba != rgba[0, 0]):
        return None
    return _rendered_edge_support(rgba)


#: 이름과 무관하게 잉크 경로로 보내는 **스타일 판정** — 칠한 배경 파일. 물체
#: 그룹(밑칠 + 클리핑 음영 잎 S·HL·shad·grad…) 하나 이상, 클리핑 음영 잎 둘
#: 이상. 실측(2026-09-04, 트리 전수): FL102 107/129, Hazbin 배경 55/57, 캐릭터
#: 6/74, 소품 3/47, 다른 쇼 표본 12/135. 캐릭터·소품 쪽 걸림은 전부 턴어라운드
#: 시트(TURN 그룹)라 아래 제외 목록이 거른다 — 그 파일들은 일반 경로의 색 경계선
#: 생성이 필요하다. 이 구조의 배경에서 일반 경로는 칠 질감을 점 얼룩으로 뿌린다
#: (FL102·Hazbin 배경 실측 둘 다) — 그래서 배경이면 잉크 경로다.
PAINTED_BG_MIN_CLIP_SHADING = 2
PAINTED_BG_MIN_OBJECT_GROUPS = 1
#: 디자인 시트의 최상위 그룹 — 있으면 배경 파일이 아니다.
DESIGN_SHEET_ROOT_KEYS = frozenset({
    "turn", "turnaround", "crowd", "colorpalette", "colourpalette",
    "extraref", "fillable", "posesnote",
})


def has_painted_object_groups(psd):
    """칠한 배경 파일인가 — 트리만 본다(디코드 없음)."""
    from .imageline import _object_key

    if any(
        layer.is_group() and _object_key(layer.name) in DESIGN_SHEET_ROOT_KEYS
        for layer in psd
    ):
        return False
    document_area = psd.width * psd.height
    clip_shading = 0
    object_groups = 0

    def walk(group, depth):
        nonlocal clip_shading, object_groups
        has_fill = has_clip_shading = False
        for layer in group:
            if layer.is_group():
                walk(layer, depth + 1)
                continue
            if layer.bbox == (0, 0, 0, 0):
                continue
            shading = _is_shading_name(layer.name)
            if layer.clipping:
                if shading:
                    clip_shading += 1
                    has_clip_shading = True
            elif layer.width * layer.height >= document_area * 0.02:
                has_fill = True
        if depth > 0 and has_fill and has_clip_shading:
            object_groups += 1

    walk(psd, 0)
    return (
        clip_shading >= PAINTED_BG_MIN_CLIP_SHADING
        and object_groups >= PAINTED_BG_MIN_OBJECT_GROUPS
    )


def ink_layers_alpha(session):
    """세션의 잉크 잎 알파를 하나로 합친 캔버스 마스크와 판단 요약."""
    psd = session["psd"]
    found = collect_ink_layers(psd)
    out = np.zeros((psd.height, psd.width), dtype=np.uint8)
    for item in found["accepted"] + found["silhouettes"]:
        alpha = item["alpha"]
        if item["opacity"] < 255:
            alpha = ((alpha.astype(np.uint16) * item["opacity"] + 127)
                     // 255).astype(np.uint8)
        _composite_layer_alpha(out, item["layer"], alpha)
    # 라인 잎 안의 넓은 칠(카메라 가까이의 코트 선 띠, 검게 칠한 창)은 윤곽만
    # 남긴다 — 일반 경로가 v0.4.0부터 해 온 처리와 같다. 보통 굵기의 획은
    # 건드리지 않는다(imageline._remove_large_solid_interiors 주석 참고).
    out = _remove_large_solid_interiors(out, thin_outline=True)
    summary = {
        "inkLayerProfile": PROFILE,
        "inkLayerCount": len(found["accepted"]),
        "inkNamedLayerCount": sum(
            1 for item in found["accepted"] if item["reason"] == "named"),
        "inkStrokeLayerCount": sum(
            1 for item in found["accepted"] if item["reason"] == "strokes"),
        "inkSilhouetteLayerCount": len(found["silhouettes"]),
        "inkRejectedLayerCount": len(found["rejected"]),
    }
    return np.ascontiguousarray(out), summary
