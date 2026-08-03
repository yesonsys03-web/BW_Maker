import { expect, test } from "vitest";
import { PreviewCache, previewCacheKey, previewRenderSpec } from "./previewCache";
import type { TreeNode } from "./types";

const F1 = { path: "/a.psd", mtime: 100 };
const F2 = { path: "/b.psd", mtime: 100 };
const F4 = { path: "/a.psd", mtime: 400 };
const F7 = { path: "/a.psd", mtime: 700 };

const pixel = (id: number, visible = true): TreeNode => ({
  id,
  name: `line${id}`,
  kind: "pixel",
  visible,
  blendMode: "normal",
  opacity: 100,
  bbox: [0, 0, 10, 10],
  hasMask: false,
  path: [`line${id}`],
});

// 화면에 띄우는 쪽(PreviewCanvas)과 미리 만들어 두는 쪽(App의 준비 큐)이 이
// 함수를 함께 쓴다. 두 곳이 각자 계산하면 키가 어긋나 준비해둔 그림을 못 찾고,
// 증상은 "미리 만들어 뒀는데도 클릭하면 또 합성한다"로 나타난다.
test("the spec's key is the key for the visible set it computed", () => {
  const tree = [pixel(1), pixel(2), pixel(3)];

  const spec = previewRenderSpec(F7, tree, [1, 3], [3], "#000000");

  expect(spec.visibleIds).toEqual([1]);
  expect(spec.key).toBe(previewCacheKey(F7, spec.documentView, [1], "#000000"));
});

test("a partial line selection is a composite, not the stored document image", () => {
  const tree = [pixel(1), pixel(2)];
  expect(previewRenderSpec(F1, tree, [1], [], null).documentView).toBe(false);
});

test("every originally-visible layer showing means the stored document image", () => {
  const tree = [pixel(1), pixel(2)];
  expect(previewRenderSpec(F1, tree, [1, 2], [], null).documentView).toBe(true);
});

test("the same file state always plans the same key", () => {
  const tree = [pixel(1), pixel(2)];
  const a = previewRenderSpec(F4, tree, [1, 2], [2], null);
  const b = previewRenderSpec(F4, [pixel(1), pixel(2)], [1, 2], [2], null);
  expect(a.key).toBe(b.key);
});

test("the same render inputs produce the same key", () => {
  expect(previewCacheKey(F1, false, [3, 1, 2], "#000000")).toBe(previewCacheKey(F1, false, [3, 1, 2], "#000000"));
});

// 이 캐시가 존재하는 이유. 엔진 세션은 LRU(2개)에 밀려 수시로 새로 열리는데,
// 그때마다 키가 달라지면 애써 만든 그림이 통째로 버려진다 — 세션 id로 키를
// 잡았을 때 실제로 그랬고, 증상은 "다른 파일 갔다 오면 또 합성한다"였다.
test("the same file keeps its key however many times its session is reopened", () => {
  const before = previewCacheKey({ path: "/a.psd", mtime: 100 }, false, [1, 2], null);
  const afterReopen = previewCacheKey({ path: "/a.psd", mtime: 100 }, false, [1, 2], null);
  expect(afterReopen).toBe(before);
});

// 반대쪽 보장. 아티스트가 포토샵에서 저장하면 그림이 달라지므로 다시 그려야 한다.
test("a file saved since the render gets a different key", () => {
  const before = previewCacheKey({ path: "/a.psd", mtime: 100 }, false, [1, 2], null);
  const afterSave = previewCacheKey({ path: "/a.psd", mtime: 200 }, false, [1, 2], null);
  expect(afterSave).not.toBe(before);
});

test("without a known mtime there is no key, so nothing is reused unverified", () => {
  expect(previewCacheKey({ path: "/a.psd" }, false, [1], null)).toBeNull();
  expect(previewRenderSpec({ path: "/a.psd" }, [pixel(1)], [1], [], null).key).toBeNull();
});

test("every other input that changes the rendered image changes the key", () => {
  const base = previewCacheKey(F1, false, [1, 2], "#000000");
  expect(previewCacheKey(F2, false, [1, 2], "#000000")).not.toBe(base); // 다른 파일
  expect(previewCacheKey(F1, true, [1, 2], "#000000")).not.toBe(base); // 문서 보기
  expect(previewCacheKey(F1, false, [1, 3], "#000000")).not.toBe(base); // 다른 레이어
  expect(previewCacheKey(F1, false, [1, 2], null)).not.toBe(base); // 라인 색 없음
});

test("layer order matters — the engine stacks them in the order it is given", () => {
  expect(previewCacheKey(F1, false, [1, 2], null)).not.toBe(previewCacheKey(F1, false, [2, 1], null));
});

test("one file's image is never served for another", () => {
  const cache = new PreviewCache();
  cache.set(previewCacheKey(F1, false, [1], null)!, "data:a");
  expect(cache.get(previewCacheKey(F2, false, [1], null)!)).toBeUndefined();
});

test("a stored image comes back for the same key", () => {
  const cache = new PreviewCache();
  const key = previewCacheKey(F1, false, [1], null)!;
  cache.set(key, "data:png");
  expect(cache.get(key)).toBe("data:png");
});

test("a miss is undefined, not an empty string", () => {
  expect(new PreviewCache().get("nope")).toBeUndefined();
});

test("the budget evicts the least recently used entry", () => {
  const cache = new PreviewCache(20);
  cache.set("a", "0123456789"); // 10
  cache.set("b", "0123456789"); // 20 — 아직 예산 안
  cache.set("c", "0123456789"); // 30 > 20 → 가장 오래된 a를 버린다
  expect(cache.get("a")).toBeUndefined();
  expect(cache.get("b")).toBe("0123456789");
  expect(cache.get("c")).toBe("0123456789");
});

test("reading an entry protects it from the next eviction", () => {
  const cache = new PreviewCache(20);
  cache.set("a", "0123456789");
  cache.set("b", "0123456789");
  cache.get("a"); // a를 최근 사용으로 올린다
  cache.set("c", "0123456789");
  expect(cache.get("a")).toBe("0123456789");
  expect(cache.get("b")).toBeUndefined();
});

test("re-storing a key does not double-count it against the budget", () => {
  const cache = new PreviewCache(20);
  cache.set("a", "0123456789");
  cache.set("a", "9876543210");
  cache.set("b", "0123456789");
  // 두 항목의 합이 정확히 20이므로 아무것도 버려지지 않아야 한다.
  expect(cache.get("a")).toBe("9876543210");
  expect(cache.get("b")).toBe("0123456789");
});

test("an entry larger than the whole budget is still kept — it is what the screen needs now", () => {
  const cache = new PreviewCache(5);
  cache.set("big", "0123456789");
  expect(cache.get("big")).toBe("0123456789");
  expect(cache.size).toBe(1);
});
