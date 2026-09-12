import { expect, it, test } from "vitest";
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

test("planBatchOutputs preserves a .psb source extension, with or without an outputDir", () => {
  expect(planBatchOutputs(["/a/b/one.psb"], null, "_LINE")).toEqual([
    { path: "/a/b/one.psb", outputPath: "/a/b/one_LINE.psb" },
  ]);
  expect(planBatchOutputs(["/a/b/one.psb"], "/out/dir", "_LINE")).toEqual([
    { path: "/a/b/one.psb", outputPath: "/out/dir/one_LINE.psb" },
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

it("plans batch outputs with the chosen format", () => {
  expect(planBatchOutputs(["/x/a.psb"], null, "_LINE", "png")).toEqual([
    { path: "/x/a.psb", outputPath: "/x/a_LINE.png" },
  ]);
  expect(planBatchOutputs(["/x/a.psd"], "/out", "_LINE", "jpg")).toEqual([
    { path: "/x/a.psd", outputPath: "/out/a_LINE.jpg" },
  ]);
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

test("planBatchOutputs numbers colliding names in a shared output folder", () => {
  expect(planBatchOutputs(
    [
      "/show/a/shot.psd",
      "/archive/b/shot.psd",
      "/show/c/shot.psd",
      "/show/d/other.psd",
    ],
    "/out",
    "_LINE",
    "png"
  )).toEqual([
    { path: "/show/a/shot.psd", outputPath: "/out/shot_LINE.png" },
    {
      path: "/archive/b/shot.psd",
      outputPath: "/out/shot_LINE_1.png",
      outputSuffix: "_LINE_1",
    },
    {
      path: "/show/c/shot.psd",
      outputPath: "/out/shot_LINE_2.png",
      outputSuffix: "_LINE_2",
    },
    { path: "/show/d/other.psd", outputPath: "/out/other_LINE.png" },
  ]);
});

test("planBatchOutputs keeps equal basenames beside their own sources", () => {
  expect(planBatchOutputs(
    ["/show/a/shot.psd", "/archive/b/shot.psd"],
    null,
    "_LINE",
    "png"
  )).toEqual([
    { path: "/show/a/shot.psd", outputPath: "/show/a/shot_LINE.png" },
    { path: "/archive/b/shot.psd", outputPath: "/archive/b/shot_LINE.png" },
  ]);
});
