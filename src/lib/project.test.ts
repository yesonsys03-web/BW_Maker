import { expect, test } from "vitest";
import { parseProject, previewFileName, serializeProject, type ProjectFile } from "./project";

const OPS = {
  includedIds: [1, 2], previewHiddenIds: [2], soloIds: [], edgeColourIds: [3],
  manualLineIds: [4], ops: [], entries: [],
};

const TREE = [{
  id: 1, name: "line", kind: "pixel", visible: true, opacity: 255,
  blendMode: "normal", bbox: [0, 0, 10, 10], hasMask: false, hasPixels: true, path: ["line"],
}];

function projectOf(): ProjectFile {
  return {
    version: 1,
    preset: null,
    files: [{
      path: "/cuts/a.psd", mtime: 1700, tree: TREE as never, matchedIds: [1],
      ops: OPS as never, previewKey: "k", previewFile: "abc.png",
    }],
  };
}

test("a project survives a round trip unchanged", () => {
  const back = parseProject(serializeProject(projectOf()));
  expect(back).toEqual(projectOf());
});

// 조용히 기본값으로 바꿔치기하면, 파일에 적힌 것과 다른 상태로 작업이 이어진다.
test("a file entry with no mtime is refused", () => {
  const p = projectOf() as unknown as { files: Record<string, unknown>[] };
  delete p.files[0].mtime;
  expect(() => parseProject(JSON.stringify(p))).toThrow(/mtime/);
});

test("an unknown version is refused", () => {
  const p = { ...projectOf(), version: 2 };
  expect(() => parseProject(JSON.stringify(p))).toThrow(/version/);
});

// 납품 파일명은 기밀이라 디스크에 남으면 안 된다.
test("the preview file name leaks nothing from the key", () => {
  const name = previewFileName("/Volumes/x/HH03_SECRET.psd\n1700\ncomposite");
  expect(name).toMatch(/^[0-9a-f]{16}\.png$/);
  expect(name).not.toContain("HH03");
});

test("the same key always makes the same preview file name", () => {
  expect(previewFileName("k")).toBe(previewFileName("k"));
  expect(previewFileName("k")).not.toBe(previewFileName("k2"));
});
