import { beforeEach, describe, expect, test, vi } from "vitest";

// vi.mock factories are hoisted; only "mock"-prefixed outer vars are reachable inside them.
const mockOpenPsd = vi.fn();
vi.mock("../lib/engine", async () => {
  const actual = await vi.importActual<typeof import("../lib/engine")>("../lib/engine");
  return { ...actual, openPsd: (...a: unknown[]) => mockOpenPsd(...a) };
});

import { EngineRpcError } from "../lib/engine";
import type { TreeNode } from "../lib/types";
import { appReducer, openFileEffect, type AppAction, type AppState } from "./appStore";

beforeEach(() => {
  mockOpenPsd.mockReset();
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

  test("pushOp with an invalid reference is caught and reported via the error stack (no throw)", () => {
    const s0 = opened();
    let s: AppState | undefined;
    expect(() => {
      s = appReducer(s0, { type: "pushOp", path: "/a.psd", op: { op: "rename", layerId: 999, name: "x" } });
    }).not.toThrow();
    expect(s!.errors).toHaveLength(1);
    expect(s!.errors[0].error.message).toBeTruthy();
    // the ops state itself is left untouched by the failed op.
    expect(s!.opsByPath["/a.psd"]).toEqual(s0.opsByPath["/a.psd"]);
  });

  test("setIncluded referencing a layer used by an existing op is caught with a clear message (no throw, no silent no-op)", () => {
    const s0 = opened();
    const merged = appReducer(s0, { type: "pushOp", path: "/a.psd", op: { op: "merge", layerIds: [1, 2], name: "M" } });
    let s: AppState | undefined;
    expect(() => {
      s = appReducer(merged, { type: "setIncluded", path: "/a.psd", includedIds: [1, 5] }); // drops layer 2, referenced by the merge
    }).not.toThrow();
    expect(s!.errors).toHaveLength(1);
    expect(s!.errors[0].error.message).toContain("참조하는 편집");
    expect(s!.opsByPath["/a.psd"]).toEqual(merged.opsByPath["/a.psd"]);
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
});

describe("error stack management", () => {
  test("dismissError removes by index", () => {
    let s = appReducer(initial, { type: "pushError", title: "t1", error: { message: "e1", traceback: "" } });
    s = appReducer(s, { type: "pushError", title: "t2", error: { message: "e2", traceback: "" } });
    s = appReducer(s, { type: "dismissError", index: 0 });
    expect(s.errors).toEqual([{ title: "t2", error: { message: "e2", traceback: "" } }]);
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
