import { appDataDir, join } from "@tauri-apps/api/path";
import { exists, mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import type { Preset } from "./types";

const PRESETS_FILENAME = "presets.json";

export const DEFAULT_PRESET: Preset = {
  name: "line 추출",
  include: { type: "contains", value: "line", caseSensitive: false },
  excludeGroupPrefixes: ["-"],
  matchGroups: true,
  includeHidden: true,
  merge: "none",
  roleTokens: ["UL", "OL_UL", "OL"],
  naming: "pathPrefix",
  outputSuffix: "_LINE",
  embedPreview: true,
  lineColor: null,
  splitLayers: false,
};

/** 색 통일을 켤 때 처음 제안하는 색. 라인 아트의 기본값. */
export const DEFAULT_LINE_COLOR = "#000000";

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** 엔진의 parse_line_color와 같은 형식(#RRGGBB)만 통과시킨다. */
export function isValidLineColor(value: string): boolean {
  return HEX_COLOR.test(value);
}

async function presetsFilePath(): Promise<string> {
  const dir = await appDataDir();
  return join(dir, PRESETS_FILENAME);
}

const INCLUDE_TYPES = new Set(["contains", "regex"]);
const MERGE_MODES = new Set(["none", "all", "perGroup", "byElement"]);

/** byRole 병합의 기본 역할 토큰(아래→위 순서). 엔진 DEFAULT_ROLE_TOKENS와 같다. */
export const DEFAULT_ROLE_TOKENS = ["UL", "OL_UL", "OL"];
const NAMING_MODES = new Set(["pathPrefix", "original"]);

/**
 * Validates and normalizes one parsed JSON entry into a `Preset`. Throws a
 * descriptive error (including the array index and offending field) on any
 * shape mismatch — valid-but-wrong-shaped JSON must never silently pass
 * through as a `Preset` and blow up later deep inside PresetDialog/engine
 * calls with an opaque TypeError.
 */
function validatePreset(value: unknown, index: number): Preset {
  const prefix = `presets.json[${index}]`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${prefix}: 객체가 아닙니다.`);
  }
  const v = value as Record<string, unknown>;

  if (typeof v.name !== "string") throw new Error(`${prefix}.name: 문자열이 아닙니다.`);

  if (typeof v.include !== "object" || v.include === null) {
    throw new Error(`${prefix}.include: 객체가 아닙니다.`);
  }
  const include = v.include as Record<string, unknown>;
  if (typeof include.type !== "string" || !INCLUDE_TYPES.has(include.type)) {
    throw new Error(`${prefix}.include.type: "contains" 또는 "regex"가 아닙니다.`);
  }
  if (typeof include.value !== "string") throw new Error(`${prefix}.include.value: 문자열이 아닙니다.`);
  if (typeof include.caseSensitive !== "boolean") {
    throw new Error(`${prefix}.include.caseSensitive: boolean이 아닙니다.`);
  }

  if (!Array.isArray(v.excludeGroupPrefixes) || !v.excludeGroupPrefixes.every((s) => typeof s === "string")) {
    throw new Error(`${prefix}.excludeGroupPrefixes: 문자열 배열이 아닙니다.`);
  }
  if (typeof v.matchGroups !== "boolean") throw new Error(`${prefix}.matchGroups: boolean이 아닙니다.`);
  if (typeof v.includeHidden !== "boolean") throw new Error(`${prefix}.includeHidden: boolean이 아닙니다.`);
  // byRole은 요소별 병합으로 대체되기 전 잠깐 존재했던 이름이다. 그 사이에
  // 저장된 프리셋이 로드에서 튕기지 않도록 새 이름으로 읽어준다.
  if (v.merge === "byRole") v.merge = "byElement";
  if (typeof v.merge !== "string" || !MERGE_MODES.has(v.merge)) {
    throw new Error(`${prefix}.merge: "none"/"all"/"perGroup" 중 하나가 아닙니다.`);
  }
  if (typeof v.naming !== "string" || !NAMING_MODES.has(v.naming)) {
    throw new Error(`${prefix}.naming: "pathPrefix" 또는 "original"이 아닙니다.`);
  }
  if (typeof v.outputSuffix !== "string") throw new Error(`${prefix}.outputSuffix: 문자열이 아닙니다.`);
  // roleTokens도 나중에 추가된 항목이라 그 전에 저장된 파일에는 없다 — 없으면
  // 기본값으로 읽고, 들어있는데 모양이 어긋나면 통과시키지 않는다.
  // splitLayers도 나중에 추가된 항목 — 없으면 기본값(합쳐서 한 파일)으로 읽는다.
  if (v.splitLayers !== undefined && typeof v.splitLayers !== "boolean") {
    throw new Error(`${prefix}.splitLayers: boolean이 아닙니다.`);
  }
  if (v.roleTokens !== undefined) {
    if (!Array.isArray(v.roleTokens) || !v.roleTokens.every((t) => typeof t === "string")) {
      throw new Error(`${prefix}.roleTokens: 문자열 배열이 아닙니다.`);
    }
  }
  if (typeof v.embedPreview !== "boolean") throw new Error(`${prefix}.embedPreview: boolean이 아닙니다.`);
  // lineColor는 나중에 추가된 항목이라, 그 이전에 저장된 presets.json에는 아예
  // 없다. 없는 것은 "원본 색 유지"(null)로 읽는다 — 형식이 깨진 값과 달리
  // 구버전 파일은 잘못된 것이 아니기 때문이다. 반대로 들어있는데 형식이
  // 어긋나면 통과시키지 않는다.
  if (v.lineColor !== undefined && v.lineColor !== null) {
    if (typeof v.lineColor !== "string" || !isValidLineColor(v.lineColor)) {
      throw new Error(`${prefix}.lineColor: null 또는 "#RRGGBB" 형식이 아닙니다.`);
    }
  }

  return {
    name: v.name,
    include: {
      type: include.type as Preset["include"]["type"],
      value: include.value,
      caseSensitive: include.caseSensitive,
    },
    excludeGroupPrefixes: v.excludeGroupPrefixes as string[],
    matchGroups: v.matchGroups,
    includeHidden: v.includeHidden,
    merge: v.merge as Preset["merge"],
    roleTokens: (v.roleTokens as string[] | undefined) ?? [...DEFAULT_ROLE_TOKENS],
    naming: v.naming as Preset["naming"],
    outputSuffix: v.outputSuffix,
    embedPreview: v.embedPreview,
    lineColor: (v.lineColor as string | null | undefined) ?? null,
    splitLayers: (v.splitLayers as boolean | undefined) ?? false,
  };
}

/** Validates the parsed top-level JSON value is an array of well-formed Presets. */
function validatePresetList(value: unknown): Preset[] {
  if (!Array.isArray(value)) throw new Error("presets.json: 최상위 값이 배열이 아닙니다.");
  return value.map((item, index) => validatePreset(item, index));
}

/**
 * Loads presets from `appDataDir()/presets.json`. Returns [DEFAULT_PRESET]
 * when the file doesn't exist yet (first run). Malformed JSON and
 * well-formed-but-wrong-shaped JSON are NOT absorbed here — both throw and
 * that rejection propagates to the caller, which must surface it (e.g. via
 * ErrorPanel).
 */
export async function loadPresets(): Promise<Preset[]> {
  const filePath = await presetsFilePath();
  if (!(await exists(filePath))) return [DEFAULT_PRESET];
  const raw = await readTextFile(filePath);
  const parsed: unknown = JSON.parse(raw);
  return validatePresetList(parsed);
}

/**
 * Persists the given preset list to `appDataDir()/presets.json`, creating
 * the app data directory first if it doesn't exist yet. IO failures are not
 * caught here — they propagate to the caller.
 */
export async function savePresets(list: Preset[]): Promise<void> {
  const dir = await appDataDir();
  await mkdir(dir, { recursive: true });
  const filePath = await join(dir, PRESETS_FILENAME);
  await writeTextFile(filePath, JSON.stringify(list, null, 2));
}
