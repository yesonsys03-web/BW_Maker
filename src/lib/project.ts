import { validatePreset } from "./presets";
import type { OpsState } from "./opsReducer";
import type { Preset, TreeNode } from "./types";

export interface ProjectEntry {
  path: string;
  /** 저장 시점 디스크 수정시각. 다르면 이 항목의 작업과 미리보기를 버린다. */
  mtime: number;
  /** 엔진이 준 TreeNode[] 그대로. 이게 있어야 열자마자 레이어 패널이 그려진다. */
  tree: TreeNode[];
  matchedIds: number[];
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
  numberArray(e.matchedIds, `${where}.matchedIds`);
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
    matchedIds: e.matchedIds as number[],
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
  return {
    version: 1,
    preset,
    files: p.files.map(validateEntry),
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
 */
export function reconcileProject(
  project: ProjectFile,
  mtimes: Record<string, number | undefined>
): { fresh: ProjectEntry[]; stale: string[] } {
  const fresh: ProjectEntry[] = [];
  const stale: string[] = [];
  for (const entry of project.files) {
    if (mtimes[entry.path] === entry.mtime) fresh.push(entry);
    else stale.push(entry.path);
  }
  return { fresh, stale };
}
