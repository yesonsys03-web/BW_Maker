import { expect, test } from "vitest";
import { BG_PRESET, CHAR_PRESET } from "./presets";
import {
  drawnLineCandidateIds,
  judgeDrawnLines,
  judgeStoredFeatures,
  preparedIncludedIds,
  COVERAGE_MAX,
  MIN_NATIVE_PX,
  SURVIVE2_MAX,
} from "./detectDrawnLines";
import type { TreeNode } from "./types";

function leaf(id: number, name: string, over: Partial<TreeNode> = {}): TreeNode {
  return {
    id, name, kind: "pixel", visible: true, blendMode: "normal", opacity: 255,
    bbox: [0, 0, 10, 10], hasMask: false, hasPixels: true, path: [name], ...over,
  } as TreeNode;
}

function group(id: number, name: string, children: TreeNode[]): TreeNode {
  return {
    id, name, kind: "group", visible: true, blendMode: "normal", opacity: 255,
    bbox: [0, 0, 10, 10], hasMask: false, path: [name], children,
  } as TreeNode;
}

test("candidates are the unmatched drawable leaves the name rules leave alone", () => {
  const tree: TreeNode[] = [
    leaf(1, "ROPE DETAILS"),                 // 신고 사례 — 후보
    leaf(2, "LINE"),                          // 매칭됨 — 잴 필요 없음
    leaf(3, "shading", { blendMode: "multiply" }), // 라인은 전부 normal이었다
    leaf(4, "notes", { kind: "type" }),
    leaf(5, "skin col"),                      // 프리셋 제외 토큰(색 지정 이름)
    leaf(6, "halo glow"),                     // 발광 — suggestLines 어휘
    group(10, "HEIGHTS chart", [leaf(11, "measure")]), // CHAR 제외 접두사
    group(12, "REFS", [leaf(13, "photo")]),   // 참고자료 그룹
    group(14, "body", [leaf(15, "shirt details")]),
  ];
  expect(drawnLineCandidateIds(tree, [2], CHAR_PRESET)).toEqual([1, 15]);
});

test("the strict band passes rope-detail numbers and rejects the borderline ones", () => {
  // 수치는 전부 실측에서 가져온 것: 로프류 s2≈0/면적 1~2%, 벽지 패턴
  // 0.29/0.16, 몰딩 띠 0.31/0.46, 채움 0.9+, 부스러기는 픽셀 수가 작다.
  const picked = judgeDrawnLines({
    "1": { survive2: 0.01, survive1: 0.05, coverage: 0.02, nNative: 120000 },
    "2": { survive2: 0.29, survive1: 0.5, coverage: 0.161, nNative: 1936000 },
    "3": { survive2: 0.31, survive1: 0.6, coverage: 0.456, nNative: 1303000 },
    "4": { survive2: 0.92, survive1: 0.96, coverage: 0.77, nNative: 500000 },
    "5": { survive2: 0.0, survive1: 0.0, coverage: 0.01, nNative: 900 },
    "6": null,
  });
  expect(picked).toEqual([1]);
});

test("the band edges are exclusive where the borderline cases live", () => {
  expect(judgeDrawnLines({
    "1": { survive2: SURVIVE2_MAX, survive1: 0, coverage: 0.01, nNative: MIN_NATIVE_PX },
  })).toEqual([]);
  expect(judgeDrawnLines({
    "1": { survive2: 0, survive1: 0, coverage: COVERAGE_MAX, nNative: MIN_NATIVE_PX },
  })).toEqual([]);
  expect(judgeDrawnLines({
    "1": { survive2: 0, survive1: 0, coverage: 0.01, nNative: MIN_NATIVE_PX - 1 },
  })).toEqual([]);
});

test("BG presets exclude their own group prefixes from candidates", () => {
  const tree: TreeNode[] = [group(1, "-LayOut", [leaf(2, "sketchy")]), leaf(3, "wires")];
  expect(drawnLineCandidateIds(tree, [], BG_PRESET)).toEqual([3]);
});


test("judgeStoredFeatures picks only this preset's candidates from a whole-file map", () => {
  // 스윕 사이드카는 "모든 잎"의 특징을 담는다 — 매칭된 라인(id 2)이나 제외
  // 어휘 잎(id 3)의 특징이 아무리 선다워도 판단 대상이 아니어야 한다.
  const tree: TreeNode[] = [leaf(1, "ROPE DETAILS"), leaf(2, "LINE"), leaf(3, "halo glow")];
  const features = {
    "1": { survive2: 0.01, survive1: 0.05, coverage: 0.02, nNative: 120000 },
    "2": { survive2: 0.0, survive1: 0.0, coverage: 0.01, nNative: 999999 },
    "3": { survive2: 0.0, survive1: 0.0, coverage: 0.01, nNative: 999999 },
  };
  expect(judgeStoredFeatures(tree, [2], CHAR_PRESET, features)).toEqual([1]);
});

test("the prepared-preview include list is the picture the worker actually baked", () => {
  // 워커의 _preset_preview_args는 매칭 ∪ 검출로 굽는다. 앱이 그 그림에 붙이는
  // 캐시 키를 매칭만으로 만들면, 키는 "검출 없는 화면"이라 말하는데 그림에는
  // 검출된 잎이 들어 있다 — 해제한 잎이 화면에 남는 필드가이드 신고의 원인이다.
  const tree: TreeNode[] = [leaf(1, "ROPE DETAILS"), leaf(2, "LINE")];
  const features = {
    "1": { survive2: 0.01, survive1: 0.05, coverage: 0.02, nNative: 120000 },
  };
  expect(preparedIncludedIds(tree, [2], CHAR_PRESET, features)).toEqual([1, 2]);
  // 스윕 안 한 폴더는 워커도 매칭만으로 굽는다 — 그때는 매칭만이 맞다.
  expect(preparedIncludedIds(tree, [2], CHAR_PRESET, null)).toEqual([2]);
