import { useMemo } from "react";
import { buildEntries, type Entry, type OpsState } from "../lib/opsReducer";
import { resolveEntryName } from "../lib/exportFlow";
import { summarizeNames } from "../lib/opsLabel";
import type { Operation, TreeNode } from "../lib/types";

interface OpsHistoryProps {
  ops: OpsState;
  tree: TreeNode[] | undefined;
  onUndo: () => void;
}

function name(entriesBefore: Entry[], tree: TreeNode[] | undefined, id: number): string {
  return resolveEntryName(entriesBefore, tree, id);
}

/** 한 줄에 보일 문구와, 마우스를 올렸을 때 보일 전체 목록. */
interface OpRow {
  text: string;
  /** 줄인 것이 없으면 undefined — 같은 내용을 툴팁으로 또 띄울 이유가 없다. */
  full?: string;
}

function describeOp(op: Operation, entriesBefore: Entry[], tree: TreeNode[] | undefined): OpRow {
  switch (op.op) {
    case "merge": {
      const names = op.layerIds.map((id) => name(entriesBefore, tree, id));
      const short = summarizeNames(names);
      const full = names.join(", ");
      return { text: `병합: ${short} → ${op.name}`, full: short === full ? undefined : `병합: ${full} → ${op.name}` };
    }
    case "flatten":
      return { text: `모두 병합 → ${op.name}` };
    case "rename":
      return { text: `이름변경: ${name(entriesBefore, tree, op.layerId)} → ${op.name}` };
    case "reorder": {
      const moved = name(entriesBefore, tree, op.layerId);
      if (op.aboveId === null) return { text: `순서변경: ${moved} → 맨 아래로` };
      return { text: `순서변경: ${moved} → ${name(entriesBefore, tree, op.aboveId)} 바로 위로` };
    }
    case "unmerge": {
      const names = op.layerIds.map((id) => name(entriesBefore, tree, id));
      const short = summarizeNames(names);
      const full = names.join(", ");
      return { text: `병합 해제: ${short}`, full: short === full ? undefined : `병합 해제: ${full}` };
    }
    case "exclude":
      return { text: `제외: ${op.layerIds.length}개 레이어` };
    default:
      return { text: JSON.stringify(op) };
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
          {rows.map((row, i) => (
            <li key={i} title={row.full}>
              {row.text}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
