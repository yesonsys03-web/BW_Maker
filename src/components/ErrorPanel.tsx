import type { ErrorEntry } from "../state/appStore";

function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

interface ErrorPanelProps {
  errors: ErrorEntry[];
  onDismiss: (index: number) => void;
  /** 카드가 이름을 댄 파일로 옮겨간다. 이름을 읽고 목록에서 다시 찾는 수고를 없앤다. */
  onSelectFile: (path: string) => void;
}

/**
 * Stack of engine/domain errors. Every EngineRpcError surfaced anywhere in
 * the app (open/preset/export/merge/...) must land here with its full
 * traceback — never absorbed or logged-only.
 */
export function ErrorPanel({ errors, onDismiss, onSelectFile }: ErrorPanelProps) {
  if (errors.length === 0) return null;

  return (
    <div className="error-panel" role="alert">
      {errors.map((entry, index) => (
        <div className="error-card" key={`${entry.title}-${index}`}>
          <div className="error-card-header">
            <span className="error-card-title">{entry.title}</span>
            <button
              type="button"
              className="error-card-close"
              onClick={() => onDismiss(index)}
              aria-label="오류 닫기"
            >
              ×
            </button>
          </div>
          <p className="error-card-message">{entry.error.message}</p>
          {entry.files && entry.files.length > 0 && (
            <div className="error-card-files">
              {/* 본문에 적힌 순서와 같다. 카드를 눈으로 훑다가 바로 그 자리를 누르게 된다. */}
              {entry.files.map((path) => (
                <button
                  key={path}
                  type="button"
                  className="error-card-file"
                  onClick={() => onSelectFile(path)}
                  title={path}
                >
                  {fileName(path)}
                </button>
              ))}
            </div>
          )}
          {entry.error.traceback && <pre className="error-card-traceback">{entry.error.traceback}</pre>}
        </div>
      ))}
    </div>
  );
}
