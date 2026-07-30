import { beforeEach, expect, test, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { callEngine, loadPngDataUrl } from "./engine";

beforeEach(() => invokeMock.mockReset());

test("callEngine passes method/params and returns result", async () => {
  invokeMock.mockResolvedValue({ sessionId: 1 });
  const r = await callEngine("open_psd", { path: "/a.psd" });
  expect(invokeMock).toHaveBeenCalledWith("engine_request", { method: "open_psd", params: { path: "/a.psd" } });
  expect(r).toEqual({ sessionId: 1 });
});

test("callEngine surfaces engine error with traceback", async () => {
  invokeMock.mockRejectedValue({ message: "boom", traceback: "Traceback ..." });
  await expect(callEngine("open_psd", { path: "x" })).rejects.toMatchObject({ message: "boom", traceback: expect.stringContaining("Traceback") });
});

test("loadPngDataUrl builds data url", async () => {
  invokeMock.mockResolvedValue("QUJD");
  await expect(loadPngDataUrl("/tmp/p.png")).resolves.toBe("data:image/png;base64,QUJD");
});
