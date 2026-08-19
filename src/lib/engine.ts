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

/**
 * 경로마다 디스크의 수정시각(초 단위 정수). **없는 파일은 키가 빠진다** — 0 같은
 * 값으로 채우면 호출부가 "안 바뀐 파일"로 오판한다.
 *
 * 엔진이 하는 이유는 PSD를 여는 쪽이 원래 거기이고(open_psd가 같은 값을 돌려준다),
 * 그래서 저장된 mtime과 지금 값이 같은 출처에서 나오기 때문이다. 다만 저장된 쪽은
 * float이고 이쪽은 정수라, 비교는 반드시 reconcileProject(lib/project.ts)를 거쳐야
 * 한다 — 거기서 양쪽을 다 초 단위로 자른다.
 */
export async function psdMtimes(paths: string[]): Promise<Record<string, number>> {
  return callEngine("psd_mtimes", { paths }) as Promise<Record<string, number>>;
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

/** measure_leaf_strokes가 잎마다 돌려주는 굵기 특징. 못 재면 null. */
export interface StrokeFeatures {
  coverage: number;
  survive1: number;
  survive2: number;
  nNative: number;
}

/**
 * 잎들의 굵기 특징(엔진 linedetect). "선으로 그려진 레이어" 검출이 프리셋 적용
 * 뒤에 부른다. 엔진이 잎 단위로 캐시하므로 같은 잎을 다시 물어도 디코드는 한
 * 번이다. 호출자는 STROKE_CHUNK씩 끊어 부른다(detectDrawnLines.ts) — 엔진은
 * 직렬이라 한 번에 다 재면 미리보기가 줄을 선다.
 */
export async function measureLeafStrokes(
  sessionId: number,
  layerIds: number[]
): Promise<Record<string, StrokeFeatures | null>> {
  const result = (await callEngine("measure_leaf_strokes", { sessionId, layerIds })) as {
    features: Record<string, StrokeFeatures | null>;
  };
  return result.features;
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
 * 잎 타일 워밍업(엔진 warm_preview_tiles). 유휴 시간에 아직 안 데운 잎을 미리
 * 디코드해, 첫 토글도 핫 토글(0.04~0.1초)과 같게 만든다 — 콜드면 그 잎의 원본
 * 해상도 디코드 0.7~50초가 토글에 그대로 얹힌다(2026-08-11 납품 판 실측).
 *
 * 엔진이 요청당 시간 예산으로 잘게 자르고 나머지를 remaining으로 돌려준다 —
 * 호출자는 remaining이 빌 때까지 반복 호출한다(lib/warmupQueue.ts). maxSize는
 * renderPreview와 같아야 한다: 배율이 타일 캐시 키에 들어가므로, 다르면 다른
 * 타일을 데워 놓고 정작 렌더는 콜드로 돈다.
 */
export async function warmPreviewTiles(
  sessionId: number,
  layerIds: number[],
  maxSize: number,
  diskOnly = false
): Promise<{ warmed: number[]; skipped: number[]; remaining: number[]; poolAlive?: boolean }> {
  return callEngine("warm_preview_tiles", {
    sessionId, layerIds, maxSize, ...(diskOnly ? { diskOnly: true } : {}),
  }) as Promise<{
    warmed: number[];
    skipped: number[];
    remaining: number[];
    poolAlive?: boolean;
  }>;
}

/**
 * 드로잉 레이어 타일을 엔진의 작업 프로세스들에 나눠 굽게 시작한다(기다리지
 * 않음). workers가 1이면 못 나눈 것 — 호출자는 기존 디코드 루프를 그대로 쓴다.
 * 2 이상이면 warmPreviewTiles(diskOnly)로 폴링하며 쓸어담는다
 * (lib/warmupQueue.ts drainPooledWarmup). 판 20 실측: 145장 216초 → 4개 80초.
 */
export async function warmTilesPooled(
  sessionId: number,
  layerIds: number[],
  maxSize: number
): Promise<{ workers: number }> {
  return callEngine("warm_tiles_pooled", { sessionId, layerIds, maxSize }) as Promise<{
    workers: number;
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
  overwrite: boolean,
  /**
   * 화면에서 손으로 "라인으로 지정"한 레이어. {경로: [id]} 꼴이고, 열어둔
   * 파일에만 있다.
   *
   * 배치는 프리셋만 받아 파일마다 처음부터 다시 매칭하므로, 이름 규칙이 닿지
   * 않는 판(선화가 `TEMPLATE` 안의 `BORDER`인 판 등)은 아티스트가 화면에서
   * 고쳐 놓아도 `no layers matched`로 실패했다. 이 값이 그 지정을 배치까지
   * 실어 나른다 — 엔진이 규칙 결과에 합집합으로 보탠다(batch.py의
   * `_add_manual_lines`).
   */
  manualLineIds: Record<string, number[]> = {}
): Promise<{ results: BatchItemResult[] }> {
  return callEngine("batch_run", {
    paths, preset, outputDir, overwrite, manualLineIds,
  }) as Promise<{
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

/**
 * 전체 캐시 워커(엔진 --warm-worker 프로세스, src-tauri/src/warm.rs) 제어.
 * 디스패치 규칙은 lib/warmWorkers.ts에 있고, 여기는 Rust 커맨드/이벤트 배선만.
 */
export interface WarmWorkersStarted {
  generation: number;
  ids: number[];
}

export async function warmWorkersStart(count: number, maxSize: number): Promise<WarmWorkersStarted> {
  return invoke("warm_workers_start", { count, maxSize });
}

/**
 * 워커 잡 한 줄. 모양은 엔진 프로토콜(engine/psd_engine/warmworker.py)이 정본:
 * - 워밍업: `presets`는 앱의 프리셋 목록(BG·CHAR가 기본) — 워커가 타일·
 *   오버레이에 더해 프리셋마다 "갓 적용한 화면"의 미리보기 PNG까지 디스크에
 *   미리 굽는다. 목록 전체를 보내는 이유: 어느 프리셋이 선택돼 있든, 스윕 뒤에
 *   바꾸든 그 화면이 이미 구워져 있어야 "전체 캐시 완료 = 즉시"가 참이다.
 * - 배치 내보내기: `export`가 있으면 그 파일 하나를 batch._process_one으로
 *   내보낸다 — 산출물·검증이 메인 엔진의 순차 배치와 같은 함수를 탄다.
 * - 파일 준비: `prepare`가 있으면 그 파일을 한 번 열어 트리·프리셋 매칭·
 *   미리보기까지 만들어 돌려준다(warmworker.prepare_file).
 */
export interface WarmWorkerJob {
  path: string;
  presets?: Preset[];
  export?: {
    preset: Preset;
    outputDir: string | null;
    overwrite: boolean;
    manualLineIds?: number[];
  };
  /**
   * 파일 준비 — 폴더 로드 직후의 "여는 중"과 "미리보기 준비 중"을 작업
   * 프로세스가 파일 단위로 나눠 한다. 워커가 파일을 한 번 열어 트리·프리셋
   * 매칭·미리보기를 만들어 돌려주므로, 지금처럼 두 패스가 같은 PSD를 두 번
   * (세션이 LRU 2칸에 밀려나 있어) 여는 일이 사라진다.
   */
  prepare?: {
    preset: Preset;
    maxSize: number;
  };
}

export async function warmWorkerSend(id: number, payload: WarmWorkerJob): Promise<void> {
  await invoke("warm_worker_send", { id, payload });
}

export async function warmWorkersStop(): Promise<void> {
  await invoke("warm_workers_stop");
}

export interface WarmWorkerLine {
  generation: number;
  id: number;
  line: string;
}

export async function onWarmWorkerLine(cb: (e: WarmWorkerLine) => void): Promise<() => void> {
  return listen<WarmWorkerLine>("warm-worker-line", (event) => cb(event.payload));
}

export interface WarmWorkerExit {
  generation: number;
  id: number;
}

export async function onWarmWorkerExit(cb: (e: WarmWorkerExit) => void): Promise<() => void> {
  return listen<WarmWorkerExit>("warm-worker-exit", (event) => cb(event.payload));
}
