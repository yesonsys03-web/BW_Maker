import type { Verification } from "./types";

/** 이름을 몇 개까지 늘어놓을지. 넘으면 개수로 줄인다 — 표의 한 줄이다. */
const NAME_LIMIT = 5;

function names(list: string[]): string {
  if (list.length <= NAME_LIMIT) return list.join(", ");
  return `${list.slice(0, NAME_LIMIT).join(", ")} 외 ${list.length - NAME_LIMIT}개`;
}

/**
 * 검증이 무엇을 잡았는지 사람이 읽을 문장으로. 잡은 것이 없으면 null.
 *
 * 이게 없던 동안 배치 표에는 "실패" 두 글자만 떴다. `자세히`를 눌러도 아무것도
 * 안 나왔는데, 상세 칸이 `error`가 있을 때만 그려졌기 때문이다 — 검증 불일치는
 * 예외가 아니라 결과값이라 `error`가 없다. 그래서 무엇이 어긋났는지 알려면
 * 엔진을 따로 돌려보는 수밖에 없었다.
 *
 * 어긋난 종류를 모두 적는다. 캔버스가 틀리면 그 아래 레이어 비교는 어차피 다
 * 어긋나므로 먼저 적되, 나머지를 감추지는 않는다 — 감추면 "캔버스만 고치면
 * 되겠구나"로 읽힌다.
 *
 * 픽셀을 **검사하지 않은** 레이어(소스가 둘 이상인 병합)는 세지 않는다.
 * pixelOk가 null인 것을 틀린 것으로 세면 병합이 있는 파일마다 없는 문제가 뜬다.
 */
export function describeVerification(v: Verification): string | null {
  const lines: string[] = [];
  if (!v.canvasOk) lines.push("캔버스 크기가 원본과 다릅니다");
  if (!v.layerCountOk) {
    lines.push(`레이어 수가 다릅니다 — 기대 ${v.expectedLayers}장, 실제 ${v.actualLayers}장`);
  }

  const wrongName = v.layers.filter((l) => !l.nameOk).map((l) => l.name);
  if (wrongName.length > 0) {
    lines.push(`이름이 다르게 쓰인 레이어 ${wrongName.length}개: ${names(wrongName)}`);
  }

  const wrongPixels = v.layers.filter((l) => l.pixelOk === false).map((l) => l.name);
  if (wrongPixels.length > 0) {
    lines.push(`픽셀이 원본과 다른 레이어 ${wrongPixels.length}개: ${names(wrongPixels)}`);
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * 배치 한 건의 결과를 사람이 구분하는 세 가지로 나눈다.
 *
 * 예전에는 "썼는데 검증이 어긋났다"와 "아예 못 썼다"가 똑같이 실패였다. 아티스트
 * 에게 이 둘은 전혀 다르다 — 앞은 산출물이 있고 열어볼 수 있으며, 뒤는 없다.
 */
export type BatchOutcome = "ok" | "failed" | "check";

export function batchOutcome(result: { ok: boolean; error?: unknown; outputPath?: string }): BatchOutcome {
  if (result.ok) return "ok";
  // 예외가 있으면 쓰기 자체가 안 된 것이다. 검증 불일치는 예외를 남기지 않는다.
  return result.error ? "failed" : "check";
}
