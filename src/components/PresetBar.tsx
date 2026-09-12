import { useEffect, useRef, useState } from "react";
import { applyPreset } from "../lib/engine";
import { toEngineError } from "../lib/preview";
import { loadPresets, savePresets } from "../lib/presets";
import { withEvictedSessionRetry } from "../lib/sessionRetry";
import type { EngineError, OpenResult, Operation, Preset } from "../lib/types";
import { PresetDialog, type PresetDialogMode } from "./PresetDialog";

interface PresetBarProps {
  sessionId: number | undefined;
  path: string | undefined;
  /**
   * 사람이 직접 한 편집(병합/이름변경/포함 변경)이 남아 있는지. ops가 비어
   * 있는지로 보지 않는 이유는 appStore의 FileEntry.edited 주석 참고 — 프리셋
   * 적용 자체가 ops를 만들기 때문에, 그걸 근거로 삼으면 지울 편집이 없는데도
   * 확인창이 뜬다.
   */
  hasManualEdits: boolean;
  onApplied: (matchedLayerIds: number[], operations: Operation[]) => void;
  onSessionRefreshed: (path: string, result: OpenResult) => void;
  onError: (title: string, error: EngineError) => void;
  onSelectedPresetChange: (preset: Preset | undefined) => void;
  /**
   * 드롭다운 선택의 원본 — 목록 이름과, 프로젝트에서 올라온 판. 이 컴포넌트의
   * 로컬 상태가 아니라 App이 든다. 로컬로 들면 리마운트되는 순간(개발 중 핫
   * 리로드가 실제로 그랬다) 선택이 목록 첫 항목으로 조용히 떨어진다 — CHAR로
   * 저장한 프로젝트가 캐시 작업 중 BG로 바뀌어 보인 사고가 그것이다. 규칙은
   * 하나다: **사용자가 바꾸지 않는 한 선택은 절대 저절로 바뀌지 않는다.**
   * 이 컴포넌트가 선택을 바꿔도 되는 경우는 목록 첫 로드에서 아무 선택도 없을
   * 때(첫 실행)와 저장된 이름이 목록에서 사라졌을 때뿐이다.
   */
  selectedName: string | null;
  onSelectedNameChange: (name: string) => void;
  projectPreset: Preset | null;
  onProjectPresetChange: (preset: Preset | null) => void;
  /**
   * "이 프리셋으로 맞추라"는 요청. 프로젝트를 열 때 그 프로젝트가 담고 있던
   * 프리셋으로 맞추기 위한 것이다 — 안 맞추면 복원해둔 미리보기의 캐시 키가
   * 지금 선택과 달라져 화면이 전부 다시 그린다(설계 5·7절).
   *
   * **이름이 아니라 프리셋 객체를 들고 온다.** 이름으로 목록에서 찾으면, 저장
   * 이후 아티스트가 그 프리셋을 편집한 순간(라인색 하나만 꺼도) 이름은 같고
   * 내용은 다른 것이 올라온다. 그러면 복원한 미리보기의 키가 **전부** 어긋나
   * 담아둔 PNG를 한 장도 못 쓴다. 아티스트가 정한 규칙이 "되살리는 것은 화면
   * 그대로 전부"이므로, 프로젝트를 열 때는 저장 시점 프리셋이 이긴다. 목록의
   * 편집본을 쓰려면 드롭다운에서 그것을 고르면 된다.
   *
   * **초기값 prop이 아니라 사건이다.** 목록은 마운트 때 한 번 읽혀 loaded[0]을
   * 고르는데 프로젝트는 그보다 한참 뒤에 열리므로, 초기값으로 내려보내면 아무
   * 효과가 없다. 그래서 열 때마다 **새 객체**로 오고, 이 컴포넌트는 그 객체
   * 하나당 딱 한 번만 선택을 바꾼다.
   *
   * 한 번만 반응하는 것이 핵심이다. 값으로 보고 목록과 함께 다시 맞추면, 그 뒤
   * 아티스트가 다른 프리셋을 골라도 프리셋을 편집·저장해 목록 배열이 새로
   * 만들어지는 순간 프로젝트의 것으로 되돌아간다.
   */
  selectPresetRequest: { name: string; preset: Preset } | null;
}

/**
 * 프로젝트에서 올라온 프리셋을 고르는 `<option>`의 값. 목록의 어떤 이름과도
 * 겹치지 않아야 한다 — 같은 이름의 편집본이 목록에 따로 있는 것이 정확히 이
 * 기능이 다루는 경우이고, 둘을 같은 값으로 두면 드롭다운에서 편집본으로
 * 되돌아갈 방법이 없어진다(같은 값은 change 사건을 안 만든다).
 */
const PROJECT_PRESET_VALUE = "\u0000project";

type DialogState = { mode: Extract<PresetDialogMode, "edit">; index: number } | { mode: Extract<PresetDialogMode, "saveAs"> };

/**
 * Top-of-shell preset toolbar: select a saved preset, apply it to the active
 * file (matches + engine-generated operations replace the current ops via
 * applyPresetResult), edit its fields, or save/save-as to appDataDir/presets.json.
 * Presets are loaded once on mount; a load/save/apply failure is never
 * absorbed — it's always reported via onError so it lands on the ErrorPanel.
 */
export function PresetBar({
  sessionId,
  path,
  hasManualEdits,
  onApplied,
  onSessionRefreshed,
  onError,
  onSelectedPresetChange,
  selectPresetRequest,
  selectedName,
  onSelectedNameChange,
  projectPreset,
  onProjectPresetChange,
}: PresetBarProps) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);
  const [applying, setApplying] = useState(false);
  const [saving, setSaving] = useState(false);

  // 마운트 한 번짜리 로드 effect가 "그 시점의" 선택을 읽기 위한 ref들 —
  // 의존성에 넣으면 로드 effect가 선택 변화마다 다시 돈다.
  const selectedNameRef = useRef(selectedName);
  const onSelectedNameChangeRef = useRef(onSelectedNameChange);
  useEffect(() => {
    selectedNameRef.current = selectedName;
    onSelectedNameChangeRef.current = onSelectedNameChange;
  });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await loadPresets();
        if (cancelled) return;
        setPresets(loaded);
        // 선택은 여기서 정하지 않는다(원본은 App, 위 prop 주석의 규칙). 채워도
        // 되는 경우는 둘뿐이다 — 아직 아무 선택도 없는 첫 실행과, 남아 있던
        // 선택 이름이 목록에서 사라진 경우(지웠거나 이름을 바꿈).
        const current = selectedNameRef.current;
        if (loaded.length > 0 && (current === null || !loaded.some((p) => p.name === current))) {
          onSelectedNameChangeRef.current(loaded[0].name);
        }
      } catch (e) {
        if (cancelled) return;
        onError("프리셋 목록 불러오기 실패", toEngineError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // Loaded once on mount; onError identity is stable (useCallback in appStore).
  }, []);

  // 목록을 ref로도 든다. 아래 요청 처리 effect가 목록을 **읽기만** 하고 그것에
  // 반응하지는 않아야 하기 때문이다 — 의존성에 넣으면 프리셋을 편집·저장해 배열이
  // 새로 만들어질 때마다 effect가 다시 돌아 아티스트가 방금 고른 선택을 되돌린다.
  const presetsRef = useRef(presets);
  useEffect(() => {
    presetsRef.current = presets;
  }, [presets]);

  // 요청 하나당 한 번만. StrictMode의 정리-재설치로 같은 effect가 두 번 돌아도
  // (그 사이 사람이 선택을 바꿨을 수 있다) 두 번째는 그냥 지나간다.
  const appliedRequestRef = useRef<{ name: string; preset: Preset } | null>(null);
  useEffect(() => {
    if (!selectPresetRequest) return;
    if (appliedRequestRef.current === selectPresetRequest) return;
    appliedRequestRef.current = selectPresetRequest;
    // 프로젝트가 담고 있는 객체를 그대로 세운다. 목록에 그 이름이 있든 없든
    // 상관없다 — 지웠거나 이름을 바꿨어도 저장 시점 설정으로 열 수 있어야 한다.
    onProjectPresetChange(selectPresetRequest.preset);
    // 목록에 같은 이름이 있으면 그쪽 선택도 맞춰둔다. 아티스트가 프로젝트 항목을
    // 버리고 목록으로 돌아갈 때 무엇이 골라질지가 이 값이다.
    if (presetsRef.current.some((p) => p.name === selectPresetRequest.preset.name)) {
      onSelectedNameChange(selectPresetRequest.preset.name);
    }
  }, [selectPresetRequest, onProjectPresetChange, onSelectedNameChange]);

  const selectedIndex = presets.findIndex((p) => p.name === selectedName);
  const listPreset = selectedIndex === -1 ? undefined : presets[selectedIndex];
  // 프로젝트에서 올라온 것이 있으면 그것이 이긴다(selectPresetRequest 주석 참고).
  const selectedPreset = projectPreset ?? listPreset;

  // Reports the currently-selected preset up to App so ExportDialog can
  // initialize naming/outputSuffix/embedPreview from it (single-file export
  // must match the same preset's batch-export defaults; see FIX 3).
  useEffect(() => {
    onSelectedPresetChange(selectedPreset);
  }, [selectedPreset, onSelectedPresetChange]);

  async function persistList(list: Preset[]) {
    setSaving(true);
    try {
      await savePresets(list);
    } catch (e) {
      onError("프리셋 저장 실패", toEngineError(e));
    } finally {
      setSaving(false);
    }
  }

  async function doApply() {
    if (!sessionId || !path || !selectedPreset) return;
    setApplying(true);
    try {
      const result = await withEvictedSessionRetry(
        path,
        sessionId,
        (sid) => applyPreset(sid, selectedPreset),
        (r) => onSessionRefreshed(path, r)
      );
      onApplied(result.matchedLayerIds, result.operations);
    } catch (e) {
      onError("프리셋 적용 실패", toEngineError(e));
    } finally {
      setApplying(false);
      setConfirmApply(false);
    }
  }

  function handleApplyClick() {
    if (!sessionId || !path || !selectedPreset || applying) return;
    if (hasManualEdits) {
      setConfirmApply(true);
      return;
    }
    void doApply();
  }

  function handleEditClick() {
    // 프로젝트에서 올라온 판을 보고 있는 동안에는 편집을 막는다. 여기서 목록의
    // 같은 이름 항목을 열면, 화면이 보여주는 설정과 다른 것을 고치게 된다.
    // 고치려면 드롭다운에서 목록의 그 프리셋을 먼저 고른다.
    if (projectPreset || selectedIndex === -1) return;
    setDialog({ mode: "edit", index: selectedIndex });
  }

  function handleSaveAsClick() {
    if (!selectedPreset) return;
    setDialog({ mode: "saveAs" });
  }

  function handleSaveClick() {
    if (presets.length === 0 || saving) return;
    void persistList(presets);
  }

  function handleDialogSave(edited: Preset) {
    if (!dialog) return;
    let newList: Preset[];
    if (dialog.mode === "edit") {
      newList = presets.map((p, i) => (i === dialog.index ? edited : p));
    } else {
      const existingIdx = presets.findIndex((p) => p.name === edited.name);
      newList = existingIdx === -1 ? [...presets, edited] : presets.map((p, i) => (i === existingIdx ? edited : p));
    }
    setDialog(null);
    setPresets(newList);
    onSelectedNameChange(edited.name);
    void persistList(newList);
  }

  const dialogBasis: Preset | undefined =
    dialog?.mode === "edit" ? presets[dialog.index] : dialog?.mode === "saveAs" ? selectedPreset : undefined;

  // "edit" excludes the entry being edited itself (a no-op rename must not
  // collide with itself); "saveAs" is always a brand-new entry, so every
  // current name — including the source preset's own — counts as "existing".
  const dialogExistingNames: string[] =
    dialog?.mode === "edit"
      ? presets.filter((_, i) => i !== dialog.index).map((p) => p.name)
      : presets.map((p) => p.name);

  return (
    <div className="preset-bar">
      <label className="preset-bar-select-label">
        <span>프리셋</span>
        <select
          value={projectPreset ? PROJECT_PRESET_VALUE : selectedName ?? ""}
          onChange={(e) => {
            const value = e.currentTarget.value;
            if (value === PROJECT_PRESET_VALUE) return;
            // 목록의 것을 고르는 순간 프로젝트에서 온 판은 내려놓는다.
            onProjectPresetChange(null);
            onSelectedNameChange(value);
          }}
          disabled={presets.length === 0 && !projectPreset}
        >
          {presets.length === 0 && !projectPreset && <option value="">불러오는 중...</option>}
          {/* 이름 뒤에 (프로젝트)를 붙여 목록의 같은 이름과 구분한다. 둘이 같아
              보이면 아티스트는 자기가 방금 고친 설정이 안 먹는다고 읽게 된다. */}
          {projectPreset && (
            <option value={PROJECT_PRESET_VALUE}>{projectPreset.name} (프로젝트)</option>
          )}
          {presets.map((p) => (
            <option key={p.name} value={p.name}>
              {p.name}
            </option>
          ))}
        </select>
      </label>

      <button type="button" onClick={handleApplyClick} disabled={!sessionId || !selectedPreset || applying}>
        {applying ? "적용 중..." : "적용"}
      </button>
      <button
        type="button"
        onClick={handleEditClick}
        disabled={!selectedPreset || projectPreset !== null}
        title={projectPreset ? "프로젝트가 담고 있는 설정입니다. 고치려면 목록의 프리셋을 고르세요." : undefined}
      >
        편집...
      </button>
      <button type="button" onClick={handleSaveClick} disabled={presets.length === 0 || saving}>
        {saving ? "저장 중..." : "저장"}
      </button>
      <button type="button" onClick={handleSaveAsClick} disabled={!selectedPreset}>
        다른 이름으로 저장...
      </button>

      {confirmApply && (
        <div className="modal-overlay" onClick={() => setConfirmApply(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>포함 목록을 프리셋 결과로 대체합니다</h3>
            <p>
              지금 체크된 레이어 목록이 프리셋의 매칭 결과로 대체됩니다. 손으로 한 병합·이름변경은 그대로 유지됩니다. 계속하시겠습니까?
            </p>
            <div className="modal-actions">
              <button type="button" onClick={() => setConfirmApply(false)}>
                취소
              </button>
              <button type="button" onClick={() => void doApply()} disabled={applying}>
                {applying ? "적용 중..." : "적용"}
              </button>
            </div>
          </div>
        </div>
      )}

      {dialog && dialogBasis && (
        <PresetDialog
          mode={dialog.mode}
          preset={dialogBasis}
          existingNames={dialogExistingNames}
          onSave={handleDialogSave}
          onCancel={() => setDialog(null)}
        />
      )}
    </div>
  );
}
