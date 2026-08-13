/**
 * "라인필요" 파일의 라인 후보 규칙. 표본은 실제 군중 판의 구조를 줄인 것이다 —
 * HH0307 CH의 0매칭 판은 CROWD(BACK·MID·FG) 아래 content 이름 잎(character,
 * detail, 01…)과 REFS/BORDERS/LABELS/Paper 참고 그룹으로 되어 있고, 획 선화는
 * 한 장도 없다(2026-08-13 콘택트시트 전수 확인). 후보는 "그림인 잎 전부"여야
 * 한다 — 실루엣도 납품 대상이다.
 */
import { expect, test } from "vitest";
import { suggestLineLayers } from "./suggestLines";
import type { Preset, TreeNode } from "./types";

let nextId = 0;

function leaf(name: string, extra: Partial<TreeNode> = {}): TreeNode {
  return {
    id: nextId++, name, kind: "pixel", visible: true, blendMode: "normal",
    opacity: 255, bbox: [0, 0, 10, 10], hasMask: false, hasPixels: true,
    path: [name], ...extra,
  };
}

function group(name: string, children: TreeNode[]): TreeNode {
  return {
    id: nextId++, name, kind: "group", visible: true, blendMode: "normal",
    opacity: 255, bbox: [0, 0, 10, 10], hasMask: false, path: [name], children,
  };
}

// CHAR 프리셋에서 규칙이 실제로 읽는 부분만 담는다. presets.ts를 통째로
// 들여오면 tauri 경로 모듈까지 모킹해야 해서 표본이 규칙보다 커진다.
const preset = {
  excludeGroupPrefixes: ["-", "HEIGHTS", "TEMPLATE", "COLOR PALETTE"],
} as Preset;

test("군중 판의 그림 잎은 실루엣이어도 전부 후보다", () => {
  const character = leaf("character");
  const detail = leaf("detail");
  const numbered = leaf("01");
  const tree = [group("CROWD", [group("BACK", [character, detail]), group("FG", [numbered])])];
  expect(suggestLineLayers(tree, preset)).toEqual([character.id, detail.id, numbered.id]);
});

test("참고 그룹(REFS·BORDERS·LABELS·Paper)은 대소문자와 무관하게 통째로 빠진다", () => {
  const art = leaf("crowd back");
  const tree = [
    group("REFS", [leaf("placement")]),
    group("Borders", [leaf("frame")]),
    group("labels", [leaf("skin")]),
    group("Paper", [leaf("texture")]),
    art,
  ];
  expect(suggestLineLayers(tree, preset)).toEqual([art.id]);
});

test("프리셋의 제외 그룹 접두사(HEIGHTS, COLOR PALETTE, -)도 매칭과 같이 빠진다", () => {
  const art = leaf("mob");
  const tree = [
    group("HEIGHTS", [leaf("CHARACTER HEIGHT")]),
    group("COLOR PALETTE 2", [leaf("swatches")]),
    group("-BGCU", [leaf("closeup")]),
    art,
  ];
  expect(suggestLineLayers(tree, preset)).toEqual([art.id]);
});

test("발광·장식 토큰은 잎 이름에서도 그룹 이름에서도 걸러진다", () => {
  const art = leaf("ruff");
  const tree = [
    leaf("halo glow"),
    leaf("sign board"),
    leaf("BOX"),
    leaf("shadow behind"),
    // 참고 이미지를 그룹 없이 잎으로 든 판이 실제로 있다(HH0307 파일 38).
    leaf("REF"),
    // 그룹 이름에만 표식이 있는 발광 — 잎 이름만 보면 딸려 들어온 전례(19장).
    group("halo glow", [leaf("inner"), leaf("outer")]),
    art,
  ];
  expect(suggestLineLayers(tree, preset)).toEqual([art.id]);
});

test("그릴 수 없는 잎은 후보가 아니다 — 글자, 픽셀 없는 잎", () => {
  const art = leaf("eyes");
  const tree = [
    leaf("note", { kind: "type" }),
    leaf("empty shell", { hasPixels: false }),
    art,
  ];
  expect(suggestLineLayers(tree, preset)).toEqual([art.id]);
});

test("hasPixels가 없는 옛 트리는 pixel 잎을 그대로 통과시킨다", () => {
  const old = leaf("character");
  delete old.hasPixels;
  expect(suggestLineLayers([old], preset)).toEqual([old.id]);
});
