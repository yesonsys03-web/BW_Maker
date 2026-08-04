import { useCallback, useEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { collectPsdFiles } from "../lib/engine";
import { describeScan } from "../lib/fileScan";
import { toEngineError } from "../lib/preview";
import type { EngineError } from "../lib/types";
import type { FileEntry, FileStatus } from "../state/appStore";

interface LoadBar {
  done: number;
  total: number;
  label: string;
}

interface FilePanelProps {
  files: FileEntry[];
  activePath: string | null;
  /** 파일을 여는 큐의 진행 상황. 안 돌고 있으면 null. */
  loadProgress: LoadBar | null;
  /**
   * 미리보기를 미리 만들어 두는 큐의 진행 상황. 여는 작업이 끝난 뒤에 도는
   * 뒷정리라 진행바는 같은 자리에 쓰되 문구로 구분한다 — 이건 기다릴 필요가
   * 없고, 도는 중에도 파일을 눌러 작업할 수 있다.
   */
  prefetchProgress: LoadBar | null;
  /**
   * 중지된 배경 작업이 남아 있을 때 그것이 무엇인지("남은 파일 22개"). 없으면 null.
   * 진행바와 같은 자리에 재개 버튼을 띄우는 근거다 — 중지를 누른 그 자리에서
   * 되돌릴 수 있어야 한다. 이게 없으면 다시 시작하는 방법이 "이미 있는 폴더를
   * 다시 추가한다"뿐인데, 그건 아무도 짐작할 수 없고 보상도 "이미 목록에
   * 있습니다" 카드 한 장뿐이다.
   */
  stopped: string | null;
  /**
   * 파일별로 내보내기에 나갈 장수(병합까지 끝난 뒤). splitLayers를 켜두면 그대로
   * 출력 파일 수다. 아직 프리셋이 안 걸린 파일은 없다.
   *
   * 이걸 행에 그냥 다는 것이 요점이다. 예전에는 이상해 보이는 파일만 골라 카드로
   * 띄웠는데, ErrorPanel에 뜨니 형태가 "뭔가 잘못됐다"였고 정작 나머지 파일의
   * 장수는 감췄다. 스물넷을 한눈에 훑어 이상한 것을 직접 고르는 편이, 무엇이
   * 이상한지를 임계값으로 정해두는 것보다 낫다.
   */
  entryCounts: Record<string, number>;
  /** 오른쪽 모서리의 폭 조절 손잡이. 레이어 패널·아래 패널과 같은 방식이다. */
  onResizeStart: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onResizeMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onResizeEnd: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onResizeReset: () => void;
  onAddFiles: (paths: string[]) => void;
  onSelectFile: (path: string) => void;
  onRemoveFile: (path: string) => void;
  /** 목록을 통째로 비운다. 폴더를 갈아끼울 때 쓴다. */
  onClearFiles: () => void;
  onCancelLoad: () => void;
  onResume: () => void;
  onError: (title: string, error: EngineError) => void;
}

const STATUS_LABEL: Record<FileStatus, string> = {
  idle: "대기",
  open: "열림",
  processing: "처리중",
  done: "완료",
  error: "실패",
};

function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function ProgressBar({ progress, onCancel }: { progress: LoadBar; onCancel: () => void }) {
  return (
    <div className="file-load-progress">
      <div className="export-progress-bar">
        <div
          className="export-progress-fill"
          style={{ width: progress.total > 0 ? `${(progress.done / progress.total) * 100}%` : "0%" }}
        />
      </div>
      <div className="file-load-progress-row">
        <span className="export-progress-label">
          {progress.label}... {progress.done}/{progress.total}
        </span>
        <button type="button" onClick={onCancel}>
          중지
        </button>
      </div>
    </div>
  );
}

/** 진행바와 같은 자리를 쓰는 "중지됨" 표시. 막대는 없고 재개 버튼만 있다. */
function StoppedBar({ label, onResume }: { label: string; onResume: () => void }) {
  return (
    <div className="file-load-progress">
      <div className="file-load-progress-row">
        <span className="export-progress-label">중지됨 — {label}</span>
        <button type="button" onClick={onResume}>
          재개
        </button>
      </div>
    </div>
  );
}

export function FilePanel({
  files,
  activePath,
  loadProgress,
  prefetchProgress,
  stopped,
  entryCounts,
  onResizeStart,
  onResizeMove,
  onResizeEnd,
  onResizeReset,
  onAddFiles,
  onSelectFile,
  onRemoveFile,
  onClearFiles,
  onCancelLoad,
  onResume,
  onError,
}: FilePanelProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  /**
   * 사람이 직접 손댄 파일이 있는지. 프리셋 자동 적용만 걸린 파일은 여기 안 든다
   * (FileEntry.edited 주석 참고) — 폴더를 갈아끼울 때마다 확인창이 뜨면 그 창은
   * 곧 아무도 안 읽는 창이 된다.
   */
  const hasEdits = files.some((f) => f.edited === true);

  function handleClear() {
    if (hasEdits) {
      setConfirmClear(true);
      return;
    }
    onClearFiles();
  }

  // The drag/drop subscription below is registered once and closes over
  // addPaths, so addPaths must not change identity every time a file lands in
  // the list — otherwise every add tears down and re-registers the listener.
  // The current list is read through this ref instead of a dependency.
  const filesRef = useRef(files);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);

  // Folder picking and dropping funnel through here: collect_psd_files walks
  // folders recursively, passes .psd files through, and drops the rest, so a
  // folder, a pile of files, or both at once need no separate handling.
  const addPaths = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      setScanning(true);
      try {
        const scan = await collectPsdFiles(paths);
        const existing = new Set(filesRef.current.map((f) => f.path));
        const alreadyPresent = scan.files.filter((p) => existing.has(p)).length;
        if (scan.files.length > 0) onAddFiles(scan.files);
        // Nothing found, a capped walk, an unreadable folder: the list alone
        // can't say any of that, so it goes to the error panel.
        const notice = describeScan(scan, alreadyPresent);
        if (notice) onError("파일 추가", { message: notice, traceback: "" });
      } catch (e) {
        onError("파일 추가 실패", toEngineError(e));
      } finally {
        setScanning(false);
      }
    },
    [onAddFiles, onError]
  );

  // Primary drop path: Tauri's webview-level drag/drop event, which carries
  // real filesystem paths regardless of whether the browser's native HTML5
  // DnD is enabled for this window.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          setIsDragOver(true);
        } else if (payload.type === "drop") {
          setIsDragOver(false);
          void addPaths(payload.paths);
        } else {
          setIsDragOver(false);
        }
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // Not running inside a Tauri webview (e.g. a plain browser preview) —
        // the HTML5 onDrop fallback below still covers that case.
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [addPaths]);

  async function handleBrowse() {
    try {
      const selection = await open({
        multiple: true,
        filters: [{ name: "Photoshop", extensions: ["psd"] }],
      });
      if (!selection) return;
      const paths = Array.isArray(selection) ? selection : [selection];
      if (paths.length > 0) onAddFiles(paths);
    } catch (e) {
      onError("파일 선택 실패", toEngineError(e));
    }
  }

  // Picking a folder pulls in every .psd beneath it, sub-folders included —
  // work that arrives split one folder per cut goes in with a single pick.
  async function handleBrowseFolder() {
    try {
      const selection = await open({ directory: true, multiple: true });
      if (!selection) return;
      const dirs = Array.isArray(selection) ? selection : [selection];
      await addPaths(dirs);
    } catch (e) {
      onError("폴더 선택 실패", toEngineError(e));
    }
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragOver(true);
  }

  function handleDragLeave() {
    setIsDragOver(false);
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragOver(false);
    // Fallback for plain-browser HTML5 drag & drop; real Tauri drops are
    // handled by the onDragDropEvent subscription above.
    const paths: string[] = [];
    for (const file of Array.from(e.dataTransfer.files)) {
      const withPath = file as File & { path?: string };
      if (withPath.path) paths.push(withPath.path);
    }
    void addPaths(paths);
  }

  return (
    <div className="file-panel">
      <div
        className="file-resize-handle"
        role="separator"
        aria-label="파일 패널 폭 조절"
        aria-orientation="vertical"
        onPointerDown={onResizeStart}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeEnd}
        onPointerCancel={onResizeEnd}
        onDoubleClick={onResizeReset}
        title="끌어서 폭 조절 (더블클릭으로 초기화)"
      />
      <div className="file-panel-header">
        <span>파일</span>
        <div className="file-panel-actions">
          <button type="button" onClick={() => void handleBrowse()} disabled={scanning}>
            + 추가
          </button>
          <button
            type="button"
            onClick={handleClear}
            disabled={files.length === 0}
            title="목록을 비웁니다 (엔진 세션도 닫습니다)"
          >
            비우기
          </button>
          <button
            type="button"
            onClick={() => void handleBrowseFolder()}
            disabled={scanning}
            title="폴더 안의 PSD를 하위 폴더까지 모두 추가합니다"
          >
            {scanning ? "읽는 중..." : "+ 폴더"}
          </button>
        </div>
      </div>
      {loadProgress ?? prefetchProgress ? (
        <ProgressBar progress={(loadProgress ?? prefetchProgress)!} onCancel={onCancelLoad} />
      ) : stopped ? (
        <StoppedBar label={stopped} onResume={onResume} />
      ) : null}
      <div
        className={`file-drop-zone${isDragOver ? " drag-over" : ""}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {files.length === 0 ? (
          <p className="file-drop-hint">
            PSD 파일이나 폴더를 여기로 끌어다 놓거나 위의 + 추가 / + 폴더 버튼을 사용하세요.
          </p>
        ) : (
          <ul className="file-list">
            {files.map((file) => (
              <li key={file.path} className="file-list-row">
                <button
                  type="button"
                  className={`file-list-item${file.path === activePath ? " active" : ""}`}
                  onClick={() => onSelectFile(file.path)}
                >
                  <span className="file-name" title={file.path}>
                    {fileName(file.path)}
                  </span>
                  <span className={`status-badge status-${file.status}`}>{STATUS_LABEL[file.status]}</span>
                  {entryCounts[file.path] !== undefined && (
                    <span className="file-entry-count" title="내보내기에 나갈 장수">
                      {entryCounts[file.path]}장
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  className="file-list-remove"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemoveFile(file.path);
                  }}
                  disabled={file.status === "processing"}
                  aria-label={`${fileName(file.path)} 목록에서 제거`}
                  title="목록에서 제거 (엔진 세션도 닫습니다)"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {confirmClear && (
        <div
          className="modal-overlay"
          onClick={(e) => {
            e.stopPropagation();
            setConfirmClear(false);
          }}
        >
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>목록을 비울까요?</h3>
            <p>
              직접 편집한 파일이 {files.filter((f) => f.edited === true).length}개 있습니다. 비우면 그
              편집(병합·이름변경 등)은 되돌릴 수 없습니다. 원본 PSD는 그대로입니다.
            </p>
            <div className="modal-actions">
              <button type="button" onClick={() => setConfirmClear(false)}>
                취소
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmClear(false);
                  onClearFiles();
                }}
              >
                비우기
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
