import { expect, test } from "vitest";
import {
  DEFAULT_PREVIEW_BACKGROUND,
  isDocumentView,
  MAX_PREVIEW_SCALE,
  MIN_PREVIEW_SCALE,
  PREVIEW_BACKGROUNDS,
  PREVIEW_BACKGROUND_LABELS,
  nextScale,
  parsePreviewBackground,
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
  expect(visibleIdsForPreview(tree, [1, 2, 5, 7, 8], [])).toEqual([1, 2, 5, 7, 8]);
});

test("excluded (not included) ids are dropped even when not preview-hidden", () => {
  expect(visibleIdsForPreview(tree, [1, 5, 7, 8], [])).toEqual([1, 5, 7, 8]);
});

test("preview-hidden ids are dropped even when included", () => {
  expect(visibleIdsForPreview(tree, [1, 2, 5, 7, 8], [5])).toEqual([1, 2, 7, 8]);
});

test("both excluded and preview-hidden combine (either drops the id)", () => {
  expect(visibleIdsForPreview(tree, [1, 5, 7, 8], [7])).toEqual([1, 5, 8]);
});

test("result order follows the tree/document order, not the includedIds argument order", () => {
  expect(visibleIdsForPreview(tree, [8, 1, 5], [])).toEqual([1, 5, 8]);
});

test("non-pixel ids (group or type) in includedIds/previewHiddenIds are ignored, not surfaced", () => {
  // 3 and 6 are groups, 4 is a non-pixel leaf; none should ever appear in the output.
  expect(visibleIdsForPreview(tree, [1, 2, 3, 4, 5, 6, 7, 8], [3, 4, 6])).toEqual([1, 2, 5, 7, 8]);
});

test("empty includedIds yields an empty preview", () => {
  expect(visibleIdsForPreview(tree, [], [])).toEqual([]);
});

test("empty tree yields an empty preview regardless of ids", () => {
  expect(visibleIdsForPreview([], [1, 2], [])).toEqual([]);
});

test("pixelLeafIds returns every pixel leaf id in document order, ignoring included/hidden state", () => {
  expect(pixelLeafIds(tree)).toEqual([1, 2, 5, 7, 8]);
});

test("pixelLeafIds on an empty tree returns an empty array", () => {
  expect(pixelLeafIds([])).toEqual([]);
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
