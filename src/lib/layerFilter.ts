import type { TreeNode } from "./types";

/**
 * 레이어 패널의 보기 모드. 소스 PSD는 레이어가 수백 장이라 전체 트리에서
 * 라인 레이어를 골라내는 것이 실질적으로 어렵다 — "라인만"은 트리를 접어두고
 * 해당 leaf만 평면으로 나열한다.
 *
 * "포함됨"(체크된 것만) 모드도 한때 있었으나 뺐다: 프리셋을 적용하면
 * includedIds가 매칭 결과로 세팅되므로 주 워크플로에서 "라인만"과 같은 목록이
 * 되고, 내보낼 대상 확인은 내보내기 다이얼로그가 순서·이름·검증까지 보여주는
 * 더 나은 자리를 이미 갖고 있다.
 */
export type LayerFilterMode = "all" | "line";

export const LAYER_FILTER_MODES: readonly LayerFilterMode[] = ["all", "line"];

export const LAYER_FILTER_LABELS: Record<LayerFilterMode, string> = {
  all: "전체",
  line: "라인만",
};

/** 프리셋 매칭 결과가 아직 없을 때 "라인만"이 대신 쓰는 이름 규칙. */
export const LINE_NAME_FALLBACK = "line";

export interface FlatLeaf {
  node: TreeNode;
  /**
   * 조상 그룹 이름만 이어붙인 경로(자기 이름 제외). 평면 목록에서는 트리 구조가
   * 사라지는데, 실제 소스 PSD에는 그룹마다 똑같이 "LINE"이라 불리는 레이어가
   * 여러 개 있어 이름만으로는 구분이 안 된다. 루트 직속 leaf면 빈 문자열.
   */
  breadcrumb: string;
}

function isGroup(node: TreeNode): boolean {
  return node.kind === "group";
}

/** 트리의 모든 leaf를 문서 순서대로 평면화한다(그룹 자신은 제외). */
export function flattenLeaves(nodes: TreeNode[], out: FlatLeaf[] = []): FlatLeaf[] {
  for (const node of nodes) {
    if (isGroup(node)) {
      flattenLeaves(node.children ?? [], out);
    } else {
      // node.path는 조상 이름 + 자기 이름이다(engine/psd_engine/tree.py).
      out.push({ node, breadcrumb: node.path.slice(0, -1).join(" / ") });
    }
  }
  return out;
}

/**
 * "라인만" 필터가 대상으로 삼는 leaf id.
 *
 * 프리셋을 적용해 matchedIds가 있으면 그대로 쓴다 — 사용자가 실제로 쓰는 규칙과
 * 정확히 일치해야 하고, 그 규칙이 꼭 "line"이라는 단어일 필요도 없기 때문이다.
 * 아직 적용 전이라 비어 있으면 이름에 "line"이 들어간 leaf로 대체해, 프리셋
 * 없이도 패널을 바로 쓸 수 있게 한다.
 */
export function lineLeafIds(leaves: FlatLeaf[], matchedIds: number[]): number[] {
  if (matchedIds.length > 0) {
    const matched = new Set(matchedIds);
    // matchedIds에는 (matchGroups 프리셋에서) 그룹 id가 섞일 수 있다. 평면
    // 목록은 leaf만 그리므로 leaf로 교집합을 낸다.
    return leaves.filter((l) => matched.has(l.node.id)).map((l) => l.node.id);
  }
  return leaves
    .filter((l) => l.node.name.toLowerCase().includes(LINE_NAME_FALLBACK))
    .map((l) => l.node.id);
}

/** "라인만"이 프리셋 매칭이 아니라 이름 규칙으로 대체 동작 중인지. */
export function isLineFallbackActive(mode: LayerFilterMode, matchedIds: number[]): boolean {
  return mode === "line" && matchedIds.length === 0;
}

export interface LayerFilterInput {
  mode: LayerFilterMode;
  query: string;
  matchedIds: number[];
}

/**
 * 필터가 걸려 있는지 — 걸려 있으면 평면 목록을, 아니면 원래 트리를 그린다.
 * "전체"에서도 검색어를 치면 평면 목록으로 넘어간다(트리를 유지한 채 검색하면
 * 결과가 접힌 그룹 안에 숨어 오히려 못 찾는다).
 */
export function isFiltering(mode: LayerFilterMode, query: string): boolean {
  return mode !== "all" || query.trim().length > 0;
}

export function filterLeaves(leaves: FlatLeaf[], input: LayerFilterInput): FlatLeaf[] {
  let out = leaves;

  if (input.mode === "line") {
    const ids = new Set(lineLeafIds(leaves, input.matchedIds));
    out = out.filter((l) => ids.has(l.node.id));
  }

  const q = input.query.trim().toLowerCase();
  if (q.length > 0) {
    // 이름과 경로 양쪽을 본다 — "PIPES"로 그룹을 좁히는 쪽이 자연스럽다.
    out = out.filter(
      (l) => l.node.name.toLowerCase().includes(q) || l.breadcrumb.toLowerCase().includes(q)
    );
  }

  return out;
}

/**
 * 표시 중인 leaf 가운데 내보내기 포함 토글이 가능한(pixel) id. 필터로 좁힌
 * 집합에 대한 일괄 체크/해제의 대상이다 — pixel이 아닌 leaf는 애초에 체크박스가
 * 비활성이라 제외한다.
 */
export function bulkTogglableIds(leaves: FlatLeaf[]): number[] {
  return leaves.filter((l) => l.node.kind === "pixel").map((l) => l.node.id);
}

/** 일괄 체크/해제 후의 includedIds. 오름차순 정렬은 기존 규약을 따른다. */
export function applyBulkInclude(includedIds: number[], targetIds: number[], include: boolean): number[] {
  if (include) {
    return Array.from(new Set([...includedIds, ...targetIds])).sort((a, b) => a - b);
  }
  const drop = new Set(targetIds);
  return includedIds.filter((id) => !drop.has(id));
}
