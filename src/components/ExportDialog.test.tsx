// @vitest-environment jsdom
/**
 * 내보내기의 검출 안전장치를 잠근다: 이 파일의 선 그림 검출이 아직이면 끝내고
 * 담는다. 이게 없으면 이름이 어긋난 선화(ROPE DETAILS류)가 조용히 빠진
 * 라인판이 나간다 — 검출을 "한가할 때"로 미루면서 이 창이 넓어졌다.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { ExportDialog } from "./ExportDialog";
import { save } from "@tauri-apps/plugin-dialog";
import { exportImageLine, exportPsd } from "../lib/engine";
import type { OpsState } from "../lib/opsReducer";
import type { TreeNode } from "../lib/types";

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock("../lib/engine", () => ({
  exportImageLine: vi.fn(),
  exportPsd: vi.fn(),
  onEngineEvent: vi.fn(async () => () => {}),
  openPsd: vi.fn(),
  EngineRpcError: class EngineRpcError extends Error {
    traceback: string;
    constructor({ message, traceback }: { message: string; traceback: string }) {
      super(message);
      this.traceback = traceback;
    }
  },
}));

afterEach(cleanup);

beforeEach(() => {
  vi.mocked(save).mockReset().mockResolvedValue("/out.psd");
  // 내보내기 RPC는 호출 여부만 본다 — 미해결로 두면 결과 화면을 흉내 낼 필요가 없다.
  vi.mocked(exportPsd).mockReset().mockImplementation(() => new Promise(() => {}));
  vi.mocked(exportImageLine).mockReset().mockImplementation(() => new Promise(() => {}));
});

const tree: TreeNode[] = [1, 2].map((id) => ({
  id, name: `leaf ${id}`, kind: "pixel", visible: true, blendMode: "normal",
  opacity: 255, bbox: [0, 0, 10, 10], hasMask: false, hasPixels: true,
  path: [`leaf ${id}`],
})) as TreeNode[];

function makeOps(includedIds: number[] = [1]): OpsState {
  return {
    includedIds,
    previewHiddenIds: [],
    soloIds: [],
    edgeColourIds: [],
    manualLineIds: [],
    ops: [],
    entries: includedIds.map((id) => ({ entryId: id, sourceIds: [id], name: null })),
  };
}

function makeProps(over: Partial<Parameters<typeof ExportDialog>[0]> = {}) {
  return {
    sessionId: 3,
    srcPath: "/a.psd",
    ops: makeOps(),
    tree,
    preset: undefined,
    matchedIds: undefined,
    onPushOp: vi.fn(),
    onClose: vi.fn(),
    onSessionRefreshed: vi.fn(),
    onError: vi.fn(),
    ...over,
  };
}

const imageLinePreset = {
  outputSuffix: "_LINE",
  naming: "pathPrefix" as const,
  outputFormat: "png" as const,
  embedPreview: true,
  splitLayers: false,
  lineColor: null,
  imageLine: {
    enabled: true,
    version: 1,
    darkThreshold: 96,
    boundaryThreshold: 32,
    minLength: 8,
    width: 3,
  },
};

test("no pending detection (null) exports immediately", async () => {
  render(<ExportDialog {...makeProps({ onWaitDetection: () => null })} />);
  fireEvent.click(screen.getByRole("button", { name: "내보내기" }));
  await waitFor(() => expect(exportPsd).toHaveBeenCalledTimes(1));
});

test("export waits for this file's pending detection, visibly", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const onWaitDetection = vi.fn(() => gate);
  render(<ExportDialog {...makeProps({ onWaitDetection })} />);
  fireEvent.click(screen.getByRole("button", { name: "내보내기" }));
  await waitFor(() => expect(onWaitDetection).toHaveBeenCalled());
  // 기다리는 동안: 내보내기 버튼은 문구를 바꿔 잠기고, RPC는 아직이다.
  const waitingBtn = screen.getByRole("button", { name: /선 그림 검출 확인 중/ }) as HTMLButtonElement;
  expect(waitingBtn.disabled).toBe(true);
  expect(exportPsd).not.toHaveBeenCalled();
  release();
  await waitFor(() => expect(exportPsd).toHaveBeenCalledTimes(1));
});

test("ops that arrive while waiting (detection designations) are what gets exported", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const props = makeProps({ onWaitDetection: () => gate });
  const view = render(<ExportDialog {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "내보내기" }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  // 기다리는 사이 검출이 잎 2를 지정했다 — App이 새 ops를 내려보낸다.
  view.rerender(<ExportDialog {...props} ops={makeOps([1, 2])} />);
  release();
  await waitFor(() => expect(exportPsd).toHaveBeenCalledTimes(1));
  expect(vi.mocked(exportPsd).mock.calls[0][1]).toEqual([1, 2]);
});

test("closing while waiting cancels the export", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const view = render(<ExportDialog {...makeProps({ onWaitDetection: () => gate })} />);
  fireEvent.click(screen.getByRole("button", { name: "내보내기" }));
  await waitFor(() => expect(save).toHaveBeenCalled());
  view.unmount(); // App이 대화상자를 닫으면 컴포넌트가 내려간다
  release();
  await new Promise((r) => setTimeout(r, 0));
  expect(exportPsd).not.toHaveBeenCalled();
});

test("imageLine can export with zero entries through the new route", async () => {
  render(<ExportDialog {...makeProps({ preset: imageLinePreset as any, ops: makeOps([]) })} />);
  fireEvent.click(screen.getByRole("button", { name: "내보내기" }));

  await waitFor(() => expect(exportImageLine).toHaveBeenCalledTimes(1));
  expect(exportImageLine).toHaveBeenCalledWith(
    3, "/out.psd", "png", imageLinePreset.imageLine, null, true
  );
  expect(exportPsd).not.toHaveBeenCalled();
});

test("legacy zero-entry export remains disabled", () => {
  render(<ExportDialog {...makeProps({ ops: makeOps([]) })} />);
  const button = screen.getByRole("button", { name: "내보내기" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(exportPsd).not.toHaveBeenCalled();
  expect(exportImageLine).not.toHaveBeenCalled();
});

test("imageLine output formats omit jpg while legacy export still offers it", async () => {
  const legacy = render(<ExportDialog {...makeProps()} />);
  expect(screen.getByRole("option", { name: "JPG — 흰 배경" })).toBeTruthy();
  legacy.unmount();

  render(<ExportDialog {...makeProps({ preset: imageLinePreset as any })} />);
  expect(screen.queryByRole("option", { name: "JPG — 흰 배경" })).toBeNull();
  expect(screen.queryByText("파일명 규칙")).toBeNull();
  expect(screen.queryByText("레이어마다 파일 따로 내보내기")).toBeNull();
});

test("an invalid imageLine jpg preset is rejected instead of silently coerced", async () => {
  const onError = vi.fn();
  render(<ExportDialog {...makeProps({
    preset: { ...imageLinePreset, outputFormat: "jpg" as const } as any,
    onError,
  })} />);
  fireEvent.click(screen.getByRole("button", { name: "내보내기" }));

  await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
  expect(exportImageLine).not.toHaveBeenCalled();
});

test("a verified imageLine export is shown as successful", async () => {
  vi.mocked(exportImageLine).mockResolvedValueOnce({
    outputPath: "/out.png",
    layerCount: 1,
    maskHash: "mask",
    verification: {
      ok: true,
      canvasOk: true,
      layerCountOk: true,
      expectedLayers: 1,
      actualLayers: 1,
      layers: [{
        name: "color_to_line", nameOk: true,
        pixelChecked: true, pixelOk: true,
      }],
    },
  });
  render(<ExportDialog {...makeProps({ preset: imageLinePreset as any })} />);
  fireEvent.click(screen.getByRole("button", { name: "내보내기" }));
  await waitFor(() => expect(screen.getByText("검증 통과")).toBeTruthy());
});
