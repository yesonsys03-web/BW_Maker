export interface FailedOpen {
  path: string;
  /** 화면에 보일 이름. 경로 전체를 넣으면 카드가 한 줄을 다 먹는다. */
  name: string;
  message: string;
  traceback: string;
}

/**
 * 폴더를 불러오다 열리지 않은 파일들을 카드 한 장으로 모은다.
 *
 * 예전에는 파일마다 카드가 하나씩, 파이썬 트레이스백을 통째로 달고 떴다. 진짜
 * 크래시라면 맞는 모양이지만 "이 형식은 지원하지 않는다"에는 과하고, 스물넷을
 * 불러오다 몇 개가 걸리면 그 카드들이 패널을 덮어 정작 봐야 할 오류가 묻힌다.
 *
 * 그래서 본문은 파일마다 한 줄(이름 — 이유)로 줄이고, 트레이스백은 접히는 자리에
 * 모아 둔다. 조사할 근거를 버리지 않으면서 카드 한 장에 들어간다.
 */
export function openFailureReport(
  files: FailedOpen[]
): { title: string; message: string; traceback: string; paths: string[] } | null {
  if (files.length === 0) return null;
  return {
    title: `열지 못한 파일 ${files.length}개`,
    message: files.map((f) => `${f.name} — ${f.message}`).join("\n"),
    // 트레이스백이 없는 실패도 있다(엔진이 아니라 프런트에서 난 것). 빈 자리를
    // 남기면 접히는 영역이 빈 줄로 벌어지므로 아예 뺀다.
    traceback: files
      .filter((f) => f.traceback)
      .map((f) => `${f.name}\n${f.traceback}`)
      .join("\n\n"),
    paths: files.map((f) => f.path),
  };
}
