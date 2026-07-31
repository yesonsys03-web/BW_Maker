import { useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { defaultExportPath, reorderArgs, resolveEntryName } from "../lib/exportFlow";
import { exportPsd, onEngineEvent } from "../lib/engine";
import { DEFAULT_LINE_COLOR } from "../lib/presets";
import { toEngineError } from "../lib/preview";
import { withEvictedSessionRetry } from "../lib/sessionRetry";
import type { OpsState } from "../lib/opsReducer";
import type { EngineError, ExportResult, OpenResult, Operation, Preset, TreeNode } from "../lib/types";

interface ExportDialogProps {
  sessionId: number;
  srcPath: string;
  ops: OpsState;
  tree: TreeNode[] | undefined;
  preset: Preset | undefined;
  onPushOp: (op: Operation) => void;
  onClose: () => void;
  onSessionRefreshed: (path: string, result: OpenResult) => void;
  onError: (title: string, error: EngineError) => void;
}

interface ProgressState {
  stage: string;
  current: number;
  total: number;
}

function isProgressEvent(payload: unknown): payload is ProgressState & { event: string } {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return p.event === "progress" && typeof p.stage === "string" && typeof p.current === "number" && typeof p.total === "number";
}

/**
 * Export dialog: shows the flat export entries list (bottom→top, matching
 * ops.entries order) with HTML5 drag&drop reordering and double-click inline
 * rename, naming/embedPreview options, then drives the save-path picker and
 * exportPsd call. Order is intentionally edited here (the flat export list)
 * rather than in LayerTree — see task-8 brief's documented deviation from
 * spec section 6.
 */
export function ExportDialog({
  sessionId,
  srcPath,
  ops,
  tree,
  preset,
  onPushOp,
  onClose,
  onSessionRefreshed,
  onError,
}: ExportDialogProps) {
  // Initialized from the currently-selected preset (still user-overridable
  // below) so single-file export matches batch export's naming/suffix/
  // embedPreview for the same preset — see FIX 3. ExportDialog is only ever
  // mounted fresh per open (App.tsx renders it conditionally), so a plain
  // useState initializer is enough; it doesn't need to react to a preset
  // switch while already open.
  const [outputSuffix, setOutputSuffix] = useState(preset?.outputSuffix ?? "_LINE");
  const [naming, setNaming] = useState<"pathPrefix" | "original">(preset?.naming ?? "pathPrefix");
  const [embedPreview, setEmbedPreview] = useState(preset?.embedPreview ?? true);
  const [splitLayers, setSplitLayers] = useState(preset?.splitLayers ?? false);
  const [normalizeColor, setNormalizeColor] = useState((preset?.lineColor ?? null) !== null);
  const [lineColor, setLineColor] = useState(preset?.lineColor ?? DEFAULT_LINE_COLOR);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);

  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const rowDragRef = useRef<{ index: number; x: number; y: number; active: boolean } | null>(null);
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    onEngineEvent((data) => {
      if (isProgressEvent(data)) setProgress({ stage: data.stage, current: data.current, total: data.total });
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  function startRename(entryId: number, currentName: string) {
    setRenamingId(entryId);
    setRenameValue(currentName);
  }

  function commitRename() {
    if (renamingId === null) return;
    const trimmed = renameValue.trim();
    if (trimmed.length > 0) onPushOp({ op: "rename", layerId: renamingId, name: trimmed });
    setRenamingId(null);
  }

  const DRAG_THRESHOLD_PX = 5;

  /** 포인터 아래에 있는 행의 인덱스. 없으면 null. */
  function rowIndexAt(x: number, y: number): number | null {
    const el = document.elementFromPoint(x, y);
    const row = el?.closest("[data-entry-index]");
    if (!row) return null;
    const raw = row.getAttribute("data-entry-index");
    return raw === null ? null : Number(raw);
  }

  /**
   * HTML5 드래그가 아니라 포인터 이벤트로 구현한다. Tauri의 dragDropEnabled가
   * 켜져 있어야 파인더에서 PSD를 끌어다 놓을 수 있는데(FilePanel), 그게 켜져
   * 있으면 OS가 드래그를 가로채 웹뷰 안의 drop 이벤트가 오지 않는다.
   */
  function beginRowDrag(e: React.PointerEvent<HTMLDivElement>, index: number) {
    if (e.button !== 0) return;
    rowDragRef.current = { index, x: e.clientX, y: e.clientY, active: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function updateRowDrag(e: React.PointerEvent<HTMLDivElement>) {
    const drag = rowDragRef.current;
    if (!drag) return;
    if (!drag.active) {
      // 이름 더블클릭 등 제자리 조작과 구분한다.
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_THRESHOLD_PX) return;
      drag.active = true;
      setDragIndex(drag.index);
    }
    setDropIndex(rowIndexAt(e.clientX, e.clientY));
  }

  function endRowDrag(e: React.PointerEvent<HTMLDivElement>) {
    const drag = rowDragRef.current;
    rowDragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    const target = drag?.active ? rowIndexAt(e.clientX, e.clientY) : null;
    setDragIndex(null);
    setDropIndex(null);
    if (drag?.active && target !== null) handleDrop(target);
  }

  function handleDrop(toIdx: number) {
    if (dragIndex === null || dragIndex === toIdx) {
      setDragIndex(null);
      return;
    }
    const { layerId, aboveId } = reorderArgs(ops.entries, dragIndex, toIdx);
    onPushOp({ op: "reorder", layerId, aboveId });
    setDragIndex(null);
  }

  async function handleExport() {
    try {
      const defaultPath = defaultExportPath(srcPath, outputSuffix);
      const outputPath = await save({
        defaultPath,
        filters: [{ name: "Photoshop", extensions: ["psd"] }],
      });
      if (!outputPath) return;

      setExporting(true);
      setProgress(null);
      setResult(null);
      // save() already confirmed overwrite with the user, so overwrite:true.
      const res = await withEvictedSessionRetry(
        srcPath,
        sessionId,
        (sid) =>
          exportPsd(sid, ops.includedIds, ops.ops, naming, outputPath, embedPreview, true, true,
                    normalizeColor ? lineColor : null, splitLayers),
        (r) => onSessionRefreshed(srcPath, r)
      );
      setResult(res);
    } catch (e) {
      onError("내보내기 실패", toEngineError(e));
    } finally {
      setExporting(false);
      setProgress(null);
    }
  }

  const verification = result?.verification;
  const verificationOk = verification?.ok === true;

  return (
    <div className="modal-overlay" onClick={() => !exporting && onClose()}>
      <div className="modal-card export-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>내보내기</h3>

        {/*
          ops.entries is bottom(index 0)→top(last index) — the same order
          build_export_plan uses server-side. .export-entries renders it with
          CSS column-reverse so the on-screen top row is the topmost stacked
          layer (Photoshop-panel convention) while the underlying array index
          (used by reorderArgs/handleDrop below) stays index-ascending
          bottom→top either way.
        */}
        <p className="export-entries-hint">레이어 순서 (맨 위 = 최상단 레이어, 드래그로 순서 변경)</p>
        <div className="export-entries">
          {ops.entries.length === 0 && <p className="export-entries-empty">내보낼 레이어가 없습니다.</p>}
          {ops.entries.map((entry, i) => {
            const displayName = resolveEntryName(ops.entries, tree, entry.entryId);
            return (
              <div
                key={entry.entryId}
                className={`export-entry-row${dragIndex === i ? " dragging" : ""}${dropIndex === i ? " drop-target" : ""}`}
                data-entry-index={i}
                onPointerDown={(e) => beginRowDrag(e, i)}
                onPointerMove={updateRowDrag}
                onPointerUp={endRowDrag}
                onPointerCancel={endRowDrag}
              >
                <span className="export-entry-handle">⠿</span>
                {renamingId === entry.entryId ? (
                  <input
                    type="text"
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.currentTarget.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                  />
                ) : (
                  <span className="export-entry-name" onDoubleClick={() => startRename(entry.entryId, displayName)}>
                    {displayName}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        <div className="export-field-row">
          <label className="preset-field">
            <span>파일명 규칙</span>
            <div className="export-radio-group">
              <label>
                <input
                  type="radio"
                  checked={naming === "pathPrefix"}
                  onChange={() => setNaming("pathPrefix")}
                />
                경로 접두사
              </label>
              <label>
                <input type="radio" checked={naming === "original"} onChange={() => setNaming("original")} />
                원본 이름
              </label>
            </div>
          </label>

          <label className="preset-field preset-field-grow">
            <span>출력 파일명 접미사</span>
            <input
              type="text"
              value={outputSuffix}
              onChange={(e) => setOutputSuffix(e.currentTarget.value)}
              placeholder="예: _LINE"
            />
          </label>
        </div>

        <label className="preset-checkbox">
          <input type="checkbox" checked={embedPreview} onChange={(e) => setEmbedPreview(e.currentTarget.checked)} />
          <span>미리보기 이미지 포함하여 내보내기</span>
        </label>

        <label className="preset-checkbox">
          <input
            type="checkbox"
            checked={splitLayers}
            onChange={(e) => setSplitLayers(e.currentTarget.checked)}
          />
          <span>레이어마다 파일 따로 내보내기</span>
        </label>

        <label className="preset-checkbox">
          <input
            type="checkbox"
            checked={normalizeColor}
            onChange={(e) => setNormalizeColor(e.currentTarget.checked)}
          />
          <span>라인 색 통일</span>
          <input
            type="color"
            className="preset-color"
            value={lineColor}
            disabled={!normalizeColor}
            onChange={(e) => setLineColor(e.currentTarget.value)}
            aria-label="통일할 라인 색"
          />
          <code className="preset-color-value">{normalizeColor ? lineColor.toUpperCase() : "원본 유지"}</code>
        </label>

        {exporting && (
          <div className="export-progress">
            <div className="export-progress-bar">
              <div
                className="export-progress-fill"
                style={{ width: progress && progress.total > 0 ? `${(progress.current / progress.total) * 100}%` : "0%" }}
              />
            </div>
            <span className="export-progress-label">
              {progress ? `${progress.stage} (${progress.current}/${progress.total})` : "내보내는 중..."}
            </span>
          </div>
        )}

        {result && (
          <div className={`export-result${verificationOk ? " ok" : " fail"}`}>
            <div className="export-result-header">
              <span className={`verification-badge${verificationOk ? " ok" : " fail"}`}>
                {verificationOk ? "검증 통과" : "검증 실패"}
              </span>
              <span className="export-result-path" title={result.outputPath}>
                {result.outputs ? `${result.outputPath} (파일 ${result.outputs.length}개)` : result.outputPath}
              </span>
            </div>
            {result.outputs && (
              <ul className="export-result-files">
                {result.outputs.map((o) => (
                  <li key={o.outputPath} title={o.outputPath}>
                    <span className={o.verification?.ok === false ? "fail" : "ok"}>
                      {o.verification?.ok === false ? "실패" : "OK"}
                    </span>
                    {o.outputPath.split(/[/\\]/).pop()}
                  </li>
                ))}
              </ul>
            )}
            {verification && !result.outputs && (
              <>
                {!verification.layerCountOk && (
                  <p className="export-result-count-mismatch">
                    레이어 수 불일치: 예상 {verification.expectedLayers} / 실제 {verification.actualLayers}
                  </p>
                )}
                <table className="verification-table">
                  <thead>
                    <tr>
                      <th>레이어</th>
                      <th>이름 확인</th>
                      <th>픽셀 확인</th>
                    </tr>
                  </thead>
                  <tbody>
                    {verification.layers.map((l, i) => (
                      <tr key={i}>
                        <td>{l.name}</td>
                        <td className={l.nameOk ? "ok" : "fail"}>{l.nameOk ? "OK" : "실패"}</td>
                        <td className={l.pixelOk === false ? "fail" : l.pixelOk === true ? "ok" : ""}>
                          {l.pixelChecked ? (l.pixelOk ? "OK" : "실패") : "미검사"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        )}

        <div className="modal-actions">
          <button type="button" onClick={onClose} disabled={exporting}>
            닫기
          </button>
          <button type="button" onClick={() => void handleExport()} disabled={exporting || ops.entries.length === 0}>
            {exporting ? "내보내는 중..." : "내보내기"}
          </button>
        </div>
      </div>
    </div>
  );
}
