import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { loadPngDataUrl, renderDocumentPreview, renderPreview } from "../lib/engine";
import {
  PREVIEW_BACKGROUNDS,
  PREVIEW_BACKGROUND_LABELS,
  PREVIEW_BACKGROUND_STORAGE_KEY,
  isDocumentView,
  KEY_ZOOM_FACTOR,
  MIN_PREVIEW_SCALE,
  nextScale,
  PREVIEW_MAX_SIZE,
  parsePreviewBackground,
  recenterOn,
  scaledBy,
  toEngineError,
  viewCommandFor,
  visibleIdsForPreview,
  zoomAround,
  type PreviewBackground,
  type ViewPoint,
} from "../lib/preview";
import { lineColorIdsFor, previewCacheKey, type PreviewCache } from "../lib/previewCache";
import { withEvictedSessionRetry } from "../lib/sessionRetry";
import type { FileStatus } from "../state/appStore";
import type { EdgeLines, EngineError, OpenResult, TreeNode } from "../lib/types";

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
   * 프리셋 규칙에 걸린 레이어 id(apply_preset의 matchedLayerIds). 색 통일은
   * 그중 지금 그리는 것에만 걸린다 — 아티스트가 손으로 체크해 넣은 색 레이어는
   * 원본 색으로 남아야 하기 때문이다(previewCache의 lineColorIdsFor 참고).
   */
  matchedIds: number[] | undefined;
  /**
   * 선택된 프리셋의 색 경계선 생성 설정. 켜져 있으면 미리보기도 내보내기 결과와
   * 같은 그림이어야 하므로 여기에 반영한다 — 캐시 키에도 들어간다(아래
   * RenderSpec.edgeLines), 설정이 바뀌면 그림이 달라지기 때문이다.
   */
  edgeLines: EdgeLines | null;
  /**
   * 색 경계선 생성의 수동 지정(설계 3.1, opsReducer의 edgeColourIds). 자동
   * 검출이 못 찾은 색 레이어를 아티스트가 트리에서 직접 짚은 것 — 내보내기
   * 미리보기는 실제 산출물과 같아야 하므로 여기에도 반영한다. edgeLines와
   * 달리 프리셋에 저장되지 않는 파일별 값이라 별도 prop이다(engine.ts의
   * renderPreview 주석 참고). 캐시 키에도 들어간다 — 지정이 바뀌면 그림이
   * 달라지기 때문이다.
   */
  edgeColourIds: number[];
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
 * 엔진에 낼 렌더 한 건. 효과 밖(앞선 렌더가 끝나는 자리)에서도 그대로 낼 수
 * 있도록, 렌더 효과의 본문이 화면 상태에서 읽던 것만 통째로 담아둔다.
 *
 * dispatch는 이 스펙에 없는 것도 넷 더 읽는다: cache, onSessionRefreshed,
 * onError, onRenderingChange. 밀려 있던 스펙은 그것을 만든 효과 세대가 아니라
 * *원래* 렌더를 낸 효과 세대의 클로저 안에서 나가므로(finally가 dispatch를
 * 다시 부르는 자리), 이 넷은 스펙에 없어도 안전하려면 각각 ref이거나 빈
 * 의존성 useCallback이어야 한다 — 어느 세대의 클로저에서 읽든 같은 값이어야
 * 하기 때문이다. 지금은 cache가 App의 ref(previewCacheRef.current)를 그대로
 * 받고, 나머지 셋이 빈 의존성 useCallback이라 성립한다. 이 중 하나라도
 * 깨지면(예: cache가 state가 되거나 onError에 의존성이 붙으면) 밀린 dispatch가
 * 옛 캐시나 옛 콜백을 tsc도, 테스트도 잡지 못한 채 조용히 계속 쓰게 된다.
 */
interface RenderSpec {
  path: string;
  visibleIds: number[];
  documentView: boolean;
  lineColor: string | null;
  /** 색 통일을 걸 레이어(previewCache의 lineColorIdsFor). null이면 전부. */
  lineColorIds: number[] | null;
  /** 색 경계선 생성 설정. null이면 꺼짐. */
  edgeLines: EdgeLines | null;
  /** 색 경계선 생성의 수동 지정(위 PreviewCanvasProps.edgeColourIds 참고). */
  edgeColourIds: number[];
  /**
   * 체크박스가 실제로 내보내기에 포함시킨 목록(위 PreviewCanvasProps.includedIds,
   * engine.ts의 renderPreview 주석 참고) — manual_views가 "이미 있는 라인"을
   * 가르는 기준이다. visibleIds(그리기용, 눈까지 반영)와는 다른 값이라 따로
   * 싣는다.
   */
  includedIds: number[];
  /** 결과를 담을 캐시 키. 만들 수 없으면(mtime 미상) null. */
  cacheKey: string | null;
}

/**
 * Center preview canvas. Recomputes visibleIds whenever activePath / eye
 * toggle / include toggle changes (via tree, includedIds, previewHiddenIds
 * reference changes), then renders via the engine — at once if the engine is
 * free, otherwise into pendingRef, a one-slot latch dispatched the moment the
 * running render finishes. A monotonically increasing request id guards
 * against a stale response (e.g. from a render superseded by a later
 * toggle) overwriting a newer frame or clobbering a newer request's loading
 * state.
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
  matchedIds,
  edgeLines,
  edgeColourIds,
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
   * 지금 엔진에 걸려 있는 렌더 수. 렌더는 한 번에 하나만 나가므로 두 렌더가
   * 겹치는 일은 이제 구조적으로 일어나지 않는다 — 그런데도 굳이 세는 이유는
   * finally(아래, dispatch 안)의 순서 때문이다. 밀려 있던 스펙을 dispatch로 낸 *다음에*
   * 이 값을 내리므로, 인계되는 그 순간에도 값이 0을 거치지 않고 1 → 2 → 1로
   * 지나간다. 그래서 "안 바쁨" 신호에 틈이 생기지 않고, 그 틈을 타고 미리보기
   * 준비 큐(App.tsx)가 끼어드는 일도 없다. onRenderingChange(false)는 그래서
   * 엔진이 정말로 빈 순간에만 나간다.
   *
   * requestIdRef로 대신할 수 없다. 그 값은 렌더가 걸리지 않는 경로(빈 집합,
   * 캐시 적중)에서도 올라가므로, 그걸 신호로 삼으면 진행 중인 렌더가 자기
   * 차례를 영영 못 알아보고 "바쁨"이 그대로 남는다.
   */
  const inFlightRef = useRef(0);
  const draggingRef = useRef<{ x: number; y: number } | null>(null);
  const viewportCleanupRef = useRef<(() => void) | null>(null);
  const viewportElRef = useRef<HTMLDivElement | null>(null);
  /**
   * 포인터가 뷰포트 안에 있을 때의 마지막 위치(뷰포트 중앙 기준). 밖이면 null.
   *
   * 단축키가 이 값으로 자기 차례인지 판단한다 — Harmony처럼 커서 아래의 뷰가
   * 키를 받는다. 포커스를 쓰지 않으므로 레이어 검색창이나 대화상자와 겹칠 일이
   * 구조적으로 없고, N이 어차피 커서 위치를 필요로 하니 값도 이미 여기 있다.
   */
  const cursorRef = useRef<ViewPoint | null>(null);
  /**
   * scale의 거울. 커서 고정 확대는 새 배율과 새 이동량을 함께 계산해야 하는데,
   * 이동량 쪽이 **직전** 배율을 즉시 읽어야 한다. 휠을 굴리면 한 프레임 안에
   * 여러 번 들어오므로 상태만 보면 같은 배율을 두 번 읽어 그림이 어긋난다.
   */
  const scaleRef = useRef(scale);
  useEffect(() => {
    scaleRef.current = scale;
  }, [scale]);
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

  /** 화면 좌표를 뷰포트 중앙 기준으로 옮긴다. 커서 위치는 전부 이 좌표계로 다닌다. */
  const pointFromClient = useCallback((clientX: number, clientY: number): ViewPoint | null => {
    const el = viewportElRef.current;
    if (!el) return null;
    const box = el.getBoundingClientRect();
    return { x: clientX - (box.left + box.width / 2), y: clientY - (box.top + box.height / 2) };
  }, []);

  /**
   * 커서 아래를 붙잡은 채 배율만 바꾼다. 휠과 1/2가 같은 이 길로 들어온다.
   *
   * 배율과 이동량이 별개의 상태라 순서가 중요하다. setScale의 갱신 함수 안에서
   * setOffset을 부르면 StrictMode가 갱신 함수를 두 번 돌리면서 이동이 두 번
   * 걸린다 — 그래서 직전 배율은 거울에서 읽고 두 상태를 나란히 세운다.
   */
  const zoomAroundCursor = useCallback((computeNext: (prev: number) => number, cursor: ViewPoint) => {
    const prev = scaleRef.current;
    const next = computeNext(prev);
    // 사람이 배율을 정했으므로 이후로는 자동으로 되돌리지 않는다.
    fittedRef.current = false;
    scaleRef.current = next;
    setScale(next);
    setOffset((off) => zoomAround(off, prev, next, cursor));
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
  // Latest sessionId, read at dispatch time rather than captured at
  // effect-setup time — see the render effect below for why.
  const sessionIdRef = useRef(sessionId);
  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);
  /**
   * 아직 못 낸 렌더 한 건 — 엔진에 이미 하나 걸려 있는 동안 화면이 원하게 된
   * 최신 상태다. 자리가 하나뿐이라 새 것이 옛 것을 덮어쓰고, 그래서 엔진 앞에
   * 쌓이는 요청은 정의상 한 건을 넘지 않는다.
   *
   * 여기 있던 것은 시간 창(PREVIEW_COALESCE_MS, 120ms)이었다. 그 창이 묶던 것은
   * dispatch **속도**(120ms에 한 번)이지 큐 깊이가 아니었다. 엔진은 stdin을
   * 순서대로 처리하므로, 렌더 한 장이 창보다 오래 걸리면 — 타일 캐시가 빈
   * 레이어는 extract_rgba가 채널을 통째로 푼다 — 요청이 엔진을 앞질러 큐가
   * 자랐다. 그건 창을 뒤(trailing)에 두든 앞(leading)에 두든 마찬가지였고, 상수를
   * 바꿔서 될 일도 아니다: 고정된 ms는 직전 렌더가 끝났는지와 무관하게 발사된다.
   * 진행 중인 렌더(inFlightRef)를 보고 미루면 그 일이 일어날 수 없다.
   *
   * 게다가 더 빠르다. 창은 시간만 셌으므로 연타의 마지막 토글이 최대 120ms를
   * 그냥 기다렸지만, 이 자리는 엔진이 비는 그 순간 나간다. 실측한 체감 지연에서
   * 그 대기가 가장 큰 몫이었다:
   *
   *     디바운스 대기        120 ms   ← 이제 없다
   *     보이는 N장 재합성     ~60 ms   (캐시된 타일 20장)
   *     PNG 인코딩          27.7 ms
   *     브라우저 PNG 디코딩   17.8 ms
   */
  const pendingRef = useRef<RenderSpec | null>(null);

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
    // 밀려 있는 렌더의 주인은 이 효과 하나다. 매번 비우고, 아래에서 지금 화면이
    // 원하는 것으로 다시 채운다. 요청 번호가 *이미 나간* 요청에 하는 일을 아직
    // 안 나간 요청에 해주는 것이다 — 아래에는 엔진까지 가지 않고 빠지는 길이
    // 넷 있고(파일 없음, 일시정지, 빈 집합, 캐시 적중) 그때 옛 요청이 자리에
    // 남아 있으면, 진행 중인 렌더가 끝나는 순간 이미 지나간 조합이 — 심지어 방금
    // 떠난 파일의 조합이 — 엔진으로 나간다. 자리를 다시 채우는 쪽은 매번 지금
    // 상태에서 새로 만드므로, 비웠다가 잃는 것은 없다.
    pendingRef.current = null;
    if (!path) return;

    // 이미 렌더해 본 조합이면 엔진에 가지 않는다. 파일을 오갈 때 위의 [path]
    // 효과가 화면의 이미지를 버리기 때문에, 이게 없으면 돌아올 때마다 같은
    // 합성을 처음부터 다시 시킨다. 키는 경로+수정시각으로 만들어지므로
    // (previewCache 참조) 앱을 껐다 켜도 같은 그림이면 같은 키다 — 프로젝트가
    // 담아둔 PNG가 재사용되는 근거가 그것이다.
    //
    // **이 조회가 paused·sessionId보다 앞이다.** 프로젝트를 열면 저장해둔 PNG가
    // 이미 캐시에 올라와 있는데(App.tsx의 primeRestoredPreviews), 로드 중이라고
    // 먼저 빠지면 파일 열기 큐가 89장을 다 여는 동안 화면이 비어 있는다 — 그릴
    // 것이 손에 있는데도. 캐시 적중은 엔진에 가지 않으니 큐와 다툴 일도 없다.
    const cacheKey =
      visibleIds.length === 0
        ? null
        : previewCacheKey(
            { path, mtime }, documentView, visibleIds, lineColor, matchedIds, edgeLines, edgeColourIds, includedIds
          );
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

    // 큐가 끝나면 paused가 false로 바뀌면서 이 효과가 다시 돌아 그때 그린다.
    if (paused) return;
    if (visibleIds.length === 0) {
      requestIdRef.current += 1; // invalidate any in-flight render from a prior toggle
      showImage(null);
      setLoading(false);
      return;
    }

    const spec: RenderSpec = {
      path, visibleIds, documentView, lineColor,
      lineColorIds: lineColorIdsFor(visibleIds, lineColor, matchedIds),
      edgeLines,
      edgeColourIds,
      includedIds,
      cacheKey,
    };

    // 엔진에 이미 하나 걸려 있으면 자리에만 적어두고 물러난다. 타이머는 세우지
    // 않는다 — 기다릴 것은 시간이 아니라 사건이고, 그 사건은 아래 finally다.
    if (inFlightRef.current > 0) {
      pendingRef.current = spec;
      return;
    }
    // 비어 있으면 곧바로 낸다. 문서 보기든 합성 미리보기든 대기는 0이다 —
    // 특히 문서 보기는 저장된 병합 이미지를 그대로 쓰므로 즉시 끝나고, 파일을
    // 연 직후가 바로 그 경우라 여기서 기다리면 첫 화면만 늦어진다.
    dispatch(spec);

    /**
     * 엔진에 실제로 내는 곳. 두 군데서 부른다 — 위(엔진이 비었을 때)와, 앞선
     * 렌더가 끝나는 자리에서 밀려 있던 것을 집어서.
     */
    function dispatch(next: RenderSpec) {
      // 세션 id는 효과가 설 때가 아니라 내는 이 시점에 읽는다(위 주석 참고).
      const sid = sessionIdRef.current;
      if (!sid) return;
      // 요청 번호도 같다. 밀렸다 나가는 렌더가 밀릴 때의 번호를 들고 있으면 그
      // 사이에 올라간 번호(캐시 적중, 빈 집합, 파일 전환)에 밀려 자기 결과를
      // 스스로 버린다 — 화면은 옛 그림에 멈춘 채로 남는다.
      const requestId = ++requestIdRef.current;
      setLoading(true);
      inFlightRef.current += 1;
      onRenderingChange(true);
      void (async () => {
        try {
          const { pngPath } = await withEvictedSessionRetry(
            next.path,
            sid,
            (s) =>
              next.documentView
                ? renderDocumentPreview(s, PREVIEW_MAX_SIZE)
                : renderPreview(s, next.visibleIds, PREVIEW_MAX_SIZE, next.lineColor,
                                next.lineColorIds, next.edgeLines, next.edgeColourIds, next.includedIds),
            (result) => onSessionRefreshed(next.path, result)
          );
          const dataUrl = await loadPngDataUrl(pngPath);
          // 화면에 못 띄우게 된 결과라도 캐시에는 넣는다 — 이 조합으로 돌아오면
          // (토글을 되돌리거나 파일을 오가면) 그때 그대로 쓴다. 키는 파일의 수정
          // 시각 기준이라, 중간에 축출-재오픈이 끼어 세션 id가 바뀌어도 그대로
          // 유효하다.
          if (next.cacheKey) cache.set(next.cacheKey, dataUrl);
          if (requestIdRef.current !== requestId) return; // superseded by a newer request
          showImage(dataUrl);
          setLoading(false);
        } catch (e) {
          if (requestIdRef.current !== requestId) return;
          setLoading(false);
          onError("미리보기 렌더링 실패", toEngineError(e));
        } finally {
          // 밀려 있는 것을 내리기 **전에** 낸다. 그래야 inFlightRef가 0을 거치지
          // 않고, "안 바쁨"도 나가지 않는다 — 그 한 틈에 미리보기 준비 큐가
          // 비켜서기를 멈추고 파일을 열면(App.tsx) 세션 두 칸을 두고 다툰다.
          const pending = pendingRef.current;
          if (pending) {
            pendingRef.current = null;
            dispatch(pending);
          }
          inFlightRef.current -= 1;
          if (inFlightRef.current === 0) onRenderingChange(false);
        }
      })();
    }
    // visibleIds 대신 visibleKey에 의존한다 — 키가 같으면 내용이 같으므로 효과가
    // 들고 있는 배열이 한 세대 옛것이어도 렌더 결과는 동일하다. 위 visibleKey의
    // 주석에 왜 배열 정체로는 안 되는지 적어두었다.
  }, [path, mtime, visibleKey, documentView, lineColor, matchedIds, edgeLines, edgeColourIds, includedIds, paused, cache, showImage, onRenderingChange, onSessionRefreshed, onError]);

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
        // 휠도 커서를 기준으로 확대한다 — 같은 화면에서 휠과 1/2가 서로 다른
        // 곳을 기준으로 삼으면 확대 방식이 두 가지가 된다.
        const cursor = pointFromClient(e.clientX, e.clientY);
        if (!cursor) return;
        zoomAroundCursor((prev) => nextScale(prev, e.deltaY), cursor);
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
    [applyFit, pointFromClient, zoomAroundCursor]
  );

  // 뷰 단축키 (Toon Boom Harmony와 같은 배치): 1 축소, 2 확대, N 커서 위치를
  // 가운데로, Shift+M 맞춤으로 되돌리기.
  //
  // window에 걸고 커서 위치로 자기 차례를 가린다. 뷰포트에 포커스를 주는 방식은
  // 클릭이 판 드래그의 시작과 겹쳐 화면이 의도치 않게 밀린다.
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const cursor = cursorRef.current;
      if (!cursor) return;
      // 글자를 받는 곳이 눌리고 있으면 그쪽 것이다. 커서가 우연히 뷰 위에 있는
      // 동안 레이어 이름을 치면 "line"의 n에 화면이 움직여버린다.
      const target = e.target as HTMLElement | null;
      if (target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "")) {
        return;
      }
      const command = viewCommandFor(e);
      if (!command) return;
      if (command === "reset") {
        applyFit();
        return;
      }
      if (command === "recenter") {
        fittedRef.current = false;
        setOffset((off) => recenterOn(off, cursor));
        return;
      }
      const factor = command === "zoomIn" ? KEY_ZOOM_FACTOR : 1 / KEY_ZOOM_FACTOR;
      zoomAroundCursor((prev) => scaledBy(prev, factor), cursor);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [applyFit, zoomAroundCursor]);

  function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = { x: e.clientX, y: e.clientY };
  }

  function handlePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    // 드래그 중인지와 무관하게 먼저 기록한다 — 단축키는 끌지 않고 커서만 올려둔
    // 상태에서 쓰는 것이 보통이다.
    cursorRef.current = pointFromClient(e.clientX, e.clientY);
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

  // 아래 안내들은 전부 "아직 보여줄 그림이 없다"는 뜻이다. 그래서 **그림을 들고
  // 있으면 하나도 해당하지 않는다** — 프로젝트를 열어 복원한 PNG가 캐시에서 바로
  // 올라온 경우가 정확히 그 경우다(세션은 아직 없고 파일 열기 큐도 안 끝났다).
  // 예전에는 `!sessionId`가 그림보다 먼저 서 있어서, 담아둔 미리보기가 손에
  // 있는데도 89장이 다 열릴 때까지 "왼쪽에서 파일을 선택하세요."가 떠 있었다.
  if (!imgSrc) {
    if (status === "processing") {
      return <div className="preview-canvas preview-empty">여는 중...</div>;
    }

    if (!sessionId) {
      return <div className="preview-canvas preview-empty">왼쪽에서 파일을 선택하세요.</div>;
    }

    if (paused) {
      return (
        <div className="preview-canvas preview-empty">
          파일을 불러오는 중입니다. 지금 보려면 파일 패널의 "중지"를 누르세요.
        </div>
      );
    }

    if (visibleIds.length === 0) {
      return <div className="preview-canvas preview-empty">표시할 레이어 없음</div>;
    }
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
        onPointerEnter={(e) => {
          cursorRef.current = pointFromClient(e.clientX, e.clientY);
        }}
        // 커서가 나가면 단축키도 이 뷰를 떠난다. 마지막 위치를 들고 있으면 다른
        // 패널에 마우스를 둔 채 누른 키에 화면이 움직인다.
        onPointerLeave={() => {
          cursorRef.current = null;
        }}
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
