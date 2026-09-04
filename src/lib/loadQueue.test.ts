import { expect, test, vi } from "vitest";
import { drainLoadQueue, type LoadProgress } from "./loadQueue";

/**
 * 파일 목록을 흉내 낸다. processPath가 불린 경로는 pending에서 빠지는데,
 * 이것이 실제 앱의 동작이다(상태가 idle에서 벗어난다).
 */
function harness(initial: string[], opts: { lagging?: boolean } = {}) {
  let pending = [...initial];
  const processed: string[] = [];
  const progress: (LoadProgress | null)[] = [];
  let cancel = false;

  return {
    processed,
    progress,
    add: (p: string) => pending.push(p),
    cancel: () => {
      cancel = true;
    },
    run: () =>
      drainLoadQueue({
        pendingPaths: () => [...pending],
        processPath: async (path) => {
          processed.push(path);
          // lagging: 상태 반영이 늦어 처리한 파일이 목록에 그대로 남아 있는 경우.
          if (!opts.lagging) pending = pending.filter((p) => p !== path);
        },
        onProgress: (p) => progress.push(p),
        cancelled: () => cancel,
      }),
  };
}

test("opens every queued file exactly once, in order", async () => {
  const h = harness(["/a.psd", "/b.psd", "/c.psd"]);
  await h.run();
  expect(h.processed).toEqual(["/a.psd", "/b.psd", "/c.psd"]);
});

// 종료 보장의 핵심. 실제 앱에서 파일 목록은 효과로 동기화되므로 await 직후에는
// 방금 연 파일이 아직 "대기"로 보일 수 있다.
test("terminates even when the pending list never updates", async () => {
  const h = harness(["/a.psd", "/b.psd"], { lagging: true });
  await h.run();
  expect(h.processed).toEqual(["/a.psd", "/b.psd"]);
});

test("picks up files added while it is running", async () => {
  let pending = ["/a.psd"];
  const processed: string[] = [];
  await drainLoadQueue({
    pendingPaths: () => [...pending],
    processPath: async (path) => {
      processed.push(path);
      pending = pending.filter((p) => p !== path);
      if (path === "/a.psd") pending.push("/late.psd");
    },
    onProgress: () => {},
    cancelled: () => false,
  });
  expect(processed).toEqual(["/a.psd", "/late.psd"]);
});

test("an empty queue does no work and clears the progress bar", async () => {
  const h = harness([]);
  await h.run();
  expect(h.processed).toEqual([]);
  expect(h.progress).toEqual([null]);
});

test("progress counts up to the total and ends at null", async () => {
  const h = harness(["/a.psd", "/b.psd"]);
  await h.run();
  expect(h.progress).toEqual([
    { done: 0, total: 2 },
    { done: 1, total: 2 },
    { done: 1, total: 2 },
    { done: 2, total: 2 },
    null,
  ]);
});

test("the total grows when files arrive mid-run instead of overshooting 100%", async () => {
  let pending = ["/a.psd"];
  const progress: (LoadProgress | null)[] = [];
  await drainLoadQueue({
    pendingPaths: () => [...pending],
    processPath: async (path) => {
      pending = pending.filter((p) => p !== path);
      if (path === "/a.psd") pending.push("/b.psd");
    },
    onProgress: (p) => progress.push(p),
    cancelled: () => false,
  });
  // done이 total을 넘는 순간이 없어야 한다.
  for (const p of progress) if (p) expect(p.done).toBeLessThanOrEqual(p.total);
  expect(progress[progress.length - 1]).toBeNull();
});

test("cancelling stops before the next file, leaving the rest untouched", async () => {
  let pending = ["/a.psd", "/b.psd", "/c.psd"];
  const processed: string[] = [];
  let cancel = false;
  await drainLoadQueue({
    pendingPaths: () => [...pending],
    processPath: async (path) => {
      processed.push(path);
      pending = pending.filter((p) => p !== path);
      if (path === "/a.psd") cancel = true;
    },
    onProgress: () => {},
    cancelled: () => cancel,
  });
  expect(processed).toEqual(["/a.psd"]);
  expect(pending).toEqual(["/b.psd", "/c.psd"]);
});

test("a cancel that lands before the first file does no work at all", async () => {
  const processPath = vi.fn();
  await drainLoadQueue({
    pendingPaths: () => ["/a.psd"],
    processPath,
    onProgress: () => {},
    cancelled: () => true,
  });
  expect(processPath).not.toHaveBeenCalled();
});

test("a thrown processPath still clears the progress bar", async () => {
  const progress: (LoadProgress | null)[] = [];
  await expect(
    drainLoadQueue({
      pendingPaths: () => ["/a.psd"],
      processPath: async () => {
        throw new Error("boom");
      },
      onProgress: (p) => progress.push(p),
      cancelled: () => false,
    })
  ).rejects.toThrow("boom");
  expect(progress[progress.length - 1]).toBeNull();
});
