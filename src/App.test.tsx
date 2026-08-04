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

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

import { open as openDialog } from "@tauri-apps/plugin-dialog";
import App from "./App";

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

function treeOf(ids: number[]) {
  return ids.map((id) => ({
    id,
    name: `line ${id}`,
    kind: "pixel",
    visible: true,
    opacity: 255,
    blendMode: "normal",
    bbox: [0, 0, 10, 10],
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
async function finishOpen(index: number, sessionId: number, ids = [1, 2, 3]) {
  opens[index].d.resolve({
    sessionId,
    width: 10,
    height: 10,
    colorMode: "RGB",
    depth: 8,
    tree: treeOf(ids),
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
