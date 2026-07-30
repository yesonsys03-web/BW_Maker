import { openPsd } from "./engine";
import { isEvictedSessionError } from "./preview";
import type { OpenResult } from "./types";

/**
 * Runs an engine call against `sessionId`. If it fails because the engine's
 * SessionStore (LRU, max 2 open PSDs — engine/psd_engine/session.py) evicted
 * this session, transparently reopens `path` (a fresh sessionId, same file)
 * and retries the call exactly once with the new id. `onReopened` is invoked
 * before the retry so the caller can fold the fresh session/tree into its
 * state — never rebuilding ops/includedIds/previewHiddenIds, since those are
 * keyed by path and unaffected by which sessionId currently backs them.
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
  try {
    return await call(sessionId);
  } catch (e) {
    if (!isEvictedSessionError(e)) throw e;
    const result = await openPsd(path);
    onReopened(result);
    return call(result.sessionId);
  }
}
