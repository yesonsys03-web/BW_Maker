import { beforeEach, expect, test, vi } from "vitest";

// 목 대상은 plugin-fs가 아니라 `invoke`다. projectFs가 Rust 커맨드로 디스크에
// 닿기 때문이다(이유는 src-tauri/src/project_fs.rs 맨 위). invoke는 커맨드
// 이름으로 갈라지므로, 커맨드별 응답을 주는 작은 디스패처를 둔다.
const cmd = vi.hoisted(() => ({
  project_make_dir: vi.fn(),
  project_read_text: vi.fn(),
  project_write_text: vi.fn(),
  project_write_b64: vi.fn(),
  read_file_b64: vi.fn(),
  paths_exist: vi.fn(),
}));
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
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
  cmd.project_make_dir.mockResolvedValue(undefined);
  cmd.project_write_text.mockResolvedValue(undefined);
  cmd.project_write_b64.mockResolvedValue(undefined);
  cmd.read_file_b64.mockResolvedValue("AAA=");
  cmd.paths_exist.mockImplementation(async ({ paths }: { paths: string[] }) => paths.map(() => true));
  invoke.mockImplementation(async (name: keyof typeof cmd, args: unknown) => {
    const handler = cmd[name];
    if (!handler) throw new Error(`unexpected command: ${name}`);
    return handler(args);
  });
});

test("saving writes project.json and every preview into previews/", async () => {
  await saveProjectTo("/p/x.bwproj", PROJECT, new Map([[VALID_HASH, "data:image/png;base64,AAA="]]));

  expect(cmd.project_write_text).toHaveBeenCalledWith({
    path: "/p/x.bwproj/project.json",
    contents: expect.stringContaining('"version": 1'),
  });
  expect(cmd.project_write_b64).toHaveBeenCalledWith({
    path: `/p/x.bwproj/previews/${VALID_HASH}`,
    b64: "AAA=",
  });
  // previews/ 디렉토리가 만들어져야 한다. 이 줄이 없으면 첫 저장이 "그런
  // 디렉터리 없음"으로 실패하는데 다른 테스트는 아무도 안 깨진다.
  expect(cmd.project_make_dir).toHaveBeenCalledWith({ path: "/p/x.bwproj/previews" });
});

test("loading returns the project and the previews it found", async () => {
  cmd.project_read_text.mockResolvedValue(JSON.stringify(PROJECT));

  const { project, previews } = await loadProjectFrom("/p/x.bwproj");

  expect(project.files[0].path).toBe("/cuts/a.psd");
  expect(previews.get(VALID_HASH)).toMatch(/^data:image\/png;base64,/);
});

// 그림이 없어졌다고 작업까지 버리면 안 된다 — 그림은 다시 만들 수 있고 판단은 못 만든다.
test("a missing preview loses the picture, not the work", async () => {
  cmd.project_read_text.mockResolvedValue(JSON.stringify(PROJECT));
  cmd.paths_exist.mockImplementation(async ({ paths }: { paths: string[] }) =>
    paths.map((p) => !p.endsWith(VALID_HASH)));

  const { project, previews } = await loadProjectFrom("/p/x.bwproj");

  expect(project.files).toHaveLength(1);
  expect(previews.size).toBe(0);
  // 없는 파일을 읽으러 가지도 않아야 한다 — Rust 쪽 read_file_b64는 던진다.
  expect(cmd.read_file_b64).not.toHaveBeenCalled();
});

test("rejecting non-hash preview names prevents confidential leaks", async () => {
  const nonHashName = "actual-psd-path.png";
  await expect(
    saveProjectTo("/p/x.bwproj", PROJECT, new Map([[nonHashName, "data:image/png;base64,AAA="]]))
  ).rejects.toThrow(/16자 16진소문자/);
  // 이름은 개수로만 말한다. 이름 자체가 새면 검사한 의미가 없다.
  await expect(
    saveProjectTo("/p/x.bwproj", PROJECT, new Map([[nonHashName, "data:image/png;base64,AAA="]]))
  ).rejects.not.toThrow(new RegExp(nonHashName));
  expect(cmd.project_write_b64).not.toHaveBeenCalled();
});

test("accepting valid hash preview names", async () => {
  // 여러 유효한 해시
  const validHashes = new Map([
    ["0011223344556677.png", "data:image/png;base64,AAA="],
    ["aabbccddeeff0011.png", "data:image/png;base64,BBB="],
  ]);

  await saveProjectTo("/p/x.bwproj", PROJECT, validHashes);

  expect(cmd.project_write_b64).toHaveBeenCalledTimes(2);
  expect(cmd.project_write_b64).toHaveBeenCalledWith({
    path: "/p/x.bwproj/previews/0011223344556677.png", b64: "AAA=",
  });
  expect(cmd.project_write_b64).toHaveBeenCalledWith({
    path: "/p/x.bwproj/previews/aabbccddeeff0011.png", b64: "BBB=",
  });
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

  cmd.project_read_text.mockResolvedValue(JSON.stringify(projectWithNullPreview));

  const { project, previews } = await loadProjectFrom("/p/x.bwproj");

  expect(project.files).toHaveLength(1);
  expect(project.files[0].path).toBe("/cuts/b.psd");
  expect(previews.size).toBe(0);
});

// 이 모듈이 plugin-fs로 되돌아가면 실제 앱에서 100% 실패한다(AppData 밖은
// PathForbidden). 목이 그 실패를 가려주므로 여기서 못을 박아 둔다.
test("disk access goes through Rust commands, never plugin-fs", async () => {
  cmd.project_read_text.mockResolvedValue(JSON.stringify(PROJECT));
  await saveProjectTo("/p/x.bwproj", PROJECT, new Map([[VALID_HASH, "data:image/png;base64,AAA="]]));
  await loadProjectFrom("/p/x.bwproj");

  for (const name of invoke.mock.calls.map((c) => c[0])) {
    expect(Object.keys(cmd)).toContain(name);
  }
  expect(invoke).toHaveBeenCalled();
});
