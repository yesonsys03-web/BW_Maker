// @vitest-environment jsdom
/**
 * 두 배경 큐(파일 열기 / 미리보기 준비)와 썸네일 큐가 서로 양보하는 규약을 잠근다.
 *
 * 이 조율은 리듀서나 순수 함수로 뽑아낼 수 없다 — 효과가 도는 순서, ref와 상태가
 * 갈리는 순간, 큐가 서로를 깨우는 신호가 곧 동작이기 때문이다. 그래서 실제로 App을
 * 띄우고 엔진만 가짜로 바꾼다. 이번 라운드에서 나온 결함의 절반이 정확히 여기 있었다.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const engine = vi.hoisted(() => ({
  openPsd: vi.fn(),
  applyPreset: vi.fn(),
  renderThumbnails: vi.fn(),
  renderPreview: vi.fn(),
  renderDocumentPreview: vi.fn(),
  loadPngDataUrl: vi.fn(),
  pinFile: vi.fn(),
  collectPsdFiles: vi.fn(),
  closeSession: vi.fn(),
  pathsExist: vi.fn(),
  exportPsd: vi.fn(),
  batchRun: vi.fn(),
  autoMergePreview: vi.fn(),
  autoMergeOperations: vi.fn(),
  onEngineEvent: vi.fn(),
  onEngineDead: vi.fn(),
  callEngine: vi.fn(),
  psdMtimes: vi.fn(),
  warmPreviewTiles: vi.fn(),
  warmWorkersStart: vi.fn(),
  warmWorkerSend: vi.fn(),
  warmWorkersStop: vi.fn(),
  onWarmWorkerLine: vi.fn(),
  onWarmWorkerExit: vi.fn(),
}));

vi.mock("./lib/engine", () => ({
  ...engine,
  EngineRpcError: class EngineRpcError extends Error {
    traceback = "";
  },
}));

// 프리셋 목록은 비워둔다. 선택된 프리셋이 없으면 로드 큐가 파일을 열기만 하므로,
// 여기서 보려는 큐의 조율만 남고 프리셋 적용 경로가 끼어들지 않는다.
vi.mock("./lib/presets", async (orig) => ({
  ...(await orig<typeof import("./lib/presets")>()),
  loadPresets: vi.fn(async () => []),
  savePresets: vi.fn(async () => {}),
}));

// 프로젝트 폴더 I/O는 Rust 커맨드를 거치므로(projectFs.ts) 여기서는 통째로 가짜다.
// 이 테스트가 보려는 것은 디스크가 아니라 **무엇을 써 보내는가**이다.
vi.mock("./lib/projectFs", () => ({
  loadProjectFrom: vi.fn(),
  saveProjectTo: vi.fn(async () => {}),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import App, { CACHE_WORKERS_STORAGE_KEY, DEFAULT_CACHE_WORKERS } from "./App";
import { PreviewCanvas } from "./components/PreviewCanvas";
import { loadPresets } from "./lib/presets";
import { PreviewCache, previewRenderSpec } from "./lib/previewCache";
import { previewFileName, type ProjectEntry, type ProjectFile } from "./lib/project";
import { loadProjectFrom, saveProjectTo } from "./lib/projectFs";
import { appReducer, initialAppState } from "./state/appStore";

/** 테스트가 원하는 시점에 풀어주는 약속. 큐를 한 걸음씩 몰기 위한 것. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 화면에 들어온 행을 테스트가 직접 정하는 관측자. */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  targets = new Set<Element>();
  constructor(private cb: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe(el: Element) {
    this.targets.add(el);
  }
  unobserve(el: Element) {
    this.targets.delete(el);
  }
  disconnect() {
    this.targets.clear();
  }
  /** 지정한 레이어 id의 행만 보이고 나머지는 화면 밖이라고 알린다. */
  reveal(visibleIds: number[]) {
    const entries = [...this.targets].map((target) => ({
      target,
      isIntersecting: visibleIds.includes(Number((target as HTMLElement).dataset.thumbId)),
    }));
    this.cb(entries as unknown as IntersectionObserverEntry[], this as unknown as IntersectionObserver);
  }
  static latest() {
    const live = FakeIntersectionObserver.instances.filter((o) => o.targets.size > 0);
    return live[live.length - 1];
  }
}

const PATHS = ["/cuts/a.psd", "/cuts/b.psd", "/cuts/c.psd"];

/** 로드 큐의 자동 적용 경로를 켜기 위한 최소 프리셋. loadPresets를 오버라이드할 때만 쓴다. */
const PRESET = {
  name: "line 추출",
  include: { type: "contains" as const, value: "line", caseSensitive: false },
  excludeGroupPrefixes: [],
  matchGroups: true,
  includeHidden: true,
  merge: "none" as const,
  roleTokens: [],
  mergeRule: "group" as const,
  naming: "original" as const,
  outputSuffix: "_LINE",
  embedPreview: true,
  lineColor: null,
  splitLayers: false,
  outputFormat: "psd" as const,
  excludeTokens: [],
  edgeLines: {
    enabled: false, threshold: 24, gap: 4, width: 5, minLength: 8, lineAlpha: 64,
    colourMode: "composite" as const, edgeMode: "region" as const, widthScale: 1,
  },
};

function treeOf(ids: number[], visible = true) {
  return ids.map((id) => ({
    id,
    name: `line ${id}`,
    kind: "pixel",
    visible,
    opacity: 255,
    blendMode: "normal",
    bbox: [0, 0, 10, 10] as [number, number, number, number],
    hasMask: false,
    hasPixels: true,
    path: [`line ${id}`],
  }));
}

let opens: { path: string; d: ReturnType<typeof deferred<unknown>> }[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  FakeIntersectionObserver.instances = [];
  opens = [];
  // 이 환경의 jsdom localStorage는 껍데기라 getItem이 없다. 레이어 패널 폭과
  // 미리보기 배경이 여기서 읽어오므로 최소한의 대역을 세운다.
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );

  engine.openPsd.mockImplementation((path: string) => {
    const d = deferred<unknown>();
    opens.push({ path, d });
    return d.promise;
  });
  engine.pinFile.mockResolvedValue(undefined);
  engine.renderThumbnails.mockResolvedValue({ thumbs: {} });
  engine.renderPreview.mockResolvedValue({ pngPath: "/tmp/p.png" });
  engine.renderDocumentPreview.mockResolvedValue({ pngPath: "/tmp/p.png" });
  engine.loadPngDataUrl.mockResolvedValue("data:image/png;base64,AAA");
  engine.onEngineDead.mockResolvedValue(() => {});
  engine.onEngineEvent.mockResolvedValue(() => {});
  engine.collectPsdFiles.mockResolvedValue({ files: PATHS, truncated: false, skippedDirs: 0 });
  // 기본은 "전부 한 번에 데워짐" — 워밍업 큐가 한 번 부르고 끝난다. 워밍업의
  // 반복·양보 규약 자체는 lib/warmupQueue.test.ts가 잠근다.
  engine.warmPreviewTiles.mockResolvedValue({ warmed: [], skipped: [], remaining: [] });
  // 워커 모드 기본 대역. 앱의 기본 작업 프로세스 수가 2라 이 대역은 **기본으로**
  // 밟힌다 — 프리셋이 걸린 채 파일이 들어오는 테스트는 전부 여기로 온다. 워커 수를
  // 1로 못박은 테스트(seedWorkerCount 참고)만 이 자리를 안 지난다.
  engine.warmWorkersStart.mockResolvedValue({ generation: 1, ids: [0] });
  engine.warmWorkerSend.mockResolvedValue(undefined);
  engine.warmWorkersStop.mockResolvedValue(undefined);
  engine.onWarmWorkerLine.mockResolvedValue(() => {});
  engine.onWarmWorkerExit.mockResolvedValue(() => {});
  vi.mocked(openDialog).mockResolvedValue(PATHS as never);
});

// vitest의 globals를 켜지 않았으므로 자동 정리가 걸리지 않는다. 남겨두면
// 다음 테스트가 이전 화면의 버튼까지 같이 찾는다.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * 앱을 띄우기 **전에** 이 테스트가 재는 작업 프로세스 수를 못박는다.
 *
 * 앱의 기본은 2다(App.tsx의 DEFAULT_CACHE_WORKERS). 그래서 프리셋이 걸린 폴더를
 * 열면 파일 준비가 워커로 나가고, 로드 큐는 통째로 비켜서서 open_psd가 한 번도
 * 안 나간다. 이 헬퍼를 1로 부르는 테스트 여덟 개는 그 병렬 경로가 생기기 전에 쓴
 * 것이라 **메인 엔진 하나가 순서대로 여는** 경로를 잰다.
 *
 * 그 여덟 개는 지금까지 "기본이 1"이라는 말을 한 번도 적지 않은 채 그 위에 얹혀
 * 있었다. 기본을 1에서 2로 올리자 여덟 개가 한꺼번에 빨간불이 됐는데, 그 빨간불이
 * 말한 것은 "기능이 깨졌다"가 아니라 **"이 테스트가 무엇을 재는지 안 적었다"**였다.
 * 그래서 판정을 무르게 하는 대신 재는 경로를 테스트가 스스로 말하게 한다. 기본값이
 * 또 바뀌어도 이 여덟 개는 안 흔들리고, 흔들린다면 그때는 진짜 회귀다.
 *
 * **render보다 먼저 불러야 한다.** cacheWorkers는 useState 초기화에서 이 키를 한
 * 번만 읽으므로, 뜬 뒤에 넣으면 아무 일도 안 일어난다. 아래 setWorkers와 목적이
 * 다르다: 이쪽은 "앱이 이 값으로 떠 있었다", 저쪽은 "사용자가 도중에 바꿨다"이다.
 */
function seedWorkerCount(n: number) {
  window.localStorage.setItem(CACHE_WORKERS_STORAGE_KEY, String(n));
}

/**
 * 화면의 워커 수 드롭다운. 이 select에는 접근성 이름이 없어 title로 찾는다 —
 * FilePanel의 그 title 문구가 바뀌면 여기가 같이 바뀌어야 하므로, 문장 전체가
 * 아니라 이 컨트롤을 유일하게 가리키는 조각만 본다.
 */
function workerSelect() {
  return screen.getByTitle(/작업 프로세스로 나눠 돌릴지/) as HTMLSelectElement;
}

/**
 * 워커 수 드롭다운을 돌린다 — **뜬 뒤에** 사용자가 바꾸는 쪽(위 seedWorkerCount와
 * 짝). 파일 준비도 전체 캐시와 **같은 설정**을 쓴다.
 */
function setWorkers(n: number) {
  const select = workerSelect();
  select.value = String(n);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

/** 파일 목록에 PATHS를 넣는다. "+ 추가"가 도는 경로를 그대로 쓴다. */
async function addFiles(user: { click: (el: Element) => void }) {
  user.click(screen.getByRole("button", { name: "+ 추가" }));
  await waitFor(() => expect(opens.length).toBeGreaterThan(0));
}

function click(el: Element) {
  el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

/** 파일 목록의 행. 접근성 이름이 파일명 + 상태 배지로 합쳐지므로 텍스트로 찾는다. */
function fileRow(name: string) {
  const row = screen
    .getAllByRole("button")
    .find((b) => b.classList.contains("file-list-item") && b.textContent?.includes(name));
  if (!row) throw new Error(`파일 행을 찾지 못했다: ${name}`);
  return row;
}

/** 열기 하나를 성공으로 끝낸다. */
async function finishOpen(index: number, sessionId: number, ids = [1, 2, 3], visible = true) {
  opens[index].d.resolve({
    sessionId,
    width: 10,
    height: 10,
    colorMode: "RGB",
    depth: 8,
    tree: treeOf(ids, visible),
    mtime: 1,
  });
  await waitFor(() => expect(screen.queryAllByText("열림").length).toBeGreaterThanOrEqual(1));
}

test("the load queue opens files one at a time, not all at once", async () => {
  render(<App />);
  await addFiles({ click });

  // 엔진은 stdin 큐를 순서대로 처리하므로 한꺼번에 던져봐야 줄만 선다. 하나가
  // 끝나야 다음이 나가는 것이 이 큐의 전제다.
  expect(opens).toHaveLength(1);
  await finishOpen(0, 1);
  await waitFor(() => expect(opens).toHaveLength(2));
});

test("stop stays stopped when a file is clicked afterwards", async () => {
  render(<App />);
  await addFiles({ click });
  await finishOpen(0, 1);
  await waitFor(() => expect(opens).toHaveLength(2));

  click(screen.getByRole("button", { name: "중지" }));
  await finishOpen(1, 2);

  // 중지 뒤에도 큐가 다음 파일로 넘어가면 안 된다.
  await waitFor(() => expect(screen.getByText(/중지됨/)).toBeTruthy());
  expect(opens).toHaveLength(2);

  // 남은 파일을 눌러 그 하나만 여는 것은 되고, 그것이 큐를 되살리면 안 된다.
  // ref로만 취소를 들었을 때는 이 클릭 한 번에 로드가 통째로 다시 시작됐다.
  click(fileRow("c.psd"));
  await waitFor(() => expect(opens).toHaveLength(3));
  await finishOpen(2, 3);

  await new Promise((r) => setTimeout(r, 20));
  expect(opens).toHaveLength(3);
});

test("resume picks the remaining files back up", async () => {
  render(<App />);
  await addFiles({ click });
  await finishOpen(0, 1);
  await waitFor(() => expect(opens).toHaveLength(2));

  click(screen.getByRole("button", { name: "중지" }));
  await finishOpen(1, 2);
  await waitFor(() => expect(screen.getByText(/중지됨/)).toBeTruthy());

  click(screen.getByRole("button", { name: "재개" }));
  await waitFor(() => expect(opens).toHaveLength(3));
});

// 로드 큐는 프리셋이 선택되면 파일을 연 직후 자동으로 붙인다(위 큐 정의 부근).
// 복원한 파일은 이미 이전 세션에서 프리셋을 거친 결과이므로, 큐가 다시 붙이면
// 방금 복원해 지킨 체크박스·병합 편집이 조용히 새 매칭으로 덮인다. appStore의
// openSuccess가 presetApplied를 정직하게 세워도, 이 큐가 그것을 확인하지 않으면
// 아무 소용이 없다 — 둘이 같이 맞아야 한다.
test("the load queue skips auto-apply for a restored file but still applies it to a plain one", async () => {
  seedWorkerCount(1); // 여기서 재는 것은 로드 큐(순차 경로)의 자동 적용 판정이다
  vi.mocked(loadPresets).mockResolvedValueOnce([PRESET]);
  engine.applyPreset.mockResolvedValue({ matchedLayerIds: [], operations: [] });

  let seeded = appReducer(initialAppState, {
    type: "restoreProject",
    entries: [
      {
        path: "/cuts/restored.psd",
        mtime: 1700,
        tree: treeOf([1]) as never,
        matchedIds: [1],
        ops: {
          includedIds: [1], previewHiddenIds: [], soloIds: [], edgeColourIds: [],
          manualLineIds: [], ops: [], entries: [],
        } as never,
        previewKey: null,
        previewFile: null,
      },
    ],
  } as never);
  seeded = appReducer(seeded, { type: "addFiles", paths: ["/cuts/plain.psd"] });

  render(<App initialState={seeded} />);

  // 복원한 파일이 먼저 열린다 — restoreProject가 목록 맨 앞에 넣는다.
  await waitFor(() => expect(opens).toHaveLength(1));
  expect(opens[0].path).toBe("/cuts/restored.psd");
  // 프리셋이 선택될 때까지 기다린다. 그래야 아래 판정이 "프리셋이 아직 안 걸려서
  // 안 불렸다"가 아니라 "복원본이라 걸지 않았다"임을 보장한다.
  //
  // PresetBar가 옵션을 그리는 렌더와, 그 선택이 App의 selectedPreset(→ presetRef)에
  // 닿는 렌더는 한 박자 다르다(PresetBar의 onSelectedPresetChange effect가 그 다음
  // 커밋에서 App의 state를 바꾸고, presetRef 동기화 effect는 또 그 다음이다).
  // getByText가 성공한 시점에는 아직 presetRef가 못 따라왔을 수 있으므로, 실제
  // 매크로태스크 틱을 하나 흘려보내 그 사슬이 다 돌게 한다.
  await waitFor(() => expect(screen.getByText(PRESET.name)).toBeTruthy());
  await new Promise((resolve) => setTimeout(resolve, 20));

  opens[0].d.resolve({
    sessionId: 1, width: 10, height: 10, colorMode: "RGB", depth: 8,
    tree: treeOf([1]), mtime: 1700,
  });
  await waitFor(() => expect(screen.queryAllByText("열림").length).toBeGreaterThanOrEqual(1));

  // 큐가 다음 파일로 넘어간다. 복원본에 자동 적용을 걸었다면 그 응답부터
  // 기다려야 했겠지만, 걸지 않았으므로 곧바로 다음 파일이 열린다.
  await waitFor(() => expect(opens).toHaveLength(2));
  expect(opens[1].path).toBe("/cuts/plain.psd");

  opens[1].d.resolve({
    sessionId: 2, width: 10, height: 10, colorMode: "RGB", depth: 8,
    tree: treeOf([1]), mtime: 999,
  });
  await waitFor(() => expect(screen.queryAllByText("열림").length).toBeGreaterThanOrEqual(2));

  await waitFor(() => expect(engine.applyPreset).toHaveBeenCalledTimes(1));
  // 복원본(세션 1)이 아니라 평범한 파일(세션 2)에만 걸렸다.
  expect(engine.applyPreset).toHaveBeenCalledWith(2, PRESET);
});

// 위 판정의 반대편. 큐의 `alreadyApplied`는 "복원한 mtime이 **있고** 그것이 방금 연
// mtime과 같을 때"만 참이어야 한다. OpenResult.mtime은 optional이라(lib/types.ts)
// 엔진이 mtime을 안 주는 경우가 있고, "있고"를 빼면 복원한 적 없는 파일에서
// `undefined === undefined`가 참이 되어 폴더 전체가 "이미 적용됨"으로 판정된다 —
// 큐가 프리셋을 한 장도 안 걸고 지나간다.
//
// 파일이 둘이어야 이것을 잡는다. 첫 파일은 보고 있는 파일이라 뒤늦게 그물 효과가
// 프리셋을 걸어주지만(App의 "그물" useEffect), 나머지는 아무도 안 걸어준다 —
// 폴더 전체가 조용히 프리셋 없이 남는 것이 실제 증상이다.
test("files that were never restored still get the preset when the engine reports no mtime", async () => {
  seedWorkerCount(1); // 위와 같은 판정의 반대편 — 역시 로드 큐(순차 경로)의 것이다
  vi.mocked(loadPresets).mockResolvedValueOnce([PRESET]);
  engine.applyPreset.mockResolvedValue({ matchedLayerIds: [1], operations: [] });

  const seeded = appReducer(initialAppState, {
    type: "addFiles",
    paths: ["/cuts/one.psd", "/cuts/two.psd"],
  });

  render(<App initialState={seeded} />);

  await waitFor(() => expect(opens).toHaveLength(1));
  // 프리셋이 선택될 때까지 기다린다(위 테스트와 같은 이유의 레이스 방지).
  await waitFor(() => expect(screen.getByText(PRESET.name)).toBeTruthy());
  await new Promise((resolve) => setTimeout(resolve, 20));

  // 엔진이 mtime을 돌려주지 않는다.
  opens[0].d.resolve({
    sessionId: 1, width: 10, height: 10, colorMode: "RGB", depth: 8, tree: treeOf([1]),
  });
  await waitFor(() => expect(opens).toHaveLength(2));
  opens[1].d.resolve({
    sessionId: 2, width: 10, height: 10, colorMode: "RGB", depth: 8, tree: treeOf([1]),
  });

  await waitFor(() => expect(engine.applyPreset).toHaveBeenCalledTimes(2));
  expect(engine.applyPreset).toHaveBeenCalledWith(1, PRESET);
  expect(engine.applyPreset).toHaveBeenCalledWith(2, PRESET);
});

// 세 번째 경로: 엔진이 죽었다 재시작하면(EngineStatus) 그 파일의 FileEntry가
// { path, status: "idle" }로 통째로 갈아 끼워진다 — mtime도 함께 사라진다.
// restoredMtimeByPath는 지워지지 않는다(엔진이 죽어도 디스크의 PSD는 그대로다).
// 큐가 "복원본이라 이미 적용됐다"는 판정을 FileEntry.mtime에서 다시 계산한다면
// 이 순간 그 대리 지표가 사라져 판정이 뒤집히고, 큐가 파일을 재오픈할 때
// applyPresetEffect를 또 걸어 복원해 지킨 편집을 덮는다.
test("re-processing a restored file after an engine restart still skips auto-apply", async () => {
  seedWorkerCount(1); // 세 번째 경로도 로드 큐가 재오픈하는 순차 경로의 것이다
  let deadCallback: ((payload: { stderrTail?: string[] }) => void) | undefined;
  engine.onEngineDead.mockImplementation((cb: (payload: { stderrTail?: string[] }) => void) => {
    deadCallback = cb;
    return Promise.resolve(() => {});
  });
  vi.mocked(loadPresets).mockResolvedValueOnce([PRESET]);
  engine.applyPreset.mockResolvedValue({ matchedLayerIds: [], operations: [] });

  const seeded = appReducer(initialAppState, {
    type: "restoreProject",
    entries: [
      {
        path: "/cuts/restored.psd",
        mtime: 1700,
        tree: treeOf([1, 2]) as never,
        matchedIds: [1, 2],
        ops: {
          includedIds: [1, 2], previewHiddenIds: [], soloIds: [], edgeColourIds: [],
          manualLineIds: [], ops: [],
          // 손으로 병합한 결과. 프리셋을 다시 걸면(matchedLayerIds가 빈 목록이므로
          // 0장) entries가 비고, 그냥 새로 연 것으로 되돌아가도(2장, 병합 전 개별
          // 항목) 이 모양이 될 수 없다 — "1장(병합)"이 끝까지 남아 있다는 것이
          // 복원한 편집이 살아남았다는 증거다.
          entries: [{ entryId: -1, sourceIds: [1, 2], name: "MERGED" }],
        } as never,
        previewKey: null,
        previewFile: null,
      },
    ],
  } as never);

  render(<App initialState={seeded} />);

  await waitFor(() => expect(opens).toHaveLength(1));
  // 프리셋이 선택될 때까지 기다린다(위 테스트와 같은 이유의 레이스 방지).
  await waitFor(() => expect(screen.getByText(PRESET.name)).toBeTruthy());
  await new Promise((resolve) => setTimeout(resolve, 20));

  opens[0].d.resolve({
    sessionId: 1, width: 10, height: 10, colorMode: "RGB", depth: 8,
    tree: treeOf([1, 2]), mtime: 1700,
  });
  await waitFor(() => expect(screen.getByText("1장")).toBeTruthy());
  expect(engine.applyPreset).not.toHaveBeenCalled();

  // 엔진이 죽고, 사람이 재시작을 누른다.
  deadCallback?.({ stderrTail: [] });
  await waitFor(() => expect(screen.getByRole("button", { name: "재시작" })).toBeTruthy());
  click(screen.getByRole("button", { name: "재시작" }));

  // 큐가 idle로 돌아간 그 파일을 다시 연다.
  await waitFor(() => expect(opens).toHaveLength(2));
  expect(opens[1].path).toBe("/cuts/restored.psd");

  // 디스크의 PSD는 바뀌지 않았으므로 엔진이 돌려주는 mtime도 그대로다.
  opens[1].d.resolve({
    sessionId: 2, width: 10, height: 10, colorMode: "RGB", depth: 8,
    tree: treeOf([1, 2]), mtime: 1700,
  });

  await waitFor(() => expect(screen.getByText("1장")).toBeTruthy());
  // 재적용을 걸었다면 매칭 결과([])로 덮여 entries가 비어 "0장"이 됐을 것이다.
  expect(screen.queryByText("0장")).toBeNull();
  expect(engine.applyPreset).not.toHaveBeenCalled();

  // 그리고 복원한 matchedIds도 살아남아야 한다. ops만 지키고 이것을 버리면 손실을
  // 맞바꾼 것뿐이다 — 큐도 그물 효과도 복원본에는 자동 적용을 걸지 않으므로
  // 되돌아올 길이 없고, matchedIds는 내보내기 인자라 비면 색 통일이 매칭된 라인이
  // 아니라 포함된 레이어 전부에 걸린다(아티스트에게는 아무 표시도 안 간다).
  //
  // "라인만"으로 본다. matchedIds가 비면 이 필터가 이름 규칙으로 대체 동작하고
  // 그때만 안내문이 뜨므로(layerFilter의 isLineFallbackActive), 안내문이 없다는
  // 것이 곧 matchedIds가 남아 있다는 것이다. 재시작 중에는 활성 파일이 잠시
  // 사라져 패널이 필터를 "전체"로 되돌리므로(LayerTree의 path 효과) 파일이 다시
  // 열린 지금 누른다.
  click(screen.getByRole("button", { name: "라인만" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "라인만" }).getAttribute("aria-pressed")).toBe("true")
  );
  expect(screen.queryByText(/프리셋을 아직 적용하지 않아/)).toBeNull();
});

test("no thumbnail is rendered while the load queue is running", async () => {
  render(<App />);
  await addFiles({ click });
  await finishOpen(0, 1, [1, 2, 3]);
  await waitFor(() => expect(opens).toHaveLength(2));

  // 첫 파일이 열려 레이어까지 떴고, 그 행들이 화면에 보인다고 알린다. 그래도
  // 큐가 도는 동안에는 한 장도 나가지 않아야 한다 — 세션이 두 칸뿐이라 이
  // 요청들이 큐가 방금 연 세션을 밀어내기 때문이다. 보여주지 않고 확인하면
  // 애초에 요청할 것이 없어 통과해버린다.
  const observer = await waitFor(() => {
    const o = FakeIntersectionObserver.latest();
    expect(o).toBeTruthy();
    return o;
  });
  observer.reveal([1, 2, 3]);

  await new Promise((r) => setTimeout(r, 30));
  expect(engine.renderThumbnails).not.toHaveBeenCalled();

  // 큐가 끝나면 그때 나간다.
  click(screen.getByRole("button", { name: "중지" }));
  await finishOpen(1, 2);
  await waitFor(() => expect(engine.renderThumbnails).toHaveBeenCalled());
});

/**
 * 리마운트(개발 중의 HMR, StrictMode)로 죽은 인스턴스가 남기는 큐를 막는다.
 *
 * 세 큐 모두 중복 실행은 ref로 막는데, 그 ref는 마운트된 인스턴스의 것이다.
 * 리마운트되면 새 인스턴스는 빈 ref로 자기 큐를 출발시키고 옛 큐는 그대로 돈다 —
 * 아무도 그것을 세울 수 없다(옛 큐가 읽는 취소 ref도 함께 버려졌으므로 진행바의
 * "중지"조차 닿지 않는다). 실제로 이렇게 여섯 개가 겹쳐 돌면서 세션 두 칸을 두고
 * 서로를 밀어냈고, 파일 40~49개가 한꺼번에 'unknown or evicted session'으로
 * 떨어졌다(에러 카드 7장, 세션 id 128→900).
 */
test("a remount does not leave the old load queue running", async () => {
  const view = render(<App />);
  await addFiles({ click });
  expect(opens).toHaveLength(1);

  view.unmount();
  // 이미 나간 열기 하나는 끝난다. 그 뒤로 죽은 큐가 다음 파일을 집으면 안 된다.
  opens[0].d.resolve({
    sessionId: 1,
    width: 10,
    height: 10,
    colorMode: "RGB",
    depth: 8,
    tree: treeOf([1, 2, 3]),
    mtime: 1,
  });

  await new Promise((r) => setTimeout(r, 50));
  expect(opens).toHaveLength(1);
});

test("a remount does not leave the old preview-prefetch queue running", async () => {
  // 활성 파일(세션 1)은 캔버스가 그리므로 즉시 끝내고, 준비 큐가 맡는 나머지
  // 파일만 테스트가 붙잡는다. 캔버스까지 붙잡으면 준비 큐가 양보하느라 안 뜬다.
  const held: ReturnType<typeof deferred<{ pngPath: string }>>[] = [];
  const holdUnlessActive = (sessionId: number) => {
    if (sessionId === 1) return Promise.resolve({ pngPath: "/tmp/p.png" });
    const d = deferred<{ pngPath: string }>();
    held.push(d);
    return d.promise;
  };
  engine.renderPreview.mockImplementation(holdUnlessActive);
  engine.renderDocumentPreview.mockImplementation(holdUnlessActive);

  const view = render(<App />);
  await addFiles({ click });
  await finishOpen(0, 1);
  await waitFor(() => expect(opens).toHaveLength(2));
  await finishOpen(1, 2);
  await waitFor(() => expect(opens).toHaveLength(3));
  await finishOpen(2, 3);

  // 로드가 끝나면 준비 큐가 돈다. 보고 있는 파일은 건너뛰므로 b.psd가 첫 대상이다.
  await waitFor(() => expect(held).toHaveLength(1), { timeout: 3000 });

  view.unmount();
  held[0].resolve({ pngPath: "/tmp/p.png" });

  await new Promise((r) => setTimeout(r, 50));
  expect(held).toHaveLength(1);
});

/**
 * 그릴 것이 없는 파일은 준비 큐를 **떠나야** 한다.
 *
 * 큐는 대상을 needsPrefetch로 고르는데(캐시에 없고 이번에 만든 적도 없으면 대기),
 * 만든 파일은 키를 적어 빠지고 실패한 파일은 prefetchFailedRef로 빠진다. 그런데
 * visibleIds가 빈 파일은 렌더 없이 return이라 **어느 쪽에도 안 걸린다** — 다음
 * 회차에 또 대기로 잡힌다. 큐가 도는 조건에 opsByPath가 들어 있으므로, 그 상태로는
 * 아티스트가 눈을 하나 켜고 끌 때마다 "미리보기 준비 중"이 다시 선다.
 *
 * 규칙이 아무것도 못 잡는 판이 실제로 있다(라인이 제외 그룹 안에 있는 경우). 그런
 * 판이 폴더에 여러 장이면 큐는 영원히 안 빈다.
 */
test("a file with nothing to draw leaves the prefetch queue for good", async () => {
  render(<App />);
  await addFiles({ click });
  await finishOpen(0, 1, [1, 2, 3]);
  await waitFor(() => expect(opens).toHaveLength(2));
  // b.psd: 잎이 전부 숨겨져 있어 그릴 것이 없다. 프리셋이 없는 테스트에서는
  // includedIds가 전체 잎이고 previewHiddenIds가 안 보이는 잎이므로 교집합이 빈다.
  await finishOpen(1, 2, [4, 5], false);
  await waitFor(() => expect(opens).toHaveLength(3));
  await finishOpen(2, 3, [6, 7]);

  // 준비 큐가 한 바퀴 **실제로** 도는 것을 먼저 확인한다. 라벨이 사라진 것만
  // 보면 "아직 시작도 안 했다"와 구별되지 않아, 뒤의 단언이 무엇을 잡았는지
  // 알 수 없다. c.psd(세션 3)가 그려졌으면 큐는 확실히 돌았다.
  const drewSession = (sid: number) =>
    [...engine.renderPreview.mock.calls, ...engine.renderDocumentPreview.mock.calls].some((c) => c[0] === sid);
  await waitFor(() => expect(drewSession(3)).toBe(true), { timeout: 3000 });
  await waitFor(() => expect(screen.queryByText(/미리보기 준비 중/)).toBeNull(), { timeout: 3000 });
  // 누계가 아니라 **토글 이후에 새로 나간 것**만 센다. 누계로 세면 큐가 몇 바퀴를
  // 돌았는지가 앞선 테스트들과의 타이밍에 따라 흔들려 단언이 제자리에서 깨진다.
  const sent = () => ({
    p: engine.renderPreview.mock.calls.length,
    d: engine.renderDocumentPreview.mock.calls.length,
  });
  const before = sent();

  // 활성 파일에서 눈을 하나 끈다. 이것이 바꾸는 것은 이 파일의 키뿐이고, 이
  // 파일은 준비 큐가 애초에 건너뛴다 — 큐가 다시 설 이유가 없다.
  click(screen.getAllByRole("button", { name: "미리보기 토글" })[0]);

  await new Promise((r) => setTimeout(r, 80));
  expect(screen.queryByText(/미리보기 준비 중/)).toBeNull();
  // 큐가 다시 서지 않았다면 남의 파일이 다시 나간 일도 없어야 한다. 활성 파일
  // (세션 1)은 캔버스가 그리므로 그쪽은 늘어도 정상이다.
  const fresh = [
    ...engine.renderPreview.mock.calls.slice(before.p),
    ...engine.renderDocumentPreview.mock.calls.slice(before.d),
  ];
  expect(fresh.filter((c) => c[0] !== 1)).toEqual([]);
});

test("a remount does not leave the old thumbnail queue running", async () => {
  const held: ReturnType<typeof deferred<{ thumbs: Record<string, string> }>>[] = [];
  engine.renderThumbnails.mockImplementation(() => {
    const d = deferred<{ thumbs: Record<string, string> }>();
    held.push(d);
    return d.promise;
  });

  const view = render(<App />);
  await addFiles({ click });
  await finishOpen(0, 1, [1, 2, 3]);
  await waitFor(() => expect(opens).toHaveLength(2));

  // 큐가 멈춰야 썸네일이 풀린다.
  click(screen.getByRole("button", { name: "중지" }));
  await finishOpen(1, 2);
  await waitFor(() => expect(screen.getByText(/중지됨/)).toBeTruthy());

  const observer = await waitFor(() => {
    const o = FakeIntersectionObserver.latest();
    expect(o).toBeTruthy();
    return o;
  });
  observer.reveal([1, 2, 3]);
  await waitFor(() => expect(held).toHaveLength(1));

  view.unmount();
  // 청크는 2장씩이라 3번 행이 남아 있다. 죽은 큐가 그것을 받으러 가면 안 된다.
  held[0].resolve({ thumbs: { "1": "/tmp/1.png", "2": "/tmp/2.png" } });

  await new Promise((r) => setTimeout(r, 50));
  expect(held).toHaveLength(1);
});

test("thumbnails are requested only for the rows that are on screen", async () => {
  render(<App />);
  await addFiles({ click });
  await finishOpen(0, 1, [1, 2, 3]);
  await waitFor(() => expect(opens).toHaveLength(2));

  // 큐가 멈춰야 썸네일이 풀린다. 이미 나간 열기 하나는 끝내줘야 큐가 취소를 본다.
  click(screen.getByRole("button", { name: "중지" }));
  await finishOpen(1, 2);
  await waitFor(() => expect(screen.getByText(/중지됨/)).toBeTruthy());

  const observer = await waitFor(() => {
    const o = FakeIntersectionObserver.latest();
    expect(o).toBeTruthy();
    return o;
  });

  observer.reveal([2]);

  await waitFor(() => expect(engine.renderThumbnails).toHaveBeenCalled());
  const asked = engine.renderThumbnails.mock.calls.flatMap((c) => c[1] as number[]);
  expect(asked).toEqual([2]);
});

/**
 * PreviewCanvas의 렌더 효과(pendingRef 한 자리 latch)를 직접 붙잡고 흔든다. App
 * 전체를 띄우는 위 테스트들과 달리, 여기서 확인하는 것은 두 큐의 조율이 아니라
 * PreviewCanvas 하나가 스스로 지키는 불변식이다 — 그래서 최소한의 props로 컴포넌트
 * 하나만 세우고 rerender로 "토글"을 흉내 낸다.
 *
 * includedIds=[1,2,3], previewHiddenIds=[1]로 시작한다: 하나를 미리 감춰서
 * documentView([1,2,3] 전부 보임)를 벗어난 채로 열어야, 세는 엔진 호출이
 * renderDocumentPreview가 아니라 renderPreview로 고정된다.
 */
function previewCanvasProps(overrides: {
  previewHiddenIds: number[];
  onRenderingChange?: (busy: boolean) => void;
  matchedIds?: number[];
}) {
  return {
    sessionId: 1,
    path: "/cuts/a.psd",
    mtime: 1,
    status: "open" as const,
    tree: treeOf([1, 2, 3]),
    includedIds: [1, 2, 3],
    previewHiddenIds: overrides.previewHiddenIds,
    soloIds: [] as number[],
    lineColor: null,
    matchedIds: overrides.matchedIds,
    edgeLines: null,
    edgeColourIds: [] as number[],
    paused: false,
    cache: new PreviewCache(),
    onRenderingChange: overrides.onRenderingChange ?? vi.fn(),
    onSessionRefreshed: vi.fn(),
    onError: vi.fn(),
  };
}

// 색 통일은 프리셋 규칙에 걸린 라인에만 걸려야 한다. 손으로 체크해 넣은 색
// 레이어까지 덮으면 화면에서 새까맣게 보인다 — 썸네일은 원본 색이라 더 헷갈렸다.
// 엔진에 넘기는 것은 "지금 그리는 것 중 규칙에 걸린 것"이다(lineColorIdsFor).
test("the canvas tells the engine which layers the line color may touch", async () => {
  engine.renderPreview.mockResolvedValue({ pngPath: "/tmp/p.png" });

  render(
    <PreviewCanvas
      {...previewCanvasProps({ previewHiddenIds: [1], matchedIds: [2] })}
      lineColor="#000000"
    />
  );

  await waitFor(() => expect(engine.renderPreview).toHaveBeenCalled());
  // visibleIds는 [2, 3]이고 그중 규칙에 걸린 것은 2뿐이다 — 3은 원본 색으로 남는다.
  const [, visibleIds, , lineColor, lineColorIds] = engine.renderPreview.mock.calls[0];
  expect(visibleIds).toEqual([2, 3]);
  expect(lineColor).toBe("#000000");
  expect(lineColorIds).toEqual([2]);
});

test("a burst of toggles behind an in-flight render collapses to exactly one more dispatch", async () => {
  const held: ReturnType<typeof deferred<{ pngPath: string }>>[] = [];
  engine.renderPreview.mockImplementation(() => {
    const d = deferred<{ pngPath: string }>();
    held.push(d);
    return d.promise;
  });

  const { rerender } = render(<PreviewCanvas {...previewCanvasProps({ previewHiddenIds: [1] })} />);

  // 엔진이 비어 있었으므로 첫 렌더는 곧바로 나갔다. 이걸 붙잡아 둔다.
  await waitFor(() => expect(held).toHaveLength(1));

  // 렌더가 걸려 있는 동안 세 번 더 토글한다(매번 previewHiddenIds가 바뀌어 visibleKey가
  // 달라지므로 렌더 효과가 다시 돈다). inFlightRef가 0이 아니므로 셋 다 pendingRef
  // 자리만 갈아 끼워야 한다 — 새 렌더가 나가면 안 된다.
  rerender(<PreviewCanvas {...previewCanvasProps({ previewHiddenIds: [1, 2] })} />);
  rerender(<PreviewCanvas {...previewCanvasProps({ previewHiddenIds: [1, 3] })} />);
  rerender(<PreviewCanvas {...previewCanvasProps({ previewHiddenIds: [2, 3] })} />);
  expect(held).toHaveLength(1);

  // 붙잡아둔 렌더를 풀어준다. finally가 밀려 있던 마지막 스펙 하나만 낸다.
  held[0].resolve({ pngPath: "/tmp/p.png" });
  await waitFor(() => expect(engine.renderPreview).toHaveBeenCalledTimes(2));

  // 세 토글이 저마다 렌더를 걸었다면 넷이 됐을 것이다. 잠깐 더 기다려도 늘지 않는다.
  await new Promise((r) => setTimeout(r, 20));
  expect(engine.renderPreview).toHaveBeenCalledTimes(2);
});

test("the hand-off to a latched render never reports the engine idle", async () => {
  const held: ReturnType<typeof deferred<{ pngPath: string }>>[] = [];
  engine.renderPreview.mockImplementation(() => {
    const d = deferred<{ pngPath: string }>();
    held.push(d);
    return d.promise;
  });
  const onRenderingChange = vi.fn();

  const { rerender } = render(
    <PreviewCanvas {...previewCanvasProps({ previewHiddenIds: [1], onRenderingChange })} />
  );
  await waitFor(() => expect(held).toHaveLength(1));

  // 걸려 있는 동안 한 번 더 토글해 pendingRef에 다음 스펙을 걸어둔다.
  rerender(<PreviewCanvas {...previewCanvasProps({ previewHiddenIds: [2], onRenderingChange })} />);
  expect(held).toHaveLength(1);

  // 붙잡아둔 렌더를 풀어준다. finally는 밀린 스펙을 dispatch(inFlightRef 1→2)한
  // *다음에* 내리므로(2→1), 인계 도중 0을 거치지 않는다 — 두 번째 렌더도 이
  // mock이 붙잡으므로, onRenderingChange(false)는 이 시점까지 한 번도 나갈 수
  // 없다. finally의 순서가 뒤집히면(내리고 나서 dispatch) 그 사이에 0을 거치며
  // false가 한 번 끼어든다.
  held[0].resolve({ pngPath: "/tmp/p.png" });
  await waitFor(() => expect(engine.renderPreview).toHaveBeenCalledTimes(2));

  expect(onRenderingChange).not.toHaveBeenCalledWith(false);
});

test("a cold file shows the stored original until the composite lands", async () => {
  // 합성 첫 렌더는 큰 판에서 수 초가 걸린다(실측 최대 170초). 그동안 빈 화면
  // 대신 ~0.2초짜리 문서 원본을 자리에 띄우고, 합성이 도착하면 바꾼다.
  const held = deferred<{ pngPath: string }>();
  engine.renderPreview.mockReturnValue(held.promise);
  engine.renderDocumentPreview.mockResolvedValue({ pngPath: "/tmp/doc.png" });
  engine.loadPngDataUrl.mockImplementation((p: string) => Promise.resolve(`data:${p}`));

  render(<PreviewCanvas {...previewCanvasProps({ previewHiddenIds: [1] })} />);

  // 합성이 아직 걸려 있는 동안 원본이 먼저 뜨고, 배지가 그 사실을 말한다.
  await waitFor(() =>
    expect(screen.getByAltText("미리보기").getAttribute("src")).toBe("data:/tmp/doc.png")
  );
  expect(screen.getByText("원본 (합성 중...)")).toBeTruthy();

  held.resolve({ pngPath: "/tmp/real.png" });
  await waitFor(() =>
    expect(screen.getByAltText("미리보기").getAttribute("src")).toBe("data:/tmp/real.png")
  );
  expect(screen.queryByText("원본 (합성 중...)")).toBeNull();
});

test("a toggle keeps the last composite instead of flashing the original", async () => {
  // 자리끼움은 파일 전환(그림 없음)에만 건다 — 토글 중에는 직전 합성을 들고
  // 있는 편이 원본으로 바꿔치우는 것보다 낫다.
  const held: ReturnType<typeof deferred<{ pngPath: string }>>[] = [];
  engine.renderPreview.mockImplementation(() => {
    const d = deferred<{ pngPath: string }>();
    held.push(d);
    return d.promise;
  });
  engine.renderDocumentPreview.mockResolvedValue({ pngPath: "/tmp/doc.png" });
  engine.loadPngDataUrl.mockImplementation((p: string) => Promise.resolve(`data:${p}`));

  const { rerender } = render(<PreviewCanvas {...previewCanvasProps({ previewHiddenIds: [1] })} />);
  await waitFor(() => expect(held).toHaveLength(1));
  held[0].resolve({ pngPath: "/tmp/real1.png" });
  await waitFor(() =>
    expect(screen.getByAltText("미리보기").getAttribute("src")).toBe("data:/tmp/real1.png")
  );
  const docCalls = engine.renderDocumentPreview.mock.calls.length; // 첫 진입의 자리끼움

  rerender(<PreviewCanvas {...previewCanvasProps({ previewHiddenIds: [2] })} />);
  await waitFor(() => expect(held).toHaveLength(2));
  // 옛 합성이 그대로 떠 있고, 원본 요청이 더 나가지 않았다.
  expect(screen.getByAltText("미리보기").getAttribute("src")).toBe("data:/tmp/real1.png");
  expect(engine.renderDocumentPreview.mock.calls.length).toBe(docCalls);

  held[1].resolve({ pngPath: "/tmp/real2.png" });
  await waitFor(() =>
    expect(screen.getByAltText("미리보기").getAttribute("src")).toBe("data:/tmp/real2.png")
  );
});

/**
 * 프로젝트 배선(Task 6). 여기서 잠그는 것은 전부 "테스트는 초록불인데 아티스트의
 * 작업이 조용히 사라지는" 경로다 — 이 기능에서 그런 문이 지금까지 여섯 나왔다.
 */
const RESTORED = "/cuts/restored.psd";

/**
 * 저장된 프로젝트 항목 하나. previewKey는 실제 키 함수로 만든다(대조가 맞아야 한다).
 *
 * `preset`을 주면 그 프리셋의 색·경계선으로 키를 만들고 프로젝트에도 담는다 —
 * 저장 시점 설정으로 그린 그림이 그 프로젝트에 들어 있는 상태다. 앱의 선택은
 * 프로젝트를 연 **뒤에** 그 프리셋으로 옮겨지므로, 복원 직후 첫 계산은 색 없이
 * 어긋나고 프리셋이 도착했을 때는 이미 파일 열기 큐가 돌고 있다.
 */
function projectWithOnePreview(
  preset: (Omit<typeof PRESET, "lineColor"> & { lineColor: string | null }) | null = null
): { project: ProjectFile; previews: Map<string, string>; key: string; previewFile: string } {
  const tree = treeOf([1, 2]);
  const ops = {
    includedIds: [1, 2], previewHiddenIds: [], soloIds: [], edgeColourIds: [],
    manualLineIds: [], ops: [],
    // 손으로 병합한 결과. 프리셋을 다시 걸면 사라지므로 "1장"이 남아 있다는 것이
    // 곧 복원한 편집이 살아남았다는 증거다.
    entries: [{ entryId: -1, sourceIds: [1, 2], name: "MERGED" }],
  };
  // 프리셋을 안 주면 앱에도 선택된 프리셋이 없으므로(loadPresets가 []) 색·경계선은
  // 양쪽 다 null이라 첫 계산부터 키가 맞는다.
  const plan = previewRenderSpec(
    { path: RESTORED, mtime: 1700 }, tree as never,
    ops.includedIds, ops.previewHiddenIds, ops.soloIds,
    preset?.lineColor ?? null, [1, 2], preset?.edgeLines ?? null, ops.edgeColourIds
  );
  const key = plan.key!;
  const previewFile = previewFileName(key);
  const entry: ProjectEntry = {
    path: RESTORED, mtime: 1700, tree: tree as never, matchedIds: [1, 2],
    ops: ops as never, previewKey: key, previewFile,
  };
  return {
    project: { version: 1, preset: preset as never, files: [entry] },
    previews: new Map([[previewFile, "data:image/png;base64,RESTORED"]]),
    key,
    previewFile,
  };
}

/**
 * ⌘S / ⌘⇧S. 이 기능의 주 조작인데 버튼과 달리 disabled를 지나지 않으므로,
 * 키 경로는 따로 잠가야 한다 — 핸들러 본문을 통째로 지워도 나머지 테스트는
 * 한 개도 안 깨진다.
 */
function pressSave(options: { shift?: boolean } = {}) {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "s", metaKey: true, shiftKey: options.shift === true })
  );
}

/** "프로젝트 열기..."를 눌러 위 프로젝트를 연 상태까지 간다. */
async function openProject(fixture = projectWithOnePreview()) {
  vi.mocked(loadProjectFrom).mockResolvedValue({ project: fixture.project, previews: fixture.previews });
  // 픽스처가 담은 항목 전부를 "안 바뀐 파일"로 돌려준다. 하나만 적어두면 항목이
  // 둘인 픽스처에서 나머지가 stale로 떨어져, 테스트가 재려던 경로를 아예 안 탄다.
  engine.psdMtimes.mockResolvedValue(
    Object.fromEntries(fixture.project.files.map((f) => [f.path, f.mtime]))
  );
  vi.mocked(openDialog).mockResolvedValue("/proj/작업.bwproj" as never);

  click(screen.getByRole("button", { name: "프로젝트 열기..." }));
  // ProjectBar가 폴더 이름을 보이면 handleProjectOpen이 끝까지 갔다는 뜻이다.
  await waitFor(() => expect(screen.getByText("작업.bwproj")).toBeTruthy());
  return fixture;
}

/**
 * 프로젝트를 열면 **파일이 열리기 전에** 담아둔 미리보기가 화면에 뜬다.
 *
 * 예전에는 안 떴다. PreviewCanvas가 `sessionId`가 없으면 그림보다 먼저 안내
 * 문구로 빠졌고, 로드 중(`paused`)이면 캐시를 보기도 전에 물러났다. 그래서
 * 아티스트는 파일 89장이 전부 열릴 때까지 빈 화면을 봤다 — 그릴 것이 이미 캐시에
 * 올라와 있는데도. 세션은 그림을 띄우는 데 필요하지 않다. 다시 그릴 때만 든다.
 */
test("a restored preview shows before the file is open", async () => {
  render(<App />);
  await openProject();

  // 아직 아무 파일도 안 열렸다 — openPsd는 붙잡혀 있다.
  expect(screen.queryAllByText("열림")).toHaveLength(0);
  await waitFor(() => expect(screen.getByAltText("미리보기")).toBeTruthy());
  expect((screen.getByAltText("미리보기") as HTMLImageElement).src).toContain("RESTORED");
  // 그리고 엔진에는 가지 않았다 — 캐시에서 그대로 온 그림이다.
  expect(engine.renderPreview).not.toHaveBeenCalled();
});

/**
 * 프리셋을 고치는 동안에는 준비 큐가 출발하지 않는다.
 *
 * 라인색·경계선은 미리보기 키에 그대로 들어가므로, 프리셋을 한 번 고치면 목록에
 * 있는 파일 **전부**의 키가 동시에 갈리고 큐는 처음부터 다시 만들기 시작한다.
 * 그런데 프리셋 편집은 원래 연타로 하는 일이라 그렇게 만든 배치는 다음 수정에서
 * 통째로 버려진다. 엔진은 요청을 하나씩만 처리하므로(rpc.py의 main 루프) 그
 * 낭비는 노는 CPU가 아니라 **아티스트가 지금 보려는 그림의 대기 시간**이다.
 *
 * **여기서 잠그는 것은 앞쪽 절반뿐이다 — "세운다"까지.** 뒤쪽("손을 멈추면 다시
 * 돈다")은 넣었다가 뺐다: 단독으로는 통과하는데 이 파일을 통째로 돌리면 재개가
 * 4초 안에 안 잡혀 제자리에서 깨졌다(프리셋이 있어 파일마다 적용까지 도는 판이라
 * 큐가 느리다).
 *
 * **그래서 재개는 지금 어떤 테스트도 잠그지 않는다.** 확인까지 했다 — 타이머가
 * `setPrefetchHold(false)`를 안 부르게 바꿔도 이 파일 38개가 전부 초록불이었다.
 * 프리셋을 바꾸는 테스트가 여기 하나뿐이라 다른 테스트는 이 표시를 아예 안 밟는다.
 * 재개가 죽으면 증상은 "미리보기가 영영 준비되지 않는다"이고, 조용히 느려지는
 * 쪽이라 눈에 안 띈다. 이 줄이 그 빈자리의 표식이다.
 */
test("changing the preset holds the prefetch queue until the artist stops", async () => {
  // 여기서 재는 것은 **미리보기 준비 큐**(순차 경로)가 서는 것이다. 워커로 준비한
  // 폴더에서는 그 큐가 애초에 할 일이 없어 "안 나갔다"가 공짜로 참이 된다.
  seedWorkerCount(1);
  // 두 번째 프리셋은 **라인색이 다르다**. 이름만 다르고 설정이 같으면 키가 하나도
  // 안 갈려 큐가 애초에 할 일이 없고, 그러면 이 테스트는 아무것도 재지 못한다.
  vi.mocked(loadPresets).mockResolvedValueOnce([
    PRESET as never,
    { ...PRESET, name: "다른 프리셋", lineColor: "#000000" } as never,
  ]);
  render(<App />);
  await addFiles({ click });
  await finishOpen(0, 1, [1, 2, 3]);
  await waitFor(() => expect(opens).toHaveLength(2));
  await finishOpen(1, 2, [4, 5]);
  await waitFor(() => expect(opens).toHaveLength(3));
  await finishOpen(2, 3, [6, 7]);

  // 큐가 한 바퀴 도는 것을 먼저 본다 — 그래야 아래 "안 돈다"가 "아직 시작도 안
  // 했다"와 구별된다. 라벨 문구로는 못 잰다: FilePanel이 "…{done}/{total}"로 쪼개
  // 그리므로 정규식 매칭이 안 붙는다(그래서 이 파일의 다른 곳에 있는
  // `queryByText(/미리보기 준비 중/)`는 늘 null이다). 실제로 나간 렌더로 센다.
  //
  // 특정 세션을 기다리지 않고 **조용해질 때까지** 기다린다. 파일 하나를 콕 집어
  // 기다리면 이 파일을 통째로 돌릴 때(프리셋이 있어 파일마다 적용까지 도는 판)
  // 3초 안에 그 차례가 안 와 제자리에서 깨진다.
  //
  // 활성 파일(세션 1)은 캔버스가 그리므로 늘어도 정상이다. 큐가 도는지는 **남의
  // 파일**이 나갔는지로만 판정한다.
  const others = () =>
    [...engine.renderPreview.mock.calls, ...engine.renderDocumentPreview.mock.calls].filter((c) => c[0] !== 1).length;
  let quiet = 0;
  let last = -1;
  for (let i = 0; i < 30 && quiet < 4; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    const now = others();
    quiet = now === last ? quiet + 1 : 0;
    last = now;
  }
  // 큐가 실제로 한 번은 돌았다는 증거. 이게 0이면 아래 단언은 아무것도 못 잰다.
  expect(others()).toBeGreaterThan(0);
  const before = others();

  // 프리셋을 바꾸고 **적용까지** 누른다. 아티스트가 하는 조작이 그것이고, 큐를
  // 다시 세우는 것도 그것이다 — 드롭다운만 바꾸면 준비 큐는 애초에 안 깨어난다
  // (효과의 의존성이 ops·파일 목록이라, 적용이 ops를 갈아야 다시 돈다).
  const select = screen.getByRole("combobox", { name: "프리셋" }) as HTMLSelectElement;
  select.value = "다른 프리셋";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  click(screen.getByRole("button", { name: "적용" }));

  // 세워둔 동안에는 **한 번도** 안 나간다. 한 번에 크게 건너뛰면 안 된다 — 그러면
  // 중간의 약속들이 정리될 틈이 없어 가드를 지워도 통과하는 가짜 초록불이 된다
  // (실제로 그랬다: 500ms 한 번에 건너뛰는 판은 변이가 살아남았다).
  for (let t = 0; t < 1_200; t += 100) {
    await new Promise((r) => setTimeout(r, 100));
    expect(others()).toBe(before);
  }

  // 이 테스트는 실제 시간을 쓴다(가짜 시계로는 준비 큐의 200ms 양보 루프가 안
  // 풀린다). 조용해질 때까지 최대 3초 + 정지 확인 1.2초라 기본 5초로는 모자란다.
}, 15_000);

/**
 * 그리고 **파일 열기 큐가 도는 중에도** 뜬다.
 *
 * 이쪽이 실제 순서다: 프로젝트의 프리셋은 PresetBar를 한 바퀴 돌아 한 틱 뒤에
 * 올라오므로, 복원 직후의 첫 계산은 색이 없어 키가 어긋난다. 그 사이 파일 열기
 * 큐가 출발해 `paused`가 서고, 캐시 조회가 그 뒤에 있으면 큐가 89장을 다 열
 * 때까지 화면이 비어 있는다 — 손에 그림을 들고서. 캐시 적중은 엔진에 가지
 * 않으므로 큐를 기다릴 이유가 없다.
 */
test("a restored preview shows while the file list is still loading", async () => {
  // 저장 시점 프리셋이 라인색을 켠 상태 = 지금 앱의 선택(없음)과 다른 상태.
  const fixture = projectWithOnePreview({ ...PRESET, lineColor: "#000000" });

  render(<App />);
  await openProject(fixture);

  // 큐가 실제로 돌고 있어야 이 테스트가 재려는 것을 잰다 — 진행 바의 "중지"가
  // 그 증거다(FilePanel은 loadProgress가 있을 때만 그린다). 큐는 프로젝트를 연
  // 직후 한 틱 뒤에 출발하므로 기다린다. openPsd는 붙잡혀 있어 한 번 서면
  // 이 테스트가 끝날 때까지 서 있다.
  await waitFor(() => expect(screen.getByRole("button", { name: "중지" })).toBeTruthy());
  await waitFor(() => expect(screen.getByAltText("미리보기")).toBeTruthy());
  expect(engine.renderPreview).not.toHaveBeenCalled();
});

/**
 * 미리보기는 **저장하는 순간 캐시에 있는 것만** 담긴다. 프리셋을 바꾼 직후에
 * 저장하면 키가 전부 갈린 뒤라 한두 장밖에 안 담기는데, previews/에는 지난
 * 저장이 남긴 PNG가 쌓여 있어 폴더만 보면 다 담긴 것처럼 보인다. 실제로 89개 중
 * 1장만 담긴 프로젝트가 나왔고, 다시 열자 87장을 처음부터 다시 그렸다. 그 침묵을
 * 없애는 것이 이 개수 표시다.
 */
test("saving says how many previews actually went in", async () => {
  const fixture = projectWithOnePreview();
  const withoutPreview: ProjectEntry = {
    ...fixture.project.files[0],
    path: "/cuts/no-preview.psd",
    previewKey: null,
    previewFile: null,
  };
  fixture.project.files.push(withoutPreview);

  render(<App />);
  await openProject(fixture);

  click(screen.getByRole("button", { name: "프로젝트 저장" }));
  await waitFor(() => expect(saveProjectTo).toHaveBeenCalled());

  const [, saved] = vi.mocked(saveProjectTo).mock.calls[0];
  expect(saved.files).toHaveLength(2);
  expect(saved.files.filter((f) => f.previewFile)).toHaveLength(1);
  // 개수는 말한다. 그리고 **그 문구 안에는** 경로·파일명이 없어야 한다 — 기밀이다.
  // (파일 목록에 이름이 보이는 것은 별개다. 여기서 재는 것은 메시지 하나다.)
  await waitFor(() => expect(screen.getByText(/미리보기 1\/2장이 담겼습니다/)).toBeTruthy());
  const notice = screen.getByText(/미리보기 1\/2장이 담겼습니다/).textContent ?? "";
  expect(notice).not.toContain("no-preview");
  // 이 파일은 그릴 것이 있는데 아직 안 만들어진 쪽이다 — 다시 저장하면 담긴다.
  expect(notice).toContain("나머지 1장");
  expect(notice).not.toContain("수동으로 선택");
});

/**
 * "아직 안 만들어졌다"와 "그릴 것이 없다"를 갈라서 말한다.
 *
 * 89장짜리 폴더에서 12장이 후자였다 — 프리셋 규칙이 그 판에서 아무것도 못 잡아
 * 체크가 0장이었고, 연속된 한 구간이었다. 그런데 안내가 "준비가 끝난 뒤 다시
 * 저장하면 전부 담깁니다"라고만 해서, 아티스트를 몇 번을 저장해도 안 담기는 일에
 * 기다리게 만들었다. 그쪽이 봐야 하는 것은 그 파일의 프리셋이고, 미리보기가 없다는
 * 것은 **내보내도 나올 것이 없다**는 뜻이기도 하다.
 */
test("the save notice separates 'nothing matched' from 'not prepared yet'", async () => {
  const fixture = projectWithOnePreview();
  const emptyOps = {
    ...(fixture.project.files[0].ops as unknown as Record<string, unknown>),
    includedIds: [],
    entries: [],
  };
  fixture.project.files.push({
    ...fixture.project.files[0],
    path: "/cuts/nothing-matched.psd",
    ops: emptyOps as never,
    matchedIds: [],
    previewKey: null,
    previewFile: null,
  });

  render(<App />);
  await openProject(fixture);

  click(screen.getByRole("button", { name: "프로젝트 저장" }));
  await waitFor(() => expect(saveProjectTo).toHaveBeenCalled());

  await waitFor(() => expect(screen.getByText(/미리보기 1\/2장이 담겼습니다/)).toBeTruthy());
  const notice = screen.getByText(/미리보기 1\/2장이 담겼습니다/).textContent ?? "";
  expect(notice).toContain("1장은 프리셋에 걸린 레이어가 없어 그릴 것이 없습니다");
  expect(notice).toContain("수동으로 선택하세요");
  // 기다리라고 하지 않는다 — 기다려도 안 담긴다.
  expect(notice).not.toContain("나머지");
});

/**
 * 캐시에 그 그림이 없어도 **참조는 이어받는다**.
 *
 * 저장은 그 순간 캐시에 있는 것만 담는데, 캐시는 예산이 있어 밀려난다. 파일이
 * 89장이면 프로젝트를 열며 프라이밍해둔 그림도 곧 밀리므로, 아무것도 안 바꾸고
 * ⌘S만 눌러도 담긴 미리보기가 줄어든다 — 디스크에는 그대로 있는데 새 project.json이
 * 이름을 안 대서 다음에 못 읽는다.
 *
 * 여기서 재는 것은 App의 몫(설정이 그대로면 옛 참조를 그대로 적고, 원본 폴더를
 * 넘긴다)뿐이다. 파일을 실제로 옮기고 없으면 참조를 지우는 쪽은 projectFs가 하고
 * 그쪽 테스트에 있다 — 이 파일에서는 projectFs가 통째로 목이다.
 */
test("a save carries a preview reference the cache has lost", async () => {
  const fixture = projectWithOnePreview();
  // 프라이밍이 아무것도 못 넣은 상태 = 캐시에 그 키가 없다.
  fixture.previews = new Map();

  render(<App />);
  await openProject(fixture);

  click(screen.getByRole("button", { name: "프로젝트 저장" }));
  await waitFor(() => expect(saveProjectTo).toHaveBeenCalled());

  const [, saved, previews, carryFrom] = vi.mocked(saveProjectTo).mock.calls[0];
  expect(saved.files[0].previewFile).toBe(fixture.previewFile);
  expect(previews.size).toBe(0); // 바이트는 안 들고 있다 — 이어받기는 파일 쪽 일이다
  expect(carryFrom).toBe("/proj/작업.bwproj");
});

/**
 * 정정 4. buildProject가 previewPlanFor를 쓰면 sessionId가 없는 복원 항목에서
 * null을 받아, **프로젝트를 열고 파일이 열리기 전에 저장하는 것만으로** 모든
 * 파일의 previewKey/previewFile이 null이 된다. previews/의 PNG는 새 저장에서
 * 빠지고 다음에 열면 그림 없이 복원된다 — 에러도 경고도 없이.
 */
test("saving right after opening a project keeps the restored previews", async () => {
  render(<App />);
  const fixture = await openProject();

  // 아직 아무 파일도 안 열렸다(openPsd는 붙잡혀 있다) — 저장은 이 상태에서 난다.
  expect(opens).toHaveLength(1);
  expect(screen.queryAllByText("열림")).toHaveLength(0);

  click(screen.getByRole("button", { name: "프로젝트 저장" }));
  await waitFor(() => expect(saveProjectTo).toHaveBeenCalled());

  const [dir, saved, previews] = vi.mocked(saveProjectTo).mock.calls[0];
  expect(dir).toBe("/proj/작업.bwproj");
  expect(saved.files).toHaveLength(1);
  expect(saved.files[0].previewKey).toBe(fixture.key);
  expect(saved.files[0].previewFile).toBe(fixture.previewFile);
  expect(previews.get(fixture.previewFile)).toBe("data:image/png;base64,RESTORED");
});

/**
 * 정정 6. engineRestarted는 모든 FileEntry를 { path, status: "idle" }로 갈아치워
 * tree와 mtime을 지운다(opsByPath는 남는다). "없으면 건너뛴다"로 두면 그 직후의
 * ⌘S 한 번이 files: []인 project.json으로 기존 폴더를 덮어쓴다.
 */
test("saving after an engine restart neither loses the files nor writes an empty project", async () => {
  let deadCallback: ((payload: { stderrTail?: string[] }) => void) | undefined;
  engine.onEngineDead.mockImplementation((cb: (payload: { stderrTail?: string[] }) => void) => {
    deadCallback = cb;
    return Promise.resolve(() => {});
  });

  render(<App />);
  const fixture = await openProject();

  deadCallback?.({ stderrTail: [] });
  await waitFor(() => expect(screen.getByRole("button", { name: "재시작" })).toBeTruthy());
  click(screen.getByRole("button", { name: "재시작" }));
  // 파일 항목이 초기화됐다 — tree도 mtime도 사라진 상태다.
  await waitFor(() => expect(screen.getAllByText("대기").length).toBeGreaterThanOrEqual(1));

  click(screen.getByRole("button", { name: "프로젝트 저장" }));
  await waitFor(() => expect(saveProjectTo).toHaveBeenCalled());

  const [, saved] = vi.mocked(saveProjectTo).mock.calls[0];
  // 빈 프로젝트가 아니다. 열려 있던 프로젝트의 tree/mtime으로 메워서 쓴다.
  expect(saved.files).toHaveLength(1);
  expect(saved.files[0].path).toBe(RESTORED);
  expect(saved.files[0].mtime).toBe(1700);
  expect(saved.files[0].ops.entries).toHaveLength(1);
  expect(saved.files[0].previewFile).toBe(fixture.previewFile);
});

/**
 * 같은 결함의 다른 쪽 — 메울 원본이 없는 세션(프로젝트를 연 적이 없다). 그때는
 * 저장을 **거절**해야 한다. 조용히 반쪽짜리를 쓰는 것보다 아무것도 안 쓰는 편이 낫다.
 */
test("saving with nothing to fall back on is refused instead of writing a hollow project", async () => {
  let deadCallback: ((payload: { stderrTail?: string[] }) => void) | undefined;
  engine.onEngineDead.mockImplementation((cb: (payload: { stderrTail?: string[] }) => void) => {
    deadCallback = cb;
    return Promise.resolve(() => {});
  });
  vi.mocked(openDialog).mockResolvedValue(PATHS as never);
  // 저장한 적 없는 세션이라 "프로젝트 저장"이 위치를 묻는다.
  vi.mocked(saveDialog).mockResolvedValue("/proj/새작업.bwproj");

  render(<App />);
  await addFiles({ click });
  await finishOpen(0, 1);

  deadCallback?.({ stderrTail: [] });
  await waitFor(() => expect(screen.getByRole("button", { name: "재시작" })).toBeTruthy());
  click(screen.getByRole("button", { name: "재시작" }));
  await waitFor(() => expect(screen.queryAllByText("열림")).toHaveLength(0));

  click(screen.getByRole("button", { name: "프로젝트 저장" }));
  await waitFor(() => expect(screen.getByText(/레이어 정보가 지금 없습니다/)).toBeTruthy());
  expect(saveProjectTo).not.toHaveBeenCalled();
  // 메시지에 납품 경로가 있으면 안 된다 — 개수만 말한다.
  expect(screen.queryByText(new RegExp(PATHS[0]))).toBeNull();
});

/**
 * 정정 5. 로드 큐의 processPath가 priorRestoredMtime을 `await openFileEffect`
 * **앞에서** 잡으면, 같은 경로의 열기가 진행 중일 때 restoreProject가 착지하는
 * 순간 두 판정이 갈린다: 리듀서의 openSuccess는 새 맵을 보고 ops를 지키는데
 * (presetApplied: true) 큐만 옛 undefined를 들고 프리셋을 걸어 그 ops를 덮는다.
 * Task 4 재리뷰가 찾았지만 배선이 없어 재현하지 못한 자리다.
 */
test("a project that lands while the queue is opening that same file does not get its work overwritten", async () => {
  vi.mocked(loadPresets).mockResolvedValueOnce([PRESET]);
  engine.applyPreset.mockResolvedValue({ matchedLayerIds: [], operations: [] });

  const seeded = appReducer(initialAppState, { type: "addFiles", paths: [RESTORED] });
  render(<App initialState={seeded} />);

  // 큐가 그 파일을 여는 중이다(응답은 아직 안 왔다).
  await waitFor(() => expect(opens).toHaveLength(1));
  expect(opens[0].path).toBe(RESTORED);
  await waitFor(() => expect(screen.getByText(PRESET.name)).toBeTruthy());
  await new Promise((resolve) => setTimeout(resolve, 20));

  // 그 사이에 프로젝트가 착지한다.
  await openProject();

  // 이제 진행 중이던 열기가 끝난다. 디스크의 PSD는 그대로이므로 mtime도 그대로다.
  opens[0].d.resolve({
    sessionId: 1, width: 10, height: 10, colorMode: "RGB", depth: 8,
    tree: treeOf([1, 2]), mtime: 1700,
  });

  // 복원한 병합("1장")이 남아 있어야 한다. 프리셋을 다시 걸었다면 매칭 결과([])로
  // 덮여 entries가 비고 "라인필요"가 됐을 것이다.
  await waitFor(() => expect(screen.getByText("1장")).toBeTruthy());
  expect(engine.applyPreset).not.toHaveBeenCalled();
});

/**
 * C1. 목록을 비워도 projectDir가 남으면 ProjectBar는 그 프로젝트가 열려 있다고
 * 말하고 ⌘S가 그 폴더를 겨눈다. buildProject는 파일이 없어 루프를 안 도니
 * blocked도 0이고, 거절 가드가 한 번도 안 걸린 채 어제까지의 작업이 files: []로
 * 덮인다. 복원 항목에는 edited가 없어 확인창도 안 뜬다 — 평범한 조작이다.
 */
test("clearing the list closes the project so ⌘S cannot overwrite it", async () => {
  render(<App />);
  await openProject();

  click(screen.getByRole("button", { name: "비우기" }));
  await waitFor(() => expect(screen.getByText("저장 안 된 작업")).toBeTruthy());

  // 그리고 ⌘S가 그 폴더를 겨누지 않는다 — 위치를 다시 묻는다.
  vi.mocked(saveDialog).mockResolvedValue(null as never);
  pressSave();
  await waitFor(() => expect(saveDialog).toHaveBeenCalled());
  expect(saveProjectTo).not.toHaveBeenCalled();
});

/**
 * 같은 결함의 다른 쪽 문. blocked는 "담을 작업이 있는데 못 담는다"라 루프를 한
 * 번이라도 돌아야 세어지므로, 0장짜리 저장은 그 가드를 그냥 지나간다.
 */
test("saving with nothing in the list is refused instead of writing files: []", async () => {
  vi.mocked(saveDialog).mockResolvedValue("/proj/작업.bwproj");
  render(<App />);

  click(screen.getByRole("button", { name: "프로젝트 다른 이름으로 저장..." }));
  await waitFor(() => expect(screen.getByText(/담을 파일이 0개/)).toBeTruthy());
  expect(saveProjectTo).not.toHaveBeenCalled();
});

/** I2. 이 기능의 주 조작인데 지금까지 테스트가 한 줄도 안 걸려 있었다. */
test("⌘S saves into the open project folder", async () => {
  render(<App />);
  await openProject();

  pressSave();
  await waitFor(() => expect(saveProjectTo).toHaveBeenCalled());
  expect(vi.mocked(saveProjectTo).mock.calls[0][0]).toBe("/proj/작업.bwproj");
  // 열려 있는 프로젝트가 있으므로 위치를 묻지 않는다.
  expect(saveDialog).not.toHaveBeenCalled();
});

test("⌘⇧S asks where to save even with a project open", async () => {
  render(<App />);
  await openProject();

  vi.mocked(saveDialog).mockResolvedValue("/proj/다른이름.bwproj");
  pressSave({ shift: true });
  await waitFor(() => expect(saveProjectTo).toHaveBeenCalled());
  expect(saveDialog).toHaveBeenCalled();
  expect(vi.mocked(saveProjectTo).mock.calls[0][0]).toBe("/proj/다른이름.bwproj");
});

/**
 * C2. macOS에서 ⌘를 누른 채 S를 붙들면 키 리피트가 난다. 버튼은 disabled로
 * 막히지만 키는 그 가드를 안 지나고, 상태(projectSaving)로는 같은 틱의 두 번째
 * 호출을 못 막는다 — setState는 다음 렌더에나 보인다. project_write_text는
 * truncate+write라 회차가 겹치면 잘린 project.json이 남고, 그러면 다음에 그
 * 폴더를 아예 못 연다(그 JSON이 유일본이다).
 */
test("a ⌘S key repeat does not run two saves over the same folder", async () => {
  render(<App />);
  await openProject();

  // 첫 회차를 붙잡아 둔다 — 겹칠 틈을 실제로 만든다.
  const gate = deferred<void>();
  vi.mocked(saveProjectTo).mockImplementationOnce(() => gate.promise);

  pressSave();
  pressSave();
  pressSave();

  await waitFor(() => expect(saveProjectTo).toHaveBeenCalled());
  expect(saveProjectTo).toHaveBeenCalledTimes(1);
  gate.resolve();
  await waitFor(() => expect(screen.getByText("작업.bwproj")).toBeTruthy());
  expect(saveProjectTo).toHaveBeenCalledTimes(1);
});

/**
 * I4. loadProjectFrom은 파일마다 IPC를 두 번씩 순차로 돈다(25장이면 50회).
 * 그동안 아무 표시가 없으면 끝난 줄 알고 다시 누르게 되고, restoreProject 둘이
 * 경합한다.
 */
test("opening a project twice at once runs one restore", async () => {
  const fixture = projectWithOnePreview();
  const gate = deferred<{ project: ProjectFile; previews: Map<string, string> }>();
  vi.mocked(loadProjectFrom).mockReturnValue(gate.promise);
  engine.psdMtimes.mockResolvedValue({ [RESTORED]: 1700 });
  vi.mocked(openDialog).mockResolvedValue("/proj/작업.bwproj" as never);

  render(<App />);
  const openButton = screen.getByRole("button", { name: "프로젝트 열기..." });
  click(openButton);
  click(openButton);

  await waitFor(() => expect(loadProjectFrom).toHaveBeenCalled());
  expect(loadProjectFrom).toHaveBeenCalledTimes(1);
  // 도는 동안 버튼도 잠긴다 — 표시가 없으면 사람은 다시 누른다.
  expect((screen.getByRole("button", { name: "프로젝트 열기..." }) as HTMLButtonElement).disabled).toBe(true);

  gate.resolve({ project: fixture.project, previews: fixture.previews });
  await waitFor(() => expect(screen.getByText("작업.bwproj")).toBeTruthy());
});

test("the chosen preset survives an app relaunch", async () => {
  // 프리셋은 사용자가 바꾸지 않는 한 저절로 바뀌면 안 되고, 그 규칙은 재시작보다
  // 위에 있다 — 켤 때마다 목록 첫 항목으로 돌아가면 그것이 "허락 없이 바뀐 것"이다.
  const other = { ...PRESET, name: "다른 프리셋" };
  // Once로 두 번 — 지속 구현(mockResolvedValue)으로 덮으면 clearAllMocks가
  // 구현은 안 지우므로 뒤따르는 테스트 전부에 프리셋이 새어 들어간다(아래
  // I3 테스트의 같은 주석 참고).
  vi.mocked(loadPresets).mockResolvedValueOnce([other, PRESET]);

  const first = render(<App />);
  await waitFor(() =>
    expect((screen.getByRole("combobox", { name: "프리셋" }) as HTMLSelectElement).value).toBe(other.name)
  );
  const el = screen.getByRole("combobox", { name: "프리셋" }) as HTMLSelectElement;
  el.value = PRESET.name;
  el.dispatchEvent(new Event("change", { bubbles: true }));
  await waitFor(() =>
    expect((screen.getByRole("combobox", { name: "프리셋" }) as HTMLSelectElement).value).toBe(PRESET.name)
  );
  first.unmount();

  vi.mocked(loadPresets).mockResolvedValueOnce([other, PRESET]);
  render(<App />);
  await waitFor(() =>
    expect((screen.getByRole("combobox", { name: "프리셋" }) as HTMLSelectElement).value).toBe(PRESET.name)
  );
});

/**
 * I3. 프로젝트의 프리셋을 앱의 선택으로 올리는 **App 쪽** 배선. PresetBar의
 * 테스트는 컴포넌트만 잠그고 위 픽스처는 preset: null이라, 이 분기를 지우면
 * 아무것도 안 깨졌다 — 그런데 이게 죽으면 화면이 계산하는 키가 방금 프라이밍한
 * 것과 달라져 복원한 미리보기를 전부 다시 그린다.
 */
test("opening a project moves the app's preset selection to the project's preset", async () => {
  const other = { ...PRESET, name: "다른 프리셋" };
  // Once로 준다 — 이 파일의 다른 테스트는 프리셋이 없는 상태를 전제하고,
  // 지속 구현으로 덮으면 뒤따르는 테스트에 프리셋이 새어 들어간다.
  vi.mocked(loadPresets).mockResolvedValueOnce([other, PRESET]);

  render(<App />);
  // 마운트 때는 목록의 첫 번째가 선택된다.
  await waitFor(() =>
    expect((screen.getByRole("combobox", { name: "프리셋" }) as HTMLSelectElement).value).toBe(other.name)
  );

  const fixture = projectWithOnePreview();
  fixture.project.preset = PRESET as never;
  await openProject(fixture);

  // 올라오는 것은 **프로젝트가 담고 있던 객체**다. 이름으로 목록에서 집으면
  // 저장 이후 그 프리셋을 편집한 경우 다른 설정이 올라와 복원한 미리보기의 키가
  // 전부 어긋난다. 그래서 드롭다운도 목록의 같은 이름과 구분해 보여준다.
  await waitFor(() =>
    expect((screen.getByRole("combobox", { name: "프리셋" }) as HTMLSelectElement).selectedOptions[0].textContent).toBe(
      `${PRESET.name} (프로젝트)`
    )
  );
});

/**
 * I1. 프리셋을 고르기 전에 폴더를 연 파일은 matchedIds가 없다. 그것을 []로
 * 적으면 저장할 때 쓴 키(undefined → "all")와 복원할 때 만드는 키([] → "")가
 * 갈려 방금 쓴 PNG를 한 장도 못 읽고, 내보내기에서는 "전부 건다"가 "아무 데도
 * 안 건다"로 뒤집힌다 — 그리고 복원 뒤에는 프리셋이 다시 걸리지 않으므로 그
 * 뒤집힌 값이 영구히 굳는다.
 */
test("a file that never had a preset applied is saved as null, not an empty list", async () => {
  vi.mocked(saveDialog).mockResolvedValue("/proj/새작업.bwproj");
  render(<App />);
  await addFiles({ click });
  await finishOpen(0, 1);

  click(screen.getByRole("button", { name: "프로젝트 다른 이름으로 저장..." }));
  await waitFor(() => expect(saveProjectTo).toHaveBeenCalled());

  const [, saved] = vi.mocked(saveProjectTo).mock.calls[0];
  const entry = saved.files.find((f) => f.path === PATHS[0]);
  expect(entry).toBeTruthy();
  expect(entry!.matchedIds).toBeNull();
});

/** 큐가 그 복원 파일을 끝까지 열어 sessionId까지 붙은 상태로 만든다. */
async function finishRestoredOpen() {
  await waitFor(() => expect(opens).toHaveLength(1));
  opens[0].d.resolve({
    sessionId: 1, width: 10, height: 10, colorMode: "RGB", depth: 8,
    tree: treeOf([1, 2]), mtime: 1700,
  });
  await waitFor(() => expect(screen.getAllByText("열림").length).toBe(1));
}

/**
 * 아홉 번째 문. openSuccess가 복원 분기에서도 edited: false를 세우면 복원한
 * 파일이 "지킬 편집 없음"이라고 말한다 — 그러면 "적용"이 확인창 없이 어제 손으로
 * 한 병합·이름변경·순서변경과 체크박스 선택을 applyPresetResult로 갈아치운다.
 * 사라지는 것이 하필 품이 제일 많이 든 작업이다.
 */
test("applying a preset to a restored file asks first — that work was done by hand", async () => {
  vi.mocked(loadPresets).mockResolvedValueOnce([PRESET]);
  engine.applyPreset.mockResolvedValue({ matchedLayerIds: [], operations: [] });

  render(<App />);
  await openProject();
  await finishRestoredOpen();

  click(screen.getByRole("button", { name: "적용" }));

  await waitFor(() => expect(screen.getByText("포함 목록을 프리셋 결과로 대체합니다")).toBeTruthy());
  // 확인창이 뜬 동안에는 아직 아무것도 덮이지 않았다.
  expect(engine.applyPreset).not.toHaveBeenCalled();
});

/** 반대쪽. 평범하게 연 파일의 ops는 프리셋의 산물이라 지킬 편집이 없다 — 지금 그대로여야 한다. */
test("applying a preset to a plainly opened file still does not ask", async () => {
  vi.mocked(loadPresets).mockResolvedValueOnce([PRESET]);
  engine.applyPreset.mockResolvedValue({ matchedLayerIds: [1], operations: [] });

  render(<App />);
  await addFiles({ click });
  await finishOpen(0, 1);
  // 큐의 자동 적용이 한 번 돈다. 그건 사람의 편집이 아니다.
  await waitFor(() => expect(engine.applyPreset).toHaveBeenCalledTimes(1));

  click(screen.getByRole("button", { name: "적용" }));

  await waitFor(() => expect(engine.applyPreset).toHaveBeenCalledTimes(2));
  expect(screen.queryByText("포함 목록을 프리셋 결과로 대체합니다")).toBeNull();
});

/**
 * 직전 라운드가 만든 침묵. 열기가 도는 중의 ⌘S는 맨 return이라 저장 0회·카드
 * 없음이었고, 버튼 라벨은 그러는 동안 "저장 중..."이라고 사실이 아닌 말을 했다.
 */
test("⌘S while a project is opening says so instead of doing nothing", async () => {
  const fixture = projectWithOnePreview();
  const gate = deferred<{ project: ProjectFile; previews: Map<string, string> }>();
  vi.mocked(loadProjectFrom).mockReturnValue(gate.promise);
  engine.psdMtimes.mockResolvedValue({ [RESTORED]: 1700 });
  vi.mocked(openDialog).mockResolvedValue("/proj/작업.bwproj" as never);

  render(<App />);
  click(screen.getByRole("button", { name: "프로젝트 열기..." }));
  await waitFor(() => expect(loadProjectFrom).toHaveBeenCalled());

  pressSave();

  await waitFor(() => expect(screen.getByText(/여는 중입니다/)).toBeTruthy());
  expect(saveProjectTo).not.toHaveBeenCalled();
  // 그리고 라벨은 저장을 하고 있다고 말하지 않는다.
  expect(screen.getByRole("button", { name: "프로젝트 저장" })).toBeTruthy();

  gate.resolve({ project: fixture.project, previews: fixture.previews });
  await waitFor(() => expect(screen.getByText("작업.bwproj")).toBeTruthy());
});

/** 같은 침묵의 더 나쁜 쪽 — 창을 띄워 폴더까지 고르게 해놓고 버렸다. */
test("⌘⇧S while a project is opening does not open a save dialog it will throw away", async () => {
  const fixture = projectWithOnePreview();
  const gate = deferred<{ project: ProjectFile; previews: Map<string, string> }>();
  vi.mocked(loadProjectFrom).mockReturnValue(gate.promise);
  engine.psdMtimes.mockResolvedValue({ [RESTORED]: 1700 });
  vi.mocked(openDialog).mockResolvedValue("/proj/작업.bwproj" as never);
  vi.mocked(saveDialog).mockResolvedValue("/proj/다른이름.bwproj");

  render(<App />);
  click(screen.getByRole("button", { name: "프로젝트 열기..." }));
  await waitFor(() => expect(loadProjectFrom).toHaveBeenCalled());

  pressSave({ shift: true });

  await waitFor(() => expect(screen.getByText(/여는 중입니다/)).toBeTruthy());
  expect(saveDialog).not.toHaveBeenCalled();
  expect(saveProjectTo).not.toHaveBeenCalled();

  gate.resolve({ project: fixture.project, previews: fixture.previews });
  await waitFor(() => expect(screen.getByText("작업.bwproj")).toBeTruthy());
});

/**
 * blocked는 "담을 작업이 있는데 못 담는다"만 센다 — ops는 한 번이라도 연 뒤에만
 * 생기므로 **아직 안 열린 파일은 세지도 않고 조용히 빠졌다.** 막지는 않는다(깨진
 * PSD 한 장이 저장을 영영 막으면 그게 더 나쁘다). 대신 개수를 말한다.
 */
test("saving while some files are still unopened says how many were left out", async () => {
  vi.mocked(saveDialog).mockResolvedValue("/proj/새작업.bwproj");
  render(<App />);
  await addFiles({ click });
  await finishOpen(0, 1);

  click(screen.getByRole("button", { name: "프로젝트 다른 이름으로 저장..." }));
  await waitFor(() => expect(saveProjectTo).toHaveBeenCalled());

  const [, saved] = vi.mocked(saveProjectTo).mock.calls[0];
  expect(saved.files).toHaveLength(1);
  await waitFor(() => expect(screen.getByText(/파일 2개가 아직 열리지 않아/)).toBeTruthy());
  // 개수만 말한다 — 납품 경로·파일명은 기밀이다.
  expect(screen.queryByText(new RegExp(PATHS[1]))).toBeNull();
});

/**
 * C1의 불변식("비우기 = 이 폴더는 끝났다")은 저장이 도는 중에도 서 있어야 한다.
 * 착지한 저장이 setProjectDir(dir)로 프로젝트를 다시 열면 다음 ⌘S가 또 그 폴더를
 * 겨눈다 — 비운 목록으로.
 */
test("clearing the list while a save is in flight does not re-open the project", async () => {
  render(<App />);
  await openProject();

  const gate = deferred<void>();
  vi.mocked(saveProjectTo).mockImplementationOnce(() => gate.promise);
  pressSave();
  await waitFor(() => expect(saveProjectTo).toHaveBeenCalled());

  click(screen.getByRole("button", { name: "비우기" }));
  await waitFor(() => expect(screen.getByText("저장 안 된 작업")).toBeTruthy());

  gate.resolve();
  // 저장 회차가 끝나 버튼이 다시 켜질 때까지 기다린다.
  await waitFor(() =>
    expect((screen.getByRole("button", { name: "프로젝트 저장" }) as HTMLButtonElement).disabled).toBe(false)
  );
  expect(screen.getByText("저장 안 된 작업")).toBeTruthy();
});

/**
 * 일곱 번째 문. restoreProject는 fresh만 받으므로(그게 맞다 — 버린 항목을
 * 되살리면 안 된다) 수정시각이 어긋난 파일은 App이 addFiles로 따로 넣어야 한다.
 * 그 한 줄을 지워도 전부 초록불이었다: FilePanel의 배지 테스트는 파일이 이미
 * 목록에 있다고 전제한 컴포넌트 테스트라 이 배선을 증명하지 못한다. 지우면
 * 아티스트는 자기 파일이 사라진 것으로 보고, 배지는 아무 데도 안 붙는다.
 */
test("opening a project keeps the files whose PSD changed in the list, with the badge", async () => {
  const MOVED = "/cuts/moved.psd";
  const fixture = projectWithOnePreview();
  fixture.project.files.push({ ...fixture.project.files[0], path: MOVED });
  vi.mocked(loadProjectFrom).mockResolvedValue({ project: fixture.project, previews: fixture.previews });
  // 저장된 mtime은 둘 다 1700이다. MOVED만 디스크에서 달라졌다.
  engine.psdMtimes.mockResolvedValue({ [RESTORED]: 1700, [MOVED]: 1899 });
  vi.mocked(openDialog).mockResolvedValue("/proj/작업.bwproj" as never);

  render(<App />);
  click(screen.getByRole("button", { name: "프로젝트 열기..." }));
  await waitFor(() => expect(screen.getByText("작업.bwproj")).toBeTruthy());

  // 목록에 남아 있고, 왜 작업이 없는지가 그 자리에 적혀 있다.
  await waitFor(() => expect(fileRow("moved.psd")).toBeTruthy());
  expect(fileRow("moved.psd").textContent).toContain("파일이 바뀜");
});

/**
 * 토글 워밍업 배선. 큐 자체의 규약(반복·양보·취소)은 lib/warmupQueue.test.ts가
 * 잠그므로, 여기서는 App이 그 큐를 실제로 출발시키는지만 본다 — 효과를 통째로
 * 지우면 이 테스트만 빨간불이 된다(변이 확인).
 */
test("after the queues settle, the active file's leaf tiles are warmed", async () => {
  render(<App />);
  await addFiles({ click });
  await finishOpen(0, 1);
  await finishOpen(1, 2);
  await finishOpen(2, 3);

  await waitFor(() => expect(engine.warmPreviewTiles).toHaveBeenCalled());
  const [sid, ids] = engine.warmPreviewTiles.mock.calls[0];
  // 활성 파일(첫 파일, 세션 1)의 픽셀 잎 전부.
  expect(sid).toBe(1);
  expect(ids).toEqual([1, 2, 3]);
});

test("the full-folder sweep waits for the artist to start it, then reports completion", async () => {
  // 워커 수 1 = 스윕을 **이 체인**(warmPreviewTiles)이 맡는 경로. 2 이상이면 스윕은
  // 워커 무리로 넘어가고(App.tsx의 `fullCacheOn && cacheWorkers > 1` 게이트) 그쪽은
  // 바로 아래 "with multiple workers…"가 잠근다.
  seedWorkerCount(1);
  // 폴더 전체 스윕은 몇 시간짜리 작업이라 자동으로 돌지 않는다 — 자동은
  // 활성·다음 파일까지만이고, 나머지는 "전체 캐시" 버튼으로 시작한다. 순서는
  // 활성 → 다음 → 나머지 스윕 → 스윕에 밀려났을 다음 파일 재데움(방금 디스크에
  // 쌓은 것을 읽는 것이라 싸다) → 완료 팝업.
  render(<App />);
  await addFiles({ click });
  await finishOpen(0, 1);
  await finishOpen(1, 2);
  await finishOpen(2, 3);

  // 자동 구간: 활성(1)과 다음(2)만. 세 번째는 건드리지 않는다.
  await waitFor(() => expect(engine.warmPreviewTiles.mock.calls.length).toBeGreaterThanOrEqual(2));
  await new Promise((r) => setTimeout(r, 30));
  expect(engine.warmPreviewTiles.mock.calls.map((c) => c[0])).not.toContain(3);

  click(screen.getByRole("button", { name: "전체 캐시" }));
  await waitFor(() => expect(screen.getByText("전체 캐시 완료")).toBeTruthy());
  const sids = engine.warmPreviewTiles.mock.calls.map((c) => c[0]);
  expect(sids.slice(0, 4)).toEqual([1, 2, 3, 2]);

  click(screen.getByRole("button", { name: "확인" }));
  await waitFor(() => expect(screen.queryByText("전체 캐시 완료")).toBeNull());
});

/**
 * 출고되는 기본 작업 프로세스 수를 못박는다.
 *
 * 이 값은 **세 군데가 동시에 맞아야** 한다: App.tsx의 DEFAULT_CACHE_WORKERS,
 * FilePanel 드롭다운이 "(기본)"이라고 써 붙인 항목, 그리고 저장된 값이 없는 채로
 * 뜬 앱이 실제로 고르는 값. 셋은 서로 다른 파일에 흩어져 있어 하나만 고쳐도 아무도
 * 안 말린다 — 드롭다운은 "워커 1 (기본)"이라 말하는데 앱은 2로 도는 화면이 그렇게
 * 만들어진다. 기본을 1에서 2로 올릴 때 실제로 셋 다 손대야 했고, 그때 이 대조를
 * 해주는 테스트가 하나도 없었다.
 *
 * **그래서 숫자를 여기 적지 않는다.** 적으면 맞춰야 할 자리가 넷이 된다.
 */
test("the shipped default worker count is what the dropdown calls 기본, and what the app starts on", () => {
  // 저장된 값이 없는 상태 = 이 앱을 처음 켠 사람. beforeEach의 localStorage 대역은
  // 매번 새로 세우므로 비어 있다 — 그 전제부터 확인한다.
  expect(window.localStorage.getItem(CACHE_WORKERS_STORAGE_KEY)).toBeNull();
  render(<App />);

  const select = workerSelect();
  // (1) 앱이 실제로 쓰는 값.
  expect(Number(select.value)).toBe(DEFAULT_CACHE_WORKERS);
  // (2) 드롭다운이 "(기본)"이라 표시한 항목. 하나뿐이어야 한다 — 둘이면 어느 쪽이
  //     기본인지 화면이 말해주지 못한다.
  const marked = [...select.options].filter((o) => o.textContent?.includes("(기본)"));
  expect(marked).toHaveLength(1);
  expect(Number(marked[0].value)).toBe(DEFAULT_CACHE_WORKERS);
});

/**
 * 그리고 **저장된 값이 기본값을 이긴다.** 기본을 올리는 변경이 사람이 골라둔 값을
 * 덮으면, 16GB 기계에서 일부러 1로 내려둔 사람이 다음 업데이트에서 말없이 2로
 * 돌아간다. 이 판정이 없으면 그 회귀는 "왜 갑자기 메모리가 터지지" 로만 보인다.
 */
test("a worker count the user already chose survives a change to the default", () => {
  const chosen = DEFAULT_CACHE_WORKERS === 1 ? 2 : 1;
  seedWorkerCount(chosen);
  render(<App />);

  expect(Number(workerSelect().value)).toBe(chosen);
});

test("with multiple workers the full cache covers files the app has not opened yet", async () => {
  // 워커 수를 올리면 전체 캐시는 별도 워커 프로세스로 돈다(디스패치 규칙은
  // lib/warmWorkers.test.ts가 잠근다). 대상은 **목록 전체**여야 한다 — 앱에서
  // 열린 파일만 쓸면, 프로젝트 로드 직후(대부분 아직 안 열림)에 몇 장만 쓸고
  // "완료" 팝업이 뜬다. 실사용에서 그렇게 잡힌 회귀다: 스윕이 수상하게 일찍
  // 끝나고, 안 쓸린 파일의 56.9Mpx 레이어가 토글에서 50초를 냈다.
  let lineCb: ((e: { generation: number; id: number; line: string }) => void) | undefined;
  engine.onWarmWorkerLine.mockImplementation(async (cb: (e: { generation: number; id: number; line: string }) => void) => {
    lineCb = cb;
    return () => {};
  });
  engine.warmWorkersStart.mockResolvedValue({ generation: 3, ids: [0, 1] });

  render(<App />);
  await addFiles({ click });
  await finishOpen(0, 1); // 나머지 두 파일은 아직 열리지 않았다

  setWorkers(2);
  click(screen.getByRole("button", { name: "전체 캐시" }));

  await waitFor(() => expect(engine.warmWorkersStart).toHaveBeenCalledWith(2, expect.any(Number)));
  // 세 파일 중 두 개가 먼저 두 워커에 나간다(당겨 가기).
  await waitFor(() => expect(engine.warmWorkerSend.mock.calls.length).toBe(2));
  // 두 번째 인자는 {path, presets} 페이로드다(engine.ts의 WarmWorkerJob).
  const done = (call: [number, { path: string }]) =>
    lineCb!({
      generation: 3, id: call[0],
      line: JSON.stringify({ event: "file", path: call[1].path, ok: true, total: 3, mtime: 1 }),
    });
  done(engine.warmWorkerSend.mock.calls[0] as [number, { path: string }]);
  done(engine.warmWorkerSend.mock.calls[1] as [number, { path: string }]);
  await waitFor(() => expect(engine.warmWorkerSend.mock.calls.length).toBe(3));
  done(engine.warmWorkerSend.mock.calls[2] as [number, { path: string }]);

  await waitFor(() => expect(screen.getByText("전체 캐시 완료")).toBeTruthy());
  expect(engine.warmWorkersStop).toHaveBeenCalled();
  // 안 연 파일까지 목록 전체가 워커에 넘어갔다.
  const sent = engine.warmWorkerSend.mock.calls.map((c) => (c[1] as { path: string }).path);
  expect(new Set(sent)).toEqual(new Set(PATHS));
});

/**
 * 파일 준비 큐(작업 프로세스 모드). 폴더를 연 직후의 "여는 중"과 "미리보기 준비
 * 중"을 워커가 파일 단위로 나눠 병렬로 한다 — 실측(100장 폴더, 콜드)으로 28.0분
 * 중 98.3%가 미리보기 합성이었고 여는 것은 1.7%뿐이었다.
 *
 * 디스패치 규칙 자체(당겨 가기·크래시 복구·실패 가시화)는 lib/warmWorkers.test.ts가
 * 잠근다. 여기서 재는 것은 **App이 그 큐를 실제로 출발시키는지**와, 돌아온 결과가
 * 화면 상태·미리보기 캐시에 제대로 앉는지다.
 */

/** 워커가 돌려주는 준비 결과 한 벌(엔진 warmworker.prepare_file의 result). */
function preparedResult(matched: number[], pngPath: string | null = null, ids = [1, 2, 3]) {
  return {
    tree: treeOf(ids),
    mtime: 1,
    width: 10,
    height: 10,
    colorMode: "RGB",
    depth: 8,
    matchedLayerIds: matched,
    skippedLayers: [],
    operations: [],
    pngPath,
    documentView: false,
  };
}

/**
 * 프리셋 하나를 고른 채로 앱을 띄운다. 준비는 워커가 프리셋 매칭까지 하는 일이라
 * 규칙이 없으면 아예 출발하지 않는다 — 이 대역이 없으면 아래 테스트들은 "준비가
 * 안 나갔다"를 배선 결함이 아니라 프리셋 없음으로 재게 된다.
 */
async function renderWithPreset() {
  // Once인 것이 중요하다. mockResolvedValue로 세우면 beforeEach의
  // clearAllMocks는 호출 기록만 지우고 구현은 남겨서, 뒤따르는 테스트들이
  // 프리셋이 선택된 채로 돌게 된다(워밍업 테스트 둘이 그렇게 깨졌다).
  vi.mocked(loadPresets).mockResolvedValueOnce([PRESET]);
  engine.applyPreset.mockResolvedValue({ matchedLayerIds: [], operations: [] });
  render(<App />);
  // PresetBar가 옵션을 그리는 렌더와 그 선택이 App의 presetRef까지 닿는 렌더는
  // 한 박자 다르다(위 "restored file" 테스트의 같은 주석 참고).
  await waitFor(() => expect(screen.getByText(PRESET.name)).toBeTruthy());
  await new Promise((r) => setTimeout(r, 20));
}

/**
 * 목록에 PATHS를 넣되 **메인 엔진 열기를 기다리지 않는다.** 워커 모드에서는 로드
 * 큐가 통째로 비켜서므로 open_psd가 한 번도 안 나간다 — addFiles의 "열기가
 * 나갔다"를 기다리면 그 자리에서 멈춘다. 행이 선 것으로 확인한다.
 */
async function addFilesForPrepare() {
  click(screen.getByRole("button", { name: "+ 추가" }));
  await waitFor(() => expect(fileRow("a.psd")).toBeTruthy());
}

/** 경로에서 파일명만. 목록 행을 찾을 때 쓴다(경로는 기밀이라 화면에 안 뜬다). */
function nameOf(path: string) {
  return path.split("/").pop()!;
}

/**
 * 워커에 나간 잡 중 **전체 캐시 스윕**의 것만. 두 큐가 같은 채널을 쓰므로 잡
 * 모양으로만 갈린다: 스윕은 {path, presets}, 파일 준비는 {path, prepare}다.
 */
function sweepJobs() {
  return engine.warmWorkerSend.mock.calls.filter(
    (c) => (c[1] as { presets?: unknown }).presets !== undefined
  );
}

/** warm-worker-line 구독을 가로채 테스트가 워커 이벤트를 직접 흘려보낸다. */
function captureWorkerLines(generation: number, ids: number[]) {
  let lineCb: ((e: { generation: number; id: number; line: string }) => void) | undefined;
  engine.onWarmWorkerLine.mockImplementation(
    async (cb: (e: { generation: number; id: number; line: string }) => void) => {
      lineCb = cb;
      return () => {};
    }
  );
  engine.warmWorkersStart.mockResolvedValue({ generation, ids });
  return (call: [number, { path: string }], result: unknown) =>
    lineCb!({
      generation,
      id: call[0],
      line: JSON.stringify({ event: "file", path: call[1].path, ok: true, result }),
    });
}

test("raising the worker count spreads file preparation across processes", async () => {
  const finish = captureWorkerLines(9, [0, 1]);

  await renderWithPreset();
  setWorkers(2);
  await addFilesForPrepare();

  await waitFor(() => expect(engine.warmWorkersStart).toHaveBeenCalledWith(2, expect.any(Number)));
  // 세 장 중 두 장이 **동시에** 나간다 — 한 장 끝나야 다음이 아니다.
  await waitFor(() => expect(engine.warmWorkerSend.mock.calls.length).toBe(2));

  // 잡 모양이 prepare다 — presets(전체 캐시)도 export(배치 내보내기)도 아니다.
  const job = engine.warmWorkerSend.mock.calls[0][1] as {
    prepare?: { preset: unknown; maxSize: number };
    presets?: unknown;
  };
  expect(job.prepare).toBeDefined();
  expect(job.prepare!.preset).toEqual(PRESET);
  expect(job.presets).toBeUndefined();

  // 준비 결과가 도착하면 그 파일이 **세션 없이** "열림"이 된다.
  finish(engine.warmWorkerSend.mock.calls[0] as [number, { path: string }], preparedResult([1]));
  finish(engine.warmWorkerSend.mock.calls[1] as [number, { path: string }], preparedResult([1]));
  await waitFor(() => expect(screen.queryAllByText("열림").length).toBeGreaterThanOrEqual(2));
  // 그리고 남은 한 장이 빈 워커에 이어 나간다(당겨 가기).
  await waitFor(() => expect(engine.warmWorkerSend.mock.calls.length).toBe(3));
});

test("with one worker file preparation stays on the current sequential path", async () => {
  // 이 테스트의 주제가 곧 워커 수다: **1로 내려두면** 아무것도 안 바뀐다 — 전체
  // 캐시가 이미 쓰는 규칙과 같다. 앱 기본이 2라 명시하지 않으면 이 자리에서
  // 병렬 경로가 도는데, 그러면 "안 나갔다"를 재려던 판정이 뒤집힌다.
  seedWorkerCount(1);
  await renderWithPreset();
  await addFiles({ click });
  await finishOpen(0, 1);
  await new Promise((r) => setTimeout(r, 20));
  expect(engine.warmWorkersStart).not.toHaveBeenCalled();
  expect(engine.warmWorkerSend).not.toHaveBeenCalled();
});

/**
 * 그리고 **드롭다운을 한 번도 안 건드린 사람**에게도 병렬 경로가 간다.
 *
 * 위아래의 워커 테스트는 전부 자기가 쓸 워커 수를 스스로 정한다 — 그래서 기본값이
 * 1로 되돌아가도 그 테스트들은 하나도 안 깨진다. 그러면 "설정을 한 번도 안 건드린
 * 사용자가 100장짜리 폴더에서 28분을 그대로 기다린다"는 예전 상태로 조용히
 * 돌아가도 아무도 안 말린다. 기본값을 올린 이유가 정확히 그것이라, 기본값만으로
 * 워커가 뜨는지를 여기서 따로 잠근다.
 */
test("a folder opened with nobody touching the dropdown goes to the workers", async () => {
  captureWorkerLines(9, [0, 1]);

  // seedWorkerCount도 setWorkers도 부르지 않는다 — 안 부르는 것이 이 테스트의 전부다.
  expect(window.localStorage.getItem(CACHE_WORKERS_STORAGE_KEY)).toBeNull();
  await renderWithPreset();
  await addFilesForPrepare();

  await waitFor(() =>
    expect(engine.warmWorkersStart).toHaveBeenCalledWith(DEFAULT_CACHE_WORKERS, expect.any(Number))
  );
  await waitFor(() => expect(engine.warmWorkerSend.mock.calls.length).toBeGreaterThan(0));
  // 그리고 그 잡은 파일 준비다 — 전체 캐시 스윕이 아니다.
  expect((engine.warmWorkerSend.mock.calls[0][1] as { prepare?: unknown }).prepare).toBeDefined();
});

test("the load queue never opens a file that preparation is going to take", async () => {
  // 준비는 로드 큐가 하던 일을 워커로 옮긴 것이다. 둘이 같이 돌면 같은 PSD를
  // 메인 엔진과 워커가 함께 열어 세션 두 칸을 두고 다툰다.
  //
  // **폴더의 첫 파일이 특히 위험하다.** 효과는 선언 순서대로 도는데 로드 큐가
  // 준비 효과보다 앞이라, 준비가 "돌고 있다"고 표시하기 전에 큐가 이미 한 장을
  // 집어 간다. 그러면 그 파일만 두 번 열리고, 늦게 착지한 openSuccess가 ops를
  // 다시 만들어 워커가 구운 미리보기가 그 파일에서만 미아가 된다. 그래서 여기서
  // 세는 것은 "한 장"이 아니라 **0장**이다.
  captureWorkerLines(9, [0, 1]);

  await renderWithPreset();
  setWorkers(2);
  await addFilesForPrepare();
  await waitFor(() => expect(engine.warmWorkerSend.mock.calls.length).toBe(2));

  await new Promise((r) => setTimeout(r, 30));
  expect(opens).toHaveLength(0);
});

/**
 * 워커는 세션을 만들 수 없다 — 세션은 메인 엔진 SessionStore의 것이다. 그래서
 * 준비된 파일은 "트리는 있는데 sessionId가 없는" 상태로 앉는데, 캔버스의 합성
 * 렌더도(PreviewCanvas는 sid가 없으면 요청 자체를 안 낸다) 레이어 썸네일도
 * 내보내기 버튼도 세션이 있어야 산다. 안 채우면 준비된 판은 눌러도 아무것도
 * 안 뜬다 — 미리보기 캐시에 그림이 있는 경우만 우연히 보인다.
 */
test("a prepared file gets a session when the app actually needs it", async () => {
  const finish = captureWorkerLines(9, [0, 1]);

  await renderWithPreset();
  setWorkers(2);
  await addFilesForPrepare();
  await waitFor(() => expect(engine.warmWorkerSend.mock.calls.length).toBe(2));
  const first = engine.warmWorkerSend.mock.calls[0] as [number, { path: string }];
  const second = engine.warmWorkerSend.mock.calls[1] as [number, { path: string }];

  finish(first, preparedResult([1]));
  finish(second, preparedResult([1]));
  await waitFor(() => expect(screen.queryAllByText("열림").length).toBeGreaterThanOrEqual(2));

  // 화면에 올라온 그 한 장에만 세션이 열린다. **준비된 전부가 아니다** — 세션은
  // LRU 2칸이라 100장을 열면 98장은 열자마자 죽고, 그 낭비를 없애려고 준비를
  // 워커로 옮긴 것이다.
  await waitFor(() => expect(opens).toHaveLength(1));
  expect(opens[0].path).toBe(first[1].path);
  await finishOpen(0, 11);
  await waitFor(() =>
    expect((screen.getByRole("button", { name: /내보내기/ }) as HTMLButtonElement).disabled).toBe(false)
  );

  // 다른 판을 누르면 그 판도 그 자리에서 세션을 얻는다.
  click(fileRow(nameOf(second[1].path)));
  await waitFor(() => expect(opens).toHaveLength(2));
  expect(opens[1].path).toBe(second[1].path);
});

/**
 * 워커가 준비한 폴더에서도 **다음 파일 미리 데우기**가 살아 있어야 한다.
 *
 * 이 사슬은 2026-08-13에 아티스트 요청으로 들어왔다: 지정 작업은 목록 순서로
 * 내려가므로, 두 번째 세션 칸에 다음 파일의 잎 타일을 미리 올려 두면 파일을
 * 넘어간 직후의 준비 구간(~2분)이 사라진다. 준비가 굽는 것은 미리보기 PNG
 * 한 장뿐이라 잎 타일은 여전히 콜드고, 그 2분을 덮는 것은 이 사슬뿐이다.
 *
 * 다음 파일을 "세션이 있는 파일"로 고르면 이 사슬이 **조용히 사라진다** —
 * 워커가 준비한 파일에는 세션이 없어서 후보가 늘 0장이 된다. 그래서 여기서
 * 재는 것은 "그다음 파일이 세션을 얻고 데워지는가"다.
 */
test("the warmup chain reaches the next prepared file, which has no session of its own", async () => {
  const finish = captureWorkerLines(9, [0, 1]);

  await renderWithPreset();
  setWorkers(2);
  await addFilesForPrepare();
  await waitFor(() => expect(engine.warmWorkerSend.mock.calls.length).toBe(2));
  const first = engine.warmWorkerSend.mock.calls[0] as [number, { path: string }];
  const second = engine.warmWorkerSend.mock.calls[1] as [number, { path: string }];

  // 실제 준비처럼 미리보기 PNG까지 들려 보낸다 — 그래야 미리보기 준비 큐가 할
  // 일이 없어(캐시 적중) 이 체인만 남는다. 워커가 굽지 못한 판까지 재려는 것이
  // 아니라, 여기서 보려는 것은 사슬의 다음 칸이다.
  finish(first, preparedResult([1], "/tmp/a.png"));
  finish(second, preparedResult([1], "/tmp/b.png"));
  await waitFor(() => expect(screen.queryAllByText("열림").length).toBeGreaterThanOrEqual(2));

  // 보고 있는 파일이 먼저 세션을 얻는다(위 테스트가 잠근 경로).
  await waitFor(() => expect(opens).toHaveLength(1));
  expect(opens[0].path).toBe(first[1].path);
  await finishOpen(0, 11);

  // 체인이 활성 파일을 데운 뒤 **그다음 파일**로 간다. 세션이 없으므로 데우기
  // 직전에 그 자리서 하나 연다 — 그러지 않으면 warm_preview_tiles를 부를 수 없다.
  await waitFor(() => expect(opens).toHaveLength(2));
  expect(opens[1].path).toBe(second[1].path);
  await finishOpen(1, 12);
  await waitFor(() =>
    expect(engine.warmPreviewTiles.mock.calls.map((c) => c[0])).toContain(12)
  );

  // 그리고 거기서 멈춘다. 준비된 것을 전부 열면 세션이 LRU 2칸이라 열자마자
  // 죽고, 그 낭비를 없애려고 준비를 워커로 옮긴 것이다.
  await new Promise((r) => setTimeout(r, 30));
  expect(opens).toHaveLength(2);
});

/**
 * 전체 캐시가 **워커 수 1로 내려간 뒤에도** 워커로 준비한 폴더를 실제로 쓸어야 한다.
 *
 * 스윕 대상을 "세션이 있는 파일"로 고르면 준비된 폴더에서는 목록이 통째로 비고,
 * 그러면 이 체인은 **"다 됐다" 가지**로 떨어진다 — 한 장 남짓 쓸고 "전체 캐시
 * 완료" 팝업이 뜬다. 실사용에서 이미 한 번 난 사고이고(App.tsx의 그 가지 주석:
 * 스윕이 수상하게 일찍 끝나고 안 쓸린 파일의 큰 레이어가 토글에서 50초를 냈다),
 * 이번에는 준비가 그 조건을 상시로 만든다.
 */
test("the full cache sweeps a worker-prepared folder instead of declaring it done", async () => {
  const finish = captureWorkerLines(9, [0, 1, 2]);

  await renderWithPreset();
  setWorkers(2);
  await addFilesForPrepare();
  await waitFor(() => expect(engine.warmWorkerSend.mock.calls.length).toBe(3));
  for (const call of engine.warmWorkerSend.mock.calls.slice(0, 3)) {
    // 미리보기 PNG까지 들려 보낸다(위 테스트의 같은 주석) — 미리보기 준비 큐를
    // 비워 두어야 여기서 재는 것이 스윕 하나로 남는다.
    finish(call as [number, { path: string }], preparedResult([1], "/tmp/p.png"));
  }
  await waitFor(() => expect(screen.queryAllByText("열림")).toHaveLength(3));

  // 보고 있는 한 장만 세션을 얻은 상태 — 나머지 둘은 트리만 있다.
  await waitFor(() => expect(opens).toHaveLength(1));
  await finishOpen(0, 11);

  // 워커 수를 1로 내린다. 그러면 스윕은 워커 무리가 아니라 이 체인이 맡는다
  // (위 게이트: fullCacheOn && cacheWorkers > 1이면 체인은 통째로 쉰다). 여기서
  // 재려는 것이 그 체인의 대상 고르기라 1이어야 한다 — 앱 기본값과는 무관하다.
  setWorkers(1);
  click(screen.getByRole("button", { name: "전체 캐시" }));

  // 다음 파일과 나머지 한 장이 차례로 세션을 얻고 데워진다. 팝업은 그 뒤다.
  await waitFor(() => expect(opens).toHaveLength(2));
  await finishOpen(1, 12);
  await waitFor(() => expect(opens).toHaveLength(3));
  await finishOpen(2, 13);

  await waitFor(() => expect(screen.getByText("전체 캐시 완료")).toBeTruthy());
  const sids = engine.warmPreviewTiles.mock.calls.map((c) => c[0]);
  expect(sids).toContain(12);
  expect(sids).toContain(13);
});

/**
 * 전체 캐시와 배치 내보내기가 도는 동안 준비가 작업 프로세스를 건드리면 안 된다.
 * 워커 스폰(warmWorkersStart)이 이전 세대를 **무조건 전부 죽이므로**
 * (src-tauri/src/warm.rs의 kill_all), 여기서 출발하면 몇 시간짜리 전체 캐시가
 * 조용히 죽고 배치는 반쪽 PSD를 남긴다. 설계 9절이 검증 항목으로 못박은 둘이다.
 */
test("file preparation stands aside while the full cache holds the workers", async () => {
  // 워커 1로 떠서 순차 경로가 파일을 쥔 상태를 먼저 만든다. 그래야 아래에서 2로
  // 올리는 것이 "전체 캐시가 워커를 잡고 있는 와중에 준비가 끼어들려는 순간"이
  // 된다 — 2로 떠 버리면 준비가 전체 캐시보다 **먼저** 출발해 재려던 순간이 없다.
  seedWorkerCount(1);
  await renderWithPreset();
  await addFiles({ click }); // 워커 1 — 현행 순차 경로가 첫 파일을 쥔다
  click(screen.getByRole("button", { name: "전체 캐시" }));
  setWorkers(2);
  await waitFor(() => expect(engine.warmWorkersStart).toHaveBeenCalled());
  await new Promise((r) => setTimeout(r, 30));

  // 워커에 나간 잡은 전부 전체 캐시(presets)다 — 준비 잡은 한 장도 없다.
  const jobs = engine.warmWorkerSend.mock.calls.map((c) => c[1] as { prepare?: unknown });
  expect(jobs.filter((j) => j.prepare !== undefined)).toHaveLength(0);
  // 그리고 파일은 현행 순차 경로가 계속 연다 — 느리지만 옳다(설계 6.2).
  await finishOpen(0, 1);
  await waitFor(() => expect(opens).toHaveLength(2));
});

test("file preparation stands aside while a batch export holds the workers", async () => {
  // 위와 같은 이유로 워커 1에서 출발한다 — 배치가 워커를 잡은 **뒤에** 2로 올린다.
  seedWorkerCount(1);
  const batching = deferred<{ results: unknown[] }>();
  engine.batchRun.mockReturnValue(batching.promise);
  engine.pathsExist.mockResolvedValue(PATHS.map(() => false));
  // BatchPanel도 프리셋 목록을 따로 읽는다 — 없으면 "배치 실행"이 비활성이다.
  vi.mocked(loadPresets).mockResolvedValueOnce([PRESET]);

  await renderWithPreset();
  await addFiles({ click }); // 워커 1 — 파일 둘이 대기로 남는다
  click(screen.getByRole("button", { name: "배치" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "전체 선택" })).toBeTruthy());
  click(screen.getByRole("button", { name: "전체 선택" }));
  await waitFor(() =>
    expect((screen.getByRole("button", { name: "배치 실행" }) as HTMLButtonElement).disabled).toBe(false)
  );
  click(screen.getByRole("button", { name: "배치 실행" }));
  await waitFor(() => expect(engine.batchRun).toHaveBeenCalled());

  setWorkers(2);
  await new Promise((r) => setTimeout(r, 30));
  expect(engine.warmWorkersStart).not.toHaveBeenCalled();
  expect(engine.warmWorkerSend).not.toHaveBeenCalled();
});

/**
 * 반대 방향: 준비가 **돌고 있는데** 배치가 시작하면, 준비는 그 자리서 접혀야
 * 한다 — 그리고 접힌 것은 "실패"가 아니라 "취소"다.
 *
 * 설계 9절이 못박은 지점이다. 접는 처리가 없으면 워커에 나가 있던 파일과 큐에
 * 남은 파일이 전부 실패로 적혀 *"준비하지 못한 파일 87개"* 같은 **가짜 오류
 * 카드**가 뜬다. 준비는 고장난 것이 아니라 자리를 내준 것이고, 남은 파일은
 * status가 "idle" 그대로라 현행 순차 경로가 이어받는다.
 *
 * 그래서 여기서는 warm.rs의 kill_all까지 흉내 낸다: 배치가 워커를 띄우는 그
 * 순간 이전 세대가 통째로 죽고, 그 exit이 준비 큐에 닿는다. 접힌 큐라면 그
 * 죽음은 아무 데도 안 적히고, 안 접혔다면 "worker died"가 파일 수만큼 쌓여
 * 카드가 뜬다.
 *
 * **흘리는 자리와 붙드는 핸들러가 이 테스트의 전부다.** 둘 중 하나만 어긋나도
 * 이 테스트는 아무 일도 없는 자리를 보고 "실패가 없다"고 말한다:
 *   - 붙들 것은 **준비 큐가 등록한** 구독이다. 배치도 워커를 쓰므로(BatchPanel의
 *     workers={cacheWorkers}) 같은 채널에 두 번째로 등록하는데, 마지막 것을 들면
 *     그 핸들러의 세대 필터(warmWorkers.ts)가 준비 세대(4)의 죽음을 통째로
 *     버린다 — 이벤트가 준비 큐에 닿지도 못한다.
 *   - 흘리는 자리는 **스폰 시점**이다. 접힌 것을 확인한 뒤에 흘리면 큐는 이미
 *     결과를 내놓은 뒤라 무엇을 흘려도 카드가 안 뜬다.
 */
test("a batch export starting mid-preparation folds the prepare queue as a cancel", async () => {
  engine.pathsExist.mockResolvedValue(PATHS.map(() => false));
  // BatchPanel도 프리셋 목록을 따로 읽는다 — 없으면 "배치 실행"이 비활성이다.
  vi.mocked(loadPresets).mockResolvedValueOnce([PRESET]);
  // 첫 등록 = 준비 큐의 것(아래에서 등록이 하나뿐임을 확인한다).
  let prepareExit: ((e: { generation: number; id: number }) => void) | undefined;
  engine.onWarmWorkerExit.mockImplementation(
    async (cb: (e: { generation: number; id: number }) => void) => {
      prepareExit ??= cb;
      return () => {};
    }
  );
  // 준비는 4세대, 배치는 5세대. 배치가 자기 세대를 띄우는 그 자리에서 warm.rs의
  // kill_all이 준비 세대를 죽인다.
  //
  // 죽음이 프런트에 **언제** 닿는지가 이 테스트의 시계다. 접는 일(batchRunning이
  // React 커밋을 타고 준비 효과에 닿는 것)은 프런트 안에서 끝나지만, 죽음은
  // 스폰 커맨드가 Rust를 왕복하고 프로세스를 죽였다 새로 띄운 **뒤에** Tauri
  // 이벤트로 온다 — 워커가 뜨는 데 초 단위가 걸려서 무소식 워치독이 30초인 것과
  // 같은 층이다. 그래서 실물에서는 접기가 크게 앞선다.
  //
  // 50ms는 그 층을 아주 보수적으로 줄여 잡은 값이다. 이 환경에서 접기까지
  // 재보면 스폰 호출로부터 4.8ms이므로 10배 여유가 있다. 0ms로 두면(= 스폰 바로
  // 다음 매크로태스크) 4.57ms 대 4.77ms로 사실상 동전 던지기가 되는데, 그것은
  // 실물이 아니라 jsdom의 스케줄러를 재는 것이다(그 실측은 리포트에 적었다).
  let killed = false;
  let starts = 0;
  engine.warmWorkersStart.mockImplementation(async () => {
    starts += 1;
    if (starts === 1) return { generation: 4, ids: [0, 1] };
    setTimeout(() => {
      prepareExit?.({ generation: 4, id: 0 });
      prepareExit?.({ generation: 4, id: 1 });
      killed = true;
    }, 50);
    return { generation: 5, ids: [0, 1] };
  });

  await renderWithPreset();
  setWorkers(2);
  await addFilesForPrepare();
  // 세 장 중 둘이 워커에 나가 있고 한 장은 큐에 남아 있다 — 준비가 한 장도
  // 끝내지 못한 상태에서 배치가 들어온다.
  await waitFor(() => expect(engine.warmWorkerSend.mock.calls.length).toBe(2));
  // 지금 등록은 하나뿐이므로 위에서 붙든 것은 준비 큐의 구독이다. 이 줄이
  // 없으면 배선이 바뀌었을 때 이 테스트가 조용히 빈 단언으로 돌아간다.
  expect(engine.onWarmWorkerExit).toHaveBeenCalledTimes(1);

  click(screen.getByRole("button", { name: "배치" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "전체 선택" })).toBeTruthy());
  click(screen.getByRole("button", { name: "전체 선택" }));
  await waitFor(() =>
    expect((screen.getByRole("button", { name: "배치 실행" }) as HTMLButtonElement).disabled).toBe(false)
  );
  click(screen.getByRole("button", { name: "배치 실행" }));

  // 배치가 자기 세대를 띄웠고(= kill_all), 준비 세대의 죽음이 실제로 흘렀다.
  // **접힌 것을 확인하고 흘리지 않는다** — 그러면 큐가 이미 결과를 내놓은 뒤라
  // 무엇을 흘려도 카드가 안 뜨고, 이 단언은 아무것도 재지 못한다.
  await waitFor(() => expect(engine.warmWorkersStart).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(killed).toBe(true));
  await new Promise((r) => setTimeout(r, 20));

  // **여기가 이 테스트의 심장이다.** 준비가 쥐고 있던 세 장은 실패가 아니다 —
  // 자리를 내준 것이지 고장난 것이 아니다.
  expect(screen.queryByText(/준비하지 못한 파일/)).toBeNull();
  // 그리고 실제로 접혔다: 워커를 놓고 진행 표시가 걷혔다.
  expect(engine.warmWorkersStop).toHaveBeenCalled();
  expect(screen.queryByText(/파일 준비 중/)).toBeNull();
  // 준비된 파일도 없다 — 한 장도 못 끝냈으므로 전부 현행 순차 경로의 몫이다.
  expect(screen.queryAllByText("열림")).toHaveLength(0);
});

/**
 * 반대 방향: 파일 준비가 도는 중에 "전체 캐시"를 누르면, 스윕은 준비가 끝날
 * 때까지 기다렸다 스스로 이어서 시작한다(사람이 다시 누를 필요가 없다) — 설계
 * 6.2가 "선점"이 아니라 "대기 후 인계"를 고른 이유는 사용자가 누르고 자리를
 * 떠도 되게 하기 위해서다.
 *
 * 즉시 출발하면 워커 스폰(warmWorkersStart)이 이전 세대를 죽이므로(warm.rs의
 * kill_all) 준비하던 작업 프로세스가 몰살당하고, 그때 워커에 나가 있던 파일
 * (워커 수만큼)은 결과가 안 온 채로 버려져 나중에 처음부터 다시 디코드된다.
 *
 * **그래서 이 테스트는 버튼 문구가 아니라 워커에 나간 잡으로 잰다.** 문구만
 * 재면 "누르는 순간 준비를 접고 곧바로 출발하는" 구현도 통과한다(3159f55가
 * 그랬다: 문구는 한 프레임 떴다가 사라졌고 스윕은 100ms 안에 나갔다).
 */
test("the full cache waits for file preparation, then takes over", async () => {
  // 워커 셋을 매핑해 목록 셋(PATHS)이 당겨 가기 없이 한 번에 나가게 한다 —
  // "몇 장이 남았나"의 레이스(로드 큐가 다음 파일을 이미 집어 갔는지)를
  // 비켜서기 위해서다(위 addFilesForPrepare 주석 참고: 준비가 먼저 서야
  // 로드 큐가 아예 손을 안 댄다).
  const finish = captureWorkerLines(5, [0, 1, 2]);

  await renderWithPreset();
  setWorkers(2);
  await addFilesForPrepare();
  // 준비 큐가 목록 전체(세 장)를 집는다.
  await waitFor(() => expect(engine.warmWorkerSend.mock.calls.length).toBe(3));

  click(screen.getByRole("button", { name: "전체 캐시" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "파일 준비 후 시작" })).toBeTruthy());

  // **여기가 이 테스트의 심장이다.** 버튼 문구 한 프레임이 아니라, 넉넉히
  // 기다린 뒤에도 스윕이 한 발도 안 나가 있어야 한다. 문구만 재면 "누르는 순간
  // 준비를 접고 곧바로 출발하는" 구현도 통과한다 — 그때는 대기가 아니라
  // 선점이고, 워커에 나가 있던 파일 몇 장이 통째로 버려져 나중에 다시
  // 디코드된다(그렇게 3159f55가 통과했다).
  await new Promise((r) => setTimeout(r, 200));
  expect(sweepJobs()).toHaveLength(0);
  // 워커 무리는 준비가 띄운 그 한 세대뿐이다. 스윕이 출발했다면 여기가 2다 —
  // 그리고 그 스폰이 warm.rs의 kill_all로 준비 프로세스를 몰살했을 것이다.
  expect(engine.warmWorkersStart).toHaveBeenCalledTimes(1);
  // 준비가 쥔 세 장은 아직 한 장도 결과를 못 냈다(결과가 오면 "열림"이 된다).
  // 즉 지금까지 기다린 것은 "이미 끝난 준비"가 아니다.
  expect(screen.queryAllByText("열림")).toHaveLength(0);
  // 대기가 한 틱 만에 풀리지도 않았다 — 버튼은 여전히 대기를 말한다.
  expect(screen.getByRole("button", { name: "파일 준비 후 시작" })).toBeTruthy();

  // 준비가 **실제로** 끝나면(쥐고 있던 세 장이 모두 결과를 돌려주면) 효과가
  // 다시 돌아 스윕이 스스로 이어진다 — 사람이 버튼을 다시 누르지 않는다.
  for (const call of engine.warmWorkerSend.mock.calls.slice(0, 3)) {
    finish(call as [number, { path: string }], preparedResult([1]));
  }
  await waitFor(() => expect(screen.queryAllByText("열림")).toHaveLength(3));

  await waitFor(() => expect(sweepJobs().length).toBeGreaterThan(0));
  // 그리고 그때 버튼은 "캐시 중지"다 — 대기가 아니라 진짜로 도는 중이다.
  await waitFor(() => expect(screen.getByRole("button", { name: "캐시 중지" })).toBeTruthy());
  // 가짜 오류 카드가 뜨면 안 된다 — 대기는 실패가 아니다.
  expect(screen.queryByText(/준비하지 못한 파일/)).toBeNull();
});

/**
 * 대기 상태에서 버튼을 다시 누르면 **요청만** 내려간다. 준비는 계속 돈다 —
 * 스윕 요청을 접는 것과 준비를 죽이는 것은 다른 일이고, 여기서 준비까지
 * 죽이면 워커에 나가 있던 파일이 통째로 버려진다.
 */
test("pressing the queued full cache button cancels the wait, not the preparation", async () => {
  const finish = captureWorkerLines(5, [0, 1, 2]);

  await renderWithPreset();
  setWorkers(2);
  await addFilesForPrepare();
  await waitFor(() => expect(engine.warmWorkerSend.mock.calls.length).toBe(3));

  click(screen.getByRole("button", { name: "전체 캐시" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "파일 준비 후 시작" })).toBeTruthy());
  click(screen.getByRole("button", { name: "파일 준비 후 시작" }));
  // 요청이 내려가 버튼이 처음 자리로 돌아온다.
  await waitFor(() => expect(screen.getByRole("button", { name: "전체 캐시" })).toBeTruthy());

  // 준비는 살아 있다: 워커에 나가 있던 세 장이 그대로 결과를 낸다.
  for (const call of engine.warmWorkerSend.mock.calls.slice(0, 3)) {
    finish(call as [number, { path: string }], preparedResult([1]));
  }
  await waitFor(() => expect(screen.queryAllByText("열림")).toHaveLength(3));
  // 요청을 접었으므로 준비가 끝나도 스윕은 출발하지 않는다.
  await new Promise((r) => setTimeout(r, 50));
  expect(sweepJobs()).toHaveLength(0);
});

/**
 * "중지"는 준비에도 닿는다 — 준비는 "여는 중"을 워커로 옮긴 것이라 사용자가
 * 진행바에서 멈추라고 한 바로 그 일이다. 전체 캐시(요청)와 갈리는 지점이다:
 * 이쪽은 돌던 회차를 그 자리에서 접는다.
 */
test("중지 stops file preparation where it stands", async () => {
  captureWorkerLines(5, [0, 1, 2]);

  await renderWithPreset();
  setWorkers(2);
  await addFilesForPrepare();
  await waitFor(() => expect(engine.warmWorkerSend.mock.calls.length).toBe(3));
  // 진행바 라벨은 "파일 준비 중... 0/3" 꼴이라 부분 일치로 잡는다.
  await waitFor(() => expect(screen.getByText(/파일 준비 중/)).toBeTruthy());

  click(screen.getByRole("button", { name: "중지" }));

  // 워커 무리가 거둬지고 진행 표시가 내려간다.
  await waitFor(() => expect(engine.warmWorkersStop).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByText(/파일 준비 중/)).toBeNull());
});

/**
 * 이 테스트가 이 기능의 심장이다: 워커가 구운 그림이 **화면이 나중에 만들 키**에
 * 담겨야 한다. 어긋나면 워커가 100장을 구워도 클릭마다 다시 합성한다 — 오류
 * 한 줄 없이 기능이 통째로 사라지는 고장이다.
 *
 * 키를 눈으로 대조하지 않고 **앱이 스스로 찾게 한다**: 프로젝트 저장은 화면
 * 상태에서 키를 다시 계산해(buildProject → previewRenderSpec, 캔버스가 쓰는 것과
 * 같은 함수·같은 입력) 캐시를 조회하고, 맞았을 때만 그림을 담는다.
 */
test("a prepared preview lands under the key the app looks up later", async () => {
  const finish = captureWorkerLines(9, [0, 1]);
  vi.mocked(saveDialog).mockResolvedValue("/proj/새작업.bwproj" as never);

  await renderWithPreset();
  setWorkers(2);
  await addFilesForPrepare();
  await waitFor(() => expect(engine.warmWorkerSend.mock.calls.length).toBe(2));

  const call = engine.warmWorkerSend.mock.calls[0] as [number, { path: string }];
  const prepared = call[1].path;
  finish(call, preparedResult([1], "/tmp/prepared.png"));
  await waitFor(() => expect(screen.queryAllByText("열림").length).toBeGreaterThanOrEqual(1));
  await new Promise((r) => setTimeout(r, 20));

  click(screen.getByRole("button", { name: "프로젝트 저장" }));
  await waitFor(() => expect(saveProjectTo).toHaveBeenCalled());

  const [, saved, previews] = vi.mocked(saveProjectTo).mock.calls[0];
  const entry = saved.files.find((f) => f.path === prepared);
  // 갓 준비한 파일의 상태: 포함 = 매칭 결과, 눈·솔로·수동 지정 없음.
  const expected = previewRenderSpec(
    { path: prepared, mtime: 1 },
    treeOf([1, 2, 3]) as never,
    [1], [], [],
    PRESET.lineColor,
    [1],
    PRESET.edgeLines,
    []
  );
  expect(entry?.previewKey).toBe(expected.key);
  expect(entry?.previewFile).toBeTruthy();
  expect(previews.get(entry!.previewFile!)).toBe("data:image/png;base64,AAA");
});

/**
 * 준비된 파일의 눈(previewHiddenIds)은 **정상 경로와 같아야 한다** — 포토샵에서
 * 아티스트가 꺼둔 레이어는 준비된 판에서도 꺼져 있어야 한다. 그리고 스스로
 * 고쳐지지 않는다: 나중에 세션이 붙어도(sessionRefreshed) 그 액션은 opsByPath를
 * 일부러 안 건드린다.
 *
 * 같은 자리에서 캐시 키의 반대편도 잠근다. 워커의 _preset_preview_args는 매칭된
 * 픽셀 잎을 **눈과 무관하게 전부** 그리므로(engine/psd_engine/warmworker.py),
 * 매칭된 잎 중 꺼진 것이 있으면 워커의 그림과 화면이 그릴 그림이 다르다 — 그때
 * 그 PNG를 화면의 키에 담으면 아티스트는 안 그려질 레이어까지 그려진 그림으로
 * 설정을 확인하게 된다. 담지 않는 것이 옳다.
 */
test("a prepared file hides what Photoshop had hidden, and its preview is not cached under a different picture", async () => {
  const finish = captureWorkerLines(9, [0, 1]);
  vi.mocked(saveDialog).mockResolvedValue("/proj/새작업.bwproj" as never);

  await renderWithPreset();
  setWorkers(2);
  await addFilesForPrepare();
  await waitFor(() => expect(engine.warmWorkerSend.mock.calls.length).toBe(2));

  const call = engine.warmWorkerSend.mock.calls[0] as [number, { path: string }];
  const prepared = call[1].path;
  // 잎 2는 포토샵에서 꺼져 있고, 프리셋은 1과 2를 잡았다.
  const tree = [...treeOf([1]), ...treeOf([2], false), ...treeOf([3])];
  finish(call, { ...preparedResult([1, 2], "/tmp/prepared.png"), tree });
  await waitFor(() => expect(screen.queryAllByText("열림").length).toBeGreaterThanOrEqual(1));
  await new Promise((r) => setTimeout(r, 20));

  click(screen.getByRole("button", { name: "프로젝트 저장" }));
  await waitFor(() => expect(saveProjectTo).toHaveBeenCalled());

  const [, saved, previews] = vi.mocked(saveProjectTo).mock.calls[0];
  const entry = saved.files.find((f) => f.path === prepared);
  expect(entry?.ops.previewHiddenIds).toEqual([2]);
  // 키는 화면이 그릴 그림(잎 1뿐)을 가리키고, 워커가 구운 그림은 담기지 않았다.
  const expected = previewRenderSpec(
    { path: prepared, mtime: 1 },
    tree as never,
    [1, 2], [2], [],
    PRESET.lineColor,
    [1, 2],
    PRESET.edgeLines,
    []
  );
  expect(entry?.previewKey).toBe(expected.key);
  expect(entry?.previewFile).toBeFalsy();
  expect(previews.size).toBe(0);
});

test("the warmup chain shows leaf-level progress while it runs", async () => {
  // 배경에서 몇 분씩 도는 일이 화면에 안 보이면 사용자는 앱이 멈췄다고 보고
  // 아무거나 누른다 — 그때마다 워밍업은 비켜서느라 더 안 끝난다. 그래서 이
  // 진행 표시는 장식이 아니라 기능이다. 첫 요청을 잡아 두고 막대가 떠 있는지,
  // 체인이 다 돌면 사라지는지 본다.
  const deferrals: ((v: { warmed: number[]; skipped: number[]; remaining: number[] }) => void)[] = [];
  const defer = () => new Promise<never>((r) => deferrals.push(r as never));
  engine.warmPreviewTiles.mockImplementationOnce(defer).mockImplementationOnce(defer);
  render(<App />);
  await addFiles({ click });
  await finishOpen(0, 1);
  await finishOpen(1, 2);
  await finishOpen(2, 3);

  // 1단계는 **활성 파일의 라인만** 센다(픽스처의 잎 셋은 전부 "line N"이다).
  // 파일 단위로 세면 큰 파일에서 몇 분씩 안 움직여 "멈췄다"로 읽히므로 잎
  // 단위다. 문구는 전체 캐시("전체 캐시 만드는 중")와 달라야 한다 — 같으면
  // 파일 전환마다 뜨는 이 짧은 표시가 "전체 캐시가 안 됐다"로 읽힌다.
  await waitFor(() => expect(screen.getByText(/라인 준비 중\.\.\. 0\/3/)).toBeTruthy());

  // 라인이 끝나면 문구가 바뀐다. 여기부터는 다음 파일을 데우는 뒷정리라
  // 기다릴 필요가 없고, 그 사실이 화면에 드러나야 아티스트가 막대 끝까지
  // 기다리지 않는다(2026-08-13 아티스트와 정한 표시 방식).
  deferrals[0]({ warmed: [1, 2, 3], skipped: [], remaining: [] });
  await waitFor(() => expect(screen.getByText(/나머지 레이어 준비 중\.\.\. 0\/3/)).toBeTruthy());

  deferrals[1]({ warmed: [1, 2, 3], skipped: [], remaining: [] });
  await waitFor(() => expect(screen.queryByText(/준비 중/)).toBeNull());
});

test("the warmup warms the active file's lines before anything else", async () => {
  // 순서가 이 기능의 전부다. 라인이 뒤로 밀리면 문구만 둘로 나뉘고 아티스트가
  // 기다리는 시간은 그대로다.
  const deferrals: ((v: { warmed: number[]; skipped: number[]; remaining: number[] }) => void)[] = [];
  engine.warmPreviewTiles.mockImplementation(
    () => new Promise<never>((r) => deferrals.push(r as never))
  );
  render(<App />);
  await addFiles({ click });
  // 활성 파일의 잎 넷 중 라인은 둘(2, 4)뿐이다.
  opens[0].d.resolve({
    sessionId: 1,
    width: 10,
    height: 10,
    colorMode: "RGB",
    depth: 8,
    mtime: 1,
    tree: [
      { ...treeOf([1])[0], name: "fill 1" },
      treeOf([2])[0],
      { ...treeOf([3])[0], name: "grain 3" },
      treeOf([4])[0],
    ],
  });
  await waitFor(() => expect(screen.queryAllByText("열림").length).toBeGreaterThanOrEqual(1));
  // 워밍업 체인은 로드 큐가 다 끝난 뒤에야 돈다.
  await finishOpen(1, 2);
  await finishOpen(2, 3);

  await waitFor(() => expect(engine.warmPreviewTiles).toHaveBeenCalled());
  // 첫 요청에 라인 둘만 실려 나간다 — fill·grain은 2단계로 밀린다.
  expect(engine.warmPreviewTiles.mock.calls[0][1]).toEqual([2, 4]);
  await waitFor(() => expect(screen.getByText(/라인 준비 중\.\.\. 0\/2/)).toBeTruthy());
});

/**
 * "후보 일괄 지정" — 프리셋이 라인을 못 잡은 파일(군중 실루엣 판)을 버튼 한
 * 번으로 내보낼 수 있는 상태로 만든다. 규칙과 측정 근거는 lib/suggestLines.ts.
 * 지정은 setManualLine과 같은 액션이라 이후의 미리보기·내보내기·저장은 일반
 * 수동 지정과 같은 길을 탄다.
 */
test("bulk-apply turns a needs-line file into exportable entries", async () => {
  vi.mocked(loadPresets).mockResolvedValueOnce([PRESET]);
  engine.applyPreset.mockResolvedValue({ matchedLayerIds: [], operations: [] });

  render(<App />);
  await addFiles({ click });
  await finishOpen(0, 1);

  // 매칭 0 → 배지와 일괄 지정 막대가 함께 뜬다.
  await waitFor(() => expect(screen.getByText("라인필요 1개")).toBeTruthy());
  expect(screen.getByText("라인필요")).toBeTruthy();

  click(screen.getByText("후보 일괄 지정"));

  // treeOf의 픽셀 잎 셋이 전부 후보다(merge 없음 → 3장). 배지와 막대는 함께
  // 사라진다 — 막대가 남아 있다면 후보를 못 찾은 파일이 남았다는 뜻이어야 한다.
  await waitFor(() => expect(screen.getByText("3장")).toBeTruthy());
  expect(screen.queryByText("라인필요")).toBeNull();
  expect(screen.queryByText("후보 일괄 지정")).toBeNull();
});
