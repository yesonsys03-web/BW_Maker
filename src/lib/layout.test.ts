import { expect, test } from "vitest";
import {
  DEFAULT_TREE_PANEL_WIDTH,
  TREE_PANEL_MAX_WIDTH,
  TREE_PANEL_MIN_WIDTH,
  clampTreePanelWidth,
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
