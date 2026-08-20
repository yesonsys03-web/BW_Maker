import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from "react";
import { EngineRpcError, applyPreset, closeSession, measureLeafStrokes, openPsd, type SkippedLayer, type StrokeFeatures } from "../lib/engine";
import { STROKE_CHUNK, drawnLineCandidateIds, judgeDrawnLines } from "../lib/detectDrawnLines";
import { buildEntries, opsReducer, type OpsState } from "../lib/opsReducer";
import type { ProjectEntry } from "../lib/project";
import { withEvictedSessionRetry } from "../lib/sessionRetry";
import type { EngineError, OpenResult, Operation, Preset, TreeNode } from "../lib/types";

export type FileStatus = "idle" | "open" | "processing" | "done" | "error";

export interface FileEntry {
  path: string;
  status: FileStatus;
  sessionId?: number;
  tree?: TreeNode[];
  width?: number;
  height?: number;
  /**
   * 지금 열려 있는 이 세션에 프리셋 적용이 이미 걸렸는지. 파일을 열면 선택된
   * 프리셋이 자동으로 적용되는데(App.tsx), 그것이 세션당 한 번만 걸리게 하는
   * 래치다. 적용을 시작하는 시점에 세우므로 적용이 실패해도 무한 재시도로
   * 번지지 않는다 — 실패는 ErrorPanel에 남고, 재시도는 사람이 "적용"으로 한다.
   *
   * `openSuccess`는 false로 되돌린다(새로 연 파일이니 다시 걸어야 한다).
   * `sessionRefreshed`는 건드리지 않는다: 축출 후 재오픈은 같은 파일의 편집을
   * 그대로 이어가는 것이므로, 자동 적용이 그 위를 덮으면 안 된다.
   */
  /**
   * 파일이 마지막으로 바뀐 시각(엔진이 열면서 읽어온 값). 만들어둔 미리보기를
   * 재사용해도 되는지의 기준이다 — lib/previewCache 참고.
   */
  mtime?: number;
  presetApplied?: boolean;
  /**
   * 사람이 이 파일을 직접 손댔는지 — 병합/이름변경(pushOp), 포함 체크 변경
   * (setIncluded), 되돌리기(undoOp). "적용"이 띄우는 "기존 편집 내용을
   * 대체합니다" 확인창의 근거다.
   *
   * ops가 비어 있는지로 판단하지 않는 이유: 프리셋 적용은 그 자체로 ops를
   * 만들기 때문에, 자동 적용이 들어간 뒤로는 파일을 열기만 해도 ops가 차 있다.
   * 그걸 근거로 삼으면 아무것도 손대지 않은 파일에서 프리셋만 바꿔 눌러도
   * "편집 내용이 사라진다"는 경고가 뜬다 — 지울 편집이 없는데도.
   */
  edited?: boolean;
}

export interface ErrorEntry {
  title: string;
  error: EngineError;
  /**
   * 본문에 이름이 적힌 파일들의 경로, 적힌 순서 그대로. 카드에서 눌러 그 파일로
   * 갈 수 있게 하려는 것이다 — 폴더 하나가 스물넷이면 이름을 읽고 목록에서 다시
   * 찾는 일이 카드를 읽는 것보다 오래 걸린다.
   */
  files?: string[];
}

export interface AppState {
  files: FileEntry[];
  activePath: string | null;
  opsByPath: Record<string, OpsState>;
  /**
   * 프리셋 규칙에 걸린 레이어 id — 파일별로 나눠 담는다. "라인만" 필터가 이걸
   * 읽는다.
   *
   * 전역 배열 하나로는 안 된다. 레이어 id는 세션(=파일) 안에서만 유일한데,
   * 로드 큐가 배경에서 파일마다 프리셋을 붙이므로 전역 필드에는 마지막으로
   * 처리된 파일의 id가 남는다. 그 숫자들은 지금 보고 있는 파일에서 전혀 다른
   * 레이어를 가리키고, "라인만"에 mask·fill·grain 같은 것이 섞여 나온다.
   * opsByPath와 같은 모양으로 두는 이유가 이것이다.
   *
   * 값이 `| undefined`인 것은 실수가 아니다. **"키가 없다"와 "빈 배열"은 다른
   * 사실이고**, 그 차이가 내보내기를 뒤집는다: 키가 없으면 엔진은 목록이 없는
   * 것으로 읽어 색 통일을 포함된 레이어 **전부**에 걸고(render.py의 `ids is
   * None`), []이면 반대로 **아무 데도** 안 건다. 이 저장소는
   * noUncheckedIndexedAccess를 켜지 않아 `Record<string, number[]>`이면 조회
   * 결과가 항상 있는 것처럼 보이고, "없으면 []로 두면 되겠네" 하는 편집이
   * 타입에서 하나도 안 걸린다.
   */
  matchedIdsByPath: Record<string, number[] | undefined>;
  /**
   * 픽셀 굵기 검출("선으로 그려진 레이어", lib/detectDrawnLines)이 파일별로
   * 지정한 잎 id. 트리·파일 목록의 "라인인지 확인 필요" 배지와, "이 파일은
   * 검출을 이미 마쳤다" 래치의 근거다 — **빈 배열도 사실이다**("검출했는데
   * 없었다"). 키가 없어야 App의 감시 효과가 검출을 돈다.
   *
   * 지정 자체는 opsByPath에 있다(수동 지정과 같은 경로). 이 맵은 파생 표시라
   * 프로젝트에 저장하지 않고, 복원한 파일은 검출 자체를 건너뛴다 — 저장된
   * 손 작업 위에 자동 지정을 다시 걸면, 아티스트가 일부러 해제한 잎이
   * 소리 없이 되살아난다.
   */
  drawnLineIdsByPath: Record<string, number[] | undefined>;
  /**
   * 스윕이 재둔 파일별 잎 굵기 특징(잎 id 문자열 → 특징|null). 프리셋과 무관한
   * 그림의 성질이라 프리셋을 바꿔도 그대로 두고 판단만 다시 한다. 파일을 새로
   * 열면(mtime이 달라졌을 수 있음) 버린다 — 스윕·클릭 경로가 다시 채운다.
   */
  strokeFeaturesByPath: Record<string, Record<string, StrokeFeatures | null> | undefined>;
  errors: ErrorEntry[];
  /**
   * 프로젝트에서 복원한 파일의 수정시각. openSuccess가 이걸 보고 복원한 작업을
   * 지킬지 정한다 — 아래 openSuccess 주석 참고.
   */
  restoredMtimeByPath: Record<string, number>;
}

/**
 * 작업 프로세스가 준비한 파일 하나(엔진 warmworker.prepare_file의 result).
 * open_psd 응답에서 **sessionId만 빠진 것** + apply_preset 응답 + 미리보기 경로다
 * — 세션은 메인 엔진 SessionStore의 것이라 워커가 만들 수 없다.
 */
export interface PreparedFileResult {
  /** 워커가 디스크 사이드카에서 읽어 온 잎 굵기 특징(스윕한 폴더의 재로드).
   * null이면 사이드카 없음 — 검출은 스윕이나 클릭 경로가 다시 채운다. */
  strokeFeatures?: Record<string, StrokeFeatures | null> | null;
  tree: TreeNode[];
  mtime: number;
  width: number;
  height: number;
  colorMode: string;
  depth: number;
  matchedLayerIds: number[];
  skippedLayers: SkippedLayer[];
  /**
   * 프리셋이 만든 자동 병합. 지금은 쓰지 않는다 — applyPresetResult가 손 병합
   * (current.ops)만 남기고 이 값을 버리는 것과 같은 판단이고, 갓 준비한 파일에는
   * 손 병합도 없다. 프로토콜에 실려 오므로 타입에는 남긴다.
   */
  operations: Operation[];
  /** 워커가 구운 "갓 적용한 화면"의 PNG. 구울 것이 없었으면 null. */
  pngPath: string | null;
  /** 매칭이 파일을 연 직후 보이는 전부와 같아, 화면이 저장된 병합 이미지로 가는 경우. */
  documentView: boolean;
}

export type AppAction =
  | { type: "addFiles"; paths: string[] }
  | { type: "openStart"; path: string; activate: boolean }
  | { type: "openSuccess"; path: string; result: OpenResult }
  | { type: "openError"; path: string; error: EngineError; quiet?: boolean }
  | { type: "preparedFile"; path: string; result: PreparedFileResult }
  | { type: "selectFile"; path: string }
  | { type: "togglePreview"; path: string; layerId: number }
  | { type: "setPreviewHidden"; path: string; layerIds: number[]; hidden: boolean }
  | { type: "toggleSolo"; path: string; layerId: number }
  | { type: "setSolo"; path: string; layerIds: number[]; solo: boolean }
  | { type: "setEdgeColour"; path: string; layerIds: number[]; on: boolean }
  | { type: "setManualLine"; path: string; layerIds: number[]; on: boolean }
  | { type: "drawnLinesDetected"; path: string; layerIds: number[] }
  | { type: "strokeFeaturesLoaded"; path: string; features: Record<string, StrokeFeatures | null> }
  | { type: "pushOp"; path: string; op: Operation }
  | { type: "setIncluded"; path: string; includedIds: number[] }
  | { type: "applyPresetResult"; path: string; matchedLayerIds: number[]; operations: Operation[] }
  | { type: "presetApplyStarted"; path: string }
  | { type: "undoOp"; path: string }
  | { type: "dismissError"; index: number }
  | { type: "pushError"; title: string; error: EngineError; files?: string[] }
  | { type: "removeFile"; path: string }
  | { type: "clearFiles" }
  | { type: "sessionRefreshed"; path: string; result: OpenResult }
  | { type: "engineRestarted" }
  | { type: "restoreProject"; entries: ProjectEntry[] };

export const EMPTY_OPS: OpsState = {
  includedIds: [],
  previewHiddenIds: [],
  soloIds: [],
  edgeColourIds: [],
  manualLineIds: [],
  ops: [],
  entries: [],
};

export const initialAppState: AppState = {
  files: [],
  activePath: null,
  opsByPath: {},
  matchedIdsByPath: {},
  drawnLineIdsByPath: {},
  strokeFeaturesByPath: {},
  errors: [],
  restoredMtimeByPath: {},
};

function isGroup(node: TreeNode): boolean {
  return node.kind === "group";
}

function collectLeaves(nodes: TreeNode[], out: TreeNode[] = []): TreeNode[] {
  for (const node of nodes) {
    if (isGroup(node)) {
      collectLeaves(node.children ?? [], out);
    } else {
      out.push(node);
    }
  }
  return out;
}

/**
 * Initial OpsState for a freshly-opened tree, per the Task 5 contract:
 * includedIds = every pixel leaf id ascending; previewHiddenIds = leaves that
 * were visible=false in the original tree; soloIds = empty — a freshly
 * opened file starts with nothing soloed. edgeColourIds is empty for the same
 * reason: which layers are colour art is a fact about *this* file's tree, not
 * something a previously open file's designation should leak into (task-8b).
 */
export function buildInitialOpsState(tree: TreeNode[]): OpsState {
  const leaves = collectLeaves(tree);
  const includedIds = leaves
    .filter((n) => n.kind === "pixel")
    .map((n) => n.id)
    .sort((a, b) => a - b);
  const previewHiddenIds = leaves.filter((n) => !n.visible).map((n) => n.id);
  return {
    includedIds, previewHiddenIds, soloIds: [], edgeColourIds: [],
    manualLineIds: [], ops: [], entries: buildEntries(includedIds, []),
  };
}

/** 맵에서 키 하나를 뺀 사본. 파일 단위 기록을 그 파일만 버릴 때 쓴다. */
function dropKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  const next = { ...map };
  delete next[key];
  return next;
}

function updateFile(files: FileEntry[], path: string, patch: Partial<FileEntry>): FileEntry[] {
  return files.map((f) => (f.path === path ? { ...f, ...patch } : f));
}

function errorFrom(e: unknown): EngineError {
  if (e instanceof Error) {
    return { message: e.message, traceback: e.stack ?? e.message };
  }
  return { message: String(e), traceback: String(e) };
}

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "addFiles": {
      const existing = new Set(state.files.map((f) => f.path));
      const additions: FileEntry[] = [];
      for (const path of action.paths) {
        if (existing.has(path)) continue;
        existing.add(path);
        additions.push({ path, status: "idle" });
      }
      if (additions.length === 0) return state;
      return { ...state, files: [...state.files, ...additions] };
    }

    case "openStart":
      return {
        ...state,
        // 목록에 추가되자마자 배경에서 미리 여는 중이라면(App.tsx의 로드 큐)
        // 보고 있던 파일을 뺏지 않는다. 클릭으로 여는 경우만 화면을 옮긴다.
        activePath: action.activate ? action.path : state.activePath,
        files: updateFile(state.files, action.path, { status: "processing" }),
      };

    case "openSuccess": {
      const { path, result } = action;
      // 복원한 파일인지, 그리고 그 사이 디스크에서 바뀌지 않았는지. `path in`으로
      // 실제로 복원된 항목인지부터 확인하는 것이 중요하다 — 복원한 적 없는 파일은
      // restoredMtimeByPath[path]도 result.mtime도 둘 다 undefined일 수 있고,
      // 그 둘을 그냥 ===로 비교하면 "둘 다 없음"을 "수정시각이 같음"으로 오판해
      // 평범하게 다시 연 파일의 옛 작업까지 지켜버린다.
      const isRestoredMatch =
        path in state.restoredMtimeByPath && state.restoredMtimeByPath[path] === result.mtime;
      // 새 세션이라 이 파일의 옛 매칭 결과는 버린다. **이 파일 것만** 버리는
      // 것이 요점이다 — 배경에서 파일을 여는 동안 보고 있는 파일의 "라인만"
      // 목록까지 비워지면 안 된다.
      //
      // 단, 프로젝트에서 복원한 매칭 결과는 예외다 — 수정시각이 그대로라면
      // 그대로 붙든다. 지우면 캐시 키가 달라져 복원해둔 미리보기를 전부
      // 다시 그린다(설계 7절).
      const matchedIdsByPath = { ...state.matchedIdsByPath };
      if (!isRestoredMatch) delete matchedIdsByPath[path];
      // 검출 기록은 무조건 버린다 — 배지는 저장 안 되는 파생 정보라 지킬 것이
      // 없고, 남기면 감시 효과가 "이미 검출했다"로 읽어 다시 재지 않는다.
      // (복원 파일은 감시 효과 쪽 가드가 검출을 건너뛴다.)
      const drawnLineIdsByPath = dropKey(state.drawnLineIdsByPath, path);
      return {
        ...state,
        matchedIdsByPath,
        drawnLineIdsByPath,
        // 특징도 함께 버린다 — 새로 연 파일은 mtime이 달라졌을 수 있다(포토샵
        // 재저장). 스윕·클릭 경로가 다시 채운다.
        strokeFeaturesByPath: dropKey(state.strokeFeaturesByPath, path),
        files: updateFile(state.files, path, {
          status: "open",
          sessionId: result.sessionId,
          tree: result.tree,
          width: result.width,
          height: result.height,
          mtime: result.mtime,
          // 새로 연 파일이므로 자동 적용을 다시 걸어야 하고, 이전 세션에서의
          // 편집 표시도 함께 사라진다(ops 자체가 아래에서 초기화된다).
          //
          // 단, 복원본을 그대로 붙드는 경우는 다르다 — 그 ops는 이전 세션에서
          // 이미 프리셋 적용을 거친 뒤 아티스트가 손으로 편집한 결과다. 여기서
          // false로 두면 로드 큐가 자동 적용을 다시 걸어 방금 지킨 opsByPath를
          // applyPresetResult로 덮어써, 체크박스·병합 편집이 조용히 사라진다
          // (App.tsx의 로드 큐 주석 참고).
          presetApplied: isRestoredMatch,
          // edited도 같은 분기를 따라야 한다. 복원한 ops는 아티스트가 이전
          // 세션에서 **손으로** 한 편집이다(병합·이름변경·순서변경, 그리고 포함
          // 체크박스) — 그것을 "지킬 편집 없음"이라고 말하면 두 확인창이 함께
          // 무력해진다: "적용"은 PresetBar의 "포함 목록을 프리셋 결과로
          // 대체합니다"를 건너뛰고 체크박스 선택을 매칭 결과로 갈아치우고,
          // "비우기"도 FilePanel의 확인창 없이 지나간다.
          //
          // 이 줄은 이 기능 이전에는 맞는 말이었다 — 그때 openSuccess의 ops는
          // 아래에서 트리로 갓 만든 것이라 지킬 편집이 애초에 없었다.
          edited: isRestoredMatch,
        }),
        // 복원한 작업은 지킨다. 이 자리가 이 기능에서 제일 조용히 망가지는
        // 곳이다 — 프로젝트를 열어 손으로 한 지정을 되살려 놓아도, 배경 큐가
        // 그 파일을 여는 순간 여기서 초기 상태로 덮여 전부 사라진다.
        //
        // 지키는 조건은 **수정시각이 그대로일 때뿐**이다. 저장된 것은 전부
        // 레이어 id이고 PSD가 바뀌면 id가 밀리므로, 그때 붙들면 "라인 지정"이
        // 엉뚱한 레이어를 가리킨다(설계 4절).
        opsByPath: {
          ...state.opsByPath,
          [path]: isRestoredMatch && state.opsByPath[path]
            ? state.opsByPath[path]
            : buildInitialOpsState(result.tree),
        },
      };
    }

    // 작업 프로세스가 준비한 파일 하나(App.tsx의 파일 준비 큐).
    //
    // openSuccess를 재사용하지 않는 이유가 둘 있다. openSuccess는
    // result.sessionId를 세우는데 준비 결과에는 그것이 없고, 복원 판정
    // (restoredMtimeByPath)도 함께 얹혀 있다 — 별도 액션이 그 둘을 섞지 않는다.
    case "preparedFile": {
      const { path, result } = action;
      // 목록에서 빠진 파일의 결과는 버린다. 워커가 파일을 쥐고 있는 동안 X로 뺄
      // 수 있는데, 그때 되살리면 removeFile이 지운 ops/매칭이 목록에 없는 경로로
      // 되살아난다.
      if (!state.files.some((f) => f.path === path)) return state;
      // 갓 적용 상태의 포함 목록 = 매칭 결과, 숫자 오름차순. applyPresetResult와
      // 같은 값이어야 한다 — 미리보기 캐시 키가 이 목록으로 만들어지므로, 두
      // 경로가 갈리면 워커가 구운 그림을 화면이 영영 못 찾는다.
      const includedIds = [...result.matchedLayerIds].sort((a, b) => a - b);
      // 나머지 칸은 **트리에서** 만든다. EMPTY_OPS로 두면 previewHiddenIds가 []가
      // 되어, 포토샵에서 아티스트가 눈을 꺼둔 레이어를 준비된 파일만 그린다 —
      // 같은 판이 워커가 준비했느냐 메인 엔진이 열었느냐에 따라 다른 그림이 된다.
      // 그리고 스스로 고쳐지지 않는다: sessionRefreshed는 opsByPath를 일부러
      // 안 건드리므로, 나중에 세션이 붙어도 이 ops가 그대로 남는다.
      //
      // buildInitialOpsState + includedIds 교체는 정상 경로(openSuccess 다음
      // applyPresetResult)가 만드는 것과 **같은 OpsState**다: 눈은 트리의
      // visible 플래그, 솔로·지정·손 병합은 비어 있고, entries는 새 포함
      // 목록으로 다시 만든 것.
      const initial = buildInitialOpsState(result.tree);
      return {
        ...state,
        // 아직 아무것도 안 보고 있으면 이 파일을 띄운다. 워커 모드에서는 로드 큐가
        // 통째로 비켜서 있으므로, 여기서 안 세우면 폴더를 열어도 화면이 "왼쪽에서
        // 파일을 선택하세요"에 머문다.
        //
        // 로드 큐와 **같은 규칙은 아니다.** 그쪽은 목록의 첫 파일을 띄우지만
        // (openFileEffect의 activate), 워커는 여럿이 동시에 돌고 파일마다 걸리는
        // 시간이 크게 달라서(실측 중앙 5초 대 최대 259초) 여기 먼저 닿는 것은
        // **가장 먼저 끝난 파일**이다 — 목록 순서와 다를 수 있다. 그래도 되는
        // 값이라 그대로 둔다: 아무것도 안 뜬 화면보다 낫고, 아티스트가 목록에서
        // 다른 파일을 누르면 그 자리에서 바뀐다.
        activePath: state.activePath ?? path,
        // 세션 없이 "열림". 프로젝트 복원(restoreProject)이 만드는 것과 같은
        // 모양이고, 세션은 화면이 그 파일을 실제로 쓸 때 채워진다.
        files: updateFile(state.files, path, {
          status: "open",
          tree: result.tree,
          mtime: result.mtime,
          width: result.width,
          height: result.height,
          // 워커가 프리셋 매칭까지 마쳤다. 래치를 안 세우면 자동 적용 그물
          // (App.tsx)이 그 위에 같은 프리셋을 한 번 더 건다.
          presetApplied: true,
        }),
        matchedIdsByPath: { ...state.matchedIdsByPath, [path]: result.matchedLayerIds },
        drawnLineIdsByPath: dropKey(state.drawnLineIdsByPath, path),
        // 워커가 사이드카에서 읽어 온 특징 — 있으면 무세션 판단 그물이 지정을
        // 복원해, 준비가 구운 미리보기(검출 포함 화면)와 키가 맞는다.
        strokeFeaturesByPath: result.strokeFeatures
          ? { ...state.strokeFeaturesByPath, [path]: result.strokeFeatures }
          : dropKey(state.strokeFeaturesByPath, path),
        opsByPath: {
          ...state.opsByPath,
          [path]: { ...initial, includedIds, entries: buildEntries(includedIds, initial.ops) },
        },
      };
    }

    case "openError":
      return {
        ...state,
        files: updateFile(state.files, action.path, { status: "error" }),
        // quiet면 카드를 내지 않는다. 폴더를 한꺼번에 불러올 때 파일마다 카드가
        // 뜨면 패널이 덮이므로, 로드 큐가 모아 끝에 한 장으로 낸다.
        errors: action.quiet
          ? state.errors
          : [...state.errors, { title: `파일 열기 실패: ${action.path}`, error: action.error }],
      };

    case "selectFile":
      return { ...state, activePath: action.path };

    case "togglePreview": {
      const current = state.opsByPath[action.path];
      if (!current) return state;
      const next = opsReducer(current, { type: "togglePreview", layerId: action.layerId });
      return { ...state, opsByPath: { ...state.opsByPath, [action.path]: next } };
    }

    case "setPreviewHidden": {
      const current = state.opsByPath[action.path];
      if (!current) return state;
      const targetIds = new Set(action.layerIds);
      const previewHiddenIds = action.hidden
        ? Array.from(new Set([...current.previewHiddenIds, ...action.layerIds]))
        : current.previewHiddenIds.filter((id) => !targetIds.has(id));
      return {
        ...state,
        opsByPath: { ...state.opsByPath, [action.path]: { ...current, previewHiddenIds } },
      };
    }

    case "toggleSolo": {
      const current = state.opsByPath[action.path];
      if (!current) return state;
      const next = opsReducer(current, { type: "toggleSolo", layerId: action.layerId });
      return { ...state, opsByPath: { ...state.opsByPath, [action.path]: next } };
    }

    case "setSolo": {
      const current = state.opsByPath[action.path];
      if (!current) return state;
      const next = opsReducer(current, {
        type: "setSolo", layerIds: action.layerIds, solo: action.solo,
      });
      return { ...state, opsByPath: { ...state.opsByPath, [action.path]: next } };
    }

    // 색 경계선 생성의 수동 지정(task-8b). setSolo와 같은 모양이다 — 체크박스
    // (includedIds)와 완전히 분리된 별도 집합이라 setIncluded와는 무관하다.
    case "setEdgeColour": {
      const current = state.opsByPath[action.path];
      if (!current) return state;
      const next = opsReducer(current, {
        type: "setEdgeColour", layerIds: action.layerIds, on: action.on,
      });
      return { ...state, opsByPath: { ...state.opsByPath, [action.path]: next } };
    }

    // 손으로 "라인이다"라고 지정. setEdgeColour와 같은 모양이되, 리듀서 쪽에서
    // includedIds까지 같이 켜는 것이 다르다(opsReducer의 setManualLine 주석).
    case "setManualLine": {
      const current = state.opsByPath[action.path];
      if (!current) return state;
      const next = opsReducer(current, {
        type: "setManualLine", layerIds: action.layerIds, on: action.on,
      });
      return { ...state, opsByPath: { ...state.opsByPath, [action.path]: next } };
    }

    // 픽셀 굵기 검출이 "선으로 그려진" 잎을 라인으로 지정한다. 지정 자체는
    // 수동 지정(setManualLine)과 같은 경로라 내보내기·저장·해제가 전부 검증된
    // 길을 탄다. 빈 배열도 기록한다 — "검출했는데 없었다"와 "아직 안 했다"가
    // 같아지면 감시 효과가 같은 파일을 영영 다시 잰다.
    case "strokeFeaturesLoaded":
      return {
        ...state,
        strokeFeaturesByPath: { ...state.strokeFeaturesByPath, [action.path]: action.features },
      };

    case "drawnLinesDetected": {
      const current = state.opsByPath[action.path];
      if (!current) return state;
      const next = action.layerIds.length === 0
        ? current
        : opsReducer(current, { type: "setManualLine", layerIds: action.layerIds, on: true });
      return {
        ...state,
        opsByPath: { ...state.opsByPath, [action.path]: next },
        drawnLineIdsByPath: { ...state.drawnLineIdsByPath, [action.path]: action.layerIds },
      };
    }

    case "pushOp": {
      const current = state.opsByPath[action.path];
      if (!current) return state;
      try {
        const next = opsReducer(current, { type: "pushOp", op: action.op });
        return {
          ...state,
          files: updateFile(state.files, action.path, { edited: true }),
          opsByPath: { ...state.opsByPath, [action.path]: next },
        };
      } catch (e) {
        return {
          ...state,
          errors: [...state.errors, { title: "레이어 편집 실패", error: errorFrom(e) }],
        };
      }
    }

    case "setIncluded": {
      const current = state.opsByPath[action.path];
      if (!current) return state;
      try {
        const next = opsReducer(current, { type: "setIncluded", includedIds: action.includedIds });
        return {
          ...state,
          files: updateFile(state.files, action.path, { edited: true }),
          opsByPath: { ...state.opsByPath, [action.path]: next },
        };
      } catch (e) {
        // 원래는 여기서 "이 레이어를 참조하는 편집이 있으니 먼저 되돌리라"는
        // 안내로 실제 메시지를 덮어썼다. 그 상황(병합에 쓰인 레이어의 체크 해제)
        // 자체가 이제 정상 동작이므로 — buildEntries가 남은 것들로 재생한다 —
        // 여기까지 오는 건 짐작할 게 아니라 진짜 결함이다. 메시지를 그대로 보인다.
        return {
          ...state,
          errors: [...state.errors, { title: "포함 상태 변경 실패", error: errorFrom(e) }],
        };
      }
    }

    case "applyPresetResult": {
      const current = state.opsByPath[action.path];
      if (!current) return state;
      try {
        const includedIds = [...action.matchedLayerIds].sort((a, b) => a - b);
        // **손으로 한 병합·이름변경은 프리셋을 걸어도 지킨다**(아티스트가 정했다,
        // 2026-08-11). 예전에는 `action.operations`가 ops를 통째로 갈아치웠는데,
        // 실제로 쓰는 프리셋은 전부 merge:"none"이라 preset_operations가 빈 배열을
        // 준다(engine/psd_engine/matching.py의 mode == "none"). 즉 갈아치우기는
        // 없애기만 하고 대신 넣어주는 것이 없었다 — 하루치 병합이 확인창 한 번에
        // 사라지는 값이었다.
        //
        // entries는 (includedIds, ops)의 함수이므로 **새 포함 목록으로 다시 만든다.**
        // 이제 매칭에서 빠진 레이어를 참조하던 병합은 buildEntries가 남은 것들로
        // 재생한다(setIncluded 주석과 같은 규칙이다).
        //
        // 대가를 적어 둔다: merge가 "none"이 아닌 프리셋을 쓰면 그 자동 병합이
        // 화면에는 안 걸린다. 배치는 엔진에서 따로 계산하므로(batch.py:63) 그때는
        // 화면과 배치 산출물이 갈린다. 지금 쓰는 프리셋에는 해당이 없다.
        const entries = buildEntries(includedIds, current.ops);
        const next: OpsState = {
          includedIds,
          previewHiddenIds: current.previewHiddenIds,
          soloIds: current.soloIds,
          // 지정은 이 프리셋과 무관한 "이 파일의 사실"이다(어떤 레이어가 색
          // 원본인지는 어느 프리셋을 걸든 바뀌지 않는다) — previewHiddenIds/
          // soloIds와 같은 이유로 그대로 넘긴다.
          edgeColourIds: current.edgeColourIds,
          // 손으로 "라인이다"라고 지정한 것도 같은 성격이다 — 프리셋을 바꿔도
          // 그 판에서 그 레이어가 선화라는 사실은 변하지 않는다.
          manualLineIds: current.manualLineIds,
          ops: current.ops,
          entries,
        };
        return {
          ...state,
          // 활성 파일이 아니라 **적용한 파일**의 칸에 넣는다. 로드 큐는 배경에서
          // 파일마다 프리셋을 붙이는데, 전역 칸 하나에 덮어쓰면 화면이 보고 있는
          // 파일의 목록이 남의 id로 바뀐다(AppState.matchedIdsByPath 주석 참고).
          matchedIdsByPath: { ...state.matchedIdsByPath, [action.path]: action.matchedLayerIds },
          // 프리셋이 다시 걸렸으니 검출도 다시 — 감시 효과가 키 없음을 보고 돈다.
          drawnLineIdsByPath: dropKey(state.drawnLineIdsByPath, action.path),
          // presetApplied: 사람이 "적용"을 먼저 눌렀다면 자동 적용이 그 위에 또
          // 걸릴 이유가 없다.
          //
          // **edited는 건드리지 않는다.** 예전에는 여기서 false로 내렸고 그때는
          // 그것이 참이었다 — ops가 통째로 프리셋의 산물로 바뀌었으니 지킬 편집이
          // 남아 있지 않았다. 이제 손 병합이 그대로 살아남으므로 false로 내리면
          // 거짓이 되고, 다음 "적용"에서 확인창이 안 떠 체크박스 편집이 조용히
          // 대체된다(같은 종류의 결함을 이 기능에서 이미 한 번 겪었다).
          files: updateFile(state.files, action.path, { presetApplied: true }),
          opsByPath: { ...state.opsByPath, [action.path]: next },
        };
      } catch (e) {
        return {
          ...state,
          errors: [...state.errors, { title: "프리셋 적용 실패", error: errorFrom(e) }],
        };
      }
    }

    // 자동 적용이 시작됐다는 표시. 결과가 돌아오기 전에 세우는 것이 요점이다 —
    // 실패해도 래치가 남아 같은 세션에 자동 적용이 다시 걸리지 않는다.
    case "presetApplyStarted":
      return { ...state, files: updateFile(state.files, action.path, { presetApplied: true }) };

    case "undoOp": {
      const current = state.opsByPath[action.path];
      if (!current || current.ops.length === 0) return state;
      try {
        const next = opsReducer(current, { type: "undo" });
        // 되돌리기도 사람의 편집이다. 프리셋이 만든 병합을 하나 되돌린 상태를
        // 다시 적용으로 덮으려 할 때 확인을 받아야 한다.
        return {
          ...state,
          files: updateFile(state.files, action.path, { edited: true }),
          opsByPath: { ...state.opsByPath, [action.path]: next },
        };
      } catch (e) {
        return {
          ...state,
          errors: [...state.errors, { title: "실행 취소 실패", error: errorFrom(e) }],
        };
      }
    }

    case "dismissError":
      return { ...state, errors: state.errors.filter((_, i) => i !== action.index) };

    case "pushError":
      return {
        ...state,
        errors: [...state.errors, { title: action.title, error: action.error, files: action.files }],
      };

    case "clearFiles":
      // 목록에 딸린 것은 전부 함께 비운다. 오류 카드까지 비우는 것이 요점이다 —
      // 그 카드들은 방금 치운 폴더에 대한 이야기이고, 카드의 파일 버튼이 이제
      // 없는 파일을 가리키면 눌러도 아무 데도 못 간다.
      return { ...initialAppState };

    case "removeFile": {
      const wasActive = state.activePath === action.path;
      const opsByPath = { ...state.opsByPath };
      delete opsByPath[action.path];
      // 목록에서 뺀 파일의 매칭 결과도 함께 버린다. 남겨두면 같은 경로를 나중에
      // 다시 추가했을 때 옛 세션의 id가 되살아난다.
      const matchedIdsByPath = { ...state.matchedIdsByPath };
      delete matchedIdsByPath[action.path];
      // 복원 mtime도 같은 이유로 지운다. 남겨두면 같은 경로를 다시 추가해 새
      // 세션을 열었을 때, 그 mtime이 우연히 옛 기록과 같아 openSuccess가 이번
      // 세션과 무관한 옛 작업/매칭을 그대로 붙들 수 있다.
      const restoredMtimeByPath = { ...state.restoredMtimeByPath };
      delete restoredMtimeByPath[action.path];
      return {
        ...state,
        files: state.files.filter((f) => f.path !== action.path),
        opsByPath,
        matchedIdsByPath,
        drawnLineIdsByPath: dropKey(state.drawnLineIdsByPath, action.path),
        strokeFeaturesByPath: dropKey(state.strokeFeaturesByPath, action.path),
        restoredMtimeByPath,
        activePath: wasActive ? null : state.activePath,
      };
    }

    // A transparent re-open after the engine's SessionStore (LRU max 2)
    // evicted this file's session (see lib/sessionRetry.ts). Unlike
    // "openSuccess", this deliberately leaves opsByPath untouched — the
    // whole point is that the user's edits (ops/includedIds/
    // previewHiddenIds) survive an eviction they never saw.
    case "sessionRefreshed": {
      const { path, result } = action;
      return {
        ...state,
        files: updateFile(state.files, path, {
          status: "open",
          sessionId: result.sessionId,
          tree: result.tree,
          width: result.width,
          height: result.height,
          // 다시 읽어온 파일이므로 수정 시각도 갱신한다. 그 사이 아티스트가
          // 저장했다면 여기서 값이 달라지고, 만들어둔 미리보기는 자연히 버려진다.
          mtime: result.mtime,
        }),
      };
    }

    // The engine child process died and was restarted (EngineStatus banner).
    // Every session the old process held is gone with it, so every file
    // resets to idle — selecting one again opens a fresh session against
    // the same path. Ops/includedIds/previewHiddenIds are left in opsByPath.
    // For a plainly-opened file that is inert, unreferenced state: the next
    // openSuccess for that path rebuilds it from the fresh tree. For a
    // *restored* file it is neither inert nor rebuilt — openSuccess above
    // deliberately holds on to it while the mtime still matches, so it stays
    // live across the restart and the same must go for its matchedIds.
    case "engineRestarted": {
      // 복원한 파일의 매칭 결과는 지킨다. 아래 "옛 세션에서 나온 id라 버린다"는
      // 근거가 복원 경로에는 맞지 않는다 — restoreProject가 이미 앱 재시작을
      // 건너 저장된 id를 세우고 있고 그것이 이 기능의 전제다. 엔진 프로세스가
      // 죽어도 디스크의 PSD는 그대로이므로 그 id는 여전히 유효하다. PSD가
      // 실제로 바뀌었으면 다음 openSuccess가 `!isRestoredMatch`로 지운다 —
      // 검증 게이트는 거기 있다.
      //
      // 여기서 버리면 되돌아올 길이 없다: 로드 큐는 복원본에 자동 적용을 걸지
      // 않고(App.tsx의 alreadyApplied), 그물 효과도 presetApplied가 false가
      // 아니면 비켜서므로 matchedIds를 다시 채울 applyPresetResult가 영영 오지
      // 않는다. 그리고 matchedIds는 표시용이 아니라 내보내기 인자다
      // (ExportDialog가 그대로 넘기고, 엔진은 그것이 없으면 "전부 해당"으로
      // 읽는다) — 비어 있으면 색 통일이 매칭된 라인이 아니라 포함된 레이어
      // 전부에 걸리는데, 아티스트에게는 아무 표시도 안 간다.
      const matchedIdsByPath: Record<string, number[]> = {};
      for (const path of Object.keys(state.restoredMtimeByPath)) {
        const restoredMatches = state.matchedIdsByPath[path];
        if (restoredMatches) matchedIdsByPath[path] = restoredMatches;
      }
      return {
        ...state,
        activePath: null,
        // 옛 프로세스가 들고 있던 세션이 전부 사라졌으므로 그 세션에서 나온
        // 매칭 결과는 버린다(복원한 파일만 위와 같이 예외다).
        matchedIdsByPath,
        // 검출 기록도 세션과 함께 죽는다. 파일을 다시 열어 프리셋이 붙으면
        // 감시 효과가 다시 잰다.
        drawnLineIdsByPath: {},
        files: state.files.map((f) => ({ path: f.path, status: "idle" })),
      };
    }

    case "restoreProject": {
      const files: FileEntry[] = action.entries.map((e) => ({
        path: e.path, status: "idle", tree: e.tree, mtime: e.mtime,
      }));
      const opsByPath: Record<string, OpsState> = {};
      const matchedIdsByPath: Record<string, number[]> = {};
      const restoredMtimeByPath: Record<string, number> = {};
      for (const e of action.entries) {
        opsByPath[e.path] = e.ops;
        // null은 "저장할 때 이 파일에는 프리셋이 걸린 적이 없었다"이므로 키를
        // 아예 넣지 않는다 — 그래야 여기서도 undefined로 남는다. []를 넣으면
        // 그 파일의 색 통일 대상이 "전부"에서 "아무 데도 안"으로 뒤집히고
        // (ProjectEntry.matchedIds 주석 참고), 되돌릴 길이 없다: 복원본에는
        // 자동 적용이 걸리지 않으므로 matchedIds를 다시 채울 applyPresetResult가
        // 영영 오지 않는다.
        if (e.matchedIds !== null) matchedIdsByPath[e.path] = e.matchedIds;
        restoredMtimeByPath[e.path] = e.mtime;
      }
      return {
        ...initialAppState,
        files, opsByPath, matchedIdsByPath, restoredMtimeByPath,
        activePath: files[0]?.path ?? null,
      };
    }

    default:
      return state;
  }
}

/**
 * Async orchestration for opening a file: dispatches openStart, calls the
 * engine, then dispatches openSuccess/openError. Kept as a standalone
 * function (not inlined in a component) so it can be unit-tested with a
 * mocked engine module and a plain dispatch collector.
 *
 * `activate: false`는 목록에 추가되자마자 배경에서 미리 여는 경우다 — 그때는
 * 보고 있던 파일을 뺏지 않는다. 열린 결과를 돌려주는 것은 호출자가 곧바로
 * 프리셋을 적용할 수 있게 하기 위해서다(세션이 아직 엔진의 LRU 안에 있을 때).
 * 실패는 openError로 이미 보고했으므로 null을 돌려준다.
 */
export async function openFileEffect(
  dispatch: Dispatch<AppAction>,
  path: string,
  options: { activate?: boolean; collect?: (path: string, error: EngineError) => void } = {}
): Promise<OpenResult | null> {
  dispatch({ type: "openStart", path, activate: options.activate !== false });
  try {
    const result = await openPsd(path);
    dispatch({ type: "openSuccess", path, result });
    return result;
  } catch (e) {
    const error: EngineError = e instanceof EngineRpcError ? { message: e.message, traceback: e.traceback } : errorFrom(e);
    // collect를 준 쪽은 실패를 모아 스스로 알린다(로드 큐). 안 준 쪽은 클릭 한
    // 번에 대한 응답이므로 그 자리에서 카드가 뜨는 것이 맞다.
    dispatch({ type: "openError", path, error, quiet: options.collect !== undefined });
    options.collect?.(path, error);
    return null;
  }
}

/**
 * 세션 없이 "열림"인 파일에 **세션만** 붙인다. 작업 프로세스가 준비한 파일이
 * 그 상태다 — 트리·매칭·미리보기는 다 있는데 세션이 없다(세션은 메인 엔진
 * SessionStore의 것이라 워커가 만들 수 없다).
 *
 * openFileEffect를 쓰지 않는 이유가 이 함수의 전부다. openSuccess는 ops를
 * 트리로 다시 만들고 matchedIdsByPath를 지우고 presetApplied를 내린다 — 그러면
 * 워커가 한 프리셋 매칭이 버려지고, 자동 적용이 메인 엔진에서 한 번 더 돌고,
 * 그 사이 matchedIds가 비어 캐시 키가 갈려 워커가 구운 그림을 화면이 못 찾는다.
 * sessionRefreshed는 축출 후 재오픈과 같은 뜻이고, 그 액션은 **opsByPath를
 * 일부러 건드리지 않는다**(같은 파일의 작업을 이어가는 것이므로).
 *
 * 실패는 openError로 접는다. 카드가 뜨는 것도 중요하지만 status가 "error"가
 * 되는 것이 더 중요하다 — selectFile이 "error"를 다시 여는 상태로 취급하므로,
 * 그 파일을 한 번 더 누르면 정상 경로로 복구된다. 조용히 두면 세션이 영영 안
 * 붙고 썸네일·내보내기가 그 파일에서만 죽은 채로 남는다.
 *
 * 연 결과를 돌려주는 것은 **세션 id가 그 자리에서 필요한 호출부** 때문이다:
 * 워밍업 체인은 warm_preview_tiles를 세션에 대고 부르므로, dispatch가 화면
 * 상태에 반영되기를 기다릴 수 없다. 실패는 null이고, 그때는 위 openError로
 * status가 "error"라 호출부의 선택에서 자연히 빠진다.
 */
export async function attachSessionEffect(dispatch: Dispatch<AppAction>, path: string): Promise<OpenResult | null> {
  try {
    const result = await openPsd(path);
    dispatch({ type: "sessionRefreshed", path, result });
    return result;
  } catch (e) {
    const error: EngineError = e instanceof EngineRpcError ? { message: e.message, traceback: e.traceback } : errorFrom(e);
    dispatch({ type: "openError", path, error });
    return null;
  }
}

/**
 * 열린 파일에 프리셋을 적용한다. 파일을 클릭해서 열었든 로드 큐가 미리 열었든
 * 같은 함수를 쓰므로 두 경로의 결과가 갈라지지 않는다.
 *
 * presetApplyStarted를 엔진 호출 *전에* 보내는 것이 요점이다: 이 래치가 서 있어야
 * 자동 적용이 같은 세션에 두 번 걸리지 않고, 적용이 실패해도 재시도로 번지지
 * 않는다(FileEntry.presetApplied 주석 참고).
 */
export async function applyPresetEffect(
  dispatch: Dispatch<AppAction>,
  path: string,
  sessionId: number,
  preset: Preset
): Promise<SkippedLayer[]> {
  dispatch({ type: "presetApplyStarted", path });
  try {
    const result = await withEvictedSessionRetry(
      path,
      sessionId,
      (sid) => applyPreset(sid, preset),
      (r) => dispatch({ type: "sessionRefreshed", path, result: r })
    );
    dispatch({
      type: "applyPresetResult",
      path,
      matchedLayerIds: result.matchedLayerIds,
      operations: result.operations,
    });
    // 규칙에 걸렸는데 그릴 것이 없어 빠진 레이어. 이름은 LINE인데 결과에 없으면
    // 사람이 그 이유를 알 방법이 없으므로 돌려준다.
    //
    // 거부 목록이 아니라 허용 목록인 것이 중요하다. 판별 규칙이 "라인이 아니다"라고
    // 뺀 것들(notLineWord/groupHasOwnLine/excludedToken/blendMode)은 의도한
    // 결과이고 수가 많다 — 실파일 25개에서 95장이다. 그것들이 카드에 얹히면
    // 이 카드가 경고하려던 진짜 오류가 묻힌다.
    //
    // noPixels 안에서의 추림은 엔진이 이미 했다(psd_engine/matching.py의
    // match_preset). 그룹 이름에 딸려온 자식과, 같은 그룹에서 라인이 나온 자리는
    // 여기 오기 전에 빠진다 — 트리와 매치 결과를 함께 봐야 가릴 수 있어서다.
    //
    // 여기서 바로 알리지 않고 돌려주는 이유: 파일을 한꺼번에 불러올 때 파일마다
    // 카드를 띄우면 화면이 카드로 덮여 진짜 오류가 묻힌다. 언제 어떻게 알릴지는
    // 부르는 쪽이 정한다(App.tsx의 로드 큐는 끝에 한 장으로 모아 띄운다).
    return (result.skippedLayers ?? []).filter((s) => s.reason === "noPixels");
  } catch (e) {
    const error: EngineError = e instanceof EngineRpcError ? { message: e.message, traceback: e.traceback } : errorFrom(e);
    dispatch({ type: "pushError", title: `프리셋 자동 적용 실패: ${path}`, error });
    return [];
  }
}

/**
 * "이름은 라인이 아닌데 그림은 선인" 잎의 검출. 후보와 문턱의 근거는
 * lib/detectDrawnLines.ts — 여기는 오케스트레이션만 한다. 프리셋 적용이 끝난
 * 파일에서 App의 감시 효과가 부른다(경로가 셋이라 — 자동 적용·준비 워커·
 * 명시 적용 — 호출부마다 잇는 대신 상태를 보고 돈다).
 *
 * 후보를 STROKE_CHUNK씩 끊어 재는 것은 엔진이 요청을 직렬로 처리해서다 —
 * 한 번에 다 재면 그동안 미리보기가 줄을 선다. 결과는 0장이어도 dispatch한다
 * (래치 — drawnLineIdsByPath 주석). 실패도 카드 한 장 + 빈 래치로 끝낸다:
 * 래치가 없으면 감시 효과가 같은 실패를 영영 반복한다.
 */
export async function detectDrawnLinesEffect(
  dispatch: Dispatch<AppAction>,
  path: string,
  sessionId: number,
  tree: TreeNode[],
  matchedIds: number[],
  preset: Preset,
  waitQuiet?: () => Promise<void>
): Promise<void> {
  const candidates = drawnLineCandidateIds(tree, matchedIds, preset);
  const features: Record<string, StrokeFeatures | null> = {};
  try {
    let sid = sessionId;
    for (let i = 0; i < candidates.length; i += STROKE_CHUNK) {
      // 디코드는 엔진이 조용할 때만 나간다. 청크마다 다시 묻는 것이 요점이다 —
      // 재는 도중에 시작된 조작(파일 전환의 워밍업·썸네일)에 다음 청크부터
      // 양보하고, 조작이 끝나면 이어서 잰다.
      await waitQuiet?.();
      const chunk = candidates.slice(i, i + STROKE_CHUNK);
      const part = await withEvictedSessionRetry(
        path,
        sid,
        (s) => measureLeafStrokes(s, chunk),
        (r) => {
          sid = r.sessionId;
          dispatch({ type: "sessionRefreshed", path, result: r });
        }
      );
      Object.assign(features, part);
    }
    dispatch({ type: "drawnLinesDetected", path, layerIds: judgeDrawnLines(features) });
  } catch (e) {
    const error: EngineError =
      e instanceof EngineRpcError ? { message: e.message, traceback: e.traceback } : errorFrom(e);
    dispatch({ type: "pushError", title: `선 그림 검출 실패: ${path}`, error });
    dispatch({ type: "drawnLinesDetected", path, layerIds: [] });
  }
}

/**
 * 검출을 한 번에 한 파일로 묶는 대기열. 감시 그물(App.tsx)은 조건에 맞는 열린
 * 파일 전부에 효과를 쏘는데, 엔진 세션은 LRU 두 칸이라 검출 여럿이 동시에
 * 돌면 각자의 재열기가 서로의 세션을 걷어찬다 — 걷어차기가 재시도 상한
 * (sessionRetry의 MAX_REOPENS)까지 겹치면 "선 그림 검출 실패"가 되고, 그동안
 * 직렬 엔진 큐가 수백 MB 재파싱으로 막혀 파일 클릭의 나머지 레이어 로딩이 그
 * 뒤에 줄을 선다. 한 번에 한 파일이면 두 칸이 "검출 1 + 보는 파일 1"로 맞아
 * 걷어차기가 구조적으로 사라진다.
 *
 * 사슬이 아니라 대기열인 이유는 내보내기다. 내보내기는 자기 파일의 검출이
 * 끝난 그림을 담아야 하는데(frontloadDetection), 줄 선 순서대로만 돌면 판
 * 여러 장의 디코드 뒤에서 기다리게 된다 — 그래서 맨 앞으로 당길 수 있어야
 * 하고, 당겨진 일은 "조용할 때" 대기(waitQuiet)도 그만둔다(urgent).
 */
interface DetectJob {
  path: string;
  urgent: boolean;
  run: () => Promise<void>;
  done: Promise<void>;
  resolve: () => void;
}

const detectQueue: DetectJob[] = [];
const pendingDetections = new Map<string, DetectJob>();
let detectPumping = false;

async function pumpDetections(): Promise<void> {
  if (detectPumping) return;
  detectPumping = true;
  try {
    for (;;) {
      const job = detectQueue.shift();
      if (!job) return;
      try {
        await job.run();
      } catch {
        // 효과는 실패를 카드 한 장 + 빈 래치로 삼키므로 여기 올 일이 없지만,
        // 혹시 모를 거부가 펌프를 죽이면 뒤에 선 파일 전부가 영영 안 돈다.
      } finally {
        pendingDetections.delete(job.path);
        job.resolve();
      }
    }
  } finally {
    detectPumping = false;
  }
}

export function queueDetectDrawnLines(
  dispatch: Dispatch<AppAction>,
  path: string,
  sessionId: number,
  tree: TreeNode[],
  matchedIds: number[],
  preset: Preset,
  waitQuiet?: (isUrgent: () => boolean) => Promise<void>
): Promise<void> {
  // 경로당 한 예약. 파일당 한 번은 감시 그물의 래치·inFlight가 보장하지만,
  // 겹쳐 들어와도 대기열이 같은 파일을 두 번 재지 않게 이중으로 막는다.
  const existing = pendingDetections.get(path);
  if (existing) return existing.done;
  let resolve!: () => void;
  const done = new Promise<void>((r) => { resolve = r; });
  const job: DetectJob = {
    path,
    urgent: false,
    run: () =>
      detectDrawnLinesEffect(dispatch, path, sessionId, tree, matchedIds, preset,
        waitQuiet && (() => waitQuiet(() => job.urgent))),
    done,
    resolve,
  };
  pendingDetections.set(path, job);
  detectQueue.push(job);
  void pumpDetections();
  return done;
}

/**
 * path의 검출을 맨 앞으로 당기고 그 완료 약속을 돌려준다. 실행 중이면 당길
 * 것 없이 그 약속을, 예약도 실행도 없으면(래치가 이미 섰거나 대상 아님) null.
 * 당겨진 일은 urgent가 되어 waitQuiet 대기를 그만둔다 — 내보내기가 로드 큐
 * 같은 긴 배경 작업 뒤에서 검출을 기다리다 굳으면 안 된다.
 */
export function frontloadDetection(path: string): Promise<void> | null {
  const job = pendingDetections.get(path);
  if (!job) return null;
  job.urgent = true;
  const i = detectQueue.indexOf(job);
  if (i > 0) {
    detectQueue.splice(i, 1);
    detectQueue.unshift(job);
  }
  return job.done;
}

/**
 * Async orchestration for removing a file from the list: best-effort closes
 * its engine session (if any), then always removes it locally regardless of
 * whether the close RPC succeeded — a close failure (e.g. engine already
 * dead) must not trap the entry in the list, but it must not be swallowed
 * either, so it's reported via pushError.
 */
export async function removeFileEffect(dispatch: Dispatch<AppAction>, file: FileEntry): Promise<void> {
  if (file.sessionId !== undefined) {
    try {
      await closeSession(file.sessionId);
    } catch (e) {
      const error: EngineError = e instanceof EngineRpcError ? { message: e.message, traceback: e.traceback } : errorFrom(e);
      dispatch({ type: "pushError", title: `세션 닫기 실패: ${file.path}`, error });
    }
  }
  dispatch({ type: "removeFile", path: file.path });
}

/**
 * 목록을 통째로 비운다. 폴더를 갈아끼우기 위한 것이다 — `+ 폴더`는 기존 목록에
 * 덧붙이므로, 다음 폴더만 보려면 먼저 비울 수 있어야 한다.
 *
 * 세션은 파일마다 하나씩 닫되 하나가 실패해도 나머지를 계속 닫는다. 그리고 닫기
 * 결과와 무관하게 목록은 비운다 — 엔진 쪽 정리가 안 됐다고 화면이 옛 목록에
 * 붙들려 있으면 사람이 할 수 있는 일이 없다. 어차피 세션은 LRU가 두 칸이라
 * 대부분 이미 축출돼 있고, 남은 것도 다음 open이 밀어낸다.
 */
export async function clearFilesEffect(dispatch: Dispatch<AppAction>, files: FileEntry[]): Promise<void> {
  dispatch({ type: "clearFiles" });
  for (const file of files) {
    if (file.sessionId === undefined) continue;
    try {
      await closeSession(file.sessionId);
    } catch {
      // 이미 축출된 세션을 닫으려 한 것이 대부분이다. 목록을 비우려던 사람에게
      // 알릴 것이 없고, 카드를 띄우면 방금 비운 화면이 다시 카드로 덮인다.
    }
  }
}

export interface AppContextValue {
  state: AppState;
  ops: OpsState;
  activeFile: FileEntry | undefined;
  dispatch: Dispatch<AppAction>;
  addFiles: (paths: string[]) => void;
  selectFile: (path: string) => void;
  removeFile: (path: string) => void;
  clearFiles: () => void;
  togglePreview: (layerId: number) => void;
  setPreviewHidden: (layerIds: number[], hidden: boolean) => void;
  toggleSolo: (layerId: number) => void;
  setSolo: (layerIds: number[], solo: boolean) => void;
  /** 색 경계선 생성의 수동 지정을 켜고 끈다(task-8b). LayerTree의 컨텍스트 메뉴가 쓴다. */
  setEdgeColour: (layerIds: number[], on: boolean) => void;
  setManualLine: (layerIds: number[], on: boolean) => void;
  pushOp: (op: Operation) => void;
  setIncluded: (includedIds: number[]) => void;
  applyPresetResult: (matchedLayerIds: number[], operations: Operation[]) => void;
  undoOp: () => void;
  dismissError: (index: number) => void;
  pushError: (title: string, error: EngineError, files?: string[]) => void;
  refreshSession: (path: string, result: OpenResult) => void;
  engineRestarted: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({
  children,
  initialState,
}: {
  children: ReactNode;
  /**
   * 테스트 전용 훅. 프로젝트 복원(restoreProject)처럼, 화면을 실제로 조작하지
   * 않고서는 도달할 수 없는 상태에서 시작해야 하는 테스트를 위한 것이다.
   * 프로덕션 코드(main.tsx)는 넘기지 않으므로 initialAppState 그대로 시작한다.
   */
  initialState?: AppState;
}) {
  const [state, dispatch] = useReducer(appReducer, initialState ?? initialAppState);

  const addFiles = useCallback((paths: string[]) => dispatch({ type: "addFiles", paths }), []);

  const selectFile = useCallback(
    (path: string) => {
      const file = state.files.find((f) => f.path === path);
      if (!file || file.status === "processing") return;
      // "error" reopens too: a failed open previously became permanently
      // active with no tree and no way to retry (only "idle" retried).
      if (file.status === "idle" || file.status === "error") {
        void openFileEffect(dispatch, path);
      } else {
        dispatch({ type: "selectFile", path });
      }
    },
    [state.files]
  );

  const togglePreview = useCallback(
    (layerId: number) => {
      if (!state.activePath) return;
      dispatch({ type: "togglePreview", path: state.activePath, layerId });
    },
    [state.activePath]
  );

  const setPreviewHidden = useCallback(
    (layerIds: number[], hidden: boolean) => {
      if (!state.activePath) return;
      dispatch({ type: "setPreviewHidden", path: state.activePath, layerIds, hidden });
    },
    [state.activePath]
  );

  const toggleSolo = useCallback(
    (layerId: number) => {
      if (!state.activePath) return;
      dispatch({ type: "toggleSolo", path: state.activePath, layerId });
    },
    [state.activePath]
  );

  const setSolo = useCallback(
    (layerIds: number[], solo: boolean) => {
      if (!state.activePath) return;
      dispatch({ type: "setSolo", path: state.activePath, layerIds, solo });
    },
    [state.activePath]
  );

  const setEdgeColour = useCallback(
    (layerIds: number[], on: boolean) => {
      if (!state.activePath) return;
      dispatch({ type: "setEdgeColour", path: state.activePath, layerIds, on });
    },
    [state.activePath]
  );

  const setManualLine = useCallback(
    (layerIds: number[], on: boolean) => {
      if (!state.activePath) return;
      dispatch({ type: "setManualLine", path: state.activePath, layerIds, on });
    },
    [state.activePath]
  );

  const pushOp = useCallback(
    (op: Operation) => {
      if (!state.activePath) return;
      dispatch({ type: "pushOp", path: state.activePath, op });
    },
    [state.activePath]
  );

  const setIncluded = useCallback(
    (includedIds: number[]) => {
      if (!state.activePath) return;
      dispatch({ type: "setIncluded", path: state.activePath, includedIds });
    },
    [state.activePath]
  );

  const applyPresetResult = useCallback(
    (matchedLayerIds: number[], operations: Operation[]) => {
      if (!state.activePath) return;
      dispatch({ type: "applyPresetResult", path: state.activePath, matchedLayerIds, operations });
    },
    [state.activePath]
  );

  const undoOp = useCallback(() => {
    if (!state.activePath) return;
    dispatch({ type: "undoOp", path: state.activePath });
  }, [state.activePath]);

  const dismissError = useCallback((index: number) => dispatch({ type: "dismissError", index }), []);

  const pushError = useCallback(
    (title: string, error: EngineError, files?: string[]) => dispatch({ type: "pushError", title, error, files }),
    []
  );

  const removeFile = useCallback(
    (path: string) => {
      const file = state.files.find((f) => f.path === path);
      if (!file || file.status === "processing") return;
      void removeFileEffect(dispatch, file);
    },
    [state.files]
  );

  const clearFiles = useCallback(() => {
    void clearFilesEffect(dispatch, state.files);
  }, [state.files]);

  const refreshSession = useCallback(
    (path: string, result: OpenResult) => dispatch({ type: "sessionRefreshed", path, result }),
    []
  );

  const engineRestarted = useCallback(() => dispatch({ type: "engineRestarted" }), []);

  const ops = (state.activePath && state.opsByPath[state.activePath]) || EMPTY_OPS;
  const activeFile = state.files.find((f) => f.path === state.activePath);

  const value = useMemo<AppContextValue>(
    () => ({
      state,
      ops,
      activeFile,
      dispatch,
      addFiles,
      selectFile,
      removeFile,
      clearFiles,
      togglePreview,
      setPreviewHidden,
      toggleSolo,
      setSolo,
      setEdgeColour,
      setManualLine,
      pushOp,
      setIncluded,
      applyPresetResult,
      undoOp,
      dismissError,
      pushError,
      refreshSession,
      engineRestarted,
    }),
    [
      state,
      ops,
      activeFile,
      addFiles,
      selectFile,
      removeFile,
      clearFiles,
      togglePreview,
      setPreviewHidden,
      toggleSolo,
      setSolo,
      setEdgeColour,
      setManualLine,
      pushOp,
      setIncluded,
      applyPresetResult,
      undoOp,
      dismissError,
      pushError,
      refreshSession,
      engineRestarted,
    ]
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useAppStore(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useAppStore must be used within AppProvider");
  return ctx;
}
