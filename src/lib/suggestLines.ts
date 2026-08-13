import { hasAnyToken } from "./layerNames";
import type { Preset, TreeNode } from "./types";

/**
 * 프리셋이 라인을 한 장도 못 잡은 파일("라인필요")에서 라인으로 지정할 후보.
 *
 * 이런 판(군중 판)에는 획으로 그린 선화가 아예 없다 — HH0307 CH의 0매칭 13장을
 * 잎 전부 눈으로 확인한 결과(2026-08-13), 그림은 모두 실루엣 면 채색이고 이름에
 * line이 없다. 납품에는 그 실루엣이 그대로 나가야 하므로, 여기서 고르는 기준은
 * "선처럼 생겼는가"가 아니라 **"그림인가"**다: 그림이 아닌 것(참고자료·장식·
 * 글자·발광)만 빼고 전부 담는다.
 *
 * 어휘는 2026-08 군중 판 전수 측정에서 나온 그대로다 — 이 규칙으로 잎 64장 중
 * 63장 정확, 오염 0. 당시 아티스트가 거절한 것은 이것을 **프리셋**으로 만들어
 * 일반 판에도 걸리게 하는 안이었다(일반 판에서는 색 레이어까지 전부 라인으로
 * 잡는다). 그래서 이 함수는 프리셋 매칭이 0장인 파일에서 사람이 버튼을 눌렀을
 * 때만 쓰이고, 결과는 일반 수동 지정과 같아서 트리에서 보이고 해제할 수 있다.
 */
// "ref"는 측정 어휘에 없었지만 REFS **그룹** 제외와 같은 취지다 — HH0307의
// 군중 판 하나가 참고 이미지를 그룹 없이 `REF`라는 잎으로 들고 있어(2026-08-13
// 실측, 파일 38) 그룹 규칙만으로는 새는 것을 확인했다. 복수형(REFS)은
// hasAnyToken이 알아서 접는다.
export const SUGGEST_EXCLUDE_TOKENS = ["glow", "behind", "board", "box", "paper", "ref"];

/** 그림이 아닌 것을 담는 그룹. 이름 비교는 대소문자 무시, 정확히 일치. */
export const SUGGEST_EXCLUDE_GROUPS = ["refs", "borders", "labels", "paper"];

export function suggestLineLayers(tree: TreeNode[], preset: Preset): number[] {
  const prefixes = preset.excludeGroupPrefixes ?? [];
  const out: number[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      const name = (node.name ?? "").trim();
      if (node.kind === "group") {
        // 프리셋의 제외 그룹(HEIGHTS, TEMPLATE, COLOR PALETTE …)은 매칭과 같은
        // 이유로 여기서도 통째로 건너뛴다 — 참고용 그림이지 납품물이 아니다.
        if (prefixes.some((p) => name.startsWith(p))) continue;
        if (SUGGEST_EXCLUDE_GROUPS.includes(name.toLowerCase())) continue;
        // `halo glow` 같은 발광 그룹은 그룹 이름에만 표식이 있다 — 잎 이름만
        // 보면 19장이 딸려 들어온 전례가 있어 그룹 이름에도 토큰을 건다.
        if (hasAnyToken(name, SUGGEST_EXCLUDE_TOKENS)) continue;
        walk(node.children ?? []);
        continue;
      }
      // 지정할 수 있는 잎의 조건과 같아야 한다(LayerTree의 체크박스·L 지정이
      // pixel만 받는다). hasPixels가 없는 트리는 이 필드가 생기기 전 것 —
      // 그때의 유일한 통과 조건이 kind == "pixel"이었으므로 그대로 통과시킨다.
      if (node.kind !== "pixel") continue;
      if (node.hasPixels === false) continue;
      if (hasAnyToken(name, SUGGEST_EXCLUDE_TOKENS)) continue;
      out.push(node.id);
    }
  };
  walk(tree);
  return out;
}
