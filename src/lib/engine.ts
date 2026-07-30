import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
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
 * Renders a preview image of visible layers.
 */
export async function renderPreview(
  sessionId: number,
  visibleLayerIds: number[],
  maxSize: number
): Promise<{ pngPath: string }> {
  return callEngine("render_preview", { sessionId, visibleLayerIds, maxSize }) as Promise<{
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
  verify: boolean = true
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
 * Subscribes to engine events (progress, etc.). Returns unsubscribe function.
 */
export async function onEngineEvent(cb: (data: unknown) => void): Promise<() => void> {
  const unlisten = await listen("engine-event", (event) => cb(event.payload));
  return unlisten;
}

/**
 * Subscribes to engine-dead event. Returns unsubscribe function.
 */
export async function onEngineDead(cb: () => void): Promise<() => void> {
  const unlisten = await listen("engine-dead", () => cb());
  return unlisten;
}
