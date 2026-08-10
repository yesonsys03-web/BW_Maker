import { expect, test } from "vitest";
import { hasAnyToken, includeTerms, tokenMatch, tokenMatchAny, tokenize } from "./layerNames";

/**
 * engine/tests/test_names.py와 글자 그대로 짝을 이루는 거울이다.
 *
 * 두 언어의 정규식 엔진이 갈라지는 지점을 잡아내는 것이 이 테스트 쌍의 유일한
 * 역할이다 — 표본을 한쪽에 추가하면 반드시 다른 쪽에도 추가한다.
 */

test("splits on separators, case boundaries and digits", () => {
  expect(tokenize("Wall_Line")).toEqual(["Wall", "Line"]);
  expect(tokenize("CurtainsLine")).toEqual(["Curtains", "Line"]);
  expect(tokenize("line2")).toEqual(["line", "2"]);
  expect(tokenize("CHAIR1_LINE")).toEqual(["CHAIR", "1", "LINE"]);
  expect(tokenize("Layer 866 (LINEAR DODGE)")).toEqual(["Layer", "866", "LINEAR", "DODGE"]);
  expect(tokenize("TopWindowArches_line")).toEqual(["Top", "Window", "Arches", "line"]);
  expect(tokenize("GRAIN_OVERLAY copy")).toEqual(["GRAIN", "OVERLAY", "copy"]);
  expect(tokenize("*ART")).toEqual(["ART"]);
});

test("a name with no ascii letters has no tokens", () => {
  // 한글만 있는 이름. 호출자는 이 경우 부분 문자열로 되돌아간다.
  expect(tokenize("라인")).toEqual([]);
});

// 실제 납품 파일에서 온 이름들이다(설계 문서 2절).
test("line matches as a word, not as a substring", () => {
  for (const name of ["line", "LINE", "LINES", "lines", "hidden line", "line ol",
                      "Wall_Line", "Ring_Line", "CurtainsLine", "line2",
                      "TopWindowArches_line", "Wall_OL_Line", "BROKEN WALL LINE"]) {
    expect(tokenMatch(name, "line"), name).toBe(true);
  }
  for (const name of ["Layer 866 (LINEAR DODGE)", "Linear Light", "Linear dodge 75% ",
                      "kline col", "OUTLINE"]) {
    expect(tokenMatch(name, "line"), name).toBe(false);
  }
});

test("a case-sensitive search still accepts the plural", () => {
  // 'LINE'을 대소문자까지 지켜 찾더라도 'LINES'가 빠지면 규칙이 쓸모없다.
  expect(tokenMatch("LINES", "LINE", true)).toBe(true);
  expect(tokenMatch("lines", "LINE", true)).toBe(false);
});

test("a multi-token value must appear consecutively", () => {
  expect(tokenMatch("BROKEN WALL LINE", "wall line")).toBe(true);
  expect(tokenMatch("WALL fill LINE", "wall line")).toBe(false);
});

test("hasAnyToken finds the colour vocabulary", () => {
  const colour = ["col", "colour", "color"];
  for (const name of ["line col", "LINE_COL", "Line Colour", "line colour", "Wall_Line_Col",
                      "Wall_Cols"]) {  // 복수형 허용이 hasAnyToken에도 걸리는지 확인한다
    expect(hasAnyToken(name, colour), name).toBe(true);
  }
  for (const name of ["COUCH LINE", "line", "Bookcase_Line"]) {
    expect(hasAnyToken(name, colour), name).toBe(false);
  }
});

test("쉼표 목록 중 하나라도 걸리면 통과한다 — 엔진 include_terms와 같은 규칙", () => {
  // 'lineart'는 토큰 하나라 'line'으로는 안 걸린다. 어휘를 늘려 잡되,
  // 'LINEAR DODGE'는 계속 빠져야 한다 — 토큰 규칙이 원래 막던 것이다.
  expect(tokenMatchAny("lineart - ", "line, lineart")).toBe(true);
  expect(tokenMatchAny("LINES", "line, lineart")).toBe(true);
  expect(tokenMatchAny("LINEAR DODGE", "line, lineart")).toBe(false);
  expect(tokenMatchAny("lineless note", "line, lineart")).toBe(false);
  // 쉼표가 없으면 단일 어휘와 같다
  expect(tokenMatchAny("lineart - ", "line")).toBe(false);
  expect(includeTerms(" line ,, lineart , ")).toEqual(["line", "lineart"]);
});
