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
  renderPreview: vi.fn(async () => ({ pngPath: "/tmp/preview.png" })),
}));

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
