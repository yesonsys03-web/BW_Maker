import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  LAYER_FILTER_LABELS,
  LAYER_FILTER_MODES,
  applyBulkInclude,
  bulkTogglableIds,
  collapseMergedRows,
  filterLeaves,
  flattenLeaves,
  isFiltering,
  isLineFallbackActive,
  suggestMergeName,
  type FlatRow,
  type LayerFilterMode,
} from "../lib/layerFilter";
import { autoMergeOperations, autoMergePreview } from "../lib/engine";
import {
  autoMergeOps,
  buildEntries,
  exportLabelsBySourceId,
  mergeDestinations,
  mergeIntoOps,
  mergedSourceIds as mergedSourceIdsOf,
  type MergeDestination,
  type OpsState,
} from "../lib/opsReducer";
import { groupSoloIds, toEngineError } from "../lib/preview";
import { PLANE_TOKENS, type EngineError, type MergeRule, type Operation, type TreeNode } from "../lib/types";
import type { FileStatus } from "../state/appStore";

interface LayerTreeProps {
  sessionId: number | undefined;
  /** 요소 이름을 알아내는 역할 접미사(선택된 프리셋). 버튼과 이름 제안이 같이 쓴다. */
  roleTokens: string[];
  tree: TreeNode[] | undefined;
  path: string | undefined;
  status: FileStatus | undefined;
  ops: OpsState;
  matchedIds: number[];
  thumbs: Record<number, string>;
  onSetIncluded: (includedIds: number[]) => void;
  onTogglePreview: (layerId: number) => void;
  onSetPreviewHidden: (layerIds: number[], hidden: boolean) => void;
  onToggleSolo: (layerId: number) => void;
  onSetSolo: (layerIds: number[], solo: boolean) => void;
  /**
   * 색 경계선 생성의 수동 지정을 켜고 끈다(설계 3.1). ops.edgeColourIds가
   * 대상 집합이고, 여기서는 컨텍스트 메뉴의 다중 선택을 그대로 받는다.
   */
  onSetEdgeColour: (layerIds: number[], on: boolean) => void;
  /**
   * "라인으로 지정"을 켜고 끈다. 이름 규칙으로 못 잡는 판이 있다 — 잎이 7장이고
   * 선화가 `BORDER`라 include에 하나도 안 걸리는 판을 아티스트가 짚었다.
   * onSetEdgeColour와 달리 **체크박스도 같이 켠다**: 이 지정의 목적이 "이걸
   * 라인으로 내보내라"이기 때문이다(opsReducer의 setManualLine 주석).
   */
  onSetManualLine: (layerIds: number[], on: boolean) => void;
  onPushOp: (op: Operation) => void;
  /**
   * 지금 화면에 보이는 pixel leaf id 전부. 스크롤할 때마다 새 목록으로 불린다.
   *
   * 썸네일을 이것만 만든다 — 500장짜리 파일을 열자마자 전부 렌더하던 때는 엔진
   * 시간의 66%가 아무도 안 보는 그림에 갔고, 엔진은 요청을 한 줄로 세워 처리하므로
   * 그동안 사람이 누른 것이 전부 그 뒤에서 기다렸다(자동 병합이 "랜덤하게" 느리던
   * 이유). 목록에서 빠진 행은 큐에서도 빠지므로, 빠르게 훑고 지나간 구간까지
   * 만들지는 않는다.
   */
  onThumbnailsNeeded: (visibleLayerIds: number[]) => void;
  onError: (title: string, error: EngineError) => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  ids: number[];
}

type ModalState =
  | { kind: "merge"; ids: number[]; defaultName: string }
  | { kind: "rename"; ids: number[]; defaultName: string };

const AUTO_MERGE_RULES: { rule: MergeRule; label: string; hint: string }[] = [
  { rule: "role", label: "역할 접미사 (UL/OL)", hint: "CHAIR1_UL과 CHAIR1_OL을 CHAIR1 한 장으로. 접미사가 없는 레이어는 BG." },
  { rule: "group", label: "그룹 단위", hint: "최상위 그룹 바로 아래 그룹으로 묶습니다 (GROUND, MG L BUILDING …)." },
  { rule: "plane", label: "깊이 평면 (BG/MG/FG)", hint: "그룹 이름 앞의 BG/MG/FG로 묶습니다. 없으면 BG." },
];

function isGroup(node: TreeNode): boolean {
  return node.kind === "group";
}

function collectLeafIds(node: TreeNode, out: number[] = []): number[] {
  if (isGroup(node)) {
    for (const child of node.children ?? []) collectLeafIds(child, out);
  } else {
    out.push(node.id);
  }
  return out;
}

/**
 * 그룹 아래에서 **체크할 수 있는** 잎만. 잎 행이 체크박스를 내주는 조건과 같아야
 * 한다(그쪽 `disabledCheckbox`는 `kind !== "pixel"`) — 여기서 텍스트나 그릴 것이
 * 없는 종류까지 담으면, 그룹 체크가 화면에 체크박스도 없는 행을 켠 것처럼 굴고
 * 그 id는 includedIds를 타고 그대로 내보내기 인자가 된다.
 */
function collectTogglableLeafIds(node: TreeNode, out: number[] = []): number[] {
  if (isGroup(node)) {
    for (const child of node.children ?? []) collectTogglableLeafIds(child, out);
  } else if (node.kind === "pixel") {
    out.push(node.id);
  }
  return out;
}

function collectVisibleLeafOrder(nodes: TreeNode[], collapsedIds: Set<number>, out: number[] = []): number[] {
  for (const node of nodes) {
    if (isGroup(node)) {
      if (!collapsedIds.has(node.id)) collectVisibleLeafOrder(node.children ?? [], collapsedIds, out);
    } else {
      out.push(node.id);
    }
  }
  return out;
}

function nodeById(nodes: TreeNode[], id: number): TreeNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (isGroup(node)) {
      const found = nodeById(node.children ?? [], id);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Renders the PSD layer tree with checkbox/preview/selection/context-menu
 * behavior. Operates on the *original* tree structure (groups/leaves) — the
 * export composition (merges etc.) lives in `ops`/`ops.entries` and never
 * mutates the tree shown here.
 */
export function LayerTree({
  sessionId,
  roleTokens,
  tree,
  path,
  status,
  ops,
  matchedIds,
  thumbs,
  onSetIncluded,
  onTogglePreview,
  onSetPreviewHidden,
  onToggleSolo,
  onSetSolo,
  onSetEdgeColour,
  onSetManualLine,
  onPushOp,
  onThumbnailsNeeded,
  onError,
}: LayerTreeProps) {
  const [collapsedIds, setCollapsedIds] = useState<Set<number>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [lastClickedId, setLastClickedId] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [nameValue, setNameValue] = useState("");
  const [filterMode, setFilterMode] = useState<LayerFilterMode>("all");
  const [query, setQuery] = useState("");
  const [autoMerging, setAutoMerging] = useState(false);
  // 규칙별 결과 장수. 어느 규칙이 맞는지는 컷마다 다르므로(같은 파일에서 2장/
  // 8장/3장으로 갈린다) 누르기 전에 보여준다. 엔진이 실제 병합과 같은 함수로
  // 계산해 주므로 표시된 숫자와 결과가 어긋나지 않는다.
  const [rulePreview, setRulePreview] = useState<Record<MergeRule, { layerCount: number; names: string[] }> | null>(null);
  const [ruleMenuOpen, setRuleMenuOpen] = useState(false);
  // 펼쳐둔 병합 행(entryId). 병합하고 나면 원본이 화면에서 사라져 무엇이
  // 들어갔는지 확인할 수 없으므로, 접힌 채로 두되 열어볼 수 있게 한다.
  const [expandedMerges, setExpandedMerges] = useState<Set<number>>(new Set());
  // 우클릭 메뉴 안에서 "병합에 넣기"를 펼쳤는지. 목적지 목록이 파일마다 다르고
  // 길어질 수 있어 한 단계 접어둔다.
  const [mergeIntoOpen, setMergeIntoOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  /** 스크롤되는 트리 본체. 썸네일 관측자의 기준(root)이다. */
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /**
   * 포인터가 이 패널 위에 있는가. L 단축키가 자기 차례를 아는 유일한 근거다
   * (PreviewCanvas의 뷰 단축키가 cursorRef로 하는 것과 같은 규약).
   *
   * CSS `:hover`가 아니라 ref다 — 의사클래스는 jsdom에서 읽을 수 없어 이 규약을
   * 시험할 수 없고, 시험할 수 없는 안전장치는 다음 사람이 조용히 지운다.
   */
  const pointerInsideRef = useRef(false);

  const includedSet = useMemo(() => new Set(ops.includedIds), [ops.includedIds]);
  const previewHiddenSet = useMemo(() => new Set(ops.previewHiddenIds), [ops.previewHiddenIds]);
  const soloSet = useMemo(() => new Set(ops.soloIds), [ops.soloIds]);
  const edgeColourSet = useMemo(() => new Set(ops.edgeColourIds), [ops.edgeColourIds]);
  const manualLineSet = useMemo(() => new Set(ops.manualLineIds), [ops.manualLineIds]);
  const matchedSet = useMemo(() => new Set(matchedIds), [matchedIds]);

  const allLeaves = useMemo(() => (tree ? flattenLeaves(tree) : []), [tree]);

  // 병합/이름변경은 트리를 건드리지 않고 내보내기 계획에만 쌓인다. 그대로 두면
  // 두 레이어를 병합해도 패널에서는 아무 변화가 없어 실패한 것처럼 보인다.
  //
  // ops.entries가 아니라 "모든 leaf 위에 ops를 재생한" 결과를 쓴다. ops.entries는
  // 체크된 레이어만으로 만들어지므로, 표시 전체 해제를 누르면 병합이 사라진 것처럼
  // 목록이 두 줄로 돌아가 버린다. 병합은 체크 상태와 무관한 결정이고, 체크는
  // "이걸 내보낼지"일 뿐이므로 패널 구조가 그것 때문에 바뀌면 안 된다.
  const planEntries = useMemo(
    () => buildEntries(allLeaves.map((l) => l.node.id), ops.ops),
    [allLeaves, ops.ops]
  );
  const exportLabels = useMemo(() => exportLabelsBySourceId(planEntries), [planEntries]);
  // "병합에서 빼기"의 대상 판정용.
  const mergedSourceIds = useMemo(() => mergedSourceIdsOf(planEntries), [planEntries]);
  const filtering = isFiltering(filterMode, query);
  const filteredLeaves = useMemo(
    () => filterLeaves(allLeaves, {
      mode: filterMode, query, matchedIds, manualLineIds: ops.manualLineIds,
    }),
    [allLeaves, filterMode, query, matchedIds, ops.manualLineIds]
  );

  // 평면 목록에서는 병합된 소스들을 한 행으로 접는다. 트리 보기는 원본 PSD
  // 구조를 비춰야 해서 접을 수 없다 — 다른 그룹끼리 병합했을 때 그 행을 어느
  // 그룹에 둘지 답이 없기 때문이다.
  const flatRows = useMemo(
    () => collapseMergedRows(filteredLeaves, planEntries),
    [filteredLeaves, planEntries]
  );

  // 행 id → 그 행이 대표하는 소스 레이어 id들. 병합 행의 체크박스·눈·제외는
  // 묶인 소스 전체에 적용돼야 한다.
  const sourcesByRowId = useMemo(() => {
    const map = new Map<number, number[]>();
    for (const row of flatRows) {
      if (row.kind === "merged") map.set(row.entryId, row.leaves.map((l) => l.node.id));
    }
    return map;
  }, [flatRows]);

  const expandRowIds = (ids: number[]): number[] =>
    ids.flatMap((id) => sourcesByRowId.get(id) ?? [id]);

  // shift-범위 선택의 기준 순서. 평면 목록일 때는 화면에 보이는 그 순서가
  // 곧 범위이고, 트리일 때는 접힌 그룹 안쪽을 건너뛴 순서다.
  const visibleOrder = useMemo(
    () =>
      filtering
        ? flatRows.flatMap((r) =>
            r.kind === "merged"
              ? expandedMerges.has(r.entryId)
                ? [r.entryId, ...r.leaves.map((l) => l.node.id)]
                : [r.entryId]
              : [r.leaf.node.id]
          )
        : tree
          ? collectVisibleLeafOrder(tree, collapsedIds)
          : [],
    [filtering, flatRows, expandedMerges, tree, collapsedIds]
  );

  /**
   * 화면에 들어온 행만 썸네일을 요청한다.
   *
   * 목록이 바뀔 때마다(스크롤이 아니라 행 구성이 바뀔 때) 관측자를 새로 걸고
   * 지금 붙어 있는 행들을 관찰한다. rootMargin으로 화면 조금 바깥까지 미리
   * 잡아, 스크롤하는 동안 빈 칸이 따라오지 않게 한다.
   *
   * 나간 행은 목록에서 뺀다. 한 번 보인 것을 계속 쌓으면 빠르게 훑고 지나간
   * 구간까지 전부 만들게 되어, 결국 예전처럼 500장을 만들게 된다.
   */
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const visible = new Set<number>();
    const report = () => onThumbnailsNeeded([...visible]);
    const observer = new IntersectionObserver(
      (entries) => {
        let changed = false;
        for (const entry of entries) {
          const raw = (entry.target as HTMLElement).dataset.thumbId;
          const id = raw === undefined ? NaN : Number(raw);
          if (!Number.isFinite(id)) continue;
          if (entry.isIntersecting) {
            if (!visible.has(id)) {
              visible.add(id);
              changed = true;
            }
          } else if (visible.delete(id)) {
            changed = true;
          }
        }
        if (changed) report();
      },
      { root, rootMargin: "300px 0px" }
    );
    root.querySelectorAll<HTMLElement>("[data-thumb-id]").forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, [visibleOrder, onThumbnailsNeeded]);

  // Layer ids are only unique within a single session, so switching the
  // active file (a new `path`) must drop any selection/collapse/menu state
  // left over from the previous file's tree. Keyed on `path`, not `tree`: a
  // transparent session-refresh reopen (LRU eviction, see sessionRetry.ts)
  // produces a new `tree` reference for the *same* file and must not silently
  // collapse every expanded group / clear the artist's selection.
  useEffect(() => {
    setCollapsedIds(new Set());
    setSelectedIds(new Set());
    setLastClickedId(null);
    setContextMenu(null);
    setModal(null);
    setFilterMode("all");
    setQuery("");
    setExpandedMerges(new Set());
  }, [path]);

  useEffect(() => {
    if (!ruleMenuOpen) return;
    function close(e: MouseEvent) {
      const el = e.target as HTMLElement;
      if (!el.closest(".auto-merge-menu-anchor")) setRuleMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setRuleMenuOpen(false);
    }
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [ruleMenuOpen]);

  // 메뉴가 새로 열리거나 닫히면 하위 메뉴는 접힌 상태에서 시작한다.
  useEffect(() => setMergeIntoOpen(false), [contextMenu]);

  useEffect(() => {
    if (!contextMenu) return;
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setContextMenu(null);
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setContextMenu(null);
    }
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenu]);

  /**
   * L — 선택한 행 전체의 라인 지정을 토글한다.
   *
   * 진짜 병목은 한 장이 아니라 "여러 장"이다. 행 버튼은 한 장을 빨리 누르게 해줄
   * 뿐이고, 스무 장을 고른 다음 한 번 누르는 길은 이 단축키뿐이다.
   *
   * `e.key`가 아니라 **`e.code`** 를 본다. 한글 입력 상태에서 L을 누르면 `key`는
   * "ㅣ"로 와서 단축키가 조용히 안 먹는다 — preview.ts의 viewCommandFor가 같은
   * 이유로 code를 쓴다. 수식키가 하나라도 끼면 넘긴다: ⌘L/⌃L은 OS와 앱의 몫이고,
   * 특히 ⌘S(프로젝트 저장) 옆에서 수식키를 흘려보내면 안 된다.
   *
   * 입력란에 포커스가 있으면 그건 명령이 아니라 글자다(검색창에 "line"을 치는
   * 것이 이 패널에서 제일 흔한 조작이다). `<select>`도 같다 — 목록이 열린
   * 상태에서 글자를 누르면 그 항목으로 뛰는 것이 브라우저 기본 동작이고,
   * 출력 포맷(ExportDialog)·프리셋(PresetBar)·배치가 전부 select다.
   *
   * 두 개의 문을 더 단다. 이 핸들러는 document에 걸리고 LayerTree는 늘 마운트돼
   * 있으므로, 그냥 두면 **아무 곳에서나** 누른 L이 뒤의 레이어 지정을 바꾼다.
   * 지정은 켜질 때 내보내기 체크까지 같이 켜는데 해제는 체크를 안 되돌리고
   * (opsReducer의 setManualLine), manualLineIds는 ops 배열이 아니라 별도 필드라
   * 되돌리기도 없다 — 사고로 누른 한 번이 남는다.
   *
   * 1. 모달이 떠 있으면 넘긴다. 모달은 전부 포털이 아니라 형제 `.modal-overlay`
   *    div이고 포커스 트랩이 없어, 내보내기 창의 버튼에 포커스를 둔 채 L을
   *    누르면 뒤가 바뀌었다. 클래스 이름에 기대는 것이 이 코드베이스의 실제
   *    규약이다(7곳 전부 이 클래스 하나를 쓰고 App.css가 그것을 그린다).
   *    새 모달을 다른 클래스로 만들면 이 문이 조용히 열린다.
   * 2. 포인터가 이 패널 밖이면 넘긴다 — PreviewCanvas의 뷰 단축키와 같은 규약.
   *
   * Escape를 보는 위의 두 핸들러와 키가 겹치지 않으므로 서로 얽히지 않는다.
   */
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.code !== "KeyL") return;
      if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target?.isContentEditable) return;
      if (document.querySelector(".modal-overlay")) return;
      if (!pointerInsideRef.current) return;
      // 선택이 비어 있으면 handleToggleManualLine이 대상 없음으로 되돌아온다
      // (우클릭 경로와 같은 문). 여기서 또 한 번 막으면 두 문이 서로를 가려
      // 어느 쪽도 시험할 수 없다.
      handleToggleManualLine(Array.from(selectedIds));
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // handleToggleManualLine은 렌더마다 새로 만들어지므로, 그것이 읽는 것들을
    // 그대로 의존성에 적는다. 빠뜨리면 오래된 지정 상태로 토글 방향을 정한다.
  }, [selectedIds, tree, sourcesByRowId, manualLineSet, onSetManualLine]);

  if (status === "processing") {
    return <div className="layer-tree layer-tree-empty">여는 중...</div>;
  }

  if (!tree) {
    return <div className="layer-tree layer-tree-empty">레이어 트리가 없습니다. 왼쪽에서 파일을 선택하세요.</div>;
  }

  function toggleCollapse(id: number) {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleRowClick(id: number, e: ReactMouseEvent) {
    if (e.shiftKey && lastClickedId !== null) {
      const from = visibleOrder.indexOf(lastClickedId);
      const to = visibleOrder.indexOf(id);
      if (from !== -1 && to !== -1) {
        const [lo, hi] = from < to ? [from, to] : [to, from];
        setSelectedIds(new Set(visibleOrder.slice(lo, hi + 1)));
        return;
      }
    }
    if (e.metaKey || e.ctrlKey) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      setLastClickedId(id);
      return;
    }
    setSelectedIds(new Set([id]));
    setLastClickedId(id);
  }

  function handleLeafCheckbox(node: TreeNode) {
    if (node.kind !== "pixel") return;
    const next = includedSet.has(node.id)
      ? ops.includedIds.filter((id) => id !== node.id)
      : [...ops.includedIds, node.id].sort((a, b) => a - b);
    onSetIncluded(next);
  }

  function handleGroupEye(node: TreeNode) {
    const leafIds = collectLeafIds(node);
    const anyVisible = leafIds.some((id) => !previewHiddenSet.has(id));
    onSetPreviewHidden(leafIds, anyVisible);
  }

  // 하위가 전부 solo면 누를 때 전부 풀고, 아니면 전부 건다. 그룹 눈과 같은 규약이다.
  // 단, 눈과 달리 soloIds에는 pixel leaf id만 넣는다(groupSoloIds 참고) — 그리지
  // 못하는 id로 soloIds가 채워지면 "solo 중"인데 어느 행도 solo로 안 보이는
  // 막다른 상태에 갇힌다.
  function handleGroupSolo(node: TreeNode) {
    const soloIds = groupSoloIds([node]);
    const allSoloed = soloIds.length > 0 && soloIds.every((id) => soloSet.has(id));
    onSetSolo(soloIds, !allSoloed);
  }

  function handleContextMenu(id: number, e: ReactMouseEvent) {
    e.preventDefault();
    const ids = selectedIds.has(id) && selectedIds.size > 0 ? Array.from(selectedIds) : [id];
    if (!selectedIds.has(id)) setSelectedIds(new Set([id]));
    setContextMenu({ x: e.clientX, y: e.clientY, ids });
  }

  function openMergeModal(ids: number[]) {
    setContextMenu(null);
    // 라인 레이어는 전부 "LINE"이라 빈칸으로 두면 매번 직접 타이핑해야 한다.
    // 요소 그룹 이름에서 역할 접미사를 떼어낸 공통 이름을 미리 채워둔다.
    const sorted = [...ids].sort((a, b) => a - b);
    const picked = allLeaves.filter((l) => sorted.includes(l.node.id));
    const suggested = suggestMergeName(picked, roleTokens);
    setModal({ kind: "merge", ids: sorted, defaultName: suggested });
    setNameValue(suggested);
  }

  function openRenameModal(ids: number[]) {
    setContextMenu(null);
    const node = tree ? nodeById(tree, ids[0]) : undefined;
    const defaultName = node?.name ?? "";
    setModal({ kind: "rename", ids, defaultName });
    setNameValue(defaultName);
  }

  function handleExclude(ids: number[]) {
    setContextMenu(null);
    const idSet = new Set(expandRowIds(ids));
    onSetIncluded(ops.includedIds.filter((id) => !idSet.has(id)));
  }

  /**
   * 색 경계선 생성의 수동 지정 대상. pixel leaf만 남긴다 — 색 경계선은 실제로
   * 칠해진 픽셀에서만 의미가 있다(체크박스가 pixel leaf에만 걸리는 것과 같은
   * 이유). 병합 행이 섞여 있으면 expandRowIds가 원본 소스 id로 펼친다.
   */
  function edgeColourTargets(ids: number[]): number[] {
    if (!tree) return [];
    return expandRowIds(ids).filter((id) => nodeById(tree, id)?.kind === "pixel");
  }

  /**
   * 컨텍스트 메뉴의 "색 원본으로 지정" 버튼. 다중 선택이 섞인 상태(일부만
   * 지정됨)일 때의 동작은 그룹 solo/eye 토글과 같은 규약을 쓴다 — 전부
   * 지정됐으면 눌렀을 때 전부 해제하고, 하나라도 안 됐으면 전부 지정한다.
   * 선택마다 개별 토글하면 "일부는 켜지고 일부는 꺼지는" 결과를 예측하기
   * 어렵고, 그 규약이 이미 이 파일 전체에서 쓰이고 있어 일관적이다.
   */
  function handleToggleEdgeColour(ids: number[]) {
    setContextMenu(null);
    const targets = edgeColourTargets(ids);
    if (targets.length === 0) return;
    const allDesignated = targets.every((id) => edgeColourSet.has(id));
    onSetEdgeColour(targets, !allDesignated);
  }

  /** "라인으로 지정". 대상 고르기와 섞임 처리는 색 원본 지정과 같은 규약이다. */
  function handleToggleManualLine(ids: number[]) {
    setContextMenu(null);
    const targets = edgeColourTargets(ids);
    if (targets.length === 0) return;
    const allDesignated = targets.every((id) => manualLineSet.has(id));
    onSetManualLine(targets, !allDesignated);
  }

  /** 행 버튼을 누르면 실제로 걸리는 대상. 버튼과 그 title이 같은 답을 쓴다. */
  function manualLineClickTargets(id: number): number[] {
    return edgeColourTargets(selectedIds.has(id) ? Array.from(selectedIds) : [id]);
  }

  /**
   * 행 오른쪽 끝의 라인 버튼. 대상 고르기는 우클릭 메뉴와 같은 규약이다 — 누른
   * 행이 선택 안에 있으면 선택 전체, 아니면 그 행 하나.
   *
   * 우클릭과 달리 선택 자체는 건드리지 않는다. 우클릭은 메뉴가 열려 있는 동안
   * 무엇에 걸릴지 볼 시간을 주지만 이 버튼은 즉시 실행되므로, 스무 장을 골라둔
   * 상태에서 스물한 번째 행을 누르는 것만으로 그 선택이 날아가면 되돌릴 방법이
   * 없다.
   */
  function handleRowLineToggle(id: number, e: ReactMouseEvent) {
    // 행 클릭이 선택을 바꾼다. 여기서 끊지 않으면 누르는 순간 선택이 이 행
    // 하나로 줄고, 방금 선택 전체에 건 지정을 눈으로 확인할 수 없다.
    e.stopPropagation();
    handleToggleManualLine(selectedIds.has(id) ? Array.from(selectedIds) : [id]);
  }

  /**
   * 행 버튼의 title. 방향(지정/해제)과 장수를 **누르면 실제로 걸릴 대상**으로
   * 계산한다 — handleToggleManualLine이 쓰는 것과 같은 집합, 같은 섞임 규약이다.
   * 장수를 적는 이유는 그 대상이 이 행 하나일 수도 선택 전체일 수도 있어서,
   * 문구만으로는 어느 쪽인지 알 수 없기 때문이다.
   */
  function manualLineButtonTitle(targets: number[]): string {
    const verb = targets.length > 0 && targets.every((id) => manualLineSet.has(id))
      ? "라인 지정 해제"
      : "라인으로 지정";
    return `${verb} (${targets.length}장, 단축키 L)`;
  }

  function manualLineButtonLabel(ids: number[]): string {
    const targets = edgeColourTargets(ids);
    if (targets.length > 0 && targets.every((id) => manualLineSet.has(id))) {
      return "라인 지정 해제";
    }
    return "라인으로 지정";
  }

  function edgeColourButtonLabel(ids: number[]): string {
    const targets = edgeColourTargets(ids);
    if (targets.length > 0 && targets.every((id) => edgeColourSet.has(id))) {
      return "색 원본 지정 해제";
    }
    return "색 원본으로 지정";
  }

  /**
   * 지금 화면에 보이는 leaf 전체를 한 번에 체크/해제한다. 필터로 좁힌 뒤
   * 하나씩 누르지 않아도 되게 하는 것이 이 패널의 목적이므로, 대상은 항상
   * "필터 결과"이지 트리 전체가 아니다.
   */
  /**
   * 표시 중인 레이어를 요소 단위로 자동 병합한다. 규칙은 엔진이 갖고 있고
   * (프리셋의 요소별 병합과 같은 함수) 여기서는 그 결과 연산만 받아 쌓는다 —
   * 규칙을 프런트에도 따로 구현하면 배치 실행 결과와 갈라진다.
   */
  // 세션이 아니라 트리를 보낸다 — 이름만 보고 묶는 계산이라 픽셀이 필요 없고,
  // 트리는 세션이 밀려나도 화면에 남아 있다. 세션을 쓰던 때는 파일을 오갔다
  // 돌아오면 축출된 세션을 되살리느라 버튼 한 번에 PSD 재파싱 3.4초가 붙었다.
  async function openRuleMenu() {
    if (!tree) return;
    const targets = bulkTogglableIds(filteredLeaves);
    if (targets.length === 0) return;
    setRuleMenuOpen(true);
    setRulePreview(null);
    try {
      const { rules } = await autoMergePreview(tree, targets, roleTokens);
      setRulePreview(rules);
    } catch (e) {
      setRuleMenuOpen(false);
      onError("자동 병합 미리보기 실패", toEngineError(e));
    }
  }

  async function handleAutoMerge(rule: MergeRule) {
    if (!tree) return;
    const targets = bulkTogglableIds(filteredLeaves);
    if (targets.length === 0) return;
    setRuleMenuOpen(false);
    setAutoMerging(true);
    try {
      const { operations } = await autoMergeOperations(tree, targets, roleTokens, rule);
      // 규칙을 바꿔 다시 누르는 것이 정상 사용이다. 이미 병합된 상태 위에 그대로
      // 얹으면 새 병합이 대상을 못 찾고 무시되므로, autoMergeOps가 먼저 풀고
      // 병합 항목 id를 현재 상태에 맞춰준다.
      for (const op of autoMergeOps(operations, ops, targets)) onPushOp(op);
    } catch (e) {
      onError("자동 병합 실패", toEngineError(e));
    } finally {
      setAutoMerging(false);
    }
  }

  /**
   * 선택한 레이어를 병합에서 빼내 단독 레이어로 되돌린다. 자동 병합이 요소를
   * 잘못 묶었을 때의 탈출구다 — 내보내기에서 빼는 것과 달리 산출물에는 남는다.
   * 병합 행 자체를 골랐다면 그 병합에 묶인 소스 전부를 꺼낸다(= 병합 해제).
   */
  function handleUnmerge(ids: number[]) {
    setContextMenu(null);
    const targets = expandRowIds(ids).filter((id) => mergedSourceIds.has(id));
    if (targets.length === 0) return;
    onPushOp({ op: "unmerge", layerIds: targets });
  }

  /**
   * 선택한 레이어를 이미 있는 병합(BG/MG/FG …)에 합친다. 자동 병합이 규칙에 걸리지
   * 않아 빠뜨린 레이어를 나중에 주워담는 용도다. 다른 병합에 묶여 있던 레이어는
   * mergeIntoOps가 거기서 먼저 빼낸다 — 안 그러면 새 병합이 조용히 무시된다.
   */
  function handleMergeInto(dest: MergeDestination) {
    const targets = contextMenu ? expandRowIds(contextMenu.ids) : [];
    setContextMenu(null);
    for (const op of mergeIntoOps(planEntries, targets, dest)) onPushOp(op);
  }

  /**
   * 그룹 체크 하나로 그 안의 잎을 전부 켜고 끈다.
   *
   * 군중 판처럼 프리셋이 아무것도 못 잡는 파일은 아티스트가 손으로 체크하는데,
   * 그때 `01`~`05` 같은 형제 잎을 한 장씩 누르고 있었다. 그룹 행에는 체크박스
   * 자리만 비어 있었다.
   *
   * 일부만 켜져 있으면 **전부 켠다**(체크박스 관례). 전부 켜져 있을 때만 끈다.
   */
  function handleGroupInclude(node: TreeNode) {
    const targets = collectTogglableLeafIds(node);
    if (targets.length === 0) return;
    const allIncluded = targets.every((id) => includedSet.has(id));
    onSetIncluded(applyBulkInclude(ops.includedIds, targets, !allIncluded));
  }

  function handleBulkInclude(include: boolean) {
    const targets = bulkTogglableIds(filteredLeaves);
    if (targets.length === 0) return;
    onSetIncluded(applyBulkInclude(ops.includedIds, targets, include));
  }

  function submitModal() {
    if (!modal) return;
    if (nameValue.trim().length === 0) return;
    if (modal.kind === "merge") {
      onPushOp({ op: "merge", layerIds: modal.ids, name: nameValue });
    } else {
      onPushOp({ op: "rename", layerId: modal.ids[0], name: nameValue });
    }
    setModal(null);
  }

  function renderNode(node: TreeNode, depth: number) {
    const indent = { paddingLeft: `${depth * 16 + 8}px` };
    const isMatched = matchedSet.has(node.id);

    if (isGroup(node)) {
      const collapsed = collapsedIds.has(node.id);
      const leafIds = collectLeafIds(node);
      const allHidden = leafIds.length > 0 && leafIds.every((id) => previewHiddenSet.has(id));
      // allSoloed는 leafIds가 아니라 groupSoloIds를 본다 — handleGroupSolo가 누를 때
      // 실제로 켜는 목록과 같아야, 이 표시가 버튼을 눌렀을 때 벌어질 일과 어긋나지 않는다.
      const soloIds = groupSoloIds([node]);
      const allSoloed = soloIds.length > 0 && soloIds.every((id) => soloSet.has(id));
      const includeTargets = collectTogglableLeafIds(node);
      const allIncluded = includeTargets.length > 0 && includeTargets.every((id) => includedSet.has(id));
      const someIncluded = includeTargets.some((id) => includedSet.has(id));
      return (
        <div key={node.id}>
          <div
            className={`tree-row tree-row-group${isMatched ? " matched" : ""}`}
            style={indent}
            role="treeitem"
            aria-expanded={!collapsed}
          >
            <button type="button" className="fold-toggle" onClick={() => toggleCollapse(node.id)}>
              {collapsed ? "▶" : "▼"}
            </button>
            <input
              type="checkbox"
              className="include-checkbox"
              checked={allIncluded}
              // 일부만 켜진 상태를 화면에 보인다. React에 prop이 없어 ref로 건다 —
              // 없으면 "다섯 중 셋 켜짐"이 "하나도 안 켜짐"과 똑같이 보인다.
              ref={(el) => {
                if (el) el.indeterminate = someIncluded && !allIncluded;
              }}
              // 켤 수 있는 잎이 없으면 누를 것이 없다(그룹 solo 버튼과 같은 판단).
              disabled={includeTargets.length === 0}
              aria-label="그룹 내보내기 토글"
              title={
                includeTargets.length === 0
                  ? "이 그룹에는 내보내기에 포함할 수 있는 레이어가 없습니다"
                  : allIncluded
                    ? `이 그룹 ${includeTargets.length}장을 전부 해제`
                    : `이 그룹 ${includeTargets.length}장을 전부 포함`
              }
              onClick={(e) => e.stopPropagation()}
              onChange={() => handleGroupInclude(node)}
            />
            <button
              type="button"
              className={`solo-toggle${allSoloed ? " solo-on" : ""}`}
              // 그릴 수 있는 leaf가 하나도 없으면 누를 것이 없다. 막지 않으면
              // 눌리기는 하는데 아무 일도 안 일어나고 켜지지도 않는 버튼이 된다
              // (soloIds가 비어 allSoloed도 영영 false다).
              disabled={soloIds.length === 0}
              onClick={() => handleGroupSolo(node)}
              aria-label="그룹 solo 토글"
              title={soloIds.length === 0 ? "이 그룹에는 미리보기에 그릴 레이어가 없습니다" : "이 그룹만 보기"}
            >
              ◉
            </button>
            <button
              type="button"
              className={`eye-toggle${allHidden ? " eye-hidden" : ""}`}
              // 그룹 solo와 같은 조건. 그릴 수 있는 leaf가 하나도 없는 그룹
              // (작업 메모만 든 LABELS 같은 그룹)에서는 눌러도 그림이 그대로다.
              disabled={soloIds.length === 0}
              onClick={() => handleGroupEye(node)}
              aria-label="그룹 미리보기 토글"
              title={
                soloIds.length === 0
                  ? "이 그룹에는 미리보기에 그릴 레이어가 없습니다"
                  : "하위 레이어 미리보기 전체 토글"
              }
            >
              👁
            </button>
            <span className="node-name" title={node.name}>
              {node.name}
            </span>
          </div>
          {!collapsed && (node.children ?? []).map((child) => renderNode(child, depth + 1))}
        </div>
      );
    }

    return renderLeaf(node, { indentPx: depth * 16 + 8 });
  }

  /**
   * leaf 한 줄. 트리 보기와 평면 목록이 같은 함수를 쓰기 때문에 체크박스·눈
   * 토글·선택·우클릭 메뉴 동작이 두 보기에서 완전히 동일하다. `breadcrumb`이
   * 주어지면 평면 목록 모드로, 이름 아래에 조상 경로를 함께 그린다.
   */
  function renderLeaf(node: TreeNode, opts: { indentPx: number; breadcrumb?: string; nested?: boolean }) {
    const isMatched = matchedSet.has(node.id);
    const included = includedSet.has(node.id);
    const hidden = previewHiddenSet.has(node.id);
    const soloed = soloSet.has(node.id);
    const edgeColour = edgeColourSet.has(node.id);
    const manualLine = manualLineSet.has(node.id);
    const selected = selectedIds.has(node.id);
    const disabledCheckbox = node.kind !== "pixel";
    // 라인 버튼을 누르면 실제로 걸리는 대상. 버튼 자체가 아니라 이걸로 title을
    // 만든다 — 이 행 하나로 계산하면 "지정된 행 + 안 된 행"을 함께 고른 상태에서
    // 툴팁이 '해제'라고 말하고 클릭은 '지정'을 거는, 방향이 뒤집힌 거짓말이 된다.
    const lineTargets = manualLineClickTargets(node.id);
    const flat = opts.breadcrumb !== undefined;
    const exportLabel = exportLabels.get(node.id);

    return (
      <div
        key={node.id}
        className={`tree-row tree-row-leaf${flat ? " tree-row-flat" : ""}${opts.nested ? " tree-row-merge-source" : ""}${selected ? " selected" : ""}${isMatched ? " matched" : ""}${edgeColour ? " edge-colour" : ""}`}
        style={{ paddingLeft: `${opts.indentPx}px` }}
        role={flat ? "listitem" : "treeitem"}
        aria-selected={selected}
        onClick={(e) => handleRowClick(node.id, e)}
        onContextMenu={(e) => handleContextMenu(node.id, e)}
      >
        <span className="fold-toggle-slot" />
        <input
          type="checkbox"
          className="include-checkbox"
          checked={included}
          disabled={disabledCheckbox}
          title={disabledCheckbox ? "pixel 레이어만 내보내기에 포함할 수 있습니다" : undefined}
          onClick={(e) => e.stopPropagation()}
          onChange={() => handleLeafCheckbox(node)}
        />
        <button
          type="button"
          className={`solo-toggle${soloed ? " solo-on" : ""}`}
          disabled={disabledCheckbox}
          onClick={(e) => {
            e.stopPropagation();
            onToggleSolo(node.id);
          }}
          aria-label="solo 토글"
          title={disabledCheckbox ? "pixel 레이어만 미리보기에 그릴 수 있습니다" : "이 레이어만 보기"}
        >
          ◉
        </button>
        <button
          type="button"
          className={`eye-toggle${hidden ? " eye-hidden" : ""}`}
          // 바로 위 solo와 같은 조건으로 막는다. 그릴 수 없는 종류(텍스트 등)는
          // includedIds에 못 들어가므로 visibleIdsForPreview가 애초에 집지 않고,
          // 그래서 눈을 눌러도 그림이 달라지지 않는다. 막지 않으면 체크박스와
          // solo는 왜 막혔는지 툴팁으로 말해주는데 눈만 조용히 아무 일도 안 하는
          // 버튼이 되어, 아티스트는 "토글이 안 된다"고 읽는다.
          disabled={disabledCheckbox}
          onClick={(e) => {
            e.stopPropagation();
            onTogglePreview(node.id);
          }}
          aria-label="미리보기 토글"
          title={disabledCheckbox ? "pixel 레이어만 미리보기에 그릴 수 있습니다" : "미리보기에서 감추기"}
        >
          👁
        </button>
        {node.kind === "pixel" && (
          // data-thumb-id로 관측자가 이 행을 알아본다(아래 IntersectionObserver).
          // 썸네일이 아직 없어도 자리는 있으므로 "보이면 그때 만든다"가 성립한다.
          <span className="node-thumb-slot" data-thumb-id={node.id}>
            {thumbs[node.id] && <img className="node-thumb" src={thumbs[node.id]} alt="" draggable={false} />}
          </span>
        )}
        <span className="node-label">
          <span className="node-name" title={node.name}>
            {node.name}
          </span>
          {flat && opts.breadcrumb!.length > 0 && (
            <span className="node-breadcrumb" title={opts.breadcrumb}>
              {opts.breadcrumb}
            </span>
          )}
        </span>
        {(edgeColour || exportLabel) && (
          <span className="node-trailing">
            {edgeColour && (
              <span
                className="node-edge-colour-badge"
                title="색 경계선 생성의 색 원본으로 지정됨 (체크박스·내보내기 포함 여부와는 무관)"
              >
                색 원본
              </span>
            )}
            {exportLabel && (
              <span
                className={`node-export-label${exportLabel.merged ? " merged" : ""}`}
                title={
                  exportLabel.merged
                    ? `${exportLabel.sourceCount}장이 "${exportLabel.name}" 하나로 병합되어 내보내집니다.`
                    : `"${exportLabel.name}" 이름으로 내보내집니다.`
                }
              >
                {exportLabel.merged ? `⤳ ${exportLabel.name} ×${exportLabel.sourceCount}` : `⤳ ${exportLabel.name}`}
              </span>
            )}
          </span>
        )}
        {node.kind !== "pixel" && <span className="node-kind">{node.kind}</span>}
        <button
          type="button"
          className={`line-toggle${manualLine ? " line-on" : ""}`}
          // 체크박스·solo·눈과 같은 조건으로 막는다. 지정 경로(edgeColourTargets)가
          // non-pixel을 이미 조용히 걸러내므로, 막지 않으면 눌리기는 하는데 아무
          // 일도 안 일어나고 켜지지도 않는 버튼이 된다 — 눈이 그래서 고쳐졌다.
          disabled={disabledCheckbox}
          onClick={(e) => handleRowLineToggle(node.id, e)}
          aria-label="라인 지정 토글"
          title={
            disabledCheckbox
              ? "pixel 레이어만 라인으로 지정할 수 있습니다"
              : manualLineButtonTitle(lineTargets)
          }
        >
          L
        </button>
      </div>
    );
  }

  /**
   * 병합 결과 한 행. 트리에서는 원본 두 행이 그대로 있지만(구조를 비추므로),
   * 평면 목록에서는 내보내기 결과와 같은 모양으로 한 줄만 보인다. 체크박스·눈은
   * 묶인 소스 전체에 한꺼번에 적용된다.
   */
  function renderMergedRow(row: Extract<FlatRow, { kind: "merged" }>) {
    const sourceIds = row.leaves.map((l) => l.node.id);
    const selected = selectedIds.has(row.entryId);
    const isMatched = sourceIds.some((id) => matchedSet.has(id));
    // 병합된 소스 중 하나라도 지정돼 있으면 표시한다 — isMatched와 같은 규약
    // ("일부라도 있으면 보인다")이다. 지정은 소스 leaf 단위라 병합 행 자체에는
    // 별도로 붙지 않는다.
    const edgeColour = sourceIds.some((id) => edgeColourSet.has(id));
    // 이 행이 대표하는 지정 가능 소스. leaf 행과 같은 경로(expandRowIds + pixel)를
    // 쓴다. 버튼이 켜 보이는지와 눌릴 수 있는지는 이 행의 소스만으로 정한다 —
    // 배지는 "이 행에 지정된 소스가 있다"는 뜻이지 선택 상태의 뜻이 아니다.
    const lineTargets = edgeColourTargets([row.entryId]);
    // 반면 누르면 실제로 걸리는 대상은 선택까지 포함한다(leaf 행과 같은 규약).
    // title은 이쪽으로 계산해야 "병합 소스 2장"이라 해놓고 3장이 걸리지 않는다.
    const lineClickTargets = manualLineClickTargets(row.entryId);
    // 하나라도 지정돼 있으면 켜진 것으로 본다 — '라인만' 목록이 이 병합 행을
    // 보여주는 조건과 같고, 위의 색 원본 배지도 같은 규약이다. 누를 때 전부
    // 지정/전부 해제 중 어느 쪽으로 가는지는 title이 말한다.
    const someLine = lineTargets.some((id) => manualLineSet.has(id));
    const allIncluded = sourceIds.length > 0 && sourceIds.every((id) => includedSet.has(id));
    const someIncluded = sourceIds.some((id) => includedSet.has(id));
    const hidden = sourceIds.length > 0 && sourceIds.every((id) => previewHiddenSet.has(id));
    // 병합 소스가 전부 non-pixel인 경우는 드물지만(선택 병합은 대상 종류를 안
    // 가린다) 그룹 solo와 같은 함정이라 여기도 groupSoloIds로 좁힌다.
    const soloSourceIds = groupSoloIds(row.leaves.map((l) => l.node));
    const allSoloed = soloSourceIds.length > 0 && soloSourceIds.every((id) => soloSet.has(id));
    const expanded = expandedMerges.has(row.entryId);
    const sourceNames = row.leaves.map((l) => l.node.name).join(" + ");
    const fullPaths = row.leaves.map((l) => (l.breadcrumb ? `${l.breadcrumb} / ${l.node.name}` : l.node.name));

    return (
      <div
        key={`merged-${row.entryId}`}
        className={`tree-row tree-row-leaf tree-row-flat tree-row-merged${selected ? " selected" : ""}${isMatched ? " matched" : ""}${edgeColour ? " edge-colour" : ""}`}
        style={{ paddingLeft: "8px" }}
        role="listitem"
        aria-selected={selected}
        onClick={(e) => handleRowClick(row.entryId, e)}
        onContextMenu={(e) => handleContextMenu(row.entryId, e)}
      >
        <button
          type="button"
          className="fold-toggle"
          aria-expanded={expanded}
          title={expanded ? "합쳐진 원본 레이어 접기" : "합쳐진 원본 레이어 펼치기"}
          onClick={(e) => {
            e.stopPropagation();
            setExpandedMerges((prev) => {
              const next = new Set(prev);
              if (next.has(row.entryId)) next.delete(row.entryId);
              else next.add(row.entryId);
              return next;
            });
          }}
        >
          {expanded ? "▼" : "▶"}
        </button>
        <input
          type="checkbox"
          className="include-checkbox"
          checked={allIncluded}
          // 일부만 체크된 병합은 "부분 포함"이다 — 체크됨/해제됨 어느 쪽으로도
          // 표시하면 거짓말이 된다. indeterminate는 DOM 속성이라 ref로 건다.
          ref={(el) => {
            if (el) el.indeterminate = someIncluded && !allIncluded;
          }}
          onClick={(e) => e.stopPropagation()}
          onChange={() => onSetIncluded(applyBulkInclude(ops.includedIds, sourceIds, !allIncluded))}
        />
        <button
          type="button"
          className={`solo-toggle${allSoloed ? " solo-on" : ""}`}
          // 그룹 버튼과 같은 이유로 막는다 — 소스가 전부 non-pixel이면 solo에
          // 넣을 id가 없어 눌러도 아무 일이 없다.
          disabled={soloSourceIds.length === 0}
          onClick={(e) => {
            e.stopPropagation();
            onSetSolo(soloSourceIds, !allSoloed);
          }}
          aria-label="solo 토글"
          title={soloSourceIds.length === 0 ? "미리보기에 그릴 소스가 없습니다" : "이 병합의 소스만 보기"}
        >
          ◉
        </button>
        <button
          type="button"
          className={`eye-toggle${hidden ? " eye-hidden" : ""}`}
          // 바로 위 solo와 같은 조건 — 소스가 전부 non-pixel이면 눌러도 그림이
          // 그대로다.
          disabled={soloSourceIds.length === 0}
          onClick={(e) => {
            e.stopPropagation();
            onSetPreviewHidden(sourceIds, !hidden);
          }}
          aria-label="미리보기 토글"
          title={soloSourceIds.length === 0 ? "미리보기에 그릴 소스가 없습니다" : "미리보기에서 감추기"}
        >
          👁
        </button>
        {/* 병합 결과의 썸네일은 없다. 소스 중 하나를 보여주면 합쳐진 그림인 양
            오해되므로 자리만 비워 정렬을 맞춘다. */}
        <span className="node-thumb-slot" />
        <span className="node-label">
          <span className="node-name" title={row.name}>
            {row.name}
          </span>
          <span className="node-breadcrumb" title={fullPaths.join("\n")}>
            {sourceNames} ({row.sourceCount}장 병합)
          </span>
        </span>
        {edgeColour && (
          <span className="node-trailing">
            <span
              className="node-edge-colour-badge"
              title="병합된 소스 중 색 경계선 생성의 색 원본으로 지정된 것이 있습니다"
            >
              색 원본
            </span>
          </span>
        )}
        <button
          type="button"
          className={`line-toggle${someLine ? " line-on" : ""}`}
          // 소스가 전부 non-pixel이면 지정할 것이 없다 — 바로 위 solo·눈과 같은 조건.
          disabled={lineTargets.length === 0}
          onClick={(e) => handleRowLineToggle(row.entryId, e)}
          aria-label="라인 지정 토글"
          title={
            lineTargets.length === 0
              ? "pixel 레이어만 라인으로 지정할 수 있습니다"
              : manualLineButtonTitle(lineClickTargets)
          }
        >
          L
        </button>
      </div>
    );
  }

  return (
    <div
      className="layer-tree"
      ref={scrollRef}
      onMouseEnter={() => {
        pointerInsideRef.current = true;
      }}
      onMouseLeave={() => {
        pointerInsideRef.current = false;
      }}
    >
      <div className="layer-filter-bar">
        <div className="layer-filter-row">
          <input
            type="text"
            className="layer-filter-search"
            value={query}
            placeholder="레이어 이름 / 그룹 경로 검색"
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
          {query.length > 0 && (
            <button type="button" className="layer-filter-clear" onClick={() => setQuery("")} aria-label="검색어 지우기">
              ×
            </button>
          )}
        </div>
        <div className="layer-filter-row">
          <div className="layer-filter-modes" role="group" aria-label="레이어 필터">
            {LAYER_FILTER_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                className={mode === filterMode ? "active" : undefined}
                aria-pressed={mode === filterMode}
                onClick={() => setFilterMode(mode)}
              >
                {LAYER_FILTER_LABELS[mode]}
              </button>
            ))}
          </div>
          <span className="layer-filter-count">
            {filtering ? `${filteredLeaves.length} / ${allLeaves.length}` : `${allLeaves.length}개`}
          </span>
          {ops.soloIds.length > 0 && (
            <button
              type="button"
              className="solo-clear"
              onClick={() => onSetSolo(ops.soloIds, false)}
              title="solo를 모두 풀고 원래 화면으로 돌아갑니다"
            >
              solo 해제 ({ops.soloIds.length})
            </button>
          )}
        </div>
        {filtering && (
          <div className="layer-filter-row layer-filter-bulk">
            <button type="button" onClick={() => handleBulkInclude(true)}>
              표시 전체 선택
            </button>
            <button type="button" onClick={() => handleBulkInclude(false)}>
              표시 전체 해제
            </button>
            <div className="auto-merge-menu-anchor">
              <button
                type="button"
                disabled={!sessionId || autoMerging || bulkTogglableIds(filteredLeaves).length === 0}
                title="표시 중인 라인을 규칙에 따라 묶습니다. 규칙별 결과 장수를 먼저 보여줍니다."
                onClick={() => (ruleMenuOpen ? setRuleMenuOpen(false) : void openRuleMenu())}
              >
                {autoMerging ? "병합 중..." : "자동 병합 ▾"}
              </button>
              {ruleMenuOpen && (
                <div className="auto-merge-menu" role="menu">
                  {AUTO_MERGE_RULES.map(({ rule, label, hint }) => {
                    const count = rulePreview?.[rule]?.layerCount;
                    return (
                      <button
                        key={rule}
                        type="button"
                        role="menuitem"
                        title={hint}
                        disabled={rulePreview === null}
                        onClick={() => void handleAutoMerge(rule)}
                      >
                        <span className="auto-merge-menu-label">{label}</span>
                        <span className="auto-merge-menu-count">
                          {count === undefined ? "…" : `${count}장`}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
        {isLineFallbackActive(filterMode, matchedIds) && (
          <p className="layer-filter-note">
            프리셋을 아직 적용하지 않아 이름에 <code>line</code>이 들어간 레이어를 보여줍니다. 프리셋을
            적용하면 그 매칭 결과로 바뀝니다.
          </p>
        )}
      </div>

      {filtering ? (
        <div className="tree-body tree-body-flat" role="list">
          {flatRows.length === 0 ? (
            <p className="layer-filter-empty">조건에 맞는 레이어가 없습니다.</p>
          ) : (
            flatRows.map((row) =>
              row.kind === "merged" ? (
                <div key={`merged-${row.entryId}`}>
                  {renderMergedRow(row)}
                  {expandedMerges.has(row.entryId) &&
                    row.leaves.map((l) =>
                      renderLeaf(l.node, { indentPx: 30, breadcrumb: l.breadcrumb, nested: true })
                    )}
                </div>
              ) : (
                renderLeaf(row.leaf.node, { indentPx: 8, breadcrumb: row.leaf.breadcrumb })
              )
            )
          )}
        </div>
      ) : (
        <div className="tree-body" role="tree">
          {tree.map((node) => renderNode(node, 0))}
        </div>
      )}

      {contextMenu && (
        <div ref={menuRef} className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          <button
            type="button"
            disabled={contextMenu.ids.length < 2}
            onClick={() => openMergeModal(contextMenu.ids)}
          >
            선택 병합...
          </button>
          <button
            type="button"
            title="이미 만들어진 병합(BG/MG/FG …)에 선택한 레이어를 합칩니다."
            onClick={() => setMergeIntoOpen((open) => !open)}
          >
            병합에 넣기 {mergeIntoOpen ? "▾" : "▸"}
          </button>
          {mergeIntoOpen && (
            <div className="context-submenu">
              {mergeDestinations(planEntries, expandRowIds(contextMenu.ids), PLANE_TOKENS).map((dest) => (
                <button
                  key={dest.entryId ?? `new-${dest.name}`}
                  type="button"
                  title={
                    dest.entryId === undefined
                      ? `${dest.name} 병합을 새로 만들어 선택한 레이어를 넣습니다.`
                      : `${dest.name} 병합에 선택한 레이어를 더합니다.`
                  }
                  onClick={() => handleMergeInto(dest)}
                >
                  <span className="context-submenu-name">{dest.name}</span>
                  <span className="context-submenu-count">
                    {dest.entryId === undefined ? "새로 만들기" : `${dest.sourceCount}장`}
                  </span>
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            disabled={contextMenu.ids.length !== 1}
            onClick={() => openRenameModal(contextMenu.ids)}
          >
            이름변경...
          </button>
          <button
            type="button"
            disabled={expandRowIds(contextMenu.ids).every((id) => !mergedSourceIds.has(id))}
            title="병합에서만 빼냅니다. 레이어는 그대로 내보내집니다."
            onClick={() => handleUnmerge(contextMenu.ids)}
          >
            병합에서 빼기
          </button>
          <button
            type="button"
            disabled={edgeColourTargets(contextMenu.ids).length === 0}
            title="색 경계선 생성이 자동으로 못 찾은 색 레이어를 직접 표시합니다. 체크박스(내보내기 포함 여부)와는 무관하고, 프리셋에는 저장되지 않습니다."
            onClick={() => handleToggleEdgeColour(contextMenu.ids)}
          >
            {edgeColourButtonLabel(contextMenu.ids)}
          </button>
          <button
            type="button"
            disabled={edgeColourTargets(contextMenu.ids).length === 0}
            title="이름 규칙이 못 찾은 선화를 직접 라인으로 표시합니다. '라인만' 목록에 들어오고 내보내기에도 포함됩니다. 프리셋에는 저장되지 않습니다."
            onClick={() => handleToggleManualLine(contextMenu.ids)}
          >
            {manualLineButtonLabel(contextMenu.ids)}
          </button>
          <button type="button" onClick={() => handleExclude(contextMenu.ids)}>
            내보내기에서 제외
          </button>
        </div>
      )}

      {modal && (
        <div className="modal-overlay" onClick={() => setModal(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>{modal.kind === "merge" ? "선택 레이어 병합" : "레이어 이름변경"}</h3>
            <input
              type="text"
              autoFocus
              value={nameValue}
              onChange={(e) => setNameValue(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitModal();
                if (e.key === "Escape") setModal(null);
              }}
              placeholder="이름 입력"
            />
            <div className="modal-actions">
              <button type="button" onClick={() => setModal(null)}>
                취소
              </button>
              <button type="button" onClick={submitModal} disabled={nameValue.trim().length === 0}>
                확인
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
