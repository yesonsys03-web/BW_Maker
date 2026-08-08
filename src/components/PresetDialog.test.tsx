// @vitest-environment jsdom
/**
 * 검출 선택이 실제로 저장까지 이어지는지 잠근다.
 *
 * 두 검출을 비교하라고 남긴 옵션이라 아티스트가 앱에서 고를 수 있어야 의미가 있다.
 * 상태만 있고 저장 객체에서 빠지면 화면은 바뀐 것처럼 보이는데 프리셋에는 안 들어가
 * 비교가 조용히 무의미해진다 — colourMode가 지금 이 테스트 없이 돌고 있다.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { PresetDialog } from "./PresetDialog";
import { DEFAULT_EDGE_LINES, DEFAULT_PRESET } from "../lib/presets";

afterEach(cleanup);

/** 검출 셀렉트. 라벨이 힌트 문단까지 감싸고 있어 getByLabelText로는 안 잡힌다. */
function edgeModeSelect(): HTMLSelectElement {
  const found = screen
    .getAllByRole("combobox")
    .find((el) => el.querySelector('option[value="region"]') !== null);
  if (!found) throw new Error("검출 선택 셀렉트를 못 찾았다");
  return found as HTMLSelectElement;
}

function renderDialog(enabled: boolean, onSave = vi.fn()) {
  render(
    <PresetDialog
      mode="edit"
      preset={{
        ...DEFAULT_PRESET,
        edgeLines: { ...DEFAULT_EDGE_LINES, enabled },
      }}
      existingNames={[]}
      onSave={onSave}
      onCancel={() => {}}
    />,
  );
  return onSave;
}

test("the edge-mode choice reaches the saved preset", () => {
  const onSave = renderDialog(true);
  fireEvent.change(edgeModeSelect(), { target: { value: "change" } });
  fireEvent.click(screen.getByRole("button", { name: "저장" }));
  expect(onSave).toHaveBeenCalledTimes(1);
  expect(onSave.mock.calls[0][0].edgeLines.edgeMode).toBe("change");
});

test("the preset's own edge mode is what the control starts on", () => {
  renderDialog(true);
  expect(edgeModeSelect().value).toBe(DEFAULT_EDGE_LINES.edgeMode);
});

test("the edge-mode control is not offered when edge lines are off", () => {
  renderDialog(false);
  expect(
    screen
      .queryAllByRole("combobox")
      .some((el) => el.querySelector('option[value="region"]') !== null),
  ).toBe(false);
});
