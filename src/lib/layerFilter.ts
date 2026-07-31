import type { Entry } from "./opsReducer";
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

/** 평면 목록의 한 행: 소스 leaf 하나, 또는 여러 소스가 합쳐진 병합 항목 하나. */
export type FlatRow =
  | { kind: "leaf"; leaf: FlatLeaf }
  | { kind: "merged"; entryId: number; name: string; leaves: FlatLeaf[]; sourceCount: number };

/**
 * 병합된 소스들을 한 행으로 접는다.
 *
 * 트리 보기는 원본 PSD 구조를 그대로 비춰야 해서 병합을 접을 수 없다 — 서로 다른
 * 그룹의 레이어를 병합하면 그 행을 어느 그룹에 둘지 답이 없기 때문이다. 평면
 * 목록에는 그룹이 없으므로 그 문제가 사라지고, 내보내기 결과와 같은 모양
 * ("Chair2" 한 줄)으로 보여줄 수 있다.
 *
 * 행 위치는 그 병합의 소스 중 목록에서 가장 먼저 나오는 자리다.
 */
export function collapseMergedRows(leaves: FlatLeaf[], entries: Entry[]): FlatRow[] {
  const entryBySource = new Map<number, Entry>();
  for (const entry of entries) {
    if (entry.sourceIds.length < 2) continue;
    for (const sourceId of entry.sourceIds) entryBySource.set(sourceId, entry);
  }
  if (entryBySource.size === 0) return leaves.map((leaf) => ({ kind: "leaf", leaf }));

  const present = new Set(leaves.map((l) => l.node.id));
  const emitted = new Set<number>();
  const out: FlatRow[] = [];

  for (const leaf of leaves) {
    const entry = entryBySource.get(leaf.node.id);
    if (entry === undefined) {
      out.push({ kind: "leaf", leaf });
      continue;
    }
    if (emitted.has(entry.entryId)) continue;
    emitted.add(entry.entryId);
    out.push({
      kind: "merged",
      entryId: entry.entryId,
      // 이름 없는 병합은 있을 수 없지만(병합은 항상 이름을 받는다) 타입상 열려 있다.
      name: entry.name ?? "(이름 없음)",
      // 필터에 걸려 지금 보이는 소스만 묶는다. 개수는 병합 전체 기준으로 알린다.
      leaves: leaves.filter((l) => entry.sourceIds.includes(l.node.id) && present.has(l.node.id)),
      sourceCount: entry.sourceIds.length,
    });
  }

  return out;
}

/**
 * 수동 병합 다이얼로그가 미리 채워둘 이름.
 *
 * 라인 레이어는 하나같이 "LINE"이라 이름만으로는 단서가 없다. 실제 단서는 요소
 * 그룹 이름(`CHAIR1_UL`, `CHAIR1_OL`)이므로 거기서 역할 접미사를 떼어내 공통
 * 이름을 찾는다. 전부 같은 요소면 그 이름을, 아니면 공통 접두사를 제안한다.
 * 어디까지나 제안이라 사용자가 고쳐 쓸 수 있다 — 못 찾으면 빈칸으로 둔다.
 */
export function suggestMergeName(leaves: FlatLeaf[], roleTokens: string[]): string {
  const bases = leaves.map((l) => elementNameOf(l, roleTokens)).filter((n) => n.length > 0);
  if (bases.length === 0) return "";
  if (bases.every((b) => b === bases[0])) return bases[0];

  let prefix = bases[0];
  for (const base of bases.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < base.length && prefix[i].toUpperCase() === base[i].toUpperCase()) i++;
    prefix = prefix.slice(0, i);
    if (prefix.length === 0) return "";
  }
  // 접두사가 이름 중간에서 잘리면(CHAIR1/CHAIR2 → "CHAIR") 그대로 쓰되,
  // 구분자로 끝나면 다듬는다.
  return prefix.replace(/[_\-\s]+$/, "");
}

/** 레이어가 속한 요소 이름. 엔진 element_of와 같은 규칙(제안용 근사). */
function elementNameOf(leaf: FlatLeaf, roleTokens: string[]): string {
  const tokens = [...roleTokens].filter((t) => t.trim().length > 0).sort((a, b) => b.length - a.length);
  const names = [...leaf.node.path].reverse();
  for (const raw of names) {
    const name = raw.trim();
    const upper = name.toUpperCase();
    for (const token of tokens) {
      const t = token.trim().toUpperCase();
      if (upper === t) return name;
      if (["_", "-", " "].some((sep) => upper.endsWith(sep + t))) {
        return name.slice(0, name.length - t.length).replace(/[_\-\s]+$/, "") || name;
      }
    }
  }
  return "";
}
