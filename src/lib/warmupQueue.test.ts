import { describe, expect, it } from "vitest";

import { drainWarmupQueue, type WarmupRequestResult } from "./warmupQueue";

const noWait = () => Promise.resolve();

describe("drainWarmupQueue", () => {
  it("remaining이 빌 때까지 반복 호출하고 warmed/skipped를 합산한다", async () => {
    const calls: number[][] = [];
    const rounds: WarmupRequestResult[] = [
      { warmed: [1], skipped: [], remaining: [2, 3, 9] },
      { warmed: [2, 3], skipped: [9], remaining: [] },
    ];
    const result = await drainWarmupQueue({
      leafIds: [1, 2, 3, 9],
      request: (ids) => {
        calls.push(ids);
        return Promise.resolve(rounds[calls.length - 1]);
      },
      shouldPause: () => false,
      cancelled: () => false,
      wait: noWait,
    });
    expect(calls).toEqual([[1, 2, 3, 9], [2, 3, 9]]);
    expect(result).toEqual({ warmed: 3, skipped: 1 });
  });

  it("shouldPause가 참인 동안은 요청을 내지 않고 기다린다", async () => {
    let paused = true;
    let waits = 0;
    const calls: number[][] = [];
    const result = await drainWarmupQueue({
      leafIds: [1],
      request: (ids) => {
        calls.push(ids);
        return Promise.resolve({ warmed: ids, skipped: [], remaining: [] });
      },
      // 세 번 기다린 뒤 풀린다 — 기다리는 동안 요청이 나가면 안 된다.
      shouldPause: () => paused,
      cancelled: () => false,
      wait: () => {
        waits += 1;
        if (waits >= 3) paused = false;
        return Promise.resolve();
      },
    });
    expect(waits).toBe(3);
    expect(calls).toEqual([[1]]);
    expect(result).toEqual({ warmed: 1, skipped: 0 });
  });

  it("취소되면 null을 돌려주고 더는 요청하지 않는다", async () => {
    let requests = 0;
    let cancelled = false;
    const result = await drainWarmupQueue({
      leafIds: [1, 2],
      request: () => {
        requests += 1;
        cancelled = true; // 첫 요청이 나간 사이 파일이 바뀐 상황
        return Promise.resolve({ warmed: [1], skipped: [], remaining: [2] });
      },
      shouldPause: () => false,
      cancelled: () => cancelled,
      wait: noWait,
    });
    expect(requests).toBe(1);
    expect(result).toBeNull();
  });

  it("remaining이 줄지 않으면 같은 목록으로 영원히 돌지 않는다", async () => {
    let requests = 0;
    const result = await drainWarmupQueue({
      leafIds: [1, 2],
      request: (ids) => {
        requests += 1;
        // 엔진의 "호출당 최소 한 장" 약속이 깨진 상황을 흉내 낸다.
        return Promise.resolve({ warmed: [], skipped: [], remaining: ids });
      },
      shouldPause: () => false,
      cancelled: () => false,
      wait: noWait,
    });
    expect(requests).toBe(1);
    expect(result).toEqual({ warmed: 0, skipped: 0 });
  });
});
