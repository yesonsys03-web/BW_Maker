import { expect, test } from "vitest";
import {
  BOTTOM_PANEL_MIN_HEIGHT,
  DEFAULT_BOTTOM_PANEL_HEIGHT,
  DEFAULT_FILE_PANEL_WIDTH,
  DEFAULT_TREE_PANEL_WIDTH,
  FILE_PANEL_MAX_WIDTH,
  FILE_PANEL_MIN_WIDTH,
  TREE_PANEL_MAX_WIDTH,
  TREE_PANEL_MIN_WIDTH,
  clampBottomPanelHeight,
  clampFilePanelWidth,
  clampTreePanelWidth,
  parseBottomPanelHeight,
  parseFilePanelWidth,
  parseTreePanelWidth,
} from "./layout";

test("clampTreePanelWidth keeps a width that is already in range", () => {
  expect(clampTreePanelWidth(500)).toBe(500);
});

test("clampTreePanelWidth pins a too-narrow drag to the minimum", () => {
  expect(clampTreePanelWidth(10)).toBe(TREE_PANEL_MIN_WIDTH);
});

test("clampTreePanelWidth pins a too-wide drag to the maximum", () => {
  expect(clampTreePanelWidth(5000)).toBe(TREE_PANEL_MAX_WIDTH);
});

test("clampTreePanelWidth rounds fractional pointer positions", () => {
  expect(clampTreePanelWidth(420.6)).toBe(421);
});

test("clampTreePanelWidth leaves room for the file panel and preview", () => {
  // 1200px 창: 240(파일) + 560 예약분을 빼면 레이어 패널은 640까지.
  expect(clampTreePanelWidth(900, 1200)).toBe(640);
});

test("clampTreePanelWidth still yields the minimum on a very narrow window", () => {
  // 창이 예약분보다 좁아도 패널이 0으로 접히지는 않는다.
  expect(clampTreePanelWidth(900, 400)).toBe(TREE_PANEL_MIN_WIDTH);
});

test("clampTreePanelWidth falls back to the default for a non-finite width", () => {
  expect(clampTreePanelWidth(Number.NaN)).toBe(DEFAULT_TREE_PANEL_WIDTH);
});

test("parseTreePanelWidth returns the default when nothing is stored yet", () => {
  expect(parseTreePanelWidth(null)).toBe(DEFAULT_TREE_PANEL_WIDTH);
  expect(parseTreePanelWidth("")).toBe(DEFAULT_TREE_PANEL_WIDTH);
});

test("parseTreePanelWidth returns the default for a non-numeric stored value", () => {
  expect(parseTreePanelWidth("wide")).toBe(DEFAULT_TREE_PANEL_WIDTH);
});

test("parseTreePanelWidth clamps a stored value from an older/wider setup", () => {
  expect(parseTreePanelWidth("5000")).toBe(TREE_PANEL_MAX_WIDTH);
  expect(parseTreePanelWidth("12")).toBe(TREE_PANEL_MIN_WIDTH);
});

test("parseTreePanelWidth round-trips a normal stored width", () => {
  expect(parseTreePanelWidth("480")).toBe(480);
});

// --- 아래 패널 높이 ---
// 히스토리 한 줄이 그룹 병합에서 소스 수십 장을 나열해 네 줄로 접혔고, 160px
// 고정에서는 항목 두 개도 안 들어왔다. 문구를 줄이는 것과 별개로, 얼마나 볼지는
// 사람마다 다르므로 레이어 패널 폭과 같이 끌어서 맞춘다.

test("clampBottomPanelHeight keeps a height that is already sensible", () => {
  expect(clampBottomPanelHeight(300)).toBe(300);
});

test("clampBottomPanelHeight will not let the panel swallow the workspace", () => {
  // 창 높이가 주어지면 위쪽(프리셋바·툴바·작업 영역)이 남을 만큼만 내준다.
  expect(clampBottomPanelHeight(900, 1000)).toBeLessThan(900);
  expect(clampBottomPanelHeight(900, 1000)).toBeGreaterThanOrEqual(BOTTOM_PANEL_MIN_HEIGHT);
});

test("clampBottomPanelHeight floors at the minimum rather than collapsing", () => {
  expect(clampBottomPanelHeight(10)).toBe(BOTTOM_PANEL_MIN_HEIGHT);
});

test("clampBottomPanelHeight on a very short window still leaves the panel usable", () => {
  // 최소 높이가 이긴다 — 패널이 0이 되는 것보다는 낫다.
  expect(clampBottomPanelHeight(400, 300)).toBe(BOTTOM_PANEL_MIN_HEIGHT);
});

test("clampBottomPanelHeight rejects a non-number rather than producing NaN", () => {
  expect(clampBottomPanelHeight(Number.NaN)).toBe(DEFAULT_BOTTOM_PANEL_HEIGHT);
});

test("parseBottomPanelHeight falls back on a first run and on junk", () => {
  expect(parseBottomPanelHeight(null)).toBe(DEFAULT_BOTTOM_PANEL_HEIGHT);
  expect(parseBottomPanelHeight("")).toBe(DEFAULT_BOTTOM_PANEL_HEIGHT);
  expect(parseBottomPanelHeight("높이")).toBe(DEFAULT_BOTTOM_PANEL_HEIGHT);
});

test("parseBottomPanelHeight clamps what was stored, not just what was typed", () => {
  expect(parseBottomPanelHeight("5")).toBe(BOTTOM_PANEL_MIN_HEIGHT);
});

// --- 파일 패널 폭 ---
// 240px 고정이었다. 파일명이 `HH03_BG-HLobbyINTBackLeftCorner015_CO_v01.psd`처럼
// 길어 어차피 잘렸는데, 행에 장수까지 붙으면서 남는 폭이 더 줄었다.

test("clampFilePanelWidth keeps a width that is already sensible", () => {
  expect(clampFilePanelWidth(320)).toBe(320);
});

test("clampFilePanelWidth will not let the file panel crowd out the preview", () => {
  expect(clampFilePanelWidth(900, 1200)).toBeLessThan(900);
  expect(clampFilePanelWidth(900, 1200)).toBeGreaterThanOrEqual(FILE_PANEL_MIN_WIDTH);
});

test("clampFilePanelWidth floors at the minimum rather than collapsing", () => {
  expect(clampFilePanelWidth(40)).toBe(FILE_PANEL_MIN_WIDTH);
});

test("clampFilePanelWidth on a narrow window still leaves the panel usable", () => {
  expect(clampFilePanelWidth(400, 500)).toBe(FILE_PANEL_MIN_WIDTH);
});

test("parseFilePanelWidth falls back on a first run and on junk", () => {
  expect(parseFilePanelWidth(null)).toBe(DEFAULT_FILE_PANEL_WIDTH);
  expect(parseFilePanelWidth("폭")).toBe(DEFAULT_FILE_PANEL_WIDTH);
});

test("parseFilePanelWidth clamps what was stored", () => {
  expect(parseFilePanelWidth("9999")).toBeLessThanOrEqual(FILE_PANEL_MAX_WIDTH);
});
