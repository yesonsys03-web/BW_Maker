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
