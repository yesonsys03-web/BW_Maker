import { validatePreset } from "./presets";
import { previewRenderSpec } from "./previewCache";
import type { OpsState } from "./opsReducer";
import type { EdgeLines, Preset, TreeNode } from "./types";

export interface ProjectEntry {
  path: string;
  /** 저장 시점 디스크 수정시각. 다르면 이 항목의 작업과 미리보기를 버린다. */
  mtime: number;
  /** 엔진이 준 TreeNode[] 그대로. 이게 있어야 열자마자 레이어 패널이 그려진다. */
  tree: TreeNode[];
  /**
   * 프리셋 규칙에 걸린 레이어 id. **null은 "프리셋을 한 번도 안 걸었다"이고
   * []는 "걸었는데 한 장도 안 걸렸다"이다** — 둘은 다른 사실이고, 그 차이가
   * 그림과 내보내기를 양쪽에서 바꾼다. 미리보기 키에서 null(=undefined)은
   * `"all"` 세그먼트가 되고 []는 빈 문자열이 되며(previewCache.ts), 내보내기에서
   * null은 "전부 건다"·[]는 "아무 데도 안 건다"이다(ExportDialog.tsx).
   * 저장할 때 []로 뭉개면 다음에 열 때 키가 갈려 방금 쓴 PNG를 한 장도 못 읽고,
   * 색 통일 대상이 조용히 뒤집힌다.
   */
  matchedIds: number[] | null;
  ops: OpsState;
  /** 저장 시점에 계산돼 있던 캐시 키. 믿지 않고 대조에만 쓴다. */
  previewKey: string | null;
  /** previews/ 안의 파일 이름. 없으면 그림 없이 복원된다. */
  previewFile: string | null;
}

export interface ProjectFile {
  version: 1;
  preset: Preset | null;
  files: ProjectEntry[];
}

/**
 * 캐시 키를 previews/ 안의 파일 이름으로 바꾼다.
 *
 * 키에는 납품 파일 경로가 들어 있고 그 이름은 기밀이라 디스크에 남으면 안 된다.
 * 두 개의 서로 다른 해시 함수를 32비트 결과로 실어 16진 8자씩 총 16자를 만든다
 * (h1은 FNV-1a, h2는 Murmur3 finalizer상수 0x85ebca6b로 섞는다). 충돌 저항이
 * 목적이 아니라 이름을 짓는 것이 목적이고, 어긋나면 아래 대조(Task 5)에서 걸린다.
 */
export function previewFileName(key: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < key.length; i += 1) {
    const c = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}.png`;
}

function numberArray(v: unknown, where: string): number[] {
  if (!Array.isArray(v) || !v.every((n) => typeof n === "number")) {
    throw new Error(`${where}: 숫자 배열이 아닙니다.`);
  }
  return v as number[];
}

/**
 * 트리 노드가 최소한의 모양을 갖췄는지 확인한다. 각 노드는 non-null 객체이고
 * 숫자 id, 문자열 name·kind를 가져야 한다. children이 있으면 재귀로 검증한다.
 * 깊은 스키마 검증이 아니라 — 로드 시점에 레이어 패널이 .id/.name/.kind를
 * 읽고 그걸 렌더링해야 하므로, 그 최소한만 거절하고 나머지는 엔진이 준 대로 믿는다.
 */
function validateTreeNode(v: unknown, where: string): TreeNode {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error(`${where}: 객체가 아닙니다.`);
  }
  const node = v as Record<string, unknown>;
  if (typeof node.id !== "number") throw new Error(`${where}.id: 숫자가 아닙니다.`);
  if (typeof node.name !== "string") throw new Error(`${where}.name: 문자열이 아닙니다.`);
  if (typeof node.kind !== "string") throw new Error(`${where}.kind: 문자열이 아닙니다.`);
  if (Array.isArray(node.children)) {
    (node.children as unknown[]).forEach((child, i) => {
      validateTreeNode(child, `${where}.children[${i}]`);
    });
  }
  return v as TreeNode;
}

function validateTreeArray(v: unknown, where: string): TreeNode[] {
  if (!Array.isArray(v)) throw new Error(`${where}: 배열이 아닙니다.`);
  return v.map((node, i) => validateTreeNode(node, `${where}[${i}]`));
}

function validateOps(v: unknown, where: string): OpsState {
  if (typeof v !== "object" || v === null) throw new Error(`${where}: 객체가 아닙니다.`);
  const o = v as Record<string, unknown>;
  for (const key of ["includedIds", "previewHiddenIds", "soloIds", "edgeColourIds", "manualLineIds"]) {
    numberArray(o[key], `${where}.${key}`);
  }
  if (!Array.isArray(o.ops)) throw new Error(`${where}.ops: 배열이 아닙니다.`);
  if (!Array.isArray(o.entries)) throw new Error(`${where}.entries: 배열이 아닙니다.`);
  return v as OpsState;
}

function validateEntry(v: unknown, i: number): ProjectEntry {
  const where = `project.json files[${i}]`;
  if (typeof v !== "object" || v === null) throw new Error(`${where}: 객체가 아닙니다.`);
  const e = v as Record<string, unknown>;
  if (typeof e.path !== "string") throw new Error(`${where}.path: 문자열이 아닙니다.`);
  // 수정시각이 없으면 이 항목이 아직 맞는지 확인할 방법이 없다. 확인할 수 없는
  // 것을 복원하느니 거절한다 — previewCache.ts의 mtime 주석과 같은 판단이다.
  if (typeof e.mtime !== "number" || !Number.isFinite(e.mtime)) {
    throw new Error(`${where}.mtime: 숫자가 아닙니다.`);
  }
  const tree = validateTreeArray(e.tree, `${where}.tree`);
  // null은 정상값이다(ProjectEntry.matchedIds 주석 참고). 그 밖에는 숫자 배열만.
  const matchedIds = e.matchedIds === null ? null : numberArray(e.matchedIds, `${where}.matchedIds`);
  validateOps(e.ops, `${where}.ops`);
  if (e.previewKey !== null && typeof e.previewKey !== "string") {
    throw new Error(`${where}.previewKey: null 또는 문자열이 아닙니다.`);
  }
  if (e.previewFile !== null && typeof e.previewFile !== "string") {
    throw new Error(`${where}.previewFile: null 또는 문자열이 아닙니다.`);
  }
  return {
    path: e.path,
    mtime: e.mtime,
    tree,
    matchedIds,
    ops: e.ops as OpsState,
    previewKey: e.previewKey as string | null,
    previewFile: e.previewFile as string | null,
  };
}

/** 파싱과 검증만. 디스크 접근은 projectFs.ts가 한다(presets.ts와 같은 나눔). */
export function parseProject(raw: string): ProjectFile {
  const v: unknown = JSON.parse(raw);
  if (typeof v !== "object" || v === null) throw new Error("project.json: 객체가 아닙니다.");
  const p = v as Record<string, unknown>;
  if (p.version !== 1) throw new Error(`project.json version: 1이 아닙니다(${String(p.version)}).`);
  if (!Array.isArray(p.files)) throw new Error("project.json files: 배열이 아닙니다.");
  let preset: Preset | null = null;
  if (p.preset !== undefined && p.preset !== null) {
    preset = validatePreset(p.preset, 0, "project.json preset");
  }
  const files = p.files.map(validateEntry);
  // 중복 경로를 찾는다.
  const seen = new Set<string>();
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    if (seen.has(file.path)) {
      throw new Error(`project.json files[${i}]: 중복된 경로 항목입니다.`);
    }
    seen.add(file.path);
  }
  return {
    version: 1,
    preset,
    files,
  };
}

export function serializeProject(p: ProjectFile): string {
  return JSON.stringify(p, null, 2);
}

/**
 * 저장된 항목 중 아직 쓸 수 있는 것과, 파일이 바뀌어 버려야 하는 것을 가른다.
 *
 * 판정은 경로 + 수정시각이고 이 앱이 이미 쓰는 규약이다(previewCacheKey).
 * 버린 파일의 경로를 돌려주는 것이 요점이다 — 조용히 지우면 아티스트는 자기가
 * 한 지정이 왜 없는지 알 수 없다.
 *
 * 저장된 mtime은 engine이 os.path.getmtime()을 통째로 넘기고(float),
 * 디스크 조회는 int로 돌아온다(Task 6). 초 단위로 비교한다.
 */
export function reconcileProject(
  project: ProjectFile,
  mtimes: Record<string, number | undefined>
): { fresh: ProjectEntry[]; stale: string[] } {
  const fresh: ProjectEntry[] = [];
  const stale: string[] = [];
  for (const entry of project.files) {
    const diskMtime = mtimes[entry.path];
    if (diskMtime !== undefined && Math.floor(diskMtime) === Math.floor(entry.mtime)) {
      fresh.push(entry);
    } else {
      stale.push(entry.path);
    }
  }
  return { fresh, stale };
}

/**
 * 복원한 항목 중 미리보기를 그대로 붙여도 되는 것만 고른다.
 *
 * **저장된 previewKey는 믿지 않는다.** 복원한 상태로 키를 다시 계산해서 저장된
 * 것과 같을 때만 붙인다. 다르면 저장과 복원 사이에 키 구성이 바뀌었다는 뜻이고,
 * 그때 옛 그림을 붙이면 아티스트는 지금 설정과 다른 그림을 보면서 확인했다고
 * 믿게 된다(설계 5절).
 *
 * 미리보기 유효성 판정을 여기서 새로 만들지 않는 것이 요점이다 — previewCacheKey가
 * 이미 경로·수정시각·보이는 레이어·라인색·경계선 설정·지정·체크를 전부 담고 있다.
 */
export function restorablePreviews(
  entries: ProjectEntry[],
  previews: Map<string, string>,
  lineColor: string | null,
  edgeLines: EdgeLines | null
): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const entry of entries) {
    if (!entry.previewKey || !entry.previewFile) continue;
    const dataUrl = previews.get(entry.previewFile);
    if (!dataUrl) continue;
    const plan = previewRenderSpec(
      { path: entry.path, mtime: entry.mtime },
      entry.tree,
      entry.ops.includedIds,
      entry.ops.previewHiddenIds,
      entry.ops.soloIds,
      lineColor,
      // null은 여기서 undefined로 되돌린다 — 저장할 때 키를 만든 값이 그것이다
      // (buildProject는 matchedIdsByPath에 없는 파일을 null로 적는다).
      // `?? []`로 뭉개면 키 세그먼트가 "all"에서 ""로 바뀌어 대조가 늘 어긋나고,
      // 방금 쓴 PNG를 한 장도 못 붙인다.
      entry.matchedIds ?? undefined,
      edgeLines,
      entry.ops.edgeColourIds
    );
    if (!plan.key || plan.key !== entry.previewKey) continue;
    out.push([plan.key, dataUrl]);
  }
  return out;
}
