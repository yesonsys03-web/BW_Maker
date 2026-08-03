import { expect, test } from "vitest";
import { hasAnyToken, tokenMatch, tokenize } from "./layerNames";

// engine/tests/test_names.py와 같은 표본이다 — 두 구현이 갈라지면 프리셋 적용
// 전후로 "라인만" 목록이 달라진다.
test("splits on separators, case boundaries and digits", () => {
  expect(tokenize("Wall_Line")).toEqual(["Wall", "Line"]);
  expect(tokenize("CurtainsLine")).toEqual(["Curtains", "Line"]);
  expect(tokenize("line2")).toEqual(["line", "2"]);
  expect(tokenize("CHAIR1_LINE")).toEqual(["CHAIR", "1", "LINE"]);
  expect(tokenize("Layer 866 (LINEAR DODGE)")).toEqual(["Layer", "866", "LINEAR", "DODGE"]);
  expect(tokenize("TopWindowArches_line")).toEqual(["Top", "Window", "Arches", "line"]);
  expect(tokenize("*ART")).toEqual(["ART"]);
  expect(tokenize("라인")).toEqual([]);
});

test("line matches as a word, not as a substring", () => {
  for (const name of ["line", "LINE", "LINES", "hidden line", "Wall_Line",
                      "CurtainsLine", "line2", "Wall_OL_Line"]) {
    expect(tokenMatch(name, "line"), name).toBe(true);
  }
  for (const name of ["Layer 866 (LINEAR DODGE)", "Linear Light", "kline col", "OUTLINE"]) {
    expect(tokenMatch(name, "line"), name).toBe(false);
  }
});

test("a case-sensitive search still accepts the plural", () => {
  expect(tokenMatch("LINES", "LINE", true)).toBe(true);
  expect(tokenMatch("lines", "LINE", true)).toBe(false);
});

test("a multi-token value must appear consecutively", () => {
  expect(tokenMatch("BROKEN WALL LINE", "wall line")).toBe(true);
  expect(tokenMatch("WALL fill LINE", "wall line")).toBe(false);
});

test("hasAnyToken finds the colour vocabulary", () => {
  expect(hasAnyToken("line col", ["col", "colour", "color"])).toBe(true);
  expect(hasAnyToken("Line Colour", ["col", "colour", "color"])).toBe(true);
  expect(hasAnyToken("COUCH LINE", ["col", "colour", "color"])).toBe(false);
});
