// @vitest-environment jsdom
/**
 * 프로젝트를 열면 그 프로젝트가 담고 있던 프리셋이 선택돼야 한다.
 *
 * 왜: primeRestoredPreviews가 복원한 미리보기를 캐시에 넣어도, 앱의 선택 프리셋이
 * 다르면 화면이 계산하는 캐시 키가 달라져 전부 다시 그린다. 그러면 "껐다 켜고
 * 프로젝트를 연다"는 이 기능의 주 경로에서 이득이 0이 된다(설계 5·7절).
 *
 * "초기 선택 prop"으로는 안 된다. 이 컴포넌트는 **마운트 때 한 번** 목록을 읽어
 * loaded[0]을 고르는데 프로젝트는 그보다 한참 뒤에 열린다. 그래서 요청은 값이
 * 아니라 사건이고, 아래 두 번째·세 번째 테스트가 그 사건이 **한 번만** 먹히는지를
 * 잠근다 — 값으로 다뤄 목록과 함께 다시 맞추면, 아티스트가 그 뒤에 고른 선택이
 * 프리셋을 편집·저장하는 순간(목록 배열이 새로 만들어진다) 조용히 되돌아간다.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../lib/presets", async (orig) => ({
  ...(await orig<typeof import("../lib/presets")>()),
  loadPresets: vi.fn(),
  savePresets: vi.fn(async () => {}),
}));

import { PresetBar } from "./PresetBar";
import { loadPresets, savePresets } from "../lib/presets";
import type { Preset } from "../lib/types";

afterEach(cleanup);

function presetNamed(name: string): Preset {
  return {
    name,
    include: { type: "contains", value: "line", caseSensitive: false },
    excludeGroupPrefixes: [],
    matchGroups: true,
    includeHidden: true,
    merge: "none",
    roleTokens: [],
    mergeRule: "group",
    naming: "original",
    outputSuffix: "_LINE",
    embedPreview: true,
    lineColor: null,
    splitLayers: false,
    outputFormat: "psd",
    excludeTokens: [],
    edgeLines: {
      enabled: false, threshold: 24, gap: 4, width: 5, minLength: 8, lineAlpha: 64,
      colourMode: "composite", edgeMode: "region",
    },
  } as Preset;
}

/**
 * 프로젝트가 담고 있던 "B 프리셋". 목록에 있는 같은 이름과 **설정이 다르다** —
 * 저장한 뒤 아티스트가 라인색을 끈 경우가 정확히 이 모양이고, 이 차이가 미리보기
 * 캐시 키를 통째로 가른다. 이름만 맞추는 구현은 이 값을 못 지킨다.
 */
const PROJECT_B: Preset = { ...presetNamed("B 프리셋"), lineColor: "#000000" };
const PROJECT_GONE: Preset = { ...presetNamed("지워진 프리셋"), lineColor: "#123456" };

/** 프로젝트를 여는 쪽(App)이 하는 일만 흉내내는 껍데기. 요청을 밖에서 던진다. */
function Harness({ onSelected }: { onSelected: (p: Preset | undefined) => void }) {
  const [request, setRequest] = useState<{ name: string; preset: Preset } | null>(null);
  return (
    <>
      <button type="button" onClick={() => setRequest({ name: PROJECT_B.name, preset: PROJECT_B })}>
        프로젝트 열기
      </button>
      <button type="button" onClick={() => setRequest({ name: PROJECT_GONE.name, preset: PROJECT_GONE })}>
        사라진 프리셋으로 열기
      </button>
      <PresetBar
        sessionId={1}
        path="/cuts/a.psd"
        hasManualEdits={false}
        onApplied={vi.fn()}
        onSessionRefreshed={vi.fn()}
        onError={vi.fn()}
        onSelectedPresetChange={onSelected}
        selectPresetRequest={request}
      />
    </>
  );
}

function click(name: string) {
  const buttons = screen.getAllByRole("button", { name });
  // 대화상자가 떠 있으면 같은 이름의 버튼이 둘이다 — 나중에 그려진 쪽이 대화상자다.
  buttons[buttons.length - 1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

function selectEl() {
  return screen.getByRole("combobox") as HTMLSelectElement;
}

test("opening a project uses that project's own preset, not the list's same-named one", async () => {
  vi.mocked(loadPresets).mockResolvedValue([presetNamed("A 프리셋"), presetNamed("B 프리셋")]);
  const onSelected = vi.fn();
  render(<Harness onSelected={onSelected} />);

  // 마운트 때는 목록의 첫 번째다.
  await waitFor(() => expect(selectEl().value).toBe("A 프리셋"));

  click("프로젝트 열기");
  // **이름이 아니라 값으로 잠근다.** 이름만 맞추는 구현도 "B 프리셋"까지는
  // 통과하지만, 그 경우 올라오는 것은 lineColor가 null인 목록의 편집본이라
  // 복원한 미리보기 키가 전부 어긋난다.
  await waitFor(() =>
    expect(onSelected).toHaveBeenLastCalledWith(expect.objectContaining({ name: "B 프리셋", lineColor: "#000000" }))
  );
  // 목록의 같은 이름과 구분되게 보여야 한다.
  expect(selectEl().selectedOptions[0].textContent).toBe("B 프리셋 (프로젝트)");
});

test("a project preset that is no longer in the list still opens with the saved settings", async () => {
  vi.mocked(loadPresets).mockResolvedValue([presetNamed("A 프리셋"), presetNamed("B 프리셋")]);
  const onSelected = vi.fn();
  render(<Harness onSelected={onSelected} />);
  await waitFor(() => expect(selectEl().value).toBe("A 프리셋"));

  // 프리셋을 지웠거나 이름을 바꾼 경우. 프로젝트가 설정을 통째로 들고 있으므로
  // 목록에 없어도 저장한 모습 그대로 열 수 있다 — 예전에는 여기서 지금 선택을
  // 유지했고, 그러면 복원한 미리보기가 한 장도 안 맞았다.
  click("사라진 프리셋으로 열기");
  await waitFor(() =>
    expect(onSelected).toHaveBeenLastCalledWith(expect.objectContaining({ name: "지워진 프리셋", lineColor: "#123456" }))
  );
  expect(selectEl().selectedOptions[0].textContent).toBe("지워진 프리셋 (프로젝트)");
});

test("picking the list's own preset drops the project's copy", async () => {
  vi.mocked(loadPresets).mockResolvedValue([presetNamed("A 프리셋"), presetNamed("B 프리셋")]);
  const onSelected = vi.fn();
  render(<Harness onSelected={onSelected} />);
  await waitFor(() => expect(selectEl().value).toBe("A 프리셋"));

  click("프로젝트 열기");
  await waitFor(() => expect(selectEl().selectedOptions[0].textContent).toBe("B 프리셋 (프로젝트)"));

  // 아티스트가 목록의 같은 이름을 고른다 — 자기가 방금 편집한 판으로 가겠다는 뜻.
  // 값이 달라야 고를 수 있다: 같은 값으로 두면 change 사건이 아예 안 난다.
  const el = selectEl();
  el.value = "B 프리셋";
  el.dispatchEvent(new Event("change", { bubbles: true }));

  await waitFor(() =>
    expect(onSelected).toHaveBeenLastCalledWith(expect.objectContaining({ name: "B 프리셋", lineColor: null }))
  );
  expect(selectEl().selectedOptions[0].textContent).toBe("B 프리셋");
});

test("the artist's own choice survives a preset edit that rebuilds the list", async () => {
  vi.mocked(loadPresets).mockResolvedValue([presetNamed("A 프리셋"), presetNamed("B 프리셋")]);
  render(<Harness onSelected={vi.fn()} />);
  await waitFor(() => expect(selectEl().value).toBe("A 프리셋"));

  click("프로젝트 열기");
  await waitFor(() => expect(selectEl().selectedOptions[0].textContent).toBe("B 프리셋 (프로젝트)"));

  // 아티스트가 다른 프리셋으로 바꾼다.
  const el = selectEl();
  el.value = "A 프리셋";
  el.dispatchEvent(new Event("change", { bubbles: true }));
  await waitFor(() => expect(selectEl().value).toBe("A 프리셋"));

  // 그 프리셋을 편집해 저장한다 — handleDialogSave가 presets 배열을 **새로**
  // 만든다. 요청을 값으로 보고 목록과 함께 다시 맞추는 구현이면 여기서 선택이
  // "B 프리셋"으로 되돌아간다.
  click("편집...");
  await waitFor(() => expect(screen.getByText("프리셋 편집")).toBeTruthy());
  click("저장");
  await waitFor(() => expect(vi.mocked(savePresets)).toHaveBeenCalled());

  await new Promise((r) => setTimeout(r, 20));
  expect(selectEl().value).toBe("A 프리셋");
});
