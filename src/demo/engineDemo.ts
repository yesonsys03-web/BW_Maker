/**
 * 도움말 스크린샷용 가짜 엔진 — **출고 번들에는 없다.**
 *
 * `HELP_SHOTS=1`로 vite를 띄울 때만 vite.config.ts의 별칭이 lib/engine을 이것으로
 * 바꾼다(일반 빌드는 이 파일을 import하는 곳이 없어 번들에 안 들어간다). 데이터는
 * 전부 예시 판(src/demo/fixtures.json — 실제 엔진이 예시 PSD 3장에서 뽑은 트리와
 * 렌더 산출물)이라, 스크린샷에 납품 파일명이 나올 길이 없다.
 *
 * 시간 흉내는 스크린샷을 찍을 만큼만이다: 열기 350ms, 드로잉 레이어 타일 하나
 * 120ms. `window.__help.freezeWarm = true`면 워밍업이 진행 중인 채로 멈춰
 * "나머지 레이어 준비 중 N/M"을 찍을 수 있다.
 */
import type {
  BatchItemResult, EdgeLines, ExportResult, OpenResult, Operation, Preset,
  TreeNode,
} from "./typesShim";
import fixturesJson from "./fixtures.json";

const VERIFIED = {
  ok: true, canvasOk: true, layerCountOk: true,
  expectedLayers: 1, actualLayers: 1, layers: [],
};

interface Fixture {
  path: string; width: number; height: number; tree: TreeNode[];
  matched: number[]; plain: string; edges: string; lines: string;
  thumbs: Record<string, string>;
}
const FIXTURES = fixturesJson as unknown as Record<string, Fixture>;

const assetUrls = import.meta.glob<string>("./assets/*.png", {
  eager: true, query: "?url", import: "default",
});
function asset(name: string): string {
  for (const [k, v] of Object.entries(assetUrls)) if (k.endsWith(`/${name}`)) return v;
  throw new Error(`데모 자산이 없다: ${name}`);
}

declare global {
  interface Window { __help?: { tileMs?: number; freezeWarm?: boolean } }
}
const knobs = () => (window.__help ??= {});
/** 데모 디버깅용 호출 자취 — 촬영 스크립트가 어디서 멈췄는지 본다. */
const trace = (name: string) =>
  ((window as unknown as { __helpCalls?: string[] }).__helpCalls ??= []).push(name);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class EngineRpcError extends Error {
  traceback = "";
}

let nextSid = 1;
const sessions = new Map<number, Fixture>();

export async function callEngine(_method: string, _params: object): Promise<unknown> {
  return {};
}

export async function openPsd(path: string): Promise<OpenResult> {
  trace("openPsd");
  await sleep(350);
  const fx = Object.values(FIXTURES).find((f) => f.path === path);
  if (!fx) throw new EngineRpcError(`데모에 없는 경로: ${path}`);
  const sessionId = nextSid++;
  sessions.set(sessionId, fx);
  return { sessionId, width: fx.width, height: fx.height, colorMode: "RGB",
           depth: 8, tree: fx.tree, mtime: 1 };
}

export async function psdMtimes(paths: string[]): Promise<Record<string, number>> {
  return Object.fromEntries(paths.map((p) => [p, 1]));
}

export async function applyPreset(sessionId: number, _preset: Preset) {
  trace("applyPreset");
  await sleep(150);
  const fx = sessions.get(sessionId);
  return { matchedLayerIds: fx ? [...fx.matched] : [], operations: [] as Operation[],
           skippedLayers: [] };
}

export async function autoMergeOperations(_tree: TreeNode[], _ids: number[]) {
  return [] as Operation[];
}

export async function autoMergePreview(_tree: TreeNode[], _ids: number[]) {
  return { groups: [] as { name: string; layerIds: number[] }[] };
}

export async function renderPreview(
  sessionId: number, visibleLayerIds: number[], _maxSize: number,
  _lineColor: string | null = null, _lineColorIds: number[] | null = null,
  edgeLines: EdgeLines | null = null, _manualColourIds: number[] | null = null,
  _includedIds: number[] | null = null
): Promise<{ pngPath: string }> {
  trace("renderPreview");
  await sleep(250);
  const fx = sessions.get(sessionId);
  if (!fx) throw new EngineRpcError(`데모에 없는 세션: ${sessionId}`);
  const matched = new Set(fx.matched);
  const colourVisible = visibleLayerIds.some((id) => !matched.has(id));
  const img = edgeLines?.enabled ? (colourVisible ? fx.edges : fx.lines)
    : colourVisible ? fx.plain : fx.lines;
  return { pngPath: asset(img) };
}

export async function renderDocumentPreview(sessionId: number, _maxSize: number) {
  trace("renderDocumentPreview");
  const fx = sessions.get(sessionId);
  if (!fx) throw new EngineRpcError(`데모에 없는 세션: ${sessionId}`);
  return { pngPath: asset(fx.plain) };
}

export async function warmPreviewTiles(
  _sessionId: number, layerIds: number[], _maxSize: number, _diskOnly = false
): Promise<{ warmed: number[]; skipped: number[]; remaining: number[]; poolAlive?: boolean }> {
  if (knobs().freezeWarm) {
    await sleep(250);
    return { warmed: [], skipped: [], remaining: layerIds };
  }
  await sleep(knobs().tileMs ?? 120);
  return { warmed: layerIds.slice(0, 1), skipped: [], remaining: layerIds.slice(1) };
}

export async function warmTilesPooled(_sessionId: number, _layerIds: number[], _maxSize: number) {
  return { workers: 1 };
}

export async function renderThumbnails(sessionId: number, opts: { layerIds?: number[] } | number[]) {
  await sleep(120);
  const fx = sessions.get(sessionId);
  const ids = Array.isArray(opts) ? opts : opts.layerIds ?? [];
  const thumbs: Record<number, string> = {};
  for (const id of ids) {
    const name = fx?.thumbs[String(id)];
    if (name) thumbs[id] = asset(name);
  }
  return { thumbs };
}

export async function exportPsd(
  _sessionId: number, includedIds: number[], _operations: Operation[],
  _naming: "pathPrefix" | "original", outputPath: string
): Promise<ExportResult> {
  await sleep(600);
  return { outputPath, layerCount: includedIds.length, verification: VERIFIED };
}

export async function batchRun(
  paths: string[], _preset: Preset, outputDir: string | null
): Promise<{ results: BatchItemResult[] }> {
  await sleep(900);
  return {
    results: paths.map((p) => ({
      path: p, ok: true, layerCount: 1, verification: VERIFIED,
      outputPath: `${outputDir ?? "/tmp/헬프_예시"}/${p.split("/").pop()!.replace(".psd", "_LINE.psd")}`,
    })),
  };
}

export async function pinFile(_path: string | null): Promise<void> {}
export async function closeSession(_sessionId: number): Promise<void> {}

export async function loadPngDataUrl(path: string): Promise<string> {
  trace("loadPngDataUrl");
  const res = await fetch(path);
  const blob = await res.blob();
  return await new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.readAsDataURL(blob);
  });
}

export async function pathsExist(paths: string[]): Promise<boolean[]> {
  return paths.map(() => true);
}

export interface PsdScan { files: string[]; truncated: boolean; skippedDirs: number }
export async function collectPsdFiles(_paths: string[]): Promise<PsdScan> {
  return { files: Object.values(FIXTURES).map((f) => f.path), truncated: false, skippedDirs: 0 };
}

export async function onEngineEvent(_cb: (data: unknown) => void): Promise<() => void> {
  return () => {};
}
export interface EngineDeadPayload { code: number | null }
export async function onEngineDead(_cb: (p: EngineDeadPayload) => void): Promise<() => void> {
  return () => {};
}

export interface WarmWorkersStarted { generation: number; ids: number[] }
export async function warmWorkersStart(count: number, _maxSize: number): Promise<WarmWorkersStarted> {
  return { generation: 1, ids: Array.from({ length: count }, (_, i) => i) };
}
export interface WarmWorkerJob { path: string; [k: string]: unknown }
const workerLineCbs: ((e: WarmWorkerLine) => void)[] = [];
export async function warmWorkerSend(id: number, payload: WarmWorkerJob): Promise<void> {
  // 파일 준비 잡이면 진짜 워커(warmworker.prepare_file)와 같은 모양으로 답한다 —
  // open_psd + apply_preset에서 sessionId만 뺀 결과 + pngPath/documentView.
  // result가 없으면 프런트가 "준비하지 못한 파일"로 센다(runPrepareQueue).
  const fx = Object.values(FIXTURES).find((f) => f.path === payload.path);
  const result = fx && {
    width: fx.width, height: fx.height, colorMode: "RGB", depth: 8,
    tree: fx.tree, mtime: 1, matchedLayerIds: [...fx.matched],
    operations: [], skippedLayers: [], pngPath: null, documentView: false,
  };
  setTimeout(() => {
    for (const cb of workerLineCbs) {
      cb({ generation: 1, id,
           line: JSON.stringify({ event: "file", path: payload.path, ok: !!result, result }) });
    }
  }, 350);
}
export async function warmWorkersStop(): Promise<void> {}
export interface WarmWorkerLine { generation: number; id: number; line: string }
export async function onWarmWorkerLine(cb: (e: WarmWorkerLine) => void): Promise<() => void> {
  workerLineCbs.push(cb);
  return () => {};
}
export interface WarmWorkerExit { generation: number; id: number }
export async function onWarmWorkerExit(_cb: (e: WarmWorkerExit) => void): Promise<() => void> {
  return () => {};
}
