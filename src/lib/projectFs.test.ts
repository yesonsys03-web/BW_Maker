import { beforeEach, expect, test, vi } from "vitest";

const fs = vi.hoisted(() => ({
  exists: vi.fn(), mkdir: vi.fn(), readTextFile: vi.fn(),
  writeTextFile: vi.fn(), readFile: vi.fn(), writeFile: vi.fn(), remove: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-fs", () => fs);
vi.mock("@tauri-apps/api/path", () => ({ join: async (...p: string[]) => p.join("/") }));

import { loadProjectFrom, saveProjectTo } from "./projectFs";
import type { ProjectFile } from "./project";

const PROJECT: ProjectFile = {
  version: 1, preset: null,
  files: [{
    path: "/cuts/a.psd", mtime: 1700, tree: [], matchedIds: [1],
    ops: { includedIds: [1], previewHiddenIds: [], soloIds: [], edgeColourIds: [], manualLineIds: [], ops: [], entries: [] } as never,
    previewKey: "k", previewFile: "aa.png",
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
  await saveProjectTo("/p/x.bwproj", PROJECT, new Map([["aa.png", "data:image/png;base64,AAA="]]));

  expect(fs.writeTextFile).toHaveBeenCalledWith("/p/x.bwproj/project.json", expect.stringContaining('"version": 1'));
  expect(fs.writeFile).toHaveBeenCalledWith("/p/x.bwproj/previews/aa.png", expect.any(Uint8Array));
});

test("loading returns the project and the previews it found", async () => {
  fs.readTextFile.mockResolvedValue(JSON.stringify(PROJECT));
  fs.readFile.mockResolvedValue(new Uint8Array([0, 1, 2]));

  const { project, previews } = await loadProjectFrom("/p/x.bwproj");

  expect(project.files[0].path).toBe("/cuts/a.psd");
  expect(previews.get("aa.png")).toMatch(/^data:image\/png;base64,/);
});

// 그림이 없어졌다고 작업까지 버리면 안 된다 — 그림은 다시 만들 수 있고 판단은 못 만든다.
test("a missing preview loses the picture, not the work", async () => {
  fs.readTextFile.mockResolvedValue(JSON.stringify(PROJECT));
  fs.exists.mockImplementation(async (p: string) => !p.endsWith("aa.png"));

  const { project, previews } = await loadProjectFrom("/p/x.bwproj");

  expect(project.files).toHaveLength(1);
  expect(previews.size).toBe(0);
});
