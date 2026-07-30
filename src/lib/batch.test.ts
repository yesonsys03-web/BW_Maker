import { expect, test } from "vitest";
import { findConflicts, planBatchOutputs } from "./batch";

test("planBatchOutputs with outputDir null puts each output next to its source (defaultExportPath semantics)", () => {
  const result = planBatchOutputs(["/a/b/one.psd", "/a/c/two.psd"], null, "_LINE");
  expect(result).toEqual([
    { path: "/a/b/one.psd", outputPath: "/a/b/one_LINE.psd" },
    { path: "/a/c/two.psd", outputPath: "/a/c/two_LINE.psd" },
  ]);
});

test("planBatchOutputs with an outputDir places every output there, keyed by source stem", () => {
  const result = planBatchOutputs(["/a/b/one.psd", "/x/y/two.psd"], "/out/dir", "_LINE");
  expect(result).toEqual([
    { path: "/a/b/one.psd", outputPath: "/out/dir/one_LINE.psd" },
    { path: "/x/y/two.psd", outputPath: "/out/dir/two_LINE.psd" },
  ]);
});

test("planBatchOutputs handles an outputDir with a trailing separator", () => {
  const result = planBatchOutputs(["/a/one.psd"], "/out/dir/", "_LINE");
  expect(result).toEqual([{ path: "/a/one.psd", outputPath: "/out/dir/one_LINE.psd" }]);
});

test("planBatchOutputs preserves windows separators in the outputDir", () => {
  const result = planBatchOutputs(["/a/one.psd"], "C:\\out", "_LINE");
  expect(result).toEqual([{ path: "/a/one.psd", outputPath: "C:\\out\\one_LINE.psd" }]);
});

test("findConflicts returns only the output paths that already exist, via the injected existsFn", async () => {
  const planned = [
    { path: "/a/one.psd", outputPath: "/a/one_LINE.psd" },
    { path: "/a/two.psd", outputPath: "/a/two_LINE.psd" },
    { path: "/a/three.psd", outputPath: "/a/three_LINE.psd" },
  ];
  const existing = new Set(["/a/one_LINE.psd", "/a/three_LINE.psd"]);
  const existsFn = async (p: string) => existing.has(p);

  const conflicts = await findConflicts(planned, existsFn);

  expect(conflicts).toEqual(["/a/one_LINE.psd", "/a/three_LINE.psd"]);
});

test("findConflicts returns an empty array when nothing conflicts", async () => {
  const planned = [{ path: "/a/one.psd", outputPath: "/a/one_LINE.psd" }];
  const conflicts = await findConflicts(planned, async () => false);
  expect(conflicts).toEqual([]);
});

test("findConflicts calls existsFn once per planned output", async () => {
  const planned = [
    { path: "/a/one.psd", outputPath: "/a/one_LINE.psd" },
    { path: "/a/two.psd", outputPath: "/a/two_LINE.psd" },
  ];
  const calls: string[] = [];
  const existsFn = async (p: string) => {
    calls.push(p);
    return false;
  };
  await findConflicts(planned, existsFn);
  expect(calls).toEqual(["/a/one_LINE.psd", "/a/two_LINE.psd"]);
});
