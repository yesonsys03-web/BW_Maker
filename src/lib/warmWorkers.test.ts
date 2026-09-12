import { expect, test, vi } from "vitest";
import {
  runWorkerSweep,
  runPrepareQueue,
  type WorkerEvent,
  type WorkerSweepDeps,
  type PrepareDeps,
  type PrepareProgress,
} from "./warmWorkers";

/** 가짜 워커판. 이벤트를 손으로 흘려보내며 디스패처 규칙을 검증한다. */
function harness(paths: string[], workerCount: number, ids = [0, 1]) {
  let lineCb: ((e: { generation: number; id: number; line: string }) => void) | undefined;
  let exitCb: ((e: { generation: number; id: number }) => void) | undefined;
  const sends: Array<{ id: number; path: string }> = [];
  const progress: number[] = [];
  const stop = vi.fn(async () => {});
  const deps: WorkerSweepDeps = {
    paths,
    workerCount,
    start: async () => ({ generation: 7, ids: ids.slice(0, workerCount) }),
    send: async (id, path) => void sends.push({ id, path }),
    stop,
    onLine: async (cb) => {
      lineCb = cb;
      return () => (lineCb = undefined);
    },
    onExit: async (cb) => {
      exitCb = cb;
      return () => (exitCb = undefined);
    },
    onProgress: (p) => void progress.push(p.doneLeaves),
  };
  const emit = (id: number, ev: WorkerEvent, generation = 7) =>
    lineCb?.({ generation, id, line: JSON.stringify(ev) });
  const exit = (id: number, generation = 7) => exitCb?.({ generation, id });
  return { deps, sends, progress, stop, emit, exit };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("each worker pulls the next file as soon as it finishes one", async () => {
  const h = harness(["a", "b", "c"], 2);
  const run = runWorkerSweep(h.deps);
  await tick();
  // 처음에는 워커마다 한 파일씩.
  expect(h.sends).toEqual([
    { id: 0, path: "a" },
    { id: 1, path: "b" },
  ]);

  // 1번이 먼저 끝나면 다음 파일(c)은 1번이 가져간다 — 미리 나누지 않는다.
  h.emit(1, { event: "file", path: "b", ok: true, total: 4 });
  await tick();
  expect(h.sends[2]).toEqual({ id: 1, path: "c" });

  h.emit(0, { event: "file", path: "a", ok: true, total: 2 });
  h.emit(1, { event: "file", path: "c", ok: true, total: 1 });
  const result = await run.finished;
  expect(result).toEqual({ done: [{ path: "b" }, { path: "a" }, { path: "c" }], failed: [] });
  expect(h.stop).toHaveBeenCalled();
});

test("progress counts finished files plus the in-flight partials", async () => {
  const h = harness(["a", "b"], 2);
  runWorkerSweep(h.deps);
  await tick();

  h.emit(0, { event: "progress", path: "a", done: 3, total: 10 });
  h.emit(1, { event: "progress", path: "b", done: 5, total: 10 });
  expect(h.progress[h.progress.length - 1]).toBe(8); // 3 + 5

  h.emit(0, { event: "file", path: "a", ok: true, total: 10, mtime: 1234 });
  expect(h.progress[h.progress.length - 1]).toBe(15); // 끝난 a(10) + 진행 중 b(5)
});

test("the worker-reported mtime rides along in the result", async () => {
  // 앱이 아직 안 연 파일도 워커에 맡기므로, "쓸었다"(path+mtime) 기록의 mtime은
  // 워커가 재서 준 값이 정본이다.
  const h = harness(["a"], 1, [0]);
  const run = runWorkerSweep(h.deps);
  await tick();
  h.emit(0, { event: "file", path: "a", ok: true, total: 2, mtime: 1786500000 });
  const result = await run.finished;
  expect(result!.done).toEqual([{ path: "a", mtime: 1786500000 }]);
});

test("a dead worker's file goes back to the queue and another worker takes it", async () => {
  const h = harness(["a", "b"], 2);
  const run = runWorkerSweep(h.deps);
  await tick();

  h.exit(0); // a를 하던 워커가 죽는다 — 아직 b가 안 끝났으니 큐에 되돌아간다
  h.emit(1, { event: "file", path: "b", ok: true, total: 1 });
  await tick();
  expect(h.sends[h.sends.length - 1]).toEqual({ id: 1, path: "a" });

  h.emit(1, { event: "file", path: "a", ok: true, total: 1 });
  const result = await run.finished;
  expect(result).toEqual({ done: [{ path: "b" }, { path: "a" }], failed: [] });
});

test("when every worker dies the sweep ends and reports what was left", async () => {
  const h = harness(["a", "b", "c"], 2);
  const run = runWorkerSweep(h.deps);
  await tick();

  h.exit(0);
  h.exit(1);
  const result = await run.finished;
  expect(result!.done).toEqual([]);
  expect(result!.failed.map((f) => f.path).sort()).toEqual(["a", "b", "c"]);
  expect(result!.failed[0].message).toBe("worker died");
});

test("a failed file is recorded but the sweep keeps going", async () => {
  const h = harness(["a", "b"], 1, [0]);
  const run = runWorkerSweep(h.deps);
  await tick();

  h.emit(0, { event: "file", path: "a", ok: false, message: "ValueError: bad" });
  await tick();
  expect(h.sends[h.sends.length - 1]).toEqual({ id: 0, path: "b" });
  h.emit(0, { event: "file", path: "b", ok: true, total: 1 });

  const result = await run.finished;
  expect(result).toEqual({
    done: [{ path: "b" }],
    failed: [{ path: "a", message: "ValueError: bad" }],
  });
});

test("cancel resolves null and stops the workers", async () => {
  const h = harness(["a", "b"], 2);
  const run = runWorkerSweep(h.deps);
  await tick();
  run.cancel();
  expect(await run.finished).toBeNull();
  expect(h.stop).toHaveBeenCalled();

  // 취소 뒤에 도착하는 이벤트는 아무것도 바꾸지 않는다.
  h.emit(0, { event: "file", path: "a", ok: true, total: 1 });
});

test("events from a stale generation are ignored", async () => {
  const h = harness(["a"], 1, [0]);
  const run = runWorkerSweep(h.deps);
  await tick();

  h.emit(0, { event: "file", path: "a", ok: true, total: 1 }, 6); // 이전 세대
  h.exit(0, 6);
  await tick();
  // 이전 세대 이벤트로는 끝나지 않는다 — 진짜 세대(7)의 완료만 친다.
  h.emit(0, { event: "file", path: "a", ok: true, total: 1 });
  const result = await run.finished;
  expect(result).toEqual({ done: [{ path: "a" }], failed: [] });
});

// ---- v0.2.7 침묵 멈춤의 회귀 잠금 ----
// 디스패치의 어느 단계가 실패해도 스윕은 "사유를 실은 실패"로 끝나야 한다.
// 예전에는 send 실패가 조용히 큐로 되돌아가고, start/구독 실패는 unhandled
// rejection으로 증발해, 진행바가 0에서 영원히 멈춘 채 아무 카드도 없었다.

test("every send failing settles the sweep with the reason, not a silent stall", async () => {
  const h = harness(["a", "b", "c"], 2);
  h.deps.send = async () => {
    throw new Error("no such worker");
  };
  const run = runWorkerSweep(h.deps);
  const result = await run.finished;
  expect(result).not.toBeNull();
  expect(result!.done).toEqual([]);
  // 남은 파일 전부가 같은 사유로 실패에 적힌다.
  expect(result!.failed.length).toBe(3);
  expect(result!.failed[0].message).toContain("no such worker");
  expect(h.stop).toHaveBeenCalled();
});

test("a start failure settles with the reason instead of an unhandled rejection", async () => {
  const h = harness(["a"], 2);
  h.deps.start = async () => {
    throw new Error("spawn refused");
  };
  const run = runWorkerSweep(h.deps);
  const result = await run.finished;
  expect(result).not.toBeNull();
  expect(result!.failed.map((f) => f.path)).toEqual(["a"]);
  expect(result!.failed[0].message).toContain("spawn refused");
});

test("thirty seconds of worker silence fails the sweep and names the stalled stage", async () => {
  vi.useFakeTimers();
  try {
    // send는 성공하는데 워커가 아무 신호(ready/progress/file)도 안 낸다 —
    // v0.2.7의 실제 증상(동결 진입점이 --warm-worker를 몰라 RPC 엔진으로 뜸).
    const h = harness(["a", "b"], 2);
    const run = runWorkerSweep(h.deps);
    await vi.advanceTimersByTimeAsync(29_000);
    // 아직은 기다린다 — 느린 기동을 성급히 실패로 접지 않는다.
    let settled = false;
    void run.finished.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await run.finished;
    expect(result).not.toBeNull();
    expect(result!.failed.length).toBe(2);
    expect(result!.failed[0].message).toContain("신호가 없음");
  } finally {
    vi.useRealTimers();
  }
});

test("a worker event before the deadline disarms the silence watchdog", async () => {
  vi.useFakeTimers();
  try {
    const h = harness(["a"], 1, [0]);
    const run = runWorkerSweep(h.deps);
    await vi.advanceTimersByTimeAsync(0);
    h.emit(0, { event: "ready" });
    await vi.advanceTimersByTimeAsync(60_000);
    // 신호를 봤으므로 무소식 실패는 나지 않는다 — 스윕은 계속 산다.
    let settled = false;
    void run.finished.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    h.emit(0, { event: "file", path: "a", ok: true, total: 1 });
    const result = await run.finished;
    expect(result).toEqual({ done: [{ path: "a" }], failed: [] });
  } finally {
    vi.useRealTimers();
  }
});

// ---- 배치 내보내기 어댑터 ----

import { runBatchExport, type BatchExportDeps, type BatchWorkerResultEntry } from "./warmWorkers";

function batchDeps(h: ReturnType<typeof harness>): BatchExportDeps {
  const { onProgress: _drop, ...rest } = h.deps;
  return rest;
}

const entry = (path: string, ok = true): BatchWorkerResultEntry =>
  ({ path, ok, outputPath: `/out/${path}`, layerCount: 1 });

test("batch export returns worker results in input order, not completion order", async () => {
  const h = harness(["a", "b"], 2);
  const results: string[] = [];
  const run = runBatchExport({
    ...batchDeps(h),
    onResult: (e) => void results.push(e.path),
  });
  await tick();
  // b가 먼저 끝나도(완주 순서) 최종 목록은 입력 순서다 — 보고서가 실행마다
  // 다른 순서로 나오면 안 된다. 점진 콜백(onResult)은 완주 순서 그대로다.
  h.emit(1, { event: "file", path: "b", ok: true, result: entry("b") });
  h.emit(0, { event: "file", path: "a", ok: false, result: entry("a", false) });
  const outcome = await run.finished;
  expect(results).toEqual(["b", "a"]);
  expect(outcome.results.map((r) => r.path)).toEqual(["a", "b"]);
  expect(outcome.results.map((r) => r.ok)).toEqual([false, true]);
  expect(outcome.stopped).toBe(false);
  expect(outcome.remaining).toEqual([]);
});

test("batch export stop drains in-flight files instead of killing them", async () => {
  // 내보내기 쓰기는 원자적이지 않다 — 중지는 "진행 중 파일은 마친다"여야
  // 반쪽 PSD가 안 남는다(직렬 배치의 '현재 파일 마치는 중...'과 같은 약속).
  const h = harness(["a", "b", "c"], 2);
  const run = runBatchExport(batchDeps(h));
  await tick();
  expect(h.sends.length).toBe(2); // a, b가 워커에
  run.stop();
  // 중지 뒤에도 진행 중이던 파일의 완료는 정상 수집되고, c는 먹이지 않는다.
  h.emit(0, { event: "file", path: "a", ok: true, result: entry("a") });
  await tick();
  expect(h.sends.length).toBe(2);
  h.emit(1, { event: "file", path: "b", ok: true, result: entry("b") });
  const outcome = await run.finished;
  expect(outcome.stopped).toBe(true);
  expect(outcome.results.map((r) => r.path)).toEqual(["a", "b"]);
  expect(outcome.remaining).toEqual(["c"]);
  expect(h.stop).toHaveBeenCalled();
});

test("batch export wiring failures land in the report, loudly", async () => {
  const h = harness(["a", "b"], 2);
  const deps = batchDeps(h);
  deps.send = async () => {
    throw new Error("no such worker");
  };
  const outcome = await runBatchExport(deps).finished;
  expect(outcome.stopped).toBe(false);
  expect(outcome.results.map((r) => r.ok)).toEqual([false, false]);
  const err = outcome.results[0].error as { message: string };
  expect(err.message).toContain("no such worker");
});

// ---- 파일 준비 큐 어댑터 ----

/** 준비 큐용 가짜 워커판. harness와 같은 모양이되 결과를 모은다. */
function prepareHarness(paths: string[], workerCount: number, ids = [0, 1]) {
  let lineCb: ((e: { generation: number; id: number; line: string }) => void) | undefined;
  let exitCb: ((e: { generation: number; id: number }) => void) | undefined;
  const sends: Array<{ id: number; path: string }> = [];
  const results: Array<{ path: string; result: Record<string, unknown> }> = [];
  const progress: PrepareProgress[] = [];
  const deps: PrepareDeps = {
    paths,
    workerCount,
    start: async () => ({ generation: 7, ids: ids.slice(0, workerCount) }),
    send: async (id, path) => void sends.push({ id, path }),
    stop: vi.fn(async () => {}),
    onLine: async (cb) => { lineCb = cb; return () => (lineCb = undefined); },
    onExit: async (cb) => { exitCb = cb; return () => (exitCb = undefined); },
    onResult: (path, result) => void results.push({ path, result }),
    onProgress: (p) => void progress.push(p),
  };
  // 준비 잡의 result는 배치 내보내기의 BatchWorkerResultEntry(ok 필수)와 다른
  // 모양(Record<string, unknown>)이라 WorkerEvent를 그대로는 못 쓴다 — result
  // 필드만 느슨하게 다시 잡는다.
  const emit = (
    id: number,
    ev: Omit<WorkerEvent, "result"> & { result?: Record<string, unknown> },
    generation = 7
  ) => lineCb?.({ generation, id, line: JSON.stringify(ev) });
  const exit = (id: number, generation = 7) => exitCb?.({ generation, id });
  return { deps, sends, results, progress, emit, exit };
}

test("prepare hands each result to the caller as soon as that file lands", async () => {
  const h = prepareHarness(["a", "b", "c"], 2);
  const run = runPrepareQueue(h.deps);
  await tick();
  expect(h.sends).toEqual([{ id: 0, path: "a" }, { id: 1, path: "b" }]);

  // 파일 하나가 끝나면 끝까지 기다리지 않고 그 자리에서 넘긴다 — 100장짜리
  // 폴더에서 다 끝나야 화면이 채워지면 아무것도 안 보이는 시간이 길어진다.
  h.emit(1, { event: "file", path: "b", ok: true, result: { path: "b", mtime: 2 } });
  await tick();
  expect(h.results).toEqual([{ path: "b", result: { path: "b", mtime: 2 } }]);
  // 그리고 빈 워커가 다음 파일을 당겨 간다.
  expect(h.sends[2]).toEqual({ id: 1, path: "c" });

  h.emit(0, { event: "file", path: "a", ok: true, result: { path: "a", mtime: 1 } });
  h.emit(1, { event: "file", path: "c", ok: true, result: { path: "c", mtime: 3 } });
  const out = await run.finished;
  expect(out.failed).toEqual([]);
  expect(out.stopped).toBe(false);
});

test("prepare records a failed file and keeps going", async () => {
  const h = prepareHarness(["a", "b"], 2);
  const run = runPrepareQueue(h.deps);
  await tick();

  h.emit(0, { event: "file", path: "a", ok: false, message: "boom" });
  h.emit(1, { event: "file", path: "b", ok: true, result: { path: "b" } });
  const out = await run.finished;
  expect(out.failed).toEqual([{ path: "a", message: "boom" }]);
  expect(h.results.map((r) => r.path)).toEqual(["b"]);
});

test("cancel is not a failure — the remaining files stay unclaimed", async () => {
  const h = prepareHarness(["a", "b", "c"], 1, [0]);
  const run = runPrepareQueue(h.deps);
  await tick();

  // 전체 캐시가 시작하면 작업 프로세스가 전부 죽는다. 그때 남은 파일을
  // "실패"로 적으면 가짜 오류 카드("미리보기를 미리 만들지 못한 파일 N개")가
  // 뜬다 — 취소는 실패가 아니다.
  run.cancel();
  const out = await run.finished;
  expect(out.stopped).toBe(true);
  expect(out.failed).toEqual([]);
  expect(out.remaining).toEqual(["b", "c"]);
});

test("a failed file advances filesDone by exactly one, not two", async () => {
  // 실패한 파일이 done과 failed 양쪽에 잡히면 진행바가 한 파일에 2씩 밀린다
  // — 실패가 섞인 폴더에서 진행바가 100%를 넘어간다. 실패 쪽을 먼저 흘려보내
  // "둘로 세는" 그 파일이 실제로 여기 걸리게 한다.
  const h = prepareHarness(["a", "b"], 2);
  const run = runPrepareQueue(h.deps);
  await tick();

  h.emit(0, { event: "file", path: "a", ok: false, message: "boom" });
  h.emit(1, { event: "file", path: "b", ok: true, result: { path: "b" } });
  await run.finished;

  // 관측한 진행값 전부가 총량을 넘어서는 안 되고, 마지막 값은 파일 수(2)와
  // 정확히 같아야 한다 — 최종값만 보면 순서에 따라 우연히 통과할 수 있어
  // 매 보고를 확인한다.
  for (const p of h.progress) {
    expect(p.filesDone).toBeLessThanOrEqual(p.filesTotal);
  }
  expect(h.progress[h.progress.length - 1]).toEqual({ filesDone: 2, filesTotal: 2 });
});

test("strokes events reach onStrokes with the file's features", async () => {
  // 워커가 잎을 구운 김에 재둔 굵기 특징 — 무세션 검출(App)의 입력이다.
  const h = harness(["a"], 1);
  const got: Array<[string, number]> = [];
  h.deps.onStrokes = (path, features) => void got.push([path, Object.keys(features).length]);
  const run = runWorkerSweep(h.deps);
  await tick();
  h.emit(0, { event: "strokes", path: "a", features: { "3": null, "4": { survive1: 0, survive2: 0, coverage: 0.01, nNative: 30000 } } });
  h.emit(0, { event: "file", path: "a", ok: true, total: 1 });
  await run.finished;
  expect(got).toEqual([["a", 2]]);
});
