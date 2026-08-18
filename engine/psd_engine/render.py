"""픽셀 추출/병합/썸네일/미리보기.

병합(merge_rgba)은 psd-tools 합성을 그대로 쓴다 — 원본 스택 안에서 블렌드/클리핑을
그대로 살려야 하는 연산이기 때문이다.

미리보기(render_preview)는 다르다. export.py가 각 레이어를 `opacity=255,
blend_mode=normal`로 기록하므로 **내보낸 PSD는 블렌드·클리핑·불투명도가 제거된
평평한 스택**이고, 그 파일의 내장 미리보기도 alpha_composite 누적으로 만들어진다.
따라서 미리보기가 재현해야 할 대상은 원본 합성이 아니라 그 평평한 알파 합성이다.
"""
import json
import os
import re
import sys
import time
from collections import OrderedDict

import numpy as np
from PIL import Image

from . import tilecache

_HEX_COLOR = re.compile(r"#[0-9a-fA-F]{6}\Z")

#: 단계별 시간 계측. PSD_ENGINE_PERF=1이면 JSON 한 줄씩 stderr로 낸다 —
#: stdout은 RPC 채널이라 쓰면 안 된다. 값이 경로면(/로 시작) 그 파일에
#: append한다: 앱이 띄운 엔진의 stderr는 Rust가 파이프로 삼켜 마지막 50줄만
#: 남기므로(src-tauri/src/engine.rs), 실행 중인 앱을 계측할 때는 파일이
#: 유일한 통로다. 기본은 꺼짐이고 동작에는 영향이 없다.
PERF = os.environ.get("PSD_ENGINE_PERF", "")
if PERF == "0":
    PERF = ""


def _perf(**kv):
    if not PERF:
        return
    # 어느 프로세스의 일인지 없으면 타임라인이 안 갈린다 — 메인 엔진과 작업
    # 프로세스들이 한 파일에 섞여 적기 때문이다(판 20 조사에서 이것 때문에
    # 공백의 주인을 두 번 잘못 짚었다).
    kv.setdefault("pid", os.getpid())
    # 벽시계 시각을 함께 찍는다. 단계별 시간만 있으면 **그 사이에 흐른 시간**이
    # 안 보인다 — 토글 한 번이 6초인데 렌더 호출은 0.7초로 찍히던 때, 남은 5초가
    # 엔진 밖인지 요청 사이 대기인지 로그만으로는 가릴 수 없었다(2026-08-13).
    kv["t"] = round(time.time(), 3)
    line = json.dumps(kv)
    if PERF.startswith("/") or PERF.startswith("\\") or ":" in PERF[:3]:
        try:
            with open(PERF, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except OSError:
            pass
        return
    print(line, file=sys.stderr, flush=True)

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

#: 잎 썸네일의 원천으로 쓰는 미리보기 타일의 배율 기준. 앱의 미리보기 크기
#: (src/lib/preview.ts의 PREVIEW_MAX_SIZE)와 같아야 한다 — 그래야 썸네일이
#: 미리보기·워밍업·전체 캐시가 쌓아 둔 **같은 타일 캐시**를 친다.
THUMBNAIL_SOURCE_MAX_SIZE = 1500


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


def assign_line_color(entries, line_color, line_color_ids=None):
    """
    엔트리마다 "여기 덮을 색"을 정해 `lineRgb`에 박아 둔다. 형식 오류는 여기서 난다.

    **색을 엔트리에 실어 보내는 이유.** 내보내기와 검증이 반드시 같은 판단을 봐야
    하기 때문이다. 예전에는 둘이 `line_color` 문자열을 따로 받아 각자 적용했고,
    한쪽만 인자를 빠뜨리자 멀쩡한 산출물이 파일마다 "검증 실패"로 나왔다(verify.py
    docstring에 그 사고가 적혀 있다). 이제 판단은 이 함수 한 번뿐이고 내보내기·
    래스터·검증은 읽기만 하므로, 그런 식으로 갈라질 자리가 없다.

    `line_color_ids`는 색 통일을 걸 레이어 id — **프리셋 규칙에 걸린 라인 레이어**다.
    아티스트가 손으로 체크해 넣은 색 레이어는 여기 없으므로 원본 색이 남는다.
    이것이 PresetDialog가 "모든 **라인 레이어**의 색을 덮습니다"라고 약속한 범위이고,
    예전 구현은 포함된 레이어를 가리지 않고 전부 덮어 그 약속을 어겼다.
    None이면 전부 건다 — 규칙을 모르는 호출자(배치처럼 매칭된 것만 내보내는 경로)용이다.

    **병합 엔트리는 소스가 전부 대상일 때만 건다.** 색은 병합이 끝난 뒤 한 번에
    덮는데, 그것이 레이어마다 덮고 병합한 것과 같아지려면 소스가 모두 같은 색이
    되어야 하기 때문이다(entry_pixels 참고). 라인과 색 레이어를 손으로 한 엔트리에
    묶은 경우에는 색 통일을 포기하고 원본 색을 지킨다 — 지우는 쪽이 아니라 남기는
    쪽으로 기운다. 되돌리려면 병합을 풀면 된다.
    """
    rgb = parse_line_color(line_color)
    ids = None if line_color_ids is None else set(line_color_ids)
    for entry in entries:
        hit = rgb is not None and (
            ids is None or all(sid in ids for sid in entry["sourceIds"])
        )
        entry["lineRgb"] = rgb if hit else None
    return entries


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


def _mask_shape(layer, viewport):
    """
    _get_mask(621행)의 **사용자 마스크** 부분을 그대로 옮긴다. 마스크가 없거나 비면 1.0.

    벡터 마스크 가지는 옮기지 않는다 — 값싼 경로들은 벡터 마스크가 걸린 레이어를
    아예 받지 않기 때문이다(_mask_fast_ok, _plain 둘 다 막는다).

    real mask를 읽지 않는 것(real_mask=False)이 두 호출자 모두에게 맞다.
    merge_rgba는 composite를 force=True로 부르고 _get_mask가 `real_mask=not force`를
    쓰므로 그쪽도 사용자 마스크를 읽는다. _extract_rgba_masked 쪽은 force=False라
    다를 수 있어 _mask_fast_ok가 has_real()을 아예 막아 둔다.

    호출자가 `layer.mask is not None and not layer.mask.disabled`를 이미 확인했다고
    본다 — 꺼진 마스크에 이것을 걸면 composite가 걸지 않는 마스크를 거는 셈이 된다.
    """
    from psd_tools.composite.composite import paste

    mask_arr = layer.numpy("mask", real_mask=False)
    shape = 1.0
    if mask_arr is not None:
        shape = paste(viewport, layer.mask.bbox, mask_arr,
                      layer.mask.background_color / 255.0)
    if layer.mask.parameters:
        density = layer.mask.parameters.user_mask_density
        if density is None:
            density = layer.mask.parameters.vector_mask_density
        if density is None:
            density = 255
        density = float(density) / 255.0
        shape = density * shape + (1 - density)
    return shape


def _scale(arr, factor):
    """
    factor가 정확히 1.0인 float면 곱을 건너뛰고 arr을 **그대로** 돌려준다.

    1.0 곱은 float32에서 무손실이라 값이 같고, bbox 크기 임시 배열 하나를 아낀다.
    그리고 같은 객체를 돌려주는 것이 _merge_rgba_fast에서 중요하다 — 마스크도
    불투명도도 없는 레이어는 shape_s와 alpha_s가 같은 배열이 되어 (shape_s -
    alpha_s)가 정확히 0이 되고, 예전 식과 비트까지 같은 결과가 나온다.
    """
    if isinstance(factor, float) and factor == 1.0:
        return arr
    return arr * factor


def _extract_rgba_masked(layer):
    """
    마스크 달린 레이어를 layer.composite 없이 읽는다. 가드를 못 넘으면 None.

    **왜 있는가.** composite는 psd-tools의 float32 전체 경로다. 실측(2026-08-05,
    납품본 한 판의 BG 그룹, 잎 140장):

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
    from psd_tools.constants import Tag

    if not _mask_fast_ok(layer):
        return None

    color = layer.numpy("color")
    if color is None:
        return None
    shape = layer.numpy("shape")
    if shape is None:
        shape = np.ones(color.shape[:2] + (1,), dtype=np.float32)

    # _get_mask(621행). 뷰포트가 레이어 bbox인 경우다.
    shape_mask = _mask_shape(layer, layer.bbox)

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
    t0 = time.perf_counter()
    if layer.mask is not None and not layer.mask.disabled:
        fast = _extract_rgba_masked(layer)
        if fast is not None:
            _perf(perf="extract", path="masked_fast",
                  mpx=round(layer.width * layer.height / 1e6, 2),
                  s=round(time.perf_counter() - t0, 4))
            return fast
        img = layer.composite(viewport=layer.bbox)
        path = "masked_composite"
    else:
        img = layer.topil()
        path = "topil"
    if img is None:
        raise ValueError(f"layer {layer.name!r} has no pixels")
    out = np.array(img.convert("RGBA"))
    _perf(perf="extract", path=path,
          mpx=round(layer.width * layer.height / 1e6, 2),
          s=round(time.perf_counter() - t0, 4))
    return out


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


def _plain(layer, allow_passthrough=False, allow_mask_opacity=False,
           allow_clipping=False):
    """
    psd.composite가 이 레이어에 하는 일 중 빠른 경로가 재현하지 않는 것이 하나라도
    있으면 False. 하나라도 걸리면 예전 경로로 떨어진다 — 빠르게 하려다 그림을
    바꾸는 것보다 느린 편이 낫다.

    판단 근거는 psd_tools/composite/composite.py의 Compositor.apply와 _get_mask /
    _get_const가 실제로 읽는 값들이다. 그쪽이 바뀌면 여기도 같이 봐야 한다.

    allow_mask_opacity는 **병합 대상 잎에만** 준다. 마스크·opacity·fill opacity는
    _merge_rgba_fast가 apply(348~372행)의 식을 그대로 옮겨 재현하기 때문이다.

    그룹(조상)에는 주지 않는다. 그룹의 그 값들은 자식마다 따로 걸리는 값이 아니라
    **자식들을 다 합성한 결과 한 장에** 걸리고, 그 결과를 만드는 방법이 블렌드에
    따라 또 갈린다. normal 그룹은 자식을 별도 Compositor에 모은 뒤(_get_group,
    715행) 거기에 마스크를 건다 — 겹치는 자식이 있으면 자식마다 거는 것과 결과가
    다르다. pass-through 그룹은 아예 다른 식으로 간다(_apply_passthrough_source,
    383행: color * mask + (1 - mask) * color_support, 여기서 color_support가
    _shape_g 이력을 끌고 온다). 지금 빠른 경로가 pass-through 그룹을 그냥 통과
    시키는 것은 마스크가 없을 때 그 식이 color 그대로가 되기 때문이고, 마스크가
    붙으면 그 근거가 사라진다.
    """
    from psd_tools.composite import utils
    from psd_tools.constants import BlendMode, Tag

    blend_ok = layer.blend_mode == BlendMode.NORMAL or (
        allow_passthrough and layer.blend_mode == BlendMode.PASS_THROUGH
    )
    if not blend_ok:
        return False
    if not allow_mask_opacity:
        if layer.opacity != 255:
            return False
        if layer.tagged_blocks.get_data(Tag.BLEND_FILL_OPACITY, 255) != 255:
            return False
    # knockout은 _apply_source의 식을 통째로 바꾼다(429~437행): alpha_g가 union이
    # 아니게 되고 backdrop이 _color_0/_alpha_0로 바뀐다. shape == alpha였을 때는
    # 그 차이가 대부분 상쇄되어 여기 없이도 버텼지만, 마스크나 opacity가 들어오면
    # shape != alpha가 되어 (shape - alpha) * alpha_0 * color_0 항이 살아난다.
    # _mask_fast_ok가 같은 이유로 이미 막고 있다. 납품 25장에는 하나도 없다.
    if layer.tagged_blocks.get_data(Tag.KNOCKOUT_SETTING, 0):
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
    #
    # allow_clipping은 **_fast_mergeable이 base를 확인한 클리핑 잎에만** 준다.
    # 그때는 빠른 경로가 그 잎을 본 패스에서 그리지 않고 base의 색 위에 얹으므로
    # (_clipped_colour), composite가 하는 일과 같아진다.
    if layer.clipping and not allow_clipping:
        return False
    if layer.mask is not None and not layer.mask.disabled and not allow_mask_opacity:
        return False
    # 벡터 마스크는 통과시키지 않는다. _get_mask의 두 번째 가지(645행)는 force면
    # 무조건 도형을 그리는데(merge_rgba가 force=True다) _mask_shape은 그 가지를
    # 옮기지 않았다.
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


def _fast_mergeable(psd, layers, allow_clipping=False):
    """
    레이어들과 그 조상 그룹이 전부 '평범'하면 빠른 경로를 쓸 수 있다.

    잎에는 마스크·불투명도를 허용한다(_plain의 allow_mask_opacity). 실측
    2026-08-06, 납품 25장의 병합 55건 인구조사:

        빠른 경로 32건(58%) → 36건(65%)   빠른 361.3 → 397.6 Mpx

    풀린 4건은 3~6배 빨라졌다(그 파일들의 픽셀 시간 합 32.3초 → 7.7초). 그중
    가장 큰 것이 어느 한 판의 'BG' 9장 11.6초 → 1.8초다.

    **`allow_clipping`은 오버레이 전용이다. 내보내기는 주지 않는다.**
    병합 대상 안에 base와 그 클리핑 잎이 함께 있으면 `_clipped_colour`가
    psd.composite의 `_apply_clip_layers`(606행)를 그대로 돌린다. 캐릭터 오버레이에서
    이것이 유일하게 남은 가드였고, 풀고 나니 샘플 넷의 뷰 17개 중 막혀 있던 5개가
    3.7~4.7배 빨라지면서 획 RGBA는 17/17 바이트 동일이었다
    (edges._composite_colour 참고).

    **내보내기에 주지 않는 이유는 클리핑 코드가 아니라 이 빠른 경로 자체다.**
    `_merge_rgba_fast`는 잎을 하나의 누적기에 평평하게 union하는데 psd.composite는
    그룹마다 0부터 union한 뒤 그 결과를 부모에 다시 union한다. float32에서 괄호가
    마지막 비트를 바꾸므로 두 결과는 원리적으로 비트 동일이 아니다 — 지금 이 경로를
    타는 병합들에서 경험적으로 같을 뿐이다. 클리핑을 열어 병합 3건이 처음 이 경로를
    타자 바로 갈렸다(납품 26장 대조에서 271/1210/124px, 대부분 알파). 한 픽셀에서
    확인한 값:

        평평하게 접기 0.984014928 / 트리대로 접기 0.984014750 / psd-tools 0.984014750

    클리핑 잎을 아예 빼도 그 갈림이 그대로라 클리핑 코드는 무죄다. 고치려면 그룹
    트리를 재현해야 하고 그건 Compositor를 다시 쓰는 일이다. 그때까지 내보내기의
    인구는 이미 대조로 검증된 것만 유지한다.

    base를 이 집합에서 못 찾은 클리핑 잎은 `allow_clipping`이어도 거절한다 — 그
    base가 집합 밖의 **그룹**이면 composite는 그 그룹의 합성 결과 위에 잎을 얹는데
    빠른 경로에는 그 그룹이 없다.

    **이것으로 풀리지 않는 쪽을 적어 둔다.** 남은 느린 405.2 Mpx의 대부분은 잎이
    아니라 **조상 그룹**이 막고 있다(ancestor:mask 132.3 Mpx, ancestor:opacity
    205.2 Mpx). 프로파일한 판 하나의 'BG'(38장 123.8초)와 'OL'
    (11장 68.4초)이 정확히 그 경우라 이 변경으로 1초도 줄지 않는다 — 'OL'은 잎이
    하나도 걸리지 않고 pass-through 그룹 'light2'의 마스크 하나에 걸려 있으며,
    'BG'는 거기에 잎 'LINE'의 OuterGlow가 더해진다. 그쪽을 풀려면 그룹의 자식을
    별도 버퍼에 먼저 합성하고 _apply_passthrough_source(383행)까지 옮겨야 한다 —
    가드를 넓히는 일이 아니라 다른 크기의 일이다.
    """
    from psd_tools.constants import ColorMode

    if psd.color_mode != ColorMode.RGB:
        return False
    # 이 집합 안에서 누가 누구의 클리핑 잎인가. base를 못 찾은 클리핑 잎은 아래에서
    # 거절한다 — base가 이 집합 밖의 **그룹**이면 psd.composite는 그 그룹의 합성
    # 결과 위에 이 잎을 얹는데, 빠른 경로에는 그 그룹이 없어 조용히 빠진다.
    # base가 잎이면 필터에서 함께 걸려 양쪽 다 안 그리므로 문제가 없지만, 둘을
    # 여기서 가릴 수 없으니 안전한 쪽으로 판단한다.
    clipped = {id(c) for l in layers if l.has_clip_layers() for c in l.clip_layers}
    for layer in layers:
        if layer.is_group():
            return False
        if layer.clipping:
            if not allow_clipping:
                return False
            if id(layer) not in clipped:
                return False
            # 클리핑의 클리핑은 옮기지 않았다(_apply_clip_layers는 재귀한다).
            if layer.has_clip_layers():
                return False
            if not _plain(layer, allow_mask_opacity=True, allow_clipping=True):
                return False
        elif not _plain(layer, allow_mask_opacity=True):
            return False
        cur = layer.parent
        while cur is not None and cur is not psd:
            # 그룹의 마스크·불투명도는 psd.composite가 자식에 적용한다.
            if not _plain(cur, allow_passthrough=True):
                return False
            cur = cur.parent
    return True


def _layer_source(layer, box):
    """
    apply(342~353행)가 레이어 하나에서 뽑는 값들을 **box 좌표계**로 돌려준다.
    box와 겹치지 않거나 그릴 픽셀이 없으면 None.

        (src, shape_raw, shape_s, alpha_s, y0, x0)

    `shape_raw`는 마스크도 불투명도도 걸기 **전**의 shape다 — _get_object가
    `alpha = shape * 1.0`으로 떠 두는 바로 그 배열이고, 클리핑 잎을 얹을 때
    하위 Compositor의 _alpha_0가 된다.

    box 밖은 잘라낸다. _get_object의 paste가 그 자리에 shape 0을 깔고, shape도
    alpha도 0인 자리에서 _apply_source는 색도 알파도 바꾸지 않기 때문이다 —
    마스크 bbox가 레이어보다 커도 그 바깥을 버려도 되는 것과 같은 이유다.
    음수로 슬라이스하면 예외 없이 배열 반대쪽 끝을 집어 엉뚱한 자리에 그린다.
    """
    from psd_tools.constants import Tag

    bbox = layer.bbox
    if bbox == (0, 0, 0, 0):
        return None
    src = layer.numpy("color")
    if src is None:
        return None
    shape = layer.numpy("shape")
    if shape is None:
        shape = np.ones(src.shape[:2] + (1,), dtype=np.float32)
    # _get_mask(621행). composite는 마스크를 뷰포트 전체에 붙이지만 여기서는 레이어
    # bbox에만 붙인다.
    shape_mask = 1.0
    if layer.mask is not None and not layer.mask.disabled:
        shape_mask = _mask_shape(layer, bbox)
    h, w = src.shape[:2]
    y0, x0 = bbox[1] - box[1], bbox[0] - box[0]
    cy0, cx0 = max(0, -y0), max(0, -x0)
    cy1 = h - max(0, y0 + h - (box[3] - box[1]))
    cx1 = w - max(0, x0 + w - (box[2] - box[0]))
    if cy1 <= cy0 or cx1 <= cx0:
        return None
    if (cy0, cx0, cy1, cx1) != (0, 0, h, w):
        src, shape = src[cy0:cy1, cx0:cx1], shape[cy0:cy1, cx0:cx1]
        if isinstance(shape_mask, np.ndarray):
            shape_mask = shape_mask[cy0:cy1, cx0:cx1]
        y0, x0 = y0 + cy0, x0 + cx0

    # _get_const(675행). 그리고 apply(348~352행) — _get_mask의 opacity는 언제나
    # 1.0이라 상수로 적는다. 곱하는 순서를 그대로 지킨다.
    shape_const = layer.tagged_blocks.get_data(Tag.BLEND_FILL_OPACITY, 255) / 255.0
    opacity_const = layer.opacity / 255.0
    mask = _scale(_scale(shape_mask, 1.0), opacity_const)
    shape_s = _scale(_scale(shape, shape_mask), shape_const)
    # 마스크만 있고 불투명도가 255면 mask가 shape_mask 그대로다 — 그때 alpha_s는
    # shape_s와 값이 같으므로 배열 하나를 더 만들지 않는다. 마스크도 불투명도도
    # 없으면 둘 다 shape 그 자체라 (shape_s - alpha_s)가 정확히 0이 되고, 예전
    # 식과 비트까지 같은 결과가 나온다.
    alpha_s = shape_s if mask is shape_mask else \
        _scale(_scale(shape, mask), shape_const)
    return src, shape, shape_s, alpha_s, y0, x0


def _clipped_colour(src, shape_raw, rect, clips):
    """
    _apply_clip_layers(606행)를 base 레이어의 그림 위에서 그대로 돌린다.

    돌려주는 것은 **색뿐**이다. psd-tools도 하위 Compositor의 `_color`만 가져가고
    base의 shape·alpha는 건드리지 않으므로, 클리핑은 base가 이미 덮은 자리의 색만
    바꾼다.

    하위 Compositor는 base의 색과 **마스크 전 shape**로 초기화된다
    (`Compositor(viewport, color, alpha)` — 280~316행). 그래서 `_alpha_0`가 0이
    아니고, 본 패스처럼 `_alpha == _alpha_g`로 줄일 수 없다 — `_alpha`와 `_alpha_g`를
    따로 들고 간다.

    base의 bbox(=`rect`) 밖은 볼 필요가 없다. 하위 Compositor는 뷰포트 전체를
    쓰지만 그 결과 중 base의 shape가 0인 자리는 곧이어 base의 _apply_source가
    통째로 버린다.

    같은 이유로 **클리핑 잎의 bbox 밖도 건드리지 않는다.** 거기서 psd-tools는
    색을 우리와 다르게 만든다 — shape도 alpha도 0이라 식이 `divide(a_prev*c_b,
    a_prev)`로 줄고, base의 알파가 0인 픽셀에서는 그것이 `divide(0, 0)`이라
    utils.divide가 **1.0(흰색)**을 넣는다. 그런데 base의 `alpha_0`가 곧 마스크 전
    shape이므로 그 자리는 `shape_s`도 0이고, base가 이 색으로 캔버스에 보태는 것이
    아무것도 없다. 그래서 그 흰색을 재현하지 않아도 결과가 같다 —
    clip_layer_psd의 base가 알파 0..255 그라데이션이라 이 자리가 실제로 있고,
    test_merge_rgba_lays_a_clipping_target_onto_its_base가 그 위에서 두 경로를
    겨룬다.
    """
    from psd_tools.composite import utils

    colour = src.copy()
    alpha_0 = shape_raw
    alpha_cur = shape_raw.copy()          # 하위 Compositor의 _alpha
    alpha_g = np.zeros_like(shape_raw)    # 하위 Compositor의 _alpha_g
    for clip in clips:
        got = _layer_source(clip, rect)
        if got is None:
            continue
        c_src, _raw, shape_s, alpha_s, y0, x0 = got
        h, w = c_src.shape[:2]
        at = (slice(y0, y0 + h), slice(x0, x0 + w))
        a_prev = alpha_cur[at]
        a_g = utils.union(alpha_g[at], alpha_s)
        a_new = utils.union(alpha_0[at], a_g)
        c_b = colour[at]
        # blend는 NORMAL만 통과하므로 blend_fn(color_b, color)는 color 그대로다.
        colour_t = (shape_s - alpha_s) * a_prev * c_b + alpha_s * (
            (1.0 - a_prev) * c_src + a_prev * c_src
        )
        colour[at] = utils.clip(
            utils.divide((1.0 - shape_s) * a_prev * c_b + colour_t, a_new)
        )
        alpha_g[at] = a_g
        alpha_cur[at] = a_new
    return colour


def _merge_rgba_fast(psd, layers, viewport):
    """
    psd.composite와 같은 그림을, 레이어를 뷰포트 크기로 부풀리지 않고 만든다.

    비싼 것은 합성식이 아니라 psd-tools가 레이어마다 하는 paste다 — 0.1Mpx짜리
    트림 한 장도 병합 그룹의 합집합 뷰포트(실측 54Mpx)로 늘린 뒤 float32로 열댓
    번 훑는다. 여기서는 각 레이어의 bbox 안에서만 같은 계산을 한다.

    식은 Compositor.apply(348~372행)와 _apply_source의 normal·knockout 아님 경우를
    그대로 옮긴 것이다. 대수적으로 줄이지 않는다 — float32에서 (1-a)*c + a*c 는 c 와
    같은 값이 아니고, 그 마지막 비트가 절삭 경계에 걸리면 픽셀 값이 1 달라진다.

    **shape와 alpha를 나눠 들고 간다.** 예전에는 둘이 같다고 보고 (shape - alpha)
    항을 지웠는데, 마스크나 opacity가 붙으면 그 둘이 갈라진다. apply가 하는 일은
    이렇다 — _get_object가 alpha를 shape의 **복사본**으로 먼저 떠 놓고(alpha =
    shape * 1.0), 그 뒤에 shape에만 마스크를 곱하고(shape *= shape_mask) alpha에는
    마스크와 불투명도를 함께 곱한다(alpha *= shape_mask * opacity_mask *
    opacity_const). 그래서 alpha 쪽 마스크는 곱해진 shape가 아니라 원래 shape에
    걸린다. 마지막으로 둘 다 fill opacity(shape_const)를 곱해 _apply_source로 간다.
    그 대목은 `_layer_source`에 있다 — 클리핑 잎도 같은 계산을 거치기 때문이다.

    **클리핑 잎은 본 패스에서 빠지고 base의 색 위에 얹힌다**(`_clipped_colour`).
    _fast_mergeable이 base를 확인한 잎만 여기 들어온다.
    """
    from psd_tools.api import pil_io
    from psd_tools.composite import utils
    from psd_tools.constants import Resource

    left, top, right, bottom = viewport
    # psd.composite(color=1.0, alpha=0.0)의 시작 상태와 같다.
    color = np.ones((bottom - top, right - left, 3), dtype=np.float32)
    alpha_g = np.zeros((bottom - top, right - left, 1), dtype=np.float32)

    ids = {id(l) for l in layers}
    order = _composite_order(psd)
    for layer in sorted(layers, key=lambda l: order[id(l)]):
        # 클리핑 잎은 본 패스에서 안 그린다(apply 329행) — base의 색 위에 얹힌다.
        if layer.clipping:
            continue
        got = _layer_source(layer, viewport)
        if got is None:
            continue
        src, shape_raw, shape_s, alpha_s, y0, x0 = got
        h, w = src.shape[:2]
        box = (slice(y0, y0 + h), slice(x0, x0 + w))

        # apply(344~346행) — 마스크·불투명도를 걸기 **전에** 클리핑을 얹는다.
        # 필터가 통과시키지 않는 클리핑 잎은 하위 Compositor에서도 걸리므로
        # (_apply_clip_layers가 같은 filter를 물려준다) 이 집합 안의 것만 본다.
        if layer.has_clip_layers():
            clips = [c for c in layer.clip_layers if id(c) in ids]
            if clips:
                src = _clipped_colour(src, shape_raw, (
                    left + x0, top + y0, left + x0 + w, top + y0 + h), clips)

        color_b = color[box]
        alpha_b = alpha_g[box]
        alpha_new = utils.union(alpha_b, alpha_s)
        color_t = (shape_s - alpha_s) * alpha_b * color_b + alpha_s * (
            (1.0 - alpha_b) * src + alpha_b * src
        )
        color[box] = utils.clip(
            utils.divide((1.0 - shape_s) * alpha_b * color_b + color_t, alpha_new)
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


def _group_rgba_scaled(psd, group, bbox, session=None):
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

    # 세션이 있으면 잎 픽셀을 원본 디코드 대신 **미리보기 타일**에서 가져온다.
    #
    # 이 함수의 6.4배(2026-08-05)는 사실 "잎마다 한 번만 디코드"가 만든 것이었다 —
    # ZIP 디코드가 numpy로 빨라진 뒤(fae8496) 다시 재니 전해상도 경로와 205.9 대
    # 216.4초로 같아졌다. 남은 비용은 디코드가 아니라 **전해상도 premultiply·축소**
    # 라서, 이미 그 축소를 마친 타일(토글·워밍업이 쓰는 그 캐시)을 그대로 쓰면
    # 그 항이 통째로 사라진다. 타일은 extract_rgba의 축소본이므로 잎 의미론
    # (마스크 잎은 이미 구워져 있음 — draw()의 leaf_baked)이 그대로 맞는다.
    #
    # **전해상도보다 작은 캔버스로 이미 가는 그룹에만 건다(scale < 1.0).** 예산
    # 아래 그룹은 오늘 전해상도에서 정확히 합성되고 있고, 빠르게 할 것도 없는데
    # 타일 해상도로 낮추면 그림만 나빠진다. 큰 그룹은 캔버스를 타일 배율로 맞춘다
    # — 소스가 타일인 이상 그보다 높은 캔버스는 정밀도를 더 주지 못한다. 배치는
    # 타일이 이미 앉아 있는 문서 격자(round(left*ts))를 그대로 써서 재표본이 없다.
    tile_source = None
    if session is not None and scale < 1.0:
        tile_scale = preview_scale(psd, THUMBNAIL_SOURCE_MAX_SIZE)
        if tile_scale < scale:
            scale = tile_scale
        id_of = {id(l): lid for lid, l in session["layers_by_id"].items()}

        def tile_source(layer):
            lid = id_of.get(id(layer))
            if lid is None:
                return None
            entry = _preview_tile(session, lid, tile_scale)
            if entry is None:
                return None
            img, dx, dy = entry
            rgba = np.asarray(img.convert("RGBA")).astype(np.float32) / 255.0
            alpha = rgba[..., 3:4]
            premul = np.concatenate((rgba[..., :3] * alpha, alpha), axis=2)
            f = scale / tile_scale
            if f != 1.0:
                # 초거대 그룹(타일 배율 > 예산 배율): 프리멀티플라이드로 줄인다 —
                # _scaled_leaf가 스트레이트 알파 축소의 번짐을 피하는 것과 같다.
                tw = max(1, round(img.width * f))
                th = max(1, round(img.height * f))
                pimg = Image.fromarray((255 * premul).astype(np.uint8), "RGBA")
                premul = np.asarray(
                    pimg.resize((tw, th), Image.LANCZOS)).astype(np.float32) / 255.0
                dx, dy = round(dx * f), round(dy * f)
            return premul, dx - round(left * scale), dy - round(top * scale)

    pw = max(1, round((right - left) * scale))
    ph = max(1, round((bottom - top) * scale))

    def leaf_px(layer):
        """잎 픽셀 — 타일이 있으면 타일, 없거나 못 주면 원본 디코드로."""
        if tile_source is not None:
            got = tile_source(layer)
            if got is not None:
                return got
        return _scaled_leaf(layer, scale, (left, top))

    def clipped_box(premul, x0, y0, ch, cw):
        """타일을 (ch, cw) 캔버스와 교차시켜 (슬라이스 상자, 잘린 타일)을 준다.

        _place의 잘라내기와 같은 산술이다 — 안 겹치면 None.
        """
        h, w = premul.shape[:2]
        sx0, sy0 = max(0, -x0), max(0, -y0)
        sx1 = w - max(0, x0 + w - cw)
        sy1 = h - max(0, y0 + h - ch)
        if sx1 <= sx0 or sy1 <= sy0:
            return None
        tile = premul[sy0:sy1, sx0:sx1]
        dy, dx = y0 + sy0, x0 + sx0
        return (slice(dy, dy + tile.shape[0]),
                slice(dx, dx + tile.shape[1])), tile

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

            if not layer.is_group():
                # 잎은 **자기 사각형만** 만진다. 원식은 잎마다 캔버스 전체에
                # clip(divide(a·c, a)) 항등을 다시 썼고, 그 비용이 타일 소스로
                # 바꾼 뒤 남은 시간의 대부분이었다(판 20: 잎 140장 × 캔버스
                # 0.5Mpx × 그룹 17개 = thumb_group 77초). 사각형 밖에서 그 항등이
                # 남기는 것은 ulp 수준이고, 이 경로의 계약은 비트가 아니라 사전
                # 선언 오차 상한(≤4)이다.
                got = leaf_px(layer)
                if got is None:
                    continue
                premul, x0, y0 = got
                placed = clipped_box(premul, x0, y0, ph, pw)
                if placed is None:
                    continue
                box, tile = placed
                a = tile[..., 3:4]
                # _place와 같은 프리멀티플라이드→스트레이트 복원.
                with np.errstate(divide="ignore", invalid="ignore"):
                    straight = np.true_divide(tile[..., :3], a)
                straight[~np.isfinite(straight)] = 1.0
                raw_color = np.clip(straight, 0.0, 1.0)
                raw_alpha = a
                if layer.mask is not None and not layer.mask.disabled:
                    # own_mask_and_opacity를 부르면 안 된다 — 마스크·불투명도·fill이
                    # extract_rgba에서 이미 alpha에 반영됐다(클리핑이 붙어 있으면
                    # _mask_fast_ok의 has_clip_layers 가드가 layer.composite로
                    # 떨어뜨리므로 그것까지도). shape는 opacity_const만 나눠
                    # 되돌린다 — psd-tools의 shape는 fill은 포함하되 opacity는
                    # 포함하지 않는다(Compositor.apply 349~353행). opacity 0이면
                    # alpha도 이미 0이라 shape 0으로 둬도 결과가 같다.
                    opacity_const = layer.opacity / 255.0
                    if opacity_const > 0:
                        shape_s = raw_alpha / opacity_const
                    else:
                        shape_s = np.zeros_like(raw_alpha)
                    alpha_s = raw_alpha
                else:
                    # 클리핑 레이어들은 베이스의 색만 바꾼다. 베이스 사각형과
                    # 겹치는 부분만 본다 — 밖은 베이스 alpha가 0이라 최종식에
                    # ulp 수준으로만 남는 자리다.
                    for clip in layer.clip_layers:
                        if not clip.visible:
                            continue
                        cgot = leaf_px(clip)
                        if cgot is None:
                            continue
                        c_premul, cx, cy = cgot
                        c_color = np.ones_like(raw_color)
                        c_alpha = np.zeros_like(raw_alpha)
                        _place(c_color, c_alpha, c_premul,
                               cx - box[1].start, cy - box[0].start)
                        raw_color = _over(raw_color, raw_alpha, c_color, c_alpha,
                                          clip.blend_mode)[0]
                    # 잎의 mask_shape는 항상 스칼라다 — 마스크 있는 잎은 위(구워진)
                    # 분기로 갔고, 없는 잎은 1.0이 온다.
                    mask_shape, opacity_const, shape_const = own_mask_and_opacity(layer)
                    # 마스크 없는 잎: extract_rgba가 topil()이라 shape==alpha(자기
                    # 불투명도를 아직 안 곱한 raw 값)다.
                    shape_s = raw_alpha * mask_shape * shape_const
                    alpha_s = raw_alpha * mask_shape * (opacity_const * shape_const)
                color[box], _ = _over(
                    color[box], utils.union(alpha_0[box], alpha_g[box]),
                    raw_color, alpha_s, layer.blend_mode)
                shape_g[box] = utils.union(shape_g[box], shape_s)
                alpha_g[box] = utils.union(alpha_g[box], alpha_s)
                continue

            # 그룹 몫 — 캔버스 전체로 다룬다. 그룹은 몇 개 안 되고, pass-through
            # 되접기(_apply_passthrough)가 캔버스 전역 상태를 읽는다.
            if is_pass:
                raw_color, raw_shape, raw_alpha = draw(
                    layer, color, utils.union(alpha_0, alpha_g))
            else:
                raw_color, raw_shape, raw_alpha = draw(
                    layer, blank_color(), blank_scalar())

            # 클리핑 레이어들은 베이스(그룹)의 색만 바꾼다.
            for clip in layer.clip_layers:
                if not clip.visible:
                    continue
                got = leaf_px(clip)
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
                t0 = time.perf_counter()
                img = Image.fromarray(
                    _group_rgba_scaled(psd, layer, bbox, session=session), "RGBA")
                # 이 로그가 없어서 그룹 썸네일 110초가 "빈 공백"으로 보였다
                # (2026-08-18, 판 20 앱 타임라인). 단계는 안 보이면 없는 취급된다.
                _perf(perf="thumb_group", lid=lid, cost=round(cost, 1),
                      s=round(time.perf_counter() - t0, 4))
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
            # 잎 썸네일은 가능하면 미리보기 타일(디스크 캐시 포함)에서 줄인다.
            # 예전처럼 원본 해상도를 다시 디코드하면, 타일·오버레이를 다 캐시해
            # 둔 판에서도 참고 그룹(TEMPLATE 등)을 펼치는 순간 56.9Mpx 잎 하나가
            # 실측 47초를 냈다 — 48px 그림을 만들자고 낼 비용이 아니고, stdin이
            # 직렬이라 그 47초 뒤에 사용자 렌더가 전부 줄을 선다.
            #
            # 타일이 청한 썸네일보다 작으면(작은 잎 × 큰 캔버스 축소) 확대
            # 흐림이 생기므로 그때만 예전 경로(원본 디코드)로 간다 — 타일이
            # 작다는 것은 잎 자체가 작다는 뜻이라 그 디코드는 어차피 싸다.
            entry = _preview_tile(session, lid, preview_scale(psd, THUMBNAIL_SOURCE_MAX_SIZE))
            if entry is None:
                continue
            if max(entry[0].width, entry[0].height) >= max_size:
                # 캐시에 든 타일을 그대로 줄이면 캐시가 오염된다 — 사본에서 줄인다.
                img = entry[0].copy()
            else:
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

    RAM 미스면 디코드 전에 디스크 캐시를 먼저 본다(tilecache). 이 한 지점이면
    토글·미리보기·워밍업 전부가 혜택을 본다 — 셋 다 여기로 온다. 디코드했을
    때는 그 부산물을 디스크에 떨궈, 세션이 밀려나거나 앱을 재시작해도 이 잎의
    디코드 비용(콜드 0.7~50초)을 다시 내지 않는다.
    """
    cache = session.setdefault("preview_tiles", OrderedDict())
    key = (layer_id, round(scale, 6))
    if key in cache:
        cache.move_to_end(key)
        return cache[key]

    t0 = time.perf_counter()
    layer = session["layers_by_id"][layer_id]
    # 그린 적 없는 빈 레이어(0x0). extract_rgba/PIL이 터지므로 렌더 대상이 아니다.
    # 디스크에도 묻지 않는다 — 비용이 0이라 기억할 것이 없다.
    if layer.width <= 0 or layer.height <= 0:
        entry = None
    else:
        entry = tilecache.load(session, layer_id, scale)
        if entry is not None:
            cache[key] = entry
            _evict_tiles(cache)
            _perf(perf="tile_disk", lid=layer_id,
                  s=round(time.perf_counter() - t0, 4))
            return entry
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
        tilecache.store(session, layer_id, scale, entry)

    cache[key] = entry
    _evict_tiles(cache)
    _perf(perf="tile_cold", lid=layer_id, s=round(time.perf_counter() - t0, 4))
    return entry


#: warm_preview_tiles가 쓰는 예상 디코드 속도(Mpx/s). 2026-08-11 납품 판 실측
#: (.superpowers/sdd/render-time)에서 느린 쪽으로 잡은 값이다: 무마스크 topil은
#: 내용(RLE 압축률)에 따라 17~58Mpx/s를 오갔고(50.4Mpx 0.87s, 81.8Mpx 4.62s),
#: 마스크 빠른 경로는 24Mpx 2.82s(~8.5Mpx/s), 가드에 막힌 composite 경로는
#: ~4Mpx/s다. 정확한 예측이 목적이 아니다 — 도는 **순서**와 "이 잎은 시작하면
#: 안 된다"는 판단에만 쓰므로, 빗나가도 순서가 조금 바뀔 뿐이다.
#:
#: **예측은 자릿수 도구다.** 같은 날 캐릭터 판 하나(#44)의 무마스크 59.9Mpx 잎이
#: 49.7초(~1.2Mpx/s)로 예측의 12배가 나왔다 — 예측 4초라 상한(10초)을 통과해
#: 워밍업이 시작하고, 그동안 온 사용자 렌더는 그 뒤에서 기다린다. 그래도 잎을
#: 작은 것부터 돌므로 이런 잎은 마지막에 오고, 워밍업이 없으면 그 50초를
#: 사용자가 토글 순간에 그대로 내는 것이라 순손해는 아니다. 채널 데이터의
#: 압축 바이트 수로 추정을 바꾸면 나아질 수 있다 — 아직 안 쟀다.
WARM_RATE_MPX_S = {"unmasked": 15.0, "masked_fast": 8.0, "masked_slow": 4.0}

#: 예상 시간이 이 값(초)을 넘는 잎은 워밍업이 건너뛴다. stdin이 직렬이라 워밍업
#: 요청이 도는 동안 사용자 렌더가 뒤에서 기다리는데, 예산 확인은 잎 사이에서만
#: 할 수 있다 — 잎 하나가 오래 걸릴 것 같으면 아예 시작하지 않는 것이 차단
#: 시간의 상한을 지키는 유일한 방법이다. 건너뛴 잎의 첫 토글은 예전처럼 느리다
#: (실측 최악 예상 53s, 213Mpx 가드 막힌 마스크 잎).
WARM_MAX_PREDICTED_S = 10.0


def _warm_cost(layer):
    """잎 하나의 예상 디코드 시간(초). 워밍업의 순서와 건너뛰기 판단에 쓴다."""
    mpx = layer.width * layer.height / 1e6
    if layer.mask is not None and not layer.mask.disabled:
        kind = "masked_fast" if _mask_fast_ok(layer) else "masked_slow"
    else:
        kind = "unmasked"
    return mpx / WARM_RATE_MPX_S[kind]


def warm_preview_tiles(session, layer_ids, max_size, budget_s, disk_only=False):
    """
    토글이 켤 수 있는 잎들의 미리보기 타일을 유휴 시간에 미리 디코드한다.

    실측(2026-08-11, 납품 BG 판): 타일이 핫이면 토글이 0.04~0.1초, 콜드면 그 잎
    하나의 원본 해상도 디코드가 0.7~4.7초다. 프리페치는 라인 조합 한 장만
    만들므로 라인이 아닌 잎은 전부 콜드로 남는다 — 엔진이 놀 때 데워 두면
    첫 토글도 핫 토글과 같아진다.

    예상 비용 오름차순으로 돌고, 예산이 차면 나머지를 remaining으로 돌려준다.
    호출자는 remaining이 빌 때까지 다시 부른다 — 한 번에 다 데우지 않는 것은
    stdin이 직렬이라 긴 워밍업 뒤에 사용자 렌더가 줄을 서기 때문이다. 예산과
    무관하게 호출당 최소 한 장은 데운다(예산 0으로 불러도 전진해야 끝이 난다).
    그룹·모르는 id는 조용히 버린다 — remaining에 안 남으므로 다시 오지 않는다.

    ``disk_only``는 타일 자식들(viewpool.start_tile_pool)이 굽는 동안 프런트가
    폴링하는 모드다: **절대 디코드하지 않고**, 디스크에 이미 있는 잎만 RAM으로
    쓸어담는다. 콜드 잎은 remaining으로 돌아가고, 자식이 그 잎을 디스크에 놓으면
    다음 폴링이 담는다. 여기서 디코드가 새면 부모가 자식과 같은 잎을 겹으로
    굽는다 — 나눈 뜻이 사라진다.
    """
    scale = preview_scale(session["psd"], max_size)
    cache = session.setdefault("preview_tiles", OrderedDict())
    warmed, skipped, todo, remaining_cold = [], [], [], []
    for lid in layer_ids:
        layer = session["layers_by_id"].get(lid)
        if layer is None or layer.is_group():
            continue
        if (lid, round(scale, 6)) in cache:
            warmed.append(lid)
            continue
        # 빈 잎(0x0)은 _preview_tile이 None을 캐시한다 — 비용 0으로 데운다.
        # 디스크 캐시에 있는 잎도 비용 0이다 — _preview_tile이 디코드 대신 디스크
        # 읽기(수십 ms)로 끝나므로, 디코드 시간 예측(_warm_cost)으로 재면 안 된다.
        # 특히 WARM_MAX_PREDICTED_S 스킵이 디스크에 이미 있는 큰 잎을 영영
        # 건너뛰는 것을 이것이 막는다.
        if layer.width <= 0 or layer.height <= 0 \
                or tilecache.has(session, lid, scale):
            cost = 0.0
        elif disk_only:
            # 콜드 잎은 자식들 몫이다 — 건드리지 않고 다음 폴링을 기다린다.
            remaining_cold.append(lid)
            continue
        else:
            cost = _warm_cost(layer)
        todo.append((cost, lid))
    todo.sort()

    t0 = time.perf_counter()
    remaining = []
    did_work = False
    for i, (cost, lid) in enumerate(todo):
        if cost > WARM_MAX_PREDICTED_S:
            skipped.append(lid)
            continue
        if did_work and time.perf_counter() - t0 >= budget_s:
            remaining.extend(l for _, l in todo[i:])
            break
        _preview_tile(session, lid, scale)
        warmed.append(lid)
        did_work = True
    # 예산에 걸려 남은 것 중 상한 초과분은 다음 호출에서도 skipped가 될 뿐이니
    # 그대로 remaining에 둔다 — 분류를 여기서 미리 하면 코드만 두 벌이 된다.
    remaining.extend(remaining_cold)
    _perf(perf="warm", warmed=len(warmed), skipped=len(skipped),
          remaining=len(remaining), s=round(time.perf_counter() - t0, 4))
    return {"warmed": warmed, "skipped": skipped, "remaining": remaining}


#: 줄여 놓은 오버레이를 세션에 몇 장까지 들고 있을지. 한 장이 미리보기 크기
#: (최대 1500px)라 수십 장이어도 메모리는 몇 MB다. 뷰가 15개인 판이 실측으로
#: 있었고(rpc._cached_plan_overlays 주석), 색 통일을 켜고 끄면 같은 뷰가 색마다
#: 하나씩 생기므로 뷰 수의 두 배는 들어가야 토글마다 미스가 나지 않는다.
OVERLAY_SCALED_CACHE = 64


#: 축소한 오버레이에서 가장 진한 획이 최소한 이만큼은 되게 한다(0~255).
#:
#: **이미 이 값을 넘는 오버레이는 손대지 않는다** — 그때 미리보기는 정상 축소
#: 그대로이고, 화면의 획 굵기가 내보내기와 같다. 보정은 "안 그러면 안 보이는"
#: 판에만 걸린다.
#:
#: 배수를 무조건 거는 방식은 세 번 실패했다. 획 전체를 곱하면 안티에일리어싱된
#: 흐린 가장자리까지 함께 진해져 눈에는 획이 두꺼워진 것으로 보인다 — 최댓값으로
#: 채우던 판(1cc4b4f, _visible_reduce 판 1·2)과 4배 배수 판(판 3) 모두 아티스트가
#: "굵다"고 돌려보냈고, 내보내기와 대조해 미리보기만의 문제로 확인됐다.
#:
#: 160인 이유: 흰 배경에서 이 정도면 확실히 보이고, 255가 아니라 여유가 있어
#: 원래 진한 획과 구별된다. 무보정 2px 획이 배율 0.128에서 ~32였다(안 보임).
OVERLAY_TARGET_PEAK = 160.0


def _max_reduce(arr, k):
    """
    k×k 블록의 채널별 최댓값으로 줄인다. 블록 안에 획이 한 픽셀이라도 있으면
    그 색이 결과 픽셀에 그대로 남는다.

    LANCZOS 평균이 몇 px짜리 획을 안개로 만드는 것을 막는 것이 목적이고, 그
    판단을 **줄이면서 한 번에** 한다. 예전에는 원본 해상도에서 MaxFilter로
    획을 먼저 두껍게 만든 뒤 줄였는데, 그 필터가 픽셀당 k²번을 비교한다 —
    11,700px 캔버스에 배율 0.128인 색 판에서 오버레이 6장 합성이 **137초**였다
    (계측 2026-08-13, 토글 한 번 138초 중 99.3%). 블록 최댓값은 배열을 한 번만
    훑으므로 같은 목적을 자릿수 싼 값에 이룬다.

    채널별로 따로 최댓값을 잡는 것은 MaxFilter가 밴드별로 돌던 것과 같다 —
    그림이 바뀌는 지점이 아니다.
    """
    h, w = arr.shape[:2]
    ph, pw = (-h) % k, (-w) % k
    # 0으로 채운다(투명). 최댓값이라 채운 자리는 결과에 영향을 주지 않는다 —
    # edge로 채우면 가장자리 획이 바깥으로 번진다.
    if ph or pw:
        arr = np.pad(arr, ((0, ph), (0, pw), (0, 0)))
    h2, w2 = arr.shape[0] // k, arr.shape[1] // k
    return arr.reshape(h2, k, w2, k, arr.shape[2]).max(axis=(1, 3))


def _visible_reduce(arr, k):
    """
    k×k 블록으로 줄이되, **사라질 획만** 최소 가시성까지 올린다.

    한 번의 reshape에서 최댓값과 평균을 함께 뽑는다:
      색   — 최댓값. 획 색이 이웃 투명 픽셀과 섞여 흐려지지 않는다.
      알파 — 평균(= 정상 축소, 굵기가 원본 비율 그대로다). 그 결과의 가장 진한
             획이 OVERLAY_TARGET_PEAK에 못 미칠 때만 전체를 그만큼 올린다.

    **보정이 필요 없으면 아무것도 안 한다.** 획이 이미 보이는 판에서는 정상
    축소와 같은 그림이고, 그래서 화면 굵기가 내보내기와 일치한다.

    알파를 최댓값으로 채우거나 무조건 배수를 걸면 안 된다. 최댓값은 획이 블록
    경계에 걸릴 때 양쪽을 다 채워 1px을 2px로 만들고, 배수는 안티에일리어싱된
    흐린 가장자리까지 진하게 만들어 역시 두꺼워 보인다 — 세 판 모두 아티스트가
    "굵다"고 돌려보냈고, 내보내기와 대조해 미리보기만의 문제로 확인됐다
    (2026-08-13). 반대로 보정을 아예 빼면 12,000px 소품 시트에서 획이 20% 알파
    안개가 되어 "생성이 안 됐다"는 신고로 돌아온다.
    """
    h, w = arr.shape[:2]
    ph, pw = (-h) % k, (-w) % k
    if ph or pw:
        arr = np.pad(arr, ((0, ph), (0, pw), (0, 0)))
    h2, w2 = arr.shape[0] // k, arr.shape[1] // k
    blocks = arr.reshape(h2, k, w2, k, arr.shape[2])
    out = blocks.max(axis=(1, 3))
    alpha = blocks[..., 3].mean(axis=(1, 3))
    peak = float(alpha.max()) if alpha.size else 0.0
    if 0.0 < peak < OVERLAY_TARGET_PEAK:
        alpha = alpha * (OVERLAY_TARGET_PEAK / peak)
    # 원래 알파(최댓값)를 넘겨 칠하지 않는다 — 반투명 획이 불투명해지면 그것도
    # 없는 그림이다.
    out[..., 3] = np.minimum(alpha, out[..., 3]).round().astype(arr.dtype)
    return out


def render_preview(session, visible_layer_ids, max_size, out_dir, line_color=None,
                   line_color_ids=None, edge_overlays=None):
    """
    내보내기 결과 미리보기: 선택된 레이어의 픽셀을 문서 순서(아래→위)대로
    알파 합성한다. export_psd가 모든 레이어를 normal/255로 기록하므로 이것이
    내보낸 PSD가 실제로 보이게 될 모습이다.

    line_color는 **레이어마다** 건다(line_color_ids에 든 것만 — 뜻은
    assign_line_color와 같다). 예전에는 합성이 끝난 캔버스에 한 번만 덮었는데,
    그 지름길은 "모든 소스가 같은 색이 되므로 결과도 같은 색"이라는 등식에
    기대고 있었다. 색 통일 대상이 일부뿐이면 그 등식이 깨지므로 지름길도 함께
    사라진다 — 손으로 체크해 넣은 색 레이어까지 검게 칠하던 것이 그 결과였다.

    타일 캐시는 여전히 색깔별로 나누지 않는다. 캐시에는 원본 픽셀만 담고 덮는
    것은 합성 직전에 사본에 하므로, 캐시된 타일은 색 설정이 바뀌어도 그대로 쓴다.

    배경은 투명하게 둔다 — 흰색/체커/검정은 UI가 뒤에 깔아 고른다.
    """
    rgb = parse_line_color(line_color)
    ids = None if line_color_ids is None else set(line_color_ids)
    psd = session["psd"]
    scale = preview_scale(psd, max_size)
    pw = max(1, round(psd.width * scale))
    ph = max(1, round(psd.height * scale))
    canvas = Image.new("RGBA", (pw, ph), (0, 0, 0, 0))

    t_tiles = time.perf_counter()
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
        if rgb is not None and (ids is None or lid in ids):
            # 캐시된 타일은 건드리지 않는다 — apply_line_color가 사본을 만든다.
            img = Image.fromarray(apply_line_color(np.asarray(img), rgb), "RGBA")
        canvas.alpha_composite(img, dest=(x0 + sx0, y0 + sy0))

    # 생성된 색 경계 획. 내보내기에서는 라인 엔트리에 합쳐지므로 여기서도 라인과
    # 같은 자리에 놓이면 되는데, 라인이 스택 맨 위인 경우가 대부분이라 마지막에
    # 얹는다. 미리보기 배율로 줄여서 얹는다.
    #
    # 스택 순서는 여기서 재현하지 않는다 — 알고 있고 일부러 남겨 둔 것이다. 라인이
    # 색보다 아래인 문서에서만 드러나고, 고치려면 미리보기 합성 구조를 다시 짜야
    # 한다(내보내기는 라인 엔트리 자리에 합치는데 미리보기는 레이어를 따로따로
    # 합성하기 때문).
    t_overlay = time.perf_counter()
    visible_ids = set(visible_layer_ids)
    for overlay in edge_overlays or []:
        # 이 뷰의 라인이 지금 화면에 없으면 그릴 게 없다 — attach_overlays가
        # 내보내기 플랜에 없는 뷰를 건너뛰는 것과 같은 규칙이고 판단 기준도 같다:
        # lineIds가 지금 그려지는 레이어(visible_layer_ids)와 겹치는가.
        line_ids = set(overlay["lineIds"])
        if not (line_ids & visible_ids):
            continue
        arr = overlay["rgba"]
        # 색 통일 범위도 레이어별 루프와 같은 규칙을 쓴다. assign_line_color는
        # 엔트리의 sourceIds가 **전부** ids 안에 있을 때만 색을 건다(섞이면
        # 원본색을 지킨다) — 여기서는 엔트리 대신 뷰의 lineIds에 같은 전부-포함
        # 조건을 적용한다. 어차피 lineIds가 한 장뿐인 흔한 경우에는 레이어별
        # 루프의 `lid in ids`와 똑같아진다.
        recolour = rgb is not None and (ids is None or line_ids <= ids)
        h, w = arr.shape[:2]
        x0, y0 = round(overlay["left"] * scale), round(overlay["top"] * scale)
        tw = max(1, round((overlay["left"] + w) * scale) - x0)
        th = max(1, round((overlay["top"] + h) * scale) - y0)

        # 줄여 놓은 오버레이를 세션에 기억한다. 결과는 (뷰, 배율, 색)만의 함수인데
        # 원본 해상도 배열을 훑는 일이라, 캐시가 없으면 **토글할 때마다** 같은 값을
        # 다시 만든다 — 실측으로 레이어 수와 무관하게 매 렌더 0.68초가 여기서
        # 고정으로 나갔다(2026-08-13, 색 판). 화면에 뜨는 것이 무엇이든 뷰는 그대로다.
        # viewKey에 뷰 구성과 **픽셀 설정**이 들어 있다(tilecache.overlay_key).
        # 그것 없이 모양(lineIds·위치·크기)만으로 키를 만들면, 문턱이나 굵기를
        # 바꿔 오버레이 내용이 달라져도 키가 같아 옛 그림이 그대로 나온다 —
        # 설정을 고친 사람이 "차이 없음"이라는 틀린 판정을 얻는다.
        skey = (overlay.get("viewKey"), tuple(overlay["lineIds"]),
                overlay["left"], overlay["top"], (h, w),
                round(scale, 6), tuple(rgb) if recolour else None)
        scaled = session.setdefault("_overlay_scaled", OrderedDict())
        img = scaled.get(skey)
        if img is None:
            # 세션에 없으면 디스크를 본다. 뷰마다 최초 한 번만 줄이고, 그 뒤로는
            # 앱을 껐다 켜도 작은 PNG 읽기로 끝난다(타일 캐시와 같은 규약).
            img = tilecache.load_scaled_overlay(
                session, overlay.get("viewKey"), scale, tuple(rgb) if recolour else None)
        if img is None:
            if recolour:
                arr = apply_line_color(arr, rgb)
            # 축소가 획을 지우는 것을 막는다. 12,000px짜리 소품 시트는 미리보기
            # 배율이 ~0.125라, 획(자동 굵기 몇 px)이 LANCZOS 평균에 녹아 알파
            # 1할짜리 안개가 된다 — "생성됐는데 화면에 없다"로 두 번 신고된
            # 그 증상이다(2026-08-13). 내보내기는 원본 배율 그대로라 무관하다.
            #
            # 목표 크기까지 **블록 최댓값으로 먼저 줄인 뒤** 남은 차이만 LANCZOS로
            # 맞춘다. 획이 살아남는 것은 블록 최댓값이 보장하고, LANCZOS는 정수배로
            # 안 떨어지는 나머지만 다듬으므로 안개를 만들 여지가 없다.
            if scale < 0.5 and (k := max(1, min(w // tw, h // th))) >= 2:
                arr = _visible_reduce(arr, k)
            img = Image.fromarray(arr, "RGBA")
            if (tw, th) != img.size:
                img = img.resize((tw, th), Image.LANCZOS)
            tilecache.store_scaled_overlay(
                session, overlay.get("viewKey"), scale,
                tuple(rgb) if recolour else None, img)
        if skey in scaled:
            scaled.move_to_end(skey)
        else:
            scaled[skey] = img
            while len(scaled) > OVERLAY_SCALED_CACHE:
                scaled.popitem(last=False)
        sx0, sy0 = max(0, -x0), max(0, -y0)
        sx1 = img.width - max(0, x0 + img.width - pw)
        sy1 = img.height - max(0, y0 + img.height - ph)
        if sx1 <= sx0 or sy1 <= sy0:
            continue
        if (sx0, sy0, sx1, sy1) != (0, 0, img.width, img.height):
            img = img.crop((sx0, sy0, sx1, sy1))
        canvas.alpha_composite(img, dest=(x0 + sx0, y0 + sy0))

    t_png = time.perf_counter()
    path = _save_png(canvas, out_dir, "preview")
    _perf(perf="render_preview", n=len(visible_layer_ids),
          tiles_s=round(t_overlay - t_tiles, 4),
          overlay_comp_s=round(t_png - t_overlay, 4),
          png_s=round(time.perf_counter() - t_png, 4))
    return path


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
