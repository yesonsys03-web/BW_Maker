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

import { drainPooledWarmup } from "./warmupQueue";

describe("drainPooledWarmup", () => {
  // 타일 자식들이 디스크에 굽는 동안 디스크 전용 요청으로 쓸어담는 루프.
  // drainWarmupQueue와 결정적으로 다른 계약 하나: **진행이 없어도 풀이 살아
  // 있으면 끝내지 않는다** — 자식이 아직 굽는 중이라는 뜻이므로 기다렸다가
  // 다시 묻는다. (decode 루프의 같은 상황은 프로토콜 위반이라 즉시 끝낸다.)

  it("sweeps tiles as the children land them, waiting between empty polls", async () => {
    const responses = [
      { warmed: [], skipped: [], remaining: [1, 2, 3], poolAlive: true },
      { warmed: [1, 2], skipped: [], remaining: [3], poolAlive: true },
      { warmed: [3], skipped: [], remaining: [], poolAlive: true },
    ];
    const waits: number[] = [];
    const res = await drainPooledWarmup({
      leafIds: [1, 2, 3],
      request: async () => responses.shift()!,
      shouldPause: () => false,
      cancelled: () => false,
      wait: async (ms) => void waits.push(ms),
    });
    expect(res).toEqual({ warmed: 3, skipped: 0, leftover: [] });
    // 첫 응답이 무진행이었다 — 끝내지 않고 기다렸어야 한다
    expect(waits.length).toBeGreaterThan(0);
  });

  it("hands the leftover back when the pool dies with tiles still missing", async () => {
    // 자식이 죽으면 그 몫은 영영 디스크에 안 온다 — 여기서 영원히 돌면
    // "나머지 레이어 준비 중"이 멈춘 채로 남는다. 호출자가 디코드 경로로
    // 마저 굽도록 남은 목록을 돌려준다.
    const responses = [
      { warmed: [1], skipped: [], remaining: [2, 3], poolAlive: true },
      { warmed: [], skipped: [], remaining: [2, 3], poolAlive: false },
    ];
    const res = await drainPooledWarmup({
      leafIds: [1, 2, 3],
      request: async () => responses.shift()!,
      shouldPause: () => false,
      cancelled: () => false,
      wait: async () => {},
    });
    expect(res).toEqual({ warmed: 1, skipped: 0, leftover: [2, 3] });
  });

  it("returns null when cancelled, like the decode queue", async () => {
    let calls = 0;
    const res = await drainPooledWarmup({
      leafIds: [1, 2],
      request: async () => {
        calls += 1;
        return { warmed: [], skipped: [], remaining: [1, 2], poolAlive: true };
      },
      shouldPause: () => false,
      cancelled: () => calls >= 2,
      wait: async () => {},
    });
    expect(res).toBeNull();
  });

  it("reports cumulative progress so the bar keeps moving", async () => {
    const responses = [
      { warmed: [1], skipped: [], remaining: [2, 3], poolAlive: true },
      { warmed: [2], skipped: [3], remaining: [], poolAlive: true },
    ];
    const seen: Array<[number, number]> = [];
    await drainPooledWarmup({
      leafIds: [1, 2, 3],
      request: async () => responses.shift()!,
      shouldPause: () => false,
      cancelled: () => false,
      wait: async () => {},
      onProgress: (w, s) => void seen.push([w, s]),
    });
    expect(seen).toEqual([
      [1, 0],
      [2, 1],
    ]);
  });
});
