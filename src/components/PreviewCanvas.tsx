import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { loadPngDataUrl, renderDocumentPreview, renderPreview } from "../lib/engine";
import {
  PREVIEW_BACKGROUNDS,
  PREVIEW_BACKGROUND_LABELS,
  PREVIEW_BACKGROUND_STORAGE_KEY,
  isDocumentView,
  MIN_PREVIEW_SCALE,
  nextScale,
  PREVIEW_MAX_SIZE,
  parsePreviewBackground,
  toEngineError,
  visibleIdsForPreview,
  type PreviewBackground,
} from "../lib/preview";
import { previewCacheKey, type PreviewCache } from "../lib/previewCache";
import { withEvictedSessionRetry } from "../lib/sessionRetry";
import type { FileStatus } from "../state/appStore";
import type { EngineError, OpenResult, TreeNode } from "../lib/types";

interface PreviewCanvasProps {
  sessionId: number | undefined;
  path: string | undefined;
  /**
   * 파일의 수정 시각. 만들어둔 미리보기를 재사용해도 되는지의 기준이라
   * 캐시 키에 들어간다 — 세션 id가 아니라 이 값을 쓰는 이유는 previewCache 참고.
   */
  mtime: number | undefined;
  status: FileStatus | undefined;
  tree: TreeNode[] | undefined;
  includedIds: number[];
  previewHiddenIds: number[];
  soloIds: number[];
  /**
   * 선택된 프리셋의 라인 색 통일 설정. 내보내기 미리보기는 실제 산출물과 같아야
   * 하므로 여기에도 반영한다. 원본 보기(문서 미리보기)에는 적용하지 않는다 —
   * 그건 파일 자체를 보여주는 화면이다.
   */
  lineColor: string | null;
  /**
   * 로드 큐가 도는 동안 참. 그동안은 렌더를 걸지 않는다.
   *
   * 엔진 세션이 두 칸뿐이라, 큐가 파일을 계속 여는 사이에 미리보기가 자기
   * 세션을 되살리려 하면 서로를 밀어낸다 — 합성 한 장에 몇 초가 걸리는 동안
   * 큐는 파일 두 개를 더 열고, 그러면 방금 되살린 세션이 또 사라져 재시도
   * 상한까지 밀린다. 기다렸다가 큐가 끝난 뒤에 한 번 그리는 편이 빠르고,
   * 지금 당장 보고 싶으면 파일 패널의 "중지"로 큐를 세우면 된다.
   */
  paused: boolean;
  /**
   * 렌더된 그림을 담는 캐시. App이 들고 있는 것을 받는다 — 로드가 끝난 뒤 도는
   * 미리보기 준비 큐가 같은 캐시에 미리 채워두기 때문이다. 여기서 따로 만들면
   * 그 준비 결과를 못 보고 클릭할 때마다 다시 합성한다.
   */
  cache: PreviewCache;
  /**
   * 엔진에 렌더를 걸기 시작/끝냈을 때 알린다. 미리보기를 미리 만들어 두는 큐가
   * 이 신호를 보고 비켜선다 — 세션이 두 칸뿐이라 둘이 겹치면 서로의 세션을
   * 밀어내고, 그러다 사람이 지금 보려던 그림이 실패한다.
   */
  onRenderingChange: (busy: boolean) => void;
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
  mtime,
  status,
  tree,
  includedIds,
  previewHiddenIds,
  soloIds,
  lineColor,
  paused,
  cache,
  onRenderingChange,
  onSessionRefreshed,
  onError,
}: PreviewCanvasProps) {
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  /**
   * 지금 그림의 배율이 정해졌는지. 아직이면 그림을 감춘다.
   *
   * 배율은 원본 크기를 알아야 정해지고, 그건 이미지가 로드된 뒤에야 알 수 있다.
   * 그동안 그냥 두면 화면이 한 프레임 1:1로 그려졌다가 줄어들어, 파일을 누를
   * 때마다 깜빡였다. 감췄다가 measureAndFit이 배율과 함께 켜주면 — 두 갱신이
   * 같은 렌더로 묶이므로 — 1:1 프레임이 아예 그려지지 않는다.
   */
  const [fitReady, setFitReady] = useState(false);

  /** 새 그림을 건다. 배율이 다시 정해질 때까지 감춘 채로 둔다. */
  const showImage = useCallback((src: string | null) => {
    setImgSrc(src);
    setFitReady(false);
  }, []);
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
  /**
   * 지금 엔진에 걸려 있는 렌더 수. 정리 함수는 아직 안 터진 디바운스 타이머만
   * 끊으므로, 이미 시작된 렌더 위로 다음 렌더가 겹칠 수 있다. 그때 먼저 끝난
   * 쪽이 곧바로 "안 바쁨"을 알리면, 뒤엣것이 도는 동안 미리보기 준비 큐가
   * 비켜서기를 멈추고 파일을 연다 — onRenderingChange가 막으려던 세션 경합이
   * 그대로 돌아온다. 그래서 하나라도 남아 있으면 바쁜 것으로 본다.
   *
   * requestIdRef로 대신할 수 없다. 그 값은 렌더가 걸리지 않는 경로(빈 집합,
   * 캐시 적중)에서도 올라가므로, 그걸 신호로 삼으면 진행 중인 렌더가 자기
   * 차례를 영영 못 알아보고 "바쁨"이 그대로 남는다.
   */
  const inFlightRef = useRef(0);
  const draggingRef = useRef<{ x: number; y: number } | null>(null);
  const viewportCleanupRef = useRef<(() => void) | null>(null);
  const viewportElRef = useRef<HTMLDivElement | null>(null);
  /** 지금 그려진 이미지의 원본 픽셀 크기. 맞춤 배율을 계산하는 기준이다. */
  const naturalSizeRef = useRef<{ w: number; h: number } | null>(null);
  /**
   * 지금 배율이 "뷰어에 맞춤"에서 온 것인지.
   *
   * 파일을 열면 그림 전체가 한눈에 보여야 한다 — 엔진은 긴 변 1500px로 렌더하므로
   * 원본 크기 그대로 두면 화면 밖으로 넘쳐 사람이 매번 휠로 줄여야 했다.
   *
   * 사람이 휠이나 드래그로 한 번이라도 손대면 이 표시가 내려가고, 그 뒤로는
   * 레이어를 토글해 다시 렌더해도 그 배율을 지킨다 — 확대해서 선을 들여다보는
   * 중에 화면이 제멋대로 되돌아가면 안 된다. 파일을 바꾸면 다시 선다.
   */
  const fittedRef = useRef(true);

  /**
   * 그림 전체가 뷰어에 들어오는 배율로 맞춘다. 원본보다 크게 키우지는 않는다 —
   * 작은 파일을 늘리면 라인이 뭉개지기만 한다.
   */
  const applyFit = useCallback(() => {
    const el = viewportElRef.current;
    const nat = naturalSizeRef.current;
    if (!el || !nat?.w || !nat.h) return;
    const box = Math.min(el.clientWidth / nat.w, el.clientHeight / nat.h);
    if (!Number.isFinite(box) || box <= 0) return;
    fittedRef.current = true;
    setScale(Math.max(MIN_PREVIEW_SCALE, Math.min(1, box)));
    setOffset({ x: 0, y: 0 });
  }, []);

  /** 그림이 붙는(또는 이미 붙어 있는) 순간의 크기를 재고, 아직 맞춤 상태면 맞춘다. */
  const measureAndFit = useCallback(
    (img: HTMLImageElement) => {
      if (img.naturalWidth && img.naturalHeight) {
        naturalSizeRef.current = { w: img.naturalWidth, h: img.naturalHeight };
        if (fittedRef.current) applyFit();
      }
      // 크기를 못 재도 그림은 내보낸다 — 감춘 채로 남는 것이 가장 나쁘다.
      setFitReady(true);
    },
    [applyFit]
  );

  // onLoad만으로는 부족하다. 캐시에서 온 data URL은 ref가 붙는 시점에 이미
  // complete일 수 있고, 그러면 onLoad가 다시 불리지 않아 맞춤이 통째로 건너뛰어진다.
  const imageCallbackRef = useCallback(
    (img: HTMLImageElement | null) => {
      if (img?.complete) measureAndFit(img);
    },
    [measureAndFit]
  );
  // Latest sessionId, read at debounce-timer-fire time rather than captured
  // at effect-setup time — see the render effect below for why.
  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  const visibleIds = useMemo(
    () => (tree ? visibleIdsForPreview(tree, includedIds, previewHiddenIds, soloIds) : []),
    [tree, includedIds, previewHiddenIds, soloIds]
  );

  const documentView = useMemo(() => isDocumentView(tree, visibleIds), [tree, visibleIds]);

  /**
   * 보이는 레이어 집합을 "내용"으로 나타낸 키. 아래 렌더 효과는 visibleIds 배열이
   * 아니라 이 키에 반응한다.
   *
   * 세션이 조용히 재오픈되면(축출 복구) 같은 파일의 tree가 새 배열로 교체된다 —
   * 내용은 한 글자도 안 바뀌는데 정체만 달라진다. 그러면 visibleIds memo가 새로
   * 만들어지고 렌더 효과가 다시 돌고, 그 렌더가 또 축출을 만나 재오픈하고, 그게
   * 다시 tree를 갈아치운다. 파일을 한꺼번에 불러올 때 이 고리가 실제로 돌아서,
   * 파일 85개를 여는 동안 세션을 280번 열었다 — 그 재오픈들이 로드 큐가 방금
   * 연 세션을 계속 밀어내면서 "프리셋 자동 적용 실패"를 만들어냈다.
   */
  const visibleKey = visibleIds.join(",");

  // Switching files (a new `path`) invalidates anything in flight/shown and
  // resets the view. Keyed on `path`, not `sessionId`: a transparent
  // session-refresh reopen (LRU eviction, see sessionRetry.ts) changes
  // sessionId for the *same* file and must NOT reset zoom/pan, nor bump
  // requestIdRef and invalidate its own in-flight retry (which would discard
  // the reopened render and cause a duplicate render_preview call).
  useEffect(() => {
    requestIdRef.current += 1;
    showImage(null);
    setLoading(false);
    setScale(1);
    setOffset({ x: 0, y: 0 });
    // 새 파일이므로 다시 뷰어에 맞춘다. 실제 배율은 그림이 붙으면서 원본 크기를
    // 알게 될 때 정해진다(measureAndFit).
    naturalSizeRef.current = null;
    fittedRef.current = true;
  }, [path, showImage]);

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
    // 큐가 끝나면 paused가 false로 바뀌면서 이 효과가 다시 돌아 그때 그린다.
    if (paused) return;
    if (visibleIds.length === 0) {
      requestIdRef.current += 1; // invalidate any in-flight render from a prior toggle
      showImage(null);
      setLoading(false);
      return;
    }

    // 이미 렌더해 본 조합이면 엔진에 가지 않는다. 파일을 오갈 때 위의 [path]
    // 효과가 화면의 이미지를 버리기 때문에, 이게 없으면 돌아올 때마다 같은
    // 합성을 처음부터 다시 시킨다. 키에 sessionId가 들어 있으므로(previewCache
    // 참조) 살아 있는 바로 그 세션이 만든 그림만 재사용된다.
    const cacheKey = previewCacheKey({ path, mtime }, documentView, visibleIds, lineColor);
    if (cacheKey) {
      const cached = cache.get(cacheKey);
      if (cached !== undefined) {
        // 아직 안 돌아온 이전 요청이 이 그림을 덮어쓰지 못하게 무효화한다.
        requestIdRef.current += 1;
        showImage(cached);
        setLoading(false);
        return;
      }
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
      inFlightRef.current += 1;
      onRenderingChange(true);
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
          // 화면에 못 띄우게 된 결과라도 캐시에는 넣는다 — 이 조합으로 돌아오면
          // (토글을 되돌리거나 파일을 오가면) 그때 그대로 쓴다. 키는 파일의 수정
          // 시각 기준이라, 중간에 축출-재오픈이 끼어 세션 id가 바뀌어도 그대로
          // 유효하다.
          if (cacheKey) cache.set(cacheKey, dataUrl);
          if (requestIdRef.current !== requestId) return; // superseded by a newer request
          showImage(dataUrl);
          setLoading(false);
        } catch (e) {
          if (requestIdRef.current !== requestId) return;
          setLoading(false);
          onError("미리보기 렌더링 실패", toEngineError(e));
        } finally {
          inFlightRef.current -= 1;
          if (inFlightRef.current === 0) onRenderingChange(false);
        }
      })();
    }, delay);

    return () => window.clearTimeout(timer);
    // visibleIds 대신 visibleKey에 의존한다 — 키가 같으면 내용이 같으므로 효과가
    // 들고 있는 배열이 한 세대 옛것이어도 렌더 결과는 동일하다. 위 visibleKey의
    // 주석에 왜 배열 정체로는 안 되는지 적어두었다.
  }, [path, mtime, visibleKey, documentView, lineColor, paused, cache, showImage, onRenderingChange, onSessionRefreshed, onError]);

  // Callback ref (not a plain ref + mount-only effect): the viewport div only
  // exists once sessionId/visibleIds make this component render past the
  // early returns below, so a `useEffect(..., [])` reading a plain ref would
  // fire while the ref is still null on first mount (no file open yet) and
  // never re-attach once the div actually appears. The callback ref runs
  // exactly when the DOM node is attached/detached, whenever that happens.
  const viewportCallbackRef = useCallback(
    (el: HTMLDivElement | null) => {
      viewportCleanupRef.current?.();
      viewportCleanupRef.current = null;
      viewportElRef.current = el;
      if (!el) return;
      function handleWheel(e: WheelEvent) {
        e.preventDefault();
        // 사람이 배율을 정했으므로 이후로는 자동으로 되돌리지 않는다.
        fittedRef.current = false;
        setScale((prev) => nextScale(prev, e.deltaY));
      }
      // Non-passive so preventDefault actually stops page scroll/zoom.
      el.addEventListener("wheel", handleWheel, { passive: false });
      // 레이어 패널의 splitter를 끌면 뷰어 폭이 바뀐다. 아직 사람이 배율을 안
      // 건드렸다면 새 크기에 다시 맞춘다.
      const observer = new ResizeObserver(() => {
        if (fittedRef.current) applyFit();
      });
      observer.observe(el);
      viewportCleanupRef.current = () => {
        el.removeEventListener("wheel", handleWheel);
        observer.disconnect();
      };
    },
    [applyFit]
  );

  function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = { x: e.clientX, y: e.clientY };
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    if (!draggingRef.current) return;
    const dx = e.clientX - draggingRef.current.x;
    const dy = e.clientY - draggingRef.current.y;
    draggingRef.current = { x: e.clientX, y: e.clientY };
    // 밀어서 위치를 정한 것도 사람의 선택이다. 창 크기가 바뀌었다고 가운데로
    // 되돌아가면 안 된다.
    fittedRef.current = false;
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

  if (paused && !imgSrc) {
    return (
      <div className="preview-canvas preview-empty">
        파일을 불러오는 중입니다. 지금 보려면 파일 패널의 "중지"를 누르세요.
      </div>
    );
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
            ref={imageCallbackRef}
            src={imgSrc}
            alt="미리보기"
            draggable={false}
            onLoad={(e) => measureAndFit(e.currentTarget)}
            style={{
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
              // 배율이 정해지기 전에는 감춘다. measureAndFit이 배율과 이 값을 한
              // 번에 켜므로 1:1 프레임이 그려지지 않는다.
              visibility: fitReady ? "visible" : "hidden",
            }}
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
