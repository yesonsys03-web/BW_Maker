import { useEffect, useRef, useState } from "react";
import "./App.css";
import { AppProvider, useAppStore } from "./state/appStore";
import { FilePanel } from "./components/FilePanel";
import { LayerTree } from "./components/LayerTree";
import { ErrorPanel } from "./components/ErrorPanel";
import { PreviewCanvas } from "./components/PreviewCanvas";
import { PresetBar } from "./components/PresetBar";
import { loadPngDataUrl, renderThumbnails } from "./lib/engine";
import { pixelLeafIds, toEngineError } from "./lib/preview";

function AppShell() {
  const {
    state,
    ops,
    activeFile,
    addFiles,
    selectFile,
    togglePreview,
    setPreviewHidden,
    pushOp,
    setIncluded,
    applyPresetResult,
    dismissError,
    pushError,
  } = useAppStore();

  // Thumbnails per file path (layer ids are only unique within a session, so
  // keying by path — not a flat id map — avoids collisions across files).
  const [thumbsByPath, setThumbsByPath] = useState<Record<string, Record<number, string>>>({});
  const fetchedPathsRef = useRef<Set<string>>(new Set());

  // Background, one-shot thumbnail render per opened file. A failure lands on
  // the error stack and leaves that file's rows showing names only.
  useEffect(() => {
    const path = state.activePath;
    const sessionId = activeFile?.sessionId;
    const tree = activeFile?.tree;
    if (!path || !sessionId || !tree) return;
    if (fetchedPathsRef.current.has(path)) return;
    fetchedPathsRef.current.add(path);

    const ids = pixelLeafIds(tree);
    if (ids.length === 0) return;

    void (async () => {
      try {
        const { thumbs } = await renderThumbnails(sessionId, ids, 48);
        const entries = await Promise.all(
          Object.entries(thumbs).map(async ([id, path_]) => [Number(id), await loadPngDataUrl(path_)] as const)
        );
        setThumbsByPath((prev) => ({ ...prev, [path]: Object.fromEntries(entries) }));
      } catch (e) {
        pushError("썸네일 렌더링 실패", toEngineError(e));
      }
    })();
  }, [state.activePath, activeFile?.sessionId, activeFile?.tree, pushError]);

  return (
    <div className="app-shell">
      <PresetBar
        sessionId={activeFile?.sessionId}
        hasPendingOps={ops.ops.length > 0}
        onApplied={applyPresetResult}
        onError={pushError}
      />

      <FilePanel files={state.files} activePath={state.activePath} onAddFiles={addFiles} onSelectFile={selectFile} />

      <div className="preview-area">
        <PreviewCanvas
          sessionId={activeFile?.sessionId}
          tree={activeFile?.tree}
          includedIds={ops.includedIds}
          previewHiddenIds={ops.previewHiddenIds}
          onError={pushError}
        />
      </div>

      <div className="layer-tree-panel">
        <LayerTree
          tree={activeFile?.tree}
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
        <span className="bottom-strip-placeholder">히스토리 / 배치 패널 (준비 중)</span>
      </div>

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
