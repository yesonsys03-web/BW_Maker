import { expect, test, vi } from "vitest";
import { runWorkerSweep, type WorkerEvent, type WorkerSweepDeps } from "./warmWorkers";

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
