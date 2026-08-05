import { expect, test } from "vitest";
import { defaultExportPath, findTreeName, outputExtension, reorderArgs, resolveEntryName } from "./exportFlow";
import type { Entry } from "./opsReducer";
import type { TreeNode } from "./types";

// ---------- defaultExportPath ----------

test("defaultExportPath appends suffix before extension, preserves .psd", () => {
  expect(defaultExportPath("/a/b/name.psd", "_LINE")).toBe("/a/b/name_LINE.psd");
});

test("defaultExportPath recognizes .psd case-insensitively", () => {
  expect(defaultExportPath("/a/b/name.PSD", "_LINE")).toBe("/a/b/name_LINE.psd");
});

test("defaultExportPath preserves a .psb source extension", () => {
  expect(defaultExportPath("/a/b/name.psb", "_LINE")).toBe("/a/b/name_LINE.psb");
});

test("defaultExportPath recognizes .psb case-insensitively", () => {
  expect(defaultExportPath("/a/b/name.PSB", "_LINE")).toBe("/a/b/name_LINE.psb");
});

test("defaultExportPath falls back to .psd for an unrelated extension", () => {
  expect(defaultExportPath("/a/b/name.txt", "_LINE")).toBe("/a/b/name_LINE.psd");
});

test("defaultExportPath preserves windows-style separators", () => {
  expect(defaultExportPath("C:\\Users\\a\\name.psd", "_OUT")).toBe("C:\\Users\\a\\name_OUT.psd");
});

test("defaultExportPath handles a bare filename with no directory", () => {
  expect(defaultExportPath("name.psd", "_LINE")).toBe("name_LINE.psd");
});

test("defaultExportPath handles a dotfile-style name with no extension, falls back to .psd", () => {
  expect(defaultExportPath("/a/.psd", "_LINE")).toBe("/a/.psd_LINE.psd");
});

// ---------- outputExtension ----------

test("outputExtension preserves .psd and .psb (case-insensitively), else falls back to .psd", () => {
  expect(outputExtension("/a/b/name.psd")).toBe("psd");
  expect(outputExtension("/a/b/name.PSD")).toBe("psd");
  expect(outputExtension("/a/b/name.psb")).toBe("psb");
  expect(outputExtension("/a/b/name.PSB")).toBe("psb");
  expect(outputExtension("/a/b/name.txt")).toBe("psd");
  expect(outputExtension("/a/.psd")).toBe("psd");
});

// ---------- reorderArgs ----------

const INC: Entry[] = [
  { entryId: 3, sourceIds: [3], name: null },
  { entryId: 4, sourceIds: [4], name: null },
  { entryId: 5, sourceIds: [5], name: null },
];

test("reorderArgs: move to bottom (toIdx 0) yields aboveId null", () => {
  expect(reorderArgs(INC, 2, 0)).toEqual({ layerId: 5, aboveId: null });
});

test("reorderArgs: move to top yields aboveId of the new topmost entry below it", () => {
  expect(reorderArgs(INC, 0, 2)).toEqual({ layerId: 3, aboveId: 5 });
});

test("reorderArgs: move within the middle", () => {
  const entries: Entry[] = [
    { entryId: 1, sourceIds: [1], name: null },
    { entryId: 2, sourceIds: [2], name: null },
    { entryId: 3, sourceIds: [3], name: null },
    { entryId: 4, sourceIds: [4], name: null },
  ];
  expect(reorderArgs(entries, 0, 2)).toEqual({ layerId: 1, aboveId: 3 });
  expect(reorderArgs(entries, 3, 1)).toEqual({ layerId: 4, aboveId: 1 });
});

test("reorderArgs: no-op move (same index) still resolves aboveId consistently", () => {
  expect(reorderArgs(INC, 1, 1)).toEqual({ layerId: 4, aboveId: 3 });
});

// ---------- findTreeName / resolveEntryName ----------

const TREE: TreeNode[] = [
  {
    id: 1,
    name: "group A",
    kind: "group",
    visible: true,
    blendMode: "normal",
    opacity: 1,
    bbox: [0, 0, 10, 10],
    hasMask: false,
    path: [],
    children: [
      {
        id: 2,
        name: "line",
        kind: "pixel",
        visible: true,
        blendMode: "normal",
        opacity: 1,
        bbox: [0, 0, 10, 10],
        hasMask: false,
        path: ["group A"],
      },
    ],
  },
  {
    id: 3,
    name: "lines",
    kind: "pixel",
    visible: true,
    blendMode: "normal",
    opacity: 1,
    bbox: [0, 0, 10, 10],
    hasMask: false,
    path: [],
  },
];

test("findTreeName finds a nested node's name by id", () => {
  expect(findTreeName(TREE, 2)).toBe("line");
  expect(findTreeName(TREE, 1)).toBe("group A");
});

test("findTreeName returns null for an unknown id or missing tree", () => {
  expect(findTreeName(TREE, 999)).toBeNull();
  expect(findTreeName(undefined, 2)).toBeNull();
});

test("resolveEntryName prefers the entry's own name (merge/rename result)", () => {
  const entries: Entry[] = [{ entryId: -1, sourceIds: [2, 3], name: "M" }];
  expect(resolveEntryName(entries, TREE, -1)).toBe("M");
});

test("resolveEntryName falls back to the original tree name when entry.name is null", () => {
  const entries: Entry[] = [{ entryId: 3, sourceIds: [3], name: null }];
  expect(resolveEntryName(entries, TREE, 3)).toBe("lines");
});

test("resolveEntryName falls back to #id when neither entry name nor tree name is found", () => {
  expect(resolveEntryName([], TREE, 42)).toBe("#42");
});
