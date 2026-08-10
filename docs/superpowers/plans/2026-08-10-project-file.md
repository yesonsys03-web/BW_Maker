# 프로젝트 파일 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 앱을 껐다 켜도 `.bwproj` 폴더 하나로 파일 목록·레이어 트리·손으로 한 작업·미리보기가 그대로 다시 뜨게 한다.

**Architecture:** `project.json`(파일 목록 + 파일마다 경로·수정시각·트리·`OpsState`·매칭 결과 + 프리셋)과 `previews/`(파일마다 PNG 한 장)를 담는 폴더. 여는 쪽은 디스크 읽기만으로 화면을 세우고 엔진을 부르지 않는다. 미리보기가 아직 유효한지는 **기존 `previewCacheKey`가 그대로 판정한다** — 새 규칙을 만들지 않는다. 수정시각이 다른 파일은 작업을 버리고 표시한다.

**Tech Stack:** React + TypeScript(Vitest), Tauri plugin-fs / plugin-dialog, 기존 `PreviewCache`·`previewRenderSpec`.

## Global Constraints

- 형식은 **JSON**. 트리는 엔진이 준 `TreeNode[]` 그대로 싣는다 — 변환층을 만들지 않는다.
- 저장은 **수동**만. 자동 저장·종료 확인창·자동 복구를 만들지 않는다. 프로젝트를 안 쓰면 앱은 지금과 똑같이 동작한다.
- 파일 식별은 **경로 + 수정시각**. 수정시각이 다르면 그 파일의 작업과 미리보기를 버리고 목록에 표시한다.
- 미리보기 유효성 판정은 **`previewCacheKey`를 재사용**한다. 저장된 `previewKey`는 믿지 않고 대조에만 쓴다.
- `previews/` 파일 이름은 **키 해시**로 짓는다. 납품 파일명이 디스크에 남으면 안 된다(기밀).
- 잘못된 모양의 JSON은 조용히 기본값으로 바꿔치기하지 않고 **던진다**. `presets.ts`의 `validatePreset`과 같은 규약이다.
- 검증은 매 작업 `npx tsc --noEmit`와 해당 테스트. `src/App.test.tsx > resume picks the remaining files back up`은 **기존 플레이크**다(HEAD에서 전체 파일 3/3 실패). 이것만 빨간불이면 통과로 본다.

---

## File Structure

| 파일 | 책임 |
|---|---|
| `src/lib/project.ts` (신규) | 프로젝트 타입, 직렬화, 검증, 키 해시. **파일시스템 접근 없음** |
| `src/lib/project.test.ts` (신규) | 위의 순수 로직 테스트 |
| `src/lib/projectFs.ts` (신규) | 폴더 읽기/쓰기(Tauri fs). `project.ts`를 쓰고 디스크만 담당 |
| `src/lib/projectFs.test.ts` (신규) | fs를 모킹한 입출력 테스트 |
| `src/state/appStore.tsx` (수정) | `restoreProject` 액션, `openSuccess`가 복원본을 덮지 않게 |
| `src/App.tsx` (수정) | 열기/저장 배선, 캐시 프라이밍, 바뀐 파일 표시 |
| `src/components/FilePanel.tsx` (수정) | "파일이 바뀌었습니다" 배지 |
| `src/components/ProjectBar.tsx` (신규) | 열기·저장·다른 이름으로 저장 버튼과 현재 프로젝트 이름 |

`project.ts`와 `projectFs.ts`를 나누는 이유는 `presets.ts`가 이미 그 이유로 `parsePresets`를 따로 뽑아둔 것과 같다 — 검증 규칙을 Tauri fs 모킹 없이 직접 시험할 수 있어야 한다.

---

## Task 1: 프로젝트 타입과 검증 (순수)

**Files:**
- Create: `src/lib/project.ts`
- Test: `src/lib/project.test.ts`

**Interfaces:**
- Consumes: `OpsState`(`src/lib/opsReducer.ts`), `TreeNode`·`Preset`(`src/lib/types.ts`)
- Produces:
  - `interface ProjectEntry { path: string; mtime: number; tree: TreeNode[]; matchedIds: number[]; ops: OpsState; previewKey: string | null; previewFile: string | null }`
  - `interface ProjectFile { version: 1; preset: Preset | null; files: ProjectEntry[] }`
  - `parseProject(raw: string): ProjectFile`
  - `serializeProject(p: ProjectFile): string`
  - `previewFileName(key: string): string`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/lib/project.test.ts`:

```ts
import { expect, test } from "vitest";
import { parseProject, previewFileName, serializeProject, type ProjectFile } from "./project";

const OPS = {
  includedIds: [1, 2], previewHiddenIds: [2], soloIds: [], edgeColourIds: [3],
  manualLineIds: [4], ops: [], entries: [],
};

const TREE = [{
  id: 1, name: "line", kind: "pixel", visible: true, opacity: 255,
  blendMode: "normal", bbox: [0, 0, 10, 10], hasMask: false, hasPixels: true, path: ["line"],
}];

function projectOf(): ProjectFile {
  return {
    version: 1,
    preset: null,
    files: [{
      path: "/cuts/a.psd", mtime: 1700, tree: TREE as never, matchedIds: [1],
      ops: OPS as never, previewKey: "k", previewFile: "abc.png",
    }],
  };
}

test("a project survives a round trip unchanged", () => {
  const back = parseProject(serializeProject(projectOf()));
  expect(back).toEqual(projectOf());
});

// 조용히 기본값으로 바꿔치기하면, 파일에 적힌 것과 다른 상태로 작업이 이어진다.
test("a file entry with no mtime is refused", () => {
  const p = projectOf() as unknown as { files: Record<string, unknown>[] };
  delete p.files[0].mtime;
  expect(() => parseProject(JSON.stringify(p))).toThrow(/mtime/);
});

test("an unknown version is refused", () => {
  const p = { ...projectOf(), version: 2 };
  expect(() => parseProject(JSON.stringify(p))).toThrow(/version/);
});

// 납품 파일명은 기밀이라 디스크에 남으면 안 된다.
test("the preview file name leaks nothing from the key", () => {
  const name = previewFileName("/Volumes/x/HH03_SECRET.psd\n1700\ncomposite");
  expect(name).toMatch(/^[0-9a-f]{16}\.png$/);
  expect(name).not.toContain("HH03");
});

test("the same key always makes the same preview file name", () => {
  expect(previewFileName("k")).toBe(previewFileName("k"));
  expect(previewFileName("k")).not.toBe(previewFileName("k2"));
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npm test -- --run src/lib/project.test.ts`
Expected: FAIL — `Failed to resolve import "./project"`

- [ ] **Step 3: 최소 구현을 쓴다**

`src/lib/project.ts`:

```ts
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
 * FNV-1a 64비트를 32비트 둘로 나눠 돌린다 — 충돌 저항이 목적이 아니라 이름을
 * 짓는 것이 목적이고, 어긋나면 아래 대조(Task 5)에서 걸린다.
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
  if (!Array.isArray(e.tree)) throw new Error(`${where}.tree: 배열이 아닙니다.`);
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
    tree: e.tree as TreeNode[],
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
  return {
    version: 1,
    preset: (p.preset as Preset | null) ?? null,
    files: p.files.map(validateEntry),
  };
}

export function serializeProject(p: ProjectFile): string {
  return JSON.stringify(p, null, 2);
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `npm test -- --run src/lib/project.test.ts`
Expected: PASS (5개)

- [ ] **Step 5: 변이로 테스트가 진짜 잡는지 확인한다**

`parseProject`의 `if (typeof e.mtime !== "number" ...)` 줄을 지우고 다시 돌린다.
Expected: `a file entry with no mtime is refused`만 FAIL. 확인 후 되돌린다.

- [ ] **Step 6: 커밋**

```bash
git add src/lib/project.ts src/lib/project.test.ts
git commit -m "feat: project file types and validation"
```

---

## Task 2: 폴더 읽기/쓰기

**Files:**
- Create: `src/lib/projectFs.ts`
- Test: `src/lib/projectFs.test.ts`

**Interfaces:**
- Consumes: Task 1의 `ProjectFile`, `parseProject`, `serializeProject`, `previewFileName`
- Produces:
  - `saveProjectTo(dir: string, project: ProjectFile, previews: Map<string, string>): Promise<void>` — `previews`는 `previewFile` 이름 → data URL
  - `loadProjectFrom(dir: string): Promise<{ project: ProjectFile; previews: Map<string, string> }>` — 없는 PNG는 조용히 빠진다(그림만 없고 작업은 산다)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/lib/projectFs.test.ts`:

```ts
import { beforeEach, expect, test, vi } from "vitest";

const fs = vi.hoisted(() => ({
  exists: vi.fn(), mkdir: vi.fn(), readTextFile: vi.fn(),
  writeTextFile: vi.fn(), readFile: vi.fn(), writeFile: vi.fn(), remove: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-fs", () => fs);
vi.mock("@tauri-apps/api/path", () => ({ join: async (...p: string[]) => p.join("/") }));

import { loadProjectFrom, saveProjectTo } from "./projectFs";
import type { ProjectFile } from "./project";

const PROJECT: ProjectFile = {
  version: 1, preset: null,
  files: [{
    path: "/cuts/a.psd", mtime: 1700, tree: [], matchedIds: [1],
    ops: { includedIds: [1], previewHiddenIds: [], soloIds: [], edgeColourIds: [], manualLineIds: [], ops: [], entries: [] } as never,
    previewKey: "k", previewFile: "aa.png",
  }],
};

beforeEach(() => {
  vi.clearAllMocks();
  fs.mkdir.mockResolvedValue(undefined);
  fs.writeTextFile.mockResolvedValue(undefined);
  fs.writeFile.mockResolvedValue(undefined);
  fs.exists.mockResolvedValue(true);
});

test("saving writes project.json and every preview into previews/", async () => {
  await saveProjectTo("/p/x.bwproj", PROJECT, new Map([["aa.png", "data:image/png;base64,AAA="]]));

  expect(fs.writeTextFile).toHaveBeenCalledWith("/p/x.bwproj/project.json", expect.stringContaining('"version": 1'));
  expect(fs.writeFile).toHaveBeenCalledWith("/p/x.bwproj/previews/aa.png", expect.any(Uint8Array));
});

test("loading returns the project and the previews it found", async () => {
  fs.readTextFile.mockResolvedValue(JSON.stringify(PROJECT));
  fs.readFile.mockResolvedValue(new Uint8Array([0, 1, 2]));

  const { project, previews } = await loadProjectFrom("/p/x.bwproj");

  expect(project.files[0].path).toBe("/cuts/a.psd");
  expect(previews.get("aa.png")).toMatch(/^data:image\/png;base64,/);
});

// 그림이 없어졌다고 작업까지 버리면 안 된다 — 그림은 다시 만들 수 있고 판단은 못 만든다.
test("a missing preview loses the picture, not the work", async () => {
  fs.readTextFile.mockResolvedValue(JSON.stringify(PROJECT));
  fs.exists.mockImplementation(async (p: string) => !p.endsWith("aa.png"));

  const { project, previews } = await loadProjectFrom("/p/x.bwproj");

  expect(project.files).toHaveLength(1);
  expect(previews.size).toBe(0);
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npm test -- --run src/lib/projectFs.test.ts`
Expected: FAIL — `Failed to resolve import "./projectFs"`

- [ ] **Step 3: 최소 구현을 쓴다**

`src/lib/projectFs.ts`:

```ts
import { join } from "@tauri-apps/api/path";
import { exists, mkdir, readFile, readTextFile, writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { parseProject, serializeProject, type ProjectFile } from "./project";

const PROJECT_JSON = "project.json";
const PREVIEWS_DIR = "previews";

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToDataUrl(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return `data:image/png;base64,${btoa(bin)}`;
}

/**
 * 프로젝트 폴더를 통째로 쓴다. `previews`는 previewFile 이름 → data URL.
 *
 * 폴더인 이유는 설계 2.2절에 있다 — 필요한 그림만 읽기 위해서다. 그림을 JSON에
 * base64로 실으면 33% 커지고 그 전부가 파싱 대상이 된다.
 */
export async function saveProjectTo(
  dir: string,
  project: ProjectFile,
  previews: Map<string, string>
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const previewDir = await join(dir, PREVIEWS_DIR);
  await mkdir(previewDir, { recursive: true });
  await writeTextFile(await join(dir, PROJECT_JSON), serializeProject(project));
  for (const [name, dataUrl] of previews) {
    await writeFile(await join(previewDir, name), dataUrlToBytes(dataUrl));
  }
}

/**
 * 프로젝트 폴더를 읽는다. project.json이 깨져 있으면 던진다(호출부가
 * ErrorPanel로 보낸다) — 조용히 빈 프로젝트로 여는 것은 작업을 잃는 것과 같다.
 *
 * 반면 **PNG 하나가 없는 것은 던지지 않는다.** 그림은 다시 만들 수 있고 손으로
 * 한 판단은 못 만든다. 그림 없는 파일은 화면이 눌렀을 때 새로 그린다.
 */
export async function loadProjectFrom(
  dir: string
): Promise<{ project: ProjectFile; previews: Map<string, string> }> {
  const project = parseProject(await readTextFile(await join(dir, PROJECT_JSON)));
  const previewDir = await join(dir, PREVIEWS_DIR);
  const previews = new Map<string, string>();
  for (const entry of project.files) {
    if (!entry.previewFile) continue;
    const p = await join(previewDir, entry.previewFile);
    if (!(await exists(p))) continue;
    previews.set(entry.previewFile, bytesToDataUrl(await readFile(p)));
  }
  return { project, previews };
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `npm test -- --run src/lib/projectFs.test.ts`
Expected: PASS (3개)

- [ ] **Step 5: 변이 확인**

`loadProjectFrom`의 `if (!(await exists(p))) continue;`를 지우고 돌린다.
Expected: `a missing preview loses the picture, not the work`가 FAIL. 되돌린다.

- [ ] **Step 6: 커밋**

```bash
git add src/lib/projectFs.ts src/lib/projectFs.test.ts
git commit -m "feat: read and write the project folder"
```

---

## Task 3: 수정시각 판정

**Files:**
- Modify: `src/lib/project.ts`
- Test: `src/lib/project.test.ts`

**Interfaces:**
- Produces: `reconcileProject(project: ProjectFile, mtimes: Record<string, number | undefined>): { fresh: ProjectEntry[]; stale: string[] }`

`mtimes`는 호출부가 디스크에서 읽어 온 값이다. 파일이 없으면 `undefined`.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/lib/project.test.ts` 끝에 덧붙인다:

```ts
import { reconcileProject } from "./project";

function entryAt(path: string, mtime: number) {
  return {
    path, mtime, tree: [], matchedIds: [], previewKey: "k", previewFile: "a.png",
    ops: { includedIds: [], previewHiddenIds: [], soloIds: [], edgeColourIds: [], manualLineIds: [], ops: [], entries: [] },
  } as never;
}

test("a file whose mtime still matches keeps its work", () => {
  const p = { version: 1 as const, preset: null, files: [entryAt("/a.psd", 1700)] };
  const { fresh, stale } = reconcileProject(p, { "/a.psd": 1700 });
  expect(fresh.map((e) => e.path)).toEqual(["/a.psd"]);
  expect(stale).toEqual([]);
});

// 저장된 것은 전부 레이어 id이고, PSD가 바뀌면 id가 밀린다. 조용히 붙이면
// "라인 지정"이 엉뚱한 레이어를 가리킨다.
test("a file that was saved in Photoshop since loses its work and is named", () => {
  const p = { version: 1 as const, preset: null, files: [entryAt("/a.psd", 1700)] };
  const { fresh, stale } = reconcileProject(p, { "/a.psd": 1800 });
  expect(fresh).toEqual([]);
  expect(stale).toEqual(["/a.psd"]);
});

test("a file that is gone from disk is stale too", () => {
  const p = { version: 1 as const, preset: null, files: [entryAt("/a.psd", 1700)] };
  const { stale } = reconcileProject(p, {});
  expect(stale).toEqual(["/a.psd"]);
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npm test -- --run src/lib/project.test.ts`
Expected: FAIL — `reconcileProject is not a function`

- [ ] **Step 3: 구현을 쓴다**

`src/lib/project.ts` 끝에 덧붙인다:

```ts
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
```

- [ ] **Step 4: 통과를 확인한다**

Run: `npm test -- --run src/lib/project.test.ts`
Expected: PASS (8개)

- [ ] **Step 5: 커밋**

```bash
git add src/lib/project.ts src/lib/project.test.ts
git commit -m "feat: drop a project entry whose file changed"
```

---

## Task 4: 스토어 복원 — 그리고 `openSuccess`가 덮지 않게

**Files:**
- Modify: `src/state/appStore.tsx`
- Test: `src/state/appStore.test.ts`

**이 작업이 이 계획에서 제일 조용히 망가지는 자리다.** `appStore.tsx:216`의 `openSuccess`는 `opsByPath[path]`를 `buildInitialOpsState(result.tree)`로 **덮어쓴다**. 복원을 해두어도 배경 큐가 그 파일을 여는 순간 손으로 한 작업이 전부 지워진다.

**Interfaces:**
- Produces:
  - 액션 `{ type: "restoreProject"; entries: ProjectEntry[] }`
  - `AppState`에 `restoredMtimeByPath: Record<string, number>` 추가

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/state/appStore.test.ts` 끝에 덧붙인다:

```ts
import { reducer, initialAppState } from "./appStore";

const RESTORED_OPS = {
  includedIds: [1, 2], previewHiddenIds: [2], soloIds: [], edgeColourIds: [],
  manualLineIds: [2], ops: [], entries: [],
};
const RESTORED_TREE = [{
  id: 1, name: "line", kind: "pixel", visible: true, opacity: 255, blendMode: "normal",
  bbox: [0, 0, 4, 4], hasMask: false, hasPixels: true, path: ["line"],
}];

function restored() {
  return reducer(initialAppState, {
    type: "restoreProject",
    entries: [{
      path: "/cuts/a.psd", mtime: 1700, tree: RESTORED_TREE as never, matchedIds: [1],
      ops: RESTORED_OPS as never, previewKey: "k", previewFile: "a.png",
    }],
  } as never);
}

test("restoring a project seeds the list, the tree and the work", () => {
  const s = restored();
  expect(s.files.map((f) => f.path)).toEqual(["/cuts/a.psd"]);
  expect(s.files[0].tree).toEqual(RESTORED_TREE);
  expect(s.opsByPath["/cuts/a.psd"].manualLineIds).toEqual([2]);
  expect(s.matchedIdsByPath["/cuts/a.psd"]).toEqual([1]);
});

// 배경 큐가 그 파일을 열면 openSuccess가 도는데, 그것이 초기 상태로 덮으면
// 복원한 의미가 없다 — 손으로 한 지정이 조용히 사라진다.
test("opening a restored file in the background keeps the restored work", () => {
  const s = reducer(restored(), {
    type: "openSuccess",
    path: "/cuts/a.psd",
    result: {
      sessionId: 7, width: 4, height: 4, colorMode: "RGB", depth: 8,
      tree: RESTORED_TREE, mtime: 1700,
    },
  } as never);

  expect(s.opsByPath["/cuts/a.psd"].manualLineIds).toEqual([2]);
  expect(s.files[0].sessionId).toBe(7);
});

// 파일이 그 사이 바뀌었으면 복원본을 붙들면 안 된다 — id가 밀렸다.
test("opening a restored file whose mtime moved resets the work", () => {
  const s = reducer(restored(), {
    type: "openSuccess",
    path: "/cuts/a.psd",
    result: {
      sessionId: 7, width: 4, height: 4, colorMode: "RGB", depth: 8,
      tree: RESTORED_TREE, mtime: 1899,
    },
  } as never);

  expect(s.opsByPath["/cuts/a.psd"].manualLineIds).toEqual([]);
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npm test -- --run src/state/appStore.test.ts`
Expected: FAIL — 첫 테스트가 `files`가 비어 있다고 실패

- [ ] **Step 3: 액션과 상태를 더한다**

`src/state/appStore.tsx`의 `AppState`에 한 줄:

```ts
  /**
   * 프로젝트에서 복원한 파일의 수정시각. openSuccess가 이걸 보고 복원한 작업을
   * 지킬지 정한다 — 아래 openSuccess 주석 참고.
   */
  restoredMtimeByPath: Record<string, number>;
```

`initialAppState`에 `restoredMtimeByPath: {}`를 더하고, 액션 유니온에 한 줄:

```ts
  | { type: "restoreProject"; entries: ProjectEntry[] }
```

리듀서에 케이스를 더한다:

```ts
    case "restoreProject": {
      const files: FileEntry[] = action.entries.map((e) => ({
        path: e.path, status: "idle", tree: e.tree, mtime: e.mtime,
      }));
      const opsByPath: Record<string, OpsState> = {};
      const matchedIdsByPath: Record<string, number[]> = {};
      const restoredMtimeByPath: Record<string, number> = {};
      for (const e of action.entries) {
        opsByPath[e.path] = e.ops;
        matchedIdsByPath[e.path] = e.matchedIds;
        restoredMtimeByPath[e.path] = e.mtime;
      }
      return {
        ...initialAppState,
        files, opsByPath, matchedIdsByPath, restoredMtimeByPath,
        activePath: files[0]?.path ?? null,
      };
    }
```

- [ ] **Step 4: `openSuccess`가 복원본을 지키게 한다**

`appStore.tsx:216`의 `opsByPath` 한 줄을 바꾼다:

```ts
        // 복원한 작업은 지킨다. 이 자리가 이 기능에서 제일 조용히 망가지는
        // 곳이다 — 프로젝트를 열어 손으로 한 지정을 되살려 놓아도, 배경 큐가
        // 그 파일을 여는 순간 여기서 초기 상태로 덮여 전부 사라진다.
        //
        // 지키는 조건은 **수정시각이 그대로일 때뿐**이다. 저장된 것은 전부
        // 레이어 id이고 PSD가 바뀌면 id가 밀리므로, 그때 붙들면 "라인 지정"이
        // 엉뚱한 레이어를 가리킨다(설계 4절).
        opsByPath: {
          ...state.opsByPath,
          [path]: state.restoredMtimeByPath[path] === result.mtime && state.opsByPath[path]
            ? state.opsByPath[path]
            : buildInitialOpsState(result.tree),
        },
```

`matchedIdsByPath`에서 이 파일 것을 지우는 위쪽 코드도 같은 조건으로 감싼다 — 복원한 매칭 결과를 버리면 캐시 키가 달라져 미리보기를 전부 다시 그린다(설계 7절).

```ts
      const matchedIdsByPath = { ...state.matchedIdsByPath };
      if (!(state.restoredMtimeByPath[path] === result.mtime)) delete matchedIdsByPath[path];
```

- [ ] **Step 5: 통과를 확인한다**

Run: `npm test -- --run src/state/appStore.test.ts`
Expected: PASS (셋 다)

- [ ] **Step 6: 변이 확인**

Step 4의 삼항을 `buildInitialOpsState(result.tree)`로 되돌리고 돌린다.
Expected: `opening a restored file in the background keeps the restored work`만 FAIL. 되돌린다.

- [ ] **Step 7: 커밋**

```bash
git add src/state/appStore.tsx src/state/appStore.test.ts
git commit -m "feat: restore a project into the store without the open queue wiping it"
```

---

## Task 5: 미리보기 캐시 프라이밍 — 키를 다시 계산해서 대조

**Files:**
- Modify: `src/App.tsx`
- Test: `src/App.test.tsx`

**Interfaces:**
- Consumes: Task 1의 `ProjectEntry`, 기존 `previewRenderSpec`
- Produces: `restorablePreviews(entries: ProjectEntry[], previews: Map<string, string>, lineColor: string | null, edgeLines: EdgeLines | null): Array<[string, string]>` — 붙여도 되는 `[키, dataUrl]` 목록. `src/lib/project.ts`에 둔다.

**순수 함수로 빼는 이유**: 판정("저장된 키를 믿지 않고 다시 계산해 대조한다")이 이 기능의 핵심인데, App 안의 내부 함수로 두면 그 판정만 따로 시험할 수 없다. `presets.ts`가 `parsePresets`를 따로 뽑아둔 것과 같은 이유다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/lib/project.test.ts`에 덧붙인다:

```ts
import { previewCacheKey } from "./previewCache";
import { restorablePreviews } from "./project";

const LEAF = {
  id: 1, name: "line", kind: "pixel", visible: true, opacity: 255, blendMode: "normal",
  bbox: [0, 0, 4, 4], hasMask: false, hasPixels: true, path: ["line"],
};

function entryWithRealKey() {
  const tree = [LEAF] as never;
  const ops = {
    includedIds: [1], previewHiddenIds: [], soloIds: [], edgeColourIds: [],
    manualLineIds: [], ops: [], entries: [],
  };
  const key = previewCacheKey(
    { path: "/cuts/a.psd", mtime: 1700 }, true, [1], null, [1], null, [], [1]
  );
  return {
    path: "/cuts/a.psd", mtime: 1700, tree, matchedIds: [1], ops: ops as never,
    previewKey: key, previewFile: "a.png",
  };
}

test("a preview whose key still comes out the same is restorable", () => {
  const out = restorablePreviews(
    [entryWithRealKey() as never],
    new Map([["a.png", "data:image/png;base64,AAA="]]),
    null, null
  );
  expect(out).toHaveLength(1);
  expect(out[0][1]).toBe("data:image/png;base64,AAA=");
});

// 저장과 복원 사이에 키 구성이 바뀌면(앱 업데이트로 항목이 늘어나는 일은 실제로
// 있었다) 옛 그림을 붙이면 안 된다 — 아티스트가 지금 설정과 다른 그림을 보면서
// 확인했다고 믿게 된다.
test("a preview whose stored key no longer matches is dropped", () => {
  const e = { ...entryWithRealKey(), previewKey: "저장될 때의 옛 키" };
  const out = restorablePreviews(
    [e as never], new Map([["a.png", "data:image/png;base64,AAA="]]), null, null
  );
  expect(out).toEqual([]);
});

test("an entry whose PNG is gone is dropped without throwing", () => {
  const out = restorablePreviews([entryWithRealKey() as never], new Map(), null, null);
  expect(out).toEqual([]);
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npm test -- --run src/lib/project.test.ts`
Expected: FAIL — `restorablePreviews is not a function`

- [ ] **Step 3: 구현을 쓴다**

`src/lib/project.ts`에 덧붙인다:

```ts
import { previewRenderSpec } from "./previewCache";
import type { EdgeLines } from "./types";

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
      entry.matchedIds,
      edgeLines,
      entry.ops.edgeColourIds
    );
    if (!plan.key || plan.key !== entry.previewKey) continue;
    out.push([plan.key, dataUrl]);
  }
  return out;
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `npm test -- --run src/lib/project.test.ts`
Expected: PASS (11개)

- [ ] **Step 5: 변이 확인**

`if (!plan.key || plan.key !== entry.previewKey) continue;`를 `if (!plan.key) continue;`로 바꾸고 돌린다.
Expected: `a preview whose stored key no longer matches is dropped`만 FAIL. 되돌린다.

- [ ] **Step 6: App이 그것을 캐시에 넣게 한다**

`App.tsx`에 더한다. `prefetchedKeysRef`에도 넣는 것이 중요하다 — 그래야 캐시가 예산으로 밀어내도 준비 큐가 다시 만들지 않는다(`needsPrefetch`의 두 그물 중 하나).

```ts
  const primeRestoredPreviews = useCallback((entries: ProjectEntry[], previews: Map<string, string>) => {
    for (const [key, dataUrl] of restorablePreviews(
      entries, previews,
      presetRef.current?.lineColor ?? null,
      presetRef.current?.edgeLines ?? null
    )) {
      previewCacheRef.current.set(key, dataUrl);
      prefetchedKeysRef.current.add(key);
    }
  }, []);
```

- [ ] **Step 7: 타입 검사와 커밋**

```bash
npx tsc --noEmit && npm test -- --run src/lib/project.test.ts
git add src/lib/project.ts src/lib/project.test.ts src/App.tsx
git commit -m "feat: restore previews only when the key still comes out the same"
```

---

## Task 5.5: 로드 큐가 복원한 파일에 프리셋을 다시 걸지 않게

**Files:**
- Modify: `src/state/appStore.tsx`, `src/App.tsx`
- Test: `src/state/appStore.test.ts`, `src/App.test.tsx`

Task 4의 리뷰가 찾은 자리다. Task 4는 `openSuccess`가 복원본을 덮는 문을 막았는데,
**그 옆에 문이 하나 더 있다.**

`App.tsx:358-361`의 로드 큐는 파일을 연 직후 **`presetApplied`를 보지 않고 무조건**
`applyPresetEffect`를 부른다(바로 아래 그물 효과 `:680`은 본다). 복원한 파일은
`status: "idle"`로 들어가므로 큐가 전부 집어 가고, `applyPresetResult`가
`includedIds`·`ops`·`entries`·`matchedIdsByPath`를 새 매칭 결과로 덮어쓴다 —
**아티스트의 체크 편집과 병합이 바로 그렇게 사라진다.** (`manualLineIds`·
`edgeColourIds`·`soloIds`·`previewHiddenIds`는 `applyPresetResult`가 그대로 넘겨서
살아남는다. 그래서 증상이 "일부만 사라짐"이라 더 알아채기 어렵다.)

고치는 방향은 `presetApplied`의 뜻을 지키는 것이다 — "이 파일의 ops는 이미 프리셋
적용에서 나왔다".

- `openSuccess`가 복원본을 지킨 경우(Task 4의 조건이 참일 때) `presetApplied`를
  **`true`** 로 둔다. 복원한 ops는 지난 세션의 프리셋 적용에서 나온 것이고, 그 위에
  아티스트가 편집을 얹었다. 다시 걸면 그 편집이 사라진다.
- 로드 큐가 적용 전에 `presetApplied !== true`를 확인한다. 지금 큐와 그물 효과가
  이 값을 두고 서로 다르게 굴고 있는데, 그 어긋남 자체가 이 결함의 원인이다.

테스트 둘:
- 리듀서: 복원한 파일의 `openSuccess` 뒤 `presetApplied`가 `true`, 복원하지 않은
  파일은 `false`.
- App: 복원한 파일이 목록에 있을 때 로드 큐가 그 파일에 `applyPreset`을 부르지
  않는다. 복원하지 않은 파일에는 지금처럼 부른다.

변이 확인: 큐의 `presetApplied` 조건을 지우면 App 쪽 테스트만 빨간불이어야 한다.

## Task 6: 열기·저장 UI와 "파일이 바뀌었습니다" 표시

**Files:**
- Create: `src/components/ProjectBar.tsx`
- Modify: `src/App.tsx`, `src/components/FilePanel.tsx`, `src/App.css`
- Test: `src/components/FilePanel.test.tsx`, `src/App.test.tsx`

**Interfaces:**
- Consumes: Task 2의 `saveProjectTo`·`loadProjectFrom`, Task 3의 `reconcileProject`, Task 4의 `restoreProject`, Task 5의 `primeRestoredPreviews`
- Produces: `ProjectBar` — props `{ projectDir: string | null; onOpen: () => void; onSave: () => void; onSaveAs: () => void }`

- [ ] **Step 1: 바뀐 파일 표시의 실패 테스트를 쓴다**

`src/components/FilePanel.test.tsx`에 덧붙인다:

```ts
test("a file whose PSD changed since the project was saved says so", () => {
  renderPanel([fileAt("/cuts/moved.psd")], { "/cuts/moved.psd": 3 }, ["/cuts/moved.psd"]);

  expect(screen.getByText("파일이 바뀜")).toBeTruthy();
  expect(rowOf("moved.psd").classList.contains("stale")).toBe(true);
});
```

`renderPanel`에 세 번째 인자 `staleProjectPaths: string[] = []`를 더하고 `FilePanel`에 같은 이름의 prop으로 넘긴다.

- [ ] **Step 2: 실패를 확인한다**

Run: `npm test -- --run src/components/FilePanel.test.tsx`
Expected: FAIL — `파일이 바뀜`을 못 찾음

- [ ] **Step 3: FilePanel에 배지를 더한다**

`FilePanelProps`에:

```ts
  /**
   * 프로젝트를 열 때 수정시각이 달라 작업을 버린 파일. 조용히 버리면 아티스트는
   * 자기가 한 지정이 왜 없는지 알 수 없다(설계 4절).
   */
  staleProjectPaths: string[];
```

행 렌더에서 `라인필요` 배지 바로 앞에:

```tsx
                  {stale && (
                    <span
                      className="status-badge status-stale"
                      title="프로젝트를 저장한 뒤 이 PSD가 바뀌었습니다. 저장돼 있던 작업은 쓰지 않았습니다."
                    >
                      파일이 바뀜
                    </span>
                  )}
```

`const stale = staleSet.has(file.path);`를 `needsLine` 옆에 두고, 행 클래스에 `${stale ? " stale" : ""}`를 더한다. `staleSet`은 `useMemo(() => new Set(staleProjectPaths), [staleProjectPaths])`.

`App.css`에 `.file-list-item.stale { background: #33231a; }`와 `.status-badge.status-stale { color: #e35d5d; border-color: #6a2f2f; }`를 `.needs-line` 규칙 뒤에 둔다.

- [ ] **Step 4: 통과를 확인한다**

Run: `npm test -- --run src/components/FilePanel.test.tsx`
Expected: PASS (4개)

- [ ] **Step 5: ProjectBar를 만든다**

`src/components/ProjectBar.tsx`:

```tsx
interface ProjectBarProps {
  /** 열려 있는 프로젝트 폴더 경로. 없으면 아직 저장한 적 없다. */
  projectDir: string | null;
  onOpen: () => void;
  onSave: () => void;
  onSaveAs: () => void;
}

function folderName(dir: string): string {
  const parts = dir.split(/[\\/]/);
  return parts[parts.length - 1] || dir;
}

/**
 * 프로젝트 열기·저장. 저장은 수동이고, 저장하지 않으면 앱은 프로젝트가 없던
 * 때와 똑같이 동작한다 — 아티스트가 그렇게 정했다(설계 6절).
 */
export function ProjectBar({ projectDir, onOpen, onSave, onSaveAs }: ProjectBarProps) {
  return (
    <div className="project-bar">
      <span className="project-bar-name" title={projectDir ?? undefined}>
        {projectDir ? folderName(projectDir) : "저장 안 된 작업"}
      </span>
      <button type="button" onClick={onOpen}>프로젝트 열기</button>
      <button type="button" onClick={onSave}>저장</button>
      <button type="button" onClick={onSaveAs}>다른 이름으로 저장</button>
    </div>
  );
}
```

- [ ] **Step 6: App에 배선한다**

`App.tsx`에 상태 셋을 더하고:

```ts
const [projectDir, setProjectDir] = useState<string | null>(null);
const [staleProjectPaths, setStaleProjectPaths] = useState<string[]>([]);
/** 프로젝트가 들고 있던 프리셋. Task 7에서 배치가 이것으로 시작한다. */
const [projectPreset, setProjectPreset] = useState<Preset | null>(null);
```


```ts
  /** 지금 화면 상태로 프로젝트 하나를 만든다. 저장이 그대로 쓴다. */
  const buildProject = useCallback((): { project: ProjectFile; previews: Map<string, string> } => {
    const previews = new Map<string, string>();
    const files: ProjectEntry[] = [];
    for (const file of filesRef.current) {
      const ops = opsByPathRef.current[file.path];
      if (!file.tree || file.mtime === undefined || !ops) continue;
      const plan = previewPlanFor(file);
      let previewFile: string | null = null;
      if (plan?.key) {
        const dataUrl = previewCacheRef.current.get(plan.key);
        if (dataUrl) {
          previewFile = previewFileName(plan.key);
          previews.set(previewFile, dataUrl);
        }
      }
      files.push({
        path: file.path, mtime: file.mtime, tree: file.tree,
        matchedIds: matchedIdsByPathRef.current[file.path] ?? [],
        ops, previewKey: plan?.key ?? null, previewFile,
      });
    }
    return { project: { version: 1, preset: presetRef.current ?? null, files }, previews };
  }, [previewPlanFor]);

  // import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
  // ExportDialog는 `save`, BatchPanel은 `open`을 이미 그렇게 쓴다.
  const handleProjectSaveAs = useCallback(async () => {
    // save는 파일 경로를 고르게 한다. 그 경로에 폴더를 만드는 것이 .bwproj다 —
    // saveProjectTo가 mkdir부터 한다.
    const dir = await saveDialog({ defaultPath: "작업.bwproj" });
    if (!dir) return;
    const { project, previews } = buildProject();
    try {
      await saveProjectTo(dir, project, previews);
      setProjectDir(dir);
    } catch (e) {
      pushError("프로젝트 저장 실패", toEngineError(e));
    }
  }, [buildProject, pushError]);

  const handleProjectSave = useCallback(async () => {
    if (!projectDir) return void handleProjectSaveAs();
    const { project, previews } = buildProject();
    try {
      await saveProjectTo(projectDir, project, previews);
    } catch (e) {
      pushError("프로젝트 저장 실패", toEngineError(e));
    }
  }, [projectDir, buildProject, handleProjectSaveAs, pushError]);

**프로젝트의 프리셋을 앱 선택으로 올린다 — 안 하면 이 기능이 헛돈다.**

`primeRestoredPreviews`가 `presetRef.current`에서 색과 경계선 설정을 읽는데, 앱을
껐다 켜면 `selectedPreset`은 `undefined`다. 그 상태로 키를 다시 계산하면
`lineColor=null, edgeLines=null`이 되어 저장된 키와 안 맞고 **복원한 미리보기가
전부 버려진다.** 틀린 그림이 뜨지는 않지만(설계대로 안전하게 실패한다), "껐다 켜고
다시 연다"는 이 기능의 주 경로에서 이득이 0이 된다. Task 5의 리뷰가 잡았다.

그래서 둘을 같이 한다:

1. `primeRestoredPreviews`가 `lineColor`와 `edgeLines`를 **인자로 받는다**
   (`presetRef.current`를 안에서 읽지 않는다). `restorablePreviews`는 이미 그렇게
   되어 있는데 App 쪽 콜백만 출처를 박아둔 상태다. 그 줄과 함께 Task 5가 남긴
   `void primeRestoredPreviews;`(App.tsx:496)도 지운다 — 이제 진짜로 불린다.
2. 프로젝트를 열면 **그 프로젝트의 프리셋을 앱의 선택으로 만든다.** 안 하면
   복원 직후의 그림은 맞지만 화면이 다시 그리는 순간 다른 프리셋으로 키가 달라져
   결국 전부 다시 그린다. "전부 그대로 뜬다"는 요구와도 그게 맞는다.

   `selectedPreset`은 `PresetBar`가 목록을 읽어 위로 알려주는 값이다. 프로젝트가
   고른 이름을 `PresetBar`에 초기 선택으로 내려보내는 prop 하나를 더한다 — 목록에
   그 이름이 없으면(프리셋을 지웠거나 이름을 바꾼 경우) 지금처럼 첫 번째를 고르고,
   그때는 미리보기가 버려지는 것이 맞다.

  const handleProjectOpen = useCallback(async () => {
    const dir = await openDialog({ directory: true });
    if (!dir || Array.isArray(dir)) return;
    try {
      const { project, previews } = await loadProjectFrom(dir);
      const mtimes = await psdMtimes(project.files.map((f) => f.path));
      const { fresh, stale } = reconcileProject(project, mtimes);
      dispatch({ type: "restoreProject", entries: fresh });
      primeRestoredPreviews(fresh, previews);
      setStaleProjectPaths(stale);
      setProjectPreset(project.preset);
      setProjectDir(dir);
    } catch (e) {
      pushError("프로젝트 열기 실패", toEngineError(e));
    }
  }, [dispatch, primeRestoredPreviews, pushError]);
```

`psdMtimes(paths)`는 `src/lib/engine.ts`에 더한다 — 엔진이 이미 파일을 여는 쪽이라 `stat`을 거기서 받는다:

```ts
/** 경로마다 디스크 수정시각. 없는 파일은 값이 빠진다. 프로젝트 복원의 판정용이다. */
export async function psdMtimes(paths: string[]): Promise<Record<string, number>> {
  return callEngine("psd_mtimes", { paths }) as Promise<Record<string, number>>;
}
```

엔진 `rpc.py`에:

```python
    def psd_mtimes(self, paths):
        # 초 단위로 자른다. 저장된 mtime은 open_psd가 준 float(소수점 이하가 있다)
        # 이므로 여기서만 자르면 양쪽이 절대 안 맞는다 — reconcileProject가 양쪽을
        # 다 자르므로(Task 3) 여기서 자르든 말든 결과는 같지만, 두 곳이 같은
        # 단위를 말하도록 맞춰 둔다.
        out = {}
        for p in paths:
            try:
                out[str(p)] = int(os.path.getmtime(p))
            except OSError:
                pass
        return out
```

**주의 — 정밀도가 갈리는 자리다.** `session.py:57`이 `os.path.getmtime`을 그대로
쓰고 `rpc.py:168`이 손대지 않고 넘기므로, 저장되는 `mtime`은
`1786347931.7873118` 같은 float다. 여기서 `int()`로 자른 값과 그대로 비교하면
**안 바뀐 파일이 전부 "바뀜"으로 판정된다.** 비교는 `reconcileProject` 한 곳에서
양쪽을 다 초 단위로 자르는 것으로 통일한다(Task 3).

`⌘S`는 `App.tsx`의 기존 키 핸들러 옆에 붙인다:

```ts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      void (e.shiftKey ? handleProjectSaveAs() : handleProjectSave());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleProjectSave, handleProjectSaveAs]);
```

- [ ] **Step 7: 엔진 테스트를 더한다**

`engine/tests/test_rpc.py`에:

```python
def test_psd_mtimes_reports_what_is_there_and_skips_what_is_not(fixture_psd, tmp_path):
    e = Engine()
    out = e.psd_mtimes([str(fixture_psd), str(tmp_path / "없는파일.psd")])
    assert str(fixture_psd) in out
    assert len(out) == 1
```

Run: `engine/.venv/bin/python -m pytest engine/tests/test_rpc.py -q`
Expected: PASS

- [ ] **Step 8: 전체 검증**

Run: `npx tsc --noEmit && npm test -- --run && engine/.venv/bin/python -m pytest engine/tests -q`
Expected: tsc clean, 기존 플레이크 외 실패 없음

- [ ] **Step 9: 커밋**

```bash
git add src/components/ProjectBar.tsx src/components/FilePanel.tsx src/components/FilePanel.test.tsx src/App.tsx src/App.css src/lib/engine.ts engine/psd_engine/rpc.py engine/tests/test_rpc.py
git commit -m "feat: open and save a project, and mark the files that changed"
```

---

## Task 7: 배치가 프로젝트의 프리셋을 따르게

**Files:**
- Modify: `src/App.tsx`, `src/components/BatchPanel.tsx`
- Test: `src/components/BatchPanel.test.tsx`

설계 7절의 마지막 항목이다. 배치 패널은 자기 목록의 **첫 번째**를 기본으로 고르는데(`BatchPanel.tsx:100`), 프로젝트가 프리셋을 복원해도 배치는 그것을 모른다. 2026-08-10에 이것 때문에 생성된 라인이 빠진 산출물이 나왔다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
test("the batch starts on the project's preset, not the first in the list", async () => {
  const projectPreset = { ...PRESET, name: "CHAR" };
  vi.mocked(loadPresets).mockResolvedValueOnce([PRESET, projectPreset]);

  render(
    <BatchPanel
      files={FILES}
      manualLineIdsByPath={{}}
      projectPresetName="CHAR"
      onError={vi.fn()}
      onRunningChange={() => {}}
    />
  );
  await waitFor(() => expect(screen.getByRole("button", { name: "배치 실행" })).toBeTruthy());

  expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("CHAR");
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npm test -- --run src/components/BatchPanel.test.tsx -t "project's preset"`
Expected: FAIL — 값이 `line 추출`

- [ ] **Step 3: 구현한다**

`BatchPanelProps`에 `projectPresetName: string | null;`을 더하고, `:100`의 기본 선택을 바꾼다:

```ts
        // 프로젝트가 프리셋을 들고 있으면 그것으로 시작한다. 목록의 첫 번째로
        // 시작하면 화면 위쪽 선택과 배치가 갈리고, 그 어긋남이 조용히 다른
        // 산출물을 만든다 — 2026-08-10에 생성된 라인이 빠진 채로 나갔다.
        const wanted = projectPresetName && loaded.some((p) => p.name === projectPresetName)
          ? projectPresetName
          : loaded[0]?.name ?? null;
        setSelectedPresetName(wanted);
```

`App.tsx`에서 `projectPresetName={projectPreset?.name ?? null}`을 넘긴다(`projectPreset`은 Task 6의 `handleProjectOpen`이 세운다).

- [ ] **Step 4: 통과를 확인한다**

Run: `npm test -- --run src/components/BatchPanel.test.tsx`
Expected: PASS (11개)

- [ ] **Step 5: 전체 검증과 커밋**

```bash
npx tsc --noEmit && npm test -- --run
git add src/components/BatchPanel.tsx src/components/BatchPanel.test.tsx src/App.tsx
git commit -m "feat: start the batch on the project's preset"
```

---

## 마지막 확인 — 앱에서 직접

단위 테스트가 못 재는 것들이다. **엔진(`rpc.py`)을 고쳤으므로 앱 재시작이 필요하다** — 프런트와 달리 HMR로 안 들어간다. 재시작 전에 `ps -eo pid,lstart,args | grep psd_engine`으로 이미 새 코드인지 먼저 볼 것.

1. 파일 여러 장을 열고 손으로 라인을 지정한 뒤 **다른 이름으로 저장** → 폴더에 `project.json`과 `previews/`가 생기는지
2. 앱을 껐다 켜고 **프로젝트 열기** → 목록·레이어 트리·체크·지정·미리보기가 **엔진 호출 없이** 뜨는지
3. 포토샵에서 한 장을 저장한 뒤 다시 열기 → 그 파일만 `파일이 바뀜`으로 뜨고 나머지는 멀쩡한지
4. 배치 패널의 프리셋이 프로젝트의 것으로 잡혀 있는지
5. 프로젝트를 안 쓰고 평소처럼 작업 → 지금과 똑같이 동작하는지
