// @vitest-environment jsdom
/**
 * PreviewCanvas — 같은 그림을 다시 걸었을 때 화면에서 사라지지 않는지.
 *
 * 실사고(2026-08-12): 이미 체크된 레이어를 L(라인으로 지정)로 지정하면
 * includedIds가 **내용은 같고 정체만 새 배열**이 된다. 렌더 효과가 다시 돌아
 * 같은 캐시 키에 적중해 지금 화면의 dataUrl을 그대로 다시 걸었고 — src가 안
 * 바뀌면 <img>의 onLoad가 다시 오지 않으므로, "배율 정해질 때까지 감춤"
 * (fitReady)을 풀어 줄 사건이 없어 그림이 사라진 채 남았다. 레이어를 다시
 * 토글해야(조합이 진짜로 바뀌어 새 onLoad가 와야) 돌아왔다.
 */
import { fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

vi.mock("../lib/engine", () => ({
  loadPngDataUrl: vi.fn(async () => "data:image/png;base64,unused"),
  renderDocumentPreview: vi.fn(async () => ({ pngPath: "/tmp/doc.png" })),
  renderImageLinePreview: vi.fn(async () => ({ pngPath: "/tmp/image-line.png", maskHash: "mask" })),
  renderPreview: vi.fn(async () => ({ pngPath: "/tmp/preview.png" })),
}));

import { renderImageLinePreview, renderPreview } from "../lib/engine";
import { PreviewCanvas } from "./PreviewCanvas";
import { PreviewCache, previewCacheKey } from "../lib/previewCache";
import type { TreeNode } from "../lib/types";

beforeEach(() => {
  // 이 환경의 jsdom localStorage는 껍데기라 getItem이 없다(App.test와 같은 대역).
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

const leaf = (id: number, name: string): TreeNode => ({
  id, name, kind: "pixel", visible: true, blendMode: "normal", opacity: 255,
  bbox: [0, 0, 8, 8], hasMask: false, path: [name],
});

// LINE만 체크된 화면 — 파일을 연 직후(둘 다 보임)와 달라 문서 보기가 아니다.
const TREE: TreeNode[] = [leaf(0, "LINE"), leaf(1, "FILL")];
const CACHED_URL = "data:image/png;base64,SAME_PICTURE";

function props(includedIds: number[], cache: PreviewCache) {
  return {
    sessionId: 7,
    path: "/컷/a.psd",
    mtime: 111,
    status: "open" as const,
    tree: TREE,
    includedIds,
    previewHiddenIds: [],
    soloIds: [],
    lineColor: null,
    matchedIds: [0],
    edgeLines: null,
    edgeColourIds: [],
    paused: false,
    cache,
    onRenderingChange: () => {},
    onSessionRefreshed: () => {},
    onError: vi.fn(),
  };
}

test("re-showing the same cached picture does not blank the preview", async () => {
  const cache = new PreviewCache();
  const key = previewCacheKey(
    { path: "/컷/a.psd", mtime: 111 }, false, [0], null, [0], null, [], [0]
  )!;
  cache.set(key, CACHED_URL);

  const view = render(<PreviewCanvas {...props([0], cache)} />);
  const img = await waitFor(() => {
    const el = view.container.querySelector("img");
    if (!el) throw new Error("아직 그림이 없다");
    return el;
  });
  fireEvent.load(img);
  expect(img.style.visibility).toBe("visible");

  // 같은 내용, 새 배열 — L 지정이 includedIds에 만드는 정확히 그 변화.
  // 같은 캐시 키에 적중해 같은 dataUrl이 다시 걸리는데, 그림은 그대로
  // 보이는 채여야 한다(onLoad는 다시 오지 않는다 — 여기서도 일부러 다시
  // fireEvent.load를 하지 않는다).
  view.rerender(<PreviewCanvas {...props([...[0]], cache)} />);
  const after = view.container.querySelector("img");
  expect(after).toBeTruthy();
  expect(after!.src).toBe(CACHED_URL);
  expect(after!.style.visibility).toBe("visible");
});

test("a session arriving after a cache-miss click sends the parked render", async () => {
  // 부류 2("합성 중..."에서 멈춤)의 정체 — 2026-08-20 preview-trace로 확정:
  // 준비된 파일을 갓 클릭하면 세션이 아직 없다. 캐시 미스면 dispatch가 세션
  // 없음으로 조용히 포기했고, 렌더 효과는 일부러 세션에 의존하지 않으므로
  // 세션이 도착해도 다시 내지 않았다 — 레이어를 토글해야(효과가 다시 돌아야)
  // 그려졌다. 세션 도착이 대기분을 내보내야 한다.
  vi.mocked(renderPreview).mockClear();
  const cache = new PreviewCache();
  const p = props([0], cache);
  const view = render(<PreviewCanvas {...p} sessionId={undefined} />);
  await new Promise((r) => setTimeout(r, 0));
  expect(renderPreview).not.toHaveBeenCalled(); // 세션이 없어 못 낸다 — 여기까진 같다
  view.rerender(<PreviewCanvas {...p} sessionId={7} />); // 세션 도착
  await waitFor(() => expect(renderPreview).toHaveBeenCalledTimes(1));
});

test("imageLine mode uses the dedicated full-document renderer", async () => {
  vi.mocked(renderImageLinePreview).mockClear();
  vi.mocked(renderPreview).mockClear();
  const cache = new PreviewCache();
  render(
    <PreviewCanvas
      {...props([0, 1], cache)}
      imageLine={{
        enabled: true, version: 1, darkThreshold: 128,
        boundaryThreshold: 32, minLength: 8, width: 1,
      }}
    />
  );
  await waitFor(() => expect(renderImageLinePreview).toHaveBeenCalledTimes(1));
  expect(renderPreview).not.toHaveBeenCalled();
});

test("a selected file waiting for its session says opening, not select-a-file", () => {
  // 세션이 붙는 몇 초 동안 "왼쪽에서 파일을 선택하세요"가 떠서 사용자가 두 번
  // 헷갈렸다(2026-08-20) — 선택된 파일이면 "여는 중..."이 맞는 말이다.
  const cache = new PreviewCache();
  const p = props([0], cache);
  const view = render(<PreviewCanvas {...p} sessionId={undefined} />);
  view.getByText("여는 중...");
  view.rerender(
    <PreviewCanvas {...p} sessionId={undefined} path={undefined} mtime={undefined}
                   status={undefined} tree={undefined} />
  );
  view.getByText("왼쪽에서 파일을 선택하세요.");
});
