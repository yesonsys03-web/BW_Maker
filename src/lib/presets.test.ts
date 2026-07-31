import { beforeEach, expect, test, vi } from "vitest";

const appDataDirMock = vi.fn();
const joinMock = vi.fn();
vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: (...a: unknown[]) => appDataDirMock(...a),
  join: (...a: unknown[]) => joinMock(...a),
}));

const existsMock = vi.fn();
const mkdirMock = vi.fn();
const readTextFileMock = vi.fn();
const writeTextFileMock = vi.fn();
vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: (...a: unknown[]) => existsMock(...a),
  mkdir: (...a: unknown[]) => mkdirMock(...a),
  readTextFile: (...a: unknown[]) => readTextFileMock(...a),
  writeTextFile: (...a: unknown[]) => writeTextFileMock(...a),
}));

import { DEFAULT_PRESET, isValidLineColor, loadPresets, savePresets } from "./presets";
import type { Preset } from "./types";

const APP_DATA_DIR = "/mock/appdata";
const FILE_PATH = "/mock/appdata/presets.json";

beforeEach(() => {
  appDataDirMock.mockReset();
  joinMock.mockReset();
  existsMock.mockReset();
  mkdirMock.mockReset();
  readTextFileMock.mockReset();
  writeTextFileMock.mockReset();

  appDataDirMock.mockResolvedValue(APP_DATA_DIR);
  joinMock.mockImplementation(async (...parts: string[]) => parts.join("/"));
});

test("DEFAULT_PRESET matches the brief contract", () => {
  expect(DEFAULT_PRESET).toEqual({
    name: "line 추출",
    include: { type: "contains", value: "line", caseSensitive: false },
    excludeGroupPrefixes: ["-"],
    matchGroups: true,
    includeHidden: true,
    merge: "none",
    naming: "pathPrefix",
    outputSuffix: "_LINE",
    embedPreview: true,
    lineColor: null,          // 기본은 원본 레이어 색 유지
  });
});

test("loadPresets returns [DEFAULT_PRESET] when the file does not exist", async () => {
  existsMock.mockResolvedValue(false);
  const result = await loadPresets();
  expect(result).toEqual([DEFAULT_PRESET]);
  expect(readTextFileMock).not.toHaveBeenCalled();
});

test("loadPresets reads and parses existing JSON (round trip)", async () => {
  const stored: Preset[] = [DEFAULT_PRESET, { ...DEFAULT_PRESET, name: "second" }];
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify(stored));

  const result = await loadPresets();

  expect(result).toEqual(stored);
  expect(existsMock).toHaveBeenCalledWith(FILE_PATH);
  expect(readTextFileMock).toHaveBeenCalledWith(FILE_PATH);
});

test("loadPresets throws on corrupted JSON instead of absorbing the error", async () => {
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue("{not valid json");

  await expect(loadPresets()).rejects.toThrow();
});

test("loadPresets throws when the top-level JSON value is not an array", async () => {
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify(DEFAULT_PRESET)); // an object, not an array

  await expect(loadPresets()).rejects.toThrow(/배열/);
});

test("loadPresets throws when a stored preset is missing a required field (valid JSON, wrong shape)", async () => {
  const { excludeGroupPrefixes: _drop, ...broken } = DEFAULT_PRESET;
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([broken]));

  await expect(loadPresets()).rejects.toThrow(/excludeGroupPrefixes/);
});

test("loadPresets throws when a field has the wrong type/value (e.g. an invalid enum)", async () => {
  const broken = { ...DEFAULT_PRESET, merge: "bogus" };
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([broken]));

  await expect(loadPresets()).rejects.toThrow(/merge/);
});

test("loadPresets accepts a well-formed preset list and preserves every field exactly", async () => {
  const wellFormed: Preset = {
    name: "custom",
    include: { type: "regex", value: "^fx_", caseSensitive: true },
    excludeGroupPrefixes: ["_", "#"],
    matchGroups: false,
    includeHidden: false,
    merge: "perGroup",
    naming: "original",
    outputSuffix: "_FX",
    embedPreview: false,
    lineColor: "#1A2B3C",
  };
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([wellFormed]));

  await expect(loadPresets()).resolves.toEqual([wellFormed]);
});

test("savePresets ensures the app data directory exists then writes JSON", async () => {
  mkdirMock.mockResolvedValue(undefined);
  writeTextFileMock.mockResolvedValue(undefined);
  const list: Preset[] = [DEFAULT_PRESET];

  await savePresets(list);

  expect(mkdirMock).toHaveBeenCalledWith(APP_DATA_DIR, { recursive: true });
  expect(writeTextFileMock).toHaveBeenCalledWith(FILE_PATH, JSON.stringify(list, null, 2));
});

test("savePresets round-trips through loadPresets via a fake in-memory file", async () => {
  let stored: string | null = null;
  mkdirMock.mockResolvedValue(undefined);
  writeTextFileMock.mockImplementation(async (_path: string, data: string) => {
    stored = data;
  });
  existsMock.mockImplementation(async () => stored !== null);
  readTextFileMock.mockImplementation(async () => stored as string);

  const list: Preset[] = [{ ...DEFAULT_PRESET, name: "roundtrip" }];
  await savePresets(list);
  const loaded = await loadPresets();

  expect(loaded).toEqual(list);
});

test("savePresets propagates write errors instead of absorbing them", async () => {
  mkdirMock.mockResolvedValue(undefined);
  writeTextFileMock.mockRejectedValue(new Error("disk full"));

  await expect(savePresets([DEFAULT_PRESET])).rejects.toThrow("disk full");
});


// lineColor: 나중에 추가된 항목이라 구버전 presets.json에는 아예 없다.
test("loadPresets reads a preset saved before lineColor existed as keep-original", async () => {
  const { lineColor: _dropped, ...legacy } = DEFAULT_PRESET;
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([legacy]));

  const [loaded] = await loadPresets();
  expect(loaded.lineColor).toBeNull();
});

test("loadPresets keeps an explicit null lineColor", async () => {
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([{ ...DEFAULT_PRESET, lineColor: null }]));

  const [loaded] = await loadPresets();
  expect(loaded.lineColor).toBeNull();
});

test("loadPresets rejects a malformed lineColor rather than dropping it", async () => {
  // 조용히 null로 떨어뜨리면 색 통일이 빠진 채 배치가 돌아버린다.
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([{ ...DEFAULT_PRESET, lineColor: "black" }]));

  await expect(loadPresets()).rejects.toThrow(/lineColor/);
});

test("loadPresets rejects a shorthand hex lineColor", async () => {
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([{ ...DEFAULT_PRESET, lineColor: "#000" }]));

  await expect(loadPresets()).rejects.toThrow(/lineColor/);
});

test("isValidLineColor matches the engine's #RRGGBB rule", () => {
  expect(isValidLineColor("#000000")).toBe(true);
  expect(isValidLineColor("#1a2B3c")).toBe(true);
  expect(isValidLineColor("#FFF")).toBe(false);
  expect(isValidLineColor("000000")).toBe(false);
  expect(isValidLineColor("#GGGGGG")).toBe(false);
  expect(isValidLineColor("")).toBe(false);
});
