"""색으로만 갈린 경계에 획을 만든다 — 캐릭터 모델 전용.

**레이어별 알파 경계가 아니라 합성된 그림의 색 변화를 본다.** 레이어의 알파를 그대로
쓰면 다른 레이어에 가려져 실제로는 보이지 않는 경계까지 후보가 된다. 실측에서 그 방식은
셔츠 전체에 격자 모양 획을 만들었고, 합성 후에는 그것이 통째로 사라졌다.

scipy를 쓰지 않는다(엔진 venv에 없다). 모폴로지는 PIL, 연결 요소는 직접 구현한다.
"""
import numpy as np

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
