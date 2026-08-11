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
  onSetIncluded?: (ids: number[]) => void;
}) {
  const [ops, dispatch] = useReducer(opsReducer, props.initialOps);
  const spy = useRef(props.onSetManualLine);
  spy.current = props.onSetManualLine;
  const setManualLine = useCallback((ids: number[], on: boolean) => {
    spy.current(ids, on);
    dispatch({ type: "setManualLine", layerIds: ids, on });
  }, []);
  // 체크도 같은 이유로 왕복시킨다(위 주석 참고). 고정 prop으로 두면 그룹 체크를
  // 눌러도 화면의 체크 상태가 그대로라, 두 번째 클릭이 첫 번째와 같은 방향으로
  // 가는지("전부 켜짐"에서 눌렀을 때 꺼지는지)를 어느 테스트도 볼 수 없다.
  const includeSpy = useRef(props.onSetIncluded);
  includeSpy.current = props.onSetIncluded;
  const setIncluded = useCallback((ids: number[]) => {
    includeSpy.current?.(ids);
    dispatch({ type: "setIncluded", includedIds: ids });
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
      onSetIncluded={setIncluded}
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
  const onSetIncluded = vi.fn();
  render(
    <Harness
      tree={tree}
      initialOps={{ ...opsOf(includedIds), ...extraOps }}
      onSetManualLine={onSetManualLine}
      onSetIncluded={onSetIncluded}
    />
  );
  return { onSetManualLine, onSetIncluded };
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

/**
 * 그룹 체크박스.
 *
 * 프리셋이 아무것도 못 잡는 파일(군중 판이 그렇다)은 아티스트가 손으로 체크하는데,
 * 그전에는 그룹 행에 체크박스 자리만 비어 있어서 `01`~`05` 형제를 한 장씩 눌러야
 * 했다. 그룹 하나로 그 안을 전부 켜고 끈다.
 */
function groupCheckbox(index = 0): HTMLInputElement {
  return screen.getAllByRole("checkbox", { name: "그룹 내보내기 토글" })[index] as HTMLInputElement;
}

/** 잎 행의 체크박스만. 그룹 것과 섞이지 않게 행 클래스로 좁힌다. */
function leafCheckboxes(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll(".tree-row-leaf input.include-checkbox"));
}

test("the group checkbox includes every layer inside it at once", () => {
  const { onSetIncluded } = renderTree(
    [group(10, "MG", [leaf(1, "01", "pixel"), leaf(2, "02", "pixel"), leaf(3, "03", "pixel")])],
    []
  );

  fireEvent.click(groupCheckbox());

  expect(onSetIncluded).toHaveBeenCalledWith([1, 2, 3]);
  expect(leafCheckboxes().map((c) => c.checked)).toEqual([true, true, true]);
  expect(groupCheckbox().checked).toBe(true);
});

test("the group checkbox releases them all when they are already on", () => {
  // 방향을 지금 상태에서 정하는지 본다. 고정 prop 하네스였다면 이 두 번째 클릭이
  // 첫 번째와 같은 방향으로 가도 아무도 못 잡는다.
  const { onSetIncluded } = renderTree(
    [group(10, "MG", [leaf(1, "01", "pixel"), leaf(2, "02", "pixel")])],
    [1, 2]
  );

  fireEvent.click(groupCheckbox());

  expect(onSetIncluded).toHaveBeenCalledWith([]);
  expect(leafCheckboxes().map((c) => c.checked)).toEqual([false, false]);
});

test("a half-checked group shows it, and one click fills the rest", () => {
  // 표시가 없으면 "다섯 중 셋"이 "하나도 안 켜짐"과 똑같이 보인다.
  const { onSetIncluded } = renderTree(
    [group(10, "MG", [leaf(1, "01", "pixel"), leaf(2, "02", "pixel"), leaf(3, "03", "pixel")])],
    [2]
  );

  expect(groupCheckbox().checked).toBe(false);
  expect(groupCheckbox().indeterminate).toBe(true);

  fireEvent.click(groupCheckbox());

  expect(onSetIncluded).toHaveBeenCalledWith([1, 2, 3]);
  expect(groupCheckbox().indeterminate).toBe(false);
});

test("the group checkbox skips layers that cannot be exported", () => {
  // 잎 행이 체크박스를 안 내주는 종류(텍스트)를 그룹이 몰래 켜면, 화면에 체크가
  // 안 보이는 그 id가 includedIds를 타고 그대로 내보내기 인자가 된다.
  const { onSetIncluded } = renderTree(
    [group(10, "MG", [leaf(1, "01", "pixel"), leaf(2, "메모", "type")])],
    []
  );

  fireEvent.click(groupCheckbox());

  expect(onSetIncluded).toHaveBeenCalledWith([1]);
  // 그리고 그 그룹은 "전부 켜짐"이다 — 못 켜는 것을 기다리느라 영영 반쯤 켜진
  // 상태로 남으면, 다음 클릭이 끄지 않고 다시 켜기만 한다.
  expect(groupCheckbox().checked).toBe(true);
});

test("a group with nothing exportable has its checkbox disabled", () => {
  renderTree([group(10, "NOTES", [leaf(1, "메모", "type")])], []);

  expect(groupCheckbox().disabled).toBe(true);
});

test("the group checkbox reaches through nested groups", () => {
  const { onSetIncluded } = renderTree(
    [group(10, "CROWD", [group(11, "MID", [leaf(1, "01", "pixel"), leaf(2, "02", "pixel")]), leaf(3, "base", "pixel")])],
    []
  );

  fireEvent.click(groupCheckbox());

  expect(onSetIncluded).toHaveBeenCalledWith([1, 2, 3]);
});

/**
 * 그룹도 잎처럼 다뤄야 내보낼 수 있다(2026-08-11 아티스트 요청).
 *
 * 체크만 되고 지정이 안 되면 반쪽이다 — 프리셋이 아무것도 못 잡는 파일에서
 * 라인으로 내보내려면 수동 지정이 필요한데, 그 경로가 잎에만 있었다. 규약은
 * 한 곳(expandRowIds)에서 편다: 그룹 행 → 그 안의 체크 가능한 잎.
 */
function groupRows(): HTMLElement[] {
  return Array.from(document.querySelectorAll(".tree-row-group"));
}

test("the group's line button designates every layer inside it", () => {
  const { onSetManualLine } = renderTree(
    [group(10, "MG", [leaf(1, "01", "pixel"), leaf(2, "02", "pixel"), leaf(3, "메모", "type")])],
    [1, 2]
  );

  // 그룹 행의 라인 버튼은 문서 순서로 첫 번째다(그 아래가 잎들).
  fireEvent.click(lineButtons()[0]);

  // 텍스트는 빠진다 — 잎의 지정 경로와 같은 조건이다.
  expect(designated(onSetManualLine)).toEqual([[1, 2], true]);
});

test("KeyL designates the selected group's layers", () => {
  const { onSetManualLine } = renderTree(
    [group(10, "MG", [leaf(1, "01", "pixel"), leaf(2, "02", "pixel")])],
    [1, 2]
  );

  fireEvent.click(groupRows()[0]);
  fireEvent.keyDown(document.body, { code: "KeyL" });

  expect(designated(onSetManualLine)).toEqual([[1, 2], true]);
});

test("right-clicking a group opens the same menu and it acts on the group's layers", () => {
  const { onSetManualLine } = renderTree(
    [group(10, "MG", [leaf(1, "01", "pixel"), leaf(2, "02", "pixel")])],
    [1, 2]
  );

  fireEvent.contextMenu(groupRows()[0]);
  fireEvent.click(screen.getByRole("button", { name: "라인으로 지정" }));

  expect(designated(onSetManualLine)).toEqual([[1, 2], true]);
});

test("a group already designated is released by the same click", () => {
  // 방향은 지금 지정 상태로 정한다 — 잎과 같은 규약이다.
  const { onSetManualLine } = renderTree(
    [group(10, "MG", [leaf(1, "01", "pixel"), leaf(2, "02", "pixel")])],
    [1, 2],
    { manualLineIds: [1, 2] }
  );

  fireEvent.click(lineButtons()[0]);

  expect(designated(onSetManualLine)).toEqual([[1, 2], false]);
});

test("selecting a group and one of its own layers does not designate it twice", () => {
  // 그룹과 자식을 함께 고르는 것은 흔하다. 같은 id가 두 번 실리면 받는 쪽이 세는
  // 개수와 화면이 어긋난다.
  const { onSetManualLine } = renderTree(
    [group(10, "MG", [leaf(1, "01", "pixel"), leaf(2, "02", "pixel")])],
    [1, 2]
  );

  fireEvent.click(groupRows()[0]);
  fireEvent.click(leafRows()[1], { metaKey: true });
  fireEvent.keyDown(document.body, { code: "KeyL" });

  const [ids] = onSetManualLine.mock.calls[0];
  expect([...(ids as number[])].sort((a, b) => a - b)).toEqual([1, 2]);
});

test("the group's own buttons do not steal the selection", () => {
  // 접기·체크·solo·눈을 누르는 것은 선택을 바꾸는 조작이 아니다. 안 끊으면
  // 스무 장을 골라둔 상태에서 그룹을 접기만 해도 그 선택이 날아간다.
  const { onSetManualLine } = renderTree(
    [group(10, "MG", [leaf(1, "01", "pixel"), leaf(2, "02", "pixel")]), leaf(3, "03", "pixel")],
    [1, 2, 3]
  );
  fireEvent.click(leafRows()[leafRows().length - 1]); // 03만 선택

  fireEvent.click(screen.getAllByRole("checkbox", { name: "그룹 내보내기 토글" })[0]);
  fireEvent.click(screen.getAllByRole("button", { name: "그룹 solo 토글" })[0]);
  fireEvent.keyDown(document.body, { code: "KeyL" });

  // 선택은 여전히 03 하나다.
  expect(designated(onSetManualLine)).toEqual([[3], true]);
});
