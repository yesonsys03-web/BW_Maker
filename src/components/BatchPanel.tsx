import { Fragment, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { findConflicts, planBatchOutputs } from "../lib/batch";
import { batchRun, onEngineEvent, pathsExist } from "../lib/engine";
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

/** 중지하고 남은 실행. 재개가 그대로 이어받도록 원래 설정을 함께 든다. */
interface StoppedRun {
  paths: string[];
  preset: Preset;
  outputDir: string | null;
  /** 시작할 때 사람이 고른 덮어쓰기 여부. 재개가 그것을 바꾸면 안 된다. */
  overwrite: boolean;
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
  /** 지금까지 몇 파일을 끝냈는지. 파일 안의 stage 진행과 별개다. */
  const [fileProgress, setFileProgress] = useState<{ done: number; total: number } | null>(null);
  /**
   * 중지를 눌렀지만 아직 안 멈춘 상태. 파일 하나는 한 번의 RPC라 중간에 끊을 수
   * 없으므로, 누른 뒤 그 파일이 끝날 때까지 몇 분이 걸릴 수 있다 — 아무 반응이
   * 없으면 버튼이 안 먹은 것으로 보이므로 문구로 알린다.
   */
  const [stopping, setStopping] = useState(false);
  const stopRef = useRef(false);
  /** 중지하고 남은 것. 재개가 여기서 이어받는다. 취소하면 버린다. */
  const [stopped, setStopped] = useState<StoppedRun | null>(null);

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
    try {
      const dir = await open({ directory: true });
      if (!dir) return;
      setOutputDir(Array.isArray(dir) ? dir[0] : dir);
    } catch (e) {
      onError("출력 폴더 선택 실패", toEngineError(e));
    }
  }

  /**
   * 파일을 하나씩 돌린다.
   *
   * 예전에는 목록 전체를 batchRun 한 번에 넘겼다. 그러면 엔진이 수십 분간
   * stdin을 읽지 않으므로 취소 요청이 파이프에 앉은 채로 남아 — 중지가 구조적으로
   * 불가능했고, 그동안 사람이 누른 미리보기·레이어 조작도 전부 그 뒤에 줄을 섰다.
   *
   * 한 파일씩 부르면 파일 경계마다 엔진이 비므로 셋이 한꺼번에 풀린다: 중지가
   * 듣고, 그 틈에 사람이 누른 것이 처리되고, 진행이 파일 단위로 보인다. 엔진은
   * 그대로다 — run_batch는 원래 경로 목록을 도는 루프였고, 목록이 하나로 줄었을
   * 뿐이다.
   */
  async function runBatch(
    paths: string[],
    preset: Preset,
    dir: string | null,
    overwrite: boolean,
    { append = false }: { append?: boolean } = {}
  ) {
    setRunning(true);
    setStopped(null);
    setStopping(false);
    stopRef.current = false;
    if (!append) {
      setResults(null);
      setExpandedRows(new Set());
    }
    setProgress(null);
    const collected: BatchItemResult[] = append ? [...(results ?? [])] : [];
    try {
      for (let i = 0; i < paths.length; i += 1) {
        if (stopRef.current) {
          // 남은 것을 들고 있어야 재개가 이어받는다.
          setStopped({ paths: paths.slice(i), preset, outputDir: dir, overwrite });
          break;
        }
        setFileProgress({ done: i, total: paths.length });
        const { results: one } = await batchRun([paths[i]], preset, dir, overwrite);
        collected.push(...one);
        // 파일마다 표를 갱신한다 — 끝까지 기다려야 아무것도 안 보이면, 무엇이
        // 실패했는지 알기까지 한 시간을 기다리게 된다.
        setResults([...collected]);
      }
    } catch (e) {
      onError("배치 실행 실패", toEngineError(e));
    } finally {
      setRunning(false);
      setStopping(false);
      setProgress(null);
      setFileProgress(null);
    }
  }

  function handleStop() {
    stopRef.current = true;
    setStopping(true);
  }

  async function handleRunClick() {
    if (!selectedPreset || running) return;
    try {
      const paths = files.filter((f) => selectedPaths.has(f.path)).map((f) => f.path);
      if (paths.length === 0) return;
      const dir = outputMode === "customDir" ? outputDir : null;
      if (outputMode === "customDir" && !dir) {
        onError("배치 실행 실패", { message: "출력 폴더를 선택하세요.", traceback: "" });
        return;
      }

      const planned = planBatchOutputs(paths, dir, selectedPreset.outputSuffix);
      // paths_exist (not plugin-fs's exists) — batch outputs routinely land
      // outside the AppData scope plugin-fs is capability-restricted to.
      const flags = await pathsExist(planned.map((p) => p.outputPath));
      const flagByPath = new Map(planned.map((p, i) => [p.outputPath, flags[i]]));
      const conflicts = await findConflicts(planned, async (p) => flagByPath.get(p) ?? false);
      if (conflicts.length > 0) {
        setPendingRun({ paths, preset: selectedPreset, outputDir: dir, conflicts });
        return;
      }
      await runBatch(paths, selectedPreset, dir, false);
    } catch (e) {
      onError("배치 실행 실패", toEngineError(e));
    }
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
            {/* 막대는 파일 수로 그린다. 파일 안의 stage 진행은 파일마다 길이가 달라
                막대가 되감기는 것처럼 보이므로 문구로만 보인다. */}
            <div
              className="export-progress-fill"
              style={{
                width: fileProgress && fileProgress.total > 0
                  ? `${(fileProgress.done / fileProgress.total) * 100}%`
                  : "0%",
              }}
            />
          </div>
          <div className="batch-progress-row">
            <span className="export-progress-label">
              {fileProgress ? `파일 ${fileProgress.done}/${fileProgress.total}` : "실행 중..."}
              {progress
                ? ` — ${progress.path ? fileName(progress.path) + " " : ""}${progress.stage} (${progress.current}/${progress.total})`
                : ""}
            </span>
            <button type="button" onClick={handleStop} disabled={stopping}>
              {stopping ? "현재 파일 마치는 중..." : "중지"}
            </button>
          </div>
        </div>
      )}

      {stopped && !running && (
        <div className="batch-progress-row">
          <span className="export-progress-label">중지됨 — 남은 파일 {stopped.paths.length}개</span>
          <button
            type="button"
            onClick={() =>
              void runBatch(stopped.paths, stopped.preset, stopped.outputDir, stopped.overwrite, { append: true })
            }
          >
            재개
          </button>
          {/* 취소는 남은 목록을 버리는 것뿐이다. 이미 나간 산출물은 그대로 둔다 —
              지우는 것은 되돌릴 수 없고, 어느 것이 이번 실행의 것인지도 화면이
              단정할 수 없다. */}
          <button type="button" onClick={() => setStopped(null)}>
            취소
          </button>
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
