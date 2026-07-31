import { expect, test } from "vitest";
import {
  applyBulkInclude,
  bulkTogglableIds,
  collapseMergedRows,
  filterLeaves,
  flattenLeaves,
  isFiltering,
  isLineFallbackActive,
  suggestMergeName,
  lineLeafIds,
} from "./layerFilter";
import type { TreeNode } from "./types";

function leaf(id: number, name: string, path: string[], kind = "pixel"): TreeNode {
  return {
    id,
    name,
    kind,
    visible: true,
    blendMode: "normal",
    opacity: 100,
    bbox: [0, 0, 10, 10],
    hasMask: false,
    path: [...path, name],
  };
}

function group(id: number, name: string, path: string[], children: TreeNode[]): TreeNode {
  return { ...leaf(id, name, path, "group"), children };
}

// 실제 소스 PSD의 형태를 축소한 것: 그룹마다 똑같이 "LINE"이라 불리는 레이어가
// 있고(2, 4), 그 밖에 라인이 아닌 레이어가 섞여 있다.
//   *ART / ROOM / ROOM  -> FILL(1), LINE(2)
//   *ART / ROOM / PIPES -> LINE(4), SH GRAIN(5)
//   NOTES(6, 루트 직속 type 레이어)
const tree: TreeNode[] = [
  group(10, "*ART", [], [
    group(11, "ROOM", ["*ART"], [
      group(12, "ROOM", ["*ART", "ROOM"], [
        leaf(1, "FILL", ["*ART", "ROOM", "ROOM"]),
        leaf(2, "LINE", ["*ART", "ROOM", "ROOM"]),
      ]),
      group(13, "PIPES", ["*ART", "ROOM"], [
        leaf(4, "LINE", ["*ART", "ROOM", "PIPES"]),
        leaf(5, "SH GRAIN", ["*ART", "ROOM", "PIPES"]),
      ]),
    ]),
  ]),
  leaf(6, "NOTES", [], "type"),
];

const leaves = flattenLeaves(tree);

test("flattenLeaves returns leaves in document order, groups excluded", () => {
  expect(leaves.map((l) => l.node.id)).toEqual([1, 2, 4, 5, 6]);
});

test("flattenLeaves builds a breadcrumb of ancestors only", () => {
  expect(leaves.find((l) => l.node.id === 2)?.breadcrumb).toBe("*ART / ROOM / ROOM");
  expect(leaves.find((l) => l.node.id === 4)?.breadcrumb).toBe("*ART / ROOM / PIPES");
});

test("flattenLeaves gives a root-level leaf an empty breadcrumb", () => {
  expect(leaves.find((l) => l.node.id === 6)?.breadcrumb).toBe("");
});

test("lineLeafIds uses the preset's matched ids when there are any", () => {
  // 프리셋이 "SH"로 매칭했다면 라인만 필터도 그 결과를 따라야 한다 — 규칙이
  // 반드시 'line'이라는 단어인 것은 아니다.
  expect(lineLeafIds(leaves, [5])).toEqual([5]);
});

test("lineLeafIds drops group ids that a matchGroups preset may have matched", () => {
  expect(lineLeafIds(leaves, [11, 2, 4])).toEqual([2, 4]);
});

test("lineLeafIds falls back to a name-contains-line rule before any preset is applied", () => {
  expect(lineLeafIds(leaves, [])).toEqual([2, 4]);
});

test("the name fallback is case-insensitive", () => {
  const mixed = flattenLeaves([leaf(7, "Outline sketch", ["G"])]);
  expect(lineLeafIds(mixed, [])).toEqual([7]);
});

test("isLineFallbackActive only reports the fallback in line mode without matches", () => {
  expect(isLineFallbackActive("line", [])).toBe(true);
  expect(isLineFallbackActive("line", [2])).toBe(false);
  expect(isLineFallbackActive("all", [])).toBe(false);
});

test("isFiltering is false only for the untouched all-mode view", () => {
  expect(isFiltering("all", "")).toBe(false);
  expect(isFiltering("all", "   ")).toBe(false);
  expect(isFiltering("all", "line")).toBe(true);
  expect(isFiltering("line", "")).toBe(true);
});

test("filterLeaves in line mode keeps only the line leaves", () => {
  const out = filterLeaves(leaves, { mode: "line", query: "", matchedIds: [] });
  expect(out.map((l) => l.node.id)).toEqual([2, 4]);
});

test("filterLeaves in all mode with no query keeps everything", () => {
  const out = filterLeaves(leaves, { mode: "all", query: "", matchedIds: [] });
  expect(out.map((l) => l.node.id)).toEqual([1, 2, 4, 5, 6]);
});

test("the query matches the breadcrumb too, so a group name narrows the list", () => {
  const out = filterLeaves(leaves, { mode: "all", query: "pipes", matchedIds: [] });
  expect(out.map((l) => l.node.id)).toEqual([4, 5]);
});

test("query and mode compose — the same-named LINE rows are told apart by path", () => {
  const out = filterLeaves(leaves, { mode: "line", query: "PIPES", matchedIds: [] });
  expect(out.map((l) => l.node.id)).toEqual([4]);
});

test("a query matching nothing yields an empty list rather than everything", () => {
  const out = filterLeaves(leaves, { mode: "all", query: "zzz", matchedIds: [] });
  expect(out).toEqual([]);
});

test("bulkTogglableIds skips non-pixel leaves, which have no usable checkbox", () => {
  expect(bulkTogglableIds(leaves)).toEqual([1, 2, 4, 5]);
});

test("applyBulkInclude adds without duplicating and keeps ids sorted", () => {
  expect(applyBulkInclude([5, 1], [2, 4, 1], true)).toEqual([1, 2, 4, 5]);
});

test("applyBulkInclude removes only the targeted ids", () => {
  expect(applyBulkInclude([1, 2, 4, 5], [2, 4], false)).toEqual([1, 5]);
});

// collapseMergedRows: 평면 목록에서 병합 결과를 한 줄로 보여준다. 트리는 원본
// 구조를 비춰야 해서 접을 수 없지만(다른 그룹끼리 병합하면 어디에 둘지 없음),
// 평면 목록에는 그룹이 없어 그 문제가 사라진다.
const entry = (entryId: number, sourceIds: number[], name: string | null) => ({
  entryId,
  sourceIds,
  name,
});

test("collapseMergedRows folds a merge into a single row at its first source's slot", () => {
  const rows = collapseMergedRows(leaves, [
    entry(1, [1], null),
    entry(-1, [2, 4], "Chair2"),
    entry(5, [5], null),
    entry(6, [6], null),
  ]);
  expect(rows.map((r) => (r.kind === "merged" ? r.name : r.leaf.node.id))).toEqual([
    1,
    "Chair2",
    5,
    6,
  ]);
});

test("a merged row carries its sources and the merge's total source count", () => {
  const rows = collapseMergedRows(leaves, [entry(-1, [2, 4], "Chair2")]);
  const merged = rows.find((r) => r.kind === "merged");
  expect(merged).toBeDefined();
  if (merged?.kind !== "merged") throw new Error("unreachable");
  expect(merged.leaves.map((l) => l.node.id)).toEqual([2, 4]);
  expect(merged.sourceCount).toBe(2);
});

test("collapseMergedRows leaves plain and renamed entries as their own rows", () => {
  const rows = collapseMergedRows(leaves, [entry(1, [1], "OUTLINE"), entry(2, [2], null)]);
  expect(rows.every((r) => r.kind === "leaf")).toBe(true);
});

test("collapseMergedRows is a passthrough when nothing is merged", () => {
  const rows = collapseMergedRows(leaves, leaves.map((l) => entry(l.node.id, [l.node.id], null)));
  expect(rows.map((r) => (r.kind === "leaf" ? r.leaf.node.id : -1))).toEqual([1, 2, 4, 5, 6]);
});

test("a merged row appears once even though it has several sources in the list", () => {
  const rows = collapseMergedRows(leaves, [entry(-1, [1, 2, 4], "All")]);
  expect(rows.filter((r) => r.kind === "merged")).toHaveLength(1);
  expect(rows).toHaveLength(3); // 병합 1줄 + 5, 6
});

test("a merge whose sources are mostly filtered out still shows the visible ones", () => {
  // 검색으로 좁혀 소스 하나만 보이는 경우에도 그 행은 병합 항목으로 보여야 한다.
  const onlyOne = leaves.filter((l) => l.node.id === 4);
  const rows = collapseMergedRows(onlyOne, [entry(-1, [2, 4], "Chair2")]);
  expect(rows).toHaveLength(1);
  if (rows[0].kind !== "merged") throw new Error("병합 행이어야 한다");
  expect(rows[0].leaves.map((l) => l.node.id)).toEqual([4]);
  expect(rows[0].sourceCount).toBe(2);
});

// suggestMergeName: 라인 레이어는 전부 "LINE"이라 이름만으론 단서가 없다.
// 요소 그룹 이름에서 역할 접미사를 떼어내 제안한다.
const TOKENS = ["UL", "OL_UL", "OL"];
const at = (id: number, name: string, path: string[]) => ({
  node: leaf(id, name, path),
  breadcrumb: path.join(" / "),
});

test("suggestMergeName returns the shared element when both sides are one element", () => {
  const rows = [at(1, "LINE", ["*ART", "CHAIR1_UL"]), at(2, "LINE", ["*ART", "CHAIR1_OL"])];
  expect(suggestMergeName(rows, TOKENS)).toBe("CHAIR1");
});

test("suggestMergeName falls back to the common prefix across elements", () => {
  const rows = [at(1, "LINE", ["*ART", "CHAIR1_UL"]), at(2, "LINE", ["*ART", "CHAIR2_OL"])];
  expect(suggestMergeName(rows, TOKENS)).toBe("CHAIR");
});

test("suggestMergeName strips the longest token first", () => {
  const rows = [at(1, "LINE", ["*ART", "PROP_OL_UL"])];
  expect(suggestMergeName(rows, TOKENS)).toBe("PROP");
});

test("suggestMergeName leaves the box empty when the layers share nothing", () => {
  const rows = [at(1, "LINE", ["*ART", "CHAIR1_UL"]), at(2, "LINE", ["*ART", "SOFA_OL"])];
  expect(suggestMergeName(rows, TOKENS)).toBe("");
});

test("suggestMergeName leaves the box empty for layers with no role suffix at all", () => {
  const rows = [at(1, "LINE", ["*ART", "ROOM"]), at(2, "LINE", ["*ART", "TABLE"])];
  expect(suggestMergeName(rows, TOKENS)).toBe("");
});

test("suggestMergeName uses the nearest ancestor carrying a token", () => {
  const rows = [at(1, "LINE", ["SET_OL", "CHAIR_UL"])];
  expect(suggestMergeName(rows, TOKENS)).toBe("CHAIR");
});
