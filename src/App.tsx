import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import { AppProvider, applyPresetEffect, openFileEffect, useAppStore, type AppState, type FileEntry } from "./state/appStore";
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
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { loadPngDataUrl, pinFile, psdMtimes, renderDocumentPreview, renderPreview, renderThumbnails } from "./lib/engine";
import { ProjectBar, type ProjectBusy } from "./components/ProjectBar";
import {
  BOTTOM_PANEL_HEIGHT_STORAGE_KEY,
  DEFAULT_FILE_PANEL_WIDTH,
  FILE_PANEL_WIDTH_STORAGE_KEY,
  clampFilePanelWidth,
  parseFilePanelWidth,
  DEFAULT_BOTTOM_PANEL_HEIGHT,
  DEFAULT_TREE_PANEL_WIDTH,
  clampBottomPanelHeight,
  parseBottomPanelHeight,
  TREE_PANEL_WIDTH_STORAGE_KEY,
  clampTreePanelWidth,
  parseTreePanelWidth,
} from "./lib/layout";
import { drainLoadQueue } from "./lib/loadQueue";
import { DEFAULT_ROLE_TOKENS } from "./lib/presets";
import { PREVIEW_MAX_SIZE, toEngineError } from "./lib/preview";
import { PreviewCache, needsPrefetch, previewRenderSpec } from "./lib/previewCache";
import { openFailureReport, type FailedOpen } from "./lib/openReport";
import {
  previewFileName,
  reconcileProject,
  restorablePreviews,
  type ProjectEntry,
  type ProjectFile,
} from "./lib/project";
import { loadProjectFrom, saveProjectTo } from "./lib/projectFs";
import { undrawableReport } from "./lib/skippedReport";
import { missingFromChunk, nextThumbnailChunk } from "./lib/thumbnailQueue";
import { withEvictedSessionRetry } from "./lib/sessionRetry";
import type { EdgeLines, Preset } from "./lib/types";

type BottomTab = "history" | "batch";

/**
 * 썸네일을 한 번에 몇 장씩 요청할지. 엔진은 stdin 큐를 순서대로 처리하므로 이
 * 값이 곧 "썸네일 작업이 사람이 누른 요청을 최대 얼마나 붙잡아두는가"이다.
 *
 * 8이었는데 2로 줄였다. 48px 썸네일 한 장에도 레이어의 원본 해상도 RGBA를 통째로
 * 디코드하기 때문에(engine/psd_engine/render.py) 장당 비용이 파일 크기에 따라
 * 수십 배로 벌어진다 — 실측으로 1.4GB짜리 파일은 8장 묶음 하나가 **19초**였고,
 * 그동안 클릭한 것이 전부 그 뒤에서 기다렸다. 총량은 그대로지만 한 번에 잡는
 * 시간이 1/4로 줄어 반응이 그만큼 빨라진다.
 */
const THUMBNAIL_CHUNK_SIZE = 2;

/** 실패 목록이 아직 없는 파일용. 매번 새 Set을 만들지 않기 위한 것. */
const EMPTY_IDS: ReadonlySet<number> = new Set<number>();

/**
 * 미리보기 준비 큐가 "화면이 그리는 중"을 기다려 주는 시간의 상한. 화면 쪽이
 * 어떤 이유로든 끝났다는 신호를 못 보내더라도 준비가 영영 멈추지는 않게 한다.
 */
const PREFETCH_YIELD_MAX_MS = 60_000;

/**
 * 프리셋이 바뀐 뒤 미리보기 준비 큐가 서 있는 시간. 이 안에 다음 수정이 오면
 * 다시 처음부터 센다 — 연타로 고치는 동안에는 큐가 한 번도 출발하지 않는다.
 * 손을 멈추면 그때 마지막 설정 하나로만 준비가 돈다(prefetchHold 참고).
 */
const PREFETCH_PRESET_HOLD_MS = 2_000;

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
    clearFiles,
    togglePreview,
    setPreviewHidden,
    toggleSolo,
    setSolo,
    setEdgeColour,
    setManualLine,
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
  /**
   * 위 상태의 거울. 큐가 한 회차를 마치고 곧바로 다음 회차를 계산하는데, 그때
   * React는 아직 새 상태를 반영하지 않았다 — 상태만 보면 방금 받은 묶음을 다시
   * 집어 큐가 끝나지 않는다. 갱신은 항상 둘을 함께 한다.
   */
  const thumbsRef = useRef<Record<string, Record<number, string>>>({});
  /** 파일별로 "지금 화면에 보이는 행". LayerTree가 스크롤에 맞춰 갈아 끼운다. */
  const wantedThumbsRef = useRef<Map<string, number[]>>(new Map());
  /** 렌더에 실패했거나 엔진이 끝내 주지 않은 id. 다시 집으면 큐가 끝나지 않는다. */
  const failedThumbsRef = useRef<Map<string, Set<number>>>(new Map());
  const drainingThumbsRef = useRef(false);

  const rememberFailedThumbs = useCallback((path: string, ids: number[]) => {
    if (ids.length === 0) return;
    const failed = failedThumbsRef.current.get(path) ?? new Set<number>();
    for (const id of ids) failed.add(id);
    failedThumbsRef.current.set(path, failed);
  }, []);

  // 레이어 패널 폭. 파일이 아니라 사람에게 붙는 설정이라 재시작을 넘어 유지된다.
  const [treeWidth, setTreeWidth] = useState(() =>
    parseTreePanelWidth(window.localStorage.getItem(TREE_PANEL_WIDTH_STORAGE_KEY))
  );
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // 파일 패널 폭. 핸들이 오른쪽 모서리에 있으므로 오른쪽으로 끌수록 넓어진다.
  const [fileWidth, setFileWidth] = useState(() =>
    parseFilePanelWidth(window.localStorage.getItem(FILE_PANEL_WIDTH_STORAGE_KEY))
  );
  const fileDragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  function handleFileResizeStart(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    fileDragRef.current = { startX: e.clientX, startWidth: fileWidth };
  }

  function handleFileResizeMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = fileDragRef.current;
    if (!drag) return;
    setFileWidth(clampFilePanelWidth(drag.startWidth + (e.clientX - drag.startX), window.innerWidth));
  }

  function handleFileResizeEnd(e: React.PointerEvent<HTMLDivElement>) {
    if (!fileDragRef.current) return;
    fileDragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    window.localStorage.setItem(FILE_PANEL_WIDTH_STORAGE_KEY, String(fileWidth));
  }

  // 아래 패널 높이. 폭과 같은 이유로 사람에게 붙는 설정이라 재시작을 넘어 유지된다.
  const [bottomHeight, setBottomHeight] = useState(() =>
    parseBottomPanelHeight(window.localStorage.getItem(BOTTOM_PANEL_HEIGHT_STORAGE_KEY))
  );
  const bottomDragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  function handleBottomResizeStart(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    bottomDragRef.current = { startY: e.clientY, startHeight: bottomHeight };
  }

  function handleBottomResizeMove(e: React.PointerEvent<HTMLDivElement>) {
    const drag = bottomDragRef.current;
    if (!drag) return;
    // 핸들은 패널 위쪽 모서리에 있으므로 위로 끌수록 높아진다.
    setBottomHeight(clampBottomPanelHeight(drag.startHeight - (e.clientY - drag.startY), window.innerHeight));
  }

  function handleBottomResizeEnd(e: React.PointerEvent<HTMLDivElement>) {
    if (!bottomDragRef.current) return;
    bottomDragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    window.localStorage.setItem(BOTTOM_PANEL_HEIGHT_STORAGE_KEY, String(bottomHeight));
  }

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

  /** 열려 있는 `.bwproj` 폴더. null이면 아직 저장한 적 없다(저장은 수동, 설계 6절). */
  const [projectDir, setProjectDir] = useState<string | null>(null);
  /**
   * 같은 값의 ref. 저장은 이것을 "지난번 미리보기가 들어 있는 폴더"로 쓴다
   * (saveProjectTo의 carryFrom). 상태로 읽으면 writeProjectTo의 의존성이 되어
   * 저장할 때마다 함수 정체가 바뀌는데, 그러면 그 함수를 붙들고 있는 키 핸들러와
   * 버튼이 매번 다시 걸린다.
   */
  const projectDirRef = useRef<string | null>(null);
  useEffect(() => {
    projectDirRef.current = projectDir;
  }, [projectDir]);
  /**
   * 프로젝트를 열 때 수정시각이 달라 저장된 작업을 버린 파일. 목록이 표시한다 —
   * 조용히 버리면 아티스트는 자기가 한 지정이 왜 없는지 알 수 없다(설계 4절).
   */
  const [staleProjectPaths, setStaleProjectPaths] = useState<string[]>([]);
  /**
   * 프로젝트 열기나 저장이 도는 중. ProjectBar의 버튼 셋을 함께 잠근다.
   * 불리언이 아니라 **어느 쪽인지**를 담는다 — 라벨이 사실만 말하려면(열기 중에
   * "저장 중..."이 뜨면 안 된다) 화면이 그것을 알아야 하고, 거절 안내도 무슨 일이
   * 진행 중인지 말해야 한다.
   */
  const [projectBusy, setProjectBusy] = useState<ProjectBusy>(null);
  /**
   * 같은 판단의 ref 판. 상태로는 못 막는 것이 있다: setState는 다음 렌더에나
   * 보이므로 **같은 틱**에 들어온 두 번째 호출은 옛 null을 본다. ⌘S는 키
   * 리피트로 정확히 그렇게 들어오고(버튼과 달리 disabled를 지나지 않는다),
   * project_write_text는 truncate+write라 회차가 겹치면 잘린 project.json이
   * 남는다 — 그 JSON은 그 폴더의 유일본이라 다음에 아예 못 연다.
   */
  const projectBusyRef = useRef<ProjectBusy>(null);
  /**
   * "비우기"가 몇 번 일어났는지. 저장은 await를 지나므로 그 사이에 목록이 비워질
   * 수 있는데, 그때 착지한 저장이 setProjectDir(dir)로 프로젝트를 **다시 연다** —
   * handleClearFiles의 setProjectDir(null)이 되돌려지고, 화면은 "저장 안 된 작업"
   * 이었다가 폴더 이름으로 돌아간다. 그러면 C1이 세운 불변식("비우기 = 이 폴더는
   * 끝났다")이 풀려 다음 ⌘S가 다시 그 폴더를 겨눈다.
   */
  const clearSeqRef = useRef(0);
  /** PresetBar에 보내는 "이 프리셋을 고르라" 요청. PresetBar의 같은 이름 prop 주석 참고. */
  const [selectPresetRequest, setSelectPresetRequest] = useState<{ name: string; preset: Preset } | null>(null);
  /**
   * 지금 열려 있는 프로젝트가 담고 있던 항목(경로 → 항목). 저장할 때 화면 상태에
   * 없는 tree/mtime을 메우는 폴백이다 — buildProject 주석 참고. 버린 항목(stale)은
   * 넣지 않는다: 그 작업은 일부러 버린 것이라 되살아나면 안 된다.
   */
  const restoredEntriesRef = useRef<Record<string, ProjectEntry>>({});

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
  /**
   * 리듀서가 openSuccess에서 읽는 것과 같은 원본(state.restoredMtimeByPath)의
   * 거울. 로드 큐가 "이 파일이 복원본이고 방금 연 mtime이 그대로인지"를 리듀서와
   * 같은 조건으로 판정하려면 이걸 읽어야 한다 — FileEntry.mtime을 대신 쓰면
   * engineRestarted가 그 필드만 지우고 restoredMtimeByPath는 그대로 두는 순간
   * 둘이 어긋난다(아래 processPath 주석 참고).
   */
  const restoredMtimeByPathRef = useRef(state.restoredMtimeByPath);
  const loadingRef = useRef(false);
  useEffect(() => {
    filesRef.current = state.files;
    activePathRef.current = state.activePath;
    presetRef.current = selectedPreset;
    restoredMtimeByPathRef.current = state.restoredMtimeByPath;
  }, [state.files, state.activePath, selectedPreset, state.restoredMtimeByPath]);

  /**
   * 이 인스턴스가 버려졌는지. 세 배경 큐가 회차 사이에 확인한다.
   *
   * 큐의 중복 실행은 ref로 막는데(draining/prefetching/drainingThumbs), 그 ref는
   * 마운트된 인스턴스의 것이다. 리마운트되면 새 인스턴스는 빈 ref로 자기 큐를
   * 출발시키고 옛 큐는 그대로 돈다 — 옛 큐가 읽는 취소 ref도 함께 버려졌으므로
   * 진행바의 "중지"조차 닿지 않는다. 개발 중 HMR로 이것이 여섯 겹까지 쌓여 세션
   * 두 칸을 두고 서로를 밀어냈고, 파일 40~49개가 한꺼번에 'unknown or evicted
   * session'으로 떨어졌다(세션 id가 900까지 갔다 — 그만큼 PSD를 다시 읽었다).
   *
   * 큐 효과들보다 먼저 선언한다. 효과는 선언 순서대로 도니, 다시 마운트될 때
   * 큐가 출발하기 전에 표시가 내려가 있어야 한다. StrictMode의 정리-재설치도
   * 같은 인스턴스라 여기서 다시 false가 되고, 그 정리와 재설치 사이는 동기
   * 구간이라 큐가 그 틈에 확인할 일이 없다.
   */
  const abandonedRef = useRef(false);
  useEffect(() => {
    abandonedRef.current = false;
    return () => {
      abandonedRef.current = true;
    };
  }, []);

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
   * 목록을 비운다. 비우기는 "이 폴더는 끝났다"는 뜻이므로 중지 표시와 미리 만들기
   * 실패 목록도 함께 내린다 — 이전 폴더에서 세운 중지가 다음 폴더의 큐를 막으면
   * 사람은 누른 적 없는 중지를 만나게 된다.
   */
  const handleClearFiles = useCallback(() => {
    setLoadCancel(false);
    setPrefetchCancel(false);
    prefetchFailedRef.current.clear();
    // "파일이 바뀜"은 방금 치운 프로젝트에 대한 이야기다. 남겨두면 나중에 같은
    // 경로를 다시 추가했을 때 근거 없는 배지가 붙는다. 저장용 폴백 항목도 같은
    // 이유로 함께 내린다 — 목록에서 치운 파일의 옛 트리를 되살릴 이유가 없다.
    setStaleProjectPaths([]);
    restoredEntriesRef.current = {};
    // 지금 도는 저장이 있다면 그 저장은 이 비우기 **이전**의 목록을 쓴 것이다.
    // 표를 올려 두면 그 회차가 착지하면서 아래 setProjectDir(null)을 되돌리지
    // 못한다(clearSeqRef 주석 참고).
    clearSeqRef.current += 1;
    // 열려 있는 프로젝트도 함께 닫는다. 안 닫으면 ProjectBar는 그 폴더가 열려
    // 있다고 말하고 ⌘S가 그 폴더를 겨눈다 — buildProject는 파일이 없어 루프를
    // 안 도니 blocked도 0이고, 거절 가드가 한 번도 안 걸린 채 어제까지의 작업이
    // files: []로 덮인다. 비우기는 "이 폴더는 끝났다"는 뜻이므로 닫는 것이 맞고,
    // 그러면 다음 ⌘S는 위치를 다시 묻는다.
    setProjectDir(null);
    clearFiles();
  }, [clearFiles, setLoadCancel, setPrefetchCancel]);

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

    // 라인이 하나도 안 나온 자리를 파일별로 모은다. 파일마다 카드를 띄우면 화면이
    // 카드로 덮여 진짜 오류가 묻히므로 끝에 한 장으로 낸다.
    const undrawableByPath: Array<{ path: string; layers: SkippedLayer[] }> = [];
    // 열리지 않은 파일. 파일마다 카드를 띄우면 화면이 덮이므로 끝에 한 장으로 낸다 —
    // 빠진 레이어 카드와 같은 이유다.
    const openFailures: FailedOpen[] = [];

    void drainLoadQueue({
      pendingPaths: () => filesRef.current.filter((f) => f.status === "idle").map((f) => f.path),
      processPath: async (path) => {
        // 아직 아무것도 안 보고 있으면 첫 파일을 띄워준다. 그 뒤로는 사람이
        // 보고 있는 화면을 뺏지 않는다.
        const result = await openFileEffect(dispatch, path, {
          activate: activePathRef.current === null,
          collect: (failed, error) =>
            openFailures.push({ path: failed, name: fileName(failed), message: error.message, traceback: error.traceback }),
        });
        const preset = presetRef.current;
        // 복원한 파일이고 mtime이 그대로면 openSuccess가 이미 presetApplied를
        // true로 세워 이전 세션의 편집을 지켰다(appStore.tsx의 openSuccess 주석
        // 참고) — 그 위에 자동 적용을 또 걸면 방금 지킨 체크박스·병합 편집이
        // 프리셋 매칭 결과로 조용히 덮인다. openSuccess가 dispatch한
        // presetApplied를 이 컴포넌트가 다시 읽으려면 재렌더와 filesRef 갱신
        // effect를 거쳐야 하고 그 시점은 여기서 보장할 수 없으므로, 리듀서와 같은
        // 조건(복원된 mtime === 방금 연 mtime)을 여기서도 독립적으로 계산한다.
        //
        // FileEntry.mtime이 아니라 restoredMtimeByPathRef를 읽는다. mtime은
        // engineRestarted가 파일 항목을 통째로 { path, status: "idle" }로 갈아
        // 끼우며 함께 지운다(appStore.tsx 참고) — 그때 restoredMtimeByPath는
        // 그대로 남는데, mtime을 대리 지표로 쓰면 그 순간부터 이 판정이 리듀서의
        // 판정과 어긋난다. 엔진이 재시작해도 디스크의 PSD는 그대로이므로 복원한
        // 작업은 여전히 유효하고, 큐가 그 파일을 다시 여는 순간에도 지켜야 한다.
        //
        // 읽는 **시점**도 같은 이야기다. 열기 전에 잡아두면 여는 도중에 프로젝트
        // 열기(handleProjectOpen → restoreProject)가 착지했을 때 낡은 값을 들게
        // 된다: 리듀서의 openSuccess는 그 dispatch 뒤에 처리되므로 새 맵을 보고
        // ops를 지키는데(presetApplied: true), 큐만 옛 undefined를 들고 프리셋을
        // 걸어 방금 복원한 그 ops를 덮는다. 열기 뒤에 읽으면 두 판정이 같은 맵을
        // 본다 — 어긋날 수 있는 두 신호는 언젠가 어긋난다.
        const priorRestoredMtime = restoredMtimeByPathRef.current[path];
        const alreadyApplied = priorRestoredMtime !== undefined && priorRestoredMtime === result?.mtime;
        // 프리셋은 파일을 연 직후에 붙인다 — 그래야 세션이 아직 엔진의 LRU 안에
        // 있어서 다시 파싱하지 않는다.
        if (result && preset && !alreadyApplied) {
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
      cancelled: () => abandonedRef.current || loadCancelledRef.current,
    })
      .then(() => {
        const failures = openFailureReport(openFailures);
        if (failures) {
          pushError(failures.title, { message: failures.message, traceback: failures.traceback }, failures.paths);
        }

        const report = undrawableReport(
          undrawableByPath.map(({ path, layers }) => ({ path, name: fileName(path), layers }))
        );
        if (report) pushError(report.title, { message: report.message, traceback: "" }, report.paths);
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
  /**
   * 프리셋이 방금 바뀌었으니 준비 큐는 잠깐 서 있으라는 표시.
   *
   * 라인색·경계선은 미리보기 키에 그대로 들어간다. 그래서 프리셋을 한 번 고치면
   * 목록에 있는 파일 **전부**의 키가 동시에 갈리고, 큐는 89장을 처음부터 다시
   * 만들기 시작한다. 그런데 프리셋 편집은 원래 연타로 하는 일이라(껐다 켜고 다시
   * 보고) 그렇게 만든 한 배치는 다음 수정에서 통째로 버려진다 — 게다가 새로 만든
   * 판이 캐시 예산을 밀고 들어와 되돌렸을 때 쓸 옛 판까지 밀어낸다.
   *
   * 엔진이 요청을 하나씩만 처리하므로(engine/psd_engine/rpc.py의 main 루프) 이건
   * 놀고 있는 CPU를 쓰는 문제가 아니다. 큐가 잡고 있는 동안 아티스트가 누른
   * 그림은 그 뒤에 줄을 선다. 손을 멈춘 뒤에 출발시키는 편이 훨씬 빠르다.
   *
   * 보고 있는 파일은 이 표시와 무관하게 곧바로 그려진다 — 그 한 장은 준비 큐가
   * 아니라 PreviewCanvas가 그리고, 큐는 애초에 활성 파일을 건너뛴다.
   */
  const [prefetchHold, setPrefetchHold] = useState(false);
  /**
   * 직전에 쓰던 프리셋. **처음 정해지는 것은 "바뀐 것"이 아니다** — 앱이 뜨면서
   * 목록의 첫 프리셋이 올라오는 것(undefined → 무엇)까지 세우면, 프리셋을 한 번도
   * 안 건드린 평범한 폴더 열기에서도 준비가 3초 늦게 출발한다.
   */
  const lastPresetRef = useRef<Preset | undefined>(undefined);
  // 프리셋이 바뀌면 세우고, 조용해지면 푼다. 다음 수정이 그 안에 오면 정리 함수가
  // 타이머를 버리고 처음부터 다시 센다 — 연타로 고치는 동안에는 한 번도 안 선다.
  useEffect(() => {
    const previous = lastPresetRef.current;
    lastPresetRef.current = selectedPreset;
    if (previous === undefined || previous === selectedPreset) return;
    setPrefetchHold(true);
    const timer = setTimeout(() => setPrefetchHold(false), PREFETCH_PRESET_HOLD_MS);
    return () => clearTimeout(timer);
  }, [selectedPreset]);
  /** 미리 만들기에 실패한 파일. 다시 집으면 큐가 끝나지 않으므로 빼둔다. */
  const prefetchFailedRef = useRef<Set<string>>(new Set());
  /**
   * 이번에 만들어둔 미리보기의 키. 캐시에서 밀려나도 다시 만들지 않기 위한 것이다
   * — 자세한 이유는 lib/previewCache.ts의 needsPrefetch 주석에 있다.
   */
  const prefetchedKeysRef = useRef<Set<string>>(new Set());
  /**
   * 배치가 도는 중인지. 배경 큐들이 그동안 비켜서기 위한 신호다.
   *
   * 배치는 이제 파일 하나씩 부르므로 파일 사이마다 엔진이 빈다. 그 틈은 사람이
   * 누른 것을 처리하라고 생긴 것이지, 배경 작업이 끼어들라고 생긴 것이 아니다 —
   * 비켜서지 않으면 아티스트가 기다리는 배치가 그만큼 느려진다.
   */
  const batchRunningRef = useRef(false);
  const [batchRunning, setBatchRunning] = useState(false);
  const handleBatchRunningChange = useCallback((busy: boolean) => {
    batchRunningRef.current = busy;
    setBatchRunning(busy);
  }, []);

  /** 화면이 지금 엔진에 렌더를 걸고 있는지. 준비 큐가 그동안 비켜서기 위한 신호. */
  const canvasRenderingRef = useRef(false);
  const handleCanvasRendering = useCallback((busy: boolean) => {
    canvasRenderingRef.current = busy;
  }, []);
  const opsByPathRef = useRef(state.opsByPath);
  useEffect(() => {
    opsByPathRef.current = state.opsByPath;
  }, [state.opsByPath]);
  /** 파일별 프리셋 매칭 결과. 색 통일을 어디에 걸지 정한다(previewCache의 lineColorIdsFor). */
  const matchedIdsByPathRef = useRef(state.matchedIdsByPath);
  useEffect(() => {
    matchedIdsByPathRef.current = state.matchedIdsByPath;
  }, [state.matchedIdsByPath]);

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
      presetRef.current?.lineColor ?? null,
      matchedIdsByPathRef.current[file.path],
      presetRef.current?.edgeLines ?? null,
      ops.edgeColourIds
    );
  }, []);

  /**
   * 복원한 항목의 PNG를 미리보기 캐시에 넣는다. 키를 다시 계산해 저장된 것과
   * 맞을 때만 넣는 판단은 restorablePreviews가 한다(설계 5절).
   *
   * 색·경계선을 **인자로 받는다**. presetRef.current를 여기서 읽으면 앱을 껐다
   * 켠 직후에는 그것이 undefined라 키가 lineColor=null/edgeLines=null로 계산돼
   * 저장된 키와 안 맞고, 복원한 미리보기가 통째로 버려진다 — 틀린 그림이 뜨지는
   * 않지만 "껐다 켜고 프로젝트를 연다"는 이 기능의 주 경로에서 이득이 0이 된다.
   * 넘겨야 하는 것은 앱의 현재 선택이 아니라 **저장 시점 프로젝트의 프리셋**이다:
   * 디스크의 PNG는 그 설정으로 그려졌고 previewKey도 그 설정으로 계산됐다.
   */
  const primeRestoredPreviews = useCallback(
    (
      entries: ProjectEntry[],
      previews: Map<string, string>,
      lineColor: string | null,
      edgeLines: EdgeLines | null
    ) => {
      for (const [key, dataUrl] of restorablePreviews(entries, previews, lineColor, edgeLines)) {
        previewCacheRef.current.set(key, dataUrl);
        prefetchedKeysRef.current.add(key);
      }
    },
    []
  );

  /**
   * 지금 화면 상태로 프로젝트 하나를 만든다. 저장이 그대로 쓴다.
   *
   * 이 함수의 어려운 부분은 그리기가 아니라 **잃지 않기**다. 화면 상태만 보고
   * 만들면 조용히 파일이 빠지는 길이 둘 있다.
   *
   * 1. 캐시 키를 previewPlanFor로 얻으면 안 된다. 그 콜백은 sessionId가 없으면
   *    null을 주는데(화면이 지금 그릴 수 있는가를 묻는 함수라 거기서는 그게 맞다),
   *    복원 직후의 항목에는 sessionId가 없다 — restoreProject가 { path, status,
   *    tree, mtime }만 세우고 세션은 로드 큐가 나중에 채운다. 그대로 쓰면
   *    **프로젝트를 열자마자 저장하는 순간** 아직 안 열린 파일 전부의
   *    previewKey·previewFile이 null로 저장되고, previews/의 PNG가 새 저장에서
   *    빠져 다음에 열면 그 파일들이 그림 없이 복원된다. previewRenderSpec 자체는
   *    sessionId를 쓰지 않으므로(가드는 previewPlanFor에만 있다) 여기서는
   *    restorablePreviews와 같은 모양으로 직접 계산한다 — 저장과 복원이 같은
   *    함수로 같은 키를 만들어야 다음에 열 때 대조가 맞는다.
   *
   * 2. `engineRestarted`는 **모든** 파일 항목을 { path, status: "idle" }로
   *    갈아치운다(appStore.tsx) — tree도 mtime도 사라지고 opsByPath만 남는다.
   *    "tree/mtime이 없으면 건너뛴다"로 두면 엔진이 죽었다 살아난 직후 ⌘S 한 번에
   *    **files: []인 project.json이 기존 폴더를 덮어쓴다.** 확인창도 경고도 없이
   *    하루 작업이 사라진다. 그래서 둘을 같이 한다:
   *     - tree/mtime은 열려 있는 프로젝트의 항목으로 **메운다**. PSD가 안 바뀐 한
   *       그 tree는 여전히 유효하다(그게 이 기능의 전제다). 바뀌었다면 저장되는
   *       mtime도 옛것이므로 다음에 열 때 reconcileProject가 "파일이 바뀜"으로
   *       잡아낸다 — 조용히 지나가지 않는다.
   *     - 그래도 못 만드는 파일은 **세어서 돌려준다**(`blocked`). 호출부가 저장을
   *       거절한다. 새로 저장하는 세션(프로젝트를 연 적이 없다)에는 메울 원본이
   *       없으므로 이 쪽만이 마지막 방어선이다.
   *
   * 세는 기준을 `ops`의 존재로 잡는 것이 요점이다. ops는 파일을 한 번이라도 연
   * 뒤에만 생기고(openSuccess의 buildInitialOpsState, 또는 restoreProject) 엔진
   * 재시작을 넘어 살아남는다 — 즉 "담을 작업이 있다"와 정확히 같은 뜻이다.
   * 아직 열리는 중이거나 열기에 실패한 파일에는 ops가 없어 저장을 막지 않는다.
   * 그것까지 막으면 폴더에 깨진 PSD가 한 장만 있어도 영영 저장할 수 없다.
   */
  const buildProject = useCallback((): {
    project: ProjectFile;
    previews: Map<string, string>;
    /** 담을 작업은 있는데 그것을 실을 tree/mtime이 지금 없는 파일 수. */
    blocked: number;
    /**
     * 화면 목록에는 있는데 이번 저장에 안 담긴 파일 수(열기에 실패한 것은 뺀다).
     * 저장을 막지는 않는다 — 깨진 PSD 한 장이나 아직 열리는 중이라는 이유로
     * 저장이 영영 막히면 그게 더 나쁘다. 대신 **말한다**: 조용히 버리면
     * 아티스트는 다음에 열었을 때 그 파일이 왜 없는지 알 수 없다("파일이 바뀜"
     * 배지가 있는 이유와 같다).
     */
    omitted: number;
  } => {
    const previews = new Map<string, string>();
    const files: ProjectEntry[] = [];
    const lineColor = presetRef.current?.lineColor ?? null;
    const edgeLines = presetRef.current?.edgeLines ?? null;
    let blocked = 0;
    let omitted = 0;
    for (const file of filesRef.current) {
      const ops = opsByPathRef.current[file.path];
      const fallback = restoredEntriesRef.current[file.path];
      const tree = file.tree ?? fallback?.tree;
      // mtime이 없으면 다음에 열 때 이 항목이 아직 맞는지 확인할 방법이 없다 —
      // 확인할 수 없는 것은 애초에 담지 않는다(parseProject도 같은 판단이다).
      const mtime = file.mtime ?? fallback?.mtime;
      if (!tree || mtime === undefined || !ops) {
        // 열기에 실패한 파일만 면제한다 — 거기엔 담을 것이 애초에 없다. 위
        // "ops의 존재로 센다"는 기준은 **아직 안 열린 파일을 세지 않는다**:
        // ops는 한 번이라도 연 뒤에만 생기기 때문이다. 그래서 열림/처리중/대기가
        // 섞인 목록에서 ⌘S를 누르면 대기 중인 파일들이 아무 말 없이 빠진다.
        if (ops) blocked += 1;
        else if (file.status !== "error") omitted += 1;
        continue;
      }
      const matchedIds = matchedIdsByPathRef.current[file.path];
      const plan = previewRenderSpec(
        { path: file.path, mtime },
        tree,
        ops.includedIds,
        ops.previewHiddenIds,
        ops.soloIds,
        lineColor,
        matchedIds,
        edgeLines,
        ops.edgeColourIds
      );
      let previewFile: string | null = null;
      if (plan.key) {
        const dataUrl = previewCacheRef.current.get(plan.key);
        if (dataUrl) {
          // 이름은 반드시 키의 해시다. 경로로 지으면 납품 파일명이 디스크에 남는다
          // — 기밀이다(설계 7절). saveProjectTo가 한 번 더 검사한다.
          previewFile = previewFileName(plan.key);
          previews.set(previewFile, dataUrl);
        } else if (fallback?.previewKey === plan.key && fallback.previewFile) {
          // 캐시엔 없지만 **설정이 그대로**라, 열어둔 프로젝트 폴더에 있는 그 그림이
          // 여전히 맞다. 캐시는 예산이 있어 밀려나므로(89장이면 곧 밀린다) 이 줄이
          // 없으면 아무것도 안 바꾸고 ⌘S만 눌러도 담긴 미리보기가 줄어든다.
          // 바이트를 여기서 읽지는 않는다 — saveProjectTo가 원본 폴더에서 이어받고,
          // 그 파일이 없으면 참조를 지운다(carryMissingPreviews).
          previewFile = fallback.previewFile;
        }
      }
      files.push({
        path: file.path,
        mtime,
        tree,
        // 키를 만든 값을 그대로 적는다. `?? []`로 적으면 저장할 때 쓴 키
        // (matchedIds가 undefined → "all")와 복원할 때 만드는 키([] → "")가
        // 갈려 방금 쓴 PNG를 한 장도 못 읽고, 색 통일 대상이 "전부"에서
        // "아무 데도 안"으로 뒤집힌다(ProjectEntry.matchedIds 주석 참고).
        matchedIds: matchedIds ?? null,
        ops,
        previewKey: plan.key,
        previewFile,
      });
    }
    return {
      project: { version: 1, preset: presetRef.current ?? null, files },
      previews,
      blocked,
      omitted,
    };
  }, []);

  /**
   * 다른 프로젝트 작업이 도는 중이라 저장 요청을 받지 않을 때. 저장의 두 진입점
   * (⌘S 경로와 ⌘⇧S 경로)이 같은 판단을 해야 해서 한 곳에 둔다.
   *
   * **열기와 겹친 것은 말한다.** 아티스트는 ⌘S를 눌렀고(⌘⇧S였다면 폴더까지
   * 골랐고) 아무 일도 안 일어난 것을 본다 — writeProjectTo의 다른 두 거절은 전부
   * 카드를 내는데 이 경로만 조용했다.
   *
   * **저장끼리 겹친 것은 말하지 않는다.** 그것은 ⌘S 키 리피트이고(projectBusyRef
   * 주석), 요청한 저장은 지금 실제로 돌고 있으며 버튼도 "저장 중..."이라고 말하고
   * 있다. 리피트마다 카드를 내면 한 번 붙든 키가 카드 여러 장이 된다.
   */
  const refuseSaveWhileBusy = useCallback((): boolean => {
    const busy = projectBusyRef.current;
    if (busy === null) return false;
    if (busy === "open") {
      pushError("프로젝트를 저장하지 않았습니다", {
        message: "프로젝트를 여는 중입니다. 다 열린 뒤에 저장하세요.",
        traceback: "",
      });
    }
    return true;
  }, [pushError]);

  const writeProjectTo = useCallback(
    async (dir: string) => {
      // 회차가 겹치는 것부터 막는다(projectBusyRef 주석 참고). 상태가 아니라
      // ref이고, 첫 await 앞에서 서므로 같은 틱의 두 번째 호출이 여기서 멈춘다.
      // finally에서 내리는 것도 ref라 "가장 먼저 끝난 회차가 버튼을 다시 켠다"는
      // 문제가 없다 — 애초에 회차가 하나뿐이다.
      if (refuseSaveWhileBusy()) return;
      projectBusyRef.current = "save";
      setProjectBusy("save");
      // 이 저장이 쓰는 것은 **지금** 목록이다. 그 사이에 비워졌는지 착지할 때
      // 대조하려고 표를 떠 둔다(clearSeqRef 주석 참고).
      const clearSeq = clearSeqRef.current;
      try {
        const { project, previews, blocked, omitted } = buildProject();
        // 잃을 것이 있으면 쓰지 않는다. 덮어쓰기는 되돌릴 수 없고, 이 폴더에는
        // 지난 저장이 들어 있다 — 반쯤 만들어진 프로젝트로 덮느니 아무것도 안 하는
        // 편이 낫다. 개수만 말한다: 납품 파일 경로·이름은 기밀이라 메시지에 넣지 않는다.
        if (blocked > 0) {
          pushError("프로젝트를 저장하지 않았습니다", {
            message:
              `파일 ${blocked}개의 레이어 정보가 지금 없습니다(엔진이 방금 재시작했을 수 있습니다). ` +
              `지금 저장하면 그 파일들의 작업이 프로젝트에서 사라집니다. ` +
              `그 파일들이 다시 열린 뒤에 저장하세요.`,
            traceback: "",
          });
          return;
        }
        // 담을 항목이 하나도 없으면 쓰지 않는다. blocked와 같은 축의 다른
        // 판단이다 — blocked는 "담을 작업이 있는데 못 담는다"이고 여기는
        // "루프를 한 번도 안 돌았다"라 blocked가 0으로 남는다. 목록을 비운 뒤의
        // ⌘S가 정확히 이 경우고, 그대로 두면 files: []가 지난 저장을 덮는다.
        // (X로 파일을 하나씩 뺀 것은 의도한 조작이므로 막지 않는다 — 0장일 때만.)
        if (project.files.length === 0) {
          pushError("프로젝트를 저장하지 않았습니다", {
            message:
              `담을 파일이 0개입니다. 지금 저장하면 이 폴더에 들어 있던 작업이 빈 프로젝트로 덮입니다. ` +
              `파일을 목록에 올린 뒤에 저장하세요.`,
            traceback: "",
          });
          return;
        }
        // 열어둔 폴더를 넘긴다 — 캐시에서 밀려난 그림을 거기서 이어받는다.
        // 다른 이름으로 저장이면 원본에서 새 폴더로 옮겨 실린다.
        await saveProjectTo(dir, project, previews, projectDirRef.current);
        // 미리보기는 **지금 캐시에 있는 것만** 담긴다(buildProject 참고). 프리셋을
        // 바꾼 직후에 저장하면 키가 전부 갈린 뒤라 한두 장밖에 안 담기는데,
        // 폴더에는 지난 저장이 남긴 PNG가 그대로 쌓여 있어서 "다 담겼다"로 보인다.
        // 실제로 그렇게 저장된 프로젝트가 있었다 — 89개 중 1장이었고, 다시 열자
        // 87장을 처음부터 다시 그렸다. 개수를 말해주는 것이 그 침묵을 없앤다.
        // (경로·파일명은 기밀이라 개수만 적는다.)
        const withPreview = project.files.filter((f) => f.previewFile).length;
        // 그 사이에 "비우기"가 눌렸으면 프로젝트를 다시 열지 않는다. 여기서
        // 열면 방금 내린 projectDir가 되살아나 다음 ⌘S가 다시 그 폴더를 겨눈다.
        if (clearSeqRef.current === clearSeq) setProjectDir(dir);
        // 쓰기는 끝났다. 그래도 화면에 있던 파일이 빠졌다면 그 사실은 말한다 —
        // 개수만이다(납품 경로·파일명은 기밀).
        if (omitted > 0) {
          pushError("일부 파일이 프로젝트에 담기지 않았습니다", {
            message:
              `파일 ${omitted}개가 아직 열리지 않아 이번 저장에 담기지 않았습니다. ` +
              `그 파일들이 다 열린 뒤에 다시 저장하면 함께 담깁니다.`,
            traceback: "",
          });
        }
        if (withPreview < project.files.length) {
          pushError("미리보기는 일부만 담겼습니다", {
            message:
              `미리보기 ${withPreview}/${project.files.length}장이 담겼습니다. ` +
              `담기지 않은 파일은 이 프로젝트를 다시 열 때 미리보기를 처음부터 다시 만듭니다. ` +
              `"미리보기 준비"가 끝난 뒤에 다시 저장하면 전부 담깁니다.`,
            traceback: "",
          });
        }
      } catch (e) {
        pushError("프로젝트 저장 실패", toEngineError(e));
      } finally {
        projectBusyRef.current = null;
        setProjectBusy(null);
      }
    },
    [buildProject, pushError, refuseSaveWhileBusy]
  );

  const handleProjectSaveAs = useCallback(async () => {
    // 가드가 다이얼로그 **앞에** 선다. 뒤에 두면 창이 뜨고, 사람이 폴더를 고르고,
    // 그러고 나서야 writeProjectTo가 돌아선다 — 고르게 해놓고 버리는 셈이다.
    // handleProjectOpen도 같은 순서다.
    if (refuseSaveWhileBusy()) return;
    try {
      // save는 **파일** 경로를 고르게 하지만 그 경로에 폴더를 만드는 것이
      // `.bwproj`다 — saveProjectTo가 mkdir부터 한다(설계 2.2절).
      const dir = await saveDialog({ defaultPath: "작업.bwproj" });
      if (!dir) return;
      await writeProjectTo(dir);
    } catch (e) {
      pushError("프로젝트 저장 실패", toEngineError(e));
    }
  }, [writeProjectTo, pushError, refuseSaveWhileBusy]);

  const handleProjectSave = useCallback(() => {
    if (!projectDir) return void handleProjectSaveAs();
    void writeProjectTo(projectDir);
  }, [projectDir, handleProjectSaveAs, writeProjectTo]);

  const handleProjectOpen = useCallback(async () => {
    // 열기도 저장과 같은 축이다. 파일마다 IPC를 두 번 순차로 도는 동안(25장이면
    // 50회) 아무 표시가 없어서, 두 번 누르면 restoreProject 둘이 경합한다.
    if (projectBusyRef.current) return;
    projectBusyRef.current = "open";
    setProjectBusy("open");
    try {
      // recursive 같은 옵션은 넣지 않는다. 디스크 접근은 전부 Rust 커맨드를
      // 거치므로(projectFs.ts) 다이얼로그가 열어주는 fs 스코프에 기댈 것이 없다.
      const dir = await openDialog({ directory: true });
      if (!dir || Array.isArray(dir)) return;
      const { project, previews } = await loadProjectFrom(dir);
      // 여기까지는 디스크 읽기뿐이라 엔진에 아무것도 안 간다(설계 3절).
      const mtimes = await psdMtimes(project.files.map((f) => f.path));
      const { fresh, stale } = reconcileProject(project, mtimes);
      dispatch({ type: "restoreProject", entries: fresh });
      // 바뀐 파일도 목록에는 남는다 — 작업 없이, 평범하게 열리는 파일로(설계 4절).
      // restoreProject는 fresh만 받으므로(그게 맞다 — 복원할 것이 없다) 여기서
      // 따로 넣어야 한다. 이걸 빼면 그 파일들은 목록에서 통째로 사라지고
      // "파일이 바뀜" 배지는 아무 데도 안 붙는다: 아티스트는 자기 파일 셋이
      // 어디로 갔는지 알 수 없다.
      //
      // 순서상 뒤로 밀리는 것은 감수한다. 앞자리는 그대로 쓸 수 있는 파일이
      // 차지하는 편이 낫고(restoreProject가 첫 파일을 활성으로 세운다),
      // 다시 해야 하는 파일이 배지와 함께 아래에 모이는 것이 읽기도 쉽다.
      if (stale.length > 0) dispatch({ type: "addFiles", paths: stale });
      // 저장할 때 화면 상태에 없는 tree/mtime을 메울 원본(buildProject 주석 참고).
      // 살아남은 항목만 넣는다 — 버린 것이 되살아나면 안 된다.
      restoredEntriesRef.current = Object.fromEntries(fresh.map((e) => [e.path, e]));
      // 저장 시점 프로젝트의 프리셋으로 프라이밍한다 — 앱의 현재 선택이 아니다
      // (primeRestoredPreviews 주석 참고).
      primeRestoredPreviews(
        fresh,
        previews,
        project.preset?.lineColor ?? null,
        project.preset?.edgeLines ?? null
      );
      setStaleProjectPaths(stale);
      // 그리고 앱의 선택도 그 프리셋으로 옮긴다. 안 옮기면 화면이 다시 그릴 때
      // 계산하는 키가 방금 프라이밍한 것과 달라져 전부 다시 그린다.
      //
      // **이름이 아니라 객체를 넘긴다.** 이름만 넘기면 PresetBar가 presets.json의
      // 같은 이름을 집는데, 저장 이후 그 프리셋을 편집했으면 그것은 다른 설정이다
      // — 그 순간 방금 프라이밍한 키가 전부 어긋나 담아둔 PNG를 한 장도 못 쓴다.
      if (project.preset) {
        setSelectPresetRequest({ name: project.preset.name, preset: project.preset });
      }
      // 프로젝트를 여는 것은 "이제 새로 시작한다"는 뜻이다 — 이전 폴더에서 세운
      // 중지가 남아 있으면 복원한 파일이 배경에서 열리지 않는다(handleAddFiles와
      // 같은 판단). 실패 목록도 그 폴더의 것이라 함께 내린다.
      setLoadCancel(false);
      setPrefetchCancel(false);
      prefetchFailedRef.current.clear();
      setProjectDir(dir);
    } catch (e) {
      pushError("프로젝트 열기 실패", toEngineError(e));
    } finally {
      projectBusyRef.current = null;
      setProjectBusy(null);
    }
  }, [dispatch, primeRestoredPreviews, pushError, setLoadCancel, setPrefetchCancel]);

  // ⌘S 저장 / ⌘⇧S 다른 이름으로 저장(설계 6절). App.tsx에는 기존 키 핸들러가
  // 없어 새로 만든다. 다른 두 핸들러와는 겹치지 않는다 — PreviewCanvas의 뷰
  // 단축키는 viewCommandFor가 metaKey/ctrlKey가 있으면 null을 주고(lib/preview.ts),
  // LayerTree의 것은 Escape(메뉴/모달 닫기)와 L(라인 지정 토글)인데 L은 수식키가
  // 하나라도 끼면 스스로 넘긴다 — ⌘S 바로 옆이라 그 문이 특히 중요하다.
  // L은 그 위에 문이 둘 더 있다: `.modal-overlay`가 떠 있으면 넘기고, 포인터가
  // 레이어 패널 위에 있을 때만 먹는다. 새 모달을 만들 때 그 클래스를 쓰지 않으면
  // 모달 위에서 누른 L이 뒤의 레이어 지정을 바꾼다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      if (e.shiftKey) void handleProjectSaveAs();
      else handleProjectSave();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleProjectSave, handleProjectSaveAs]);

  useEffect(() => {
    // loading(=loadProgress 상태)만으로는 부족하다. 로드 큐가 방금 시작한 것은
    // 같은 커밋 안에서 아직 상태에 반영되지 않아, 두 효과가 한 렌더에서 나란히
    // 출발할 수 있다 — 중지했다가 재개할 때가 정확히 그 경우다(이미 열린 파일이
    // 있어 준비 큐도 할 일이 있고, 로드 큐도 남은 대기 파일로 출발한다). 그러면
    // 세션 두 칸을 두고 다투다 'unknown or evicted session'이 난다. 효과는 선언
    // 순서대로 도니, 로드 큐가 동기적으로 세워둔 ref를 여기서 보면 그 틈이 없다.
    if (loading || drainingRef.current || prefetchingRef.current || batchRunning) return;
    if (prefetchCancelled) return;
    // 프리셋을 만지는 중이면 아직 출발하지 않는다(prefetchHold 주석 참고).
    if (prefetchHold) return;

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
        .filter((f) => needsPrefetch(previewPlanFor(f)?.key ?? null, cache, prefetchedKeysRef.current))
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
        // 기다리는 동안에도 중지를 본다. 예전에는 회차 사이에서만 확인해서, 최대
        // 60초를 기다리는 사이에 누른 중지가 그동안 아무 반응이 없었다.
        for (let waited = 0; canvasRenderingRef.current && waited < PREFETCH_YIELD_MAX_MS; waited += 200) {
          if (prefetchCancelledRef.current || drainingRef.current || abandonedRef.current) return;
          await new Promise((resolve) => window.setTimeout(resolve, 200));
        }

        const file = filesRef.current.find((f) => f.path === path);
        if (!file) return;
        const plan = previewPlanFor(file);
        if (!plan || !plan.key) return;
        // 그릴 것이 없는 파일도 **처리한 것으로 적어둔다**. 안 적으면 큐를 못
        // 떠난다: needsPrefetch는 "캐시에 없고 이번에 만든 적도 없으면 대기"로
        // 고르는데, 만든 것은 아래에서 키를 적고 실패한 것은 prefetchFailedRef로
        // 빠지는 반면 이 경우만 어느 그물에도 안 걸렸다. 그러면 큐가 도는 조건에
        // opsByPath가 들어 있으므로(이 효과의 deps), 아티스트가 눈을 하나 켜고 끌
        // 때마다 그 파일들로 큐가 다시 서서 "미리보기 준비 중"이 끝없이 뜬다.
        //
        // 규칙이 아무것도 못 잡는 판이 실제로 있다 — 라인이 제외 그룹 안에 있는
        // 경우다. 그런 판이 폴더에 여러 장이면 큐는 영원히 안 빈다.
        //
        // 키에 담아두는 것이 맞다: 나중에 손으로 라인을 지정하거나 눈을 켜면
        // visibleIds가 달라져 키 자체가 바뀌므로, 그때는 정상적으로 다시 만든다.
        if (plan.visibleIds.length === 0) {
          prefetchedKeysRef.current.add(plan.key);
          return;
        }
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
                : renderPreview(s, plan.visibleIds, PREVIEW_MAX_SIZE,
                                presetRef.current?.lineColor ?? null, plan.lineColorIds,
                                presetRef.current?.edgeLines ?? null, plan.edgeColourIds,
                                plan.includedIds),
            (r) => {
              sid = r.sessionId;
              refreshSession(path, r);
            }
          );
          previewCacheRef.current.set(plan.key, await loadPngDataUrl(pngPath));
          prefetchedKeysRef.current.add(plan.key);
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
      cancelled: () =>
        abandonedRef.current || prefetchCancelledRef.current || drainingRef.current || batchRunningRef.current,
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
  }, [loading, prefetchCancelled, prefetchHold, batchRunning, state.files, state.opsByPath, state.activePath, previewPlanFor, refreshSession, pushError]);

  /**
   * 파일별로 손으로 "라인으로 지정"한 레이어. 배치가 이걸 함께 보내야, 이름
   * 규칙이 닿지 않는 판을 아티스트가 화면에서 고쳐둔 것이 배치에도 반영된다
   * (BatchPanel의 같은 이름 prop 주석 참고).
   *
   * 빈 것은 담지 않는다 — 대부분의 파일에는 지정이 없고, 빈 배열까지 실어
   * 보내면 엔진 쪽에서 "지정이 있는 파일"과 구별이 안 된다.
   */
  const manualLineIdsByPath = useMemo(() => {
    const out: Record<string, number[]> = {};
    for (const [path, ops] of Object.entries(state.opsByPath)) {
      if (ops.manualLineIds.length > 0) out[path] = ops.manualLineIds;
    }
    return out;
  }, [state.opsByPath]);

  /**
   * 파일별 내보내기 장수. opsByPath에 이미 있는 값을 세는 것뿐이라 따로 저장하거나
   * 엔진을 부를 것이 없다. 프리셋이 아직 안 걸린 파일은 빠진다 — 그때의 entries는
   * 매칭 전의 전체 픽셀 leaf라 내보낼 장수가 아니다.
   */
  const entryCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const file of state.files) {
      if (!file.presetApplied) continue;
      const ops = state.opsByPath[file.path];
      if (ops) out[file.path] = ops.entries.length;
    }
    return out;
  }, [state.files, state.opsByPath]);

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

  // 썸네일은 "화면에 보이는 행"만 만든다. LayerTree가 스크롤에 따라 목록을
  // 알려주고(onThumbnailsNeeded), 여기서 아직 못 받은 것만 청크로 나눠 받는다.
  //
  // 예전에는 파일을 열자마자 전 레이어를 만들었다. 실측으로 엔진 시간의 66%가
  // 아무도 안 보는 썸네일이었고(303회 / 1038초), 엔진은 stdin 큐를 순서대로
  // 처리하므로 그동안 사람이 누른 것이 전부 그 뒤에서 기다렸다 — 자동 병합이
  // "어떤 파일은 즉시, 어떤 파일은 몇 초"로 갈리던 이유가 이것이다. 계산 자체는
  // 0.01초였고, 기다린 것은 앞에 쌓인 썸네일 청크들이었다.
  //
  // 청크를 하나씩 await하는 것은 그대로다. 엔진 렌더 디렉터리는 세대가 돌아가므로
  // 다음 청크를 내기 전에 이번 PNG를 다 읽어야 한다.
  const drainThumbnails = useCallback(async () => {
    if (drainingThumbsRef.current) return;
    drainingThumbsRef.current = true;
    try {
      for (;;) {
        const path = activePathRef.current;
        // 로드 큐가 도는 동안에는 양보한다. 세션이 두 칸뿐이라 썸네일 요청이
        // 큐가 방금 연 세션을 밀어낸다. 큐가 끝나면 아래 효과가 다시 부른다.
        //
        // 버려진 인스턴스에서도 멈춘다 — activePathRef는 언마운트 뒤에도 값을
        // 들고 있어, 이 확인이 없으면 죽은 화면이 남은 청크를 계속 받아간다.
        if (abandonedRef.current || !path || loadingRef.current || batchRunningRef.current) return;
        const file = filesRef.current.find((f) => f.path === path);
        if (file?.sessionId === undefined) return;
        const chunk = nextThumbnailChunk(
          wantedThumbsRef.current.get(path) ?? [],
          thumbsRef.current[path],
          failedThumbsRef.current.get(path) ?? EMPTY_IDS,
          THUMBNAIL_CHUNK_SIZE
        );
        if (chunk.length === 0) return;

        let sid = file.sessionId;
        try {
          const { thumbs } = await withEvictedSessionRetry(
            path,
            sid,
            (s) => renderThumbnails(s, chunk, 48),
            (result) => {
              // 청크마다 현재 id를 갱신한다. 처음 잡은 값을 끝까지 쓰면 축출된
              // 뒤의 청크가 전부 죽은 id로 나가 매번 재오픈(=PSD 재파싱)이 붙는다.
              sid = result.sessionId;
              refreshSession(path, result);
            }
          );
          const entries = await Promise.all(
            Object.entries(thumbs).map(async ([id, p]) => [Number(id), await loadPngDataUrl(p)] as const)
          );
          // 상태와 ref를 함께 올린다. 다음 회차가 곧바로 ref를 읽으므로, 상태만
          // 갱신하면 React가 반영하기 전에 같은 묶음을 다시 집어 큐가 돌지 않는다.
          const merged = { ...thumbsRef.current, [path]: { ...thumbsRef.current[path], ...Object.fromEntries(entries) } };
          thumbsRef.current = merged;
          setThumbsByPath(merged);
          // 엔진이 끝내 안 준 id는 없는 것으로 본다 — 안 그러면 같은 묶음이 계속 나간다.
          rememberFailedThumbs(path, missingFromChunk(chunk, thumbs));
        } catch (e) {
          // 이 묶음만 포기하고 나머지는 계속 받는다. 실패한 행은 이름만 보인다.
          rememberFailedThumbs(path, chunk);
          pushError("썸네일 렌더링 실패", toEngineError(e));
        }
      }
    } finally {
      drainingThumbsRef.current = false;
    }
  }, [rememberFailedThumbs, refreshSession, pushError]);

  /** LayerTree가 알려주는 "지금 보이는 행". 목록을 통째로 바꾼다 — 지나간 행은 빠진다. */
  const requestThumbnails = useCallback(
    (visibleIds: number[]) => {
      const path = activePathRef.current;
      if (!path) return;
      wantedThumbsRef.current.set(path, visibleIds);
      void drainThumbnails();
    },
    [drainThumbnails]
  );

  // 로드 큐가 끝났거나 파일이 열렸을 때 멈춰 있던 큐를 다시 깨운다. 보이는 행은
  // 그대로인데 그때는 양보하느라(또는 세션이 없어) 받지 못했을 수 있다.
  useEffect(() => {
    if (!loading) void drainThumbnails();
  }, [loading, state.activePath, activeFile?.sessionId, drainThumbnails]);

  // Removing a file (FilePanel's "×") drops its thumbnails/fetch-marker too,
  // so re-adding the same path later re-fetches instead of reusing stale
  // (or, worse, silently absent) thumbnail data.
  useEffect(() => {
    const validPaths = new Set(state.files.map((f) => f.path));
    let changed = false;
    const next: Record<string, Record<number, string>> = {};
    for (const [p, v] of Object.entries(thumbsRef.current)) {
      if (validPaths.has(p)) next[p] = v;
      else changed = true;
    }
    if (changed) {
      thumbsRef.current = next;
      setThumbsByPath(next);
    }
    for (const map of [wantedThumbsRef.current, failedThumbsRef.current]) {
      for (const p of map.keys()) if (!validPaths.has(p)) map.delete(p);
    }
  }, [state.files]);

  return (
    <div
      className="app-shell"
      style={{
        gridTemplateColumns: `${fileWidth}px 1fr ${treeWidth}px`,
        gridTemplateRows: `auto auto 1fr ${bottomHeight}px`,
      }}
    >
      <EngineStatus onRestarted={engineRestarted} onError={pushError} />

      <PresetBar
        sessionId={activeFile?.sessionId}
        path={activeFile?.path}
        hasManualEdits={activeFile?.edited === true}
        onApplied={applyPresetResult}
        onSessionRefreshed={refreshSession}
        onError={pushError}
        onSelectedPresetChange={setSelectedPreset}
        selectPresetRequest={selectPresetRequest}
      />

      <div className="toolbar">
        <button type="button" onClick={() => setExportOpen(true)} disabled={!activeFile?.sessionId}>
          내보내기...
        </button>
        <button type="button" onClick={() => setBottomTab("batch")}>
          배치 실행...
        </button>
        {/* 그리드 행을 새로 만들지 않고 기존 toolbar 행에 얹는다 — .app-shell의
            grid-template-areas(App.css)와 위쪽 인라인 gridTemplateRows를 함께
            고쳐야 행이 늘어나고, 어긋나면 화면이 통째로 깨진다. */}
        <ProjectBar
          projectDir={projectDir}
          busy={projectBusy}
          onOpen={() => void handleProjectOpen()}
          onSave={handleProjectSave}
          onSaveAs={() => void handleProjectSaveAs()}
        />
      </div>

      <FilePanel
        files={state.files}
        activePath={state.activePath}
        loadProgress={loadProgress ? { ...loadProgress, label: "여는 중" } : null}
        prefetchProgress={prefetchProgress ? { ...prefetchProgress, label: "미리보기 준비 중" } : null}
        stopped={stoppedLabel}
        entryCounts={entryCounts}
        staleProjectPaths={staleProjectPaths}
        onResizeStart={handleFileResizeStart}
        onResizeMove={handleFileResizeMove}
        onResizeEnd={handleFileResizeEnd}
        onResizeReset={() => {
          const reset = clampFilePanelWidth(DEFAULT_FILE_PANEL_WIDTH, window.innerWidth);
          setFileWidth(reset);
          window.localStorage.setItem(FILE_PANEL_WIDTH_STORAGE_KEY, String(reset));
        }}
        onAddFiles={handleAddFiles}
        onSelectFile={selectFile}
        onRemoveFile={removeFile}
        onClearFiles={handleClearFiles}
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
          matchedIds={state.activePath ? state.matchedIdsByPath[state.activePath] : undefined}
          edgeLines={selectedPreset?.edgeLines ?? null}
          edgeColourIds={ops.edgeColourIds}
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
          onSetEdgeColour={setEdgeColour}
          onSetManualLine={setManualLine}
          onPushOp={pushOp}
          onThumbnailsNeeded={requestThumbnails}
          onError={pushError}
        />
      </div>

      <div className="bottom-strip">
        <div
          className="bottom-resize-handle"
          role="separator"
          aria-label="아래 패널 높이 조절"
          aria-orientation="horizontal"
          onPointerDown={handleBottomResizeStart}
          onPointerMove={handleBottomResizeMove}
          onPointerUp={handleBottomResizeEnd}
          onPointerCancel={handleBottomResizeEnd}
          onDoubleClick={() => {
            const reset = clampBottomPanelHeight(DEFAULT_BOTTOM_PANEL_HEIGHT, window.innerHeight);
            setBottomHeight(reset);
            window.localStorage.setItem(BOTTOM_PANEL_HEIGHT_STORAGE_KEY, String(reset));
          }}
          title="끌어서 높이 조절 (더블클릭으로 초기화)"
        />
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
            <BatchPanel
              files={state.files}
              defaultPresetName={selectedPreset?.name ?? null}
              manualLineIdsByPath={manualLineIdsByPath}
              onError={pushError}
              onRunningChange={handleBatchRunningChange}
            />
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
          matchedIds={state.matchedIdsByPath[activeFile.path]}
          onPushOp={pushOp}
          onClose={() => setExportOpen(false)}
          onSessionRefreshed={refreshSession}
          onError={pushError}
        />
      )}

      <ErrorPanel errors={state.errors} onDismiss={dismissError} onSelectFile={selectFile} />
    </div>
  );
}

// initialState는 테스트 전용이다(AppProvider 주석 참고) — main.tsx는 넘기지 않는다.
function App({ initialState }: { initialState?: AppState } = {}) {
  return (
    <AppProvider initialState={initialState}>
      <AppShell />
    </AppProvider>
  );
}

export default App;
