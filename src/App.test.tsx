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
import App from "./App";
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
    colourMode: "composite" as const, edgeMode: "region" as const,
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
  vi.mocked(openDialog).mockResolvedValue(PATHS as never);
});

// vitest의 globals를 켜지 않았으므로 자동 정리가 걸리지 않는다. 남겨두면
// 다음 테스트가 이전 화면의 버튼까지 같이 찾는다.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

/**
 * 프로젝트 배선(Task 6). 여기서 잠그는 것은 전부 "테스트는 초록불인데 아티스트의
 * 작업이 조용히 사라지는" 경로다 — 이 기능에서 그런 문이 지금까지 여섯 나왔다.
 */
const RESTORED = "/cuts/restored.psd";

/** 저장된 프로젝트 항목 하나. previewKey는 실제 키 함수로 만든다(대조가 맞아야 한다). */
function projectWithOnePreview(): { project: ProjectFile; previews: Map<string, string>; key: string; previewFile: string } {
  const tree = treeOf([1, 2]);
  const ops = {
    includedIds: [1, 2], previewHiddenIds: [], soloIds: [], edgeColourIds: [],
    manualLineIds: [], ops: [],
    // 손으로 병합한 결과. 프리셋을 다시 걸면 사라지므로 "1장"이 남아 있다는 것이
    // 곧 복원한 편집이 살아남았다는 증거다.
    entries: [{ entryId: -1, sourceIds: [1, 2], name: "MERGED" }],
  };
  // 앱에는 선택된 프리셋이 없으므로(loadPresets가 []) 색·경계선은 양쪽 다 null이다.
  const plan = previewRenderSpec(
    { path: RESTORED, mtime: 1700 }, tree as never,
    ops.includedIds, ops.previewHiddenIds, ops.soloIds, null, [1, 2], null, ops.edgeColourIds
  );
  const key = plan.key!;
  const previewFile = previewFileName(key);
  const entry: ProjectEntry = {
    path: RESTORED, mtime: 1700, tree: tree as never, matchedIds: [1, 2],
    ops: ops as never, previewKey: key, previewFile,
  };
  return {
    project: { version: 1, preset: null, files: [entry] },
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
  engine.psdMtimes.mockResolvedValue({ [RESTORED]: 1700 });
  vi.mocked(openDialog).mockResolvedValue("/proj/작업.bwproj" as never);

  click(screen.getByRole("button", { name: "프로젝트 열기..." }));
  // ProjectBar가 폴더 이름을 보이면 handleProjectOpen이 끝까지 갔다는 뜻이다.
  await waitFor(() => expect(screen.getByText("작업.bwproj")).toBeTruthy());
  return fixture;
}

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
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe(other.name)
  );

  const fixture = projectWithOnePreview();
  fixture.project.preset = PRESET as never;
  await openProject(fixture);

  await waitFor(() =>
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe(PRESET.name)
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
