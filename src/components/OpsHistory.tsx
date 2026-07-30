import { useMemo } from "react";
import { buildEntries, type Entry, type OpsState } from "../lib/opsReducer";
import { resolveEntryName } from "../lib/exportFlow";
import type { Operation, TreeNode } from "../lib/types";

interface OpsHistoryProps {
  ops: OpsState;
  tree: TreeNode[] | undefined;
  onUndo: () => void;
}

function name(entriesBefore: Entry[], tree: TreeNode[] | undefined, id: number): string {
  return resolveEntryName(entriesBefore, tree, id);
}

function describeOp(op: Operation, entriesBefore: Entry[], tree: TreeNode[] | undefined): string {
  switch (op.op) {
    case "merge": {
      const names = op.layerIds.map((id) => name(entriesBefore, tree, id));
      return `병합: ${names.join(", ")} → ${op.name}`;
    }
    case "flatten":
      return `모두 병합 → ${op.name}`;
    case "rename":
      return `이름변경: ${name(entriesBefore, tree, op.layerId)} → ${op.name}`;
    case "reorder": {
      const moved = name(entriesBefore, tree, op.layerId);
      if (op.aboveId === null) return `순서변경: ${moved} → 맨 아래로`;
      return `순서변경: ${moved} → ${name(entriesBefore, tree, op.aboveId)} 바로 위로`;
    }
    case "exclude":
      return `제외: ${op.layerIds.length}개 레이어`;
    default:
      return JSON.stringify(op);
  }
}

/**
 * Bottom-strip history tab: renders `ops.ops` as human-readable sentences
 * ("병합: line, lines → M") by rebuilding the entries snapshot as of just
 * before each op (buildEntries(includedIds, ops.slice(0, i))) so merge/
 * rename/reorder refs resolve to the names visible at that point — not just
 * raw ids. Safe without extra validation: ops.ops already passed
 * buildEntries(includedIds, ops.ops) in full (opsReducer enforces this on
 * every push), so every prefix of it is guaranteed valid against the same
 * includedIds too.
 */
export function OpsHistory({ ops, tree, onUndo }: OpsHistoryProps) {
  const rows = useMemo(
    () => ops.ops.map((op, i) => describeOp(op, buildEntries(ops.includedIds, ops.ops.slice(0, i)), tree)),
    [ops.ops, ops.includedIds, tree]
  );

  return (
    <div className="ops-history">
      <div className="ops-history-header">
        <span>작업 히스토리</span>
        <button type="button" onClick={onUndo} disabled={ops.ops.length === 0}>
          마지막 취소
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="ops-history-empty">편집 내역이 없습니다.</p>
      ) : (
        <ol className="ops-history-list">
          {rows.map((text, i) => (
            <li key={i}>{text}</li>
          ))}
        </ol>
      )}
    </div>
  );
}
