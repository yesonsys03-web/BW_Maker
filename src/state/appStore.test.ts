import { beforeEach, describe, expect, test, vi } from "vitest";

// vi.mock factories are hoisted; only "mock"-prefixed outer vars are reachable inside them.
const mockOpenPsd = vi.fn();
const mockCloseSession = vi.fn();
vi.mock("../lib/engine", async () => {
  const actual = await vi.importActual<typeof import("../lib/engine")>("../lib/engine");
  return {
    ...actual,
    openPsd: (...a: unknown[]) => mockOpenPsd(...a),
    closeSession: (...a: unknown[]) => mockCloseSession(...a),
  };
});

import { EngineRpcError } from "../lib/engine";
import type { TreeNode } from "../lib/types";
import { appReducer, openFileEffect, removeFileEffect, type AppAction, type AppState } from "./appStore";

beforeEach(() => {
  mockOpenPsd.mockReset();
  mockCloseSession.mockReset();
});

const initial: AppState = { files: [], activePath: null, opsByPath: {}, matchedIds: [], errors: [] };

const leaf = (id: number, kind: string, visible = true): TreeNode => ({
  id,
  name: `layer${id}`,
  kind,
  visible,
  blendMode: "normal",
  opacity: 100,
  bbox: [0, 0, 10, 10],
  hasMask: false,
  path: [`layer${id}`],
});

const tree: TreeNode[] = [
  leaf(1, "pixel"),
  leaf(2, "pixel", false),
  {
    ...leaf(3, "group"),
    children: [leaf(4, "type"), leaf(5, "pixel")],
  },
];

describe("addFiles", () => {
  test("appends new files as idle, preserving order", () => {
    const s = appReducer(initial, { type: "addFiles", paths: ["/a.psd", "/b.psd"] });
    expect(s.files).toEqual([
      { path: "/a.psd", status: "idle" },
      { path: "/b.psd", status: "idle" },
    ]);
  });

  test("does not duplicate a path already present", () => {
    let s = appReducer(initial, { type: "addFiles", paths: ["/a.psd"] });
    s = appReducer(s, { type: "addFiles", paths: ["/a.psd", "/b.psd"] });
    expect(s.files.map((f) => f.path)).toEqual(["/a.psd", "/b.psd"]);
  });

  test("does not duplicate within a single batch", () => {
    const s = appReducer(initial, { type: "addFiles", paths: ["/a.psd", "/a.psd"] });
    expect(s.files.map((f) => f.path)).toEqual(["/a.psd"]);
  });
});

describe("open success/failure transitions", () => {
  test("openStart marks the file processing and sets it active", () => {
    let s = appReducer(initial, { type: "addFiles", paths: ["/a.psd"] });
    s = appReducer(s, { type: "openStart", path: "/a.psd" });
    expect(s.files[0].status).toBe("processing");
    expect(s.activePath).toBe("/a.psd");
  });

  test("openSuccess sets open status, tree/session fields, and derives initial ops", () => {
    let s = appReducer(initial, { type: "addFiles", paths: ["/a.psd"] });
    s = appReducer(s, { type: "openStart", path: "/a.psd" });
    s = appReducer(s, {
      type: "openSuccess",
      path: "/a.psd",
      result: { sessionId: 42, width: 100, height: 200, colorMode: "RGB", depth: 8, tree },
    });

    expect(s.files[0]).toMatchObject({
      path: "/a.psd",
      status: "open",
      sessionId: 42,
      width: 100,
      height: 200,
    });

    const ops = s.opsByPath["/a.psd"];
    // pixel leaves only (1, 2, 5), ascending — the group (3) and non-pixel leaf (4) excluded.
    expect(ops.includedIds).toEqual([1, 2, 5]);
    // leaves with visible=false in the original tree.
    expect(ops.previewHiddenIds).toEqual([2]);
    expect(ops.ops).toEqual([]);
    expect(ops.entries.map((e) => e.entryId)).toEqual([1, 2, 5]);
  });

  test("openError marks the file error and pushes onto the error stack", () => {
    let s = appReducer(initial, { type: "addFiles", paths: ["/a.psd"] });
    s = appReducer(s, { type: "openStart", path: "/a.psd" });
    s = appReducer(s, {
      type: "openError",
      path: "/a.psd",
      error: { message: "boom", traceback: "Traceback ..." },
    });

    expect(s.files[0].status).toBe("error");
    expect(s.errors).toHaveLength(1);
    expect(s.errors[0]).toEqual({
      title: expect.stringContaining("/a.psd"),
      error: { message: "boom", traceback: "Traceback ..." },
    });
  });
});

describe("selectFile", () => {
  test("switches the active file without touching status/ops", () => {
    let s = appReducer(initial, { type: "addFiles", paths: ["/a.psd", "/b.psd"] });
    s = appReducer(s, { type: "openStart", path: "/a.psd" });
    s = appReducer(s, {
      type: "openSuccess",
      path: "/a.psd",
      result: { sessionId: 1, width: 1, height: 1, colorMode: "RGB", depth: 8, tree: [] },
    });
    s = appReducer(s, { type: "selectFile", path: "/b.psd" });
    expect(s.activePath).toBe("/b.psd");
    expect(s.files.find((f) => f.path === "/a.psd")?.status).toBe("open");
  });
});

describe("ops actions delegate to the active file's OpsState", () => {
  function opened(): AppState {
    let s = appReducer(initial, { type: "addFiles", paths: ["/a.psd"] });
    s = appReducer(s, { type: "openStart", path: "/a.psd" });
    return appReducer(s, {
      type: "openSuccess",
      path: "/a.psd",
      result: { sessionId: 1, width: 1, height: 1, colorMode: "RGB", depth: 8, tree },
    });
  }

  test("pushOp merges layers and records the entry", () => {
    const s0 = opened();
    const s = appReducer(s0, { type: "pushOp", path: "/a.psd", op: { op: "merge", layerIds: [1, 2], name: "M" } });
    // merge inserts at the topmost source position (index of layer 2), sources bottom->top.
    expect(s.opsByPath["/a.psd"].entries.map((e) => e.entryId)).toEqual([-1, 5]);
    expect(s.errors).toHaveLength(0);
  });

  test("pushOp naming a layer that isn't in the export set changes nothing and raises nothing", () => {
    // ops는 includedIds 위에서 재생되므로, 내보내기 대상이 아닌 레이어를 가리키는
    // 작업은 적용할 대상이 없다. 예전에는 여기서 예외가 났다.
    const s0 = opened();
    let s: AppState | undefined;
    expect(() => {
      s = appReducer(s0, { type: "pushOp", path: "/a.psd", op: { op: "rename", layerId: 999, name: "x" } });
    }).not.toThrow();
    expect(s!.errors).toHaveLength(0);
    expect(s!.opsByPath["/a.psd"].entries).toEqual(s0.opsByPath["/a.psd"].entries);
  });

  test("unchecking a layer used by a merge succeeds, leaving the merge on what remains", () => {
    // 회귀 방지: 예전에는 "포함 상태 변경 실패 — 먼저 병합을 되돌리세요"가 떴다.
    // 체크 해제는 일상적인 동작이므로 무관한 편집을 되돌리게 만들면 안 된다.
    const s0 = opened();
    const merged = appReducer(s0, { type: "pushOp", path: "/a.psd", op: { op: "merge", layerIds: [1, 2], name: "M" } });
    let s: AppState | undefined;
    expect(() => {
      s = appReducer(merged, { type: "setIncluded", path: "/a.psd", includedIds: [1, 5] }); // 병합에 쓰인 2를 뺀다
    }).not.toThrow();
    expect(s!.errors).toHaveLength(0);
    expect(s!.opsByPath["/a.psd"].includedIds).toEqual([1, 5]);
    const survivor = s!.opsByPath["/a.psd"].entries.find((e) => e.sourceIds.includes(1));
    expect(survivor?.name).toBe("M");
    expect(survivor?.sourceIds).toEqual([1]);
  });

  test("re-checking that layer restores the two-source merge", () => {
    const s0 = opened();
    const merged = appReducer(s0, { type: "pushOp", path: "/a.psd", op: { op: "merge", layerIds: [1, 2], name: "M" } });
    const dropped = appReducer(merged, { type: "setIncluded", path: "/a.psd", includedIds: [1, 5] });
    const restored = appReducer(dropped, { type: "setIncluded", path: "/a.psd", includedIds: [1, 2, 5] });
    const entry = restored.opsByPath["/a.psd"].entries.find((e) => e.sourceIds.length === 2);
    expect(entry?.sourceIds).toEqual([1, 2]);
    expect(entry?.name).toBe("M");
    expect(restored.errors).toHaveLength(0);
  });

  test("togglePreview flips a layer id in previewHiddenIds", () => {
    const s0 = opened();
    // initial previewHiddenIds already contains 2 (visible=false in the source tree).
    expect(s0.opsByPath["/a.psd"].previewHiddenIds).toEqual([2]);
    const s = appReducer(s0, { type: "togglePreview", path: "/a.psd", layerId: 1 });
    expect(s.opsByPath["/a.psd"].previewHiddenIds).toEqual([2, 1]);
  });

  test("setPreviewHidden hides/shows a batch of ids atomically (used by the group eye toggle)", () => {
    const s0 = opened();
    // 2 is already preview-hidden from openSuccess; hide 1 and 5 too.
    const hidden = appReducer(s0, { type: "setPreviewHidden", path: "/a.psd", layerIds: [1, 5], hidden: true });
    expect(hidden.opsByPath["/a.psd"].previewHiddenIds.sort()).toEqual([1, 2, 5]);

    const shown = appReducer(hidden, { type: "setPreviewHidden", path: "/a.psd", layerIds: [1, 2, 5], hidden: false });
    expect(shown.opsByPath["/a.psd"].previewHiddenIds).toEqual([]);
  });

  test("undoOp reverts the last op", () => {
    const s0 = opened();
    const merged = appReducer(s0, { type: "pushOp", path: "/a.psd", op: { op: "merge", layerIds: [1, 2], name: "M" } });
    const s = appReducer(merged, { type: "undoOp", path: "/a.psd" });
    expect(s.opsByPath["/a.psd"].entries.map((e) => e.entryId)).toEqual([1, 2, 5]);
  });

  test("applyPresetResult replaces includedIds/ops/entries with the engine's result and sets matchedIds", () => {
    const s0 = opened();
    const s = appReducer(s0, {
      type: "applyPresetResult",
      path: "/a.psd",
      matchedLayerIds: [5, 1],
      operations: [{ op: "merge", layerIds: [1, 5], name: "M" }],
    });
    expect(s.matchedIds).toEqual([5, 1]);
    expect(s.opsByPath["/a.psd"].includedIds).toEqual([1, 5]);
    expect(s.opsByPath["/a.psd"].ops).toEqual([{ op: "merge", layerIds: [1, 5], name: "M" }]);
    expect(s.opsByPath["/a.psd"].entries.map((e) => e.entryId)).toEqual([-1]);
    // previewHiddenIds carries over unchanged from the prior OpsState.
    expect(s.opsByPath["/a.psd"].previewHiddenIds).toEqual(s0.opsByPath["/a.psd"].previewHiddenIds);
    expect(s.errors).toHaveLength(0);
  });

  test("applyPresetResult applies the match even when an operation names a layer outside it", () => {
    const s0 = opened();
    let s: AppState | undefined;
    expect(() => {
      s = appReducer(s0, {
        type: "applyPresetResult",
        path: "/a.psd",
        matchedLayerIds: [1],
        operations: [{ op: "rename", layerId: 999, name: "x" }], // 999 isn't in matchedLayerIds
      });
    }).not.toThrow();
    expect(s!.errors).toHaveLength(0);
    // 매칭 결과는 반영되고, 대상이 없는 작업만 아무 일도 하지 않는다.
    expect(s!.matchedIds).toEqual([1]);
    expect(s!.opsByPath["/a.psd"].entries).toEqual([{ entryId: 1, sourceIds: [1], name: null }]);
  });
});

describe("error stack management", () => {
  test("dismissError removes by index", () => {
    let s = appReducer(initial, { type: "pushError", title: "t1", error: { message: "e1", traceback: "" } });
    s = appReducer(s, { type: "pushError", title: "t2", error: { message: "e2", traceback: "" } });
    s = appReducer(s, { type: "dismissError", index: 0 });
    expect(s.errors).toEqual([{ title: "t2", error: { message: "e2", traceback: "" } }]);
  });
});

describe("removeFile", () => {
  function twoFilesOpened(): AppState {
    let s = appReducer(initial, { type: "addFiles", paths: ["/a.psd", "/b.psd"] });
    s = appReducer(s, { type: "openStart", path: "/a.psd" });
    s = appReducer(s, {
      type: "openSuccess",
      path: "/a.psd",
      result: { sessionId: 1, width: 1, height: 1, colorMode: "RGB", depth: 8, tree },
    });
    s = appReducer(s, { type: "openStart", path: "/b.psd" });
    return appReducer(s, {
      type: "openSuccess",
      path: "/b.psd",
      result: { sessionId: 2, width: 1, height: 1, colorMode: "RGB", depth: 8, tree: [] },
    });
  }

  test("drops the file entry and its ops state", () => {
    const s0 = twoFilesOpened();
    const s = appReducer(s0, { type: "removeFile", path: "/a.psd" });
    expect(s.files.map((f) => f.path)).toEqual(["/b.psd"]);
    expect(s.opsByPath).not.toHaveProperty("/a.psd");
    expect(s.opsByPath["/b.psd"]).toEqual(s0.opsByPath["/b.psd"]);
  });

  test("resets activePath and matchedIds when the removed file was active", () => {
    const s0 = twoFilesOpened(); // activePath is /b.psd after the second openSuccess
    const withMatched = appReducer(s0, { type: "setMatched", matchedIds: [1, 2] });
    const s = appReducer(withMatched, { type: "removeFile", path: "/b.psd" });
    expect(s.activePath).toBeNull();
    expect(s.matchedIds).toEqual([]);
  });

  test("leaves activePath and matchedIds untouched when removing a non-active file", () => {
    const s0 = twoFilesOpened(); // activePath is /b.psd
    const withMatched = appReducer(s0, { type: "setMatched", matchedIds: [1, 2] });
    const s = appReducer(withMatched, { type: "removeFile", path: "/a.psd" });
    expect(s.activePath).toBe("/b.psd");
    expect(s.matchedIds).toEqual([1, 2]);
  });
});

describe("sessionRefreshed (S2: transparent reopen after LRU eviction)", () => {
  test("updates sessionId/tree/dimensions but leaves opsByPath untouched", () => {
    const s0 = appReducer(initial, { type: "addFiles", paths: ["/a.psd"] });
    const opened = appReducer(s0, {
      type: "openSuccess",
      path: "/a.psd",
      result: { sessionId: 1, width: 10, height: 20, colorMode: "RGB", depth: 8, tree },
    });
    const editedOps = appReducer(opened, {
      type: "pushOp",
      path: "/a.psd",
      op: { op: "rename", layerId: 1, name: "renamed" },
    });

    const s = appReducer(editedOps, {
      type: "sessionRefreshed",
      path: "/a.psd",
      result: { sessionId: 99, width: 10, height: 20, colorMode: "RGB", depth: 8, tree },
    });

    expect(s.files[0]).toMatchObject({ path: "/a.psd", status: "open", sessionId: 99 });
    // The rename op survives the reopen — S2's core requirement.
    expect(s.opsByPath["/a.psd"]).toEqual(editedOps.opsByPath["/a.psd"]);
  });
});

describe("engineRestarted", () => {
  test("resets every file to idle and clears activePath/matchedIds", () => {
    let s = appReducer(initial, { type: "addFiles", paths: ["/a.psd", "/b.psd"] });
    s = appReducer(s, {
      type: "openSuccess",
      path: "/a.psd",
      result: { sessionId: 1, width: 1, height: 1, colorMode: "RGB", depth: 8, tree },
    });
    s = appReducer(s, { type: "setMatched", matchedIds: [1] });

    const restarted = appReducer(s, { type: "engineRestarted" });

    expect(restarted.files).toEqual([
      { path: "/a.psd", status: "idle" },
      { path: "/b.psd", status: "idle" },
    ]);
    expect(restarted.activePath).toBeNull();
    expect(restarted.matchedIds).toEqual([]);
  });
});

describe("openFileEffect (async orchestration against the mocked engine)", () => {
  test("dispatches openStart then openSuccess on success", async () => {
    mockOpenPsd.mockResolvedValue({ sessionId: 9, width: 1, height: 1, colorMode: "RGB", depth: 8, tree: [] });
    const actions: AppAction[] = [];
    await openFileEffect((a) => actions.push(a), "/a.psd");
    expect(actions[0]).toEqual({ type: "openStart", path: "/a.psd" });
    expect(actions[1].type).toBe("openSuccess");
  });

  test("dispatches openStart then openError with full traceback on engine failure", async () => {
    mockOpenPsd.mockRejectedValue(new EngineRpcError({ message: "boom", traceback: "Traceback ..." }));
    const actions: AppAction[] = [];
    await openFileEffect((a) => actions.push(a), "/a.psd");
    expect(actions[0]).toEqual({ type: "openStart", path: "/a.psd" });
    expect(actions[1]).toEqual({
      type: "openError",
      path: "/a.psd",
      error: { message: "boom", traceback: "Traceback ..." },
    });
  });
});

describe("removeFileEffect (async orchestration against the mocked engine)", () => {
  test("closes the session (when present) then dispatches removeFile", async () => {
    mockCloseSession.mockResolvedValue(undefined);
    const actions: AppAction[] = [];
    await removeFileEffect((a) => actions.push(a), { path: "/a.psd", status: "open", sessionId: 5 });
    expect(mockCloseSession).toHaveBeenCalledWith(5);
    expect(actions).toEqual([{ type: "removeFile", path: "/a.psd" }]);
  });

  test("skips closeSession for a file with no sessionId (never opened)", async () => {
    const actions: AppAction[] = [];
    await removeFileEffect((a) => actions.push(a), { path: "/a.psd", status: "idle" });
    expect(mockCloseSession).not.toHaveBeenCalled();
    expect(actions).toEqual([{ type: "removeFile", path: "/a.psd" }]);
  });

  test("a close_session failure is reported via pushError but the file is still removed (not swallowed, not blocked)", async () => {
    mockCloseSession.mockRejectedValue(new EngineRpcError({ message: "engine not running", traceback: "" }));
    const actions: AppAction[] = [];
    await removeFileEffect((a) => actions.push(a), { path: "/a.psd", status: "open", sessionId: 5 });
    expect(actions[0]).toEqual({
      type: "pushError",
      title: "세션 닫기 실패: /a.psd",
      error: { message: "engine not running", traceback: "" },
    });
    expect(actions[1]).toEqual({ type: "removeFile", path: "/a.psd" });
  });
});
