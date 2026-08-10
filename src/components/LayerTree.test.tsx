// @vitest-environment jsdom
/**
 * 눈(👁)은 solo·체크박스와 같은 조건에서 막혀야 한다.
 *
 * 그리지 못하는 종류(텍스트 등)는 includedIds에 못 들어가므로
 * visibleIdsForPreview가 애초에 집지 않는다 — 눈을 눌러도 그림이 안 바뀐다.
 * 체크박스와 solo는 왜 막혔는지 툴팁으로 말해주는데 눈만 조용히 무반응이면,
 * 아티스트는 그것을 "토글이 안 된다"고 읽는다(2026-08-10 신고).
 *
 * 납품 파일의 LABELS 그룹이 실제 사례다 — "antlers grow!", "tangible shadow!"
 * 같은 작업 메모가 전부 type 레이어다.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("../lib/engine", () => ({
  autoMergePreview: vi.fn(),
  autoMergeOperations: vi.fn(),
}));

import { LayerTree } from "./LayerTree";
import type { OpsState } from "../lib/opsReducer";
import type { TreeNode } from "../lib/types";

// 썸네일 관측자는 이 테스트가 보려는 것과 무관하지만, 없으면 마운트에서 터진다.
beforeEach(() => {
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function leaf(id: number, name: string, kind: "pixel" | "type"): TreeNode {
  return {
    id,
    name,
    kind,
    visible: true,
    opacity: 255,
    blendMode: "normal",
    bbox: [0, 0, 10, 10],
    hasMask: false,
    hasPixels: true,
    path: [name],
  } as TreeNode;
}

function group(id: number, name: string, children: TreeNode[]): TreeNode {
  return {
    id,
    name,
    kind: "group",
    visible: true,
    opacity: 255,
    blendMode: "normal",
    bbox: [0, 0, 10, 10],
    hasMask: false,
    hasPixels: false,
    path: [name],
    children,
  } as TreeNode;
}

function opsOf(includedIds: number[]): OpsState {
  return {
    includedIds,
    previewHiddenIds: [],
    soloIds: [],
    edgeColourIds: [],
    manualLineIds: [],
    ops: [],
    entries: [],
  } as OpsState;
}

function renderTree(tree: TreeNode[], includedIds: number[]) {
  return render(
    <LayerTree
      sessionId={1}
      roleTokens={["UL", "OL_UL", "OL"]}
      tree={tree}
      path="/cuts/a.psd"
      status="open"
      ops={opsOf(includedIds)}
      matchedIds={[]}
      thumbs={{}}
      onSetIncluded={vi.fn()}
      onTogglePreview={vi.fn()}
      onSetPreviewHidden={vi.fn()}
      onToggleSolo={vi.fn()}
      onSetSolo={vi.fn()}
      onSetEdgeColour={vi.fn()}
      onSetManualLine={vi.fn()}
      onPushOp={vi.fn()}
      onThumbnailsNeeded={vi.fn()}
      onError={vi.fn()}
    />
  );
}

test("the eye is disabled on a layer the preview can never draw", () => {
  renderTree([leaf(1, "line A", "pixel"), leaf(2, "antlers grow!", "type")], [1]);

  const eyes = screen.getAllByRole("button", { name: "미리보기 토글" });
  expect(eyes).toHaveLength(2);
  // 순서는 문서 순서 그대로다: pixel 잎이 먼저, type 잎이 다음.
  expect((eyes[0] as HTMLButtonElement).disabled).toBe(false);
  expect((eyes[1] as HTMLButtonElement).disabled).toBe(true);
  expect(eyes[1].getAttribute("title")).toBe("pixel 레이어만 미리보기에 그릴 수 있습니다");
});

test("the group eye is disabled when the group holds nothing drawable", () => {
  renderTree(
    [
      group(10, "LABELS", [leaf(11, "tangible shadow!", "type"), leaf(12, "tentacles!", "type")]),
      group(20, "LINE", [leaf(21, "line A", "pixel")]),
    ],
    [21]
  );

  const groupEyes = screen.getAllByRole("button", { name: "그룹 미리보기 토글" });
  expect(groupEyes).toHaveLength(2);
  expect((groupEyes[0] as HTMLButtonElement).disabled).toBe(true);
  expect(groupEyes[0].getAttribute("title")).toBe("이 그룹에는 미리보기에 그릴 레이어가 없습니다");
  expect((groupEyes[1] as HTMLButtonElement).disabled).toBe(false);
});
