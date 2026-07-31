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
  ops: Operation[]; // exclude 제외: merge/rename/reorder/flatten
  entries: Entry[]; // includedIds+ops로부터 계산된 현재 내보내기 목록 (아래→위)
}

export type OpsAction =
  | { type: "reset"; includedIds: number[] }
  | { type: "setIncluded"; includedIds: number[] }
  | { type: "togglePreview"; layerId: number }
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
        for (const layerId of op.layerIds) {
          // "자기 자신이 아닌 항목에 담겨 있으면" 병합된 것이다. 소스가 하나만
          // 남은 병합 항목까지 포함해야, 전부 빼냈을 때 병합이 완전히 사라진다.
          const host = entries.find((e) => e.entryId !== layerId && e.sourceIds.includes(layerId));
          if (host === undefined) continue;   // 이미 단독이거나 대상이 사라졌다
          host.sourceIds = host.sourceIds.filter((id) => id !== layerId);
          const extracted: Entry = { entryId: layerId, sourceIds: [layerId], name: null };
          // 배열 index 0 = 맨 아래. 꺼낸 레이어는 원래 있던 병합 바로 위에 둔다.
          entries.splice(entries.indexOf(host) + 1, 0, extracted);
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

export function opsReducer(state: OpsState, action: OpsAction): OpsState {
  switch (action.type) {
    case "reset": {
      const includedIds = action.includedIds;
      return { includedIds, previewHiddenIds: [], ops: [], entries: buildEntries(includedIds, []) };
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
