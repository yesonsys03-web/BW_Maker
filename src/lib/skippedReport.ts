import type { SkippedLayer } from "./engine";

export interface UndrawableFile {
  /** 화면에 보일 파일 이름. 경로 전체를 넣으면 카드가 한 줄을 다 먹는다. */
  name: string;
  layers: SkippedLayer[];
}

/**
 * "라인이 하나도 안 나온 자리" 카드의 제목과 본문.
 *
 * 세는 단위가 레이어가 아니라 **자리(그룹)** 인 것이 요점이다. 엔진이 이미
 * 걸러주므로(psd_engine/matching.py의 match_preset) 여기 오는 것은 자기 이름이
 * 라인으로 걸렸고, 그릴 픽셀이 없고, 같은 그룹에서 라인이 한 장도 안 나온
 * 레이어뿐이다. 그러면 사람이 할 일은 "그 그룹을 열어본다" 하나이고, 같은
 * 그룹에 빈 레이어가 두 장이어도 열어볼 자리는 여전히 하나다.
 *
 * 종류를 함께 적는다. 조정 레이어는 애초에 자기 픽셀을 갖지 않는 종류라
 * (`line curves`) 파일이 잘못된 것이 아니라는 신호가 되는데, 이름만으로는
 * 그것이 안 보인다.
 */
export function undrawableReport(files: UndrawableFile[]): { title: string; message: string } | null {
  if (files.length === 0) return null;

  let places = 0;
  const blocks: string[] = [];

  for (const { name, layers } of files) {
    // 그룹 경로별로 묶는다. Map은 넣은 순서를 지키므로 파일 안에서의 순서가
    // 문서 순서 그대로 남는다.
    const byGroup = new Map<string, string[]>();
    for (const layer of layers) {
      const parts = layer.path.split("/");
      const leaf = parts.pop() ?? layer.path;
      const group = parts.join("/") || "(최상위)";
      const entries = byGroup.get(group) ?? [];
      entries.push(`${leaf} (${layer.kind})`);
      byGroup.set(group, entries);
    }
    places += byGroup.size;
    blocks.push([name, ...[...byGroup].map(([group, leaves]) => `  ${group} — ${leaves.join(", ")}`)].join("\n"));
  }

  return {
    title: `라인이 하나도 안 나온 자리 ${places}곳 (파일 ${files.length}개)`,
    message: blocks.join("\n"),
  };
}
