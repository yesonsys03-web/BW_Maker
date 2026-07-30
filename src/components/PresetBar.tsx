import { useEffect, useState } from "react";
import { applyPreset } from "../lib/engine";
import { toEngineError } from "../lib/preview";
import { loadPresets, savePresets } from "../lib/presets";
import type { EngineError, Operation, Preset } from "../lib/types";
import { PresetDialog, type PresetDialogMode } from "./PresetDialog";

interface PresetBarProps {
  sessionId: number | undefined;
  hasPendingOps: boolean;
  onApplied: (matchedLayerIds: number[], operations: Operation[]) => void;
  onError: (title: string, error: EngineError) => void;
}

type DialogState = { mode: Extract<PresetDialogMode, "edit">; index: number } | { mode: Extract<PresetDialogMode, "saveAs"> };

/**
 * Top-of-shell preset toolbar: select a saved preset, apply it to the active
 * file (matches + engine-generated operations replace the current ops via
 * applyPresetResult), edit its fields, or save/save-as to appDataDir/presets.json.
 * Presets are loaded once on mount; a load/save/apply failure is never
 * absorbed — it's always reported via onError so it lands on the ErrorPanel.
 */
export function PresetBar({ sessionId, hasPendingOps, onApplied, onError }: PresetBarProps) {
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

  const selectedIndex = presets.findIndex((p) => p.name === selectedName);
  const selectedPreset = selectedIndex === -1 ? undefined : presets[selectedIndex];

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
    if (!sessionId || !selectedPreset) return;
    setApplying(true);
    try {
      const result = await applyPreset(sessionId, selectedPreset);
      onApplied(result.matchedLayerIds, result.operations);
    } catch (e) {
      onError("프리셋 적용 실패", toEngineError(e));
    } finally {
      setApplying(false);
      setConfirmApply(false);
    }
  }

  function handleApplyClick() {
    if (!sessionId || !selectedPreset || applying) return;
    if (hasPendingOps) {
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
