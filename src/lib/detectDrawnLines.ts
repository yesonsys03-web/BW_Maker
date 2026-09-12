import { hasAnyToken } from "./layerNames";
import { SUGGEST_EXCLUDE_GROUPS, SUGGEST_EXCLUDE_TOKENS } from "./suggestLines";
import type { DrawnLinesPolicy, StrokeFeatures } from "./engine";
import type { Preset, TreeNode } from "./types";

/**
 * "이름은 라인이 아닌데 그림은 선인" 드로잉 레이어의 검출(2026-08-19 아티스트
 * 결정). 신고 사례: 캐릭터 판의 ROPE DETAILS — 로프 빗금 획인데 이름에 line이
 * 없어 매칭이 놓친다. 어휘를 늘리는 것(rope…)은 다음 판에서 다른 이름으로 또
 * 뚫리는 두더지잡기라, 이름 대신 픽셀 굵기를 본다.
 *
 * 분업: 엔진은 수치만 잰다(measure_leaf_strokes). 여기가 무엇을 잴지(후보)와
 * 문턱을 정하고, 통과한 잎은 군중 후보와 같은 수동 지정 경로로 라인이 된다 —
 * 내보내기·저장·해제가 전부 검증된 길이다. 트리에는 네온과 같은 "라인인지
 * 확인 필요" 배지가 붙는다.
 *
 * 군중 판의 실루엣은 획이 아니라서 여기로는 원리적으로 안 잡힌다 — 그쪽은
 * 기존 "후보 일괄 지정"(suggestLines)이 계속 담당한다(사용자 확인 2026-08-19).
 */

/**
 * 확실 구간 문턱. 납품 BG 26장 실측(1,756장)에서 나온 값들이다:
 * - survive2 < 0.25: 이름으로 잡힌 라인의 95%가 0.3 미만이고, 눈 검증에서
 *   0.25 미만 표본은 오탐 0이었다. 경계 사례(벽지 패턴·몰딩 띠·스우시)는
 *   전부 0.28~0.47 구간이라 이 문턱 밖이다.
 * - coverage < 0.15: 진짜 라인의 칠 면적은 1~9%. 경계 사례는 면적이 크다.
 * - nNative >= 20000: 부스러기(빈 타일 조각) 가드 — 군중 판에서 획 검출기가
 *   낸 오탐이 전부 이 아래였다.
 */
export const SURVIVE2_MAX = 0.25;
export const COVERAGE_MAX = 0.15;
export const MIN_NATIVE_PX = 20000;

/**
 * 한 RPC에 실어 보내는 잎 수. 엔진은 요청을 직렬로 처리하므로 파일의 후보를
 * 한 번에 다 재면 그동안 미리보기가 줄을 선다 — 큰 잎 몇 장 단위로 끊어야
 * 다른 요청이 사이에 낄 수 있다.
 */
export const STROKE_CHUNK = 6;

/**
 * 굵기를 재 볼 후보. 매칭이 놓친 그릴 수 있는 잎 중, 검출이 손대면 안 되는
 * 것들을 이름 규칙으로 먼저 뺀다:
 * - 프리셋 제외 그룹·토큰: 매칭과 같은 이유 — HEIGHTS·TEMPLATE 같은 참고
 *   그룹과 col류(색 지정 이름)는 라인이 아니라고 이미 정해져 있다.
 * - suggestLines 제외 어휘: 참고자료(REF·Field Guide류)·발광·글자 상자.
 *   주석 낙서는 굵기로는 선이라 이름으로만 걸러진다(BG 26장 실측에서 주석
 *   부류 17장 확인).
 * - normal 블렌드만: 진짜 라인 645장이 전부 normal이었다(매칭과 같은 게이트).
 */
export function drawnLineCandidateIds(
  tree: TreeNode[],
  matchedIds: readonly number[],
  preset: Preset,
): number[] {
  const matched = new Set(matchedIds);
  const prefixes = preset.excludeGroupPrefixes ?? [];
  const excludeTokens = [...(preset.excludeTokens ?? []), ...SUGGEST_EXCLUDE_TOKENS];
  const out: number[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      const name = (node.name ?? "").trim();
      if (node.kind === "group") {
        if (prefixes.some((p) => name.startsWith(p))) continue;
        if (SUGGEST_EXCLUDE_GROUPS.includes(name.toLowerCase())) continue;
        if (hasAnyToken(name, excludeTokens)) continue;
        walk(node.children ?? []);
        continue;
      }
      if (node.kind !== "pixel") continue;
      if (node.hasPixels === false) continue;
      if (matched.has(node.id)) continue;
      if (node.blendMode !== "normal") continue;
      if (hasAnyToken(name, excludeTokens)) continue;
      out.push(node.id);
    }
  };
  walk(tree);
  return out;
}

/** 측정 결과에서 확실 구간을 통과한 잎. null(못 잰 잎)은 그냥 넘어간다. */
export function judgeDrawnLines(features: Record<string, StrokeFeatures | null>): number[] {
  const out: number[] = [];
  for (const [id, f] of Object.entries(features)) {
    if (!f) continue;
    if (f.survive2 < SURVIVE2_MAX && f.coverage < COVERAGE_MAX && f.nNative >= MIN_NATIVE_PX) {
      out.push(Number(id));
    }
  }
  return out.sort((a, b) => a - b);
}

/**
 * 배치에 실어 보내는 판단 정책 — 문턱·어휘의 단일 출처. 엔진(batch.py)은 이
 * 값으로 스윕이 재둔 특징을 배치 드롭다운의 프리셋 기준으로 판단만 한다.
 * 위 문턱을 바꾸면 이 객체를 타고 배치까지 함께 바뀐다.
 */
export const DRAWN_LINES_POLICY: DrawnLinesPolicy = {
  survive2Max: SURVIVE2_MAX,
  coverageMax: COVERAGE_MAX,
  minNativePx: MIN_NATIVE_PX,
  excludeGroups: [...SUGGEST_EXCLUDE_GROUPS],
  excludeTokens: [...SUGGEST_EXCLUDE_TOKENS],
};

/**
 * 스윕이 재둔 파일 단위 특징(모든 잎)에서 이 프리셋의 후보만 골라 판단한다.
 * 세션도 엔진 호출도 없다 — "캐시완료 = 검출완료"의 프런트 절반. 후보·문턱이
 * 클릭 경로(detectDrawnLinesEffect)와 같은 함수라 두 경로의 답이 같다.
 */
export function judgeStoredFeatures(
  tree: TreeNode[],
  matchedIds: readonly number[],
  preset: Preset,
  features: Record<string, StrokeFeatures | null>,
): number[] {
  const subset: Record<string, StrokeFeatures | null> = {};
  for (const id of drawnLineCandidateIds(tree, matchedIds, preset)) {
    subset[String(id)] = features[String(id)] ?? null;
  }
  return judgeDrawnLines(subset);
}

/**
 * 아티스트가 화면에서 뺀 잎 전부 — 배치에 실어 보낼 거절 목록.
 *
 * **되살아나는 문이 셋이다.** 배치는 파일마다 프리셋을 다시 돌리고(matched),
 * 사이드카 특징으로 검출을 다시 판단하고(detected), 수동 지정을 다시 더한다
 * (manual). 그래서 뺄셈의 왼쪽은 그 셋의 합집합이어야 한다.
 *
 * 2026-08-21 신고가 이 함수를 넓히게 했다: PROP 판에서 `…/Color/red line`을
 * 라인만 화면에서 껐는데 배치 산출물에 그대로 나왔다. 첫 구현
 * (rejectedDrawnLineIds)이 **검출된 잎만** 뺐기 때문에, 이름으로 매칭된 잎은
 * 실을 칸이 아예 없었다. 검출 신고로 시작한 기능이라 검출만 보고 만든 것이
 * 원인이고, 프리셋과 무관하게 세 프리셋 전부에서 나던 결함이다.
 *
 * 화면 내보내기는 처음부터 옳았다 — `ExportDialog`가 `includedIds`를 그대로
 * 보낸다. 갈라진 쪽은 배치뿐이다.
 *
 * 세 근거가 다 비면 빈 배열이다 — "전부 거절"이 아니라 "뺄 근거가 없다"다.
 * 프리셋을 아직 안 건 파일·미스윕·복원이 그 경우이고, 그쪽은 지금까지처럼
 * 이름 매칭과 수동 지정으로 돈다.
 */
export function rejectedLineIds(
  matchedIds: readonly number[] | undefined,
  detectedIds: readonly number[] | undefined,
  manualIds: readonly number[] | undefined,
  includedIds: readonly number[],
): number[] {
  const revivable = new Set<number>();
  for (const src of [matchedIds, detectedIds, manualIds]) {
    for (const id of src ?? []) revivable.add(id);
  }
  if (revivable.size === 0) return [];
  const included = new Set(includedIds);
  return [...revivable].filter((id) => !included.has(id)).sort((a, b) => a - b);
}

/**
 * 배치에 실어 보낼 파일별 거절 목록. 위 뺄셈을 열린 파일 전부에 돌린 것이다.
 *
 * 조립을 App의 useMemo가 아니라 여기 두는 이유는 **인자 순서 때문**이다 —
 * rejectedLineIds의 인자 넷이 전부 number[]라 자리를 바꿔 넣어도 타입이 통과하고,
 * 그러면 엉뚱한 잎이 조용히 빠진다. 순수 함수라 그 실수를 단위 테스트로 잠글 수
 * 있다(App.test는 시간에 민감해 판정이 흔들린다).
 *
 * 빈 목록은 담지 않는다 — payload에 실리는 것은 실제로 뺄 것이 있는 파일뿐이다.
 */
export function rejectedLineIdsByPath(
  opsByPath: Record<string, { includedIds: number[]; manualLineIds: number[] }>,
  matchedIdsByPath: Record<string, number[] | undefined>,
  drawnLineIdsByPath: Record<string, number[] | undefined>,
): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const [path, ops] of Object.entries(opsByPath)) {
    const rejected = rejectedLineIds(
      matchedIdsByPath[path], drawnLineIdsByPath[path],
      ops.manualLineIds, ops.includedIds,
    );
    if (rejected.length > 0) out[path] = rejected;
  }
  return out;
}

/**
 * 작업 프로세스가 "갓 적용한 화면"을 구울 때 실제로 켠 포함 목록 —
 * `warmworker._preset_preview_args`의 included_set 미러다. 특징이 없으면
 * (스윕 안 한 폴더) 워커도 매칭만으로 굽는다.
 *
 * 이것을 따로 두는 이유는 **키 때문**이다. 워커가 구운 그림에 앱이 붙이는
 * 미리보기 캐시 키는 이 목록으로 만들어야 한다. 매칭만으로 만들면 키는
 * "검출 없는 화면"이라고 말하는데 그림에는 검출된 잎이 그려져 있어, 아티스트가
 * 해제한 잎이 화면에 남아 있는 그림을 보게 된다(2026-08-20 필드가이드 신고).
 * 저쪽 함수를 바꾸면 여기도 같이 볼 것.
 */
export function preparedIncludedIds(
  tree: TreeNode[],
  matchedIds: readonly number[],
  preset: Preset,
  features: Record<string, StrokeFeatures | null> | null | undefined,
): number[] {
  const ids = new Set<number>(matchedIds);
  if (features) {
    for (const id of judgeStoredFeatures(tree, matchedIds, preset, features)) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b);
}
