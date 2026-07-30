import type { Entry } from "./opsReducer";
import type { TreeNode } from "./types";

/**
 * Suggested export path for the save dialog's defaultPath: same directory as
 * the source (separator preserved verbatim, "/" or "\\"), source stem plus
 * the given suffix, extension always forced to ".psd" regardless of the
 * source's original extension.
 */
export function defaultExportPath(srcPath: string, suffix: string): string {
  const lastSlash = Math.max(srcPath.lastIndexOf("/"), srcPath.lastIndexOf("\\"));
  const dir = lastSlash === -1 ? "" : srcPath.slice(0, lastSlash + 1);
  const fileName = lastSlash === -1 ? srcPath : srcPath.slice(lastSlash + 1);
  const dotIdx = fileName.lastIndexOf(".");
  const stem = dotIdx <= 0 ? fileName : fileName.slice(0, dotIdx);
  return `${dir}${stem}${suffix}.psd`;
}

/**
 * Computes the {layerId, aboveId} args for a "reorder" op from a drag in the
 * export dialog's flat entries list (index 0 = bottom, last index = top).
 * `toIdx` is the entry's target index in the RESULTING array (same
 * convention as common drag-and-drop libraries' "destination index" — e.g.
 * dropping the bottommost entry (index 0) means toIdx=0, dropping onto the
 * topmost slot of an N-entry list means toIdx=N-1). aboveId is the entry
 * that ends up directly below the moved one afterwards; null means the moved
 * entry becomes the new bottom.
 */
export function reorderArgs(
  entries: Entry[],
  fromIdx: number,
  toIdx: number
): { layerId: number; aboveId: number | null } {
  const layerId = entries[fromIdx].entryId;
  const rest = entries.filter((_, i) => i !== fromIdx);
  const aboveId = toIdx === 0 ? null : rest[toIdx - 1].entryId;
  return { layerId, aboveId };
}

/** Depth-first search for a tree node's name by id, or null if not found. */
export function findTreeName(tree: TreeNode[] | undefined, id: number): string | null {
  if (!tree) return null;
  const stack = [...tree];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.id === id) return node.name;
    if (node.children) stack.push(...node.children);
  }
  return null;
}

/**
 * Human-readable name for an export-plan entry id: the entry's own name if
 * set (merge/rename result), else the original tree layer/group name, else a
 * "#id" placeholder as a last resort (should only happen for stale/unknown
 * ids).
 */
export function resolveEntryName(entries: Entry[], tree: TreeNode[] | undefined, id: number): string {
  const entry = entries.find((e) => e.entryId === id);
  if (entry?.name) return entry.name;
  return findTreeName(tree, id) ?? `#${id}`;
}
