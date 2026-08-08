/**
 * 다음에 받아올 썸네일 id 묶음.
 *
 * 대상은 "지금 화면에 보이는 행"이다(LayerTree의 IntersectionObserver). 파일
 * 하나에 레이어가 500장이어도 눈에 들어오는 것은 수십 행뿐인데, 예전에는 열자마자
 * 전부 만들었다 — 실측으로 엔진 시간의 66%가 아무도 안 보는 썸네일이었고, 엔진은
 * 요청을 한 줄로 세워 처리하므로 그동안 사람이 누른 것이 전부 그 뒤에서 기다렸다.
 *
 * 이미 받은 것과 실패한 것은 건너뛴다. 실패를 다시 집으면 큐가 끝나지 않는다.
 */
export function nextThumbnailChunk(
  wanted: Iterable<number>,
  have: Record<number, string> | undefined,
  failed: ReadonlySet<number>,
  size: number
): number[] {
  const out: number[] = [];
  for (const id of wanted) {
    if (have?.[id] !== undefined) continue;
    if (failed.has(id)) continue;
    out.push(id);
    if (out.length >= size) break;
  }
  return out;
}

/**
 * 엔진이 이번 묶음에서 끝내 돌려주지 않은 id.
 *
 * 요청한 것이 다 오지 않으면 그 id는 영원히 "아직 못 받음"으로 남아 같은 묶음이
 * 계속 다시 나간다. 한 번 비었으면 없는 것으로 보고 넘긴다.
 */
export function missingFromChunk(chunk: number[], received: Record<string, unknown>): number[] {
  return chunk.filter((id) => !(String(id) in received));
}
