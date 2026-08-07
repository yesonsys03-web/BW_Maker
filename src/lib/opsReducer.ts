import type { Operation } from "./types";

/**
 * Client-side mirror of the engine's export plan entry (engine/psd_engine/ops.py).
 */
export interface Entry {
  entryId: number;
  sourceIds: number[];
  name: string | null;
}

export interface OpsState {
  includedIds: number[]; // 체크박스 (정렬된 리프 id, 아래→위)
  previewHiddenIds: number[]; // 눈 아이콘 off (미리보기 전용, 내보내기와 무관)
  /**
   * solo (미리보기 전용). 하나라도 있으면 미리보기는 이것만 그리고 체크박스와
   * 눈을 무시한다 — 이름만으로 라인인지 알 수 없는 레이어를 눈으로 판정하는 용도다.
   * previewHiddenIds와 독립이라, solo를 풀면 원래 화면이 그대로 돌아온다.
   */
  soloIds: number[];
  /**
   * 색 경계선 생성의 수동 지정(설계 3.1) — 아티스트가 레이어 트리에서 직접
   * 짚은 색 레이어(잎) id. 체크박스(includedIds)와 완전히 분리된 별도의
   * per-layer 집합이다: 체크박스를 그대로 쓰면 지정한 색 레이어가 그 자체로
   * 내보내기 엔트리가 되어 산출물에 색 레이어가 한 장 끼어든다 — "최종 라인
   * 레이어만 내보낸다"는 이 기능의 목적과 정면으로 어긋난다.
   *
   * 내보내기와 무관하고(soloIds처럼 화면 조작을 위한 것도 아니다), 렌더/
   * 내보내기 요청의 payload에만 실린다. 프리셋에는 저장하지 않는다 — 어떤
   * 레이어가 색 원본인지는 파일마다 다른 사실이고 프리셋은 파일과 무관하다.
   */
  edgeColourIds: number[];
  ops: Operation[]; // exclude 제외: merge/rename/reorder/flatten
  entries: Entry[]; // includedIds+ops로부터 계산된 현재 내보내기 목록 (아래→위)
}

export type OpsAction =
  | { type: "reset"; includedIds: number[] }
  | { type: "setIncluded"; includedIds: number[] }
  | { type: "togglePreview"; layerId: number }
  | { type: "toggleSolo"; layerId: number }
  | { type: "setSolo"; layerIds: number[]; solo: boolean }
  | { type: "toggleEdgeColour"; layerId: number }
  | { type: "setEdgeColour"; layerIds: number[]; on: boolean }
  | { type: "pushOp"; op: Operation }
  | { type: "undo" };

/**
 * TS mirror of engine/psd_engine/ops.py build_export_plan. Same semantics:
 * merge inserts at the topmost source position with sourceIds bottom→top,
 * merge entryIds count down from -1 and may be re-merged; flatten merges
 * every current entry; reorder aboveId=null moves to the bottom.
 * "exclude" is not supported here — the checkbox-driven includedIds/
 * setIncluded replaces it.
 *
 * ops는 includedIds 위에서 매번 처음부터 재생된다. 그래서 어떤 작업이 가리키던
 * 레이어의 체크가 풀리면 그 작업은 실패가 아니라 남은 것들에 대해서만 성립한다
 * (2장 병합에서 하나가 빠지면 나머지 하나가 그 이름을 이어받는 식). 체크를 다시
 * 켜면 재생 결과가 원래대로 돌아온다.
 */
export function buildEntries(includedIds: number[], ops: Operation[]): Entry[] {
  const entries: Entry[] = includedIds.map((id) => ({ entryId: id, sourceIds: [id], name: null }));
  const byId = new Map<number, Entry>(entries.map((e) => [e.entryId, e]));
  let mergeCounter = 0;

  const doMerge = (entryIds: number[], name: string | null) => {
    // includedIds가 무엇이 내보내지는지의 기준이다. 체크를 푼 레이어는 애초에
    // 산출물에 없으므로, 그 레이어를 참조하던 병합은 "실패"가 아니라 남은
    // 것들끼리의 병합으로 성립한다. 예전에는 여기서 예외가 나서, 병합에 참여한
    // 레이어의 체크를 푸는 것만으로 "먼저 병합을 되돌리라"는 에러가 떴다.
    const group = entryIds
      .map((id) => byId.get(id))
      .filter((e): e is Entry => e !== undefined);

    // 병합 항목 id는 결과와 무관하게 소비한다 — 그래야 이 병합을 가리키는
    // 뒤쪽 작업(예: 병합 결과의 이름변경)의 id가 어긋나지 않는다.
    mergeCounter -= 1;

    if (group.length === 0) return;
    if (group.length === 1) {
      // 합칠 상대가 없다. 남은 항목이 그 병합의 자리(id·이름)를 이어받는다.
      const only = group[0];
      byId.delete(only.entryId);
      only.entryId = mergeCounter;
      only.name = name;
      byId.set(only.entryId, only);
      return;
    }

    const groupSorted = [...group].sort((a, b) => entries.indexOf(a) - entries.indexOf(b));
    const topIndex = entries.indexOf(groupSorted[groupSorted.length - 1]);
    const merged: Entry = {
      entryId: mergeCounter,
      sourceIds: groupSorted.flatMap((e) => e.sourceIds),
      name,
    };
    entries.splice(topIndex + 1, 0, merged);
    for (const e of group) {
      const idx = entries.indexOf(e);
      if (idx === -1) throw new Error(`duplicate entry id in merge: ${e.entryId}`);
      entries.splice(idx, 1);
      byId.delete(e.entryId);
    }
    byId.set(merged.entryId, merged);
  };

  for (const op of ops) {
    switch (op.op) {
      case "exclude":
        throw new Error("exclude op is not supported by buildEntries; use setIncluded instead");
      // rename/reorder도 같은 이유로 대상이 사라졌으면 조용히 건너뛴다: 그
      // 레이어는 이미 내보내기 대상이 아니므로 이름을 바꾸거나 순서를 옮길
      // 것이 없다. 나중에 다시 체크하면 ops를 처음부터 재생하므로 그대로
      // 되살아난다.
      case "rename": {
        const e = byId.get(op.layerId);
        if (e !== undefined) e.name = op.name;
        break;
      }
      case "merge":
        doMerge(op.layerIds, op.name);
        break;
      case "flatten":
        doMerge(entries.map((e) => e.entryId), op.name);
        break;
      // 병합에서 빼내 단독 항목으로 되돌린다. 자동 병합이 요소를 잘못 묶었을 때
      // 그 레이어만 꺼내는 용도라, 대상은 항상 원본 레이어 id다.
      case "unmerge": {
        // 한 병합에서 여러 장을 뺄 때, 전부 같은 자리에 끼워넣으면 서로의 순서가
        // 뒤집힌다(나중에 뺀 것이 아래로 간다). 다시 묶을 때 이 순서가 그대로
        // 소스 쌓임 순서가 되므로, 뺀 순서를 그대로 유지한다.
        const placed = new Map<number, number>(); // host entryId -> 이번 op에서 그 위에 넣은 수
        for (const layerId of op.layerIds) {
          // "자기 자신이 아닌 항목에 담겨 있으면" 병합된 것이다. 소스가 하나만
          // 남은 병합 항목까지 포함해야, 전부 빼냈을 때 병합이 완전히 사라진다.
          const host = entries.find((e) => e.entryId !== layerId && e.sourceIds.includes(layerId));
          if (host === undefined) continue;   // 이미 단독이거나 대상이 사라졌다
          host.sourceIds = host.sourceIds.filter((id) => id !== layerId);
          const extracted: Entry = { entryId: layerId, sourceIds: [layerId], name: null };
          // 배열 index 0 = 맨 아래. 꺼낸 레이어는 원래 있던 병합 바로 위에 둔다.
          const above = placed.get(host.entryId) ?? 0;
          entries.splice(entries.indexOf(host) + 1 + above, 0, extracted);
          placed.set(host.entryId, above + 1);
          byId.set(layerId, extracted);
          if (host.sourceIds.length === 0) {
            entries.splice(entries.indexOf(host), 1);
            byId.delete(host.entryId);
          }
        }
        break;
      }
      case "reorder": {
        const e = byId.get(op.layerId);
        if (e === undefined) break;
        if (op.aboveId === null) {
          entries.splice(entries.indexOf(e), 1);
          entries.splice(0, 0, e);
          break;
        }
        // 기준이던 항목이 사라졌으면 "그 위로"가 성립하지 않는다. 억지로 다른
        // 자리에 끼워넣지 않고 원래 자리에 둔다.
        const above = byId.get(op.aboveId);
        if (above === undefined) break;
        entries.splice(entries.indexOf(e), 1);
        const aboveIdx = entries.indexOf(above);
        if (aboveIdx === -1) {
          throw new Error(`reorder: aboveId ${op.aboveId} not found in entries (self-reference?)`);
        }
        entries.splice(aboveIdx + 1, 0, e);
        break;
      }
      default:
        throw new Error(`unknown op: ${JSON.stringify(op)}`);
    }
  }

  return entries;
}

/** 지금 어떤 병합에 묶여 있는 소스 레이어들 — 자기 자신이 아닌 항목에 담겨 있으면 병합된 것이다. */
export function mergedSourceIds(entries: Entry[]): Set<number> {
  const ids = new Set<number>();
  for (const entry of entries) {
    for (const id of entry.sourceIds) if (entry.entryId !== id) ids.add(id);
  }
  return ids;
}

/**
 * 대상 중 이미 다른 병합에 묶여 있는 것들. 오름차순 = 아래→위(includedIds와 같은
 * 규약)로 돌려준다 — 빼내는 순서가 그대로 다시 묶일 때의 쌓임 순서가 되므로,
 * 호출 쪽의 목록 순서와 무관하게 원래 순서를 지킨다.
 */
function alreadyMerged(entries: Entry[], targetIds: number[]): number[] {
  const merged = mergedSourceIds(entries);
  return targetIds.filter((id) => merged.has(id)).sort((a, b) => a - b);
}

/**
 * 자동 병합 결과를 "지금 상태 위에 얹을 수 있는" 연산 목록으로 바꾼다.
 *
 * 엔진의 자동 병합은 아무것도 병합되지 않은 상태를 가정한다. 그대로 얹으면 두
 * 군데가 어긋난다:
 *   1. merge가 가리키는 원본 레이어 id는 이미 병합된 뒤에는 항목 목록에 없다
 *      (병합 항목 id로 바뀌어 있다). buildEntries는 대상을 못 찾으면 조용히
 *      건너뛰므로, 규칙을 바꿔 다시 눌러도 화면이 그대로였다. 그래서 대상 중
 *      이미 병합된 것을 먼저 unmerge로 풀어 원래 id를 되살린다.
 *   2. 병합 항목 id는 merge/flatten 하나당 하나씩 세션 전체에서 소비되는데,
 *      엔진은 자기 병합이 -1부터 시작한다고 보고 reorder를 붙인다. 이미 소비된
 *      수만큼 밀어주지 않으면 reorder가 엉뚱한 항목을 가리켜 순서가 엉킨다.
 */
export function autoMergeOps(
  engineOps: Operation[],
  state: OpsState,
  targetIds: number[]
): Operation[] {
  const toUnmerge = alreadyMerged(state.entries, targetIds);

  // unmerge는 병합 항목 id를 소비하지 않으므로 앞에 붙어도 아래 보정에 영향이 없다.
  const consumed = state.ops.filter((op) => op.op === "merge" || op.op === "flatten").length;
  const shift = (id: number) => (id < 0 ? id - consumed : id);
  const rebased = engineOps.map((op): Operation => {
    switch (op.op) {
      case "merge":
        return { ...op, layerIds: op.layerIds.map(shift) };
      case "rename":
        return { ...op, layerId: shift(op.layerId) };
      case "reorder":
        return { ...op, layerId: shift(op.layerId), aboveId: op.aboveId === null ? null : shift(op.aboveId) };
      default:
        return op;
    }
  });

  return toUnmerge.length > 0 ? [{ op: "unmerge", layerIds: toUnmerge }, ...rebased] : rebased;
}

/** 우클릭 "병합에 넣기"의 목적지 하나. */
export interface MergeDestination {
  /** 기존 병합 항목이면 그 항목 id. 아직 없는 이름으로 새로 만들 목적지면 undefined. */
  entryId?: number;
  name: string;
  /** 지금 그 병합에 들어 있는 소스 수. 새로 만들 목적지는 0. */
  sourceCount: number;
}

/**
 * 선택한 레이어를 넣을 수 있는 병합 목록.
 *
 * 자동 병합으로 BG/MG/FG를 만든 뒤 빠진 레이어를 주워담는 것이 주 용도지만,
 * 아직 그 덩어리가 없을 때도 바로 만들 수 있어야 한다(자동 병합 없이 한두 장만
 * 옮기는 경우). 그래서 기존 병합 항목 + 아직 없는 평면 이름을 함께 돌려준다.
 */
export function mergeDestinations(
  entries: Entry[],
  targetIds: number[],
  planeTokens: readonly string[]
): MergeDestination[] {
  const targets = new Set(targetIds);
  const existing = entries
    // 병합 항목만. 그리고 그 병합의 소스가 전부 선택된 것이라면 목적지가 아니다
    // (자기 자신에게 넣는 셈이라 아무 일도 일어나지 않는다).
    .filter((e) => e.sourceIds.length > 1 && e.sourceIds.some((id) => !targets.has(id)))
    .map((e) => ({ entryId: e.entryId, name: e.name ?? "merged", sourceCount: e.sourceIds.length }));

  // 이미 있는 병합 이름은 "새로 만들기"로 다시 내밀지 않는다. existing이 아니라
  // 모든 병합 항목에서 모아야 한다 — 선택한 것뿐인 병합은 위에서 목적지에서
  // 빠지는데, 그것 때문에 같은 이름이 새 목적지로 되살아나면 안 된다.
  const taken = new Set(
    entries.filter((e) => e.sourceIds.length > 1 && e.name).map((e) => e.name!.toUpperCase())
  );
  const fresh = planeTokens
    .filter((token) => !taken.has(token.toUpperCase()))
    .map((token) => ({ name: token, sourceCount: 0 }));

  return [...existing, ...fresh];
}

/**
 * 선택한 레이어를 목적지 병합에 합치는 연산.
 *
 * 이미 다른 병합에 묶여 있는 레이어는 먼저 빼내야 한다 — 병합된 뒤에는 원본
 * 레이어 id가 항목 목록에 없어서, 그냥 merge를 얹으면 조용히 무시된다
 * (autoMergeOps와 같은 이유).
 */
export function mergeIntoOps(
  entries: Entry[],
  targetIds: number[],
  dest: MergeDestination
): Operation[] {
  const host = dest.entryId === undefined ? undefined : entries.find((e) => e.entryId === dest.entryId);
  // 이미 그 병합에 들어 있는 것은 옮길 것이 없다.
  const moving = host ? targetIds.filter((id) => !host.sourceIds.includes(id)) : targetIds;
  if (moving.length === 0) return [];

  const ops: Operation[] = [];
  const stuck = alreadyMerged(entries, moving);
  if (stuck.length > 0) ops.push({ op: "unmerge", layerIds: stuck });
  // 목적지 항목 자체를 함께 넘겨 그 덩어리에 흡수시킨다. 새로 만드는 경우는
  // 선택한 것들끼리 묶고 이름만 목적지 이름으로 붙인다.
  ops.push({ op: "merge", layerIds: host ? [host.entryId, ...moving] : moving, name: dest.name });
  return ops;
}

export function opsReducer(state: OpsState, action: OpsAction): OpsState {
  switch (action.type) {
    case "reset": {
      const includedIds = action.includedIds;
      return {
        includedIds, previewHiddenIds: [], soloIds: [], edgeColourIds: [],
        ops: [], entries: buildEntries(includedIds, []),
      };
    }
    case "setIncluded": {
      const includedIds = action.includedIds;
      return { ...state, includedIds, entries: buildEntries(includedIds, state.ops) };
    }
    case "togglePreview": {
      const { layerId } = action;
      const previewHiddenIds = state.previewHiddenIds.includes(layerId)
        ? state.previewHiddenIds.filter((id) => id !== layerId)
        : [...state.previewHiddenIds, layerId];
      return { ...state, previewHiddenIds };
    }
    case "toggleSolo": {
      const { layerId } = action;
      const soloIds = state.soloIds.includes(layerId)
        ? state.soloIds.filter((id) => id !== layerId)
        : [...state.soloIds, layerId];
      return { ...state, soloIds };
    }
    case "setSolo": {
      const target = new Set(action.layerIds);
      const soloIds = action.solo
        ? Array.from(new Set([...state.soloIds, ...action.layerIds]))
        : state.soloIds.filter((id) => !target.has(id));
      return { ...state, soloIds };
    }
    case "toggleEdgeColour": {
      const { layerId } = action;
      const edgeColourIds = state.edgeColourIds.includes(layerId)
        ? state.edgeColourIds.filter((id) => id !== layerId)
        : [...state.edgeColourIds, layerId];
      return { ...state, edgeColourIds };
    }
    case "setEdgeColour": {
      const target = new Set(action.layerIds);
      const edgeColourIds = action.on
        ? Array.from(new Set([...state.edgeColourIds, ...action.layerIds]))
        : state.edgeColourIds.filter((id) => !target.has(id));
      return { ...state, edgeColourIds };
    }
    case "pushOp": {
      // Throws on invalid refs (unchanged) — caller/UI catches and displays.
      const ops = [...state.ops, action.op];
      const entries = buildEntries(state.includedIds, ops);
      return { ...state, ops, entries };
    }
    case "undo": {
      const ops = state.ops.slice(0, -1);
      return { ...state, ops, entries: buildEntries(state.includedIds, ops) };
    }
    default:
      return state;
  }
}

export interface ExportLabel {
  /** 내보낼 때 이 레이어가 갖게 될 이름. */
  name: string;
  /** 여러 소스가 하나로 합쳐진 항목인지. */
  merged: boolean;
  /** 그 병합에 함께 들어간 소스 레이어 수(병합이 아니면 1). */
  sourceCount: number;
}

/**
 * 소스 레이어 id → 그 레이어가 내보내기에서 갖게 될 이름.
 *
 * 레이어 트리는 원본 PSD 구조를 그대로 보여주고 병합/이름변경은 트리를 건드리지
 * 않는다(내보내기 계획에만 쌓인다). 그래서 두 레이어를 병합해도 패널에서는 아무
 * 일도 일어나지 않은 것처럼 보인다 — 이 매핑으로 각 행에 결과를 붙여준다.
 *
 * 이름이 붙지 않은 항목(단순 복사)은 원본 이름 그대로 나가므로 제외한다.
 */
export function exportLabelsBySourceId(entries: Entry[]): Map<number, ExportLabel> {
  const out = new Map<number, ExportLabel>();
  for (const entry of entries) {
    if (entry.name === null) continue;
    for (const sourceId of entry.sourceIds) {
      out.set(sourceId, {
        name: entry.name,
        merged: entry.sourceIds.length > 1,
        sourceCount: entry.sourceIds.length,
      });
    }
  }
  return out;
}
