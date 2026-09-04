import { beforeEach, describe, expect, test, vi } from "vitest";

// vi.mock factories are hoisted; only "mock"-prefixed outer vars are reachable inside them.
const mockOpenPsd = vi.fn();
const mockCloseSession = vi.fn();
const mockApplyPreset = vi.fn();
const mockMeasureLeafStrokes = vi.fn();
vi.mock("../lib/engine", async () => {
  const actual = await vi.importActual<typeof import("../lib/engine")>("../lib/engine");
  return {
    ...actual,
    openPsd: (...a: unknown[]) => mockOpenPsd(...a),
    closeSession: (...a: unknown[]) => mockCloseSession(...a),
    applyPreset: (...a: unknown[]) => mockApplyPreset(...a),
    measureLeafStrokes: (...a: unknown[]) => mockMeasureLeafStrokes(...a),
  };
});

import { EngineRpcError } from "../lib/engine";
import { parseProject } from "../lib/project";
import type { Preset, TreeNode } from "../lib/types";
import {
  appReducer,
  applyPresetEffect,
  detectDrawnLinesEffect,
  queueDetectDrawnLines,
  frontloadDetection,
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
  files: [], activePath: null, opsByPath: {}, matchedIdsByPath: {}, drawnLineIdsByPath: {}, strokeFeaturesByPath: {},
  errors: [], restoredMtimeByPath: {},
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

  // 프리셋 적용은 **포함 목록**을 매칭 결과로 바꾼다. 손으로 한 병합·이름변경은
  // 그대로 둔다(2026-08-11, 아티스트가 정했다). 예전에는 ops를 통째로 갈아치웠는데,
  // 실제로 쓰는 프리셋은 전부 merge:"none"이라 엔진이 빈 배열을 준다 — 없애기만 하고
  // 대신 넣어주는 것이 없는 거래였다.
  test("applyPresetResult takes the match as the inclusion list but keeps the merges the artist made", () => {
    const merged = appReducer(opened(), {
      type: "pushOp", path: "/a.psd", op: { op: "merge", layerIds: [1, 2], name: "M" },
    });

    const s = appReducer(merged, {
      type: "applyPresetResult", path: "/a.psd", matchedLayerIds: [5, 1, 2], operations: [],
    });

    expect(s.matchedIdsByPath["/a.psd"]).toEqual([5, 1, 2]);
    expect(s.opsByPath["/a.psd"].includedIds).toEqual([1, 2, 5]);
    expect(s.opsByPath["/a.psd"].ops).toEqual([{ op: "merge", layerIds: [1, 2], name: "M" }]);
    // entries는 (includedIds, ops)로 다시 만들어진다 — 병합 하나 + 남은 잎 하나.
    const entries = s.opsByPath["/a.psd"].entries;
    expect(entries).toHaveLength(2);
    expect(entries.some((e) => e.sourceIds.join(",") === "1,2")).toBe(true);
    expect(s.opsByPath["/a.psd"].previewHiddenIds).toEqual(merged.opsByPath["/a.psd"].previewHiddenIds);
    expect(s.errors).toHaveLength(0);
  });

  // merge가 "none"이 아닌 프리셋을 골라도 화면의 병합을 밀어내지 않는다.
  // (대가: 그런 프리셋의 자동 병합은 화면에 안 걸린다. 배치는 엔진에서 따로
  // 계산하므로 그때는 화면과 배치가 갈린다 — appStore.tsx의 주석 참고.)
  test("applyPresetResult does not let the preset's own operations replace the artist's", () => {
    const merged = appReducer(opened(), {
      type: "pushOp", path: "/a.psd", op: { op: "merge", layerIds: [1, 2], name: "M" },
    });

    const s = appReducer(merged, {
      type: "applyPresetResult", path: "/a.psd", matchedLayerIds: [1, 2, 5],
      operations: [{ op: "merge", layerIds: [1, 5], name: "PRESET" }],
    });

    expect(s.opsByPath["/a.psd"].ops).toEqual([{ op: "merge", layerIds: [1, 2], name: "M" }]);
    expect(s.errors).toHaveLength(0);
  });

  // 매칭이 좁아지면 병합에 쓰인 레이어가 포함에서 빠질 수 있다. buildEntries가
  // 남은 것으로 재생해야 하고, 던져서 "프리셋 적용 실패"가 되면 안 된다.
  test("applyPresetResult regenerates a merge whose layer fell out of the match", () => {
    const merged = appReducer(opened(), {
      type: "pushOp", path: "/a.psd", op: { op: "merge", layerIds: [1, 2], name: "M" },
    });

    const s = appReducer(merged, {
      type: "applyPresetResult", path: "/a.psd", matchedLayerIds: [1], operations: [],
    });

    expect(s.errors).toHaveLength(0);
    expect(s.opsByPath["/a.psd"].includedIds).toEqual([1]);
    expect(s.opsByPath["/a.psd"].entries.flatMap((e) => e.sourceIds)).toEqual([1]);
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

// "적용"의 "포함 목록을 프리셋 결과로 대체합니다" 확인창이 이 플래그로 뜬다. ops가 비어
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
    // 이것이 회귀 방지의 요점: 자동 적용은 사람의 편집이 아니다. 그리고 이제
    // 프리셋의 작업은 ops에 들어가지도 않는다 — 손으로 한 것만 거기 남는다.
    expect(s.opsByPath["/a.psd"].ops).toEqual([]);
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

  test("undoOp marks it — taking a merge back is a human decision too", () => {
    const merged = appReducer(opened(), {
      type: "pushOp", path: "/a.psd", op: { op: "merge", layerIds: [1, 5], name: "M" },
    });
    const s = appReducer(merged, { type: "undoOp", path: "/a.psd" });
    expect(s.opsByPath["/a.psd"].ops).toEqual([]);
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

  // 2026-08-11에 뒤집힌 규칙이다. 적용이 손 병합을 지키게 된 뒤로는, 적용했다고
  // 해서 지킬 것이 없어지지 않는다 — 병합은 그대로 남아 있고 다음 "적용"이
  // 체크박스 선택을 또 대체하므로 확인창은 계속 떠야 한다.
  test("re-applying a preset does not clear it — the merges survived, so there is still something to protect", () => {
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
    expect(s.opsByPath["/a.psd"].ops).toHaveLength(1);
    expect(s.files[0].edited).toBe(true);
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

  // opsByPath/matchedIdsByPath와 같은 자리에 있는 세 번째 칸이다. 여기서 안 지우면
  // 같은 경로를 나중에 다시 추가해 새 세션을 열었을 때, 그 mtime이 옛 기록과 같을
  // 경우 openSuccess가 이번 세션과 무관한 옛 작업/매칭을 그대로 붙들 수 있다.
  test("drops the restored mtime record too", () => {
    const s0 = twoFilesOpened();
    const withRestored: AppState = { ...s0, restoredMtimeByPath: { "/a.psd": 1700, "/b.psd": 1800 } };
    const s = appReducer(withRestored, { type: "removeFile", path: "/a.psd" });
    expect(s.restoredMtimeByPath).not.toHaveProperty("/a.psd");
    // 남은 파일 것은 그대로다 — 지우는 것은 뺀 파일 것뿐이다.
    expect(s.restoredMtimeByPath["/b.psd"]).toBe(1800);
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

  // 복원한 파일만은 예외다. 엔진이 죽어도 디스크의 PSD는 그대로라 저장해둔 id가
  // 여전히 유효하고, 여기서 버리면 되돌아올 길이 없다 — 로드 큐도 그물 효과도
  // 복원본에는 자동 적용을 걸지 않으므로 matchedIds를 다시 채울 applyPresetResult가
  // 영영 오지 않는다. matchedIds는 내보내기 인자이므로 비면 색 통일이 매칭된
  // 라인이 아니라 포함된 레이어 전부에 걸린다.
  //
  // 두 번째 단언이 요점이다. 그것이 없으면 "복원 여부를 안 보고 그냥 전부
  // 지킨다"로 바꿔도 이 테스트가 통과해, 옛 세션의 id가 새 세션에 남는다.
  test("keeps a restored file's matches and still drops a plain file's", () => {
    let s = appReducer(initial, {
      type: "restoreProject",
      entries: [{
        path: "/restored.psd", mtime: 1700, tree, matchedIds: [1],
        ops: buildInitialOpsState(tree), previewKey: null, previewFile: null,
      }],
    } as never);
    s = appReducer(s, { type: "addFiles", paths: ["/plain.psd"] });
    s = { ...s, matchedIdsByPath: { ...s.matchedIdsByPath, "/plain.psd": [4, 5] } };

    const restarted = appReducer(s, { type: "engineRestarted" });

    expect(restarted.matchedIdsByPath["/restored.psd"]).toEqual([1]);
    expect(restarted.matchedIdsByPath).not.toHaveProperty("/plain.psd");
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

  // 저장할 때 프리셋이 걸린 적 없던 파일은 matchedIds가 null로 적힌다. 그것을
  // []로 되살리면 그 파일의 색 통일 대상이 "전부"에서 "아무 데도 안"으로 뒤집히고
  // (엔진은 없는 목록을 "전부 해당"으로 읽는다), 되돌릴 길이 없다 — 복원본에는
  // 자동 적용이 걸리지 않아 matchedIds를 다시 채울 applyPresetResult가 안 온다.
  test("restoring an entry that never had a preset leaves its match list unset, not empty", () => {
    const s = appReducer(initialAppState, {
      type: "restoreProject",
      entries: [{
        path: "/cuts/a.psd", mtime: 1700, tree: RESTORED_TREE as never, matchedIds: null,
        ops: RESTORED_OPS as never, previewKey: "k", previewFile: "a.png",
      }],
    } as never);

    expect(s.matchedIdsByPath).not.toHaveProperty("/cuts/a.psd");
    // 작업 자체는 살아 있어야 한다 — 버리는 것은 "없다"는 사실뿐이다.
    expect(s.opsByPath["/cuts/a.psd"].manualLineIds).toEqual([2]);
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
    // 매칭 결과도 같이 버려야 한다. 이 검증 게이트가 engineRestarted가 복원
    // 경로의 matchedIdsByPath를 붙드는 근거이므로(appStore.tsx의 그 주석),
    // 여기가 무르면 바뀐 PSD의 옛 id가 되살아나 영영 남는다 — 그리고
    // matchedIds는 표시용이 아니라 내보내기 인자다(ExportDialog → render.py).
    expect(s.matchedIdsByPath).not.toHaveProperty("/cuts/a.psd");
  });

  // 복원본은 status가 "idle"이라 **파일 준비 큐의 대상이기도 하다**(App.tsx의
  // prepareWillTake는 복원 여부를 안 본다, 작업 프로세스 2 이상이 기본값).
  // openSuccess와 같은 보장이 여기에도 있어야 한다 — 없으면 프로젝트를 여는 것만으로
  // 지정·병합·눈이 "갓 적용" 상태로 조용히 갈아치워진다.
  test("preparing a restored file in the background keeps the restored work", () => {
    const s = appReducer(restored(), {
      type: "preparedFile",
      path: "/cuts/a.psd",
      result: {
        tree: RESTORED_TREE, mtime: 1700, width: 4, height: 4,
        matchedLayerIds: [1], pngPath: null,
      },
    } as never);

    expect(s.opsByPath["/cuts/a.psd"].manualLineIds).toEqual([2]);
    expect(s.opsByPath["/cuts/a.psd"].includedIds).toEqual([1, 2]);
    expect(s.matchedIdsByPath["/cuts/a.psd"]).toEqual([1]);
  });

  // 반대쪽 — 파일이 바뀌었으면 복원본을 붙들면 안 된다(openSuccess와 같은 게이트).
  test("preparing a restored file whose mtime moved starts from the fresh match", () => {
    const s = appReducer(restored(), {
      type: "preparedFile",
      path: "/cuts/a.psd",
      result: {
        tree: RESTORED_TREE, mtime: 1899, width: 4, height: 4,
        matchedLayerIds: [1], pngPath: null,
      },
    } as never);

    expect(s.opsByPath["/cuts/a.psd"].manualLineIds).toEqual([]);
    expect(s.opsByPath["/cuts/a.psd"].includedIds).toEqual([1]);
  });

  // presetApplied가 정직해야 로드 큐가 자동 적용을 다시 걸지 않는다(App.tsx의
  // 로드 큐 주석 참고) — 복원한 ops는 이전 세션에서 이미 프리셋을 거친 결과이므로,
  // false로 남으면 큐가 그 위에 새 매칭을 덮어써 체크박스·병합 편집이 사라진다.
  test("opening a restored file whose mtime matches marks presetApplied — the restored ops already came from a preset", () => {
    const s = appReducer(restored(), {
      type: "openSuccess",
      path: "/cuts/a.psd",
      result: {
        sessionId: 7, width: 4, height: 4, colorMode: "RGB", depth: 8,
        tree: RESTORED_TREE, mtime: 1700,
      },
    } as never);

    expect(s.files[0].presetApplied).toBe(true);
  });

  // 아티스트가 명시한 요구는 "되살리는 것은 화면 그대로 전부 — 눈·solo까지"다.
  // OpsState는 일곱 필드이고, 어느 하나가 왕복에서 떨어져도 앱은 아무 말 없이
  // 그 만큼 덜 되살린다. 지금까지 잠긴 것은 includedIds·manualLineIds·entries
  // 셋뿐이었고 previewHiddenIds(눈)·soloIds(solo)·edgeColourIds·ops(병합·
  // 이름변경·순서변경)는 떨어뜨려도 전부 초록불이었다.
  //
  // 디스크에 적히는 모양 그대로 왕복시킨다(JSON → parseProject → restoreProject).
  // 필드가 빠질 수 있는 자리가 리듀서 말고 직렬화 경계에도 있기 때문이다.
  test("a saved project brings back all seven fields of the work, not just the three that were locked", () => {
    const ops = {
      includedIds: [1, 2, 3],
      previewHiddenIds: [2],
      soloIds: [3],
      edgeColourIds: [1],
      manualLineIds: [2, 3],
      ops: [{ op: "rename", layerId: 1, name: "LINE" }],
      entries: [{ entryId: 1, sourceIds: [1], name: "LINE" }],
    };
    const onDisk = JSON.stringify({
      version: 1,
      preset: null,
      files: [{
        path: "/cuts/a.psd", mtime: 1700, tree: RESTORED_TREE, matchedIds: [1],
        ops, previewKey: "k", previewFile: "a.png",
      }],
    });

    const s = appReducer(initialAppState, {
      type: "restoreProject",
      entries: parseProject(onDisk).files,
    });

    expect(s.opsByPath["/cuts/a.psd"]).toEqual(ops);
  });

  // []는 "프리셋을 걸었는데 한 장도 안 걸렸다"이다 — null("건 적이 없다")과
  // 다른 사실이고, 버리면 그 파일의 색 통일이 매칭된 라인이 아니라 **포함된
  // 전부**에 걸린다(엔진은 목록이 없으면 "전부 해당"으로 읽는다: render.py).
  // 위의 테스트가 null 쪽을 잠갔고, 여기가 그 반대 방향이다.
  test("restoring an entry whose preset matched nothing keeps the empty list, not no list", () => {
    const s = appReducer(initialAppState, {
      type: "restoreProject",
      entries: [{
        path: "/cuts/a.psd", mtime: 1700, tree: RESTORED_TREE as never, matchedIds: [],
        ops: RESTORED_OPS as never, previewKey: "k", previewFile: "a.png",
      }],
    } as never);

    expect(s.matchedIdsByPath).toHaveProperty("/cuts/a.psd");
    expect(s.matchedIdsByPath["/cuts/a.psd"]).toEqual([]);
  });

  // 엔진 재시작도 같은 방향으로 무를 수 있는 자리다. 복원 경로의 matchedIds를
  // 지키는 그 루프가 []를 "없는 것"으로 읽어 떨어뜨리면 같은 뒤집힘이 난다 —
  // 그리고 복원본에는 자동 적용이 안 걸리므로 되돌아올 길이 없다.
  test("an engine restart keeps a restored empty match list instead of dropping it", () => {
    const restoredEmpty = appReducer(initialAppState, {
      type: "restoreProject",
      entries: [{
        path: "/cuts/a.psd", mtime: 1700, tree: RESTORED_TREE as never, matchedIds: [],
        ops: RESTORED_OPS as never, previewKey: "k", previewFile: "a.png",
      }],
    } as never);

    const s = appReducer(restoredEmpty, { type: "engineRestarted" });

    expect(s.matchedIdsByPath).toHaveProperty("/cuts/a.psd");
    expect(s.matchedIdsByPath["/cuts/a.psd"]).toEqual([]);
  });

  // 평범하게 연 파일은 그대로 false여야 한다 — 로드 큐가 자동 적용을 걸 자리가
  // 있어야 새로 연 파일에 프리셋이 붙는다.
  test("opening a file that was never restored leaves presetApplied false", () => {
    const opened = appReducer(initialAppState, { type: "addFiles", paths: ["/cuts/b.psd"] });
    const s = appReducer(opened, {
      type: "openSuccess",
      path: "/cuts/b.psd",
      result: { sessionId: 1, width: 1, height: 1, colorMode: "RGB", depth: 8, tree: [] },
    });

    expect(s.files[0].presetApplied).toBe(false);
  });
});

describe("drawnLinesDetected (픽셀 굵기 검출의 지정과 래치)", () => {
  function opened(): AppState {
    let s = appReducer(initial, { type: "addFiles", paths: ["/a.psd"] });
    s = appReducer(s, { type: "openStart", path: "/a.psd", activate: true });
    return appReducer(s, {
      type: "openSuccess",
      path: "/a.psd",
      result: { sessionId: 1, width: 1, height: 1, colorMode: "RGB", depth: 8, tree },
    });
  }

  test("designates through the manual-line path and records the badge ids", () => {
    const s = appReducer(opened(), { type: "drawnLinesDetected", path: "/a.psd", layerIds: [1] });
    // 수동 지정과 같은 경로 — 포함까지 함께 켜진다(opsReducer의 setManualLine).
    expect(s.opsByPath["/a.psd"].manualLineIds).toContain(1);
    expect(s.opsByPath["/a.psd"].includedIds).toContain(1);
    expect(s.drawnLineIdsByPath["/a.psd"]).toEqual([1]);
  });

  test("an empty result still latches, so the watcher stops re-measuring", () => {
    const s0 = opened();
    const s = appReducer(s0, { type: "drawnLinesDetected", path: "/a.psd", layerIds: [] });
    expect(s.drawnLineIdsByPath["/a.psd"]).toEqual([]);
    expect(s.opsByPath["/a.psd"]).toBe(s0.opsByPath["/a.psd"]);
  });

  test("a file that is not open ignores the action", () => {
    const s = appReducer(initial, { type: "drawnLinesDetected", path: "/x.psd", layerIds: [1] });
    expect(s).toBe(initial);
  });

  test("re-applying a preset drops the latch so detection reruns", () => {
    const s0 = appReducer(opened(), { type: "drawnLinesDetected", path: "/a.psd", layerIds: [1] });
    const s = appReducer(s0, {
      type: "applyPresetResult", path: "/a.psd", matchedLayerIds: [2], operations: [],
    });
    expect(s.drawnLineIdsByPath).not.toHaveProperty("/a.psd");
  });
});

describe("detectDrawnLinesEffect (선 그림 검출의 실제 동작)", () => {
  // 후보 산정(제외 어휘)과 문턱은 detectDrawnLines.test.ts가 잠근다. 여기서는
  // 오케스트레이션만 본다: 청크로 끊어 부르는지, 결과·실패가 래치로 끝나는지.
  const detectTree: TreeNode[] = Array.from({ length: 8 }, (_, i) => ({
    id: i + 1, name: `detail ${i + 1}`, kind: "pixel", visible: true, blendMode: "normal",
    opacity: 255, bbox: [0, 0, 10, 10], hasMask: false, hasPixels: true,
    path: [`detail ${i + 1}`],
  })) as TreeNode[];

  beforeEach(() => {
    mockMeasureLeafStrokes.mockReset();
  });

  test("measures in chunks and lands the judged ids on that path", async () => {
    mockMeasureLeafStrokes.mockImplementation(async (_sid: number, ids: number[]) =>
      Object.fromEntries(ids.map((id) => [String(id), {
        survive1: 0, survive2: 0, coverage: 0.02,
        // 잎 1만 부스러기 가드 위 — 나머지는 너무 작아 걸러진다
        nNative: id === 1 ? 120000 : 100,
      }]))
    );
    const actions: AppAction[] = [];
    await detectDrawnLinesEffect((a) => actions.push(a), "/a.psd", 3, detectTree, [], preset);

    // 후보 8장, 청크 6 → 두 번에 나눠 잰다. 엔진이 직렬이라 이 틈이 미리보기의 숨구멍이다.
    expect(mockMeasureLeafStrokes).toHaveBeenCalledTimes(2);
    expect(mockMeasureLeafStrokes.mock.calls[0][1]).toHaveLength(6);
    expect(actions).toEqual([{ type: "drawnLinesDetected", path: "/a.psd", layerIds: [1] }]);
  });

  test("a failure raises one card and still latches — no endless retry loop", async () => {
    mockMeasureLeafStrokes.mockRejectedValue(new EngineRpcError({ message: "boom", traceback: "" }));
    const actions: AppAction[] = [];
    await detectDrawnLinesEffect((a) => actions.push(a), "/a.psd", 3, detectTree, [], preset);
    expect(actions.map((a) => a.type)).toEqual(["pushError", "drawnLinesDetected"]);
    expect(actions[1]).toEqual({ type: "drawnLinesDetected", path: "/a.psd", layerIds: [] });
  });

  test("no candidates means one empty latch and no engine call", async () => {
    const actions: AppAction[] = [];
    await detectDrawnLinesEffect((a) => actions.push(a), "/a.psd", 3, [], [], preset);
    expect(mockMeasureLeafStrokes).not.toHaveBeenCalled();
    expect(actions).toEqual([{ type: "drawnLinesDetected", path: "/a.psd", layerIds: [] }]);
  });

  test("two files' detections never overlap — the chain runs one at a time", async () => {
    // 첫 파일의 측정을 붙들어 두고, 그동안 둘째 파일이 시작하는지 본다.
    // 겹치면 안 되는 이유는 queueDetectDrawnLines 주석 — 세션 두 칸을 놓고
    // 검출끼리 서로의 세션을 걷어차며 재열기(수백 MB 재파싱)를 주고받는다.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const sids: number[] = [];
    mockMeasureLeafStrokes.mockImplementation(async (sid: number) => {
      sids.push(sid);
      if (sid === 1) await gate;
      return {};
    });
    const p1 = queueDetectDrawnLines(() => {}, "/a.psd", 1, detectTree, [], preset);
    const p2 = queueDetectDrawnLines(() => {}, "/b.psd", 2, detectTree, [], preset);
    await new Promise((r) => setTimeout(r, 0));
    expect(sids).toEqual([1]); // 둘째는 첫째가 끝나기 전에 시작하지 않는다
    release();
    await Promise.all([p1, p2]);
    expect(sids).toEqual([1, 1, 2, 2]); // 후보 8 → 청크 6+2, 넣은 순서대로
  });

  test("waitQuiet gates every chunk — a busy engine defers measurement", async () => {
    // 미루기의 핵심: 잰다는 결정은 그대로 두고, 실제 디코드는 엔진이 조용할
    // 때만 나간다. 청크마다 물어야 도중에 온 조작(파일 전환 등)에 양보한다.
    let releaseQuiet!: () => void;
    const quietGate = new Promise<void>((r) => { releaseQuiet = r; });
    const waits: number[] = [];
    mockMeasureLeafStrokes.mockResolvedValue({});
    const waitQuiet = async () => { waits.push(mockMeasureLeafStrokes.mock.calls.length); await quietGate; };
    const p = detectDrawnLinesEffect(() => {}, "/quiet.psd", 3, detectTree, [], preset, waitQuiet);
    await new Promise((r) => setTimeout(r, 0));
    expect(mockMeasureLeafStrokes).not.toHaveBeenCalled(); // 조용해지기 전엔 안 잰다
    releaseQuiet();
    await p;
    expect(mockMeasureLeafStrokes).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([0, 1]); // 청크마다 한 번씩, 측정보다 먼저
  });

  test("frontloadDetection pulls a queued file ahead; a running one hands back its promise", async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => { releaseA = r; });
    const order: number[] = [];
    mockMeasureLeafStrokes.mockImplementation(async (sid: number) => {
      order.push(sid);
      if (sid === 1) await gateA;
      return {};
    });
    const pa = queueDetectDrawnLines(() => {}, "/fa.psd", 1, detectTree, [], preset);
    const pb = queueDetectDrawnLines(() => {}, "/fb.psd", 2, detectTree, [], preset);
    const pc = queueDetectDrawnLines(() => {}, "/fc.psd", 3, detectTree, [], preset);
    expect(frontloadDetection("/no-such.psd")).toBeNull(); // 예약 없음 — 기다릴 것도 없다
    expect(frontloadDetection("/fc.psd")).toBe(pc); // 대기열에 있으면 맨 앞으로
    expect(frontloadDetection("/fa.psd")).toBe(pa); // 이미 실행 중이면 그 약속 그대로
    releaseA();
    await Promise.all([pa, pb, pc]);
    expect(order).toEqual([1, 1, 3, 3, 2, 2]); // C가 B를 앞지른다
  });

  test("urgent detection stops waiting for quiet — export must not stall behind a busy engine", async () => {
    mockMeasureLeafStrokes.mockResolvedValue({});
    const waitQuiet = async (isUrgent: () => boolean) => {
      while (!isUrgent()) await new Promise((r) => setTimeout(r, 1));
    };
    const p = queueDetectDrawnLines(() => {}, "/fu.psd", 9, detectTree, [], preset, waitQuiet);
    await new Promise((r) => setTimeout(r, 5));
    expect(mockMeasureLeafStrokes).not.toHaveBeenCalled(); // 엔진이 계속 바쁨 — 대기
    expect(frontloadDetection("/fu.psd")).toBe(p);
    await p; // 앞당기면 조용함을 더 기다리지 않는다
    expect(mockMeasureLeafStrokes).toHaveBeenCalledTimes(2);
  });
});

test("strokeFeaturesLoaded stores the sweep's features and removeFile drops them", () => {
  let s1 = appReducer(initial, { type: "addFiles", paths: ["/a.psd"] });
  s1 = appReducer(s1, { type: "strokeFeaturesLoaded", path: "/a.psd", features: { "3": null } });
  expect(s1.strokeFeaturesByPath["/a.psd"]).toEqual({ "3": null });
  s1 = appReducer(s1, { type: "removeFile", path: "/a.psd" });
  expect(s1.strokeFeaturesByPath["/a.psd"]).toBeUndefined();
});

test("evicted-session exhaustion retreats quietly — no card, no empty latch", async () => {
  // 축출 소진은 고장이 아니라 경합이다(파일을 빠르게 오가며 클릭 — 2026-08-20
  // 실사고). 카드+빈 래치로 접으면 그 파일은 세션 내내 검출이 없던 일이 된다.
  // 래치를 안 세우고 물러나면 감시 그물이 조용해진 뒤 다시 대기열에 세운다.
  mockOpenPsd.mockResolvedValue({ sessionId: 9, tree: [], width: 1, height: 1, mtime: 1 });
  mockMeasureLeafStrokes.mockRejectedValue(
    new EngineRpcError({ message: "unknown or evicted session: 25", traceback: "" })
  );
  const tree = [{
    id: 1, name: "detail", kind: "pixel", visible: true, blendMode: "normal",
    opacity: 255, bbox: [0, 0, 10, 10], hasMask: false, hasPixels: true, path: ["detail"],
  }] as unknown as TreeNode[];
  const actions: AppAction[] = [];
  await detectDrawnLinesEffect((a) => actions.push(a), "/ev.psd", 3, tree, [], preset);
  expect(actions.filter((a) => a.type === "pushError" || a.type === "drawnLinesDetected")).toEqual([]);
});
