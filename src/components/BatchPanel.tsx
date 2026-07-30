import { Fragment, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { exists } from "@tauri-apps/plugin-fs";
import { findConflicts, planBatchOutputs } from "../lib/batch";
import { batchRun, onEngineEvent } from "../lib/engine";
import { loadPresets } from "../lib/presets";
import { toEngineError } from "../lib/preview";
import type { FileEntry } from "../state/appStore";
import type { BatchItemResult, EngineError, Preset } from "../lib/types";

interface BatchPanelProps {
  files: FileEntry[];
  onError: (title: string, error: EngineError) => void;
}

interface ProgressState {
  path?: string;
  stage: string;
  current: number;
  total: number;
}

function isProgressEvent(payload: unknown): payload is ProgressState & { event: string } {
  if (typeof payload !== "object" || payload === null) return false;
  const p = payload as Record<string, unknown>;
  return (
    p.event === "progress" &&
    typeof p.stage === "string" &&
    typeof p.current === "number" &&
    typeof p.total === "number" &&
    (p.path === undefined || typeof p.path === "string")
  );
}

function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

interface PendingRun {
  paths: string[];
  preset: Preset;
  outputDir: string | null;
  conflicts: string[];
}

/**
 * Batch panel: pick files (defaults to every file in FilePanel) + a preset,
 * choose "next to source" or a picked output folder, pre-check name
 * conflicts with a bulk overwrite confirmation, run batchRun, and show a
 * per-file results table. batch_run opens files itself server-side — it is
 * independent of any currently-open session, and the engine keeps going past
 * per-file failures, so this UI only ever renders the final results list.
 */
export function BatchPanel({ files, onError }: BatchPanelProps) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [selectedPresetName, setSelectedPresetName] = useState<string | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(() => new Set(files.map((f) => f.path)));
  const [outputMode, setOutputMode] = useState<"sameFolder" | "customDir">("sameFolder");
  const [outputDir, setOutputDir] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [results, setResults] = useState<BatchItemResult[] | null>(null);
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  const [pendingRun, setPendingRun] = useState<PendingRun | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await loadPresets();
        if (cancelled) return;
        setPresets(loaded);
        setSelectedPresetName(loaded[0]?.name ?? null);
      } catch (e) {
        if (cancelled) return;
        onError("프리셋 목록 불러오기 실패", toEngineError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // Loaded once on mount; onError identity is stable (useCallback in appStore).
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    onEngineEvent((data) => {
      if (isProgressEvent(data)) setProgress({ path: data.path, stage: data.stage, current: data.current, total: data.total });
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const selectedPreset = presets.find((p) => p.name === selectedPresetName);

  function toggleSelected(path: string) {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function selectAll() {
    setSelectedPaths(new Set(files.map((f) => f.path)));
  }

  function selectNone() {
    setSelectedPaths(new Set());
  }

  async function handlePickOutputDir() {
    const dir = await open({ directory: true });
    if (!dir) return;
    setOutputDir(Array.isArray(dir) ? dir[0] : dir);
  }

  async function runBatch(paths: string[], preset: Preset, dir: string | null, overwrite: boolean) {
    setRunning(true);
    setResults(null);
    setExpandedRows(new Set());
    setProgress(null);
    try {
      const { results: batchResults } = await batchRun(paths, preset, dir, overwrite);
      setResults(batchResults);
    } catch (e) {
      onError("배치 실행 실패", toEngineError(e));
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }

  async function handleRunClick() {
    if (!selectedPreset || running) return;
    const paths = files.filter((f) => selectedPaths.has(f.path)).map((f) => f.path);
    if (paths.length === 0) return;
    const dir = outputMode === "customDir" ? outputDir : null;
    if (outputMode === "customDir" && !dir) {
      onError("배치 실행 실패", { message: "출력 폴더를 선택하세요.", traceback: "" });
      return;
    }

    const planned = planBatchOutputs(paths, dir, selectedPreset.outputSuffix);
    const conflicts = await findConflicts(planned, exists);
    if (conflicts.length > 0) {
      setPendingRun({ paths, preset: selectedPreset, outputDir: dir, conflicts });
      return;
    }
    await runBatch(paths, selectedPreset, dir, false);
  }

  function toggleExpanded(i: number) {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  return (
    <div className="batch-panel">
      <div className="batch-panel-row">
        <label className="preset-bar-select-label">
          <span>프리셋</span>
          <select
            value={selectedPresetName ?? ""}
            onChange={(e) => setSelectedPresetName(e.currentTarget.value)}
            disabled={presets.length === 0}
          >
            {presets.length === 0 && <option value="">불러오는 중...</option>}
            {presets.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <label className="batch-output-radio">
          <input
            type="radio"
            checked={outputMode === "sameFolder"}
            onChange={() => setOutputMode("sameFolder")}
          />
          각 원본과 같은 폴더
        </label>
        <label className="batch-output-radio">
          <input type="radio" checked={outputMode === "customDir"} onChange={() => setOutputMode("customDir")} />
          폴더 선택...
        </label>
        {outputMode === "customDir" && (
          <>
            <button type="button" onClick={() => void handlePickOutputDir()}>
              폴더 선택
            </button>
            {outputDir && (
              <span className="batch-output-dir" title={outputDir}>
                {outputDir}
              </span>
            )}
          </>
        )}

        <button type="button" onClick={selectAll}>
          전체 선택
        </button>
        <button type="button" onClick={selectNone}>
          전체 해제
        </button>
        <button type="button" onClick={() => void handleRunClick()} disabled={!selectedPreset || running || selectedPaths.size === 0}>
          {running ? "실행 중..." : "배치 실행"}
        </button>
      </div>

      <div className="batch-file-list">
        {files.length === 0 ? (
          <p className="batch-empty">파일 패널에 추가된 파일이 없습니다.</p>
        ) : (
          files.map((f) => (
            <label key={f.path} className="batch-file-item">
              <input type="checkbox" checked={selectedPaths.has(f.path)} onChange={() => toggleSelected(f.path)} />
              <span title={f.path}>{fileName(f.path)}</span>
            </label>
          ))
        )}
      </div>

      {running && (
        <div className="export-progress">
          <div className="export-progress-bar">
            <div
              className="export-progress-fill"
              style={{ width: progress && progress.total > 0 ? `${(progress.current / progress.total) * 100}%` : "0%" }}
            />
          </div>
          <span className="export-progress-label">
            {progress
              ? `${progress.path ? fileName(progress.path) + " - " : ""}${progress.stage} (${progress.current}/${progress.total})`
              : "실행 중..."}
          </span>
        </div>
      )}

      {results && (
        <table className="batch-results-table">
          <thead>
            <tr>
              <th>파일</th>
              <th>결과</th>
              <th>레이어 수</th>
              <th>출력 경로</th>
            </tr>
          </thead>
          <tbody>
            {results.map((r, i) => (
              <Fragment key={r.path}>
                <tr className={r.ok ? "batch-row-ok" : "batch-row-fail"}>
                  <td title={r.path}>{fileName(r.path)}</td>
                  <td>
                    {r.ok ? "성공" : (
                      <>
                        실패{" "}
                        <button type="button" onClick={() => toggleExpanded(i)}>
                          {expandedRows.has(i) ? "접기" : "자세히"}
                        </button>
                      </>
                    )}
                  </td>
                  <td>{r.layerCount ?? "-"}</td>
                  <td title={r.outputPath}>{r.outputPath ? fileName(r.outputPath) : "-"}</td>
                </tr>
                {!r.ok && expandedRows.has(i) && r.error && (
                  <tr className="batch-row-detail">
                    <td colSpan={4}>
                      <p className="error-card-message">{r.error.message}</p>
                      <pre className="error-card-traceback">{r.error.traceback}</pre>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}

      {pendingRun && (
        <div
          className="modal-overlay"
          onClick={(e) => {
            e.stopPropagation();
            setPendingRun(null);
          }}
        >
          <div className="modal-card batch-conflict-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>이미 존재하는 파일 {pendingRun.conflicts.length}개</h3>
            <ul className="batch-conflict-list">
              {pendingRun.conflicts.map((c) => (
                <li key={c} title={c}>
                  {fileName(c)}
                </li>
              ))}
            </ul>
            <p>덮어쓰기를 진행하시겠습니까?</p>
            <div className="modal-actions">
              <button type="button" onClick={() => setPendingRun(null)}>
                취소
              </button>
              <button
                type="button"
                onClick={() => {
                  const r = pendingRun;
                  setPendingRun(null);
                  void runBatch(r.paths, r.preset, r.outputDir, true);
                }}
              >
                덮어쓰기 진행
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
