import { beforeEach, expect, test, vi } from "vitest";
// 엔진 소스를 그대로 읽어 두 언어의 기본값을 대조한다(아래 마지막 테스트).
import edgesSource from "../../engine/psd_engine/edges.py?raw";

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

import { DEFAULT_EDGE_LINES, DEFAULT_PRESET, isValidLineColor, loadPresets, parsePresets, savePresets } from "./presets";
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
    roleTokens: ["UL", "OL_UL", "OL"],
    mergeRule: "role",
    splitLayers: false,       // 기본은 한 파일에 모두
    excludeTokens: ["col", "colour", "color"],  // line col 류는 색 지정이다
    outputFormat: "psd",      // 기본은 원본 따름
    // 기본은 꺼짐, width 0 = 자동, colourMode는 지금까지의 정확한 경로
    edgeLines: {
      enabled: false, threshold: 24, gap: 4, width: 0, minLength: 8, lineAlpha: 64,
      colourMode: "composite",
    },
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
    roleTokens: ["UL", "OL"],
    mergeRule: "group",
    naming: "original",
    outputSuffix: "_FX",
    embedPreview: false,
    lineColor: "#1A2B3C",
    splitLayers: true,
    outputFormat: "jpg",
    excludeTokens: ["fx", "temp"],
    // colourMode는 기본값이 아닌 쪽을 넣는다 — 기본값이면 파서가 메워 넣은 것과
    // 구분이 안 되어 "그대로 보존한다"를 실제로 재지 못한다.
    edgeLines: {
      enabled: true, threshold: 30, gap: 6, width: 7, minLength: 10, lineAlpha: 70,
      colourMode: "paste",
    },
  };
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([wellFormed]));

  await expect(loadPresets()).resolves.toEqual([wellFormed]);
});

test("a preset saved before colourMode existed loads with the composite path", async () => {
  // 이미 저장된 프리셋에는 이 키가 없다. 없는 채로 열렸을 때 예전 동작(정확한
  // 합성)으로 떨어져야 한다 — 여기서 paste로 떨어지면 아무도 고르지 않은 변경이
  // 조용히 적용된다.
  const old = {
    ...DEFAULT_PRESET,
    edgeLines: { enabled: true, threshold: 24, gap: 4, width: 0, minLength: 8, lineAlpha: 64 },
  };
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([old]));

  const loaded = await loadPresets();
  expect(loaded[0].edgeLines.colourMode).toBe("composite");
});

test("loadPresets rejects an unknown colourMode instead of guessing", async () => {
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([
    { ...DEFAULT_PRESET, edgeLines: { ...DEFAULT_PRESET.edgeLines, colourMode: "turbo" } },
  ]));

  await expect(loadPresets()).rejects.toThrow(/colourMode/);
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

// roleTokens: byRole 병합용. 이 항목이 생기기 전 파일에는 없다.
test("loadPresets fills in the default role tokens for a preset saved before they existed", async () => {
  const { roleTokens: _dropped, ...legacy } = DEFAULT_PRESET;
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([legacy]));

  const [loaded] = await loadPresets();
  expect(loaded.roleTokens).toEqual(["UL", "OL_UL", "OL"]);
});

test("loadPresets keeps a custom role token order, since it sets the stacking order", async () => {
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([{ ...DEFAULT_PRESET, roleTokens: ["OL", "UL"] }]));

  const [loaded] = await loadPresets();
  expect(loaded.roleTokens).toEqual(["OL", "UL"]);
});

test("loadPresets rejects role tokens that are not a string array", async () => {
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([{ ...DEFAULT_PRESET, roleTokens: "UL,OL" }]));

  await expect(loadPresets()).rejects.toThrow(/roleTokens/);
});

test("loadPresets accepts the byElement merge mode", async () => {
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([{ ...DEFAULT_PRESET, merge: "byElement" }]));

  const [loaded] = await loadPresets();
  expect(loaded.merge).toBe("byElement");
});

test("loadPresets migrates the short-lived byRole mode to byElement", async () => {
  // byRole은 요소별 병합으로 대체되기 전 잠깐 존재했다. 그 사이에 저장된
  // 프리셋이 로드에서 튕기면 사용자는 이유도 모른 채 프리셋을 잃는다.
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([{ ...DEFAULT_PRESET, merge: "byRole" }]));

  const [loaded] = await loadPresets();
  expect(loaded.merge).toBe("byElement");
});

// splitLayers: 레이어별 분리 내보내기. 이 항목이 생기기 전 파일에는 없다.
test("loadPresets reads a preset saved before splitLayers existed as one-file", async () => {
  const { splitLayers: _dropped, ...legacy } = DEFAULT_PRESET;
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([legacy]));

  const [loaded] = await loadPresets();
  expect(loaded.splitLayers).toBe(false);
});

test("loadPresets keeps splitLayers when it is set", async () => {
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([{ ...DEFAULT_PRESET, splitLayers: true }]));

  const [loaded] = await loadPresets();
  expect(loaded.splitLayers).toBe(true);
});

test("loadPresets rejects a non-boolean splitLayers", async () => {
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([{ ...DEFAULT_PRESET, splitLayers: "yes" }]));

  await expect(loadPresets()).rejects.toThrow(/splitLayers/);
});

// mergeRule: 자동 병합 기준. 이 항목이 생기기 전 파일에는 없다.
test("loadPresets defaults mergeRule to role for a preset saved before it existed", async () => {
  const { mergeRule: _dropped, ...legacy } = DEFAULT_PRESET;
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([legacy]));

  const [loaded] = await loadPresets();
  expect(loaded.mergeRule).toBe("role");
});

test("loadPresets keeps a chosen mergeRule", async () => {
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([{ ...DEFAULT_PRESET, mergeRule: "plane" }]));

  const [loaded] = await loadPresets();
  expect(loaded.mergeRule).toBe("plane");
});

test("loadPresets rejects an unknown mergeRule rather than falling back", async () => {
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([{ ...DEFAULT_PRESET, mergeRule: "depth" }]));

  await expect(loadPresets()).rejects.toThrow(/mergeRule/);
});

test("presets saved before excludeTokens existed load with the default vocabulary", async () => {
  // tsconfig에 noUnusedLocals가 켜져 있어 구조분해로 필드를 빼면 tsc가 잡는다.
  const withoutField: Record<string, unknown> = { ...DEFAULT_PRESET };
  delete withoutField.excludeTokens;
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([withoutField]));

  const [loaded] = await loadPresets();

  expect(loaded.excludeTokens).toEqual(["col", "colour", "color"]);
});

test("an empty excludeTokens list is kept, not replaced by the default", async () => {
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([{ ...DEFAULT_PRESET, excludeTokens: [] }]));

  const [loaded] = await loadPresets();

  expect(loaded.excludeTokens).toEqual([]);
});

test("a malformed excludeTokens is rejected rather than silently defaulted", async () => {
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([{ ...DEFAULT_PRESET, excludeTokens: "col" }]));

  await expect(loadPresets()).rejects.toThrow("excludeTokens");
});

// outputFormat: 나중에 추가된 항목이라 구버전 presets.json에는 아예 없다.
test("loadPresets reads a preset saved before outputFormat existed as psd", async () => {
  const withoutField: Record<string, unknown> = { ...DEFAULT_PRESET };
  delete withoutField.outputFormat;
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([withoutField]));

  const [loaded] = await loadPresets();

  expect(loaded.outputFormat).toBe("psd");
});

test("loadPresets keeps an explicit outputFormat", async () => {
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([{ ...DEFAULT_PRESET, outputFormat: "jpg" }]));

  const [loaded] = await loadPresets();

  expect(loaded.outputFormat).toBe("jpg");
});

test("loadPresets rejects an unknown outputFormat rather than silently defaulting", async () => {
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([{ ...DEFAULT_PRESET, outputFormat: "webp" }]));

  await expect(loadPresets()).rejects.toThrow(/outputFormat/);
});

test("a preset saved before this feature reads as edge lines off", () => {
  // lineColor·outputFormat 때와 같은 규칙 — 구버전 파일은 잘못된 것이 아니다.
  const { edgeLines, ...withoutEdges } = DEFAULT_PRESET;
  const parsed = parsePresets(JSON.stringify([withoutEdges]));
  expect(parsed[0].edgeLines.enabled).toBe(false);
  expect(parsed[0].edgeLines.threshold).toBe(24);
});

test("edge line settings round-trip", () => {
  const preset = { ...DEFAULT_PRESET, edgeLines: { ...DEFAULT_PRESET.edgeLines, enabled: true, width: 7 } };
  const parsed = parsePresets(JSON.stringify([preset]));
  expect(parsed[0].edgeLines.enabled).toBe(true);
  expect(parsed[0].edgeLines.width).toBe(7);
});

test("a non-numeric edge line setting is rejected rather than coerced", () => {
  const bad = { ...DEFAULT_PRESET, edgeLines: { ...DEFAULT_PRESET.edgeLines, width: "굵게" } };
  expect(() => parsePresets(JSON.stringify([bad]))).toThrow(/edgeLines\.width/);
});

test("a fractional edge line setting is rejected rather than reaching the engine", () => {
  const bad = { ...DEFAULT_PRESET, edgeLines: { ...DEFAULT_PRESET.edgeLines, width: 4.5 } };
  expect(() => parsePresets(JSON.stringify([bad]))).toThrow(/edgeLines\.width/);
});

test.each([
  ["a string", "garbage"],
  ["a number", 42],
  ["an array", [1, 2, 3]],
  ["null", null],
])("a non-object top-level edgeLines (%s) is rejected rather than spread into defaults", (_label, value) => {
  const bad = { ...DEFAULT_PRESET, edgeLines: value };
  expect(() => parsePresets(JSON.stringify([bad]))).toThrow(/edgeLines/);
});

test("the five numeric edge-line defaults match the engine's EDGE_DEFAULTS", () => {
  // 이 둘이 갈라지면 조용히 틀린 그림이 나온다. 실제로 갈라진 적이 있다 —
  // 엔진이 width:0(자동)으로 바뀐 뒤에도 여기가 5로 남아, 프런트가 다섯 수치를
  // 항상 실어 보내는 탓에 화면에서는 자동이 한 번도 돌지 않았다. 타입도 테스트도
  // 그걸 잡지 못했다. 두 파일을 직접 대조하는 것만이 잡는다.
  const body = edgesSource.slice(edgesSource.indexOf("EDGE_DEFAULTS = {"));
  for (const key of ["threshold", "gap", "width", "minLength", "lineAlpha"] as const) {
    const m = new RegExp(`"${key}":\\s*(-?\\d+)`).exec(body);
    expect(m, `engine EDGE_DEFAULTS에 ${key}가 없다`).not.toBeNull();
    expect(Number(m![1]), `${key}: 엔진과 DEFAULT_EDGE_LINES가 다르다`).toBe(
      DEFAULT_EDGE_LINES[key],
    );
  }
  // colourMode는 숫자가 아니라 문자열이라 따로 본다. 이 대조가 없으면 프런트가
  // 엔진에 없는 값을 보내고도 양쪽 테스트가 모두 통과한다 — width 자동이 앱에서
  // 한 번도 안 돌았던 것이 정확히 그 사고였다.
  const mode = /"colourMode":\s*"(\w+)"/.exec(body);
  expect(mode, "engine EDGE_DEFAULTS에 colourMode가 없다").not.toBeNull();
  expect(mode![1], "colourMode: 엔진과 DEFAULT_EDGE_LINES가 다르다").toBe(
    DEFAULT_EDGE_LINES.colourMode,
  );
  const modes = /COLOUR_MODES = \(([^)]*)\)/.exec(edgesSource);
  expect(modes, "engine에 COLOUR_MODES가 없다").not.toBeNull();
  for (const value of ["composite", "paste"]) {
    expect(modes![1], `COLOUR_MODES에 ${value}가 없다`).toContain(`"${value}"`);
  }
});
