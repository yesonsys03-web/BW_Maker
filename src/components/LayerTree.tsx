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
  type FlatRow,
  type LayerFilterMode,
} from "../lib/layerFilter";
import { exportLabelsBySourceId, type OpsState } from "../lib/opsReducer";
import type { Operation, TreeNode } from "../lib/types";
import type { FileStatus } from "../state/appStore";

interface LayerTreeProps {
  tree: TreeNode[] | undefined;
  path: string | undefined;
  status: FileStatus | undefined;
  ops: OpsState;
  matchedIds: number[];
  thumbs: Record<number, string>;
  onSetIncluded: (includedIds: number[]) => void;
  onTogglePreview: (layerId: number) => void;
  onSetPreviewHidden: (layerIds: number[], hidden: boolean) => void;
  onPushOp: (op: Operation) => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  ids: number[];
}

type ModalState =
  | { kind: "merge"; ids: number[]; defaultName: string }
  | { kind: "rename"; ids: number[]; defaultName: string };

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
  tree,
  path,
  status,
  ops,
  matchedIds,
  thumbs,
  onSetIncluded,
  onTogglePreview,
  onSetPreviewHidden,
  onPushOp,
}: LayerTreeProps) {
  const [collapsedIds, setCollapsedIds] = useState<Set<number>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [lastClickedId, setLastClickedId] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [nameValue, setNameValue] = useState("");
  const [filterMode, setFilterMode] = useState<LayerFilterMode>("all");
  const [query, setQuery] = useState("");
  const menuRef = useRef<HTMLDivElement | null>(null);

  const includedSet = useMemo(() => new Set(ops.includedIds), [ops.includedIds]);
  const previewHiddenSet = useMemo(() => new Set(ops.previewHiddenIds), [ops.previewHiddenIds]);
  const matchedSet = useMemo(() => new Set(matchedIds), [matchedIds]);
  // 병합/이름변경은 트리를 건드리지 않고 내보내기 계획에만 쌓인다. 그대로 두면
  // 두 레이어를 병합해도 패널에서는 아무 변화가 없어 실패한 것처럼 보인다.
  const exportLabels = useMemo(() => exportLabelsBySourceId(ops.entries), [ops.entries]);

  const allLeaves = useMemo(() => (tree ? flattenLeaves(tree) : []), [tree]);
  const filtering = isFiltering(filterMode, query);
  const filteredLeaves = useMemo(
    () => filterLeaves(allLeaves, { mode: filterMode, query, matchedIds }),
    [allLeaves, filterMode, query, matchedIds]
  );

  // 평면 목록에서는 병합된 소스들을 한 행으로 접는다. 트리 보기는 원본 PSD
  // 구조를 비춰야 해서 접을 수 없다 — 다른 그룹끼리 병합했을 때 그 행을 어느
  // 그룹에 둘지 답이 없기 때문이다.
  const flatRows = useMemo(
    () => collapseMergedRows(filteredLeaves, ops.entries),
    [filteredLeaves, ops.entries]
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
        ? flatRows.map((r) => (r.kind === "merged" ? r.entryId : r.leaf.node.id))
        : tree
          ? collectVisibleLeafOrder(tree, collapsedIds)
          : [],
    [filtering, flatRows, tree, collapsedIds]
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
  }, [path]);

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

  function handleContextMenu(id: number, e: ReactMouseEvent) {
    e.preventDefault();
    const ids = selectedIds.has(id) && selectedIds.size > 0 ? Array.from(selectedIds) : [id];
    if (!selectedIds.has(id)) setSelectedIds(new Set([id]));
    setContextMenu({ x: e.clientX, y: e.clientY, ids });
  }

  function openMergeModal(ids: number[]) {
    setContextMenu(null);
    setModal({ kind: "merge", ids: [...ids].sort((a, b) => a - b), defaultName: "" });
    setNameValue("");
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
  function renderLeaf(node: TreeNode, opts: { indentPx: number; breadcrumb?: string }) {
    const isMatched = matchedSet.has(node.id);
    const included = includedSet.has(node.id);
    const hidden = previewHiddenSet.has(node.id);
    const selected = selectedIds.has(node.id);
    const disabledCheckbox = node.kind !== "pixel";
    const flat = opts.breadcrumb !== undefined;
    const exportLabel = exportLabels.get(node.id);

    return (
      <div
        key={node.id}
        className={`tree-row tree-row-leaf${flat ? " tree-row-flat" : ""}${selected ? " selected" : ""}${isMatched ? " matched" : ""}`}
        style={{ paddingLeft: `${opts.indentPx}px` }}
        role={flat ? "listitem" : "treeitem"}
        aria-selected={selected}
        onClick={(e) => handleRowClick(node.id, e)}
        onContextMenu={(e) => handleContextMenu(node.id, e)}
      >
        {!flat && <span className="fold-toggle-slot" />}
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
    const included = sourceIds.some((id) => includedSet.has(id));
    const hidden = sourceIds.length > 0 && sourceIds.every((id) => previewHiddenSet.has(id));
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
        <input
          type="checkbox"
          className="include-checkbox"
          checked={included}
          onClick={(e) => e.stopPropagation()}
          onChange={() => onSetIncluded(applyBulkInclude(ops.includedIds, sourceIds, !included))}
        />
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
        </div>
        {filtering && (
          <div className="layer-filter-row layer-filter-bulk">
            <button type="button" onClick={() => handleBulkInclude(true)}>
              표시 전체 선택
            </button>
            <button type="button" onClick={() => handleBulkInclude(false)}>
              표시 전체 해제
            </button>
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
              row.kind === "merged"
                ? renderMergedRow(row)
                : renderLeaf(row.leaf.node, { indentPx: 8, breadcrumb: row.leaf.breadcrumb })
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
            disabled={contextMenu.ids.length !== 1}
            onClick={() => openRenameModal(contextMenu.ids)}
          >
            이름변경...
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
