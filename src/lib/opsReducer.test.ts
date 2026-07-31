import { expect, test } from "vitest";
import { autoMergeOps, buildEntries, exportLabelsBySourceId, opsReducer, OpsState } from "./opsReducer";
import type { Operation } from "./types";

const INC = [3, 4, 5];
const ids = (e: { entryId: number }[]) => e.map((x) => x.entryId);

test("no ops keeps order", () => { expect(ids(buildEntries(INC, []))).toEqual([3, 4, 5]); });

test("merge replaces at topmost, sources bottom-to-top", () => {
  const e = buildEntries(INC, [{ op: "merge", layerIds: [5, 3], name: "M" }]);
  expect(ids(e)).toEqual([4, -1]);
  expect(e[1].sourceIds).toEqual([3, 5]);
});

test("merge result can be merged again", () => {
  const e = buildEntries(INC, [
    { op: "merge", layerIds: [3, 4], name: "A" },
    { op: "merge", layerIds: [-1, 5], name: "B" },
  ]);
  expect(ids(e)).toEqual([-2]);
  expect(e[0].sourceIds).toEqual([3, 4, 5]);
});

test("flatten", () => {
  const e = buildEntries(INC, [{ op: "flatten", name: "F" }]);
  expect(ids(e)).toEqual([-1]);
  expect(e[0].sourceIds).toEqual([3, 4, 5]);
});

test("reorder above and to bottom", () => {
  expect(ids(buildEntries(INC, [{ op: "reorder", layerId: 3, aboveId: 5 }]))).toEqual([4, 5, 3]);
  expect(ids(buildEntries(INC, [{ op: "reorder", layerId: 5, aboveId: null }]))).toEqual([5, 3, 4]);
});

test("an op referring to a layer that is no longer included is skipped, not fatal", () => {
  // 체크 해제는 일상적인 동작이다. 그 레이어를 가리키던 작업 때문에 전체가
  // 실패하면 아티스트는 무관한 편집을 되돌려야 한다.
  expect(() => buildEntries(INC, [{ op: "rename", layerId: 99, name: "x" }])).not.toThrow();
  expect(ids(buildEntries(INC, [{ op: "rename", layerId: 99, name: "x" }]))).toEqual(INC);
});

test("reorder self-reference (aboveId === layerId) throws", () => {
  expect(() => buildEntries(INC, [{ op: "reorder", layerId: 4, aboveId: 4 }])).toThrow();
});

test("undo recomputes entries", () => {
  let s: OpsState = opsReducer(undefined as never, { type: "reset", includedIds: INC });
  s = opsReducer(s, { type: "pushOp", op: { op: "flatten", name: "F" } });
  expect(ids(s.entries)).toEqual([-1]);
  s = opsReducer(s, { type: "undo" });
  expect(ids(s.entries)).toEqual([3, 4, 5]);
});

// exportLabelsBySourceId: 병합/이름변경은 트리에 나타나지 않으므로, 각 소스 행에
// "내보낼 때 이렇게 나간다"를 붙이기 위한 매핑.
test("exportLabelsBySourceId maps every source of a merge to the merged name", () => {
  const entries = buildEntries([1, 2, 3], [{ op: "merge", layerIds: [1, 2], name: "Chair2" }]);
  const labels = exportLabelsBySourceId(entries);
  expect(labels.get(1)).toEqual({ name: "Chair2", merged: true, sourceCount: 2 });
  expect(labels.get(2)).toEqual({ name: "Chair2", merged: true, sourceCount: 2 });
});

test("exportLabelsBySourceId leaves plain copies unlabelled", () => {
  const entries = buildEntries([1, 2, 3], [{ op: "merge", layerIds: [1, 2], name: "Chair2" }]);
  expect(exportLabelsBySourceId(entries).has(3)).toBe(false);
});

test("exportLabelsBySourceId labels a rename without calling it a merge", () => {
  const entries = buildEntries([1, 2], [{ op: "rename", layerId: 1, name: "OUTLINE" }]);
  expect(exportLabelsBySourceId(entries).get(1)).toEqual({
    name: "OUTLINE",
    merged: false,
    sourceCount: 1,
  });
});

test("exportLabelsBySourceId is empty when nothing has been edited", () => {
  expect(exportLabelsBySourceId(buildEntries([1, 2, 3], [])).size).toBe(0);
});

test("exportLabelsBySourceId follows a merge that is later renamed", () => {
  // rename은 소스 레이어 id가 아니라 항목(entry) id를 가리킨다. 병합은 새 항목
  // id를 만들어내므로 그 id로 이름을 바꿔야 한다.
  const merged = buildEntries([1, 2], [{ op: "merge", layerIds: [1, 2], name: "Chair2" }]);
  const mergedId = merged.find((e) => e.sourceIds.length === 2)!.entryId;
  const entries = buildEntries(
    [1, 2],
    [
      { op: "merge", layerIds: [1, 2], name: "Chair2" },
      { op: "rename", layerId: mergedId, name: "CHAIR_LINE" },
    ]
  );
  const label = exportLabelsBySourceId(entries).get(2);
  expect(label?.name).toBe("CHAIR_LINE");
  expect(label?.merged).toBe(true);
  expect(label?.sourceCount).toBe(2);
});


// 병합에 참여한 레이어의 체크를 푸는 경우. 예전에는 buildEntries가 던져서
// "포함 상태 변경 실패 — 먼저 병합을 되돌리세요" 에러가 떴다.
const MERGE_CHAIR = [{ op: "merge" as const, layerIds: [3, 4], name: "Chair2" }];

test("unchecking one source of a merge leaves the other carrying the merged name", () => {
  const entries = buildEntries([4, 5], MERGE_CHAIR);
  const chair = entries.find((e) => e.sourceIds.includes(4));
  expect(chair?.name).toBe("Chair2");
  expect(chair?.sourceIds).toEqual([4]);
  expect(entries).toHaveLength(2);
});

test("unchecking every source of a merge drops it entirely", () => {
  const entries = buildEntries([5], MERGE_CHAIR);
  expect(entries).toEqual([{ entryId: 5, sourceIds: [5], name: null }]);
});

test("re-checking a source restores the merge, since ops replay from scratch", () => {
  const entries = buildEntries(INC, MERGE_CHAIR);
  const merged = entries.find((e) => e.sourceIds.length === 2);
  expect(merged?.sourceIds).toEqual([3, 4]);
  expect(merged?.name).toBe("Chair2");
});

test("a merge reduced to one source still answers to its merged entry id", () => {
  // 뒤따르는 작업(예: 병합 결과 이름변경)이 id를 잃지 않아야 한다.
  const full = buildEntries(INC, MERGE_CHAIR);
  const mergedId = full.find((e) => e.sourceIds.length === 2)!.entryId;
  const entries = buildEntries([4, 5], [
    ...MERGE_CHAIR,
    { op: "rename", layerId: mergedId, name: "CHAIR_LINE" },
  ]);
  expect(entries.find((e) => e.sourceIds.includes(4))?.name).toBe("CHAIR_LINE");
});

test("reorder is skipped when its reference entry is no longer included", () => {
  const ops = [{ op: "reorder" as const, layerId: 5, aboveId: 3 }];
  expect(() => buildEntries([4, 5], ops)).not.toThrow();
  expect(ids(buildEntries([4, 5], ops))).toEqual([4, 5]);
});

test("reorder to the bottom still works when its own entry survives", () => {
  expect(ids(buildEntries(INC, [{ op: "reorder", layerId: 5, aboveId: null }]))).toEqual([5, 3, 4]);
});

// unmerge: 자동 병합이 잘못 묶었을 때 그 레이어만 단독으로 되돌린다.
// "내보내기에서 제외"와 달리 산출물에는 남는다.
const MERGE_THREE = [{ op: "merge" as const, layerIds: [3, 4, 5], name: "BG" }];

test("unmerge pulls one layer out and leaves the rest merged", () => {
  const entries = buildEntries(INC, [...MERGE_THREE, { op: "unmerge", layerIds: [4] }]);
  const merged = entries.find((e) => e.sourceIds.length > 1);
  expect(merged?.sourceIds).toEqual([3, 5]);
  expect(merged?.name).toBe("BG");
  const solo = entries.find((e) => e.entryId === 4);
  expect(solo).toEqual({ entryId: 4, sourceIds: [4], name: null });
});

test("unmerge keeps the extracted layer in the export, unlike an exclude", () => {
  const entries = buildEntries(INC, [...MERGE_THREE, { op: "unmerge", layerIds: [4] }]);
  expect(entries.flatMap((e) => e.sourceIds).sort()).toEqual([3, 4, 5]);
});

test("unmerge places the extracted layer directly above the merge it came from", () => {
  const entries = buildEntries(INC, [...MERGE_THREE, { op: "unmerge", layerIds: [4] }]);
  const mergedIdx = entries.findIndex((e) => e.sourceIds.length > 1);
  expect(entries[mergedIdx + 1].entryId).toBe(4);
});

test("unmerging every source dissolves the merge entirely", () => {
  const entries = buildEntries(INC, [...MERGE_THREE, { op: "unmerge", layerIds: [3, 4, 5] }]);
  expect(entries.map((e) => e.entryId).sort((a, b) => a - b)).toEqual([3, 4, 5]);
  expect(entries.every((e) => e.name === null)).toBe(true);
});

test("a merge left with one source keeps its name", () => {
  const entries = buildEntries(INC, [...MERGE_THREE, { op: "unmerge", layerIds: [3, 4] }]);
  expect(entries.find((e) => e.sourceIds.includes(5))?.name).toBe("BG");
});

test("unmerge on a layer that is not merged does nothing", () => {
  const plain = buildEntries(INC, []);
  expect(buildEntries(INC, [{ op: "unmerge", layerIds: [4] }])).toEqual(plain);
});

test("unmerge is undone by dropping the op, restoring the full merge", () => {
  const withUnmerge = buildEntries(INC, [...MERGE_THREE, { op: "unmerge", layerIds: [4] }]);
  expect(withUnmerge.find((e) => e.sourceIds.length > 1)?.sourceIds).toEqual([3, 5]);
  const undone = buildEntries(INC, MERGE_THREE);
  expect(undone.find((e) => e.sourceIds.length > 1)?.sourceIds).toEqual([3, 4, 5]);
});

// autoMergeOps: 자동 병합을 "이미 병합된 상태" 위에 얹는 경우. 규칙을 바꿔 다시
// 누르는 것이 정상 사용인데, 예전에는 새 병합이 원본 레이어 id를 가리켜 대상을
// 찾지 못하고 조용히 무시됐다 — 화면도 산출물도 그대로였다.
const AUTO_INC = [1, 2, 3, 4, 5];
// 엔진 auto_merge_operations의 실제 출력(스크린샷의 5장 기준).
const ROLE_OPS: Operation[] = [
  { op: "merge", layerIds: [1, 2, 3, 4, 5], name: "BG" },
  { op: "reorder", layerId: -1, aboveId: null },
];
const PLANE_OPS: Operation[] = [
  { op: "merge", layerIds: [1, 5], name: "BG" },
  { op: "merge", layerIds: [2, 3, 4], name: "MG" },
  { op: "reorder", layerId: -1, aboveId: null },
  { op: "reorder", layerId: -2, aboveId: -1 },
];
const fresh = (includedIds: number[]): OpsState => ({
  includedIds,
  previewHiddenIds: [],
  ops: [],
  entries: buildEntries(includedIds, []),
});
const withOps = (includedIds: number[], ops: Operation[]): OpsState => ({
  includedIds,
  previewHiddenIds: [],
  ops,
  entries: buildEntries(includedIds, ops),
});

test("autoMergeOps leaves the engine ops alone when nothing is merged yet", () => {
  expect(autoMergeOps(PLANE_OPS, fresh(AUTO_INC), AUTO_INC)).toEqual(PLANE_OPS);
});

test("autoMergeOps unmerges the targets first when they are already merged", () => {
  const pushed = autoMergeOps(PLANE_OPS, withOps(AUTO_INC, ROLE_OPS), AUTO_INC);
  expect(pushed[0]).toEqual({ op: "unmerge", layerIds: [1, 2, 3, 4, 5] });
});

test("autoMergeOps shifts merge ids past the merges already consumed", () => {
  const pushed = autoMergeOps(PLANE_OPS, withOps(AUTO_INC, ROLE_OPS), AUTO_INC);
  // ROLE_OPS의 merge 하나가 -1을 이미 썼으므로 새 병합은 -2, -3이다.
  expect(pushed.slice(1)).toEqual([
    { op: "merge", layerIds: [1, 5], name: "BG" },
    { op: "merge", layerIds: [2, 3, 4], name: "MG" },
    { op: "reorder", layerId: -2, aboveId: null },
    { op: "reorder", layerId: -3, aboveId: -2 },
  ]);
});

test("re-running auto-merge with another rule actually re-splits the layers", () => {
  const state = withOps(AUTO_INC, ROLE_OPS);
  expect(state.entries).toEqual([{ entryId: -1, sourceIds: [1, 2, 3, 4, 5], name: "BG" }]);

  const entries = buildEntries(AUTO_INC, [...state.ops, ...autoMergeOps(PLANE_OPS, state, AUTO_INC)]);
  expect(entries.map((e) => [e.name, e.sourceIds])).toEqual([
    ["BG", [1, 5]], // BG는 맨 아래
    ["MG", [2, 3, 4]],
  ]);
});

test("autoMergeOps only unmerges the layers it is about to re-merge", () => {
  // 3,4는 다른 병합에 묶여 있고 자동 병합 대상(1,2,5)에는 없다 — 건드리지 않는다.
  const state = withOps(AUTO_INC, [{ op: "merge", layerIds: [3, 4], name: "KEEP" }]);
  const pushed = autoMergeOps([{ op: "merge", layerIds: [1, 2, 5], name: "BG" }], state, [1, 2, 5]);
  expect(pushed).toEqual([{ op: "merge", layerIds: [1, 2, 5], name: "BG" }]);
  const entries = buildEntries(AUTO_INC, [...state.ops, ...pushed]);
  expect(entries.find((e) => e.name === "KEEP")?.sourceIds).toEqual([3, 4]);
  expect(entries.find((e) => e.name === "BG")?.sourceIds).toEqual([1, 2, 5]);
});

test("unmerging several layers at once keeps their order, so re-merging restacks them the same", () => {
  const entries = buildEntries(INC, [...MERGE_THREE, { op: "unmerge", layerIds: [3, 4, 5] }]);
  expect(ids(entries)).toEqual([3, 4, 5]); // index 0 = 맨 아래
  const remerged = buildEntries(INC, [
    ...MERGE_THREE,
    { op: "unmerge", layerIds: [3, 4, 5] },
    { op: "merge", layerIds: [3, 4, 5], name: "BG" },
  ]);
  expect(remerged[0].sourceIds).toEqual([3, 4, 5]);
});

test("autoMergeOps restacks the same way no matter what order the panel lists its targets", () => {
  const state = withOps(AUTO_INC, ROLE_OPS);
  const replay = (targets: number[]) =>
    buildEntries(AUTO_INC, [...state.ops, ...autoMergeOps(PLANE_OPS, state, targets)]);
  expect(replay([...AUTO_INC].reverse())).toEqual(replay(AUTO_INC));
  expect(replay([...AUTO_INC].reverse()).map((e) => e.sourceIds)).toEqual([[1, 5], [2, 3, 4]]);
});
