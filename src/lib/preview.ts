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

/**
 * 미리보기 뒤에 깔리는 배경. 라인 추출 결과는 투명 배경에 어두운 선만 남는
 * 경우가 많아 체커보드 위에서는 사실상 보이지 않는다. 그래서 기본값은
 * "white"이고, 대신 체커보드(투명 여부 확인용)와 검정(밝은 선 확인용)을
 * 언제든 고를 수 있게 남겨둔다.
 */
export type PreviewBackground = "white" | "checker" | "black";

export const PREVIEW_BACKGROUNDS: readonly PreviewBackground[] = ["white", "checker", "black"];

export const PREVIEW_BACKGROUND_LABELS: Record<PreviewBackground, string> = {
  white: "흰색",
  checker: "투명",
  black: "검정",
};

export const DEFAULT_PREVIEW_BACKGROUND: PreviewBackground = "white";

export const PREVIEW_BACKGROUND_STORAGE_KEY = "bwMaker.previewBackground";

/**
 * localStorage에 저장된 배경 설정을 읽는다. 값이 없거나(첫 실행) 아는 값이
 * 아니면(옵션 이름이 바뀐 구버전 설정) 기본값으로 되돌린다 — 이건 에러 흡수가
 * 아니라 저장된 문자열의 파싱 규칙이다. localStorage 접근 자체가 실패하면
 * 그대로 throw시켜 드러낸다.
 */
export function parsePreviewBackground(raw: string | null): PreviewBackground {
  return PREVIEW_BACKGROUNDS.includes(raw as PreviewBackground)
    ? (raw as PreviewBackground)
    : DEFAULT_PREVIEW_BACKGROUND;
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
