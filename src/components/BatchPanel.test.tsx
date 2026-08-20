// @vitest-environment jsdom
/**
 * 배치가 파일을 하나씩 도는 규약을 잠근다.
 *
 * 예전에는 목록 전체를 batchRun 한 번에 넘겼다. 엔진은 그 한 번의 요청이 끝날
 * 때까지 stdin을 읽지 않으므로 중지 요청이 파이프에 앉은 채로 남았고 — 취소가
 * 구조적으로 불가능했다. 실제로 107개 폴더를 돌리다 멈추지 못해 앱을 종료해야
 * 했다. 그 조율은 순수 함수로 뽑을 수 없어(무엇을 언제 부르는가가 곧 동작이다)
 * 실제로 패널을 띄우고 엔진만 가짜로 바꾼다.
 */
import { DRAWN_LINES_POLICY } from "../lib/detectDrawnLines";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const engine = vi.hoisted(() => ({
  batchRun: vi.fn(),
  onEngineEvent: vi.fn(),
  pathsExist: vi.fn(),
}));

vi.mock("../lib/engine", () => engine);
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const PRESET = {
  name: "line 추출",
  include: { type: "contains" as const, value: "line", caseSensitive: false },
  excludeGroupPrefixes: ["-"],
  matchGroups: true,
  includeHidden: true,
  merge: "byElement" as const,
  roleTokens: ["UL"],
  mergeRule: "group" as const,
  naming: "original" as const,
  outputSuffix: "_LINE",
  embedPreview: true,
  lineColor: null,
  splitLayers: true,
  excludeTokens: [],
  edgeLines: {
    enabled: false, threshold: 24, gap: 4, width: 5, minLength: 8, lineAlpha: 64,
    colourMode: "composite" as const, edgeMode: "region" as const, widthScale: 1,
  },
};

vi.mock("../lib/presets", async (orig) => ({
  ...(await orig<typeof import("../lib/presets")>()),
  loadPresets: vi.fn(async () => [PRESET]),
}));

import { BatchPanel } from "./BatchPanel";
import { loadPresets } from "../lib/presets";
import type { FileEntry } from "../state/appStore";

const FILES: FileEntry[] = ["/cuts/a.psd", "/cuts/b.psd", "/cuts/c.psd"].map((path) => ({
  path,
  status: "open" as const,
}));

/** 테스트가 원하는 시점에 풀어주는 약속. 파일 하나씩 몰기 위한 것. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

let runs: { paths: string[]; d: ReturnType<typeof deferred<{ results: unknown[] }>> }[] = [];
/** 배경 큐에 알린 실행 상태의 이력. 배치가 도는 동안 켜지고 끝나면 꺼져야 한다. */
let runningSignals: boolean[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  runs = [];
  runningSignals = [];
  engine.onEngineEvent.mockResolvedValue(() => {});
  engine.pathsExist.mockImplementation(async (paths: string[]) => paths.map(() => false));
  engine.batchRun.mockImplementation((paths: string[]) => {
    const d = deferred<{ results: unknown[] }>();
    runs.push({ paths, d });
    return d.promise;
  });
});

afterEach(cleanup);

/** 결과 표의 셀. 같은 이름이 위쪽 파일 선택 목록에도 있어 역할로 좁힌다. */
function resultCells() {
  return screen.queryAllByRole("cell").map((c) => c.textContent);
}

/** 상태 칸에는 버튼 글자가 붙으므로("실패 자세히") 부분 일치로 본다. */
function hasCell(text: string) {
  return resultCells().some((c) => c?.includes(text));
}

function click(name: string) {
  screen.getByRole("button", { name }).dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

/** 진행 중인 파일 하나를 성공으로 끝낸다. */
function finish(index: number) {
  runs[index].d.resolve({
    results: [{ path: runs[index].paths[0], ok: true, outputPath: "/out", layerCount: 3 }],
  });
}

async function startRun(manualLineIdsByPath: Record<string, number[]> = {}, rejectedLineIdsByPath: Record<string, number[]> = {}) {
  render(
    <BatchPanel
      files={FILES}
      defaultPresetName={null}
      manualLineIdsByPath={manualLineIdsByPath}
      rejectedLineIdsByPath={rejectedLineIdsByPath}
      workers={1}
      onError={vi.fn()}
      onRunningChange={(r) => runningSignals.push(r)}
    />
  );
  await waitFor(() => expect(screen.getByRole("button", { name: "배치 실행" })).toBeTruthy());
  click("배치 실행");
  await waitFor(() => expect(runs.length).toBeGreaterThan(0));
}

test("the batch asks the engine for one file at a time", async () => {
  await startRun();

  // 목록 전체를 한 번에 넘기면 엔진이 그동안 stdin을 안 읽어 중지가 닿지 못한다.
  expect(runs).toHaveLength(1);
  expect(runs[0].paths).toEqual(["/cuts/a.psd"]);

  finish(0);
  await waitFor(() => expect(runs).toHaveLength(2));
  expect(runs[1].paths).toEqual(["/cuts/b.psd"]);
});

// planBatchOutputs was already correct and unit-tested — the bug was that
// the caller here never passed the preset's outputFormat, so the pre-check
// always looked for .psd paths no matter what the preset would actually
// write. A PNG-format preset run twice into the same folder would then find
// zero conflicts on the second run (it's checking .psd, not .png), skip the
// overwrite dialog, and the engine would raise FileExistsError for every
// file — with no way in the UI to recover.
test("the pre-check inspects paths in the preset's output format, not always .psd", async () => {
  const pngPreset = { ...PRESET, outputFormat: "png" as const };
  vi.mocked(loadPresets).mockResolvedValueOnce([pngPreset]);

  await startRun();

  expect(engine.pathsExist).toHaveBeenCalledTimes(1);
  const checked = engine.pathsExist.mock.calls[0][0] as string[];
  expect(checked.length).toBeGreaterThan(0);
  expect(checked.every((p) => p.endsWith(".png"))).toBe(true);
});

test("stop takes effect at the next file, not in the middle of one", async () => {
  await startRun();

  click("중지");
  // 파일 하나는 한 번의 RPC라 중간에 끊을 수 없다. 누른 직후에는 그 사실을
  // 문구로 알리고, 실제로 멈추는 것은 진행 중이던 파일이 끝난 뒤다.
  await waitFor(() => expect(screen.getByRole("button", { name: "현재 파일 마치는 중..." })).toBeTruthy());
  expect(runs).toHaveLength(1);

  finish(0);

  await waitFor(() => expect(screen.getByText(/중지됨 — 남은 파일 2개/)).toBeTruthy());
  expect(runs).toHaveLength(1);
});

test("resume picks up the files that were left", async () => {
  await startRun();
  click("중지");
  finish(0);
  await waitFor(() => expect(screen.getByRole("button", { name: "재개" })).toBeTruthy());

  click("재개");

  await waitFor(() => expect(runs).toHaveLength(2));
  expect(runs[1].paths).toEqual(["/cuts/b.psd"]);
});

test("cancel drops what was left without touching what already ran", async () => {
  await startRun();
  click("중지");
  finish(0);
  await waitFor(() => expect(screen.getByRole("button", { name: "취소" })).toBeTruthy());

  click("취소");

  await waitFor(() => expect(screen.queryByText(/중지됨/)).toBeNull());
  expect(runs).toHaveLength(1);
  // 이미 끝난 파일의 결과는 표에 남는다 — 취소는 남은 목록을 버리는 것뿐이다.
  expect(resultCells()).toContain("a.psd");
});

test("results appear as each file lands, not only at the end", async () => {
  // 한 시간짜리 배치에서 끝까지 아무것도 안 보이면, 무엇이 실패했는지 알기까지
  // 그 한 시간을 기다리게 된다.
  await startRun();
  expect(resultCells()).not.toContain("a.psd");

  finish(0);

  await waitFor(() => expect(resultCells()).toContain("a.psd"));
  expect(resultCells()).not.toContain("b.psd");
});

test("the background queues are told to stand aside while a batch runs", async () => {
  // 배치는 이제 파일 사이마다 엔진을 비운다. 그 틈에 미리보기 준비가 끼어들면
  // 아티스트가 기다리는 배치가 그만큼 느려진다.
  await startRun();
  expect(runningSignals).toEqual([true]);

  // 다음 파일이 나가야 그것을 끝낼 수 있다 — 한 번에 하나씩이 이 큐의 전제다.
  for (let i = 0; i < FILES.length; i += 1) {
    await waitFor(() => expect(runs).toHaveLength(i + 1));
    finish(i);
  }

  await waitFor(() => expect(runningSignals).toEqual([true, false]));
});

// 오늘 실제로 겪은 것: 색 통일을 켠 배치가 파일마다 "실패"를 냈는데 `자세히`를
// 눌러도 아무것도 안 나왔다. 상세 칸이 error가 있을 때만 그려졌기 때문이고,
// 검증 불일치는 예외가 아니라 결과값이라 error가 없다.
test("a file that was written but did not verify says so, and says why", async () => {
  await startRun();
  runs[0].d.resolve({
    results: [{
      path: "/cuts/a.psd",
      ok: false,
      outputPath: "/out/a_LINE.psd",
      layerCount: 21,
      verification: {
        ok: false, canvasOk: true, layerCountOk: true, expectedLayers: 21, actualLayers: 21,
        layers: [
          { name: "RUG", nameOk: true, pixelChecked: true, pixelOk: false },
          { name: "BG", nameOk: true, pixelChecked: true, pixelOk: true },
        ],
      },
    }],
  });

  // 쓰기 실패가 아니다 — 파일은 디스크에 있다.
  await waitFor(() => expect(hasCell("확인 필요")).toBe(true));
  expect(hasCell("실패")).toBe(false);

  click("자세히");
  await waitFor(() => expect(screen.getByText(/픽셀이 원본과 다른 레이어 1개: RUG/)).toBeTruthy());
});

test("a file that could not be written is still a plain failure", async () => {
  await startRun();
  runs[0].d.resolve({
    results: [{ path: "/cuts/a.psd", ok: false, error: { message: "output already exists", traceback: "T" } }],
  });

  await waitFor(() => expect(hasCell("실패")).toBe(true));
  click("자세히");
  await waitFor(() => expect(screen.getByText("output already exists")).toBeTruthy());
});

/**
 * 손으로 "라인으로 지정"한 것이 배치까지 가야 한다.
 *
 * 배치는 프리셋만 갖고 파일마다 처음부터 다시 매칭하므로, 이름 규칙이 닿지 않는
 * 판(선화가 `TEMPLATE` 안의 `BORDER`인 판)은 아티스트가 화면에서 고쳐 놓아도
 * `no layers matched`로 실패했다 — 지정이 여기까지 오지 않았기 때문이다
 * (2026-08-10 신고).
 */
test("a file's manual line designation rides along to the batch", async () => {
  await startRun({ "/cuts/b.psd": [7, 9] });

  // 파일을 하나씩 돌므로 첫 호출은 a.psd다. 지정이 없는 파일에는 빈 것이 간다.
  expect(engine.batchRun.mock.calls[0][0]).toEqual(["/cuts/a.psd"]);
  expect(engine.batchRun.mock.calls[0][4]).toEqual({});
  // 검출 정책이 여섯째 인자로 실려 간다 — 엔진이 스윕 특징을 배치 프리셋으로
  // 판단하는 입력(단일 출처 detectDrawnLines.ts).
  expect(engine.batchRun.mock.calls[0][5]).toEqual(DRAWN_LINES_POLICY);

  finish(0);
  await waitFor(() => expect(runs.length).toBe(2));

  // b.psd 차례에는 그 파일의 지정만 실린다.
  expect(engine.batchRun.mock.calls[1][0]).toEqual(["/cuts/b.psd"]);
  expect(engine.batchRun.mock.calls[1][4]).toEqual({ "/cuts/b.psd": [7, 9] });
});

/**
 * 아티스트가 물린 검출 결과가 배치까지 가야 한다 — 지정과 반대 방향의 같은 문제다.
 *
 * 검출은 프리셋과 무관하게 늘 돌고 배치는 파일마다 사이드카 특징으로 다시
 * 판단하므로, 화면에서 뺀 잎이 배치에서 그대로 되살아났다. 같은 파일인데 화면
 * 내보내기는 거절을 지키고 배치만 안 지켜서, 아티스트가 뺀 것이 말없이 납품
 * 파일에 들어갔다.
 */
test("a file's rejected drawn line rides along to the batch", async () => {
  await startRun({}, { "/cuts/b.psd": [4] });

  // 거절이 없는 파일에는 빈 것이 간다(일곱째 인자).
  expect(engine.batchRun.mock.calls[0][0]).toEqual(["/cuts/a.psd"]);
  expect(engine.batchRun.mock.calls[0][6]).toEqual({});

  finish(0);
  await waitFor(() => expect(runs.length).toBe(2));

  // b.psd 차례에는 그 파일의 거절만 실린다.
  expect(engine.batchRun.mock.calls[1][0]).toEqual(["/cuts/b.psd"]);
  expect(engine.batchRun.mock.calls[1][6]).toEqual({ "/cuts/b.psd": [4] });
});

/**
 * 배치의 기본 프리셋.
 *
 * 배치는 자기 목록의 첫 번째로 시작했다. 위쪽 `PresetBar`의 선택과 갈리면
 * 아티스트가 보고 승인한 설정과 실제로 나가는 산출물이 조용히 달라진다 —
 * 2026-08-10에 이것 때문에 생성된 라인이 빠진 산출물이 실제로 나갔다.
 */
const PSD = { ...PRESET, outputFormat: "psd" as const };
const PRESET_B = { ...PSD, name: "line 추출 (굵게)" };
const PRESET_C = { ...PSD, name: "line 추출 (얇게)" };

function presetSelect() {
  return screen.getByRole("combobox") as HTMLSelectElement;
}

/**
 * 실행하지 않고 패널만 띄운다. 기본 선택을 보기 위한 것.
 *
 * 화면의 `<select>`만으로는 부족하다 — 목록에 없는 이름을 넣으면 브라우저가
 * 첫 번째를 고른 것처럼 보여주므로, "지운 이름이 그대로 남은" 고장이 정상과
 * 똑같이 보인다. 그래서 실제로 배치를 돌려 엔진에 무엇이 갔는지로 확인한다
 * (그것이 곧 산출물이다).
 */
function panel(defaultPresetName: string | null) {
  return (
    <BatchPanel
      files={FILES}
      defaultPresetName={defaultPresetName}
      manualLineIdsByPath={{}}
      rejectedLineIdsByPath={{}}
      workers={1}
      onError={vi.fn()}
      onRunningChange={() => {}}
    />
  );
}

/** 배치를 실행하고, 엔진이 받은 프리셋을 돌려준다. */
async function runAndTakePreset() {
  await waitFor(() => expect(screen.getByRole("button", { name: "배치 실행" })).toBeTruthy());
  click("배치 실행");
  await waitFor(() => expect(engine.batchRun).toHaveBeenCalled());
  return engine.batchRun.mock.calls[0][1];
}

test("the batch starts on the preset the top bar has, not the first in the list", async () => {
  vi.mocked(loadPresets).mockResolvedValueOnce([PSD, PRESET_B, PRESET_C]);

  render(panel(PRESET_B.name));
  await waitFor(() => expect(presetSelect().value).toBe(PRESET_B.name));

  expect(await runAndTakePreset()).toEqual(PRESET_B);
});

test("a name that is no longer in the list falls back to the first", async () => {
  // 프리셋을 지웠거나 이름을 바꿨을 수 있다. 그럴 땐 예전 동작 그대로다.
  // 이름을 그대로 들고 있으면 고른 프리셋이 없는 셈이라 배치 실행 자체가 막힌다.
  vi.mocked(loadPresets).mockResolvedValueOnce([PSD, PRESET_B, PRESET_C]);

  render(panel("사라진 프리셋"));

  expect(await runAndTakePreset()).toEqual(PSD);
});

test("what the artist picked in the batch dropdown survives a change up top", async () => {
  // 이 이름을 값으로 보고 바뀔 때마다 선택을 맞추면(의존성에 넣거나 별도 effect로
  // 만들면), 배치에서 고른 것이 위쪽 바를 건드릴 때마다 되돌아간다. 목록을 읽는
  // 그 순간에만 봐야 한다.
  vi.mocked(loadPresets).mockResolvedValueOnce([PSD, PRESET_B, PRESET_C]);

  const { rerender } = render(panel(PSD.name));
  await waitFor(() => expect(presetSelect().value).toBe(PSD.name));

  fireEvent.change(presetSelect(), { target: { value: PRESET_B.name } });
  expect(presetSelect().value).toBe(PRESET_B.name);

  // 위쪽 바에서 다른 프리셋을 골랐다.
  rerender(panel(PRESET_C.name));
  // 되맞추는 effect가 있다면 여기서 돈다(비동기라 한 번 흘려보낸다).
  await act(async () => {});

  expect(presetSelect().value).toBe(PRESET_B.name);
  expect(await runAndTakePreset()).toEqual(PRESET_B);
});
