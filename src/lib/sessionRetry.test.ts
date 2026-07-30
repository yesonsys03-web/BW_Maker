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
