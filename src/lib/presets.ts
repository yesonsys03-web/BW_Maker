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
  naming: "pathPrefix",
  outputSuffix: "_LINE",
  embedPreview: true,
};

async function presetsFilePath(): Promise<string> {
  const dir = await appDataDir();
  return join(dir, PRESETS_FILENAME);
}

const INCLUDE_TYPES = new Set(["contains", "regex"]);
const MERGE_MODES = new Set(["none", "all", "perGroup"]);
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
  if (typeof v.merge !== "string" || !MERGE_MODES.has(v.merge)) {
    throw new Error(`${prefix}.merge: "none"/"all"/"perGroup" 중 하나가 아닙니다.`);
  }
  if (typeof v.naming !== "string" || !NAMING_MODES.has(v.naming)) {
    throw new Error(`${prefix}.naming: "pathPrefix" 또는 "original"이 아닙니다.`);
  }
  if (typeof v.outputSuffix !== "string") throw new Error(`${prefix}.outputSuffix: 문자열이 아닙니다.`);
  if (typeof v.embedPreview !== "boolean") throw new Error(`${prefix}.embedPreview: boolean이 아닙니다.`);

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
    naming: v.naming as Preset["naming"],
    outputSuffix: v.outputSuffix,
    embedPreview: v.embedPreview,
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
