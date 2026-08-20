"""이름 규칙이 놓친 "선으로 그려진" 드로잉 레이어의 픽셀 증거.

여기는 수치만 잰다 — 무엇을 라인으로 지정할지는 프런트가 정한다
(src/lib/detectDrawnLines.ts). 규칙(문턱)을 엔진에 두면 프리셋 어휘처럼
두 구현이 갈라질 자리가 하나 늘 뿐이다.

수학은 2026-08-18~19 실측(납품 BG 26장 드로잉 레이어 1,756장 + CH 디자인
시트)을 그대로 옮긴 것이다: 이름으로 잡힌 라인 382장의 99%가 침식 생존율
(survive2) 0.5 미만이고, 채색 면은 중앙값 0.935다. 다운스케일 방식까지
그 측정과 같아야 문턱이 의미를 갖는다 — 여기 수식을 바꾸면 문턱도 다시
재야 한다.
"""
import numpy as np
from PIL import Image

from .render import extract_rgba

#: 측정 해상도. 실측 보정이 이 크기에서 이뤄졌다.
MAX_SIDE = 512

#: 이보다 불투명 픽셀이 적으면(측정 해상도 기준) 부스러기라 잰 값이 무의미하다.
MIN_OPAQUE = 20


def measure_strokes(layer):
    """잎 하나의 굵기 특징 — 디코드 포함 래퍼. 잴 수 없으면 None."""
    return measure_strokes_rgba(extract_rgba(layer))


def measure_strokes_rgba(rgba):
    """
    디코드된 rgba의 굵기 특징. 잴 수 없으면(빈 그림·부스러기) None.

    코어를 분리한 이유: 전체 캐시 스윕은 타일을 구우며 이미 디코드한 rgba를
    들고 있다 — 같은 잎을 두 번 디코드하지 않으려면 배열로 직접 재야 한다.
    두 경로(래퍼·코어)가 같은 수식을 타야 문턱이 하나로 성립한다.

    - coverage: 자기 bbox에서 불투명 픽셀의 비율. 선은 작다(실측 1~9%).
    - survive1/survive2: 가장자리를 1픽셀씩 한 번/두 번 깎았을 때 살아남는
      불투명 픽셀의 비율. 가는 획은 전멸하고 채색 면은 테두리만 잃는다.
    - nNative: 원본 해상도 기준 불투명 픽셀 수 추정치. 부스러기 가드용.
    """
    h, w = rgba.shape[:2]
    if w == 0 or h == 0:
        return None
    scale = min(1.0, MAX_SIDE / max(w, h))
    if scale < 1.0:
        img = Image.fromarray(rgba).resize(
            (max(1, int(w * scale)), max(1, int(h * scale)))
        )
        rgba = np.asarray(img)
    alpha = rgba[..., 3] > 32
    n = int(alpha.sum())
    if n < MIN_OPAQUE:
        return None
    core = alpha.copy()
    core[1:] &= alpha[:-1]
    core[:-1] &= alpha[1:]
    core[:, 1:] &= alpha[:, :-1]
    core[:, :-1] &= alpha[:, 1:]
    core2 = core.copy()
    core2[1:] &= core[:-1]
    core2[:-1] &= core[1:]
    core2[:, 1:] &= core[:, :-1]
    core2[:, :-1] &= core[:, 1:]
    return {
        "coverage": round(n / alpha.size, 4),
        "survive1": round(int(core.sum()) / n, 4),
        "survive2": round(int(core2.sum()) / n, 4),
        "nNative": int(n / (scale * scale)) if scale < 1.0 else n,
    }


def select_drawn_line_candidates(tree, matched_ids, preset,
                                 exclude_groups, exclude_tokens_extra):
    """
    프런트 drawnLineCandidateIds(detectDrawnLines.ts)의 미러. 배치는 화면 없이
    돌므로 여기서 같은 후보를 골라야 대화형 경로와 산출물이 갈리지 않는다.
    어휘 '값'은 프런트가 payload로 보낸다 — 정책은 프런트, 여기는 실행이라는
    분업 그대로다(프리셋 규칙이 이미 그렇게 온다). 저쪽 규칙을 바꾸면 여기도
    같이 볼 것.
    """
    from .names import has_any_token

    matched = set(matched_ids)
    prefixes = tuple(preset.get("excludeGroupPrefixes") or ())
    tokens = list(preset.get("excludeTokens") or []) + list(exclude_tokens_extra)
    groups = {(g or "").strip().lower() for g in exclude_groups}
    out = []

    def walk(nodes):
        for node in nodes:
            name = (node.get("name") or "").strip()
            if node["kind"] == "group":
                if prefixes and name.startswith(prefixes):
                    continue
                if name.lower() in groups:
                    continue
                if has_any_token(name, tokens):
                    continue
                walk(node.get("children") or [])
                continue
            if node["kind"] != "pixel":
                continue
            if node.get("hasPixels") is False:
                continue
            if node["id"] in matched:
                continue
            if node.get("blendMode") != "normal":
                continue
            if has_any_token(name, tokens):
                continue
            out.append(node["id"])

    walk(tree)
    return out


def judge_drawn_lines(features, candidate_ids, policy):
    """프런트 judgeDrawnLines의 미러. features는 사이드카({lid 문자열: f|None}),
    문턱 값은 policy(survive2Max·coverageMax·minNativePx — 프런트가 보냄)."""
    out = []
    for lid in candidate_ids:
        f = features.get(str(lid))
        if not f:
            continue
        if (f["survive2"] < policy["survive2Max"]
                and f["coverage"] < policy["coverageMax"]
                and f["nNative"] >= policy["minNativePx"]):
            out.append(lid)
    return sorted(out)
