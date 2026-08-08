import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  MergeRule,
  EdgeLines,
  EngineError,
  OpenResult,
  Operation,
  OutputFormat,
  Preset,
  ExportResult,
  BatchItemResult,
  TreeNode,
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

export interface SkippedLayer {
  id: number;
  /** 그룹 경로까지 포함한 이름. `*ART/120_BG/BOTTOM_FLOOR_WALL/NOTE FOR LINE: ...` */
  path: string;
  kind: string;
  /**
   * 규칙에 걸렸는데도 결과에 없는 이유.
   *
   * "그릴 수 없어서" — "text"는 라인 PSD 안의 텍스트를 작업 메모로 본 것,
   * "noPixels"는 그릴 채널이 없는 것.
   *
   * "라인이 아니라서" — "notLineWord"는 이름에 검색어가 부분 문자열로만
   * 들어있는 것("LINEAR DODGE"), "groupHasOwnLine"은 그룹 이름 때문에 딸려올
   * 뻔했지만 그 그룹에 진짜 라인이 따로 있는 것, "excludedToken"은 제외
   * 토큰이 붙은 것("line col"), "blendMode"는 normal이 아닌 합성으로 얹힌 것.
   * 이쪽은 규칙이 의도한 결과라 오류가 아니다.
   */
  reason:
    | "text"
    | "noPixels"
    | "notLineWord"
    | "groupHasOwnLine"
    | "excludedToken"
    | "blendMode";
}

/**
 * Applies a preset to a PSD session.
 *
 * skippedLayers는 규칙에 걸렸지만 그릴 수 없어 뺀 레이어들이다. 예전에는 그런
 * 레이어 하나가 파일 전체의 적용을 실패시켰다(engine/psd_engine/matching.py).
 */
export async function applyPreset(
  sessionId: number,
  preset: Preset
): Promise<{ matchedLayerIds: number[]; operations: Operation[]; skippedLayers?: SkippedLayer[] }> {
  return callEngine("apply_preset", { sessionId, preset }) as Promise<{
    matchedLayerIds: number[];
    operations: Operation[];
    skippedLayers?: SkippedLayer[];
  }>;
}

/**
 * 같은 요소의 라인들을 한 장으로 묶는 연산 목록. 레이어 패널의 버튼이 쓴다.
 * 프리셋의 요소별 병합과 엔진에서 같은 함수를 공유하므로, 화면에서 누른 결과와
 * 배치 실행 결과가 갈라지지 않는다.
 */
export async function autoMergeOperations(
  tree: TreeNode[],
  layerIds: number[],
  roleTokens: string[] | null,
  rule: MergeRule
): Promise<{ operations: Operation[] }> {
  return callEngine("auto_merge_operations", { tree, layerIds, roleTokens, rule }) as Promise<{
    operations: Operation[];
  }>;
}

/**
 * 규칙별로 몇 장이 되는지. 어느 규칙이 맞는지는 컷마다 다르므로(같은 파일에서도
 * 2장/8장/3장으로 갈린다) 누르기 전에 보여준다. 실제 병합과 같은 엔진 함수를
 * 쓰기 때문에 표시된 숫자와 결과가 어긋나지 않는다.
 */
export async function autoMergePreview(
  tree: TreeNode[],
  layerIds: number[],
  roleTokens: string[] | null = null
): Promise<{ rules: Record<MergeRule, { layerCount: number; names: string[] }> }> {
  return callEngine("auto_merge_preview", { tree, layerIds, roleTokens }) as Promise<{
    rules: Record<MergeRule, { layerCount: number; names: string[] }>;
  }>;
}

/**
 * Renders a preview image of visible layers.
 *
 * `manualColourIds`는 색 경계선 생성의 수동 지정(설계 3.1) — 자동 검출이
 * 못 찾은 색 레이어를 아티스트가 트리에서 직접 짚은 것이다. TS `EdgeLines`
 * 타입에는 이 필드가 없다: `EdgeLines`는 프리셋에 그대로 저장되는데, 지정은
 * 파일마다 다른 사실이라 프리셋(파일과 무관)에 넣으면 안 되기 때문이다
 * (opsReducer.ts의 edgeColourIds 주석 참고). 그래서 엔진이 기대하는 모양
 * (`edgeLines.manualColourIds`)은 여기서, payload를 만드는 이 자리에서만
 * 합친다. edgeLines가 꺼져 있으면(null) 엔진이 애초에 안 읽으므로 지정이
 * 있어도 그대로 null을 보낸다 — 기능이 꺼진 상태를 payload로 흉내내지 않는다.
 *
 * `includedIds`는 체크박스가 실제로 내보내기에 포함시킨 레이어 목록
 * (opsReducer.ts의 같은 이름, exportPsd가 받는 것과 같은 값) — 엔진의
 * `character.manual_views`가 "이미 있는 라인"을 판단하는 기준이다. 여기
 * 넘기는 `visibleLayerIds`는 눈(previewHiddenIds)까지 반영한 **그리기용**
 * 목록이라 다르다: 체크는 됐지만 눈으로 숨긴 라인은 visibleLayerIds에 없어도
 * includedIds에는 있어야 한다 — 그래야 미리보기가 export와 같은 라인을
 * 뺀다(rpc.py의 render_preview 주석 참고). 생략하면(null) 엔진은 이전
 * 동작(세션 전체 레이어로 근사)으로 물러난다.
 */
export async function renderPreview(
  sessionId: number,
  visibleLayerIds: number[],
  maxSize: number,
  lineColor: string | null = null,
  lineColorIds: number[] | null = null,
  edgeLines: EdgeLines | null = null,
  manualColourIds: number[] | null = null,
  includedIds: number[] | null = null
): Promise<{ pngPath: string }> {
  return callEngine("render_preview", {
    sessionId,
    visibleLayerIds,
    maxSize,
    lineColor,
    lineColorIds,
    edgeLines: edgeLines ? { ...edgeLines, manualColourIds: manualColourIds ?? [] } : null,
    includedIds,
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
 *
 * `manualColourIds` — renderPreview 위의 주석과 같다. PreviewCanvas와 여기가
 * 같은 값(ops.edgeColourIds)을 보내야 한다: 하나라도 다른 값을 쓰면 아티스트가
 * 미리보기로 승인한 그림과 실제로 내보낸 파일이 달라진다.
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
  splitLayers: boolean = false,
  outputFormat: OutputFormat = "psd",
  lineColorIds: number[] | null = null,
  edgeLines: EdgeLines | null = null,
  manualColourIds: number[] | null = null
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
    outputFormat,
    lineColorIds,
    edgeLines: edgeLines ? { ...edgeLines, manualColourIds: manualColourIds ?? [] } : null,
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
 * 화면이 지금 보고 있는 파일을 엔진에 알린다. 그 파일의 세션은 LRU 축출에서
 * 제외되므로, 배경에서 파일을 차례로 여는 동안에도 밀려나지 않는다. 세션
 * 총량(2개)은 그대로라 메모리는 늘지 않는다 — engine/psd_engine/session.py 참고.
 *
 * 세션 id가 아니라 경로를 보내는 이유가 중요하다: 축출 복구는 새 세션을 만드는데,
 * id로 고정하면 그 새 id를 다시 고정하기 전까지 무방비다. 경로는 재오픈에도
 * 그대로이므로 그 틈이 없다.
 *
 * null은 "지금 보고 있는 파일 없음"이다.
 */
export async function pinFile(path: string | null): Promise<void> {
  return (await callEngine("pin_file", { path })) as void;
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

export interface PsdScan {
  /** Sorted, de-duplicated absolute paths of the .psd files that were found. */
  files: string[];
  /** True when the walk gave up early on a file-count or depth cap. */
  truncated: boolean;
  /** Sub-folders that could not be opened (permissions) and were skipped. */
  skippedDirs: number;
}

/**
 * Expands a mixed list of paths into .psd files: folders are walked
 * recursively, .psd files pass straight through, everything else is dropped.
 * The folder button and drag & drop share it, so dropping a folder, a pile of
 * files, or both at once all follow one rule.
 *
 * Rust-side for the same reason as pathsExist: source folders live outside
 * AppData, which is all plugin-fs's capability scope allows it to read.
 */
export async function collectPsdFiles(paths: string[]): Promise<PsdScan> {
  return invoke("collect_psd_files", { paths });
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
