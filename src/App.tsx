import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import { AppProvider, applyPresetEffect, openFileEffect, useAppStore, type FileEntry } from "./state/appStore";
import type { SkippedLayer } from "./lib/engine";
import { FilePanel } from "./components/FilePanel";
import { LayerTree } from "./components/LayerTree";
import { ErrorPanel } from "./components/ErrorPanel";
import { EngineStatus } from "./components/EngineStatus";
import { PreviewCanvas } from "./components/PreviewCanvas";
import { PresetBar } from "./components/PresetBar";
import { OpsHistory } from "./components/OpsHistory";
import { ExportDialog } from "./components/ExportDialog";
import { BatchPanel } from "./components/BatchPanel";
import { loadPngDataUrl, pinFile, renderDocumentPreview, renderPreview, renderThumbnails } from "./lib/engine";
import {
  DEFAULT_TREE_PANEL_WIDTH,
  TREE_PANEL_WIDTH_STORAGE_KEY,
  clampTreePanelWidth,
  parseTreePanelWidth,
} from "./lib/layout";
import { drainLoadQueue } from "./lib/loadQueue";
import { DEFAULT_ROLE_TOKENS } from "./lib/presets";
import { PREVIEW_MAX_SIZE, pixelLeafIds, toEngineError } from "./lib/preview";
import { PreviewCache, previewRenderSpec } from "./lib/previewCache";
import { withEvictedSessionRetry } from "./lib/sessionRetry";
import type { Preset } from "./lib/types";

type BottomTab = "history" | "batch";

/**
 * 썸네일을 한 번에 몇 장씩 요청할지. 엔진은 stdin 큐를 순서대로 처리하므로 이
 * 값이 곧 "썸네일 작업이 미리보기 요청을 최대 얼마나 붙잡아두는가"이다.
 */
const THUMBNAIL_CHUNK_SIZE = 8;

/**
 * 첫 썸네일 청크를 보내기 전에 두는 짧은 지연. 파일을 열면 이 효과와
 * PreviewCanvas의 렌더 요청이 같은 틱에 깨어나는데, 아티스트가 기다리는 것은
 * 그림이지 썸네일이 아니다. 이만큼 양보해 미리보기 요청이 큐에 먼저 들어가게 한다.
 */
const THUMBNAIL_START_DELAY_MS = 250;

/**
 * 미리보기 준비 큐가 "화면이 그리는 중"을 기다려 주는 시간의 상한. 화면 쪽이
 * 어떤 이유로든 끝났다는 신호를 못 보내더라도 준비가 영영 멈추지는 않게 한다.
 */
const PREFETCH_YIELD_MAX_MS = 60_000;

function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function AppShell() {
  const {
    state,
    ops,
    activeFile,
    addFiles,
    selectFile,
    removeFile,
    togglePreview,
    setPreviewHidden,
    toggleSolo,
    setSolo,
    pushOp,
    setIncluded,
    applyPresetResult,
    undoOp,
    dismissError,
    pushError,
    refreshSession,
    engineRestarted,
    dispatch,
  } = useAppStore();

  // Thumbnails per file path (layer ids are only unique within a session, so
  // keying by path — not a flat id map — avoids collisions across files).
  const [thumbsByPath, setThumbsByPath] = useState<Record<string, Record<number, string>>>({});
  const fetchedPathsRef = useRef<Set<string>>(new Set());

  // 레이어 패널 폭. 파일이 아니라 사람에게 붙는 설정이라 재시작을 넘어 유지된다.
  const [treeWidth, setTreeWidth] = useState(() =>
    parseTreePanelWidth(window.localStorage.getItem(TREE_PANEL_WIDTH_STORAGE_KEY))
  );
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  function handleResizeStart(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startWidth: treeWidth };
  }

  function handleResizeMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    // 핸들은 패널 왼쪽 모서리에 있으므로 왼쪽으로 끌수록 넓어진다.
    setTreeWidth(clampTreePanelWidth(drag.startWidth - (e.clientX - drag.startX), window.innerWidth));
  }

  function handleResizeEnd(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) return;
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    window.localStorage.setItem(TREE_PANEL_WIDTH_STORAGE_KEY, String(treeWidth));
  }

  const [bottomTab, setBottomTab] = useState<BottomTab>("history");
  const [exportOpen, setExportOpen] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState<Preset | undefined>(undefined);

  // Clear a stale open dialog if its file disappears from under it (e.g. an
  // engine restart resets activePath to null) — otherwise it would spring
  // back open unprompted the next time any file is selected.
  useEffect(() => {
    if (!activeFile) setExportOpen(false);
  }, [activeFile]);

  // 로드 큐. 목록에 들어온 파일을 클릭 없이 하나씩 열고, 선택된 프리셋까지
  // 적용해 둔다 — 작업자가 파일마다 클릭해서 여는 단계를 없앤 것이다.
  //
  // 한 번에 하나씩 도는 이유는 두 가지다. 엔진은 stdin 큐를 순서대로 처리하므로
  // 동시에 던져봐야 어차피 줄을 서고, 파일 사이에서 양보해야 그 틈에 사람이 누른
  // 미리보기 요청이 끼어들 수 있다. 그리고 프리셋 적용은 그 파일을 연 직후에
  // 붙여야 세션이 아직 엔진의 LRU(2개) 안에 있다.
  //
  // 여기서 계산해둔 트리와 매칭 결과는 프론트엔드 상태에 남으므로, 나중에 세션이
  // 밀려나도 그대로 쓸 수 있다. 다시 필요한 것은 미리보기 렌더뿐이다.
  const [loadProgress, setLoadProgress] = useState<{ done: number; total: number } | null>(null);
  const drainingRef = useRef(false);
  /**
   * "중지"가 세운 취소 표시. 큐마다 따로 둔다 — 진행바 자리는 하나지만 두 큐는
   * 별개의 작업이라, "여는 중"에서 누른 중지가 그 뒤에 도는 "미리보기 준비 중"까지
   * 함께 끄면 사용자는 누른 적 없는 작업이 멈춘 것을 보게 된다.
   *
   * 표시를 큐 안이 아니라 여기 바깥에 두는 것이 요점이다. 큐를 시작하는 효과는
   * state.files가 바뀔 때마다 다시 도는데, 그 효과 안에서 취소를 지우면 중지가
   * 다음 상태 변화까지밖에 못 간다 — 중지 직후 파일 하나를 클릭해 여는 것만으로도
   * (selectFile이 idle 파일에 openFileEffect를 부른다) 방금 세운 중지가 풀려
   * 큐가 통째로 다시 시작됐다. 파일을 새로 추가할 때만 푼다(handleAddFiles).
   *
   * 상태와 ref를 함께 든다. 큐가 도는 도중에는 값을 즉시 읽어야 하므로(cancelled)
   * ref가 필요하고, 취소를 **푸는** 것은 효과를 다시 돌려야 하므로 상태가 필요하다.
   * ref만 두면 다시 시작할 방법이 없다: 이미 있는 폴더를 다시 추가하면 addFiles
   * 리듀서가 새 파일이 없다며 같은 state를 그대로 돌려주고(appStore.tsx의
   * `additions.length === 0`), 그러면 state.files 정체가 그대로라 효과가 안 돈다.
   */
  const [loadCancelled, setLoadCancelled] = useState(false);
  const [prefetchCancelled, setPrefetchCancelled] = useState(false);
  const loadCancelledRef = useRef(false);
  const prefetchCancelledRef = useRef(false);
  const setLoadCancel = useCallback((cancelled: boolean) => {
    loadCancelledRef.current = cancelled;
    setLoadCancelled(cancelled);
  }, []);
  const setPrefetchCancel = useCallback((cancelled: boolean) => {
    prefetchCancelledRef.current = cancelled;
    setPrefetchCancelled(cancelled);
  }, []);
  const filesRef = useRef(state.files);
  const activePathRef = useRef(state.activePath);
  const presetRef = useRef(selectedPreset);
  const loadingRef = useRef(false);
  useEffect(() => {
    filesRef.current = state.files;
    activePathRef.current = state.activePath;
    presetRef.current = selectedPreset;
  }, [state.files, state.activePath, selectedPreset]);

  // 큐가 도는 동안 엔진을 두고 다투는 다른 작업들을 멈추기 위한 플래그. 세션이
  // 두 개뿐이라, 동시에 세 군데서 열면 서로의 세션을 밀어내며 PSD를 계속 다시
  // 파싱하게 된다.
  const loading = loadProgress !== null;
  // 썸네일 큐는 회차 사이에 이 값을 다시 읽어야 한다 — 효과가 잡아둔 값을 계속
  // 쓰면 로드가 시작돼도 양보하지 않는다.
  loadingRef.current = loading;

  /**
   * 진행바의 "중지". 버튼은 하나지만 진행바가 지금 무엇을 보여주고 있는지에 따라
   * 그 큐만 세운다 — 사용자는 지금 눈에 보이는 문구를 멈추려고 누른다.
   */
  const cancelLoad = useCallback(() => {
    if (loading) setLoadCancel(true);
    else setPrefetchCancel(true);
  }, [loading, setLoadCancel, setPrefetchCancel]);

  /**
   * 파일을 새로 추가하는 것은 "이제 다시 시작해도 좋다"는 뜻이므로 중지 표시를
   * 푼다. 취소가 풀리는 유일한 지점이다 — 그 밖의 상태 변화로는 풀리지 않아야
   * 중지가 중지로 남는다.
   */
  const handleAddFiles = useCallback(
    (paths: string[]) => {
      setLoadCancel(false);
      setPrefetchCancel(false);
      addFiles(paths);
    },
    [addFiles, setLoadCancel, setPrefetchCancel]
  );

  /**
   * 중지 표시를 푼다. 큐를 여기서 직접 부르지 않는 것이 요점이다 — 상태가
   * 바뀌면 두 효과가 다시 돌면서 남은 일을 스스로 다시 센다.
   */
  const handleResume = useCallback(() => {
    setLoadCancel(false);
    setPrefetchCancel(false);
  }, [setLoadCancel, setPrefetchCancel]);

  useEffect(() => {
    if (drainingRef.current) return;
    if (loadCancelled) return;
    if (!state.files.some((f) => f.status === "idle")) return;
    drainingRef.current = true;

    // 규칙에 걸렸지만 그릴 픽셀이 없어 빠진 레이어들을 파일별로 모은다. 파일마다
    // 카드를 띄우면 화면이 카드로 덮여 진짜 오류가 묻히므로 끝에 한 장으로 낸다.
    const undrawableByPath: Array<{ path: string; layers: SkippedLayer[] }> = [];

    void drainLoadQueue({
      pendingPaths: () => filesRef.current.filter((f) => f.status === "idle").map((f) => f.path),
      processPath: async (path) => {
        // 아직 아무것도 안 보고 있으면 첫 파일을 띄워준다. 그 뒤로는 사람이
        // 보고 있는 화면을 뺏지 않는다.
        const result = await openFileEffect(dispatch, path, { activate: activePathRef.current === null });
        const preset = presetRef.current;
        // 프리셋은 파일을 연 직후에 붙인다 — 그래야 세션이 아직 엔진의 LRU 안에
        // 있어서 다시 파싱하지 않는다.
        if (result && preset) {
          const undrawable = await applyPresetEffect(dispatch, path, result.sessionId, preset);
          if (undrawable.length > 0) undrawableByPath.push({ path, layers: undrawable });
        }
      },
      // 큐가 끝났다는 표시(progress=null)와 drainingRef를 같은 순간에 내린다.
      // 준비 큐는 loading이 false가 되는 것을 보고 다시 도는데, 그때 drainingRef가
      // 아직 서 있으면 위의 가드에 걸려 되돌아가고 — 그것을 다시 깨울 신호는
      // 없다(ref는 의존성이 아니다). 두 값을 붙여두면 그 틈이 생기지 않는다.
      onProgress: (progress) => {
        if (progress === null) drainingRef.current = false;
        setLoadProgress(progress);
      },
      cancelled: () => loadCancelledRef.current,
    })
      .then(() => {
        if (undrawableByPath.length === 0) return;
        const total = undrawableByPath.reduce((n, f) => n + f.layers.length, 0);
        pushError(`그릴 픽셀이 없어 뺀 레이어 ${total}개 (파일 ${undrawableByPath.length}개)`, {
          message: undrawableByPath
            .map(({ path, layers }) => `${fileName(path)}\n  ${layers.map((l) => `${l.path} (${l.kind})`).join("\n  ")}`)
            .join("\n"),
          traceback: "",
        });
      })
      // 개별 파일의 실패는 openError/pushError로 이미 보고되고 큐는 계속 돈다.
      // 여기까지 오는 것은 큐 자체가 무너진 경우뿐이라 조용히 넘기면 안 된다.
      .catch((e) => pushError("파일 자동 열기 중단", toEngineError(e)))
      .finally(() => {
        drainingRef.current = false;
      });
  }, [state.files, loadCancelled, dispatch, pushError]);

  // 보고 있는 파일을 엔진에 고정한다. 이게 없으면 배경 작업(미리보기 미리
  // 만들기)이 파일을 차례로 여는 동안 화면이 쓰는 세션이 계속 밀려나고, 썸네일과
  // 미리보기가 각자 재오픈을 하다 서로를 걷어차며 실패한다.
  //
  // 세션 id가 아니라 경로를 보낸다. id로 걸었더니 재오픈이 새 id를 만드는 순간부터
  // 그것을 다시 고정할 때까지가 무방비였고, 그 사이에 배경 작업이 두 번만 열면
  // 방금 되살린 세션이 또 사라졌다 — 썸네일이 그렇게 실패했다. 경로는 재오픈에도
  // 변하지 않으므로 그 틈이 없다.
  //
  // 실측상 세션 하나가 파일 크기만큼(700MB급) 메모리를 쓰므로 총량은 늘리지
  // 않았다 — 두 칸 중 한 칸을 화면 몫으로 못박는 것뿐이다.
  //
  // 다만 로드 큐가 도는 동안에는 고정을 푼다. 그때는 이 pin이 지키는 것이 없다 —
  // 미리보기 캔버스는 paused(=loading)라 안 그리고, 썸네일도 준비 큐도 loading에
  // 막혀 있어 활성 파일의 세션을 읽는 사람이 아무도 없다. 그런데 고정해두면 두 칸
  // 중 한 칸이 묶여 큐가 쓸 수 있는 것은 한 칸뿐이고, 여유가 0이 된다: 어디선가
  // open_psd가 하나만 끼어들어도 큐가 방금 연 세션이 곧바로 밀려나 apply_preset이
  // 'unknown or evicted session'으로 떨어진다(재시도 상한까지 밀린다). 로드 중에는
  // 두 칸을 다 큐에 주고, 끝나는 순간 다시 고정한다.
  useEffect(() => {
    void pinFile(loading ? null : state.activePath).catch((e) =>
      pushError("파일 고정 실패", toEngineError(e))
    );
  }, [state.activePath, loading, pushError]);

  // 미리보기 준비 큐. 로드가 끝난 뒤 조용히 돌면서 파일마다 라인 합성을 미리
  // 만들어 캐시에 넣어둔다 — 그래야 파일을 눌렀을 때 엔진에 가지 않고 바로 뜬다.
  //
  // 로드와 분리한 이유는 비용이다. 실측(245레이어급 한 장)으로 PSD 열기 3.4초에
  // 합성 7.9초라, 로드에 합치면 진행바가 세 배로 길어진다. 여기서 미리 해두면
  // 진행바는 지금처럼 끝나고 그 뒤로 조용히 채워진다.
  //
  // 보고 있는 파일을 맨 앞에 둔다. 그 파일은 어차피 PreviewCanvas가 그리는데,
  // 준비 큐가 다른 파일을 열어 세션을 밀어내면 그 그림에 PSD 재파싱 3.4초가
  // 얹힌다. 먼저 처리해 캐시에 넣어두면 그 왕복이 통째로 사라진다.
  const previewCacheRef = useRef(new PreviewCache());
  const [prefetchProgress, setPrefetchProgress] = useState<{ done: number; total: number } | null>(null);
  const prefetchingRef = useRef(false);
  /** 미리 만들기에 실패한 파일. 다시 집으면 큐가 끝나지 않으므로 빼둔다. */
  const prefetchFailedRef = useRef<Set<string>>(new Set());
  /** 화면이 지금 엔진에 렌더를 걸고 있는지. 준비 큐가 그동안 비켜서기 위한 신호. */
  const canvasRenderingRef = useRef(false);
  const handleCanvasRendering = useCallback((busy: boolean) => {
    canvasRenderingRef.current = busy;
  }, []);
  const opsByPathRef = useRef(state.opsByPath);
  useEffect(() => {
    opsByPathRef.current = state.opsByPath;
  }, [state.opsByPath]);

  /** 이 파일의 미리보기를 어떻게 그릴지 + 어느 키에 담을지. 아직 못 그리면 null. */
  const previewPlanFor = useCallback((file: FileEntry) => {
    const ops = opsByPathRef.current[file.path];
    if (!file.tree || file.sessionId === undefined || !ops) return null;
    return previewRenderSpec(
      { path: file.path, mtime: file.mtime },
      file.tree,
      ops.includedIds,
      ops.previewHiddenIds,
      ops.soloIds,
      presetRef.current?.lineColor ?? null
    );
  }, []);

  useEffect(() => {
    // loading(=loadProgress 상태)만으로는 부족하다. 로드 큐가 방금 시작한 것은
    // 같은 커밋 안에서 아직 상태에 반영되지 않아, 두 효과가 한 렌더에서 나란히
    // 출발할 수 있다 — 중지했다가 재개할 때가 정확히 그 경우다(이미 열린 파일이
    // 있어 준비 큐도 할 일이 있고, 로드 큐도 남은 대기 파일로 출발한다). 그러면
    // 세션 두 칸을 두고 다투다 'unknown or evicted session'이 난다. 효과는 선언
    // 순서대로 도니, 로드 큐가 동기적으로 세워둔 ref를 여기서 보면 그 틈이 없다.
    if (loading || drainingRef.current || prefetchingRef.current) return;
    if (prefetchCancelled) return;

    const pending = () => {
      const cache = previewCacheRef.current;
      const ready = filesRef.current.filter(
        (f) =>
          f.status === "open" &&
          !prefetchFailedRef.current.has(f.path) &&
          // 보고 있는 파일은 건드리지 않는다. 그 파일은 캔버스가 어차피 그려서
          // 같은 캐시에 넣으므로 여기서 또 그릴 이유가 없고, 무엇보다 한 파일을
          // 두 군데서 열면 서로를 밀어낸다: 둘 다 자기 세션 id를 들고 있다가
          // 축출되면 각자 재오픈하는데, 세션 칸이 둘뿐이라 그 재오픈이 상대의
          // 세션을 걷어찬다. 그러다 재시도 상한을 넘겨 실패한 것이
          // "미리보기를 미리 만들지 못한 파일"의 정체였다(활성 파일 하나만 그랬다).
          f.path !== activePathRef.current
      );
      return ready
        .filter((f) => {
          const plan = previewPlanFor(f);
          return plan?.key != null && cache.get(plan.key) === undefined;
        })
        .map((f) => f.path);
    };
    if (pending().length === 0) return;

    prefetchingRef.current = true;
    const failures: Array<{ path: string; message: string }> = [];

    void drainLoadQueue({
      pendingPaths: pending,
      processPath: async (path) => {
        // 화면이 그림을 그리는 동안에는 비켜선다. 세션이 두 칸뿐이라 둘이 동시에
        // 열면 서로의 세션을 밀어내고, 그러다 재시도 상한을 넘기면 사람이 보려던
        // 그림이 실패한다 — 미리 만들어두려다 지금 보는 화면을 망치는 셈이다.
        for (let waited = 0; canvasRenderingRef.current && waited < PREFETCH_YIELD_MAX_MS; waited += 200) {
          await new Promise((resolve) => window.setTimeout(resolve, 200));
        }

        const file = filesRef.current.find((f) => f.path === path);
        if (!file) return;
        const plan = previewPlanFor(file);
        if (!plan || !plan.key || plan.visibleIds.length === 0) return;
        try {
          // 축출-재오픈이 끼면 세션 id가 바뀐다. 그림을 만든 그 id로 담아야
          // 화면 쪽이 같은 키를 만들어 찾아낸다.
          let sid = file.sessionId!;
          const { pngPath } = await withEvictedSessionRetry(
            path,
            sid,
            (s) =>
              plan.documentView
                ? renderDocumentPreview(s, PREVIEW_MAX_SIZE)
                : renderPreview(s, plan.visibleIds, PREVIEW_MAX_SIZE, presetRef.current?.lineColor ?? null),
            (r) => {
              sid = r.sessionId;
              refreshSession(path, r);
            }
          );
          previewCacheRef.current.set(plan.key, await loadPngDataUrl(pngPath));
        } catch (e) {
          // 한 파일의 실패로 준비 전체를 멈추지 않는다. 예전에는 여기서 예외가
          // 큐 밖으로 나가 회차가 통째로 끊겼고, 효과가 다시 돌면서 같은 파일에서
          // 또 끊겨 진행률이 0에서 움직이지 않았다.
          //
          // 실패한 파일은 이번 세션 동안 다시 시도하지 않는다 — 그래야 큐가
          // 끝난다. 그 파일은 눌렀을 때 화면이 직접 그린다.
          prefetchFailedRef.current.add(path);
          failures.push({ path, message: toEngineError(e).message });
        }
      },
      onProgress: setPrefetchProgress,
      // 로드 큐가 출발하면 즉시 비켜선다. 사람이 기다리는 것은 파일이 열리는
      // 쪽이고, 미리 만들어두는 일은 그 뒤에 해도 된다. 취소 표시는 건드리지
      // 않으므로 로드가 끝나 loading이 내려가면 알아서 다시 돈다.
      cancelled: () => prefetchCancelledRef.current || drainingRef.current,
    })
      .then(() => {
        // 미리 만들어두는 일이 실패해도 작업을 막지 않는다(누를 때 그리면 된다).
        // 다만 조용히 넘기지는 않는다 — 파일마다 카드를 내면 화면을 덮으므로
        // 한 장으로 모은다.
        if (failures.length === 0) return;
        pushError(`미리보기를 미리 만들지 못한 파일 ${failures.length}개`, {
          message: failures.map((f) => `${fileName(f.path)} — ${f.message}`).join("\n"),
          traceback: "",
        });
      })
      .catch((e) => pushError("미리보기 준비 중단", toEngineError(e)))
      .finally(() => {
        prefetchingRef.current = false;
      });
  }, [loading, prefetchCancelled, state.files, state.opsByPath, state.activePath, previewPlanFor, refreshSession, pushError]);

  /**
   * 진행바 자리에 띄울 "중지됨" 문구. 도는 큐가 있으면 진행바가 우선이라 null이다.
   *
   * 파일 열기가 중지된 경우에는 남은 개수를 말한다 — 사람이 아쉬워하는 값이 그것이다.
   * 미리보기 준비만 중지된 경우에는 세지 않는다: 무엇이 남았는지는 캐시 적중까지
   * 봐야 알 수 있어 렌더마다 열린 파일 전부의 트리를 걷게 된다. 재개를 누르면
   * 큐가 스스로 다시 세고, 할 일이 없으면 그대로 끝난다(버튼은 사라진다).
   */
  const stoppedLabel = useMemo(() => {
    if (loading || prefetchProgress !== null) return null;
    const idle = state.files.filter((f) => f.status === "idle").length;
    if (loadCancelled && idle > 0) return `남은 파일 ${idle}개`;
    if (prefetchCancelled) return "미리보기 준비";
    return null;
  }, [loading, prefetchProgress, state.files, loadCancelled, prefetchCancelled]);

  // 로드 큐가 지나간 뒤에도 프리셋이 안 걸린 파일을 위한 그물. 프리셋 목록은
  // 비동기로 읽히므로(PresetBar) 그보다 파일이 먼저 열렸을 수 있고, 그런 파일은
  // presetApplied가 false로 남는다. 래치가 서 있는 파일은 건드리지 않으므로
  // 사람이 해둔 편집을 덮지 않는다.
  //
  // 큐가 도는 동안에는 비켜선다. 큐가 여는 파일마다 어차피 프리셋을 붙이는데,
  // 그 사이 openSuccess가 반영된 렌더를 이 효과가 먼저 보면 같은 파일에 적용이
  // 두 번 나간다 — 두 번째는 이미 밀려난 세션을 붙들고 실패할 수 있다.
  useEffect(() => {
    const path = state.activePath;
    const sessionId = activeFile?.sessionId;
    if (loading) return;
    if (!path || !sessionId || !selectedPreset) return;
    if (activeFile?.presetApplied !== false) return;
    void applyPresetEffect(dispatch, path, sessionId, selectedPreset);
  }, [state.activePath, activeFile?.sessionId, activeFile?.presetApplied, selectedPreset, loading, dispatch]);

  /**
   * 지금 파일에서 썸네일을 받을 레이어들. 내용으로 만든 키라, 세션이 재오픈되어
   * tree가 새 배열로 바뀌어도 값은 그대로다 — 아래 효과가 그때 다시 돌지 않게
   * 하는 것이 요점이다.
   */
  const thumbIdsKey = useMemo(
    () => (activeFile?.tree ? pixelLeafIds(activeFile.tree).join(",") : ""),
    [activeFile?.tree]
  );

  // Background thumbnail render per opened file, in chunks. A failure lands on
  // the error stack and leaves that file's rows showing names only.
  //
  // Chunked because the engine serves its stdin queue strictly in order: one
  // request covering all 165 layers of a real plate occupies it for ~13s, and
  // the preview the artist is actually waiting for sits behind that. Per
  // chunk the wait is ~1s, and rows fill in progressively instead of all at
  // the end. Chunks are issued one at a time (each awaited before the next),
  // so a chunk's PNGs are always read before the engine's render-dir ring
  // rotates them away.
  useEffect(() => {
    const path = state.activePath;
    const sessionId = activeFile?.sessionId;
    const tree = activeFile?.tree;
    if (!path || !sessionId || !tree) return;
    // 로드 큐가 도는 동안에는 양보한다. 썸네일은 한 파일에 수십 번 요청을 내는데,
    // 엔진 세션은 두 개뿐이라 그 요청들이 큐가 방금 연 세션을 밀어내 버린다.
    // 큐가 끝나면 fetchedPathsRef에 표시가 없으므로 그때 다시 걸린다.
    if (loading) return;
    if (fetchedPathsRef.current.has(path)) return;
    fetchedPathsRef.current.add(path);

    const ids = pixelLeafIds(tree);
    if (ids.length === 0) return;

    let cancelled = false;
    let finished = false;
    void (async () => {
      try {
        await new Promise((resolve) => window.setTimeout(resolve, THUMBNAIL_START_DELAY_MS));
        // 청크마다 갱신되는 현재 세션 id. 처음 잡은 값을 끝까지 쓰면, 중간에 한 번
        // 축출돼 재오픈된 뒤로는 남은 청크가 전부 죽은 id로 나간다 — 청크마다
        // 재오픈(=PSD 전체 재파싱)이 한 번씩 붙어 세션 두 칸을 쉴 새 없이
        // 갈아치우고, 그 바람에 다른 작업의 세션까지 말려든다.
        let currentSid = sessionId;
        for (let i = 0; i < ids.length; i += THUMBNAIL_CHUNK_SIZE) {
          if (cancelled) return;
          const chunk = ids.slice(i, i + THUMBNAIL_CHUNK_SIZE);
          const { thumbs } = await withEvictedSessionRetry(
            path,
            currentSid,
            (sid) => renderThumbnails(sid, chunk, 48),
            (result) => {
              currentSid = result.sessionId;
              refreshSession(path, result);
            }
          );
          const entries = await Promise.all(
            Object.entries(thumbs).map(async ([id, path_]) => [Number(id), await loadPngDataUrl(path_)] as const)
          );
          if (cancelled) return;
          setThumbsByPath((prev) => ({ ...prev, [path]: { ...prev[path], ...Object.fromEntries(entries) } }));
        }
        finished = true;
      } catch (e) {
        if (cancelled) return;
        pushError("썸네일 렌더링 실패", toEngineError(e));
      }
    })();

    return () => {
      cancelled = true;
      // Switching away mid-run leaves this file with only some of its rows
      // filled. Clearing the marker lets a later visit pick the rest up —
      // keeping it would strand those rows on names-only forever.
      if (!finished) fetchedPathsRef.current.delete(path);
    };
    // tree 배열이나 sessionId가 아니라 "어떤 레이어들의 썸네일인가"(thumbIdsKey)에
    // 반응한다. 세션이 조용히 재오픈되면 둘 다 값은 그대로인 채 바뀌는데, 그것을
    // 의존성으로 두면 효과가 다시 돌고 정리 함수가 fetchedPathsRef의 표시를 지워
    // 31개 청크를 처음부터 다시 시작한다. 그 재시작이 또 재오픈을 부르면서
    // 엔진을 영영 붙잡는다 — 미리보기 준비가 0에서 멈춰 있던 원인이 이것이다.
  }, [state.activePath, thumbIdsKey, loading, refreshSession, pushError]);

  // Removing a file (FilePanel's "×") drops its thumbnails/fetch-marker too,
  // so re-adding the same path later re-fetches instead of reusing stale
  // (or, worse, silently absent) thumbnail data.
  useEffect(() => {
    const validPaths = new Set(state.files.map((f) => f.path));
    setThumbsByPath((prev) => {
      let changed = false;
      const next: typeof prev = {};
      for (const [p, v] of Object.entries(prev)) {
        if (validPaths.has(p)) next[p] = v;
        else changed = true;
      }
      return changed ? next : prev;
    });
    for (const p of fetchedPathsRef.current) {
      if (!validPaths.has(p)) fetchedPathsRef.current.delete(p);
    }
  }, [state.files]);

  return (
    <div className="app-shell" style={{ gridTemplateColumns: `240px 1fr ${treeWidth}px` }}>
      <EngineStatus onRestarted={engineRestarted} onError={pushError} />

      <PresetBar
        sessionId={activeFile?.sessionId}
        path={activeFile?.path}
        hasManualEdits={activeFile?.edited === true}
        onApplied={applyPresetResult}
        onSessionRefreshed={refreshSession}
        onError={pushError}
        onSelectedPresetChange={setSelectedPreset}
      />

      <div className="toolbar">
        <button type="button" onClick={() => setExportOpen(true)} disabled={!activeFile?.sessionId}>
          내보내기...
        </button>
        <button type="button" onClick={() => setBottomTab("batch")}>
          배치 실행...
        </button>
      </div>

      <FilePanel
        files={state.files}
        activePath={state.activePath}
        loadProgress={loadProgress ? { ...loadProgress, label: "여는 중" } : null}
        prefetchProgress={prefetchProgress ? { ...prefetchProgress, label: "미리보기 준비 중" } : null}
        stopped={stoppedLabel}
        onAddFiles={handleAddFiles}
        onSelectFile={selectFile}
        onRemoveFile={removeFile}
        onCancelLoad={cancelLoad}
        onResume={handleResume}
        onError={pushError}
      />

      <div className="preview-area">
        <PreviewCanvas
          sessionId={activeFile?.sessionId}
          path={activeFile?.path}
          mtime={activeFile?.mtime}
          status={activeFile?.status}
          tree={activeFile?.tree}
          includedIds={ops.includedIds}
          previewHiddenIds={ops.previewHiddenIds}
          soloIds={ops.soloIds}
          lineColor={selectedPreset?.lineColor ?? null}
          paused={loading}
          cache={previewCacheRef.current}
          onRenderingChange={handleCanvasRendering}
          onSessionRefreshed={refreshSession}
          onError={pushError}
        />
      </div>

      <div className="layer-tree-panel">
        <div
          className="panel-resize-handle"
          role="separator"
          aria-label="레이어 패널 폭 조절"
          aria-orientation="vertical"
          onPointerDown={handleResizeStart}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeEnd}
          onPointerCancel={handleResizeEnd}
          onDoubleClick={() => {
            const reset = clampTreePanelWidth(DEFAULT_TREE_PANEL_WIDTH, window.innerWidth);
            setTreeWidth(reset);
            window.localStorage.setItem(TREE_PANEL_WIDTH_STORAGE_KEY, String(reset));
          }}
          title="드래그해서 폭 조절 (더블클릭: 기본값)"
        />
        <LayerTree
          sessionId={activeFile?.sessionId}
          roleTokens={selectedPreset?.roleTokens ?? DEFAULT_ROLE_TOKENS}
          tree={activeFile?.tree}
          path={activeFile?.path}
          status={activeFile?.status}
          ops={ops}
          matchedIds={(state.activePath && state.matchedIdsByPath[state.activePath]) || []}
          thumbs={(state.activePath && thumbsByPath[state.activePath]) || {}}
          onSetIncluded={setIncluded}
          onTogglePreview={togglePreview}
          onSetPreviewHidden={setPreviewHidden}
          onToggleSolo={toggleSolo}
          onSetSolo={setSolo}
          onPushOp={pushOp}
          onError={pushError}
        />
      </div>

      <div className="bottom-strip">
        <div className="bottom-tabs">
          <button
            type="button"
            className={bottomTab === "history" ? "active" : ""}
            onClick={() => setBottomTab("history")}
          >
            히스토리
          </button>
          <button type="button" className={bottomTab === "batch" ? "active" : ""} onClick={() => setBottomTab("batch")}>
            배치
          </button>
        </div>
        <div className="bottom-panel">
          {bottomTab === "history" ? (
            <OpsHistory ops={ops} tree={activeFile?.tree} onUndo={undoOp} />
          ) : (
            <BatchPanel files={state.files} onError={pushError} />
          )}
        </div>
      </div>

      {exportOpen && activeFile?.sessionId && (
        <ExportDialog
          sessionId={activeFile.sessionId}
          srcPath={activeFile.path}
          ops={ops}
          tree={activeFile.tree}
          preset={selectedPreset}
          onPushOp={pushOp}
          onClose={() => setExportOpen(false)}
          onSessionRefreshed={refreshSession}
          onError={pushError}
        />
      )}

      <ErrorPanel errors={state.errors} onDismiss={dismissError} />
    </div>
  );
}

function App() {
  return (
    <AppProvider>
      <AppShell />
    </AppProvider>
  );
}

export default App;
