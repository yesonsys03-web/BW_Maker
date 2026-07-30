import { useEffect, useState, type DragEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { FileEntry, FileStatus } from "../state/appStore";

interface FilePanelProps {
  files: FileEntry[];
  activePath: string | null;
  onAddFiles: (paths: string[]) => void;
  onSelectFile: (path: string) => void;
  onRemoveFile: (path: string) => void;
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

export function FilePanel({ files, activePath, onAddFiles, onSelectFile, onRemoveFile }: FilePanelProps) {
  const [isDragOver, setIsDragOver] = useState(false);

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
          const psdPaths = payload.paths.filter((p) => p.toLowerCase().endsWith(".psd"));
          if (psdPaths.length > 0) onAddFiles(psdPaths);
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
  }, [onAddFiles]);

  async function handleBrowse() {
    const selection = await open({
      multiple: true,
      filters: [{ name: "Photoshop", extensions: ["psd"] }],
    });
    if (!selection) return;
    const paths = Array.isArray(selection) ? selection : [selection];
    if (paths.length > 0) onAddFiles(paths);
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
    if (paths.length > 0) onAddFiles(paths);
  }

  return (
    <div className="file-panel">
      <div className="file-panel-header">
        <span>파일</span>
        <button type="button" onClick={handleBrowse}>
          + 추가
        </button>
      </div>
      <div
        className={`file-drop-zone${isDragOver ? " drag-over" : ""}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {files.length === 0 ? (
          <p className="file-drop-hint">PSD 파일을 여기로 끌어다 놓거나 위의 + 추가 버튼을 사용하세요.</p>
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
    </div>
  );
}
