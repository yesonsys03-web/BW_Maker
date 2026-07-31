import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { loadPngDataUrl, renderDocumentPreview, renderPreview } from "../lib/engine";
import {
  PREVIEW_BACKGROUNDS,
  PREVIEW_BACKGROUND_LABELS,
  PREVIEW_BACKGROUND_STORAGE_KEY,
  isDocumentView,
  nextScale,
  parsePreviewBackground,
  toEngineError,
  visibleIdsForPreview,
  type PreviewBackground,
} from "../lib/preview";
import { withEvictedSessionRetry } from "../lib/sessionRetry";
import type { FileStatus } from "../state/appStore";
import type { EngineError, OpenResult, TreeNode } from "../lib/types";

interface PreviewCanvasProps {
  sessionId: number | undefined;
  path: string | undefined;
  status: FileStatus | undefined;
  tree: TreeNode[] | undefined;
  includedIds: number[];
  previewHiddenIds: number[];
  /**
   * 선택된 프리셋의 라인 색 통일 설정. 내보내기 미리보기는 실제 산출물과 같아야
   * 하므로 여기에도 반영한다. 원본 보기(문서 미리보기)에는 적용하지 않는다 —
   * 그건 파일 자체를 보여주는 화면이다.
   */
  lineColor: string | null;
  onSessionRefreshed: (path: string, result: OpenResult) => void;
  onError: (title: string, error: EngineError) => void;
}

/**
 * 연속된 토글을 한 번의 렌더로 묶는 대기 시간. 400ms였던 값인데, 그때는 렌더
 * 한 번이 수십 초라 최대한 묶는 것이 이득이었다. 지금은 캐시된 타일 합성이라
 * 50ms 안에 끝나므로 디바운스가 오히려 체감 지연의 대부분이 된다. 빠르게
 * 연타하는 경우만 묶일 정도로 줄인다.
 */
const DEBOUNCE_MS = 120;
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
  status,
  tree,
  includedIds,
  previewHiddenIds,
  lineColor,
  onSessionRefreshed,
  onError,
}: PreviewCanvasProps) {
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  // 배경 선택은 파일/세션이 아니라 사람에게 붙는 설정이므로 파일 전환·재시작을
  // 넘어 유지된다. 프리셋(appdata JSON)과 달리 내보내기 결과에 아무 영향이 없는
  // 순수 표시 설정이라 localStorage에 둔다.
  const [background, setBackground] = useState<PreviewBackground>(() =>
    parsePreviewBackground(window.localStorage.getItem(PREVIEW_BACKGROUND_STORAGE_KEY))
  );

  function chooseBackground(next: PreviewBackground) {
    setBackground(next);
    window.localStorage.setItem(PREVIEW_BACKGROUND_STORAGE_KEY, next);
  }

  const requestIdRef = useRef(0);
  const draggingRef = useRef<{ x: number; y: number } | null>(null);
  const wheelCleanupRef = useRef<(() => void) | null>(null);
  // Latest sessionId, read at debounce-timer-fire time rather than captured
  // at effect-setup time — see the render effect below for why.
  const sessionIdRef = useRef(sessionId);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  const visibleIds = useMemo(
    () => (tree ? visibleIdsForPreview(tree, includedIds, previewHiddenIds) : []),
    [tree, includedIds, previewHiddenIds]
  );

  const documentView = useMemo(() => isDocumentView(tree, visibleIds), [tree, visibleIds]);

  // Switching files (a new `path`) invalidates anything in flight/shown and
  // resets the view. Keyed on `path`, not `sessionId`: a transparent
  // session-refresh reopen (LRU eviction, see sessionRetry.ts) changes
  // sessionId for the *same* file and must NOT reset zoom/pan, nor bump
  // requestIdRef and invalidate its own in-flight retry (which would discard
  // the reopened render and cause a duplicate render_preview call).
  useEffect(() => {
    requestIdRef.current += 1;
    setImgSrc(null);
    setLoading(false);
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, [path]);

  // `sessionId` is deliberately NOT a dependency here (read via sessionIdRef
  // inside the timer instead). withEvictedSessionRetry's reopen already gets
  // a fresh sessionId directly from its own openPsd call and retries with it
  // — it doesn't need this effect to re-run to pick that up. If sessionId
  // *were* a dependency, a mid-flight session refresh would (a) not change
  // path/tree/visibleIds's content, yet (b) still change tree's array
  // identity, re-triggering this effect and scheduling a second, fully
  // redundant render_preview call ~400ms after the retry's own successful
  // one — a real duplicate composite render on a large file, even without
  // the view-reset bug above. Reading the ref at fire time instead keeps the
  // effect reactive to genuine visibility/file changes only.
  useEffect(() => {
    if (!path) return;
    if (visibleIds.length === 0) {
      requestIdRef.current += 1; // invalidate any in-flight render from a prior toggle
      setImgSrc(null);
      setLoading(false);
      return;
    }

    // 문서 보기는 저장된 병합 이미지를 그대로 쓰므로 즉시 끝난다. 파일을 연
    // 직후가 바로 이 경우라, 여기에 디바운스를 걸면 첫 화면만 늦어진다.
    // 합성 미리보기는 연속 토글을 묶어야 하므로 디바운스를 유지한다.
    const delay = documentView ? 0 : DEBOUNCE_MS;

    const timer = window.setTimeout(() => {
      const sid = sessionIdRef.current;
      if (!sid) return;
      const requestId = ++requestIdRef.current;
      setLoading(true);
      void (async () => {
        try {
          const { pngPath } = await withEvictedSessionRetry(
            path,
            sid,
            (s) =>
              documentView
                ? renderDocumentPreview(s, PREVIEW_MAX_SIZE)
                : renderPreview(s, visibleIds, PREVIEW_MAX_SIZE, lineColor),
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
    }, delay);

    return () => window.clearTimeout(timer);
  }, [path, visibleIds, documentView, lineColor, onSessionRefreshed, onError]);

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

  if (status === "processing") {
    return <div className="preview-canvas preview-empty">여는 중...</div>;
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
        className={`preview-viewport preview-bg-${background}`}
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
      <div
        className="preview-mode-badge"
        title={
          documentView
            ? "저장된 원본 이미지입니다. 레이어를 고르면 내보내기 결과 미리보기로 바뀝니다."
            : "선택한 레이어만 쌓아 올린 결과 — 내보낸 PSD가 이렇게 보입니다. 원본의 블렌드 모드·클리핑은 내보내기에서 제거되므로 여기에도 적용되지 않습니다."
        }
      >
        {documentView ? "원본" : "내보내기 미리보기"}
      </div>
      <div className="preview-bg-toggle" role="group" aria-label="미리보기 배경">
        {PREVIEW_BACKGROUNDS.map((bg) => (
          <button
            key={bg}
            type="button"
            className={bg === background ? "active" : undefined}
            aria-pressed={bg === background}
            onClick={() => chooseBackground(bg)}
          >
            {PREVIEW_BACKGROUND_LABELS[bg]}
          </button>
        ))}
      </div>
      {loading && (
        <div className="preview-spinner-overlay" role="status" aria-label="렌더링 중">
          <div className="preview-spinner" />
        </div>
      )}
    </div>
  );
}
