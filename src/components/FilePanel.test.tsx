// @vitest-environment jsdom
/**
 * 규칙이 라인을 하나도 못 잡은 파일은 목록에서 바로 보여야 한다.
 *
 * 그 자리를 찾느라 파일을 한 장씩 열어보는 것이 오래 걸린다고 아티스트가 지목한
 * 작업이다(2026-08-10). 표시는 "열림" 옆의 `라인필요` 배지와 행 하이라이트 둘.
 *
 * 조건은 **내보낼 장수 0**이지 "미리보기가 비었나"가 아니다 — 눈을 다 꺼둔
 * 파일도 미리보기는 비는데, 그건 아티스트가 일부러 한 것이라 "라인필요"라고
 * 말하면 거짓말이 된다. entryCounts는 프리셋이 걸린 파일만 담으므로, 아직 안
 * 걸린 파일에는 아무 표시도 안 붙는다.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));

import { FilePanel } from "./FilePanel";
import type { FileEntry } from "../state/appStore";

afterEach(cleanup);

function fileAt(path: string): FileEntry {
  return { path, status: "open", sessionId: 1, mtime: 1, presetApplied: true } as FileEntry;
}

function renderPanel(
  files: FileEntry[],
  entryCounts: Record<string, number>,
  staleProjectPaths: string[] = [],
  onApplyLineSuggestions = vi.fn(),
) {
  // 막대의 수는 배지와 같은 조건(내보낼 장수 0)으로 App이 세서 내려준다.
  const needsLineCount = files.filter((f) => entryCounts[f.path] === 0).length;
  return render(
    <FilePanel
      files={files}
      activePath={null}
      loadProgress={null}
      prefetchProgress={null}
      warmProgress={null}
      fullCacheRunning={false}
      onFullCacheStart={vi.fn()}
      onFullCacheStop={vi.fn()}
      cacheWorkers={1}
      onCacheWorkersChange={vi.fn()}
      stopped={null}
      entryCounts={entryCounts}
      needsLineCount={needsLineCount}
      onApplyLineSuggestions={onApplyLineSuggestions}
      staleProjectPaths={staleProjectPaths}
      onResizeStart={vi.fn()}
      onResizeMove={vi.fn()}
      onResizeEnd={vi.fn()}
      onResizeReset={vi.fn()}
      onAddFiles={vi.fn()}
      onSelectFile={vi.fn()}
      onRemoveFile={vi.fn()}
      onClearFiles={vi.fn()}
      onCancelLoad={vi.fn()}
      onResume={vi.fn()}
      onError={vi.fn()}
    />
  );
}

function rowOf(name: string) {
  const row = screen
    .getAllByRole("button")
    .find((b) => b.classList.contains("file-list-item") && b.textContent?.includes(name));
  if (!row) throw new Error(`파일 행을 찾지 못했다: ${name}`);
  return row;
}

test("a file the rules found no line in is badged and highlighted", () => {
  renderPanel(
    [fileAt("/cuts/none.psd"), fileAt("/cuts/some.psd")],
    { "/cuts/none.psd": 0, "/cuts/some.psd": 12 }
  );

  expect(screen.getByText("라인필요")).toBeTruthy();
  expect(rowOf("none.psd").classList.contains("needs-line")).toBe(true);
  expect(rowOf("some.psd").classList.contains("needs-line")).toBe(false);
});

test("the badge replaces the sheet count rather than sitting beside it", () => {
  renderPanel([fileAt("/cuts/none.psd")], { "/cuts/none.psd": 0 });

  expect(screen.getByText("라인필요")).toBeTruthy();
  // "0장"까지 같이 뜨면 같은 말을 두 번 하는 셈이다.
  expect(screen.queryByText("0장")).toBeNull();
});

/**
 * 프로젝트를 열 때 수정시각이 달라 작업을 버린 파일. 조용히 버리면 아티스트는
 * 자기가 한 지정이 왜 없는지 알 수 없다(설계 4절).
 */
test("a file whose PSD changed since the project was saved says so", () => {
  renderPanel(
    [fileAt("/cuts/moved.psd"), fileAt("/cuts/kept.psd")],
    { "/cuts/moved.psd": 3, "/cuts/kept.psd": 3 },
    ["/cuts/moved.psd"]
  );

  expect(screen.getByText("파일이 바뀜")).toBeTruthy();
  expect(rowOf("moved.psd").classList.contains("stale")).toBe(true);
  expect(rowOf("kept.psd").classList.contains("stale")).toBe(false);
});

test("a file with no preset applied yet is not called out", () => {
  // entryCounts에 아예 없는 파일. 여는 동안 전부 "라인필요"로 깜빡이면 안 된다.
  renderPanel([fileAt("/cuts/pending.psd")], {});

  expect(screen.queryByText("라인필요")).toBeNull();
  expect(rowOf("pending.psd").classList.contains("needs-line")).toBe(false);
});

/**
 * "라인필요" 파일이 있으면 목록 위에 일괄 지정 막대가 뜬다. 군중 판은 파일마다
 * 열어 손으로 지정하는 것이 오래 걸린다고 지목된 작업이라, 목록 단위 버튼이
 * 이 기능의 핵심이다(규칙은 lib/suggestLines.ts).
 */
test("files needing lines get a bulk-apply bar; the button calls the handler", () => {
  const onApply = vi.fn();
  renderPanel(
    [fileAt("/cuts/crowd1.psd"), fileAt("/cuts/crowd2.psd"), fileAt("/cuts/ok.psd")],
    { "/cuts/crowd1.psd": 0, "/cuts/crowd2.psd": 0, "/cuts/ok.psd": 5 },
    [],
    onApply,
  );

  expect(screen.getByText("라인필요 2개")).toBeTruthy();
  screen.getByText("후보 일괄 지정").click();
  expect(onApply).toHaveBeenCalledTimes(1);
});

test("the bulk-apply bar stays hidden while nothing needs a line", () => {
  renderPanel([fileAt("/cuts/ok.psd")], { "/cuts/ok.psd": 5 });

  expect(screen.queryByText("후보 일괄 지정")).toBeNull();
});
