import { expect, test } from "vitest";
import {
  DEFAULT_PREVIEW_BACKGROUND,
  PREVIEW_COALESCE_MS,
  groupSoloIds,
  isDocumentView,
  previewRenderDelay,
  MAX_PREVIEW_SCALE,
  MIN_PREVIEW_SCALE,
  PREVIEW_BACKGROUNDS,
  PREVIEW_BACKGROUND_LABELS,
  nextScale,
  parsePreviewBackground,
  recenterOn,
  scaledBy,
  viewCommandFor,
  zoomAround,
  pixelLeafIds,
  visibleIdsForPreview,
} from "./preview";
import type { TreeNode } from "./types";

function leaf(id: number, kind: string, visible = true): TreeNode {
  return {
    id,
    name: `layer${id}`,
    kind,
    visible,
    blendMode: "normal",
    opacity: 100,
    bbox: [0, 0, 10, 10],
    hasMask: false,
    path: [`layer${id}`],
  };
}

function group(id: number, children: TreeNode[]): TreeNode {
  return { ...leaf(id, "group"), children };
}

// Document order for pixel leaves: 1, 2, 5, 7, 8. Node 3/6 are groups,
// node 4 is a non-pixel leaf (type).
const tree: TreeNode[] = [
  leaf(1, "pixel"),
  leaf(2, "pixel"),
  group(3, [leaf(4, "type"), leaf(5, "pixel"), group(6, [leaf(7, "pixel")])]),
  leaf(8, "pixel"),
];

test("all included and not preview-hidden yields every pixel leaf in document order", () => {
  expect(visibleIdsForPreview(tree, [1, 2, 5, 7, 8], [], [])).toEqual([1, 2, 5, 7, 8]);
});

test("excluded (not included) ids are dropped even when not preview-hidden", () => {
  expect(visibleIdsForPreview(tree, [1, 5, 7, 8], [], [])).toEqual([1, 5, 7, 8]);
});

test("preview-hidden ids are dropped even when included", () => {
  expect(visibleIdsForPreview(tree, [1, 2, 5, 7, 8], [5], [])).toEqual([1, 2, 7, 8]);
});

test("both excluded and preview-hidden combine (either drops the id)", () => {
  expect(visibleIdsForPreview(tree, [1, 5, 7, 8], [7], [])).toEqual([1, 5, 8]);
});

test("result order follows the tree/document order, not the includedIds argument order", () => {
  expect(visibleIdsForPreview(tree, [8, 1, 5], [], [])).toEqual([1, 5, 8]);
});

test("non-pixel ids (group or type) in includedIds/previewHiddenIds are ignored, not surfaced", () => {
  // 3 and 6 are groups, 4 is a non-pixel leaf; none should ever appear in the output.
  expect(visibleIdsForPreview(tree, [1, 2, 3, 4, 5, 6, 7, 8], [3, 4, 6], [])).toEqual([1, 2, 5, 7, 8]);
});

test("empty includedIds yields an empty preview", () => {
  expect(visibleIdsForPreview(tree, [], [], [])).toEqual([]);
});

test("empty tree yields an empty preview regardless of ids", () => {
  expect(visibleIdsForPreview([], [1, 2], [], [])).toEqual([]);
});

// --- solo (설계 문서 2절) ---

test("solo shows only the soloed leaves", () => {
  expect(visibleIdsForPreview(tree, [1, 2, 5, 7, 8], [], [2, 7])).toEqual([2, 7]);
});

// solo는 "이것만 보여달라"는 뜻이지 "내보낼 것 중에서 고른다"가 아니다. 아직
// 체크하지 않은 레이어가 라인인지 확인하는 것이 이 기능의 목적이다.
test("solo ignores the include checkbox", () => {
  expect(visibleIdsForPreview(tree, [], [], [5])).toEqual([5]);
});

test("solo ignores the eye toggle", () => {
  expect(visibleIdsForPreview(tree, [1, 2, 5, 7, 8], [5], [5])).toEqual([5]);
});

test("solo still yields document order, not the order they were soloed", () => {
  expect(visibleIdsForPreview(tree, [1, 2, 5, 7, 8], [], [8, 1])).toEqual([1, 8]);
});

// 그릴 수 있는 것은 pixel leaf뿐이라는 제약은 solo가 풀어주지 않는다.
test("solo cannot conjure a non-pixel leaf into the preview", () => {
  expect(visibleIdsForPreview(tree, [], [], [4])).toEqual([]);
});

test("a solo id that is not in the tree is simply absent", () => {
  expect(visibleIdsForPreview(tree, [1, 2], [], [99])).toEqual([]);
});

test("pixelLeafIds returns every pixel leaf id in document order, ignoring included/hidden state", () => {
  expect(pixelLeafIds(tree)).toEqual([1, 2, 5, 7, 8]);
});

test("pixelLeafIds on an empty tree returns an empty array", () => {
  expect(pixelLeafIds([])).toEqual([]);
});

// --- groupSoloIds (그룹 solo가 soloIds에 넣는 id) ---
//
// LayerTree의 handleGroupSolo/allSoloed/병합 행이 전부 이 함수 하나로 solo
// 대상을 정한다. 그리지 못하는 id(type/adjustment/shape)가 섞여 들어가면 solo
// 모드에 갇힌 채 어느 행도 solo로 안 보이는 막다른 상태가 되므로, pixel leaf만
// 남기는지가 이 함수의 핵심 계약이다.

test("groupSoloIds on a mixed group (pixel + text) keeps only the pixel leaf", () => {
  // group 3 = [type 4, pixel 5, group 6 = [pixel 7]]
  const mixedGroup = tree.find((n) => n.id === 3)!;
  expect(groupSoloIds([mixedGroup])).toEqual([5, 7]);
});

test("groupSoloIds on a group with no pixel descendants returns an empty array", () => {
  const textOnlyGroup = group(100, [leaf(101, "type"), leaf(102, "shape")]);
  expect(groupSoloIds([textOnlyGroup])).toEqual([]);
});

test("groupSoloIds recurses into nested groups", () => {
  // group 6 = [pixel 7], nested one level inside group 3.
  const nestedGroup = group(200, [leaf(201, "type"), group(202, [leaf(203, "pixel"), leaf(204, "adjustment")])]);
  expect(groupSoloIds([nestedGroup])).toEqual([203]);
});

test("nextScale with deltaY 0 leaves scale unchanged", () => {
  expect(nextScale(2, 0)).toBeCloseTo(2);
});

test("nextScale with negative deltaY (scroll up) zooms in", () => {
  expect(nextScale(1, -100)).toBeGreaterThan(1);
});

test("nextScale with positive deltaY (scroll down) zooms out", () => {
  expect(nextScale(1, 100)).toBeLessThan(1);
});

test("nextScale clamps at MIN_PREVIEW_SCALE on a large zoom-out", () => {
  expect(nextScale(0.11, 1_000_000)).toBe(MIN_PREVIEW_SCALE);
});

test("nextScale clamps at MAX_PREVIEW_SCALE on a large zoom-in", () => {
  expect(nextScale(7, -1_000_000)).toBe(MAX_PREVIEW_SCALE);
});

test("nextScale never leaves the [MIN_PREVIEW_SCALE, MAX_PREVIEW_SCALE] range", () => {
  expect(nextScale(MIN_PREVIEW_SCALE, 500)).toBeGreaterThanOrEqual(MIN_PREVIEW_SCALE);
  expect(nextScale(MAX_PREVIEW_SCALE, -500)).toBeLessThanOrEqual(MAX_PREVIEW_SCALE);
});

test("parsePreviewBackground keeps every known background value", () => {
  for (const bg of PREVIEW_BACKGROUNDS) {
    expect(parsePreviewBackground(bg)).toBe(bg);
  }
});

test("parsePreviewBackground falls back to white when nothing is stored yet", () => {
  expect(parsePreviewBackground(null)).toBe("white");
  expect(DEFAULT_PREVIEW_BACKGROUND).toBe("white");
});

test("parsePreviewBackground falls back to the default on an unknown stored value", () => {
  expect(parsePreviewBackground("grey")).toBe(DEFAULT_PREVIEW_BACKGROUND);
  expect(parsePreviewBackground("")).toBe(DEFAULT_PREVIEW_BACKGROUND);
});

test("every background has a label for the toggle button", () => {
  for (const bg of PREVIEW_BACKGROUNDS) {
    expect(PREVIEW_BACKGROUND_LABELS[bg]).toBeTruthy();
  }
});

// isDocumentView: 파일을 막 연 직후인지 판정한다. buildInitialOpsState가
// includedIds = 픽셀 leaf 전부 / previewHiddenIds = visible이 false인 leaf로
// 세팅하므로, 초기 visible 집합은 "visible=true인 픽셀 leaf 전부"다.
const mixedVisibility: TreeNode[] = [
  leaf(1, "pixel"),
  leaf(2, "pixel", false),
  group(3, [leaf(4, "type"), leaf(5, "pixel")]),
];

test("isDocumentView is true for the set a freshly opened file produces", () => {
  expect(isDocumentView(mixedVisibility, [1, 5])).toBe(true);
});

test("isDocumentView is false once a layer is switched off", () => {
  expect(isDocumentView(mixedVisibility, [1])).toBe(false);
});

test("isDocumentView is false when a layer the PSD had hidden gets switched on", () => {
  expect(isDocumentView(mixedVisibility, [1, 2, 5])).toBe(false);
});

test("isDocumentView ignores ordering", () => {
  expect(isDocumentView(mixedVisibility, [5, 1])).toBe(true);
});

test("isDocumentView is false with no tree yet", () => {
  expect(isDocumentView(undefined, [])).toBe(false);
});

// --- 뷰 단축키 (Harmony식 1 / 2 / N / Shift+M) ---

test("the digits and N map to view commands", () => {
  expect(viewCommandFor({ code: "Digit1" })).toBe("zoomOut");
  expect(viewCommandFor({ code: "Digit2" })).toBe("zoomIn");
  expect(viewCommandFor({ code: "KeyN" })).toBe("recenter");
});

test("the key is read by physical code, so a Korean keyboard still recenters", () => {
  // 한글 입력 상태에서 N을 누르면 event.key는 "ㅜ"로 온다. code는 자판 배열과
  // 무관하게 KeyN이므로, 여기서 code만 보면 두 상태가 같은 명령이 된다.
  expect(viewCommandFor({ code: "KeyN", key: "ㅜ" })).toBe("recenter");
  expect(viewCommandFor({ code: "KeyN", key: "n" })).toBe("recenter");
});

test("reset needs shift — bare M does nothing", () => {
  expect(viewCommandFor({ code: "KeyM", shiftKey: true })).toBe("reset");
  expect(viewCommandFor({ code: "KeyM" })).toBeNull();
});

test("a command key held with ctrl/alt/meta is left to the OS and the app", () => {
  expect(viewCommandFor({ code: "Digit2", metaKey: true })).toBeNull();
  expect(viewCommandFor({ code: "Digit1", ctrlKey: true })).toBeNull();
  expect(viewCommandFor({ code: "KeyN", altKey: true })).toBeNull();
  expect(viewCommandFor({ code: "KeyM", shiftKey: true, metaKey: true })).toBeNull();
});

test("shift on the zoom keys is ignored — the digit is what matters", () => {
  // Shift+2는 자판에 따라 "@"가 되지만 code는 Digit2 그대로다. 확대를 기대한
  // 손가락이 shift에 걸려 아무 일도 안 일어나는 편이 더 나쁘다.
  expect(viewCommandFor({ code: "Digit2", shiftKey: true })).toBe("zoomIn");
});

test("keys the view does not claim are left alone", () => {
  expect(viewCommandFor({ code: "Digit3" })).toBeNull();
  expect(viewCommandFor({ code: "KeyA" })).toBeNull();
});

test("scaledBy multiplies and clamps with the same bounds as the wheel", () => {
  expect(scaledBy(1, 2)).toBeCloseTo(2);
  expect(scaledBy(MAX_PREVIEW_SCALE, 2)).toBe(MAX_PREVIEW_SCALE);
  expect(scaledBy(MIN_PREVIEW_SCALE, 0.5)).toBe(MIN_PREVIEW_SCALE);
});

/** 커서 아래에 있던 문서 좌표가 확대 뒤 화면 어디로 갔는지. 안 움직여야 한다. */
function pointUnderCursorAfterZoom(
  offset: { x: number; y: number },
  scale: number,
  next: number,
  cursor: { x: number; y: number }
) {
  const doc = { x: (cursor.x - offset.x) / scale, y: (cursor.y - offset.y) / scale };
  const moved = zoomAround(offset, scale, next, cursor);
  return { x: moved.x + doc.x * next, y: moved.y + doc.y * next };
}

test("zoomAround keeps the point under the cursor under the cursor", () => {
  const cursor = { x: 100, y: 50 };
  const after = pointUnderCursorAfterZoom({ x: 30, y: -10 }, 1, 2, cursor);
  expect(after.x).toBeCloseTo(cursor.x);
  expect(after.y).toBeCloseTo(cursor.y);
});

test("zoomAround holds the point on the way out too", () => {
  const cursor = { x: -220, y: 140 };
  const after = pointUnderCursorAfterZoom({ x: -75, y: 60 }, 3, 1.5, cursor);
  expect(after.x).toBeCloseTo(cursor.x);
  expect(after.y).toBeCloseTo(cursor.y);
});

test("zooming a centred image from its centre moves nothing", () => {
  expect(zoomAround({ x: 0, y: 0 }, 1, 2, { x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
});

test("a zoom that the clamp refused does not shift the image", () => {
  // 상한에 걸려 배율이 그대로면 화면도 그대로여야 한다. next를 현재와 같은 값으로
  // 넘기는 것이 그 경우다 — 여기서 offset이 움직이면 키를 눌러도 배율은 안 변한
  // 채 그림만 미끄러진다.
  const offset = { x: 40, y: -25 };
  expect(zoomAround(offset, 2, 2, { x: 90, y: 15 })).toEqual(offset);
});

test("recenterOn brings the point under the cursor to the middle", () => {
  const offset = { x: 30, y: -10 };
  const cursor = { x: 100, y: 50 };
  const scale = 2;
  const doc = { x: (cursor.x - offset.x) / scale, y: (cursor.y - offset.y) / scale };

  const moved = recenterOn(offset, cursor);

  expect(moved.x + doc.x * scale).toBeCloseTo(0);
  expect(moved.y + doc.y * scale).toBeCloseTo(0);
});

test("recenterOn with the cursor already centred changes nothing", () => {
  expect(recenterOn({ x: 12, y: 34 }, { x: 0, y: 0 })).toEqual({ x: 12, y: 34 });
});

test("첫 토글은 기다리지 않는다", () => {
  // 이것이 이 함수가 존재하는 이유다. 예전에는 클릭 한 번에도 120ms를 무조건
  // 냈고, 실측된 체감 지연 ~225ms의 절반 이상이 그 대기였다.
  expect(previewRenderDelay(null, 1000)).toBe(0);
});

test("조용하다 누른 토글도 기다리지 않는다", () => {
  // 마지막 렌더 이후 충분히 지났으면 연타가 아니다.
  expect(previewRenderDelay(1000, 1000 + PREVIEW_COALESCE_MS)).toBe(0);
  expect(previewRenderDelay(1000, 1000 + PREVIEW_COALESCE_MS + 50)).toBe(0);
});

test("연타는 묶는다 — 남은 시간만 기다린다", () => {
  // 디바운스를 없애는 것이 아니라 앞으로 옮기는 것이다. 엔진은 stdin을 순서대로
  // 처리하므로 열 번 빠르게 누르면 열 번의 전체 렌더가 큐에 쌓인다. requestIdRef가
  // 오래된 *결과*는 버리지만 엔진은 그 일을 다 한다 — 그래서 묶기가 필요하다.
  expect(previewRenderDelay(1000, 1000)).toBe(PREVIEW_COALESCE_MS);
  expect(previewRenderDelay(1000, 1000 + 40)).toBe(PREVIEW_COALESCE_MS - 40);
});

test("시계가 뒤로 가도 음수를 돌려주지 않는다", () => {
  // setTimeout에 음수를 주면 즉시 발사라 결과는 같지만, 이 함수가 "남은 대기"를
  // 뜻하는 이상 음수는 뜻이 없는 값이다.
  expect(previewRenderDelay(2000, 1000)).toBe(0);
});
