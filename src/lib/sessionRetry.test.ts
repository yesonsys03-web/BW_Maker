import { beforeEach, expect, test, vi } from "vitest";

// vi.mock factories are hoisted; only "mock"-prefixed outer vars are reachable inside them.
const mockOpenPsd = vi.fn();
vi.mock("./engine", async () => {
  const actual = await vi.importActual<typeof import("./engine")>("./engine");
  return { ...actual, openPsd: (...a: unknown[]) => mockOpenPsd(...a) };
});

import { EngineRpcError } from "./engine";
import { isEvictedSessionError } from "./preview";
import { withEvictedSessionRetry } from "./sessionRetry";

// Block body, not a concise arrow — mockReset() returns the mock itself, and
// vitest treats a beforeEach that returns a value as a cleanup hook (Task 3's
// footgun; see appStore.test.ts / progress.md).
beforeEach(() => {
  mockOpenPsd.mockReset();
});

test("isEvictedSessionError matches the engine's KeyError repr-quoted message", () => {
  expect(isEvictedSessionError(new EngineRpcError({ message: "'unknown or evicted session: 2'" }))).toBe(true);
});

test("isEvictedSessionError matches an unquoted variant too (substring match)", () => {
  expect(isEvictedSessionError(new EngineRpcError({ message: "unknown or evicted session: 7" }))).toBe(true);
});

test("isEvictedSessionError is false for unrelated engine errors", () => {
  expect(isEvictedSessionError(new EngineRpcError({ message: "unsupported color mode" }))).toBe(false);
});

test("isEvictedSessionError is false for a plain Error/unknown value", () => {
  expect(isEvictedSessionError(new Error("boom"))).toBe(false);
  expect(isEvictedSessionError("boom")).toBe(false);
});

test("withEvictedSessionRetry returns the first call's result without reopening on success", async () => {
  const call = vi.fn().mockResolvedValue("ok");
  const onReopened = vi.fn();
  const result = await withEvictedSessionRetry("/a.psd", 1, call, onReopened);
  expect(result).toBe("ok");
  expect(call).toHaveBeenCalledTimes(1);
  expect(call).toHaveBeenCalledWith(1);
  expect(mockOpenPsd).not.toHaveBeenCalled();
  expect(onReopened).not.toHaveBeenCalled();
});

test("on an evicted-session failure, reopens the path and retries once with the new sessionId", async () => {
  const call = vi
    .fn()
    .mockRejectedValueOnce(new EngineRpcError({ message: "'unknown or evicted session: 1'" }))
    .mockResolvedValueOnce("ok-after-reopen");
  const reopened = { sessionId: 99, width: 1, height: 1, colorMode: "RGB", depth: 8, tree: [] };
  mockOpenPsd.mockResolvedValue(reopened);
  const onReopened = vi.fn();

  const result = await withEvictedSessionRetry("/a.psd", 1, call, onReopened);

  expect(result).toBe("ok-after-reopen");
  expect(mockOpenPsd).toHaveBeenCalledWith("/a.psd");
  expect(onReopened).toHaveBeenCalledWith(reopened);
  expect(call).toHaveBeenNthCalledWith(1, 1);
  expect(call).toHaveBeenNthCalledWith(2, 99);
});

// 파일을 한꺼번에 불러올 때 실제로 났던 실패다. 세션 칸이 둘뿐이라 되살린
// 세션이 다음 호출 전에 또 밀려나는데, 재시도가 한 번뿐이면 그대로 에러가 된다.
test("survives an eviction that repeats, retrying from each newly reopened session", async () => {
  const evicted = (sid: number) => new EngineRpcError({ message: `'unknown or evicted session: ${sid}'` });
  const call = vi
    .fn()
    .mockRejectedValueOnce(evicted(1))
    .mockRejectedValueOnce(evicted(11))
    .mockResolvedValueOnce("ok");
  mockOpenPsd
    .mockResolvedValueOnce({ sessionId: 11, width: 1, height: 1, colorMode: "RGB", depth: 8, tree: [] })
    .mockResolvedValueOnce({ sessionId: 12, width: 1, height: 1, colorMode: "RGB", depth: 8, tree: [] });

  await expect(withEvictedSessionRetry("/a.psd", 1, call, vi.fn())).resolves.toBe("ok");

  // 매 재시도가 직전 재오픈이 준 id로 나가야 한다. 처음 id를 계속 쓰면 재오픈이
  // 무한히 반복되면서 스스로 축출을 만들어낸다.
  expect(call.mock.calls.map((c) => c[0])).toEqual([1, 11, 12]);
});

test("gives up rather than reopening forever, so a real fault still surfaces", async () => {
  const call = vi.fn().mockRejectedValue(new EngineRpcError({ message: "unknown or evicted session: 1" }));
  mockOpenPsd.mockResolvedValue({ sessionId: 2, width: 1, height: 1, colorMode: "RGB", depth: 8, tree: [] });

  await expect(withEvictedSessionRetry("/a.psd", 1, call, vi.fn())).rejects.toThrow("evicted session");
  // 첫 호출 + 재오픈 상한만큼의 재시도.
  expect(call).toHaveBeenCalledTimes(4);
  expect(mockOpenPsd).toHaveBeenCalledTimes(3);
});

test("a non-eviction failure propagates without reopening", async () => {
  const err = new EngineRpcError({ message: "unsupported color mode" });
  const call = vi.fn().mockRejectedValue(err);
  const onReopened = vi.fn();

  await expect(withEvictedSessionRetry("/a.psd", 1, call, onReopened)).rejects.toBe(err);
  expect(mockOpenPsd).not.toHaveBeenCalled();
  expect(onReopened).not.toHaveBeenCalled();
});

test("a reopen failure (evicted, then open_psd itself fails) propagates the reopen's error", async () => {
  const call = vi.fn().mockRejectedValue(new EngineRpcError({ message: "unknown or evicted session: 1" }));
  const reopenErr = new EngineRpcError({ message: "file not found" });
  mockOpenPsd.mockRejectedValue(reopenErr);
  const onReopened = vi.fn();

  await expect(withEvictedSessionRetry("/a.psd", 1, call, onReopened)).rejects.toBe(reopenErr);
  expect(onReopened).not.toHaveBeenCalled();
  expect(call).toHaveBeenCalledTimes(1);
});
