import "./App.css";
import { AppProvider, useAppStore } from "./state/appStore";
import { FilePanel } from "./components/FilePanel";
import { LayerTree } from "./components/LayerTree";
import { ErrorPanel } from "./components/ErrorPanel";

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
    dismissError,
  } = useAppStore();

  return (
    <div className="app-shell">
      <FilePanel files={state.files} activePath={state.activePath} onAddFiles={addFiles} onSelectFile={selectFile} />

      <div className="preview-area">
        <div className="preview-placeholder">미리보기 (준비 중)</div>
      </div>

      <div className="layer-tree-panel">
        <LayerTree
          tree={activeFile?.tree}
          ops={ops}
          matchedIds={state.matchedIds}
          onSetIncluded={setIncluded}
          onTogglePreview={togglePreview}
          onSetPreviewHidden={setPreviewHidden}
          onPushOp={pushOp}
        />
      </div>

      <div className="bottom-strip">
        <span className="bottom-strip-placeholder">프리셋 / 히스토리 / 배치 패널 (준비 중)</span>
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
