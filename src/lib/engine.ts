import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  OpenResult,
  Operation,
  Preset,
  ExportResult,
  BatchItemResult,
} from "./types";

/**
 * Core engine request wrapper. Calls the Tauri command `engine_request`
 * with the given method and parameters. Rejects with EngineError on failure.
 */
export async function callEngine(method: string, params: object): Promise<unknown> {
  try {
    return await invoke("engine_request", { method, params });
  } catch (e: any) {
    const err = e as { message?: string; traceback?: string };
    throw {
      message: err?.message ?? String(err),
      traceback: err?.traceback ?? "",
    };
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
export async function applyPreset(sessionId: number, preset: Preset): Promise<unknown> {
  return callEngine("apply_preset", { sessionId, preset });
}

/**
 * Renders a preview image of visible layers.
 */
export async function renderPreview(
  sessionId: number,
  visibleLayerIds: number[],
  maxSize: number
): Promise<string> {
  return callEngine("render_preview", { sessionId, visibleLayerIds, maxSize }) as Promise<string>;
}

/**
 * Renders thumbnail images for layers.
 */
export async function renderThumbnails(sessionId: number, layerIds: number[], size: number): Promise<unknown> {
  return callEngine("render_thumbnails", { sessionId, layerIds, size });
}

/**
 * Exports a PSD file with applied operations.
 */
export async function exportPsd(
  sessionId: number,
  operations: Operation[],
  outputPath: string
): Promise<ExportResult> {
  return callEngine("export_psd", { sessionId, operations, outputPath }) as Promise<ExportResult>;
}

/**
 * Runs batch operations on multiple PSD files.
 */
export async function batchRun(
  paths: string[],
  preset: Preset,
  outputDir: string
): Promise<BatchItemResult[]> {
  return callEngine("batch_run", { paths, preset, outputDir }) as Promise<BatchItemResult[]>;
}

/**
 * Closes a PSD session.
 */
export async function closeSession(sessionId: number): Promise<void> {
  return callEngine("close_session", { sessionId }) as Promise<void>;
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
