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
import { toEngineError } from "../lib/preview";
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
  onPushOp: (op: Operation) => void;
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
  onPushOp,
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

  const includedSet = useMemo(() => new Set(ops.includedIds), [ops.includedIds]);
  const previewHiddenSet = useMemo(() => new Set(ops.previewHiddenIds), [ops.previewHiddenIds]);
  const soloSet = useMemo(() => new Set(ops.soloIds), [ops.soloIds]);
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
    () => filterLeaves(allLeaves, { mode: filterMode, query, matchedIds }),
    [allLeaves, filterMode, query, matchedIds]
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
  function handleGroupSolo(node: TreeNode) {
    const leafIds = collectLeafIds(node);
    const allSoloed = leafIds.length > 0 && leafIds.every((id) => soloSet.has(id));
    onSetSolo(leafIds, !allSoloed);
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
   * 지금 화면에 보이는 leaf 전체를 한 번에 체크/해제한다. 필터로 좁힌 뒤
   * 하나씩 누르지 않아도 되게 하는 것이 이 패널의 목적이므로, 대상은 항상
   * "필터 결과"이지 트리 전체가 아니다.
   */
  /**
   * 표시 중인 레이어를 요소 단위로 자동 병합한다. 규칙은 엔진이 갖고 있고
   * (프리셋의 요소별 병합과 같은 함수) 여기서는 그 결과 연산만 받아 쌓는다 —
   * 규칙을 프런트에도 따로 구현하면 배치 실행 결과와 갈라진다.
   */
  async function openRuleMenu() {
    const sid = sessionId;
    if (!sid) return;
    const targets = bulkTogglableIds(filteredLeaves);
    if (targets.length === 0) return;
    setRuleMenuOpen(true);
    setRulePreview(null);
    try {
      const { rules } = await autoMergePreview(sid, targets, roleTokens);
      setRulePreview(rules);
    } catch (e) {
      setRuleMenuOpen(false);
      onError("자동 병합 미리보기 실패", toEngineError(e));
    }
  }

  async function handleAutoMerge(rule: MergeRule) {
    const sid = sessionId;
    if (!sid) return;
    const targets = bulkTogglableIds(filteredLeaves);
    if (targets.length === 0) return;
    setRuleMenuOpen(false);
    setAutoMerging(true);
    try {
      const { operations } = await autoMergeOperations(sid, targets, roleTokens, rule);
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
      const allSoloed = leafIds.length > 0 && leafIds.every((id) => soloSet.has(id));
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
            <span className="checkbox-slot" />
            <button
              type="button"
              className={`solo-toggle${allSoloed ? " solo-on" : ""}`}
              onClick={() => handleGroupSolo(node)}
              aria-label="그룹 solo 토글"
              title="이 그룹만 보기"
            >
              ◉
            </button>
            <button
              type="button"
              className={`eye-toggle${allHidden ? " eye-hidden" : ""}`}
              onClick={() => handleGroupEye(node)}
              aria-label="그룹 미리보기 토글"
              title="하위 레이어 미리보기 전체 토글"
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
    const selected = selectedIds.has(node.id);
    const disabledCheckbox = node.kind !== "pixel";
    const flat = opts.breadcrumb !== undefined;
    const exportLabel = exportLabels.get(node.id);

    return (
      <div
        key={node.id}
        className={`tree-row tree-row-leaf${flat ? " tree-row-flat" : ""}${opts.nested ? " tree-row-merge-source" : ""}${selected ? " selected" : ""}${isMatched ? " matched" : ""}`}
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
          onClick={(e) => {
            e.stopPropagation();
            onTogglePreview(node.id);
          }}
          aria-label="미리보기 토글"
        >
          👁
        </button>
        {node.kind === "pixel" && (
          <span className="node-thumb-slot">
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
        {node.kind !== "pixel" && <span className="node-kind">{node.kind}</span>}
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
    const allIncluded = sourceIds.length > 0 && sourceIds.every((id) => includedSet.has(id));
    const someIncluded = sourceIds.some((id) => includedSet.has(id));
    const hidden = sourceIds.length > 0 && sourceIds.every((id) => previewHiddenSet.has(id));
    const allSoloed = sourceIds.length > 0 && sourceIds.every((id) => soloSet.has(id));
    const expanded = expandedMerges.has(row.entryId);
    const sourceNames = row.leaves.map((l) => l.node.name).join(" + ");
    const fullPaths = row.leaves.map((l) => (l.breadcrumb ? `${l.breadcrumb} / ${l.node.name}` : l.node.name));

    return (
      <div
        key={`merged-${row.entryId}`}
        className={`tree-row tree-row-leaf tree-row-flat tree-row-merged${selected ? " selected" : ""}${isMatched ? " matched" : ""}`}
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
          onClick={(e) => {
            e.stopPropagation();
            onSetSolo(sourceIds, !allSoloed);
          }}
          aria-label="solo 토글"
          title="이 병합의 소스만 보기"
        >
          ◉
        </button>
        <button
          type="button"
          className={`eye-toggle${hidden ? " eye-hidden" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            onSetPreviewHidden(sourceIds, !hidden);
          }}
          aria-label="미리보기 토글"
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
      </div>
    );
  }

  return (
    <div className="layer-tree">
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
