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
//
// 필드가이드 세 표기(2026-08-20 신고). 빨간 주석 획이라 굵기로는 영락없는 선이고,
// BG 26장 실측이 이미 "주석 부류는 이름으로 걸러야 한다"고 결론 낸 자리다.
// 토크나이저를 실제로 돌려 본 결과가 셋을 다 필요하게 만든다:
//   *FIELDGUIDES → ["FIELDGUIDES"]  별표는 버려지고 복수형은 접히므로 fieldguide
//   FLGD         → ["FLGD"]         약어는 부분문자열 매칭이 없어 자기 토큰이 필요
//   FIELD GUIDE  → ["FIELD","GUIDE"] 띄어 쓰면 두 토큰이라 guide가 받는다
//
// `notes`는 CH 74판 전수 실측이 데려왔다(2026-08-21). 확실 구간을 통과한 잎이
// 74판 4,467장 중 5장뿐인데 **그중 셋이 주석 지시 화살표**였다 — 판을 가로지르는
// 화살표라 굵기로는 완벽한 선(s2 0.00~0.09)이다. 이 한 낱말로 검출 정밀도가
// 2/5에서 2/2가 된다. 그룹 이름이 문이고(`POSES/NOTES`, `EXTRA NOTES` — 토큰
// 둘이라 notes가 받는다), 같은 그룹 아래 이름에 line이 있는 진짜 캐릭터 도해
// 81장은 **매칭**이 내보내므로 출고가 줄지 않는다(어휘는 매칭 경로에 안 닿는다).
// 트레이드오프: 그 주석 그룹 아래에서는 검출이 통째로 꺼진다 — 나중에 문턱
// 밴드를 넓힐 때 그 안에서 잡을 수 있었던 것은 안 잡힌다.
//
// `overlay`는 같은 측정이 기각했다: CH 74판에 0장, BG 26장에서도 확실 구간
// 기여가 notes와 겹치는 1장뿐이라 순 이득이 0인데, 블렌드 모드 이름이라 언젠가
// 진짜 선화를 담은 그룹을 통째로 지울 위험만 남는다.
export const SUGGEST_EXCLUDE_TOKENS = [
  "glow", "behind", "board", "box", "paper", "ref",
  "fieldguide", "flgd", "guide",
  "notes",
];

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
