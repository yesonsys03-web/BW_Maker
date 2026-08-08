import { expect, test } from "vitest";
import { summarizeNames } from "./opsLabel";

test("a short list is spelled out — that is the useful form", () => {
  expect(summarizeNames(["line", "lines"])).toBe("line, lines");
  expect(summarizeNames(["a", "b", "c"])).toBe("a, b, c");
});

test("a long list gives kinds and a count instead of a wall of names", () => {
  // 실제로 나온 모양이다. 그룹 병합의 소스가 수십 장이라 히스토리 한 줄이
  // 패널을 네 줄로 가로질렀다.
  const names = [...Array(8).fill("LINES"), "wall line", "line", "line", "line"];
  expect(summarizeNames(names)).toBe("LINES, wall line, line 등 12장");
});

test("repeats collapse — listing the same name eight times says nothing", () => {
  expect(summarizeNames(Array(8).fill("LINES"))).toBe("LINES 등 8장");
});

test("the count is every layer, not just the ones named", () => {
  // "등 12장"의 12는 병합에 들어간 전체 장수다. 앞의 세 이름을 뺀 나머지가
  // 아니다 — 그렇게 읽히면 합계를 잘못 세게 된다.
  const names = [...Array(9).fill("A"), "B", "C", "D"];
  expect(summarizeNames(names)).toBe("A, B, C 등 12장");
});

test("four distinct names already earn the short form", () => {
  expect(summarizeNames(["a", "b", "c", "d"])).toBe("a, b, c 등 4장");
});

test("an empty list has nothing to say", () => {
  expect(summarizeNames([])).toBe("");
});
