import { expect, test } from "vitest";
import { buildEntries, exportLabelsBySourceId, opsReducer, OpsState } from "./opsReducer";

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

test("unknown ref throws", () => {
  expect(() => buildEntries(INC, [{ op: "rename", layerId: 99, name: "x" }])).toThrow();
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
