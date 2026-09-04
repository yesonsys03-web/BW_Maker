import { expect, test } from "vitest";
import { describeScan } from "./fileScan";
import type { PsdScan } from "./engine";

function scan(patch: Partial<PsdScan> = {}): PsdScan {
  return { files: ["/a/1.psd", "/a/2.psd"], truncated: false, skippedDirs: 0, ...patch };
}

test("a clean scan says nothing — the file list already shows it", () => {
  expect(describeScan(scan(), 0)).toBeNull();
});

test("an empty result is reported instead of looking like a no-op", () => {
  expect(describeScan(scan({ files: [] }), 0)).toBe("PSD 파일을 찾지 못했습니다.");
});

test("a truncated walk reports how many it actually kept", () => {
  const notice = describeScan(scan({ truncated: true }), 0);
  expect(notice).toContain("2개까지만");
});

test("duplicates explain why the list barely grew", () => {
  expect(describeScan(scan(), 2)).toBe("2개는 이미 목록에 있습니다.");
});

test("unreadable folders are reported even when files were found", () => {
  expect(describeScan(scan({ skippedDirs: 3 }), 0)).toBe("열 수 없는 폴더 3개는 건너뛰었습니다.");
});

test("an empty result caused by unreadable folders reports both", () => {
  const notice = describeScan(scan({ files: [], skippedDirs: 1 }), 0);
  expect(notice).toBe("PSD 파일을 찾지 못했습니다. 열 수 없는 폴더 1개는 건너뛰었습니다.");
});

test("an empty result never claims duplicates", () => {
  expect(describeScan(scan({ files: [] }), 0)).not.toContain("이미 목록에");
});
