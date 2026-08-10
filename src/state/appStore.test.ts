import { beforeEach, describe, expect, test, vi } from "vitest";

// vi.mock factories are hoisted; only "mock"-prefixed outer vars are reachable inside them.
const mockOpenPsd = vi.fn();
const mockCloseSession = vi.fn();
const mockApplyPreset = vi.fn();
vi.mock("../lib/engine", async () => {
  const actual = await vi.importActual<typeof import("../lib/engine")>("../lib/engine");
  return {
    ...actual,
    openPsd: (...a: unknown[]) => mockOpenPsd(...a),
    closeSession: (...a: unknown[]) => mockCloseSession(...a),
    applyPreset: (...a: unknown[]) => mockApplyPreset(...a),
  };
});

import { EngineRpcError } from "../lib/engine";
import type { Preset, TreeNode } from "../lib/types";
import {
  appReducer,
  applyPresetEffect,
  buildInitialOpsState,
  EMPTY_OPS,
  initialAppState,
  openFileEffect,
  removeFileEffect,
  type AppAction,
  type AppState,
} from "./appStore";

beforeEach(() => {
  mockOpenPsd.mockReset();
  mockCloseSession.mockReset();
  mockApplyPreset.mockReset();
});

const preset: Preset = {
  name: "line",
  includeRules: [],
  excludeRules: [],
  mergeRule: "none",
  roleTokens: [],
  naming: "original",
  outputSuffix: "_line",
  embedPreview: true,
  lineColor: null,
} as unknown as Preset;

const initial: AppState = {
  files: [], activePath: null, opsByPath: {}, matchedIdsByPath: {}, errors: [], restoredMtimeByPath: {},
};

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
    s = appReducer(s, { type: "openStart", path: "/a.psd", activate: true });
    expect(s.files[0].status).toBe("processing");
    expect(s.activePath).toBe("/a.psd");
  });

  test("openSuccess sets open status, tree/session fields, and derives initial ops", () => {
    let s = appReducer(initial, { type: "addFiles", paths: ["/a.psd"] });
    s = appReducer(s, { type: "openStart", path: "/a.psd", activate: true });
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
    s = appReducer(s, { type: "openStart", path: "/a.psd", activate: true });
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
    s = appReducer(s, { type: "openStart", path: "/a.psd", activate: true });
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
    s = appReducer(s, { type: "openStart", path: "/a.psd", activate: true });
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
    expect(s.matchedIdsByPath["/a.psd"]).toEqual([5, 1]);
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
    expect(s!.matchedIdsByPath["/a.psd"]).toEqual([1]);
    expect(s!.opsByPath["/a.psd"].entries).toEqual([{ entryId: 1, sourceIds: [1], name: null }]);
  });

  // 로드 큐는 목록의 파일을 배경에서 차례로 열고 프리셋까지 붙인다. 레이어 id는
  // 세션(=파일) 안에서만 유일하므로, 매칭 결과를 전역 칸 하나에 담으면 마지막으로
  // 처리된 파일의 id가 남는다 — 그 숫자들이 화면이 보고 있는 파일에서는 전혀 다른
  // 레이어를 가리켜, "라인만"에 mask·fill·grain 같은 것이 섞여 나왔다.
  test("a background file's preset result leaves the active file's matched ids alone", () => {
    let s = appReducer(initial, { type: "addFiles", paths: ["/a.psd", "/b.psd"] });
    s = appReducer(s, { type: "openStart", path: "/a.psd", activate: true });
    s = appReducer(s, {
      type: "openSuccess",
      path: "/a.psd",
      result: { sessionId: 1, width: 1, height: 1, colorMode: "RGB", depth: 8, tree },
    });
    s = appReducer(s, { type: "applyPresetResult", path: "/a.psd", matchedLayerIds: [1], operations: [] });

    // 로드 큐가 배경에서 여는 두 번째 파일. 화면은 계속 /a.psd를 보고 있다.
    s = appReducer(s, { type: "openStart", path: "/b.psd", activate: false });
    s = appReducer(s, {
      type: "openSuccess",
      path: "/b.psd",
      result: { sessionId: 2, width: 1, height: 1, colorMode: "RGB", depth: 8, tree },
    });
    s = appReducer(s, { type: "applyPresetResult", path: "/b.psd", matchedLayerIds: [2, 5], operations: [] });

    expect(s.activePath).toBe("/a.psd");
    expect(s.matchedIdsByPath["/a.psd"]).toEqual([1]);
    expect(s.matchedIdsByPath["/b.psd"]).toEqual([2, 5]);
  });

  // 위 테스트의 절반 — 프리셋이 붙기 전, 파일이 열리는 것만으로도 전역 칸은
  // 비워졌다. 그동안 화면의 "라인만" 목록이 통째로 사라졌다.
  test("opening a background file does not clear the active file's matched ids", () => {
    let s = appReducer(initial, { type: "addFiles", paths: ["/a.psd", "/b.psd"] });
    s = appReducer(s, { type: "openStart", path: "/a.psd", activate: true });
    s = appReducer(s, {
      type: "openSuccess",
      path: "/a.psd",
      result: { sessionId: 1, width: 1, height: 1, colorMode: "RGB", depth: 8, tree },
    });
    s = appReducer(s, { type: "applyPresetResult", path: "/a.psd", matchedLayerIds: [1, 2], operations: [] });

    s = appReducer(s, {
      type: "openSuccess",
      path: "/b.psd",
      result: { sessionId: 2, width: 1, height: 1, colorMode: "RGB", depth: 8, tree },
    });

    expect(s.matchedIdsByPath["/a.psd"]).toEqual([1, 2]);
  });

  // 반대로 그 파일을 **다시** 열면 세션이 새것이므로 옛 매칭은 버려야 한다.
  test("reopening a file drops its own stale matched ids", () => {
    let s = appReducer(initial, { type: "addFiles", paths: ["/a.psd"] });
    s = appReducer(s, {
      type: "openSuccess",
      path: "/a.psd",
      result: { sessionId: 1, width: 1, height: 1, colorMode: "RGB", depth: 8, tree },
    });
    s = appReducer(s, { type: "applyPresetResult", path: "/a.psd", matchedLayerIds: [1], operations: [] });

    s = appReducer(s, {
      type: "openSuccess",
      path: "/a.psd",
      result: { sessionId: 9, width: 1, height: 1, colorMode: "RGB", depth: 8, tree },
    });

    expect(s.matchedIdsByPath).not.toHaveProperty("/a.psd");
  });

  // --- solo (설계 문서 5절) ---

  test("EMPTY_OPS carries an empty solo set", () => {
    expect(EMPTY_OPS.soloIds).toEqual([]);
  });

  test("a freshly opened tree starts with nothing soloed", () => {
    const state = buildInitialOpsState([
      { id: 1, name: "a", kind: "pixel", visible: true, blendMode: "normal", opacity: 100,
        bbox: [0, 0, 1, 1], hasMask: false, path: ["a"] },
    ]);
    expect(state.soloIds).toEqual([]);
  });

  test("toggleSolo flips a layer id in soloIds", () => {
    const s0 = opened();
    expect(s0.opsByPath["/a.psd"].soloIds).toEqual([]);
    const on = appReducer(s0, { type: "toggleSolo", path: "/a.psd", layerId: 1 });
    expect(on.opsByPath["/a.psd"].soloIds).toEqual([1]);
    const off = appReducer(on, { type: "toggleSolo", path: "/a.psd", layerId: 1 });
    expect(off.opsByPath["/a.psd"].soloIds).toEqual([]);
  });

  test("setSolo turns a batch on and off (used by the group solo toggle)", () => {
    const s0 = opened();
    const on = appReducer(s0, { type: "setSolo", path: "/a.psd", layerIds: [1, 5], solo: true });
    expect(on.opsByPath["/a.psd"].soloIds).toEqual([1, 5]);
    const off = appReducer(on, { type: "setSolo", path: "/a.psd", layerIds: [1, 5], solo: false });
    expect(off.opsByPath["/a.psd"].soloIds).toEqual([]);
  });

  // solo를 걸고 푸는 동안 눈과 체크박스는 그대로여야 한다. 이것이 깨지면 solo를
  // 풀었을 때 원래 화면이 돌아오지 않는다.
  test("solo leaves the eye toggles and the export selection alone", () => {
    const s0 = opened();
    const before = s0.opsByPath["/a.psd"];
    const on = appReducer(s0, { type: "setSolo", path: "/a.psd", layerIds: [1, 5], solo: true });
    const after = appReducer(on, { type: "setSolo", path: "/a.psd", layerIds: [1, 5], solo: false })
      .opsByPath["/a.psd"];
    expect(after.previewHiddenIds).toEqual(before.previewHiddenIds);
    expect(after.includedIds).toEqual(before.includedIds);
    expect(after.entries).toEqual(before.entries);
  });

  // --- 색 경계선 수동 지정 (edgeColourIds, task-8b) ---

  test("EMPTY_OPS carries an empty designation set", () => {
    expect(EMPTY_OPS.edgeColourIds).toEqual([]);
  });

  test("a freshly opened tree starts with nothing designated", () => {
    expect(opened().opsByPath["/a.psd"].edgeColourIds).toEqual([]);
  });

  test("setEdgeColour designates a batch and clears it again", () => {
    const s0 = opened();
    const on = appReducer(s0, { type: "setEdgeColour", path: "/a.psd", layerIds: [1, 5], on: true });
    expect(on.opsByPath["/a.psd"].edgeColourIds).toEqual([1, 5]);
    const off = appReducer(on, { type: "setEdgeColour", path: "/a.psd", layerIds: [1, 5], on: false });
    expect(off.opsByPath["/a.psd"].edgeColourIds).toEqual([]);
  });

  // 설계의 핵심 보장 — 체크박스를 재사용하지 않는다는 결정이 실제로 지켜지는지.
  test("designating a layer never changes the export checkbox set, and vice versa", () => {
    const s0 = opened();
    const designated = appReducer(s0, { type: "setEdgeColour", path: "/a.psd", layerIds: [1], on: true });
    expect(designated.opsByPath["/a.psd"].includedIds).toEqual(s0.opsByPath["/a.psd"].includedIds);

    const unchecked = appReducer(s0, { type: "setIncluded", path: "/a.psd", includedIds: [5] });
    expect(unchecked.opsByPath["/a.psd"].edgeColourIds).toEqual(s0.opsByPath["/a.psd"].edgeColourIds);
  });

  // applyPresetResult는 includedIds/ops/entries를 엔진 결과로 갈아끼우지만,
  // 지정은 그 프리셋과 무관한 "이 파일의 사실"이므로 previewHiddenIds/soloIds와
  // 같은 이유로 그대로 넘어가야 한다.
  test("applyPresetResult carries the designation over unchanged", () => {
    const s0 = opened();
    const designated = appReducer(s0, { type: "setEdgeColour", path: "/a.psd", layerIds: [1, 5], on: true });
    const s = appReducer(designated, {
      type: "applyPresetResult",
      path: "/a.psd",
      matchedLayerIds: [1, 5],
      operations: [{ op: "merge", layerIds: [1, 5], name: "M" }],
    });
    expect(s.opsByPath["/a.psd"].edgeColourIds).toEqual([1, 5]);
  });

  // 지정은 파일마다 다른 사실이다. 새로 연 파일에 이전 파일의 지정이 새면
  // 엉뚱한 레이어에 획이 붙는다.
  test("reopening the file (a fresh openSuccess) does not carry the designation over", () => {
    const designated = appReducer(opened(), { type: "setEdgeColour", path: "/a.psd", layerIds: [1], on: true });
    const reopened = appReducer(designated, {
      type: "openSuccess",
      path: "/a.psd",
      result: { sessionId: 2, width: 1, height: 1, colorMode: "RGB", depth: 8, tree },
    });
    expect(reopened.opsByPath["/a.psd"].edgeColourIds).toEqual([]);
  });
});

// 파일을 열면 App.tsx가 선택된 프리셋을 자동으로 적용한다. 그 효과는 오직
// presetApplied === false 일 때만 도므로, 이 플래그가 언제 서고 언제 풀리는지가
// "자동 적용이 사람이 해둔 편집을 덮지 않는다"는 보장 그 자체다.
describe("presetApplied (자동 적용 래치)", () => {
  function opened(sessionId = 1): AppState {
    const s = appReducer(initial, { type: "addFiles", paths: ["/a.psd"] });
    return appReducer(s, {
      type: "openSuccess",
      path: "/a.psd",
      result: { sessionId, width: 1, height: 1, colorMode: "RGB", depth: 8, tree },
    });
  }

  test("openSuccess arms it — a freshly opened file gets the preset applied", () => {
    expect(opened().files[0].presetApplied).toBe(false);
  });

  test("presetApplyStarted latches before the engine answers, so a failure cannot loop", () => {
    const s = appReducer(opened(), { type: "presetApplyStarted", path: "/a.psd" });
    expect(s.files[0].presetApplied).toBe(true);
  });

  test("applyPresetResult latches too — a manual 적용 pre-empts the auto one", () => {
    const s = appReducer(opened(), {
      type: "applyPresetResult",
      path: "/a.psd",
      matchedLayerIds: [1],
      operations: [],
    });
    expect(s.files[0].presetApplied).toBe(true);
  });

  test("sessionRefreshed leaves it latched — an evicted-session reopen must not re-apply over edits", () => {
    const applied = appReducer(opened(1), { type: "presetApplyStarted", path: "/a.psd" });
    const s = appReducer(applied, {
      type: "sessionRefreshed",
      path: "/a.psd",
      result: { sessionId: 99, width: 1, height: 1, colorMode: "RGB", depth: 8, tree },
    });
    expect(s.files[0]).toMatchObject({ sessionId: 99, presetApplied: true });
  });

  test("engineRestarted clears it — every file reopens from scratch, so it re-applies", () => {
    const applied = appReducer(opened(), { type: "presetApplyStarted", path: "/a.psd" });
    const s = appReducer(applied, { type: "engineRestarted" });
    expect(s.files[0].presetApplied).toBeUndefined();
  });

  test("it is per file, so opening a second file does not disarm the first", () => {
    let s = appReducer(initial, { type: "addFiles", paths: ["/a.psd", "/b.psd"] });
    s = appReducer(s, {
      type: "openSuccess",
      path: "/a.psd",
      result: { sessionId: 1, width: 1, height: 1, colorMode: "RGB", depth: 8, tree },
    });
    s = appReducer(s, { type: "presetApplyStarted", path: "/a.psd" });
    s = appReducer(s, {
      type: "openSuccess",
      path: "/b.psd",
      result: { sessionId: 2, width: 1, height: 1, colorMode: "RGB", depth: 8, tree },
    });
    expect(s.files.map((f) => f.presetApplied)).toEqual([true, false]);
  });
});

// "적용"의 "기존 편집 내용을 대체합니다" 확인창이 이 플래그로 뜬다. ops가 비어
// 있는지로 보지 않는 이유가 핵심이다: 프리셋 적용 자체가 ops를 만들기 때문에,
// 자동 적용이 들어간 뒤로는 파일을 열기만 해도 ops가 차 있다.
describe("edited (수동 편집 표시)", () => {
  function opened(): AppState {
    const s = appReducer(initial, { type: "addFiles", paths: ["/a.psd"] });
    return appReducer(s, {
      type: "openSuccess",
      path: "/a.psd",
      result: { sessionId: 1, width: 1, height: 1, colorMode: "RGB", depth: 8, tree },
    });
  }

  test("a freshly opened file counts as untouched", () => {
    expect(opened().files[0].edited).toBe(false);
  });

  test("an auto-applied preset leaves the file untouched even though it filled ops", () => {
    const s = appReducer(opened(), {
      type: "applyPresetResult",
      path: "/a.psd",
      matchedLayerIds: [1, 5],
      operations: [{ op: "merge", layerIds: [1, 5], name: "M" }],
    });
    // 이것이 회귀 방지의 요점: ops는 찼지만 지울 사람의 편집은 없다.
    expect(s.opsByPath["/a.psd"].ops).toHaveLength(1);
    expect(s.files[0].edited).toBe(false);
  });

  test("pushOp marks it", () => {
    const s = appReducer(opened(), { type: "pushOp", path: "/a.psd", op: { op: "merge", layerIds: [1, 2], name: "M" } });
    expect(s.files[0].edited).toBe(true);
  });

  test("setIncluded marks it", () => {
    const s = appReducer(opened(), { type: "setIncluded", path: "/a.psd", includedIds: [1] });
    expect(s.files[0].edited).toBe(true);
  });

  test("undoOp marks it — undoing a preset's merge is a human decision too", () => {
    const applied = appReducer(opened(), {
      type: "applyPresetResult",
      path: "/a.psd",
      matchedLayerIds: [1, 5],
      operations: [{ op: "merge", layerIds: [1, 5], name: "M" }],
    });
    const s = appReducer(applied, { type: "undoOp", path: "/a.psd" });
    expect(s.files[0].edited).toBe(true);
  });

  test("an edit that failed does not mark it — nothing changed, so nothing needs protecting", () => {
    // exclude는 buildEntries가 받지 않는 op라 여기서 예외가 난다(opsReducer).
    const s = appReducer(opened(), { type: "pushOp", path: "/a.psd", op: { op: "exclude", layerIds: [1] } });
    expect(s.errors).toHaveLength(1);
    expect(s.files[0].edited).toBe(false);
    expect(s.opsByPath["/a.psd"].ops).toEqual([]);
  });

  test("an op that matches nothing still marks it — it is in the history and a re-apply would drop it", () => {
    const s = appReducer(opened(), { type: "pushOp", path: "/a.psd", op: { op: "rename", layerId: 999, name: "x" } });
    expect(s.opsByPath["/a.psd"].ops).toHaveLength(1);
    expect(s.files[0].edited).toBe(true);
  });

  test("re-applying a preset clears it — the edits are gone, so nothing is left to protect", () => {
    const edited = appReducer(opened(), {
      type: "pushOp",
      path: "/a.psd",
      op: { op: "merge", layerIds: [1, 2], name: "M" },
    });
    const s = appReducer(edited, {
      type: "applyPresetResult",
      path: "/a.psd",
      matchedLayerIds: [1],
      operations: [],
    });
    expect(s.files[0].edited).toBe(false);
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
    s = appReducer(s, { type: "openStart", path: "/a.psd", activate: true });
    s = appReducer(s, {
      type: "openSuccess",
      path: "/a.psd",
      result: { sessionId: 1, width: 1, height: 1, colorMode: "RGB", depth: 8, tree },
    });
    s = appReducer(s, { type: "openStart", path: "/b.psd", activate: true });
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

  test("resets activePath and drops the removed file's matched ids when it was active", () => {
    const s0 = twoFilesOpened(); // activePath is /b.psd after the second openSuccess
    const withMatched: AppState = { ...s0, matchedIdsByPath: { "/a.psd": [1], "/b.psd": [2] } };
    const s = appReducer(withMatched, { type: "removeFile", path: "/b.psd" });
    expect(s.activePath).toBeNull();
    expect(s.matchedIdsByPath).not.toHaveProperty("/b.psd");
    // 남은 파일의 매칭 결과는 그대로다 — 지우는 것은 뺀 파일 것뿐이다.
    expect(s.matchedIdsByPath["/a.psd"]).toEqual([1]);
  });

  test("leaves activePath and the active file's matched ids untouched when removing another file", () => {
    const s0 = twoFilesOpened(); // activePath is /b.psd
    const withMatched: AppState = { ...s0, matchedIdsByPath: { "/a.psd": [1], "/b.psd": [2] } };
    const s = appReducer(withMatched, { type: "removeFile", path: "/a.psd" });
    expect(s.activePath).toBe("/b.psd");
    expect(s.matchedIdsByPath).not.toHaveProperty("/a.psd");
    expect(s.matchedIdsByPath["/b.psd"]).toEqual([2]);
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
    s = { ...s, matchedIdsByPath: { "/a.psd": [1] } };

    const restarted = appReducer(s, { type: "engineRestarted" });

    expect(restarted.files).toEqual([
      { path: "/a.psd", status: "idle" },
      { path: "/b.psd", status: "idle" },
    ]);
    expect(restarted.activePath).toBeNull();
    expect(restarted.matchedIdsByPath).toEqual({});
  });
});

// 폴더를 갈아끼우기 위한 것이다. `+ 폴더`는 기존 목록에 덧붙이므로, 폴더 2만
// 보려면 먼저 비울 수 있어야 한다.
describe("clearFiles", () => {
  test("empties the list and everything keyed by it", () => {
    let s = appReducer(initial, { type: "addFiles", paths: ["/a.psd", "/b.psd"] });
    s = appReducer(s, {
      type: "openSuccess",
      path: "/a.psd",
      result: { sessionId: 1, width: 1, height: 1, colorMode: "RGB", depth: 8, tree },
    });
    s = { ...s, matchedIdsByPath: { "/a.psd": [1] } };

    const cleared = appReducer(s, { type: "clearFiles" });

    expect(cleared.files).toEqual([]);
    expect(cleared.activePath).toBeNull();
    expect(cleared.opsByPath).toEqual({});
    expect(cleared.matchedIdsByPath).toEqual({});
  });

  test("clears the error cards too — they were all about the list being emptied", () => {
    // 카드에 달린 파일 버튼이 사라진 파일을 가리키면 눌러도 아무 데도 못 간다.
    let s = appReducer(initial, { type: "addFiles", paths: ["/a.psd"] });
    s = appReducer(s, {
      type: "pushError",
      title: "라인이 하나도 안 나온 자리 1곳",
      error: { message: "a.psd", traceback: "" },
      files: ["/a.psd"],
    });
    expect(s.errors).toHaveLength(1);

    expect(appReducer(s, { type: "clearFiles" }).errors).toEqual([]);
  });
});

describe("openFileEffect (async orchestration against the mocked engine)", () => {
  test("dispatches openStart then openSuccess on success", async () => {
    mockOpenPsd.mockResolvedValue({ sessionId: 9, width: 1, height: 1, colorMode: "RGB", depth: 8, tree: [] });
    const actions: AppAction[] = [];
    await openFileEffect((a) => actions.push(a), "/a.psd");
    expect(actions[0]).toEqual({ type: "openStart", path: "/a.psd", activate: true });
    expect(actions[1].type).toBe("openSuccess");
  });

  test("dispatches openStart then openError with full traceback on engine failure", async () => {
    mockOpenPsd.mockRejectedValue(new EngineRpcError({ message: "boom", traceback: "Traceback ..." }));
    const actions: AppAction[] = [];
    await openFileEffect((a) => actions.push(a), "/a.psd");
    expect(actions[0]).toEqual({ type: "openStart", path: "/a.psd", activate: true });
    expect(actions[1]).toEqual({
      type: "openError",
      path: "/a.psd",
      error: { message: "boom", traceback: "Traceback ..." },
      // 클릭 한 번에 대한 응답이므로 그 자리에서 카드가 떠야 한다.
      quiet: false,
    });
  });

  // 폴더를 한꺼번에 불러올 때는 파일마다 카드가 뜨면 패널이 덮인다. collect를 준
  // 쪽(로드 큐)은 실패를 모아 끝에 한 장으로 내므로, 여기서는 조용히 지나간다.
  test("with collect, the failure is handed back instead of raising its own card", async () => {
    mockOpenPsd.mockRejectedValue(new EngineRpcError({ message: "boom", traceback: "T" }));
    const actions: AppAction[] = [];
    const collected: Array<[string, string]> = [];

    await openFileEffect((a) => actions.push(a), "/a.psd", {
      collect: (path, error) => collected.push([path, error.message]),
    });

    expect(actions[1]).toMatchObject({ type: "openError", path: "/a.psd", quiet: true });
    expect(collected).toEqual([["/a.psd", "boom"]]);
  });
});

describe("openFileEffect background mode (로드 큐가 쓰는 경로)", () => {
  test("does not steal the active file, and hands back the session so the preset can follow", async () => {
    const result = { sessionId: 7, width: 1, height: 1, colorMode: "RGB", depth: 8, tree: [] };
    mockOpenPsd.mockResolvedValue(result);
    const actions: AppAction[] = [];

    const returned = await openFileEffect((a) => actions.push(a), "/a.psd", { activate: false });

    expect(actions[0]).toEqual({ type: "openStart", path: "/a.psd", activate: false });
    // 세션 id 없이는 큐가 프리셋을 이어 붙일 수 없다.
    expect(returned).toEqual(result);
  });

  test("returns null when the open failed, so the caller skips the preset step", async () => {
    mockOpenPsd.mockRejectedValue(new EngineRpcError({ message: "boom", traceback: "" }));
    const actions: AppAction[] = [];
    await expect(openFileEffect((a) => actions.push(a), "/a.psd", { activate: false })).resolves.toBeNull();
    expect(actions[1].type).toBe("openError");
  });
});

describe("applyPresetEffect (자동 적용의 실제 동작)", () => {
  test("latches before calling the engine, then lands the match on that path", async () => {
    mockApplyPreset.mockResolvedValue({ matchedLayerIds: [1, 5], operations: [] });
    const actions: AppAction[] = [];

    await applyPresetEffect((a) => actions.push(a), "/a.psd", 3, preset);

    // 순서가 핵심이다: 래치가 엔진 호출보다 먼저 서야 재진입이 막힌다.
    expect(actions[0]).toEqual({ type: "presetApplyStarted", path: "/a.psd" });
    expect(mockApplyPreset).toHaveBeenCalledWith(3, preset);
    expect(actions[1]).toEqual({
      type: "applyPresetResult",
      path: "/a.psd",
      matchedLayerIds: [1, 5],
      operations: [],
    });
  });

  test("a text note that matched is dropped without a word — that exclusion is the rule itself", async () => {
    mockApplyPreset.mockResolvedValue({
      matchedLayerIds: [1],
      operations: [],
      skippedLayers: [{ id: 9, path: "*ART/BG/NOTE FOR LINE: repaint", kind: "type", reason: "text" }],
    });
    const actions: AppAction[] = [];

    const undrawable = await applyPresetEffect((a) => actions.push(a), "/a.psd", 3, preset);

    expect(undrawable).toEqual([]);
    expect(actions.some((a) => a.type === "pushError")).toBe(false);
  });

  // 알림을 여기서 띄우지 않고 돌려주는 이유: 한꺼번에 불러올 때 파일마다 카드를
  // 내면 화면이 카드로 덮여 진짜 오류가 묻힌다. 부르는 쪽이 모아서 낸다.
  test("art that matched but had no pixels is handed back, so the caller decides when to say it", async () => {
    mockApplyPreset.mockResolvedValue({
      matchedLayerIds: [1],
      operations: [],
      skippedLayers: [
        { id: 9, path: "LayOut/BG/line curves", kind: "curves", reason: "noPixels" },
        { id: 8, path: "*ART/NOTE FOR LINE: x", kind: "type", reason: "text" },
      ],
    });
    const actions: AppAction[] = [];

    const undrawable = await applyPresetEffect((a) => actions.push(a), "/a.psd", 3, preset);

    expect(undrawable).toEqual([{ id: 9, path: "LayOut/BG/line curves", kind: "curves", reason: "noPixels" }]);
    expect(actions.some((a) => a.type === "pushError")).toBe(false);
    // 매칭 결과 자체는 그대로 반영된다 — 빠진 레이어가 적용을 막지 않는다.
    expect(actions.some((a) => a.type === "applyPresetResult")).toBe(true);
  });

  // 규칙으로 뺀 것은 이상 징후가 아니다. 실파일 25개 기준 95장이 여기 얹히면
  // 이 카드가 경고하려던 진짜 오류(그릴 픽셀이 없는 레이어)가 묻힌다.
  test("layers dropped on purpose by a rule do not raise the card", async () => {
    mockApplyPreset.mockResolvedValue({
      matchedLayerIds: [1],
      operations: [],
      skippedLayers: [
        { id: 2, path: "*ART/Layer 866 (LINEAR DODGE)", kind: "pixel", reason: "notLineWord" },
        { id: 3, path: "*ART/lines/fill", kind: "pixel", reason: "groupHasOwnLine" },
        { id: 4, path: "*ART/line col", kind: "pixel", reason: "excludedToken" },
        { id: 5, path: "*ART/LINE WIN", kind: "pixel", reason: "blendMode" },
        { id: 9, path: "LayOut/BG/line curves", kind: "curves", reason: "noPixels" },
      ],
    });
    const actions: AppAction[] = [];

    const undrawable = await applyPresetEffect((a) => actions.push(a), "/a.psd", 3, preset);

    expect(undrawable).toEqual([
      { id: 9, path: "LayOut/BG/line curves", kind: "curves", reason: "noPixels" },
    ]);
    expect(actions.some((a) => a.type === "pushError")).toBe(false);
  });

  test("a failed apply hands back nothing rather than a stale list", async () => {
    mockApplyPreset.mockRejectedValue(new EngineRpcError({ message: "boom", traceback: "" }));
    await expect(applyPresetEffect(() => {}, "/a.psd", 3, preset)).resolves.toEqual([]);
  });

  test("a failure is reported with the file name and leaves the latch standing", async () => {
    mockApplyPreset.mockRejectedValue(new EngineRpcError({ message: "boom", traceback: "Traceback ..." }));
    const actions: AppAction[] = [];

    await applyPresetEffect((a) => actions.push(a), "/a.psd", 3, preset);

    expect(actions[0]).toEqual({ type: "presetApplyStarted", path: "/a.psd" });
    expect(actions[1]).toEqual({
      type: "pushError",
      title: "프리셋 자동 적용 실패: /a.psd",
      error: { message: "boom", traceback: "Traceback ..." },
    });
    // applyPresetResult가 없으므로 래치를 푸는 것도 없다 — 재시도는 사람이 "적용"으로.
    expect(actions.some((a) => a.type === "applyPresetResult")).toBe(false);
  });

  test("an evicted session is reopened transparently and the match still lands", async () => {
    mockApplyPreset
      .mockRejectedValueOnce(new EngineRpcError({ message: "'unknown or evicted session: 3'", traceback: "" }))
      .mockResolvedValueOnce({ matchedLayerIds: [2], operations: [] });
    const reopened = { sessionId: 9, width: 1, height: 1, colorMode: "RGB", depth: 8, tree: [] };
    mockOpenPsd.mockResolvedValue(reopened);
    const actions: AppAction[] = [];

    await applyPresetEffect((a) => actions.push(a), "/a.psd", 3, preset);

    expect(actions[1]).toEqual({ type: "sessionRefreshed", path: "/a.psd", result: reopened });
    expect(mockApplyPreset).toHaveBeenLastCalledWith(9, preset);
    expect(actions[2]).toMatchObject({ type: "applyPresetResult", matchedLayerIds: [2] });
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

// 프로젝트 파일 복원(Task 4). 저장해둔 작업을 스토어에 되살리는 것과, 배경 로드
// 큐가 그 파일을 열 때 openSuccess가 그걸 초기 상태로 덮지 않는 것을 함께 본다 —
// 이 파일에서 제일 조용히 망가지는 자리다.
describe("restoreProject", () => {
  const RESTORED_OPS = {
    includedIds: [1, 2], previewHiddenIds: [2], soloIds: [], edgeColourIds: [],
    manualLineIds: [2], ops: [], entries: [],
  };
  const RESTORED_TREE = [{
    id: 1, name: "line", kind: "pixel", visible: true, opacity: 255, blendMode: "normal",
    bbox: [0, 0, 4, 4], hasMask: false, hasPixels: true, path: ["line"],
  }];

  function restored() {
    return appReducer(initialAppState, {
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
    const s = appReducer(restored(), {
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

  // matchedIdsByPath에도 같은 보장이 있어야 한다 — 이걸 지우면 미리보기 캐시
  // 키가 달라져 복원해둔 미리보기를 전부 다시 그린다(설계 7절), 기능의 요점이
  // 무너진다.
  test("opening a restored file in the background keeps the restored match results", () => {
    const s = appReducer(restored(), {
      type: "openSuccess",
      path: "/cuts/a.psd",
      result: {
        sessionId: 7, width: 4, height: 4, colorMode: "RGB", depth: 8,
        tree: RESTORED_TREE, mtime: 1700,
      },
    } as never);

    expect(s.matchedIdsByPath["/cuts/a.psd"]).toEqual([1]);
  });

  // 파일이 그 사이 바뀌었으면 복원본을 붙들면 안 된다 — id가 밀렸다.
  test("opening a restored file whose mtime moved resets the work", () => {
    const s = appReducer(restored(), {
      type: "openSuccess",
      path: "/cuts/a.psd",
      result: {
        sessionId: 7, width: 4, height: 4, colorMode: "RGB", depth: 8,
        tree: RESTORED_TREE, mtime: 1899,
      },
    } as never);

    expect(s.opsByPath["/cuts/a.psd"].manualLineIds).toEqual([]);
  });
});
