/**
 * 레이어 이름을 토큰으로 쪼개고 비교한다.
 *
 * engine/psd_engine/names.py가 같은 규칙의 원본이다. 프리셋을 적용하기 전
 * "라인만" 패널은 여기 있는 폴백 규칙으로 도는데, 두 구현이 갈라지면 프리셋을
 * 누르는 순간 목록이 바뀐다. 한쪽을 고치면 다른 쪽도 고쳐야 한다.
 */

/**
 * 토큰 하나. 숫자 덩어리 / 연속 대문자(뒤에 소문자가 오지 않는 것) /
 * 대문자로 시작하는 낱말 / 소문자 덩어리.
 *
 * lookbehind를 쓰지 않는다 — 이 코드는 Tauri의 시스템 웹뷰에서 돌고
 * lookbehind는 Safari 16.4부터다.
 */
const TOKEN = /[0-9]+|[A-Z]+(?![a-z])|[A-Z][a-z]*|[a-z]+/g;

/** 이름의 토큰 목록. ASCII 영숫자가 없으면 빈 목록이다. */
export function tokenize(name: string): string[] {
  return name.match(TOKEN) ?? [];
}

function tokenEq(token: string, want: string, caseSensitive: boolean): boolean {
  const a = caseSensitive ? token : token.toLowerCase();
  const b = caseSensitive ? want : want.toLowerCase();
  if (a === b) return true;
  // 복수형 s를 받아준다 — 'line'으로 찾을 때 'LINES'가 빠지면 안 된다.
  return a.length === b.length + 1 && a.slice(0, -1) === b && (a.endsWith("s") || a.endsWith("S"));
}

/**
 * 이름의 토큰 열에 검색값의 토큰 열이 연속으로 나타나는가.
 * 검색값이 토큰을 하나도 만들지 못하면 false다 — 되돌아갈지는 호출자가 정한다.
 */
export function tokenMatch(name: string, value: string, caseSensitive = false): boolean {
  const want = tokenize(value);
  if (want.length === 0) return false;
  const have = tokenize(name);
  for (let i = 0; i + want.length <= have.length; i++) {
    if (want.every((w, j) => tokenEq(have[i + j], w, caseSensitive))) return true;
  }
  return false;
}

/**
 * 포함 규칙의 검색값을 쉼표로 나눈 목록. 엔진 matching.include_terms와 같다.
 *
 * 토크나이저가 소문자 덩어리를 토큰 하나로 보므로 `lineart`는 `line`과 다른
 * 토큰이고 영영 안 걸린다. 그 규칙을 무르면 `LINEAR DODGE`가 걸리므로, 규칙 대신
 * 어휘를 늘린다. 쉼표가 없으면 항목 하나짜리 목록이라 기존 값은 그대로 동작한다.
 */
export function includeTerms(value: string): string[] {
  return value.split(",").map((t) => t.trim()).filter((t) => t.length > 0);
}

/** 쉼표 목록 중 하나라도 토큰으로 걸리는가. 엔진 _name_matches의 contains와 같다. */
export function tokenMatchAny(name: string, value: string, caseSensitive = false): boolean {
  return includeTerms(value).some((t) => tokenMatch(name, t, caseSensitive));
}

/** 이름의 토큰 중 하나라도 wanted에 있는가. */
export function hasAnyToken(name: string, wanted: string[], caseSensitive = false): boolean {
  const have = tokenize(name);
  return have.some((t) => wanted.some((w) => w.trim().length > 0 && tokenEq(t, w, caseSensitive)));
}

/**
 * BG 프리셋이 네온을 라인 어휘로 가지면서(presets.ts BG_PRESET 주석), 네온으로
 * 걸린 레이어는 "진짜 선화인지 확인 필요"로 표시한다 — 간판·튜브는 획 그림이
 * 맞지만 점 전구·글로 막대 같은 빛 장식이 같은 이름 아래 섞여 있어, 기계가
 * 포함하고 사람이 확인하는 구도다. 판정은 매칭과 같은 토큰 규칙이다 — 부분
 * 문자열이 아니므로 "neonlight"(한 토큰)는 안 걸리고 "NEON red"·"neon2"·
 * "Red_Neon"은 걸린다.
 */
export const NEON_TOKEN = "neon";

/** 이름이 네온 토큰을 갖는가. 조상 그룹 이름까지 보려면 path에 some으로 건다. */
export function isNeonName(name: string): boolean {
  return tokenMatch(name, NEON_TOKEN);
}
