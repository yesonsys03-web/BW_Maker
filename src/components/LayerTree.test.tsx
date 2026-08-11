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
import { useCallback, useReducer, useRef } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

vi.mock("../lib/engine", () => ({
  autoMergePreview: vi.fn(),
  autoMergeOperations: vi.fn(),
}));

import { LayerTree } from "./LayerTree";
import { opsReducer, type OpsState } from "../lib/opsReducer";
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

/**
 * ops를 **상태로 들고 왕복시키는** 하네스.
 *
 * 고정 prop으로 주면 지정을 걸어도 화면의 지정 상태가 그대로라, 두 번째 토글이
 * 첫 번째와 같은 방향으로 가는 stale closure 버그를 어느 테스트도 볼 수 없다.
 * 진짜 reducer를 쓰는 이유는 여기에 규칙을 다시 적으면(켤 때 체크도 켠다 등)
 * 앱과 조용히 갈라지기 때문이다.
 *
 * onSetManualLine을 useCallback으로 고정하는 것도 그 일부다. 인라인 화살표로
 * 주면 렌더마다 새 함수가 되어 L 핸들러가 매번 다시 걸리고, 그 재등록이 오래된
 * 클로저를 우연히 가려버려 의존성 배열이 무엇이든 테스트가 통과한다. 앱은
 * appStore에서 useCallback으로 주므로(그쪽이 진짜다) 여기서도 고정한다.
 */
function Harness(props: {
  tree: TreeNode[];
  initialOps: OpsState;
  onSetManualLine: (ids: number[], on: boolean) => void;
}) {
  const [ops, dispatch] = useReducer(opsReducer, props.initialOps);
  const spy = useRef(props.onSetManualLine);
  spy.current = props.onSetManualLine;
  const setManualLine = useCallback((ids: number[], on: boolean) => {
    spy.current(ids, on);
    dispatch({ type: "setManualLine", layerIds: ids, on });
  }, []);
  return (
    <LayerTree
      sessionId={1}
      roleTokens={["UL", "OL_UL", "OL"]}
      tree={props.tree}
      path="/cuts/a.psd"
      status="open"
      ops={ops}
      matchedIds={[]}
      thumbs={{}}
      onSetIncluded={vi.fn()}
      onTogglePreview={vi.fn()}
      onSetPreviewHidden={vi.fn()}
      onToggleSolo={vi.fn()}
      onSetSolo={vi.fn()}
      onSetEdgeColour={vi.fn()}
      onSetManualLine={setManualLine}
      onPushOp={vi.fn()}
      onThumbnailsNeeded={vi.fn()}
      onError={vi.fn()}
    />
  );
}

/** 마운트만 한다 — 포인터는 아직 패널 밖이다(앱을 막 띄운 상태). */
function mountTree(tree: TreeNode[], includedIds: number[], extraOps: Partial<OpsState> = {}) {
  const onSetManualLine = vi.fn();
  render(
    <Harness tree={tree} initialOps={{ ...opsOf(includedIds), ...extraOps }} onSetManualLine={onSetManualLine} />
  );
  return { onSetManualLine };
}

function renderTree(tree: TreeNode[], includedIds: number[], extraOps: Partial<OpsState> = {}) {
  const handle = mountTree(tree, includedIds, extraOps);
  // 단축키는 포인터가 패널 위에 있을 때만 먹는다. 그것을 보는 테스트 말고는
  // 전부 "아티스트가 이 패널을 쓰는 중"이 출발점이므로 여기서 한 번 올려둔다.
  fireEvent.mouseEnter(panel());
  return handle;
}

/** 레이어 패널 본체. 포인터가 그 위에 있는지가 L 단축키의 조건이다. */
function panel(): HTMLElement {
  const el = document.querySelector(".layer-tree");
  if (!el) throw new Error("layer-tree not rendered");
  return el as HTMLElement;
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
  expect(buttons[0].getAttribute("title")).toBe("라인 지정 해제 (1장, 단축키 L)");
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
  expect(button.getAttribute("title")).toBe("라인으로 지정 (2장, 단축키 L)");
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

test("the merged row's button covers the whole selection, like a leaf row", () => {
  // 병합 행이 다중 선택 안에 있을 때 그 버튼이 선택을 무시하고 자기 소스만
  // 거는 것을 막는다. 잎 행에는 같은 테스트가 있었고 병합 행에는 없었다.
  const { onSetManualLine } = renderTree(
    [leaf(1, "line A", "pixel"), leaf(2, "line B", "pixel"), leaf(3, "line C", "pixel")],
    [1, 2, 3],
    { ops: [{ op: "merge", layerIds: [1, 2], name: "LINE" }] }
  );
  fireEvent.change(screen.getByPlaceholderText("레이어 이름 / 그룹 경로 검색"), {
    target: { value: "line" },
  });
  const rows = screen.getAllByRole("listitem");
  fireEvent.click(rows[0]); // 병합 행
  fireEvent.click(rows[1], { metaKey: true }); // line C

  fireEvent.click(lineButtons()[0]);

  expect(designated(onSetManualLine)).toEqual([[1, 2, 3], true]);
});

test("the merged row's button is disabled when no source can ever be a line", () => {
  // 잎 행에는 같은 테스트가 있었다. 병합 행에서 이 조건을 지우면(=늘 눌리게
  // 하면) 눌리기는 하는데 아무 일도 안 일어나는 버튼이 된다.
  renderTree([leaf(1, "line note!", "type"), leaf(2, "line memo!", "type")], [], {
    ops: [{ op: "merge", layerIds: [1, 2], name: "LINE" }],
  });
  fireEvent.change(screen.getByPlaceholderText("레이어 이름 / 그룹 경로 검색"), {
    target: { value: "line" },
  });

  const button = lineButtons()[0];
  expect(button.disabled).toBe(true);
  expect(button.getAttribute("title")).toBe("pixel 레이어만 라인으로 지정할 수 있습니다");
});

/**
 * 아래는 툴팁이 클릭 결과와 어긋나지 않는다는 것(2026-08-11 리뷰).
 *
 * title을 그 행 하나로 계산하면, 지정된 행과 안 된 행을 함께 고른 상태에서
 * 툴팁이 '해제'라고 말하고 클릭은 '지정'을 거는 방향이 뒤집힌 거짓말이 된다.
 */

test("the tooltip points the same way the click will go on a mixed selection", () => {
  const { onSetManualLine } = renderTree(
    [leaf(1, "line A", "pixel"), leaf(2, "line B", "pixel")],
    [1, 2],
    { manualLineIds: [1] }
  );
  const rows = leafRows();
  fireEvent.click(rows[0]); // 지정된 행
  fireEvent.click(rows[1], { metaKey: true }); // 안 된 행

  // 섞여 있으면 규약상 전부 지정이다. 툴팁도 그렇게 말해야 한다.
  expect(lineButtons()[0].getAttribute("title")).toBe("라인으로 지정 (2장, 단축키 L)");
  fireEvent.click(lineButtons()[0]);
  expect(designated(onSetManualLine)).toEqual([[1, 2], true]);
});

test("the tooltip counts only its own row when that row is outside the selection", () => {
  renderTree(
    [leaf(1, "line A", "pixel"), leaf(2, "line B", "pixel"), leaf(3, "line C", "pixel")],
    [1, 2, 3]
  );
  const rows = leafRows();
  fireEvent.click(rows[0]);
  fireEvent.click(rows[1], { metaKey: true });

  // 선택은 두 장이지만 이 버튼이 거는 것은 자기 행 하나다.
  expect(lineButtons()[2].getAttribute("title")).toBe("라인으로 지정 (1장, 단축키 L)");
  expect(lineButtons()[0].getAttribute("title")).toBe("라인으로 지정 (2장, 단축키 L)");
});

/**
 * 아래는 L이 자기 차례를 아는 방법(2026-08-11 리뷰의 Critical).
 *
 * 핸들러는 document에 걸리고 LayerTree는 늘 마운트돼 있다. 모달은 포털이 아니라
 * 형제 div이고 포커스 트랩이 없어, 내보내기 창의 버튼에 포커스를 둔 채 누른 L이
 * 뒤의 레이어 지정을 바꿨다. 지정은 켜질 때 내보내기 체크까지 켜는데 해제는 그
 * 체크를 안 되돌리고 되돌리기도 없어서, 사고로 누른 한 번이 그대로 남는다.
 */

test("KeyL does nothing while a modal is open", () => {
  const { onSetManualLine } = renderTree([leaf(1, "line A", "pixel")], [1]);
  fireEvent.click(leafRows()[0]);
  // 내보내기·프리셋·배치 창은 전부 이 클래스의 형제 div다.
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  const button = document.createElement("button");
  overlay.appendChild(button);
  document.body.appendChild(overlay);
  button.focus();

  fireEvent.keyDown(button, { code: "KeyL" });

  expect(onSetManualLine).not.toHaveBeenCalled();
  overlay.remove();
});

test("KeyL does nothing while this panel's own rename modal is open", () => {
  // 위의 테스트는 형제 창을 흉내낸 div였다. 이건 코드베이스에 실재하는 모달로
  // 같은 문을 확인한다 — 입력란에 포커스가 있어서가 아니라 모달이 떠 있어서
  // 막힌다는 것을 보려고 keydown은 body에 쏜다.
  const { onSetManualLine } = renderTree([leaf(1, "line A", "pixel")], [1]);
  fireEvent.contextMenu(leafRows()[0]);
  fireEvent.click(screen.getByRole("button", { name: "이름변경..." }));
  expect(document.querySelector(".modal-overlay")).toBeTruthy();

  fireEvent.keyDown(document.body, { code: "KeyL" });

  expect(onSetManualLine).not.toHaveBeenCalled();
});

test("KeyL does nothing before the pointer has ever entered the panel", () => {
  // 앱을 막 띄운 상태. 포인터가 어디 있는지는 아무도 모르므로 밖으로 친다 —
  // 기본값을 '안'으로 두면 첫 mouseleave 전까지 이 안전장치가 통째로 없다.
  const { onSetManualLine } = mountTree([leaf(1, "line A", "pixel")], [1]);
  fireEvent.click(leafRows()[0]);

  fireEvent.keyDown(document.body, { code: "KeyL" });

  expect(onSetManualLine).not.toHaveBeenCalled();
});

test("KeyL does nothing while the pointer is outside the layer panel", () => {
  const { onSetManualLine } = renderTree([leaf(1, "line A", "pixel")], [1]);
  fireEvent.click(leafRows()[0]);
  fireEvent.mouseLeave(panel());

  fireEvent.keyDown(document.body, { code: "KeyL" });

  expect(onSetManualLine).not.toHaveBeenCalled();
});

test("KeyL fires again once the pointer comes back to the panel", () => {
  const { onSetManualLine } = renderTree([leaf(1, "line A", "pixel")], [1]);
  fireEvent.click(leafRows()[0]);
  fireEvent.mouseLeave(panel());
  fireEvent.mouseEnter(panel());

  fireEvent.keyDown(document.body, { code: "KeyL" });

  expect(designated(onSetManualLine)).toEqual([[1], true]);
});

test("KeyL does nothing while a select has focus", () => {
  // 출력 포맷(ExportDialog)·프리셋(PresetBar)·배치가 전부 select다. 목록이 열린
  // 채 글자를 누르면 그 항목으로 뛰는 것이 브라우저 기본 동작이라 그쪽 것이다.
  const { onSetManualLine } = renderTree([leaf(1, "line A", "pixel")], [1]);
  fireEvent.click(leafRows()[0]);
  const select = document.createElement("select");
  document.body.appendChild(select);
  select.focus();

  fireEvent.keyDown(select, { code: "KeyL" });

  expect(onSetManualLine).not.toHaveBeenCalled();
  select.remove();
});

test("a second KeyL releases what the first one designated", () => {
  // 토글 방향은 지금 지정 상태를 보고 정한다. 핸들러가 오래된 지정 상태를 쥐고
  // 있으면 두 번째 L이 첫 번째와 같은 방향으로 가고, 아티스트는 껐다고 믿는다.
  const { onSetManualLine } = renderTree(
    [leaf(1, "line A", "pixel"), leaf(2, "line B", "pixel")],
    [1, 2]
  );
  const rows = leafRows();
  fireEvent.click(rows[0]);
  fireEvent.click(rows[1], { metaKey: true });

  fireEvent.keyDown(document.body, { code: "KeyL" });
  fireEvent.keyDown(document.body, { code: "KeyL" });

  expect(designated(onSetManualLine, 0)).toEqual([[1, 2], true]);
  expect(designated(onSetManualLine, 1)).toEqual([[1, 2], false]);
});
