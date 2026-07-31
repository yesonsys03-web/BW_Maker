import { useEffect, useRef, useState } from "react";
import "./App.css";
import { AppProvider, useAppStore } from "./state/appStore";
import { FilePanel } from "./components/FilePanel";
import { LayerTree } from "./components/LayerTree";
import { ErrorPanel } from "./components/ErrorPanel";
import { EngineStatus } from "./components/EngineStatus";
import { PreviewCanvas } from "./components/PreviewCanvas";
import { PresetBar } from "./components/PresetBar";
import { OpsHistory } from "./components/OpsHistory";
import { ExportDialog } from "./components/ExportDialog";
import { BatchPanel } from "./components/BatchPanel";
import { loadPngDataUrl, renderThumbnails } from "./lib/engine";
import { pixelLeafIds, toEngineError } from "./lib/preview";
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
    pushOp,
    setIncluded,
    applyPresetResult,
    undoOp,
    dismissError,
    pushError,
    refreshSession,
    engineRestarted,
  } = useAppStore();

  // Thumbnails per file path (layer ids are only unique within a session, so
  // keying by path — not a flat id map — avoids collisions across files).
  const [thumbsByPath, setThumbsByPath] = useState<Record<string, Record<number, string>>>({});
  const fetchedPathsRef = useRef<Set<string>>(new Set());

  const [bottomTab, setBottomTab] = useState<BottomTab>("history");
  const [exportOpen, setExportOpen] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState<Preset | undefined>(undefined);

  // Clear a stale open dialog if its file disappears from under it (e.g. an
  // engine restart resets activePath to null) — otherwise it would spring
  // back open unprompted the next time any file is selected.
  useEffect(() => {
    if (!activeFile) setExportOpen(false);
  }, [activeFile]);

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
    if (fetchedPathsRef.current.has(path)) return;
    fetchedPathsRef.current.add(path);

    const ids = pixelLeafIds(tree);
    if (ids.length === 0) return;

    let cancelled = false;
    let finished = false;
    void (async () => {
      try {
        await new Promise((resolve) => window.setTimeout(resolve, THUMBNAIL_START_DELAY_MS));
        for (let i = 0; i < ids.length; i += THUMBNAIL_CHUNK_SIZE) {
          if (cancelled) return;
          const chunk = ids.slice(i, i + THUMBNAIL_CHUNK_SIZE);
          const { thumbs } = await withEvictedSessionRetry(
            path,
            sessionId,
            (sid) => renderThumbnails(sid, chunk, 48),
            (result) => refreshSession(path, result)
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
  }, [state.activePath, activeFile?.sessionId, activeFile?.tree, refreshSession, pushError]);

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
    <div className="app-shell">
      <EngineStatus onRestarted={engineRestarted} onError={pushError} />

      <PresetBar
        sessionId={activeFile?.sessionId}
        path={activeFile?.path}
        hasPendingOps={ops.ops.length > 0}
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
        onAddFiles={addFiles}
        onSelectFile={selectFile}
        onRemoveFile={removeFile}
        onError={pushError}
      />

      <div className="preview-area">
        <PreviewCanvas
          sessionId={activeFile?.sessionId}
          path={activeFile?.path}
          status={activeFile?.status}
          tree={activeFile?.tree}
          includedIds={ops.includedIds}
          previewHiddenIds={ops.previewHiddenIds}
          onSessionRefreshed={refreshSession}
          onError={pushError}
        />
      </div>

      <div className="layer-tree-panel">
        <LayerTree
          tree={activeFile?.tree}
          path={activeFile?.path}
          status={activeFile?.status}
          ops={ops}
          matchedIds={state.matchedIds}
          thumbs={(state.activePath && thumbsByPath[state.activePath]) || {}}
          onSetIncluded={setIncluded}
          onTogglePreview={togglePreview}
          onSetPreviewHidden={setPreviewHidden}
          onPushOp={pushOp}
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
