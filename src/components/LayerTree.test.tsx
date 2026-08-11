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
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

function renderTree(tree: TreeNode[], includedIds: number[], extraOps: Partial<OpsState> = {}) {
  const onSetManualLine = vi.fn();
  render(
    <LayerTree
      sessionId={1}
      roleTokens={["UL", "OL_UL", "OL"]}
      tree={tree}
      path="/cuts/a.psd"
      status="open"
      ops={{ ...opsOf(includedIds), ...extraOps }}
      matchedIds={[]}
      thumbs={{}}
      onSetIncluded={vi.fn()}
      onTogglePreview={vi.fn()}
      onSetPreviewHidden={vi.fn()}
      onToggleSolo={vi.fn()}
      onSetSolo={vi.fn()}
      onSetEdgeColour={vi.fn()}
      onSetManualLine={onSetManualLine}
      onPushOp={vi.fn()}
      onThumbnailsNeeded={vi.fn()}
      onError={vi.fn()}
    />
  );
  return { onSetManualLine };
}

/** 행 오른쪽 끝의 라인 버튼들. 문서 순서 = 화면 순서다. */
function lineButtons(): HTMLButtonElement[] {
  return screen.getAllByRole("button", { name: "라인 지정 토글" }) as HTMLButtonElement[];
}

/** 트리 보기의 leaf 행. 그룹 없이 잎만 넣은 트리에서는 그대로 행 목록이다. */
function leafRows(): HTMLElement[] {
  return screen.getAllByRole("treeitem");
}

/** 라인 지정이 실제로 걸린 대상. 순서는 선택 순서라 정렬해서 본다. */
function designated(onSetManualLine: ReturnType<typeof vi.fn>, call = 0): [number[], boolean] {
  const [ids, on] = onSetManualLine.mock.calls[call];
  return [[...(ids as number[])].sort((a, b) => a - b), on as boolean];
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

/**
 * 아래는 행에서 바로 하는 라인 지정(2026-08-11 아티스트 요청).
 *
 * 지금까지는 우클릭 → 메뉴에서 고르기뿐이었다. 로직(다중 선택, 선택 전체 적용,
 * 섞인 상태 토글)은 전부 이미 있었고 없던 것은 발견 가능성과 클릭 수라, 이
 * 테스트들이 지키는 것은 "버튼과 단축키가 **우클릭과 같은 경로**로 간다"는 것
 * 하나다. 새 규약이 생기면 우클릭과 갈라진다.
 */

test("the row button designates that row as a line", () => {
  const { onSetManualLine } = renderTree([leaf(1, "line A", "pixel"), leaf(2, "line B", "pixel")], [1]);

  fireEvent.click(lineButtons()[0]);

  expect(onSetManualLine).toHaveBeenCalledTimes(1);
  expect(designated(onSetManualLine)).toEqual([[1], true]);
});

test("the row button releases a row that is already designated", () => {
  const { onSetManualLine } = renderTree(
    [leaf(1, "line A", "pixel"), leaf(2, "line B", "pixel")],
    [1, 2],
    { manualLineIds: [1] }
  );

  fireEvent.click(lineButtons()[0]);

  expect(designated(onSetManualLine)).toEqual([[1], false]);
});

test("the row button covers the whole selection, like the right-click menu", () => {
  const { onSetManualLine } = renderTree(
    [leaf(1, "line A", "pixel"), leaf(2, "line B", "pixel"), leaf(3, "line C", "pixel")],
    [1, 2, 3]
  );
  const rows = leafRows();
  fireEvent.click(rows[0]);
  fireEvent.click(rows[1], { metaKey: true });

  fireEvent.click(lineButtons()[0]);

  expect(designated(onSetManualLine)).toEqual([[1, 2], true]);
});

test("the row button covers only its own row when that row is outside the selection", () => {
  const { onSetManualLine } = renderTree(
    [leaf(1, "line A", "pixel"), leaf(2, "line B", "pixel"), leaf(3, "line C", "pixel")],
    [1, 2, 3]
  );
  const rows = leafRows();
  fireEvent.click(rows[0]);
  fireEvent.click(rows[1], { metaKey: true });

  fireEvent.click(lineButtons()[2]);

  expect(designated(onSetManualLine)).toEqual([[3], true]);
});

test("the row button leaves the selection alone", () => {
  renderTree([leaf(1, "line A", "pixel"), leaf(2, "line B", "pixel"), leaf(3, "line C", "pixel")], [1, 2, 3]);
  const rows = leafRows();
  fireEvent.click(rows[0]);
  fireEvent.click(rows[1], { metaKey: true });

  fireEvent.click(lineButtons()[2]);

  // 눌린 행이 선택 밖이어도 골라둔 두 장은 그대로 남는다 — 우클릭과 달리 즉시
  // 실행이라, 선택이 날아가면 되돌릴 방법이 없다.
  expect(leafRows().map((r) => r.getAttribute("aria-selected"))).toEqual(["true", "true", "false"]);
});

test("the row button is disabled on a layer that can never be a line", () => {
  renderTree([leaf(1, "line A", "pixel"), leaf(2, "antlers grow!", "type")], [1]);

  const buttons = lineButtons();
  expect(buttons[0].disabled).toBe(false);
  expect(buttons[1].disabled).toBe(true);
  expect(buttons[1].getAttribute("title")).toBe("pixel 레이어만 라인으로 지정할 수 있습니다");
});

test("KeyL toggles the whole selection", () => {
  const { onSetManualLine } = renderTree(
    [leaf(1, "line A", "pixel"), leaf(2, "line B", "pixel"), leaf(3, "line C", "pixel")],
    [1, 2, 3]
  );
  const rows = leafRows();
  fireEvent.click(rows[0]);
  fireEvent.click(rows[2], { metaKey: true });

  fireEvent.keyDown(document.body, { code: "KeyL" });

  expect(designated(onSetManualLine)).toEqual([[1, 3], true]);
});

test("KeyL still fires while the IME is in Korean", () => {
  // 한글 입력 상태에서 L을 누르면 `key`는 "ㅣ"로 온다. code로 보지 않으면 이
  // 단축키는 아티스트의 평소 상태에서 조용히 안 먹는다.
  const { onSetManualLine } = renderTree([leaf(1, "line A", "pixel")], [1]);
  fireEvent.click(leafRows()[0]);

  fireEvent.keyDown(document.body, { code: "KeyL", key: "ㅣ" });

  expect(designated(onSetManualLine)).toEqual([[1], true]);
});

test("KeyL does nothing while the search box has focus", () => {
  const { onSetManualLine } = renderTree([leaf(1, "line A", "pixel")], [1]);
  fireEvent.click(leafRows()[0]);
  const search = screen.getByPlaceholderText("레이어 이름 / 그룹 경로 검색");

  fireEvent.keyDown(search, { code: "KeyL" });

  expect(onSetManualLine).not.toHaveBeenCalled();
});

test("KeyL with a modifier held is ignored", () => {
  const { onSetManualLine } = renderTree([leaf(1, "line A", "pixel")], [1]);
  fireEvent.click(leafRows()[0]);

  for (const modifier of ["metaKey", "ctrlKey", "altKey", "shiftKey"]) {
    fireEvent.keyDown(document.body, { code: "KeyL", [modifier]: true });
  }

  expect(onSetManualLine).not.toHaveBeenCalled();
});

test("KeyL does nothing when nothing is selected", () => {
  const { onSetManualLine } = renderTree([leaf(1, "line A", "pixel")], [1]);

  fireEvent.keyDown(document.body, { code: "KeyL" });

  expect(onSetManualLine).not.toHaveBeenCalled();
});

test("an already designated row keeps its button on screen", () => {
  // 호버해야 보이는 버튼이지만 지정된 행에서는 늘 보여야 한다(.line-on이 그
  // visibility를 되돌린다). 지금은 지정 여부를 '라인만' 필터로 걸러봐야 알 수
  // 있어, 이 버튼이 그 표시를 겸한다.
  renderTree([leaf(1, "line A", "pixel"), leaf(2, "line B", "pixel")], [1, 2], { manualLineIds: [1] });

  const buttons = lineButtons();
  expect(buttons[0].className).toContain("line-on");
  expect(buttons[1].className).not.toContain("line-on");
  expect(buttons[0].getAttribute("title")).toBe("라인 지정 해제 (선택한 행 전체, 단축키 L)");
});

test("a merged row shows its button when even one source is designated", () => {
  renderTree([leaf(1, "line A", "pixel"), leaf(2, "line B", "pixel")], [1, 2], {
    manualLineIds: [1],
    ops: [{ op: "merge", layerIds: [1, 2], name: "LINE" }],
  });
  fireEvent.change(screen.getByPlaceholderText("레이어 이름 / 그룹 경로 검색"), {
    target: { value: "line" },
  });

  const button = lineButtons()[0];
  // '라인만' 목록이 이 행을 보여주는 조건과 같다. 다만 누르면 나머지 한 장까지
  // 지정되므로 title은 해제가 아니라 지정이라고 말해야 한다.
  expect(button.className).toContain("line-on");
  expect(button.getAttribute("title")).toBe("라인으로 지정 (병합 소스 2장, 단축키 L)");
});

test("the merged row's button covers every source of the merge", () => {
  const { onSetManualLine } = renderTree(
    [leaf(1, "line A", "pixel"), leaf(2, "line B", "pixel"), leaf(3, "line C", "pixel")],
    [1, 2, 3],
    { ops: [{ op: "merge", layerIds: [1, 2], name: "LINE" }] }
  );
  // 병합 행은 평면 목록에서만 접혀 한 줄이 된다.
  fireEvent.change(screen.getByPlaceholderText("레이어 이름 / 그룹 경로 검색"), {
    target: { value: "line" },
  });

  const buttons = lineButtons();
  expect(buttons).toHaveLength(2); // 병합 한 줄 + 안 묶인 line C
  fireEvent.click(buttons[0]);

  expect(designated(onSetManualLine)).toEqual([[1, 2], true]);
});
