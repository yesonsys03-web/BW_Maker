import type { ErrorEntry } from "../state/appStore";

interface ErrorPanelProps {
  errors: ErrorEntry[];
  onDismiss: (index: number) => void;
}

/**
 * Stack of engine/domain errors. Every EngineRpcError surfaced anywhere in
 * the app (open/preset/export/merge/...) must land here with its full
 * traceback — never absorbed or logged-only.
 */
export function ErrorPanel({ errors, onDismiss }: ErrorPanelProps) {
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
          {entry.error.traceback && <pre className="error-card-traceback">{entry.error.traceback}</pre>}
        </div>
      ))}
    </div>
  );
}
