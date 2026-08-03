import { beforeEach, expect, test, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { callEngine, collectPsdFiles, loadPngDataUrl } from "./engine";

beforeEach(() => {
  invokeMock.mockReset();
});

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

test("collectPsdFiles hands folders and files to the Rust scanner as one list", async () => {
  const scan = { files: ["/cuts/a.psd"], truncated: false, skippedDirs: 0 };
  invokeMock.mockResolvedValue(scan);
  await expect(collectPsdFiles(["/cuts", "/b.psd"])).resolves.toEqual(scan);
  expect(invokeMock).toHaveBeenCalledWith("collect_psd_files", { paths: ["/cuts", "/b.psd"] });
});
