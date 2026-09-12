import { openPsd } from "./engine";
import { isEvictedSessionError } from "./preview";
import type { OpenResult } from "./types";

/**
 * 축출 때문에 다시 여는 횟수의 상한. 한 번으로 두었더니 파일을 한꺼번에 불러올
 * 때 실패했다: 세션이 두 칸뿐이라 재오픈과 재오픈 사이에 다른 작업이 끼어들면
 * 방금 되살린 세션이 또 밀려난다. 그렇다고 무제한으로 두면 진짜 고장을 재시도로
 * 덮게 되므로, 경합이 몇 번 겹치는 정도만 넘긴다.
 */
const MAX_REOPENS = 3;

/**
 * Runs an engine call against `sessionId`. If it fails because the engine's
 * SessionStore (LRU, max 2 open PSDs — engine/psd_engine/session.py) evicted
 * this session, transparently reopens `path` (a fresh sessionId, same file)
 * and retries the call with the new id, up to MAX_REOPENS times. `onReopened`
 * is invoked before each retry so the caller can fold the fresh session/tree
 * into its state — never rebuilding ops/includedIds/previewHiddenIds, since
 * those are keyed by path and unaffected by which sessionId currently backs
 * them.
 *
 * 호출자가 여러 번 부를 때는 onReopened에서 받은 새 id로 다음 호출을 걸어야
 * 한다. 처음 잡은 id를 계속 쓰면 매 호출마다 재오픈(=PSD 전체 재파싱)이 붙어,
 * 고쳐주려던 축출을 오히려 자기가 만들어낸다.
 *
 * Any other failure (including the reopen itself failing) propagates
 * unchanged, so it still lands on the ErrorPanel like every other engine
 * error — this is a transparent recovery for the one known-benign cause,
 * not a general retry/backoff mechanism.
 */
export async function withEvictedSessionRetry<T>(
  path: string,
  sessionId: number,
  call: (sessionId: number) => Promise<T>,
  onReopened: (result: OpenResult) => void
): Promise<T> {
  let sid = sessionId;
  for (let attempt = 0; ; attempt++) {
    try {
      return await call(sid);
    } catch (e) {
      if (!isEvictedSessionError(e) || attempt >= MAX_REOPENS) throw e;
      const result = await openPsd(path);
      onReopened(result);
      sid = result.sessionId;
    }
  }
}
