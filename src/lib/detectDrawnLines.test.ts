import { expect, test } from "vitest";
import { BG_PRESET, CHAR_PRESET } from "./presets";
import {
  drawnLineCandidateIds,
  judgeDrawnLines,
  judgeStoredFeatures,
  preparedIncludedIds,
  rejectedLineIds,
  rejectedLineIdsByPath,
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
});

test("fieldguide annotations are not drawn-line candidates, however they are spelled", () => {
  // 신고된 경로 그대로: 빨간 주석 획은 굵기로는 영락없는 선이라 문턱으로는
  // 못 막는다 — 어휘가 유일한 문이다(suggestLines의 SUGGEST_EXCLUDE_TOKENS).
  const tree: TreeNode[] = [
    group(10, "*FIELDGUIDES", [leaf(11, "FLGD"), leaf(12, "notes")]),
    leaf(13, "FLGD"),
    leaf(14, "Wall_Line detail"),
  ];
  expect(drawnLineCandidateIds(tree, [], CHAR_PRESET)).toEqual([14]);
});

test("annotation notes are not drawn-line candidates, group name or leaf name", () => {
  // CH 74판 전수 실측(2026-08-21): 확실 구간을 통과한 잎이 5장뿐인데 그중 셋이
  // 주석 지시 화살표였다 — `POSES/NOTES/ARROWS`(9316x1083), `EXTRA NOTES/BODY/
  // arrows`(13633x1723), `Extra notes/BODY/arrows`. 판을 가로지르는 화살표라
  // 굵기로는 완벽한 선(s2 0.00~0.09)이고, 필드가이드와 같은 부류다.
  //
  // 그룹 이름이 문이다: `EXTRA NOTES`는 토큰 둘로 쪼개져 `notes`가 받는다.
  // 같은 그룹 아래 이름에 line이 있는 진짜 도해(CH 81장, `Extra notes/BODY/
  // GLASSES/line` 등)는 **매칭**이 내보내므로 여기서 빠져도 출고에 영향이 없다.
  const tree: TreeNode[] = [
    group(10, "POSES", [group(11, "NOTES", [leaf(12, "ARROWS")])]),
    group(13, "EXTRA NOTES", [group(14, "BODY", [leaf(15, "arrows")])]),
    leaf(16, "notes"),
    group(17, "TURN", [group(18, "LINES", [leaf(19, "boa")])]), // 진짜 그림 — 남는다
  ];
  expect(drawnLineCandidateIds(tree, [], CHAR_PRESET)).toEqual([19]);
});

test("unchecking a preset-matched line is a rejection the batch must honour too", () => {
  // 2026-08-21 신고(PROP 판): `PROP/cigar lit/Color/red line`을 라인만 화면에서
  // 껐는데 배치 산출물에 그대로 나왔다. 첫 구현이 **검출된 잎만** 뺐기 때문이다 —
  // 이름으로 매칭된 잎(red line)과 손으로 지정한 잎은 실을 칸이 아예 없었다.
  //
  // 배치는 파일마다 프리셋을 다시 돌리고 수동 지정을 다시 더하므로, 되살아나는
  // 문이 셋이다: 매칭 · 검출 · 수동 지정. 뺄셈의 왼쪽은 그 셋의 합집합이어야 한다.
  // 화면 내보내기는 includedIds를 그대로 보내 처음부터 옳았다(ExportDialog) —
  // 갈라진 쪽은 배치뿐이다.
  expect(rejectedLineIds([1, 2], undefined, undefined, [2])).toEqual([1]);
  expect(rejectedLineIds(undefined, undefined, [7], [])).toEqual([7]);
  // 셋이 섞여도 지금 체크된 것만 남는다.
  expect(rejectedLineIds([1, 2], [3], [4], [2, 3])).toEqual([1, 4]);
  // 전부 켜져 있으면 거절은 없다.
  expect(rejectedLineIds([1, 2], [3], [4], [1, 2, 3, 4])).toEqual([]);
  // 기록이 하나도 없는 파일은 뺄 근거가 없다 — "전부 거절"이 아니다.
  expect(rejectedLineIds(undefined, undefined, undefined, [5])).toEqual([]);
});

test("the batch rejection map is built from all three revival sources, per file", () => {
  // 인자가 넷 다 number[]라 순서를 바꿔 넣어도 타입이 통과한다 — 그 실수를 여기서
  // 잠근다. 조립을 App의 useMemo 안에 두면 이 잠금이 App.test로만 가능한데,
  // 그 스위트는 시간에 민감해서 판정이 흔들린다(2026-08-21 실측).
  const map = rejectedLineIdsByPath(
    {
      // 매칭 2장 중 하나를 껐다 — 신고된 `red line`의 모양이다.
      "/a.psd": { includedIds: [2], manualLineIds: [] },
      // 손으로 지정했다가 체크를 껐다. 지정 해제와 체크 해제는 서로를 안 건드리므로
      // 이 상태가 실제로 생긴다(opsReducer).
      "/b.psd": { includedIds: [], manualLineIds: [7] },
      // 전부 켜져 있다 — 거절 없음, 맵에 담기지 않는다.
      "/c.psd": { includedIds: [1, 3], manualLineIds: [] },
      // 프리셋을 아직 안 건 파일: 세 근거가 다 없으니 뺄 근거도 없다.
      "/d.psd": { includedIds: [9], manualLineIds: [] },
    },
    { "/a.psd": [1, 2], "/c.psd": [1] },
    { "/c.psd": [3] },
  );
  expect(map).toEqual({ "/a.psd": [1], "/b.psd": [7] });
});
