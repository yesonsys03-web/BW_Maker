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
import { exportPsd } from "../lib/engine";
import type { OpsState } from "../lib/opsReducer";
import type { TreeNode } from "../lib/types";

vi.mock("@tauri-apps/plugin-dialog", () => ({ save: vi.fn(), open: vi.fn() }));
vi.mock("../lib/engine", () => ({
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
