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
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
};

vi.mock("../lib/presets", async (orig) => ({
  ...(await orig<typeof import("../lib/presets")>()),
  loadPresets: vi.fn(async () => [PRESET]),
}));

import { BatchPanel } from "./BatchPanel";
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

beforeEach(() => {
  vi.clearAllMocks();
  runs = [];
  engine.onEngineEvent.mockResolvedValue(() => {});
  engine.pathsExist.mockImplementation(async (paths: string[]) => paths.map(() => false));
  engine.batchRun.mockImplementation((paths: string[]) => {
    const d = deferred<{ results: unknown[] }>();
    runs.push({ paths, d });
    return d.promise;
  });
});

afterEach(cleanup);

/** 결과 표의 파일 셀. 같은 이름이 위쪽 파일 선택 목록에도 있어 역할로 좁힌다. */
function resultCells() {
  return screen.queryAllByRole("cell").map((c) => c.textContent);
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

async function startRun() {
  render(<BatchPanel files={FILES} onError={vi.fn()} />);
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
