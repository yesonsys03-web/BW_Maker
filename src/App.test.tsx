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
import { PreviewCanvas } from "./components/PreviewCanvas";
import { PreviewCache } from "./lib/previewCache";

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
