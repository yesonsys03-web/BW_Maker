import { beforeEach, expect, test, vi } from "vitest";

const fs = vi.hoisted(() => ({
  exists: vi.fn(), mkdir: vi.fn(), readTextFile: vi.fn(),
  writeTextFile: vi.fn(), readFile: vi.fn(), writeFile: vi.fn(), remove: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-fs", () => fs);
vi.mock("@tauri-apps/api/path", () => ({ join: async (...p: string[]) => p.join("/") }));

import { loadProjectFrom, saveProjectTo } from "./projectFs";
import type { ProjectFile } from "./project";

// 유효한 해시 이름: 16자 16진소문자 + ".png"
const VALID_HASH = "0011223344556677.png";

const PROJECT: ProjectFile = {
  version: 1, preset: null,
  files: [{
    path: "/cuts/a.psd", mtime: 1700, tree: [], matchedIds: [1],
    ops: { includedIds: [1], previewHiddenIds: [], soloIds: [], edgeColourIds: [], manualLineIds: [], ops: [], entries: [] } as never,
    previewKey: "k", previewFile: VALID_HASH,
  }],
};

beforeEach(() => {
  vi.clearAllMocks();
  fs.mkdir.mockResolvedValue(undefined);
  fs.writeTextFile.mockResolvedValue(undefined);
  fs.writeFile.mockResolvedValue(undefined);
  fs.exists.mockResolvedValue(true);
});

test("saving writes project.json and every preview into previews/", async () => {
  await saveProjectTo("/p/x.bwproj", PROJECT, new Map([[VALID_HASH, "data:image/png;base64,AAA="]]));

  expect(fs.writeTextFile).toHaveBeenCalledWith("/p/x.bwproj/project.json", expect.stringContaining('"version": 1'));
  expect(fs.writeFile).toHaveBeenCalledWith(`/p/x.bwproj/previews/${VALID_HASH}`, expect.any(Uint8Array));
  // previews/ 디렉토리가 mkdir 호출로 생성되어야 한다
  expect(fs.mkdir).toHaveBeenCalledWith("/p/x.bwproj/previews", { recursive: true });
});

test("loading returns the project and the previews it found", async () => {
  fs.readTextFile.mockResolvedValue(JSON.stringify(PROJECT));
  fs.readFile.mockResolvedValue(new Uint8Array([0, 1, 2]));

  const { project, previews } = await loadProjectFrom("/p/x.bwproj");

  expect(project.files[0].path).toBe("/cuts/a.psd");
  expect(previews.get(VALID_HASH)).toMatch(/^data:image\/png;base64,/);
});

// 그림이 없어졌다고 작업까지 버리면 안 된다 — 그림은 다시 만들 수 있고 판단은 못 만든다.
test("a missing preview loses the picture, not the work", async () => {
  fs.readTextFile.mockResolvedValue(JSON.stringify(PROJECT));
  fs.exists.mockImplementation(async (p: string) => !p.endsWith(VALID_HASH));

  const { project, previews } = await loadProjectFrom("/p/x.bwproj");

  expect(project.files).toHaveLength(1);
  expect(previews.size).toBe(0);
});

test("rejecting non-hash preview names prevents confidential leaks", async () => {
  const nonHashName = "actual-psd-path.png";
  expect(
    saveProjectTo("/p/x.bwproj", PROJECT, new Map([[nonHashName, "data:image/png;base64,AAA="]]))
  ).rejects.toThrow(/16자 16진소문자/);
});

test("accepting valid hash preview names", async () => {
  // 여러 유효한 해시
  const validHashes = new Map([
    ["0011223344556677.png", "data:image/png;base64,AAA="],
    ["aabbccddeeff0011.png", "data:image/png;base64,BBB="],
  ]);

  await saveProjectTo("/p/x.bwproj", PROJECT, validHashes);

  expect(fs.writeFile).toHaveBeenCalledTimes(2);
  expect(fs.writeFile).toHaveBeenCalledWith("/p/x.bwproj/previews/0011223344556677.png", expect.any(Uint8Array));
  expect(fs.writeFile).toHaveBeenCalledWith("/p/x.bwproj/previews/aabbccddeeff0011.png", expect.any(Uint8Array));
});

test("loading with null previewFile still loads the work", async () => {
  const projectWithNullPreview: ProjectFile = {
    version: 1, preset: null,
    files: [{
      path: "/cuts/b.psd", mtime: 1800, tree: [], matchedIds: [2],
      ops: { includedIds: [2], previewHiddenIds: [], soloIds: [], edgeColourIds: [], manualLineIds: [], ops: [], entries: [] } as never,
      previewKey: null, previewFile: null,
    }],
  };

  fs.readTextFile.mockResolvedValue(JSON.stringify(projectWithNullPreview));

  const { project, previews } = await loadProjectFrom("/p/x.bwproj");

  expect(project.files).toHaveLength(1);
  expect(project.files[0].path).toBe("/cuts/b.psd");
  expect(previews.size).toBe(0);
});
