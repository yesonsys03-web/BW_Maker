import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from "react";
import { EngineRpcError, closeSession, openPsd } from "../lib/engine";
import { buildEntries, opsReducer, type OpsState } from "../lib/opsReducer";
import type { EngineError, OpenResult, Operation, TreeNode } from "../lib/types";

export type FileStatus = "idle" | "open" | "processing" | "done" | "error";

export interface FileEntry {
  path: string;
  status: FileStatus;
  sessionId?: number;
  tree?: TreeNode[];
  width?: number;
  height?: number;
}

export interface ErrorEntry {
  title: string;
  error: EngineError;
}

export interface AppState {
  files: FileEntry[];
  activePath: string | null;
  opsByPath: Record<string, OpsState>;
  matchedIds: number[];
  errors: ErrorEntry[];
}

export type AppAction =
  | { type: "addFiles"; paths: string[] }
  | { type: "openStart"; path: string }
  | { type: "openSuccess"; path: string; result: OpenResult }
  | { type: "openError"; path: string; error: EngineError }
  | { type: "selectFile"; path: string }
  | { type: "setMatched"; matchedIds: number[] }
  | { type: "togglePreview"; path: string; layerId: number }
  | { type: "setPreviewHidden"; path: string; layerIds: number[]; hidden: boolean }
  | { type: "pushOp"; path: string; op: Operation }
  | { type: "setIncluded"; path: string; includedIds: number[] }
  | { type: "applyPresetResult"; path: string; matchedLayerIds: number[]; operations: Operation[] }
  | { type: "undoOp"; path: string }
  | { type: "dismissError"; index: number }
  | { type: "pushError"; title: string; error: EngineError }
  | { type: "removeFile"; path: string }
  | { type: "sessionRefreshed"; path: string; result: OpenResult }
  | { type: "engineRestarted" };

export const EMPTY_OPS: OpsState = { includedIds: [], previewHiddenIds: [], ops: [], entries: [] };

export const initialAppState: AppState = {
  files: [],
  activePath: null,
  opsByPath: {},
  matchedIds: [],
  errors: [],
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
 * were visible=false in the original tree.
 */
export function buildInitialOpsState(tree: TreeNode[]): OpsState {
  const leaves = collectLeaves(tree);
  const includedIds = leaves
    .filter((n) => n.kind === "pixel")
    .map((n) => n.id)
    .sort((a, b) => a - b);
  const previewHiddenIds = leaves.filter((n) => !n.visible).map((n) => n.id);
  return { includedIds, previewHiddenIds, ops: [], entries: buildEntries(includedIds, []) };
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
        activePath: action.path,
        files: updateFile(state.files, action.path, { status: "processing" }),
      };

    case "openSuccess": {
      const { path, result } = action;
      return {
        ...state,
        matchedIds: [],
        files: updateFile(state.files, path, {
          status: "open",
          sessionId: result.sessionId,
          tree: result.tree,
          width: result.width,
          height: result.height,
        }),
        opsByPath: { ...state.opsByPath, [path]: buildInitialOpsState(result.tree) },
      };
    }

    case "openError":
      return {
        ...state,
        files: updateFile(state.files, action.path, { status: "error" }),
        errors: [...state.errors, { title: `파일 열기 실패: ${action.path}`, error: action.error }],
      };

    case "selectFile":
      return { ...state, activePath: action.path };

    case "setMatched":
      return { ...state, matchedIds: action.matchedIds };

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

    case "pushOp": {
      const current = state.opsByPath[action.path];
      if (!current) return state;
      try {
        const next = opsReducer(current, { type: "pushOp", op: action.op });
        return { ...state, opsByPath: { ...state.opsByPath, [action.path]: next } };
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
        return { ...state, opsByPath: { ...state.opsByPath, [action.path]: next } };
      } catch (e) {
        const original = errorFrom(e);
        return {
          ...state,
          errors: [
            ...state.errors,
            {
              title: "포함 상태 변경 실패",
              error: {
                message:
                  "이 레이어를 참조하는 편집 작업이 있습니다. 먼저 관련 편집(병합/이름변경 등)을 되돌린 뒤 다시 시도하세요.",
                traceback: original.traceback,
              },
            },
          ],
        };
      }
    }

    case "applyPresetResult": {
      const current = state.opsByPath[action.path];
      if (!current) return state;
      try {
        const includedIds = [...action.matchedLayerIds].sort((a, b) => a - b);
        const entries = buildEntries(includedIds, action.operations);
        const next: OpsState = {
          includedIds,
          previewHiddenIds: current.previewHiddenIds,
          ops: action.operations,
          entries,
        };
        return {
          ...state,
          matchedIds: action.matchedLayerIds,
          opsByPath: { ...state.opsByPath, [action.path]: next },
        };
      } catch (e) {
        return {
          ...state,
          errors: [...state.errors, { title: "프리셋 적용 실패", error: errorFrom(e) }],
        };
      }
    }

    case "undoOp": {
      const current = state.opsByPath[action.path];
      if (!current || current.ops.length === 0) return state;
      try {
        const next = opsReducer(current, { type: "undo" });
        return { ...state, opsByPath: { ...state.opsByPath, [action.path]: next } };
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
      return { ...state, errors: [...state.errors, { title: action.title, error: action.error }] };

    case "removeFile": {
      const wasActive = state.activePath === action.path;
      const opsByPath = { ...state.opsByPath };
      delete opsByPath[action.path];
      return {
        ...state,
        files: state.files.filter((f) => f.path !== action.path),
        opsByPath,
        activePath: wasActive ? null : state.activePath,
        matchedIds: wasActive ? [] : state.matchedIds,
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
        }),
      };
    }

    // The engine child process died and was restarted (EngineStatus banner).
    // Every session the old process held is gone with it, so every file
    // resets to idle — selecting one again opens a fresh session against
    // the same path. Ops/includedIds/previewHiddenIds are left in
    // opsByPath; the next openSuccess for that path rebuilds them anyway,
    // and until then they're inert, unreferenced state.
    case "engineRestarted":
      return {
        ...state,
        activePath: null,
        matchedIds: [],
        files: state.files.map((f) => ({ path: f.path, status: "idle" })),
      };

    default:
      return state;
  }
}

/**
 * Async orchestration for opening a file: dispatches openStart, calls the
 * engine, then dispatches openSuccess/openError. Kept as a standalone
 * function (not inlined in a component) so it can be unit-tested with a
 * mocked engine module and a plain dispatch collector.
 */
export async function openFileEffect(dispatch: Dispatch<AppAction>, path: string): Promise<void> {
  dispatch({ type: "openStart", path });
  try {
    const result = await openPsd(path);
    dispatch({ type: "openSuccess", path, result });
  } catch (e) {
    const error: EngineError = e instanceof EngineRpcError ? { message: e.message, traceback: e.traceback } : errorFrom(e);
    dispatch({ type: "openError", path, error });
  }
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

export interface AppContextValue {
  state: AppState;
  ops: OpsState;
  activeFile: FileEntry | undefined;
  dispatch: Dispatch<AppAction>;
  addFiles: (paths: string[]) => void;
  selectFile: (path: string) => void;
  removeFile: (path: string) => void;
  togglePreview: (layerId: number) => void;
  setPreviewHidden: (layerIds: number[], hidden: boolean) => void;
  pushOp: (op: Operation) => void;
  setIncluded: (includedIds: number[]) => void;
  applyPresetResult: (matchedLayerIds: number[], operations: Operation[]) => void;
  undoOp: () => void;
  dismissError: (index: number) => void;
  pushError: (title: string, error: EngineError) => void;
  refreshSession: (path: string, result: OpenResult) => void;
  engineRestarted: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, initialAppState);

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
    (title: string, error: EngineError) => dispatch({ type: "pushError", title, error }),
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
      togglePreview,
      setPreviewHidden,
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
      togglePreview,
      setPreviewHidden,
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
