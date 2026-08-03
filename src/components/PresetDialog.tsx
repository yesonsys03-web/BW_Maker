import { useState } from "react";
import { DEFAULT_EXCLUDE_TOKENS, DEFAULT_LINE_COLOR, DEFAULT_ROLE_TOKENS } from "../lib/presets";
import type { Preset } from "../lib/types";

export type PresetDialogMode = "edit" | "saveAs";

interface PresetDialogProps {
  mode: PresetDialogMode;
  preset: Preset;
  /**
   * Names of OTHER presets already on disk — excludes the preset being
   * edited itself in "edit" mode. Used to prevent silently writing two
   * presets with the same name (findIndex-by-name elsewhere would then only
   * ever resolve the first one, corrupting selection and persistence).
   */
  existingNames: string[];
  onSave: (preset: Preset) => void;
  onCancel: () => void;
}

const INCLUDE_TYPES: Preset["include"]["type"][] = ["contains", "regex"];
const MERGE_MODES: Preset["merge"][] = ["none", "all", "perGroup", "byElement"];

const MERGE_LABELS: Record<Preset["merge"], string> = {
  none: "병합 없음",
  all: "전체 병합",
  perGroup: "그룹별 병합",
  byElement: "요소별 병합 (BG + 요소)",
};
const NAMING_MODES: Preset["naming"][] = ["pathPrefix", "original"];

function parseGroupPrefixes(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Full-field editor for the Preset schema (spec section 5). Used both for
 * "편집..." (edit the selected preset in place) and "다른 이름으로 저장..."
 * (duplicate as a new named preset) — `mode` only changes labels/copy, the
 * validated Preset shape returned via onSave is identical either way.
 */
export function PresetDialog({ mode, preset, existingNames, onSave, onCancel }: PresetDialogProps) {
  const [name, setName] = useState(preset.name);
  const [includeType, setIncludeType] = useState<Preset["include"]["type"]>(preset.include.type);
  const [includeValue, setIncludeValue] = useState(preset.include.value);
  const [caseSensitive, setCaseSensitive] = useState(preset.include.caseSensitive);
  const [excludeGroupPrefixesText, setExcludeGroupPrefixesText] = useState(
    preset.excludeGroupPrefixes.join(", ")
  );
  const [matchGroups, setMatchGroups] = useState(preset.matchGroups);
  const [includeHidden, setIncludeHidden] = useState(preset.includeHidden);
  const [merge, setMerge] = useState<Preset["merge"]>(preset.merge);
  const [mergeRule, setMergeRule] = useState<Preset["mergeRule"]>(preset.mergeRule ?? "role");
  const [roleTokensText, setRoleTokensText] = useState(
    (preset.roleTokens ?? DEFAULT_ROLE_TOKENS).join(", ")
  );
  const [excludeTokensText, setExcludeTokensText] = useState(
    (preset.excludeTokens ?? DEFAULT_EXCLUDE_TOKENS).join(", ")
  );
  const [naming, setNaming] = useState<Preset["naming"]>(preset.naming);
  const [outputSuffix, setOutputSuffix] = useState(preset.outputSuffix);
  const [embedPreview, setEmbedPreview] = useState(preset.embedPreview);
  const [splitLayers, setSplitLayers] = useState(preset.splitLayers ?? false);
  // 색 통일은 "켜짐 여부"와 "어떤 색"을 따로 들고 있어야, 껐다 켜도 고르던 색이
  // 그대로 남는다. 저장 시점에만 lineColor(문자열 | null)로 합친다.
  const [normalizeColor, setNormalizeColor] = useState(preset.lineColor !== null);
  const [lineColor, setLineColor] = useState(preset.lineColor ?? DEFAULT_LINE_COLOR);

  const [nameError, setNameError] = useState<string | null>(null);
  const [valueError, setValueError] = useState<string | null>(null);
  const [pendingSave, setPendingSave] = useState<Preset | null>(null);

  function validate(): Preset | null {
    let ok = true;

    const trimmedName = name.trim();
    if (trimmedName.length === 0) {
      setNameError("이름을 입력하세요.");
      ok = false;
    } else if (mode === "edit" && existingNames.includes(trimmedName)) {
      // Edit mode is a hard block: renaming to collide with another saved
      // preset would make findIndex-by-name resolve the wrong entry.
      setNameError("같은 이름의 프리셋이 이미 있습니다.");
      ok = false;
    } else {
      setNameError(null);
    }

    if (includeValue.trim().length === 0) {
      setValueError("값을 입력하세요.");
      ok = false;
    } else if (includeType === "regex") {
      try {
        new RegExp(includeValue);
        setValueError(null);
      } catch (e) {
        setValueError(`잘못된 정규식입니다: ${e instanceof Error ? e.message : String(e)}`);
        ok = false;
      }
    } else {
      setValueError(null);
    }

    if (!ok) return null;

    return {
      name: name.trim(),
      include: { type: includeType, value: includeValue, caseSensitive },
      excludeGroupPrefixes: parseGroupPrefixes(excludeGroupPrefixesText),
      excludeTokens: parseGroupPrefixes(excludeTokensText),
      matchGroups,
      includeHidden,
      merge,
      roleTokens: parseGroupPrefixes(roleTokensText),
      mergeRule,
      naming,
      outputSuffix,
      embedPreview,
      lineColor: normalizeColor ? lineColor : null,
      splitLayers,
    };
  }

  function handleSubmit() {
    const validated = validate();
    if (!validated) return;
    // "edit" mode already hard-blocked a colliding name above (validate()
    // sets nameError and returns null). "saveAs" mode is intentionally
    // allowed to collide — that's how the user explicitly overwrites an
    // existing preset by name — but it must be an explicit confirmation,
    // never a silent overwrite.
    if (mode === "saveAs" && existingNames.includes(validated.name)) {
      setPendingSave(validated);
      return;
    }
    onSave(validated);
  }

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-card preset-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>{mode === "edit" ? "프리셋 편집" : "다른 이름으로 저장"}</h3>

        <label className="preset-field">
          <span>이름</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            placeholder="프리셋 이름"
          />
          {nameError && <span className="preset-field-error">{nameError}</span>}
        </label>

        <div className="preset-field-row">
          <label className="preset-field">
            <span>포함 규칙 종류</span>
            <select
              value={includeType}
              onChange={(e) => setIncludeType(e.currentTarget.value as Preset["include"]["type"])}
            >
              {INCLUDE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t === "contains" ? "포함(contains)" : "정규식(regex)"}
                </option>
              ))}
            </select>
          </label>

          <label className="preset-field preset-field-grow">
            <span>값</span>
            <input
              type="text"
              value={includeValue}
              onChange={(e) => setIncludeValue(e.currentTarget.value)}
              placeholder={includeType === "regex" ? "정규식 패턴" : "부분 문자열"}
            />
            {valueError && <span className="preset-field-error">{valueError}</span>}
          </label>
        </div>

        <label className="preset-checkbox">
          <input
            type="checkbox"
            checked={caseSensitive}
            onChange={(e) => setCaseSensitive(e.currentTarget.checked)}
          />
          <span>대소문자 구분</span>
        </label>

        <label className="preset-field">
          <span>제외할 그룹 접두사 (쉼표로 구분)</span>
          <input
            type="text"
            value={excludeGroupPrefixesText}
            onChange={(e) => setExcludeGroupPrefixesText(e.currentTarget.value)}
            placeholder="예: -, #"
          />
        </label>

        <label className="preset-field">
          <span>제외 토큰 (쉼표로 구분)</span>
          <input
            type="text"
            value={excludeTokensText}
            onChange={(e) => setExcludeTokensText(e.currentTarget.value)}
            placeholder="예: col, colour, color"
          />
        </label>

        <label className="preset-checkbox">
          <input type="checkbox" checked={matchGroups} onChange={(e) => setMatchGroups(e.currentTarget.checked)} />
          <span>그룹 이름도 매칭 대상에 포함</span>
        </label>

        <label className="preset-checkbox">
          <input
            type="checkbox"
            checked={includeHidden}
            onChange={(e) => setIncludeHidden(e.currentTarget.checked)}
          />
          <span>숨김 레이어도 포함</span>
        </label>

        <div className="preset-field-row">
          <label className="preset-field">
            <span>병합 방식</span>
            <select value={merge} onChange={(e) => setMerge(e.currentTarget.value as Preset["merge"])}>
              {MERGE_MODES.map((m) => (
                <option key={m} value={m}>
                  {MERGE_LABELS[m]}
                </option>
              ))}
            </select>
          </label>

          <label className="preset-field">
            <span>파일명 규칙</span>
            <select value={naming} onChange={(e) => setNaming(e.currentTarget.value as Preset["naming"])}>
              {NAMING_MODES.map((n) => (
                <option key={n} value={n}>
                  {n === "pathPrefix" ? "경로 접두사" : "원본 이름"}
                </option>
              ))}
            </select>
          </label>
        </div>

        {merge === "byElement" && (
          <label className="preset-field">
            <span>병합 기준</span>
            <select
              value={mergeRule}
              onChange={(e) => setMergeRule(e.currentTarget.value as Preset["mergeRule"])}
            >
              <option value="role">역할 접미사 (UL/OL)</option>
              <option value="group">그룹 단위 (최상위 바로 아래)</option>
              <option value="plane">깊이 평면 (BG/MG/FG)</option>
            </select>
          </label>
        )}
        {merge === "byElement" && mergeRule === "role" && (
          <label className="preset-field">
            <span>역할 접미사 (쉼표로 구분)</span>
            <input
              type="text"
              value={roleTokensText}
              onChange={(e) => setRoleTokensText(e.currentTarget.value)}
              placeholder="UL, OL_UL, OL"
            />
            <span className="preset-hint">
              요소 이름에서 이 접미사를 떼어내 같은 요소를 알아냅니다 —
              <code>CHAIR1_UL</code>과 <code>CHAIR1_OL</code>이 <code>CHAIR1</code> 한 장이 됩니다.
              어디에도 걸리지 않은 레이어는 <code>BG</code>로 묶여 맨 아래에 깔립니다.
            </span>
          </label>
        )}

        <label className="preset-field">
          <span>출력 파일명 접미사</span>
          <input
            type="text"
            value={outputSuffix}
            onChange={(e) => setOutputSuffix(e.currentTarget.value)}
            placeholder="예: _LINE"
          />
        </label>

        <label className="preset-checkbox">
          <input
            type="checkbox"
            checked={embedPreview}
            onChange={(e) => setEmbedPreview(e.currentTarget.checked)}
          />
          <span>미리보기 이미지 포함하여 내보내기</span>
        </label>

        <label className="preset-checkbox">
          <input
            type="checkbox"
            checked={splitLayers}
            onChange={(e) => setSplitLayers(e.currentTarget.checked)}
          />
          <span>레이어마다 파일 따로 내보내기</span>
        </label>
        <p className="preset-hint">
          한 파일에 레이어를 모두 담는 대신, 레이어 하나당 PSD 하나를 씁니다
          (<code>..._LINE_BG.psd</code>, <code>..._LINE_CHAIR1.psd</code> …).
          캔버스 크기는 매 파일 원본 그대로라 다시 합칠 때 좌표가 맞습니다.
        </p>

        <label className="preset-checkbox">
          <input
            type="checkbox"
            checked={normalizeColor}
            onChange={(e) => setNormalizeColor(e.currentTarget.checked)}
          />
          <span>라인 색 통일</span>
          <input
            type="color"
            className="preset-color"
            value={lineColor}
            disabled={!normalizeColor}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setLineColor(e.currentTarget.value)}
            aria-label="통일할 라인 색"
          />
          <code className="preset-color-value">{normalizeColor ? lineColor.toUpperCase() : "원본 유지"}</code>
        </label>
        <p className="preset-hint">
          내보낼 때 모든 라인 레이어의 색을 한 색으로 덮습니다. 알파는 그대로 두므로 선 가장자리의
          안티에일리어싱은 보존됩니다. 꺼두면 원본 레이어 색을 그대로 씁니다.
        </p>

        <div className="modal-actions">
          <button type="button" onClick={onCancel}>
            취소
          </button>
          <button type="button" onClick={handleSubmit}>
            저장
          </button>
        </div>
      </div>

      {pendingSave && (
        <div
          className="modal-overlay"
          onClick={(e) => {
            // Nested inside the outer dialog's own overlay — without this,
            // a backdrop click here would bubble up and also fire the outer
            // overlay's onCancel, silently discarding the whole edit form.
            e.stopPropagation();
            setPendingSave(null);
          }}
        >
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>이미 존재하는 이름입니다</h3>
            <p>"{pendingSave.name}" 프리셋이 이미 있습니다. 기존 프리셋을 덮어쓰시겠습니까?</p>
            <div className="modal-actions">
              <button type="button" onClick={() => setPendingSave(null)}>
                취소
              </button>
              <button type="button" onClick={() => onSave(pendingSave)}>
                덮어쓰기
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
