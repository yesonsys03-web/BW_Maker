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
   * "지금 이 프리셋을 고르라"는 요청. 프로젝트를 열 때 그 프로젝트가 담고 있던
   * 프리셋으로 맞추기 위한 것이다 — 안 맞추면 복원해둔 미리보기의 캐시 키가
   * 지금 선택과 달라져 화면이 전부 다시 그린다(설계 5·7절).
   *
   * **초기값 prop이 아니라 사건이다.** 목록은 마운트 때 한 번 읽혀 loaded[0]을
   * 고르는데 프로젝트는 그보다 한참 뒤에 열리므로, 초기값으로 내려보내면 아무
   * 효과가 없다. 그래서 열 때마다 **새 객체**로 오고, 이 컴포넌트는 그 객체
   * 하나당 딱 한 번만 선택을 바꾼다.
   *
   * 한 번만 반응하는 것이 핵심이다. 이름을 값으로 보고 목록과 함께 다시 맞추면,
   * 그 뒤 아티스트가 다른 프리셋을 골라도 프리셋을 편집·저장해 목록 배열이 새로
   * 만들어지는 순간 프로젝트의 것으로 되돌아간다.
   */
  selectPresetRequest: { name: string } | null;
}

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
}: PresetBarProps) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [confirmApply, setConfirmApply] = useState(false);
  const [applying, setApplying] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await loadPresets();
        if (cancelled) return;
        setPresets(loaded);
        setSelectedName(loaded[0]?.name ?? null);
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
  const appliedRequestRef = useRef<{ name: string } | null>(null);
  useEffect(() => {
    if (!selectPresetRequest) return;
    if (appliedRequestRef.current === selectPresetRequest) return;
    appliedRequestRef.current = selectPresetRequest;
    // 목록에 그 이름이 없으면(지웠거나 이름이 바뀐 경우) 지금 선택을 유지한다.
    // 그때는 캐시 키가 안 맞아 복원한 미리보기가 버려지는데, 저장 시점과 다른
    // 설정의 그림을 붙이는 것보다 그편이 맞다(설계 5절).
    if (!presetsRef.current.some((p) => p.name === selectPresetRequest.name)) return;
    setSelectedName(selectPresetRequest.name);
  }, [selectPresetRequest]);

  const selectedIndex = presets.findIndex((p) => p.name === selectedName);
  const selectedPreset = selectedIndex === -1 ? undefined : presets[selectedIndex];

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
    if (selectedIndex === -1) return;
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
    setSelectedName(edited.name);
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
          value={selectedName ?? ""}
          onChange={(e) => setSelectedName(e.currentTarget.value)}
          disabled={presets.length === 0}
        >
          {presets.length === 0 && <option value="">불러오는 중...</option>}
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
      <button type="button" onClick={handleEditClick} disabled={!selectedPreset}>
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
            <h3>기존 편집 내용을 대체합니다</h3>
            <p>
              현재 레이어 편집(병합/이름변경 등) 내역이 모두 사라지고, 프리셋의 매칭 결과로 대체됩니다. 계속하시겠습니까?
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
