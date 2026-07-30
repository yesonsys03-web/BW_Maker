import { useState } from "react";
import type { Preset } from "../lib/types";

export type PresetDialogMode = "edit" | "saveAs";

interface PresetDialogProps {
  mode: PresetDialogMode;
  preset: Preset;
  onSave: (preset: Preset) => void;
  onCancel: () => void;
}

const INCLUDE_TYPES: Preset["include"]["type"][] = ["contains", "regex"];
const MERGE_MODES: Preset["merge"][] = ["none", "all", "perGroup"];
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
export function PresetDialog({ mode, preset, onSave, onCancel }: PresetDialogProps) {
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
  const [naming, setNaming] = useState<Preset["naming"]>(preset.naming);
  const [outputSuffix, setOutputSuffix] = useState(preset.outputSuffix);
  const [embedPreview, setEmbedPreview] = useState(preset.embedPreview);

  const [nameError, setNameError] = useState<string | null>(null);
  const [valueError, setValueError] = useState<string | null>(null);

  function validate(): Preset | null {
    let ok = true;

    if (name.trim().length === 0) {
      setNameError("이름을 입력하세요.");
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
      matchGroups,
      includeHidden,
      merge,
      naming,
      outputSuffix,
      embedPreview,
    };
  }

  function handleSubmit() {
    const validated = validate();
    if (!validated) return;
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
                  {m === "none" ? "병합 없음" : m === "all" ? "전체 병합" : "그룹별 병합"}
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

        <div className="modal-actions">
          <button type="button" onClick={onCancel}>
            취소
          </button>
          <button type="button" onClick={handleSubmit}>
            저장
          </button>
        </div>
      </div>
    </div>
  );
}
