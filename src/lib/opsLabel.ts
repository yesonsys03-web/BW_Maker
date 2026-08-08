/** 이름을 그대로 나열하는 상한. 넘으면 종류와 장수로 줄인다. */
const NAME_LIMIT = 3;

/**
 * 병합에 들어간 레이어 이름들을 히스토리 한 줄에 들어가는 길이로 줄인다.
 *
 * 그룹 단위 병합은 소스가 수십 장이라, 전부 나열하면 한 줄이 패널을 네 줄로
 * 가로지른다. 게다가 그 이름들은 대개 같다 — `LINES, LINES, LINES, LINES…`를
 * 여덟 번 읽어도 아는 것이 늘지 않는다.
 *
 * 그래서 서로 다른 이름 몇 개와 전체 장수로 줄인다. 무엇이 합쳐졌는지(종류)와
 * 얼마나 합쳐졌는지(장수)가 남고, 반복만 사라진다. 전체 목록은 부르는 쪽이
 * title에 담아 마우스를 올리면 보이게 한다.
 *
 * 장수는 **전체**다. 앞에 적은 이름을 뺀 나머지가 아니다 — "외 N장"으로 적으면
 * 앞의 셋과 더해 읽게 되는데, 그 셋은 종류를 보인 것이지 한 장씩이 아니다.
 */
export function summarizeNames(names: string[]): string {
  if (names.length === 0) return "";
  if (names.length <= NAME_LIMIT) return names.join(", ");
  const distinct = [...new Set(names)];
  return `${distinct.slice(0, NAME_LIMIT).join(", ")} 등 ${names.length}장`;
}
