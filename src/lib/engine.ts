import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  MergeRule,
  EngineError,
  OpenResult,
  Operation,
  Preset,
  ExportResult,
  BatchItemResult,
} from "./types";

export class EngineRpcError extends Error implements EngineError {
  traceback: string;
  constructor(err: { message?: string; traceback?: string }) {
    super(err?.message ?? String(err));
    this.name = "EngineRpcError";
    this.traceback = err?.traceback ?? "";
    Object.defineProperty(this, "message", {
      value: err?.message ?? String(err),
      enumerable: true,
    });
  }
}

/**
 * Core engine request wrapper. Calls the Tauri command `engine_request`
 * with the given method and parameters. Rejects with EngineError on failure.
 */
export async function callEngine(method: string, params: object): Promise<unknown> {
  try {
    return await invoke("engine_request", { method, params });
  } catch (e) {
    throw new EngineRpcError(e as { message?: string; traceback?: string });
  }
}

/**
 * Opens a PSD file and returns metadata and layer tree.
 */
export async function openPsd(path: string): Promise<OpenResult> {
  return callEngine("open_psd", { path }) as Promise<OpenResult>;
}

/**
 * Applies a preset to a PSD session.
 */
export async function applyPreset(
  sessionId: number,
  preset: Preset
): Promise<{ matchedLayerIds: number[]; operations: Operation[] }> {
  return callEngine("apply_preset", { sessionId, preset }) as Promise<{
    matchedLayerIds: number[];
    operations: Operation[];
  }>;
}

/**
 * 같은 요소의 라인들을 한 장으로 묶는 연산 목록. 레이어 패널의 버튼이 쓴다.
 * 프리셋의 요소별 병합과 엔진에서 같은 함수를 공유하므로, 화면에서 누른 결과와
 * 배치 실행 결과가 갈라지지 않는다.
 */
export async function autoMergeOperations(
  sessionId: number,
  layerIds: number[],
  roleTokens: string[] | null,
  rule: MergeRule
): Promise<{ operations: Operation[] }> {
  return callEngine("auto_merge_operations", { sessionId, layerIds, roleTokens, rule }) as Promise<{
    operations: Operation[];
  }>;
}

/**
 * 규칙별로 몇 장이 되는지. 어느 규칙이 맞는지는 컷마다 다르므로(같은 파일에서도
 * 2장/8장/3장으로 갈린다) 누르기 전에 보여준다. 실제 병합과 같은 엔진 함수를
 * 쓰기 때문에 표시된 숫자와 결과가 어긋나지 않는다.
 */
export async function autoMergePreview(
  sessionId: number,
  layerIds: number[],
  roleTokens: string[] | null = null
): Promise<{ rules: Record<MergeRule, { layerCount: number; names: string[] }> }> {
  return callEngine("auto_merge_preview", { sessionId, layerIds, roleTokens }) as Promise<{
    rules: Record<MergeRule, { layerCount: number; names: string[] }>;
  }>;
}

/**
 * Renders a preview image of visible layers.
 */
export async function renderPreview(
  sessionId: number,
  visibleLayerIds: number[],
  maxSize: number,
  lineColor: string | null = null
): Promise<{ pngPath: string }> {
  return callEngine("render_preview", {
    sessionId,
    visibleLayerIds,
    maxSize,
    lineColor,
  }) as Promise<{ pngPath: string }>;
}

/**
 * Renders the document as saved — the PSD's own stored flattened preview.
 * Independent of layer count (a 165-layer plate costs ~0.2s here versus
 * several seconds to compose one), so it's what fills the canvas the moment
 * a file opens, before the artist has selected anything.
 */
export async function renderDocumentPreview(
  sessionId: number,
  maxSize: number
): Promise<{ pngPath: string }> {
  return callEngine("render_document_preview", { sessionId, maxSize }) as Promise<{
    pngPath: string;
  }>;
}

/**
 * Renders thumbnail images for layers.
 */
export async function renderThumbnails(
  sessionId: number,
  layerIds: number[],
  maxSize: number
): Promise<{ thumbs: Record<string, string> }> {
  return callEngine("render_thumbnails", { sessionId, layerIds, maxSize }) as Promise<{
    thumbs: Record<string, string>;
  }>;
}

/**
 * Exports a PSD file with applied operations.
 */
export async function exportPsd(
  sessionId: number,
  includedIds: number[],
  operations: Operation[],
  naming: "pathPrefix" | "original",
  outputPath: string,
  embedPreview: boolean = true,
  overwrite: boolean = false,
  verify: boolean = true,
  lineColor: string | null = null,
  splitLayers: boolean = false
): Promise<ExportResult> {
  return callEngine("export_psd", {
    sessionId,
    includedIds,
    operations,
    naming,
    outputPath,
    embedPreview,
    overwrite,
    verify,
    lineColor,
    splitLayers,
  }) as Promise<ExportResult>;
}

/**
 * Runs batch operations on multiple PSD files.
 */
export async function batchRun(
  paths: string[],
  preset: Preset,
  outputDir: string | null,
  overwrite: boolean
): Promise<{ results: BatchItemResult[] }> {
  return callEngine("batch_run", { paths, preset, outputDir, overwrite }) as Promise<{
    results: BatchItemResult[];
  }>;
}

/**
 * Closes a PSD session.
 */
export async function closeSession(sessionId: number): Promise<void> {
  return (await callEngine("close_session", { sessionId })) as void;
}

/**
 * Loads a PNG file as a base64 data URL.
 */
export async function loadPngDataUrl(path: string): Promise<string> {
  const b64 = await invoke("read_file_b64", { path });
  return `data:image/png;base64,${b64}`;
}

/**
 * Checks filesystem existence for a batch of paths via the Rust `paths_exist`
 * command. plugin-fs's `exists` is scoped to AppData and rejects with
 * PathForbidden for arbitrary user-chosen paths (e.g. batch export outputs
 * next to the source file), so this bypasses that capability restriction
 * instead of widening it.
 */
export async function pathsExist(paths: string[]): Promise<boolean[]> {
  return invoke("paths_exist", { paths });
}

/**
 * Subscribes to engine events (progress, etc.). Returns unsubscribe function.
 */
export async function onEngineEvent(cb: (data: unknown) => void): Promise<() => void> {
  const unlisten = await listen("engine-event", (event) => cb(event.payload));
  return unlisten;
}

export interface EngineDeadPayload {
  stderrTail?: string[];
}

/**
 * Subscribes to engine-dead event. The payload's stderrTail carries the
 * engine process's last ~50 stderr lines (see src-tauri/src/engine.rs) — a
 * packaged build has no terminal, so this is the only way a Python-level
 * crash traceback reaches the artist. Returns unsubscribe function.
 */
export async function onEngineDead(cb: (payload: EngineDeadPayload) => void): Promise<() => void> {
  const unlisten = await listen<EngineDeadPayload>("engine-dead", (event) => cb(event.payload ?? {}));
  return unlisten;
}
