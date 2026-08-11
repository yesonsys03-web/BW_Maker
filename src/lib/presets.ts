import { appDataDir, join } from "@tauri-apps/api/path";
import { exists, mkdir, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import type { EdgeLines, OutputFormat, Preset } from "./types";

const PRESETS_FILENAME = "presets.json";

/**
 * 선화가 아닌 레이어를 걸러내는 기본 어휘. 엔진 DEFAULT_EXCLUDE_TOKENS와 같다.
 *
 * `height`는 키 기준선(`CHARACTER HEIGHT LINE` 등)을 뺀다 — 이름에 line이 들어
 * 있어 include 규칙에 걸리지만 선화가 아니다. 근거 수치는 엔진 쪽 주석에 있다.
 */
export const DEFAULT_EXCLUDE_TOKENS = ["col", "colour", "color", "height"];

/**
 * 색 경계선 생성 기본값. 엔진 EDGE_DEFAULTS(engine/psd_engine/edges.py)와
 * threshold/gap/width/minLength/lineAlpha가 같다 — enabled만 TS 쪽에만 있다
 * (엔진은 edgeLines.get("enabled")로 켜짐 여부를 읽는다). 기본은 꺼짐이라
 * BG 프리셋과 이미 저장된 모든 프리셋은 이 기능 도입 전과 똑같이 동작한다.
 *
 * `width: 0`은 **자동**이다 — 그 뷰 자신의 라인 굵기에서 유도한다. 이 값들이
 * 엔진 기본값과 같아야 하는 이유가 여기서 드러난다: 프런트는 다섯 수치를 **항상**
 * 실어 보내므로, 여기 0이 아닌 값이 있으면 엔진의 자동 판정을 매번 덮어쓴다.
 * 한동안 여기만 5로 남아 있어서 엔진이 자동을 지원해도 화면에서는 늘 5가 강제됐다.
 */
export const DEFAULT_EDGE_LINES: EdgeLines = {
  enabled: false, threshold: 24, gap: 4, width: 0, minLength: 8, lineAlpha: 64,
  colourMode: "composite", edgeMode: "region",
};

/**
 * 두 기본 프리셋이 공유하는 부분. 값은 납품 데이터에서 검증된 것이지 임의의
 * 초기값이 아니다 — merge/mergeRule/naming/lineColor는 픽셀 기준선(납품 BG 26장,
 * `baseline/hh0306.jsonl`)을 뜬 그 설정이고, 아티스트가 실제로 쓰던 값과도 같다.
 * (그전 기본값은 merge "none" / naming "pathPrefix" / lineColor null이었는데,
 * 아무도 그대로 쓰지 않아서 프리셋을 골라도 바로 작업이 안 됐다.)
 */
const SHARED: Omit<Preset, "name" | "excludeGroupPrefixes" | "edgeLines"> = {
  include: { type: "contains", value: "line, lineart", caseSensitive: false },
  matchGroups: true,
  includeHidden: true,
  merge: "byElement",
  roleTokens: ["UL", "OL_UL", "OL"],
  mergeRule: "group",
  naming: "original",
  outputSuffix: "_LINE",
  embedPreview: true,
  lineColor: "#000000",
  splitLayers: false,
  outputFormat: "psd",
  excludeTokens: [...DEFAULT_EXCLUDE_TOKENS],
};

/** 배경 판용. 경계선 생성은 끈다 — 그 기능은 캐릭터 모델 전용이다. */
export const BG_PRESET: Preset = {
  ...SHARED,
  name: "BG",
  excludeGroupPrefixes: ["-"],
  edgeLines: { ...DEFAULT_EDGE_LINES },
};

/**
 * 캐릭터 모델 판용. BG와 **두 가지만** 다르다.
 *
 * - 그룹 접두사에 `HEIGHTS`, `TEMPLATE`, `COLOR PALETTE`를 더한다. 캐릭터 판에만
 *   있는 참고용 그룹이다(BG 26장 전수에서 이 이름 0건이라 BG에 넣어도 무해하지만,
 *   넣지 않는 편이 각 프리셋이 무엇을 위한 것인지 분명하다).
 * - 색 경계선 생성을 켠다. 나머지 수치는 엔진 기본값 그대로다 — 굵기는 자동
 *   (`width: 0`), 색 그림은 정확(composite), 경계는 영역(region).
 *
 * `height` 토큰은 SHARED에 있어 양쪽 다 걸린다. 키 기준선(`CHARACTER HEIGHT LINE`)
 * 은 캐릭터에만 있고 BG에는 0건이라, 공유해도 BG 결과가 바뀌지 않는다.
 */
export const CHAR_PRESET: Preset = {
  ...SHARED,
  name: "CHAR",
  excludeGroupPrefixes: ["-", "HEIGHTS", "TEMPLATE", "COLOR PALETTE"],
  edgeLines: { ...DEFAULT_EDGE_LINES, enabled: true },
};

/** 처음 실행할 때 깔리는 프리셋. 고르면 바로 작업할 수 있어야 한다. */
export const DEFAULT_PRESETS: Preset[] = [BG_PRESET, CHAR_PRESET];

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

const MERGE_RULES = new Set(["role", "group", "plane"]);

export interface OutputFormatOption {
  value: OutputFormat;
  label: string;
}

/**
 * 출력 포맷 선택지의 유일한 출처. ExportDialog와 PresetDialog가 그대로 렌더링에
 * 쓰고, 아래 OUTPUT_FORMATS(검증기)도 여기서 값만 뽑아 쓴다 — 세 군데가 각자
 * 같은 목록을 따로 적으면, 하나만 바뀌었을 때 나머지가 조용히 어긋난다.
 */
export const OUTPUT_FORMAT_OPTIONS: OutputFormatOption[] = [
  { value: "psd", label: "원본 따름 (.psd / .psb)" },
  { value: "png", label: "PNG — 투명 배경" },
  { value: "jpg", label: "JPG — 흰 배경" },
];

const OUTPUT_FORMATS = new Set<string>(OUTPUT_FORMAT_OPTIONS.map((o) => o.value));

/** byRole 병합의 기본 역할 토큰(아래→위 순서). 엔진 DEFAULT_ROLE_TOKENS와 같다. */
export const DEFAULT_ROLE_TOKENS = ["UL", "OL_UL", "OL"];
const NAMING_MODES = new Set(["pathPrefix", "original"]);

/**
 * Validates and normalizes one parsed JSON entry into a `Preset`. Throws a
 * descriptive error (including the field name and path) on any shape mismatch —
 * valid-but-wrong-shaped JSON must never silently pass through as a `Preset`
 * and blow up later deep inside PresetDialog/engine calls with an opaque TypeError.
 *
 * @param value The value to validate
 * @param index The array index (used in default prefix)
 * @param prefix Optional prefix for error messages (default: `presets.json[index]`)
 */
export function validatePreset(value: unknown, index: number, prefix?: string): Preset {
  const msgPrefix = prefix ?? `presets.json[${index}]`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${msgPrefix}: 객체가 아닙니다.`);
  }
  const v = value as Record<string, unknown>;

  if (typeof v.name !== "string") throw new Error(`${msgPrefix}.name: 문자열이 아닙니다.`);

  if (typeof v.include !== "object" || v.include === null) {
    throw new Error(`${msgPrefix}.include: 객체가 아닙니다.`);
  }
  const include = v.include as Record<string, unknown>;
  if (typeof include.type !== "string" || !INCLUDE_TYPES.has(include.type)) {
    throw new Error(`${msgPrefix}.include.type: "contains" 또는 "regex"가 아닙니다.`);
  }
  if (typeof include.value !== "string") throw new Error(`${msgPrefix}.include.value: 문자열이 아닙니다.`);
  if (typeof include.caseSensitive !== "boolean") {
    throw new Error(`${msgPrefix}.include.caseSensitive: boolean이 아닙니다.`);
  }

  if (!Array.isArray(v.excludeGroupPrefixes) || !v.excludeGroupPrefixes.every((s) => typeof s === "string")) {
    throw new Error(`${msgPrefix}.excludeGroupPrefixes: 문자열 배열이 아닙니다.`);
  }
  if (typeof v.matchGroups !== "boolean") throw new Error(`${msgPrefix}.matchGroups: boolean이 아닙니다.`);
  if (typeof v.includeHidden !== "boolean") throw new Error(`${msgPrefix}.includeHidden: boolean이 아닙니다.`);
  // byRole은 요소별 병합으로 대체되기 전 잠깐 존재했던 이름이다. 그 사이에
  // 저장된 프리셋이 로드에서 튕기지 않도록 새 이름으로 읽어준다.
  if (v.merge === "byRole") v.merge = "byElement";
  if (typeof v.merge !== "string" || !MERGE_MODES.has(v.merge)) {
    throw new Error(`${msgPrefix}.merge: "none"/"all"/"perGroup" 중 하나가 아닙니다.`);
  }
  if (typeof v.naming !== "string" || !NAMING_MODES.has(v.naming)) {
    throw new Error(`${msgPrefix}.naming: "pathPrefix" 또는 "original"이 아닙니다.`);
  }
  if (typeof v.outputSuffix !== "string") throw new Error(`${msgPrefix}.outputSuffix: 문자열이 아닙니다.`);
  // roleTokens도 나중에 추가된 항목이라 그 전에 저장된 파일에는 없다 — 없으면
  // 기본값으로 읽고, 들어있는데 모양이 어긋나면 통과시키지 않는다.
  // splitLayers도 나중에 추가된 항목 — 없으면 기본값(합쳐서 한 파일)으로 읽는다.
  if (v.splitLayers !== undefined && typeof v.splitLayers !== "boolean") {
    throw new Error(`${msgPrefix}.splitLayers: boolean이 아닙니다.`);
  }
  // mergeRule도 나중에 추가된 항목 — 없으면 기존 동작(역할 접미사)으로 읽는다.
  if (v.mergeRule !== undefined && (typeof v.mergeRule !== "string" || !MERGE_RULES.has(v.mergeRule))) {
    throw new Error(`${msgPrefix}.mergeRule: "role"/"group"/"plane" 중 하나가 아닙니다.`);
  }
  if (v.roleTokens !== undefined) {
    if (!Array.isArray(v.roleTokens) || !v.roleTokens.every((t) => typeof t === "string")) {
      throw new Error(`${msgPrefix}.roleTokens: 문자열 배열이 아닙니다.`);
    }
  }
  // excludeTokens도 나중에 추가된 항목 — 없으면 기본 어휘로 읽는다. 빈 배열은
  // "제외하지 않겠다"는 뜻이므로 기본값으로 되돌리지 않는다.
  if (v.excludeTokens !== undefined) {
    if (!Array.isArray(v.excludeTokens) || !v.excludeTokens.every((t) => typeof t === "string")) {
      throw new Error(`${msgPrefix}.excludeTokens: 문자열 배열이 아닙니다.`);
    }
  }
  if (typeof v.embedPreview !== "boolean") throw new Error(`${msgPrefix}.embedPreview: boolean이 아닙니다.`);
  // lineColor는 나중에 추가된 항목이라, 그 이전에 저장된 presets.json에는 아예
  // 없다. 없는 것은 "원본 색 유지"(null)로 읽는다 — 형식이 깨진 값과 달리
  // 구버전 파일은 잘못된 것이 아니기 때문이다. 반대로 들어있는데 형식이
  // 어긋나면 통과시키지 않는다.
  if (v.lineColor !== undefined && v.lineColor !== null) {
    if (typeof v.lineColor !== "string" || !isValidLineColor(v.lineColor)) {
      throw new Error(`${msgPrefix}.lineColor: null 또는 "#RRGGBB" 형식이 아닙니다.`);
    }
  }
  // outputFormat도 나중에 추가된 항목이라 그 이전에 저장된 presets.json에는
  // 아예 없다. 없는 것은 "원본 따름"(psd)으로 읽는다 — 구버전 파일은 잘못된
  // 것이 아니기 때문이다. 반대로 들어있는데 모르는 값이면 통과시키지 않는다.
  if (v.outputFormat !== undefined && !OUTPUT_FORMATS.has(v.outputFormat as string)) {
    throw new Error(`${msgPrefix}.outputFormat: "psd", "png", "jpg" 중 하나가 아닙니다.`);
  }
  // edgeLines도 나중에 추가된 항목이라 그 이전 presets.json에는 없다. 없는 것은
  // 꺼짐으로 읽는다 — 구버전 파일은 잘못된 것이 아니다. 반대로 들어있는데 형식이
  // 어긋나면 통과시키지 않는다.
  // 키 자체가 없는 것(구버전 파일)과 키는 있는데 객체가 아닌 것(손상된 파일)을
  // 구분해야 한다 — typeof만으로는 null과 배열도 "object"로 잡히므로 따로
  // 걸러낸다. 여기서 조용히 기본값으로 바꿔치기하면, 파일에 적힌 값을 무시한
  // 채로 내보내기가 진행되어 아티스트가 의도하지 않은 결과물을 받게 된다 —
  // 차라리 막는 편이 낫다.
  if (
    v.edgeLines !== undefined &&
    (typeof v.edgeLines !== "object" || v.edgeLines === null || Array.isArray(v.edgeLines))
  ) {
    throw new Error(`${msgPrefix}.edgeLines: 객체가 아닙니다.`);
  }
  const edge = { ...DEFAULT_EDGE_LINES, ...((v.edgeLines as object | undefined) ?? {}) };
  if (typeof edge.enabled !== "boolean") {
    throw new Error(`${msgPrefix}.edgeLines.enabled: boolean이 아닙니다.`);
  }
  for (const key of ["threshold", "gap", "width", "minLength", "lineAlpha"] as const) {
    if (
      typeof edge[key] !== "number" ||
      !Number.isFinite(edge[key]) ||
      !Number.isInteger(edge[key]) ||
      edge[key] < 0
    ) {
      throw new Error(`${msgPrefix}.edgeLines.${key}: 0 이상의 정수가 아닙니다.`);
    }
  }
  // 저장된 프리셋에는 이 두 키가 없다(각 옵션이 생기기 전에 저장된 것들). 위의
  // 스프레드가 둘 다 기본값으로 메운다 — colourMode는 composite라 예전 프리셋이
  // 예전 동작 그대로지만, edgeMode는 일부러 그렇지 않다. 기본값이 region(새 검출)
  // 이라, edgeMode가 없던 예전 프리셋은 이제 새 검출을 쓴다 — region이 옛 change를
  // 밀어낸 이유가 바로 아티스트가 change를 결함으로 신고했기 때문이다(설계 문서 3절).
  if (edge.colourMode !== "composite" && edge.colourMode !== "paste") {
    throw new Error(`${msgPrefix}.edgeLines.colourMode: composite 또는 paste가 아닙니다.`);
  }
  if (edge.edgeMode !== "region" && edge.edgeMode !== "change") {
    throw new Error(`${msgPrefix}.edgeLines.edgeMode: region 또는 change가 아닙니다.`);
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
    mergeRule: (v.mergeRule as Preset["mergeRule"] | undefined) ?? "role",
    naming: v.naming as Preset["naming"],
    outputSuffix: v.outputSuffix,
    embedPreview: v.embedPreview,
    lineColor: (v.lineColor as string | null | undefined) ?? null,
    splitLayers: (v.splitLayers as boolean | undefined) ?? false,
    outputFormat: (v.outputFormat as OutputFormat | undefined) ?? "psd",
    excludeTokens: (v.excludeTokens as string[] | undefined) ?? [...DEFAULT_EXCLUDE_TOKENS],
    edgeLines: edge,
  };
}

/** Validates the parsed top-level JSON value is an array of well-formed Presets. */
function validatePresetList(value: unknown): Preset[] {
  if (!Array.isArray(value)) throw new Error("presets.json: 최상위 값이 배열이 아닙니다.");
  return value.map((item, index) => validatePreset(item, index));
}

/**
 * Parses and validates a raw presets.json string into Preset[], with no
 * filesystem access. `loadPresets` below is this plus the disk read — pulled
 * apart so validation rules (esp. the "missing key is fine, wrong-shaped key
 * throws" family) can be exercised directly without going through Tauri fs
 * mocks for every case.
 */
export function parsePresets(raw: string): Preset[] {
  const parsed: unknown = JSON.parse(raw);
  return validatePresetList(parsed);
}

/**
 * 기본 프리셋(BG·CHAR)은 **어느 컴퓨터에서든** 목록에 있어야 한다.
 *
 * 파일이 없을 때만 기본값을 주면 그 약속이 깨진다: 앱을 새로 설치해도 appData는
 * 지워지지 않으므로, 옛 버전이 써둔 `presets.json`이 남아 있는 컴퓨터에서는 그
 * 옛 목록만 뜨고 BG·CHAR이 아예 안 보인다(실제로 그런 컴퓨터가 있었다 — 지금
 * 소스에 없는 이름의 프리셋 하나만 떠 있었다). 그래서 읽어온 목록에 **없는**
 * 기본 프리셋만 끼워 넣는다. 이름이 같은 것이 이미 있으면 손대지 않는다 —
 * 아티스트가 고쳐 쓰는 판이 그쪽이다.
 *
 * **앞에 끼운다.** 새로 설치한 컴퓨터와 같은 순서로 보이게 하려는 것이다. 다만
 * 순서는 눈에만 보이는 값이 아니다 — 배치는 자기 드롭다운의 첫 번째로 출발하므로
 * (BatchPanel의 `defaultPresetName`), 기본값이 빠져 있던 컴퓨터에서는 배치의
 * 출발 프리셋도 BG로 바뀐다.
 *
 * 디스크에는 쓰지 않는다. `presets.json`은 아티스트가 저장을 누를 때만 바뀐다.
 * 그래서 일부러 지운 기본 프리셋도 다음 실행에 다시 보인다 — "기본은 항상
 * 보인다"를 지키는 대가이고, 지우기가 아니라 이름을 바꿔 쓰는 것이 답이다.
 */
export function withDefaultPresets(list: Preset[]): Preset[] {
  const names = new Set(list.map((p) => p.name));
  const missing = DEFAULT_PRESETS.filter((p) => !names.has(p.name)).map((p) => ({ ...p }));
  return missing.length === 0 ? list : [...missing, ...list];
}

/**
 * Loads presets from `appDataDir()/presets.json`. Returns DEFAULT_PRESETS
 * (BG, CHAR) when the file doesn't exist yet (first run), and tops up any
 * missing default when it does exist (see withDefaultPresets). Malformed JSON
 * and well-formed-but-wrong-shaped JSON are NOT absorbed here — both throw and
 * that rejection propagates to the caller, which must surface it (e.g. via
 * ErrorPanel).
 */
export async function loadPresets(): Promise<Preset[]> {
  const filePath = await presetsFilePath();
  if (!(await exists(filePath))) return DEFAULT_PRESETS.map((p) => ({ ...p }));
  const raw = await readTextFile(filePath);
  return withDefaultPresets(parsePresets(raw));
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
