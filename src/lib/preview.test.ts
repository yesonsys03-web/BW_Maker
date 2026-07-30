import { expect, test } from "vitest";
import { pixelLeafIds, visibleIdsForPreview } from "./preview";
import type { TreeNode } from "./types";

function leaf(id: number, kind: string): TreeNode {
  return {
    id,
    name: `layer${id}`,
    kind,
    visible: true,
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
