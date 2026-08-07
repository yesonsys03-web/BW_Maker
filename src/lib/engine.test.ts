import { beforeEach, expect, test, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));

import { callEngine, collectPsdFiles, exportPsd, loadPngDataUrl, renderPreview } from "./engine";
import type { EdgeLines } from "./types";

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

// 수동 색 지정(task-8b). TS EdgeLines에는 manualColourIds 필드가 없다 —
// 프리셋에 저장하지 않기 위해서다(파일마다 다른 사실이라 프리셋과 무관).
// 엔진이 기대하는 모양(edgeLines.manualColourIds, task-8a report 참고)으로
// 여기서만 얹는다.
const EDGE: EdgeLines = { enabled: true, threshold: 24, gap: 4, width: 5, minLength: 8, lineAlpha: 64 };

test("renderPreview merges manualColourIds into the edgeLines payload the engine expects", async () => {
  invokeMock.mockResolvedValue({ pngPath: "/tmp/p.png" });
  await renderPreview(1, [10, 11], 1500, "#000000", [10], EDGE, [42]);
  expect(invokeMock).toHaveBeenCalledWith("engine_request", {
    method: "render_preview",
    params: expect.objectContaining({
      edgeLines: { ...EDGE, manualColourIds: [42] },
    }),
  });
});

test("renderPreview defaults manualColourIds to an empty list when omitted", async () => {
  invokeMock.mockResolvedValue({ pngPath: "/tmp/p.png" });
  await renderPreview(1, [10], 1500, null, null, EDGE);
  const params = invokeMock.mock.calls[0][1].params;
  expect(params.edgeLines).toEqual({ ...EDGE, manualColourIds: [] });
});

// edgeLines가 꺼져 있으면(null) 엔진이 애초에 안 읽으므로 그대로 null을 보낸다
// — 지정만 있고 기능이 꺼져 있는 상태를 payload로 흉내내지 않는다.
test("renderPreview sends edgeLines as null when the feature itself is off, even with a designation", async () => {
  invokeMock.mockResolvedValue({ pngPath: "/tmp/p.png" });
  await renderPreview(1, [10], 1500, null, null, null, [42]);
  const params = invokeMock.mock.calls[0][1].params;
  expect(params.edgeLines).toBeNull();
});

test("exportPsd merges manualColourIds into the edgeLines payload the same way", async () => {
  invokeMock.mockResolvedValue({ outputPath: "/out.psd", layerCount: 1 });
  await exportPsd(1, [10], [], "original", "/out.psd", true, true, true, null, false, "psd", null, EDGE, [7, 8]);
  const params = invokeMock.mock.calls[0][1].params;
  expect(params.edgeLines).toEqual({ ...EDGE, manualColourIds: [7, 8] });
});
