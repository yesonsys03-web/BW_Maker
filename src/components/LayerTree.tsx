import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { OpsState } from "../lib/opsReducer";
import type { Operation, TreeNode } from "../lib/types";

interface LayerTreeProps {
  tree: TreeNode[] | undefined;
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
  const menuRef = useRef<HTMLDivElement | null>(null);

  const includedSet = useMemo(() => new Set(ops.includedIds), [ops.includedIds]);
  const previewHiddenSet = useMemo(() => new Set(ops.previewHiddenIds), [ops.previewHiddenIds]);
  const matchedSet = useMemo(() => new Set(matchedIds), [matchedIds]);

  const visibleOrder = useMemo(
    () => (tree ? collectVisibleLeafOrder(tree, collapsedIds) : []),
    [tree, collapsedIds]
  );

  // Layer ids are only unique within a single session, so switching the
  // active file (a new `tree` reference) must drop any selection/collapse/
  // menu state left over from the previous file's tree.
  useEffect(() => {
    setCollapsedIds(new Set());
    setSelectedIds(new Set());
    setLastClickedId(null);
    setContextMenu(null);
    setModal(null);
  }, [tree]);

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
    const idSet = new Set(ids);
    onSetIncluded(ops.includedIds.filter((id) => !idSet.has(id)));
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
            <span className="node-name">{node.name}</span>
          </div>
          {!collapsed && (node.children ?? []).map((child) => renderNode(child, depth + 1))}
        </div>
      );
    }

    const included = includedSet.has(node.id);
    const hidden = previewHiddenSet.has(node.id);
    const selected = selectedIds.has(node.id);
    const disabledCheckbox = node.kind !== "pixel";

    return (
      <div
        key={node.id}
        className={`tree-row tree-row-leaf${selected ? " selected" : ""}${isMatched ? " matched" : ""}`}
        style={indent}
        role="treeitem"
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
        <span className="node-name">{node.name}</span>
        {node.kind !== "pixel" && <span className="node-kind">{node.kind}</span>}
      </div>
    );
  }

  return (
    <div className="layer-tree">
      <div className="tree-body" role="tree">
        {tree.map((node) => renderNode(node, 0))}
      </div>

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
