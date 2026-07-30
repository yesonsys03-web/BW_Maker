import { expect, test } from "vitest";
import { buildEntries, opsReducer, OpsState } from "./opsReducer";

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

test("undo recomputes entries", () => {
  let s: OpsState = opsReducer(undefined as never, { type: "reset", includedIds: INC });
  s = opsReducer(s, { type: "pushOp", op: { op: "flatten", name: "F" } });
  expect(ids(s.entries)).toEqual([-1]);
  s = opsReducer(s, { type: "undo" });
  expect(ids(s.entries)).toEqual([3, 4, 5]);
});
