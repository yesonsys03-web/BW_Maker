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

// 이하는 검증 가드들이 진짜 작동하는지 확인하는 테스트. 각각 특정 필드를
// 망가뜨려서 그 가드가 거절하는지 확인한다.
// 주의: 각 테스트는 projectOf()를 JSON으로 직렬화해서 복사본을 만든 후 수정한다.

test("path not a string is refused", () => {
  const p = JSON.parse(JSON.stringify(projectOf())) as Record<string, unknown>;
  (p.files as Record<string, unknown>[])[0].path = 123;
  expect(() => parseProject(JSON.stringify(p))).toThrow(/path/);
});

test("tree not an array is refused", () => {
  const p = JSON.parse(JSON.stringify(projectOf())) as Record<string, unknown>;
  (p.files as Record<string, unknown>[])[0].tree = "not an array";
  expect(() => parseProject(JSON.stringify(p))).toThrow(/tree.*배열/);
});

test("tree node without id is refused", () => {
  const p = JSON.parse(JSON.stringify(projectOf())) as Record<string, unknown>;
  const node = { name: "x", kind: "pixel" };
  (p.files as Record<string, unknown>[])[0].tree = [node];
  expect(() => parseProject(JSON.stringify(p))).toThrow(/\.id/);
});

test("tree node without name is refused", () => {
  const p = JSON.parse(JSON.stringify(projectOf())) as Record<string, unknown>;
  const node = { id: 1, kind: "pixel" };
  (p.files as Record<string, unknown>[])[0].tree = [node];
  expect(() => parseProject(JSON.stringify(p))).toThrow(/\.name/);
});

test("tree node without kind is refused", () => {
  const p = JSON.parse(JSON.stringify(projectOf())) as Record<string, unknown>;
  const node = { id: 1, name: "x" };
  (p.files as Record<string, unknown>[])[0].tree = [node];
  expect(() => parseProject(JSON.stringify(p))).toThrow(/\.kind/);
});

test("tree node with child without id is refused", () => {
  const p = JSON.parse(JSON.stringify(projectOf())) as Record<string, unknown>;
  const node = {
    id: 1, name: "x", kind: "pixel",
    children: [{ name: "y", kind: "pixel" }],
  };
  (p.files as Record<string, unknown>[])[0].tree = [node];
  expect(() => parseProject(JSON.stringify(p))).toThrow(/children\[0\]\.id/);
});

test("matchedIds not a number array is refused", () => {
  const p = JSON.parse(JSON.stringify(projectOf())) as Record<string, unknown>;
  (p.files as Record<string, unknown>[])[0].matchedIds = ["not", "numbers"];
  expect(() => parseProject(JSON.stringify(p))).toThrow(/matchedIds/);
});

test("includedIds not a number array is refused", () => {
  const p = JSON.parse(JSON.stringify(projectOf())) as Record<string, unknown>;
  const ops = ((p.files as Record<string, unknown>[])[0].ops as Record<string, unknown>);
  ops.includedIds = "not an array";
  expect(() => parseProject(JSON.stringify(p))).toThrow(/includedIds/);
});

test("previewHiddenIds not a number array is refused", () => {
  const p = JSON.parse(JSON.stringify(projectOf())) as Record<string, unknown>;
  const ops = ((p.files as Record<string, unknown>[])[0].ops as Record<string, unknown>);
  ops.previewHiddenIds = [1, "not a number"];
  expect(() => parseProject(JSON.stringify(p))).toThrow(/previewHiddenIds/);
});

test("soloIds not a number array is refused", () => {
  const p = JSON.parse(JSON.stringify(projectOf())) as Record<string, unknown>;
  const ops = ((p.files as Record<string, unknown>[])[0].ops as Record<string, unknown>);
  ops.soloIds = null;
  expect(() => parseProject(JSON.stringify(p))).toThrow(/soloIds/);
});

test("edgeColourIds not a number array is refused", () => {
  const p = JSON.parse(JSON.stringify(projectOf())) as Record<string, unknown>;
  const ops = ((p.files as Record<string, unknown>[])[0].ops as Record<string, unknown>);
  ops.edgeColourIds = 42;
  expect(() => parseProject(JSON.stringify(p))).toThrow(/edgeColourIds/);
});

test("manualLineIds not a number array is refused", () => {
  const p = JSON.parse(JSON.stringify(projectOf())) as Record<string, unknown>;
  const ops = ((p.files as Record<string, unknown>[])[0].ops as Record<string, unknown>);
  ops.manualLineIds = { not: "array" };
  expect(() => parseProject(JSON.stringify(p))).toThrow(/manualLineIds/);
});

test("ops.ops not an array is refused", () => {
  const p = JSON.parse(JSON.stringify(projectOf())) as Record<string, unknown>;
  const ops = ((p.files as Record<string, unknown>[])[0].ops as Record<string, unknown>);
  ops.ops = "not an array";
  expect(() => parseProject(JSON.stringify(p))).toThrow(/ops\.ops/);
});

test("ops.entries not an array is refused", () => {
  const p = JSON.parse(JSON.stringify(projectOf())) as Record<string, unknown>;
  const ops = ((p.files as Record<string, unknown>[])[0].ops as Record<string, unknown>);
  ops.entries = 123;
  expect(() => parseProject(JSON.stringify(p))).toThrow(/entries/);
});

test("previewKey neither null nor string is refused", () => {
  const p = JSON.parse(JSON.stringify(projectOf())) as Record<string, unknown>;
  (p.files as Record<string, unknown>[])[0].previewKey = 123;
  expect(() => parseProject(JSON.stringify(p))).toThrow(/previewKey/);
});

test("previewFile neither null nor string is refused", () => {
  const p = JSON.parse(JSON.stringify(projectOf())) as Record<string, unknown>;
  (p.files as Record<string, unknown>[])[0].previewFile = false;
  expect(() => parseProject(JSON.stringify(p))).toThrow(/previewFile/);
});

test("top-level not an object is refused", () => {
  expect(() => parseProject("123")).toThrow(/객체/);
});

test("files not an array is refused", () => {
  const p = JSON.parse(JSON.stringify(projectOf())) as Record<string, unknown>;
  p.files = "not an array";
  expect(() => parseProject(JSON.stringify(p))).toThrow(/files.*배열/);
});

test("invalid preset is refused", () => {
  const p = JSON.parse(JSON.stringify(projectOf())) as Record<string, unknown>;
  p.preset = "not a preset";
  expect(() => parseProject(JSON.stringify(p))).toThrow(/preset/);
});

test("preset can be null", () => {
  const p = JSON.parse(JSON.stringify(projectOf())) as unknown as ProjectFile;
  p.preset = null;
  const serialized = JSON.stringify(p);
  const back = parseProject(serialized);
  expect(back.preset).toBeNull();
});

import { reconcileProject } from "./project";

function entryAt(path: string, mtime: number) {
  return {
    path, mtime, tree: [], matchedIds: [], previewKey: "k", previewFile: "a.png",
    ops: { includedIds: [], previewHiddenIds: [], soloIds: [], edgeColourIds: [], manualLineIds: [], ops: [], entries: [] },
  } as never;
}

test("a file whose mtime still matches keeps its work", () => {
  const p = { version: 1 as const, preset: null, files: [entryAt("/a.psd", 1700)] };
  const { fresh, stale } = reconcileProject(p, { "/a.psd": 1700 });
  expect(fresh.map((e) => e.path)).toEqual(["/a.psd"]);
  expect(stale).toEqual([]);
});

// 저장된 것은 전부 레이어 id이고, PSD가 바뀌면 id가 밀린다. 조용히 붙이면
// "라인 지정"이 엉뚱한 레이어를 가리킨다.
test("a file that was saved in Photoshop since loses its work and is named", () => {
  const p = { version: 1 as const, preset: null, files: [entryAt("/a.psd", 1700)] };
  const { fresh, stale } = reconcileProject(p, { "/a.psd": 1800 });
  expect(fresh).toEqual([]);
  expect(stale).toEqual(["/a.psd"]);
});

test("a file that is gone from disk is stale too", () => {
  const p = { version: 1 as const, preset: null, files: [entryAt("/a.psd", 1700)] };
  const { stale } = reconcileProject(p, {});
  expect(stale).toEqual(["/a.psd"]);
});

// engine이 float을 저장하지만 디스크 조회는 int로 돌아온다.
// 초 단위로 비교해야 한다.
test("a stored float mtime against a truncated int from disk keeps its work", () => {
  const p = { version: 1 as const, preset: null, files: [entryAt("/a.psd", 1700.7873118)] };
  const { fresh, stale } = reconcileProject(p, { "/a.psd": 1700 });
  expect(fresh.map((e) => e.path)).toEqual(["/a.psd"]);
  expect(stale).toEqual([]);
});

test("a stored float mtime against a genuinely different second loses its work", () => {
  const p = { version: 1 as const, preset: null, files: [entryAt("/a.psd", 1700.7873118)] };
  const { fresh, stale } = reconcileProject(p, { "/a.psd": 1701 });
  expect(fresh).toEqual([]);
  expect(stale).toEqual(["/a.psd"]);
});

test("a duplicate path in project.files is rejected at parse time", () => {
  const p = { version: 1 as const, preset: null, files: [entryAt("/a.psd", 1700), entryAt("/a.psd", 1800)] };
  const path = "/a.psd";
  expect(() => parseProject(JSON.stringify(p))).toThrow(/files\[\d+\].*중복된 경로/);
  try {
    parseProject(JSON.stringify(p));
  } catch (e) {
    // 에러 메시지가 기밀 파일명을 드러내지 않아야 한다.
    expect(String(e)).not.toContain(path);
  }
});

import { previewCacheKey } from "./previewCache";
import { restorablePreviews } from "./project";

const LEAF = {
  id: 1, name: "line", kind: "pixel", visible: true, opacity: 255, blendMode: "normal",
  bbox: [0, 0, 4, 4], hasMask: false, hasPixels: true, path: ["line"],
};

function entryWithRealKey() {
  const tree = [LEAF] as never;
  const ops = {
    includedIds: [1], previewHiddenIds: [], soloIds: [], edgeColourIds: [],
    manualLineIds: [], ops: [], entries: [],
  };
  const key = previewCacheKey(
    { path: "/cuts/a.psd", mtime: 1700 }, true, [1], null, [1], null, [], [1]
  );
  return {
    path: "/cuts/a.psd", mtime: 1700, tree, matchedIds: [1], ops: ops as never,
    previewKey: key, previewFile: "a.png",
  };
}

test("a preview whose key still comes out the same is restorable", () => {
  const out = restorablePreviews(
    [entryWithRealKey() as never],
    new Map([["a.png", "data:image/png;base64,AAA="]]),
    null, null
  );
  expect(out).toHaveLength(1);
  expect(out[0][1]).toBe("data:image/png;base64,AAA=");
});

// 저장과 복원 사이에 키 구성이 바뀌면(앱 업데이트로 항목이 늘어나는 일은 실제로
// 있었다) 옛 그림을 붙이면 안 된다 — 아티스트가 지금 설정과 다른 그림을 보면서
// 확인했다고 믿게 된다.
test("a preview whose stored key no longer matches is dropped", () => {
  const e = { ...entryWithRealKey(), previewKey: "저장될 때의 옛 키" };
  const out = restorablePreviews(
    [e as never], new Map([["a.png", "data:image/png;base64,AAA="]]), null, null
  );
  expect(out).toEqual([]);
});

test("an entry whose PNG is gone is dropped without throwing", () => {
  const out = restorablePreviews([entryWithRealKey() as never], new Map(), null, null);
  expect(out).toEqual([]);
});
