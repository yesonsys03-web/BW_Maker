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

/**
 * Loads presets from `appDataDir()/presets.json`. Returns [DEFAULT_PRESET]
 * when the file doesn't exist yet (first run). Malformed JSON is NOT
 * absorbed here — JSON.parse throws and that rejection propagates to the
 * caller, which must surface it (e.g. via ErrorPanel).
 */
export async function loadPresets(): Promise<Preset[]> {
  const filePath = await presetsFilePath();
  if (!(await exists(filePath))) return [DEFAULT_PRESET];
  const raw = await readTextFile(filePath);
  return JSON.parse(raw) as Preset[];
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
