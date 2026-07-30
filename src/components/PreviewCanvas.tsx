import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { loadPngDataUrl, renderPreview } from "../lib/engine";
import { nextScale, toEngineError, visibleIdsForPreview } from "../lib/preview";
import { withEvictedSessionRetry } from "../lib/sessionRetry";
import type { EngineError, OpenResult, TreeNode } from "../lib/types";

interface PreviewCanvasProps {
  sessionId: number | undefined;
  path: string | undefined;
  tree: TreeNode[] | undefined;
  includedIds: number[];
  previewHiddenIds: number[];
  onSessionRefreshed: (path: string, result: OpenResult) => void;
  onError: (title: string, error: EngineError) => void;
}

const DEBOUNCE_MS = 400;
const PREVIEW_MAX_SIZE = 1500;

/**
 * Center preview canvas. Recomputes visibleIds whenever activePath / eye
 * toggle / include toggle changes (via tree, includedIds, previewHiddenIds
 * reference changes), waits DEBOUNCE_MS, then renders via the engine. A
 * monotonically increasing request id guards against a stale response
 * (e.g. from a render superseded by a later toggle) overwriting a newer
 * frame or clobbering a newer request's loading state.
 */
export function PreviewCanvas({
  sessionId,
  path,
  tree,
  includedIds,
  previewHiddenIds,
  onSessionRefreshed,
  onError,
}: PreviewCanvasProps) {
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  const requestIdRef = useRef(0);
  const draggingRef = useRef<{ x: number; y: number } | null>(null);
  const wheelCleanupRef = useRef<(() => void) | null>(null);

  const visibleIds = useMemo(
    () => (tree ? visibleIdsForPreview(tree, includedIds, previewHiddenIds) : []),
    [tree, includedIds, previewHiddenIds]
  );

  // Switching files invalidates anything in flight/shown and resets the view.
  useEffect(() => {
    requestIdRef.current += 1;
    setImgSrc(null);
    setLoading(false);
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !path) return;
    if (visibleIds.length === 0) {
      requestIdRef.current += 1; // invalidate any in-flight render from a prior toggle
      setImgSrc(null);
      setLoading(false);
      return;
    }

    const timer = window.setTimeout(() => {
      const requestId = ++requestIdRef.current;
      setLoading(true);
      void (async () => {
        try {
          const { pngPath } = await withEvictedSessionRetry(
            path,
            sessionId,
            (sid) => renderPreview(sid, visibleIds, PREVIEW_MAX_SIZE),
            (result) => onSessionRefreshed(path, result)
          );
          const dataUrl = await loadPngDataUrl(pngPath);
          if (requestIdRef.current !== requestId) return; // superseded by a newer request
          setImgSrc(dataUrl);
          setLoading(false);
        } catch (e) {
          if (requestIdRef.current !== requestId) return;
          setLoading(false);
          onError("미리보기 렌더링 실패", toEngineError(e));
        }
      })();
    }, DEBOUNCE_MS);

    return () => window.clearTimeout(timer);
  }, [sessionId, path, visibleIds, onSessionRefreshed, onError]);

  // Callback ref (not a plain ref + mount-only effect): the viewport div only
  // exists once sessionId/visibleIds make this component render past the
  // early returns below, so a `useEffect(..., [])` reading a plain ref would
  // fire while the ref is still null on first mount (no file open yet) and
  // never re-attach once the div actually appears. The callback ref runs
  // exactly when the DOM node is attached/detached, whenever that happens.
  const viewportCallbackRef = useCallback((el: HTMLDivElement | null) => {
    wheelCleanupRef.current?.();
    wheelCleanupRef.current = null;
    if (!el) return;
    function handleWheel(e: WheelEvent) {
      e.preventDefault();
      setScale((prev) => nextScale(prev, e.deltaY));
    }
    // Non-passive so preventDefault actually stops page scroll/zoom.
    el.addEventListener("wheel", handleWheel, { passive: false });
    wheelCleanupRef.current = () => el.removeEventListener("wheel", handleWheel);
  }, []);

  function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = { x: e.clientX, y: e.clientY };
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    const dx = e.clientX - draggingRef.current.x;
    const dy = e.clientY - draggingRef.current.y;
    draggingRef.current = { x: e.clientX, y: e.clientY };
    setOffset((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
  }

  function handlePointerUp(e: ReactPointerEvent<HTMLDivElement>) {
    draggingRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }

  if (!sessionId) {
    return <div className="preview-canvas preview-empty">왼쪽에서 파일을 선택하세요.</div>;
  }

  if (visibleIds.length === 0) {
    return <div className="preview-canvas preview-empty">표시할 레이어 없음</div>;
  }

  return (
    <div className="preview-canvas">
      <div
        className="preview-viewport"
        ref={viewportCallbackRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {imgSrc && (
          <img
            className="preview-image"
            src={imgSrc}
            alt="미리보기"
            draggable={false}
            style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
          />
        )}
      </div>
      {loading && (
        <div className="preview-spinner-overlay" role="status" aria-label="렌더링 중">
          <div className="preview-spinner" />
        </div>
      )}
    </div>
  );
}
