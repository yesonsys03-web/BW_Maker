import { beforeEach, expect, test, vi } from "vitest";
// 엔진 소스를 그대로 읽어 두 언어의 기본값을 대조한다(아래 마지막 테스트).
import edgesSource from "../../engine/psd_engine/edges.py?raw";
import matchingSource from "../../engine/psd_engine/matching.py?raw";

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

import { BG_PRESET, CHAR_PRESET, DEFAULT_EDGE_LINES, DEFAULT_EXCLUDE_TOKENS, DEFAULT_PRESETS, isValidLineColor, loadPresets, parsePresets, savePresets } from "./presets";
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

/**
 * 파일에 들어 있던 그 프리셋을 집어온다. **인덱스로 집으면 안 된다** —
 * loadPresets는 빠진 기본 프리셋을 목록 앞에 끼우므로(withDefaultPresets)
 * `[0]`은 파일에 있던 것이 아닐 수 있다. 못 찾으면 조용히 다른 것을 검사하는
 * 대신 여기서 터뜨린다.
 */
async function loadStored(name = "BG"): Promise<Preset> {
  const found = (await loadPresets()).find((p) => p.name === name);
  if (!found) throw new Error(`저장된 프리셋 "${name}"이 불러온 목록에 없습니다.`);
  return found;
}

test("BG_PRESET matches the brief contract", () => {
  // 값이 임의의 초기값이 아니라 **검증된 설정**이라는 것이 이 테스트의 요점이다.
  // merge/mergeRule/naming/lineColor는 납품 BG 26장 픽셀 기준선을 뜬 그 설정이다.
  // 예전 기본값(merge "none" / naming "pathPrefix" / lineColor null)은 아무도
  // 그대로 쓰지 않아서, 프리셋을 골라도 바로 작업이 안 됐다.
  expect(BG_PRESET).toEqual({
    name: "BG",
    // 어휘가 둘인 이유는 include_terms 주석에 있다 — lineart는 토큰 하나라
    // line으로는 영영 안 걸린다(납품 캐릭터 100장에서 83개).
    include: { type: "contains", value: "line, lineart", caseSensitive: false },
    excludeGroupPrefixes: ["-"],
    matchGroups: true,
    includeHidden: true,
    merge: "byElement",
    naming: "original",
    outputSuffix: "_LINE",
    embedPreview: true,
    lineColor: "#000000",
    roleTokens: ["UL", "OL_UL", "OL"],
    mergeRule: "group",
    splitLayers: false,
    // line col 류는 색 지정이고, HEIGHT LINE 류는 키 기준선이라 둘 다 선화가 아니다
    excludeTokens: ["col", "colour", "color", "height"],
    outputFormat: "psd",
    // BG에서는 경계선 생성을 끈다 — 캐릭터 모델 전용 기능이다
    edgeLines: {
      enabled: false, threshold: 24, gap: 4, width: 0, minLength: 8, lineAlpha: 64,
      colourMode: "composite", edgeMode: "region",
    },
  });
});

test("CHAR_PRESET은 BG와 **두 가지만** 다르다", () => {
  // 목록을 두 번 적는 대신 차이를 센다. 값을 통째로 다시 쓰면 어느 쪽을 고치다
  // 다른 쪽이 따라 움직여도 테스트가 그대로 통과한다 — 두 프리셋의 관계가
  // 계약이므로 관계를 재야 한다.
  const differing = (Object.keys(BG_PRESET) as (keyof typeof BG_PRESET)[]).filter(
    (k) => JSON.stringify(BG_PRESET[k]) !== JSON.stringify(CHAR_PRESET[k]),
  );
  expect(differing.sort()).toEqual(["edgeLines", "excludeGroupPrefixes", "name"]);
  expect(CHAR_PRESET.name).toBe("CHAR");
  expect(CHAR_PRESET.excludeGroupPrefixes).toEqual([
    "-", "HEIGHTS", "TEMPLATE", "COLOR PALETTE",
  ]);
  // 경계선 생성이 켜진 것 말고는 수치가 같아야 한다 — 굵기 자동(0), 정확, 영역.
  expect(CHAR_PRESET.edgeLines).toEqual({ ...BG_PRESET.edgeLines, enabled: true });
  expect(CHAR_PRESET.edgeLines.width).toBe(0);
});

test("loadPresets returns both built-ins when the file does not exist", async () => {
  existsMock.mockResolvedValue(false);
  const result = await loadPresets();
  expect(result).toEqual([BG_PRESET, CHAR_PRESET]);
  expect(result.map((p) => p.name)).toEqual(["BG", "CHAR"]);
  expect(readTextFileMock).not.toHaveBeenCalled();
});

test("loadPresets가 돌려준 기본 프리셋을 고쳐도 원본이 안 바뀐다", () => {
  // 첫 실행에서 받은 목록을 화면이 그대로 편집하면, 상수 객체를 공유하고 있을 때
  // 두 번째 호출이 이미 오염된 값을 돌려준다.
  const [bg] = DEFAULT_PRESETS.map((p) => ({ ...p }));
  bg.name = "손댐";
  expect(BG_PRESET.name).toBe("BG");
});

test("loadPresets reads and parses existing JSON (round trip)", async () => {
  // 기본 둘이 다 들어 있는 파일이라 채워 넣을 것이 없다 — 읽은 그대로 나와야 한다.
  const stored: Preset[] = [BG_PRESET, CHAR_PRESET, { ...BG_PRESET, name: "second" }];
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify(stored));

  const result = await loadPresets();

  expect(result).toEqual(stored);
  expect(existsMock).toHaveBeenCalledWith(FILE_PATH);
  expect(readTextFileMock).toHaveBeenCalledWith(FILE_PATH);
});

// 옛 버전이 써둔 presets.json이 남아 있는 컴퓨터에서 실제로 났던 일이다: 앱을
// 새로 설치했는데 BG·CHAR이 안 보이고 그 파일에 든 옛 프리셋 하나만 떴다.
// appData는 재설치로 지워지지 않으므로 "파일이 없을 때만 기본값"으로는 못 막는다.
test("loadPresets tops up defaults that a legacy presets.json never had", async () => {
  const legacy: Preset = { ...BG_PRESET, name: "line 추출" };
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([legacy]));

  const result = await loadPresets();

  expect(result.map((p) => p.name)).toEqual(["BG", "CHAR", "line 추출"]);
  // 끼워 넣기는 메모리에서만 한다 — 저장은 아티스트가 누를 때만이다.
  expect(writeTextFileMock).not.toHaveBeenCalled();
});

// 이름이 같은 것이 이미 있으면 손대지 않는다. 여기서 기본값으로 덮으면 아티스트가
// 고쳐 쓰는 판이 조용히 되돌아간다 — 그건 이 기능이 막으려는 바로 그 형태다.
test("loadPresets does not overwrite a default the artist has edited", async () => {
  const edited: Preset = { ...CHAR_PRESET, lineColor: null };
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([edited]));

  const result = await loadPresets();

  expect(result.map((p) => p.name)).toEqual(["BG", "CHAR"]);
  expect(result.find((p) => p.name === "CHAR")?.lineColor).toBeNull();
});

test("loadPresets throws on corrupted JSON instead of absorbing the error", async () => {
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue("{not valid json");

  await expect(loadPresets()).rejects.toThrow();
});

test("loadPresets throws when the top-level JSON value is not an array", async () => {
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify(BG_PRESET)); // an object, not an array

  await expect(loadPresets()).rejects.toThrow(/배열/);
});

test("loadPresets throws when a stored preset is missing a required field (valid JSON, wrong shape)", async () => {
  const { excludeGroupPrefixes: _drop, ...broken } = BG_PRESET;
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([broken]));

  await expect(loadPresets()).rejects.toThrow(/excludeGroupPrefixes/);
});

test("loadPresets throws when a field has the wrong type/value (e.g. an invalid enum)", async () => {
  const broken = { ...BG_PRESET, merge: "bogus" };
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
    // colourMode·edgeMode는 기본값이 아닌 쪽을 넣는다 — 기본값이면 파서가 메워
    // 넣은 것과 구분이 안 되어 "그대로 보존한다"를 실제로 재지 못한다.
    edgeLines: {
      enabled: true, threshold: 30, gap: 6, width: 7, minLength: 10, lineAlpha: 70,
      colourMode: "paste", edgeMode: "change",
    },
  };
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([wellFormed]));

  // 목록 전체와 대조하지 않는다 — 빠진 기본 프리셋이 함께 들어오기 때문이다.
  // 이 테스트가 재는 것은 "파일에 적힌 필드가 하나도 안 변한다"이다.
  await expect(loadStored("custom")).resolves.toEqual(wellFormed);
});

test("a preset saved before colourMode existed loads with the composite path", async () => {
  // 이미 저장된 프리셋에는 이 키가 없다. 없는 채로 열렸을 때 예전 동작(정확한
  // 합성)으로 떨어져야 한다 — 여기서 paste로 떨어지면 아무도 고르지 않은 변경이
  // 조용히 적용된다.
  const old = {
    ...BG_PRESET,
    edgeLines: { enabled: true, threshold: 24, gap: 4, width: 0, minLength: 8, lineAlpha: 64 },
  };
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([old]));

  // 이름으로 집는다. `[0]`으로 집으면 끼워 넣은 기본 프리셋의 colourMode가
  // 마침 "composite"이라 **파서가 고장 나도 초록불이 뜬다**.
  const loaded = await loadStored();
  expect(loaded.edgeLines.colourMode).toBe("composite");
});

test("a preset saved after colourMode existed but before edgeMode did loads with the region path", async () => {
  // 실제로 있었을 모양: colourMode가 생긴 뒤, edgeMode가 생기기 전에 저장된
  // 프리셋이라 edgeLines에 colourMode는 있고 edgeMode만 없다. 없는 채로 열렸을
  // 때 region(새 검출)으로 떨어져야 한다 — colourMode 때와 달리 여기서는 일부러
  // "예전 그대로"가 아니다(위 edgeMode 검증 앞 주석 참고).
  const old = {
    ...BG_PRESET,
    edgeLines: {
      enabled: true, threshold: 24, gap: 4, width: 0, minLength: 8, lineAlpha: 64,
      colourMode: "composite",
    },
  };
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([old]));

  const loaded = await loadPresets();
  expect(loaded[0].edgeLines.edgeMode).toBe("region");
});

test("loadPresets rejects an unknown colourMode instead of guessing", async () => {
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([
    { ...BG_PRESET, edgeLines: { ...BG_PRESET.edgeLines, colourMode: "turbo" } },
  ]));

  await expect(loadPresets()).rejects.toThrow(/colourMode/);
});

test("savePresets ensures the app data directory exists then writes JSON", async () => {
  mkdirMock.mockResolvedValue(undefined);
  writeTextFileMock.mockResolvedValue(undefined);
  const list: Preset[] = [BG_PRESET];

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

  const list: Preset[] = [{ ...BG_PRESET, name: "roundtrip" }];
  await savePresets(list);
  const loaded = await loadPresets();

  // 디스크에 적힌 것은 준 목록 그대로다 — 기본값 끼워 넣기는 읽을 때만 한다.
  expect(JSON.parse(String(stored))).toEqual(list);
  // 그리고 읽으면 그 항목이 필드까지 그대로 돌아온다.
  expect(loaded.find((p) => p.name === "roundtrip")).toEqual(list[0]);
});

test("savePresets propagates write errors instead of absorbing them", async () => {
  mkdirMock.mockResolvedValue(undefined);
  writeTextFileMock.mockRejectedValue(new Error("disk full"));

  await expect(savePresets([BG_PRESET])).rejects.toThrow("disk full");
});


// lineColor: 나중에 추가된 항목이라 구버전 presets.json에는 아예 없다.
test("loadPresets reads a preset saved before lineColor existed as keep-original", async () => {
  const { lineColor: _dropped, ...legacy } = BG_PRESET;
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([legacy]));

  const loaded = await loadStored();
  expect(loaded.lineColor).toBeNull();
});

test("loadPresets keeps an explicit null lineColor", async () => {
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([{ ...BG_PRESET, lineColor: null }]));

  const loaded = await loadStored();
  expect(loaded.lineColor).toBeNull();
});

test("loadPresets rejects a malformed lineColor rather than dropping it", async () => {
  // 조용히 null로 떨어뜨리면 색 통일이 빠진 채 배치가 돌아버린다.
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([{ ...BG_PRESET, lineColor: "black" }]));

  await expect(loadPresets()).rejects.toThrow(/lineColor/);
});

test("loadPresets rejects a shorthand hex lineColor", async () => {
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([{ ...BG_PRESET, lineColor: "#000" }]));

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
  const { roleTokens: _dropped, ...legacy } = BG_PRESET;
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([legacy]));

  const loaded = await loadStored();
  expect(loaded.roleTokens).toEqual(["UL", "OL_UL", "OL"]);
});

test("loadPresets keeps a custom role token order, since it sets the stacking order", async () => {
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([{ ...BG_PRESET, roleTokens: ["OL", "UL"] }]));

  const loaded = await loadStored();
  expect(loaded.roleTokens).toEqual(["OL", "UL"]);
});

test("loadPresets rejects role tokens that are not a string array", async () => {
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([{ ...BG_PRESET, roleTokens: "UL,OL" }]));

  await expect(loadPresets()).rejects.toThrow(/roleTokens/);
});

test("loadPresets accepts the byElement merge mode", async () => {
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([{ ...BG_PRESET, merge: "byElement" }]));

  const loaded = await loadStored();
  expect(loaded.merge).toBe("byElement");
});

test("loadPresets migrates the short-lived byRole mode to byElement", async () => {
  // byRole은 요소별 병합으로 대체되기 전 잠깐 존재했다. 그 사이에 저장된
  // 프리셋이 로드에서 튕기면 사용자는 이유도 모른 채 프리셋을 잃는다.
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([{ ...BG_PRESET, merge: "byRole" }]));

  const loaded = await loadStored();
  expect(loaded.merge).toBe("byElement");
});

// splitLayers: 레이어별 분리 내보내기. 이 항목이 생기기 전 파일에는 없다.
test("loadPresets reads a preset saved before splitLayers existed as one-file", async () => {
  const { splitLayers: _dropped, ...legacy } = BG_PRESET;
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([legacy]));

  const loaded = await loadStored();
  expect(loaded.splitLayers).toBe(false);
});

test("loadPresets keeps splitLayers when it is set", async () => {
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([{ ...BG_PRESET, splitLayers: true }]));

  const loaded = await loadStored();
  expect(loaded.splitLayers).toBe(true);
});

test("loadPresets rejects a non-boolean splitLayers", async () => {
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([{ ...BG_PRESET, splitLayers: "yes" }]));

  await expect(loadPresets()).rejects.toThrow(/splitLayers/);
});

// mergeRule: 자동 병합 기준. 이 항목이 생기기 전 파일에는 없다.
test("loadPresets defaults mergeRule to role for a preset saved before it existed", async () => {
  const { mergeRule: _dropped, ...legacy } = BG_PRESET;
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([legacy]));

  const loaded = await loadStored();
  expect(loaded.mergeRule).toBe("role");
});

test("loadPresets keeps a chosen mergeRule", async () => {
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([{ ...BG_PRESET, mergeRule: "plane" }]));

  const loaded = await loadStored();
  expect(loaded.mergeRule).toBe("plane");
});

test("loadPresets rejects an unknown mergeRule rather than falling back", async () => {
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([{ ...BG_PRESET, mergeRule: "depth" }]));

  await expect(loadPresets()).rejects.toThrow(/mergeRule/);
});

test("presets saved before excludeTokens existed load with the default vocabulary", async () => {
  // tsconfig에 noUnusedLocals가 켜져 있어 구조분해로 필드를 빼면 tsc가 잡는다.
  const withoutField: Record<string, unknown> = { ...BG_PRESET };
  delete withoutField.excludeTokens;
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([withoutField]));

  const loaded = await loadStored();

  // 어휘가 늘면 옛 프리셋도 늘어난 쪽을 받는다 — 그게 이 마이그레이션의 요점이다.
  // (2026-08-10에 키 기준선을 빼려고 "height"가 들어왔다.)
  expect(loaded.excludeTokens).toEqual(DEFAULT_EXCLUDE_TOKENS);
  expect(loaded.excludeTokens).toContain("height");
});

test("an empty excludeTokens list is kept, not replaced by the default", async () => {
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([{ ...BG_PRESET, excludeTokens: [] }]));

  const loaded = await loadStored();

  expect(loaded.excludeTokens).toEqual([]);
});

test("a malformed excludeTokens is rejected rather than silently defaulted", async () => {
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([{ ...BG_PRESET, excludeTokens: "col" }]));

  await expect(loadPresets()).rejects.toThrow("excludeTokens");
});

// outputFormat: 나중에 추가된 항목이라 구버전 presets.json에는 아예 없다.
test("loadPresets reads a preset saved before outputFormat existed as psd", async () => {
  const withoutField: Record<string, unknown> = { ...BG_PRESET };
  delete withoutField.outputFormat;
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([withoutField]));

  const loaded = await loadStored();

  expect(loaded.outputFormat).toBe("psd");
});

test("loadPresets keeps an explicit outputFormat", async () => {
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([{ ...BG_PRESET, outputFormat: "jpg" }]));

  const loaded = await loadStored();

  expect(loaded.outputFormat).toBe("jpg");
});

test("loadPresets rejects an unknown outputFormat rather than silently defaulting", async () => {
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([{ ...BG_PRESET, outputFormat: "webp" }]));

  await expect(loadPresets()).rejects.toThrow(/outputFormat/);
});

test("a preset saved before this feature reads as edge lines off", () => {
  // lineColor·outputFormat 때와 같은 규칙 — 구버전 파일은 잘못된 것이 아니다.
  const { edgeLines, ...withoutEdges } = BG_PRESET;
  const parsed = parsePresets(JSON.stringify([withoutEdges]));
  expect(parsed[0].edgeLines.enabled).toBe(false);
  expect(parsed[0].edgeLines.threshold).toBe(24);
});

test("edge line settings round-trip", () => {
  const preset = { ...BG_PRESET, edgeLines: { ...BG_PRESET.edgeLines, enabled: true, width: 7 } };
  const parsed = parsePresets(JSON.stringify([preset]));
  expect(parsed[0].edgeLines.enabled).toBe(true);
  expect(parsed[0].edgeLines.width).toBe(7);
});

test("a non-numeric edge line setting is rejected rather than coerced", () => {
  const bad = { ...BG_PRESET, edgeLines: { ...BG_PRESET.edgeLines, width: "굵게" } };
  expect(() => parsePresets(JSON.stringify([bad]))).toThrow(/edgeLines\.width/);
});

test("a fractional edge line setting is rejected rather than reaching the engine", () => {
  const bad = { ...BG_PRESET, edgeLines: { ...BG_PRESET.edgeLines, width: 4.5 } };
  expect(() => parsePresets(JSON.stringify([bad]))).toThrow(/edgeLines\.width/);
});

test("an unknown edgeMode is rejected rather than passed to the engine", () => {
  const bad = {
    ...BG_PRESET,
    edgeLines: { ...DEFAULT_EDGE_LINES, edgeMode: "sdf" },
  };
  expect(() => parsePresets(JSON.stringify([bad]))).toThrow(/edgeLines\.edgeMode/);
});

test.each([
  ["a string", "garbage"],
  ["a number", 42],
  ["an array", [1, 2, 3]],
  ["null", null],
])("a non-object top-level edgeLines (%s) is rejected rather than spread into defaults", (_label, value) => {
  const bad = { ...BG_PRESET, edgeLines: value };
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
  // edgeMode도 같은 이유로 대조한다. 이 대조가 없으면 프런트가 항상 값을 실어
  // 보내는 탓에 엔진 기본값이 매번 덮어써지고, 양쪽 테스트는 각자 자기 상수만
  // 보므로 둘 다 통과한다 — width 자동이 앱에서 한 번도 안 돌았던 그 사고다.
  const emode = /"edgeMode":\s*"(\w+)"/.exec(body);
  expect(emode, "engine EDGE_DEFAULTS에 edgeMode가 없다").not.toBeNull();
  expect(emode![1], "edgeMode: 엔진과 DEFAULT_EDGE_LINES가 다르다").toBe(
    DEFAULT_EDGE_LINES.edgeMode,
  );
  const emodes = /EDGE_MODES = \(([^)]*)\)/.exec(edgesSource);
  expect(emodes, "engine에 EDGE_MODES가 없다").not.toBeNull();
  for (const value of ["region", "change"]) {
    expect(emodes![1], `EDGE_MODES에 ${value}가 없다`).toContain(`"${value}"`);
  }
});

test("excludeTokens의 기본 어휘가 엔진과 프런트에서 같다", () => {
  // 이 대조가 없어서 두 곳을 손으로 맞춰야 했다. 이 저장소는 같은 결함을 이미 한 번
  // 냈다 — 엔진에서 width=0이 "자동"인데 프런트가 항상 5를 보내 자동이 한 번도 안
  // 돌았고, 각자 자기 쪽 상수만 봐서 양쪽 테스트가 모두 통과했다.
  //
  // 파이썬 리스트를 그대로 읽어 비교한다. 주석에 예시 목록이 있어도 `=` 오른쪽의
  // 대괄호만 잡으므로 걸리지 않는다.
  const m = /^DEFAULT_EXCLUDE_TOKENS\s*=\s*\[([^\]]*)\]/m.exec(matchingSource);
  expect(m, "matching.py에서 DEFAULT_EXCLUDE_TOKENS를 못 찾았다").not.toBeNull();
  const engine = [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  expect(engine, "엔진과 프런트의 excludeTokens 기본값이 다르다").toEqual(
    DEFAULT_EXCLUDE_TOKENS,
  );
});
