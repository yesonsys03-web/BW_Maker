import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { defaultExportPath, reorderArgs, resolveEntryName } from "../lib/exportFlow";
import { exportPsd, onEngineEvent } from "../lib/engine";
import { toEngineError } from "../lib/preview";
import type { OpsState } from "../lib/opsReducer";
import type { EngineError, ExportResult, Operation, TreeNode } from "../lib/types";

interface ExportDialogProps {
  sessionId: number;
  srcPath: string;
  ops: OpsState;
  tree: TreeNode[] | undefined;
  onPushOp: (op: Operation) => void;
  onClose: () => void;
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
export function ExportDialog({ sessionId, srcPath, ops, tree, onPushOp, onClose, onError }: ExportDialogProps) {
  const [outputSuffix, setOutputSuffix] = useState("_LINE");
  const [naming, setNaming] = useState<"pathPrefix" | "original">("pathPrefix");
  const [embedPreview, setEmbedPreview] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);

  const [dragIndex, setDragIndex] = useState<number | null>(null);
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
    const defaultPath = defaultExportPath(srcPath, outputSuffix);
    const outputPath = await save({
      defaultPath,
      filters: [{ name: "Photoshop", extensions: ["psd"] }],
    });
    if (!outputPath) return;

    setExporting(true);
    setProgress(null);
    setResult(null);
    try {
      // save() already confirmed overwrite with the user, so overwrite:true.
      const res = await exportPsd(sessionId, ops.includedIds, ops.ops, naming, outputPath, embedPreview, true, true);
      setResult(res);
    } catch (e) {
      onError("내보내기 실패", toEngineError(e));
    } finally {
      setExporting(false);
      setProgress(null);
    }
  }

  const verification = result?.verification;
  const verificationOk = verification ? verification.ok : true;

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
                className={`export-entry-row${dragIndex === i ? " dragging" : ""}`}
                draggable
                onDragStart={() => setDragIndex(i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => handleDrop(i)}
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
                {result.outputPath}
              </span>
            </div>
            {verification && (
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
