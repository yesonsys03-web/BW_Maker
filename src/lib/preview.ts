import { EngineRpcError } from "./engine";
import type { EngineError, TreeNode } from "./types";

function isGroup(node: TreeNode): boolean {
  return node.kind === "group";
}

/**
 * Preview-visible pixel leaf ids, in document order: included (checkbox on)
 * and not preview-hidden (eye toggle off). Merge/rename/flatten/reorder ops
 * never change which source pixels compose the flattened image, so this only
 * needs includedIds/previewHiddenIds against the original tree shape — the
 * `entries`/ops layer is irrelevant to what gets rendered.
 */
export function visibleIdsForPreview(
  tree: TreeNode[],
  includedIds: number[],
  previewHiddenIds: number[]
): number[] {
  const includedSet = new Set(includedIds);
  const hiddenSet = new Set(previewHiddenIds);
  const out: number[] = [];

  function walk(nodes: TreeNode[]) {
    for (const node of nodes) {
      if (isGroup(node)) {
        walk(node.children ?? []);
      } else if (node.kind === "pixel" && includedSet.has(node.id) && !hiddenSet.has(node.id)) {
        out.push(node.id);
      }
    }
  }

  walk(tree);
  return out;
}

/**
 * Every pixel leaf id in a tree, document order, regardless of
 * included/preview-hidden state — the request set for the one-shot
 * background thumbnail render after a tree loads.
 */
export function pixelLeafIds(tree: TreeNode[]): number[] {
  const out: number[] = [];

  function walk(nodes: TreeNode[]) {
    for (const node of nodes) {
      if (isGroup(node)) {
        walk(node.children ?? []);
      } else if (node.kind === "pixel") {
        out.push(node.id);
      }
    }
  }

  walk(tree);
  return out;
}

/** Normalizes a thrown value into the app's EngineError shape (mirrors appStore's errorFrom). */
export function toEngineError(e: unknown): EngineError {
  if (e instanceof EngineRpcError) return { message: e.message, traceback: e.traceback };
  if (e instanceof Error) return { message: e.message, traceback: e.stack ?? e.message };
  return { message: String(e), traceback: String(e) };
}

/**
 * True when an engine RPC failure is SessionStore.get raising "unknown or
 * evicted session: {id}" (engine/psd_engine/session.py) — i.e. the LRU
 * cache (max 2 sessions) dropped this file's session in favor of more
 * recently used files. Callers use this to distinguish "transparently
 * reopen and retry" from a real failure that belongs on the ErrorPanel.
 * Substring match (not exact), because Python's KeyError.__str__ wraps the
 * message in repr() quotes: str(KeyError("unknown or evicted session: 2"))
 * === "'unknown or evicted session: 2'".
 */
export function isEvictedSessionError(e: unknown): boolean {
  return toEngineError(e).message.includes("unknown or evicted session");
}

export const MIN_PREVIEW_SCALE = 0.1;
export const MAX_PREVIEW_SCALE = 8;

/**
 * Wheel-driven zoom step for PreviewCanvas: exponential response to deltaY
 * (negative deltaY == scroll up == zoom in), clamped to
 * [MIN_PREVIEW_SCALE, MAX_PREVIEW_SCALE]. Pure so the clamp/direction
 * behavior is unit-testable without a DOM wheel event.
 */
export function nextScale(current: number, deltaY: number): number {
  const factor = Math.exp(-deltaY * 0.001);
  return Math.min(MAX_PREVIEW_SCALE, Math.max(MIN_PREVIEW_SCALE, current * factor));
}
