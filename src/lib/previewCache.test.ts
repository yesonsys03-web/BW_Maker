import { expect, test } from "vitest";
import {
  PreviewCache,
  lineColorIdsFor,
  needsPrefetch,
  previewCacheKey,
  previewRenderSpec,
} from "./previewCache";
import type { EdgeLines, TreeNode } from "./types";

const F1 = { path: "/a.psd", mtime: 100 };
const F2 = { path: "/b.psd", mtime: 100 };
const F4 = { path: "/a.psd", mtime: 400 };
const F7 = { path: "/a.psd", mtime: 700 };

/** 색 경계선 생성이 켜진 설정. 꺼짐(null)과의 키 차이를 확인하는 데만 쓴다. */
const EDGE_ON: EdgeLines = { enabled: true, threshold: 24, gap: 4, width: 5, minLength: 8, lineAlpha: 64 };

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

  const spec = previewRenderSpec(F7, tree, [1, 3], [3], [], "#000000", undefined, null);

  expect(spec.visibleIds).toEqual([1]);
  expect(spec.key).toBe(previewCacheKey(F7, spec.documentView, [1], "#000000", undefined, null));
});

test("a partial line selection is a composite, not the stored document image", () => {
  const tree = [pixel(1), pixel(2)];
  expect(previewRenderSpec(F1, tree, [1], [], [], null, undefined, null).documentView).toBe(false);
});

test("every originally-visible layer showing means the stored document image", () => {
  const tree = [pixel(1), pixel(2)];
  expect(previewRenderSpec(F1, tree, [1, 2], [], [], null, undefined, null).documentView).toBe(true);
});

test("the same file state always plans the same key", () => {
  const tree = [pixel(1), pixel(2)];
  const a = previewRenderSpec(F4, tree, [1, 2], [2], [], null, undefined, null);
  const b = previewRenderSpec(F4, [pixel(1), pixel(2)], [1, 2], [2], [], null, undefined, null);
  expect(a.key).toBe(b.key);
});

test("the same render inputs produce the same key", () => {
  expect(previewCacheKey(F1, false, [3, 1, 2], "#000000", undefined, null)).toBe(previewCacheKey(F1, false, [3, 1, 2], "#000000", undefined, null));
});

// 이 캐시가 존재하는 이유. 엔진 세션은 LRU(2개)에 밀려 수시로 새로 열리는데,
// 그때마다 키가 달라지면 애써 만든 그림이 통째로 버려진다 — 세션 id로 키를
// 잡았을 때 실제로 그랬고, 증상은 "다른 파일 갔다 오면 또 합성한다"였다.
test("the same file keeps its key however many times its session is reopened", () => {
  const before = previewCacheKey({ path: "/a.psd", mtime: 100 }, false, [1, 2], null, undefined, null);
  const afterReopen = previewCacheKey({ path: "/a.psd", mtime: 100 }, false, [1, 2], null, undefined, null);
  expect(afterReopen).toBe(before);
});

// 반대쪽 보장. 아티스트가 포토샵에서 저장하면 그림이 달라지므로 다시 그려야 한다.
test("a file saved since the render gets a different key", () => {
  const before = previewCacheKey({ path: "/a.psd", mtime: 100 }, false, [1, 2], null, undefined, null);
  const afterSave = previewCacheKey({ path: "/a.psd", mtime: 200 }, false, [1, 2], null, undefined, null);
  expect(afterSave).not.toBe(before);
});

test("without a known mtime there is no key, so nothing is reused unverified", () => {
  expect(previewCacheKey({ path: "/a.psd" }, false, [1], null, undefined, null)).toBeNull();
  expect(previewRenderSpec({ path: "/a.psd" }, [pixel(1)], [1], [], [], null, undefined, null).key).toBeNull();
});

test("every other input that changes the rendered image changes the key", () => {
  const base = previewCacheKey(F1, false, [1, 2], "#000000", undefined, null);
  expect(previewCacheKey(F2, false, [1, 2], "#000000", undefined, null)).not.toBe(base); // 다른 파일
  expect(previewCacheKey(F1, true, [1, 2], "#000000", undefined, null)).not.toBe(base); // 문서 보기
  expect(previewCacheKey(F1, false, [1, 3], "#000000", undefined, null)).not.toBe(base); // 다른 레이어
  expect(previewCacheKey(F1, false, [1, 2], null, undefined, null)).not.toBe(base); // 라인 색 없음
  expect(previewCacheKey(F1, false, [1, 2], "#000000", [1], null)).not.toBe(base); // 색 통일 대상이 다름
  expect(previewCacheKey(F1, false, [1, 2], "#000000", undefined, EDGE_ON)).not.toBe(base); // 색 경계선 켜짐
});

// 색 통일은 프리셋 규칙에 걸린 라인에만 걸린다. 아티스트가 손으로 체크해 넣은
// 색 레이어까지 덮으면 화면에서 새까맣게 보이고(썸네일은 원본 색이라 더 헷갈렸다),
// 내보낸 파일에도 그 색이 그대로 박힌다.
test("only the rule-matched layers among the visible ones get the line color", () => {
  expect(lineColorIdsFor([1, 2, 3], "#000000", [1, 3, 9])).toEqual([1, 3]);
});

test("with no line color there is nothing to target", () => {
  expect(lineColorIdsFor([1, 2], null, [1])).toBeNull();
});

// 프리셋을 아직 적용하지 않은 상태. null은 엔진에서 "전부 건다"는 뜻이고, 색
// 통일을 켜둔 프리셋이 선택돼 있으면 App이 곧 적용해 다시 그린다.
test("before a preset has been applied the target set is unknown, not empty", () => {
  expect(lineColorIdsFor([1, 2], "#000000", undefined)).toBeNull();
});

test("the spec targets the same layers its key was built from", () => {
  const tree = [pixel(1), pixel(2), pixel(3)];
  const spec = previewRenderSpec(F7, tree, [1, 2, 3], [], [], "#000000", [2, 3], null);
  expect(spec.visibleIds).toEqual([1, 2, 3]);
  expect(spec.lineColorIds).toEqual([2, 3]);
  expect(spec.key).toBe(previewCacheKey(F7, spec.documentView, [1, 2, 3], "#000000", [2, 3], null));
});

test("layer order matters — the engine stacks them in the order it is given", () => {
  expect(previewCacheKey(F1, false, [1, 2], null, undefined, null)).not.toBe(previewCacheKey(F1, false, [2, 1], null, undefined, null));
});

test("one file's image is never served for another", () => {
  const cache = new PreviewCache();
  cache.set(previewCacheKey(F1, false, [1], null, undefined, null)!, "data:a");
  expect(cache.get(previewCacheKey(F2, false, [1], null, undefined, null)!)).toBeUndefined();
});

test("a stored image comes back for the same key", () => {
  const cache = new PreviewCache();
  const key = previewCacheKey(F1, false, [1], null, undefined, null)!;
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

// --- 준비 큐가 무엇을 다시 만들 것인가 ---
// 107개 폴더에서 미리보기를 다 만든 뒤에도 준비 큐가 0/105로 계속 재시작했다.
// 캐시는 예산제 LRU라 폴더가 예산을 넘기면 앞쪽부터 버려지는데, 큐가 "캐시에
// 있는가"로 할 일을 고르니 방금 버려진 것이 곧바로 다시 잡혔다 — 만든 것을
// 스스로 버리고 다시 만드는 무한 루프였고, 엔진을 영원히 붙잡았다.

test("a key that is not in the cache and was never made is worth making", () => {
  expect(needsPrefetch("k", new PreviewCache(), new Set())).toBe(true);
});

test("a key already in the cache is not made again", () => {
  const cache = new PreviewCache();
  cache.set("k", "data:image/png;base64,AAA");
  expect(needsPrefetch("k", cache, new Set())).toBe(false);
});

test("a key made earlier is not made again just because the cache dropped it", () => {
  // 이 한 줄이 무한 루프를 끊는다. 축출은 캐시의 정상 동작이므로 그것을 근거로
  // 다시 만들면 큐가 영영 끝나지 않는다. 눌렀을 때 그 자리에서 그리면 된다.
  const cache = new PreviewCache();
  expect(needsPrefetch("k", cache, new Set(["k"]))).toBe(false);
});

test("a file with no key yet is skipped", () => {
  // 트리나 수정 시각을 아직 모르는 파일. 만들 그림이 정해지지 않았다.
  expect(needsPrefetch(null, new PreviewCache(), new Set())).toBe(false);
});
