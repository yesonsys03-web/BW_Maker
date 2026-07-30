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
 * every current entry; reorder aboveId=null moves to the bottom; unknown
 * refs throw. "exclude" is not supported here — the checkbox-driven
 * includedIds/setIncluded replaces it.
 */
export function buildEntries(includedIds: number[], ops: Operation[]): Entry[] {
  const entries: Entry[] = includedIds.map((id) => ({ entryId: id, sourceIds: [id], name: null }));
  const byId = new Map<number, Entry>(entries.map((e) => [e.entryId, e]));
  let mergeCounter = 0;

  const require_ = (entryId: number): Entry => {
    const e = byId.get(entryId);
    if (e === undefined) throw new Error(`unknown entry id: ${entryId}`);
    return e;
  };

  const doMerge = (entryIds: number[], name: string | null) => {
    const group = entryIds.map((id) => require_(id));
    if (group.length < 2) throw new Error("merge needs at least 2 layers");
    const groupSorted = [...group].sort((a, b) => entries.indexOf(a) - entries.indexOf(b));
    const topIndex = entries.indexOf(groupSorted[groupSorted.length - 1]);
    mergeCounter -= 1;
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
      case "rename":
        require_(op.layerId).name = op.name;
        break;
      case "merge":
        doMerge(op.layerIds, op.name);
        break;
      case "flatten":
        doMerge(entries.map((e) => e.entryId), op.name);
        break;
      case "reorder": {
        const e = require_(op.layerId);
        entries.splice(entries.indexOf(e), 1);
        if (op.aboveId === null) {
          entries.splice(0, 0, e);
        } else {
          const above = require_(op.aboveId);
          entries.splice(entries.indexOf(above) + 1, 0, e);
        }
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
