import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { onEngineDead } from "../lib/engine";
import { toEngineError } from "../lib/preview";
import type { EngineError } from "../lib/types";

interface EngineStatusProps {
  onRestarted: () => void;
  onError: (title: string, error: EngineError) => void;
}

/**
 * Top-of-shell banner for the "engine-dead" event (src-tauri/src/engine.rs
 * emits it once the reader thread hits EOF on the child's stdout — see
 * should_drain_on_eof). "재시작" spawns a fresh engine process via the
 * restart_engine Tauri command; every session the old process held dies
 * with it, so a successful restart resets the whole file list to idle
 * (onRestarted) instead of pretending any sessionId still points at
 * something real. Re-selecting a file after that opens a fresh session
 * against the same path, same as any first-time open.
 */
export function EngineStatus({ onRestarted, onError }: EngineStatusProps) {
  const [dead, setDead] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [stderrTail, setStderrTail] = useState<string[]>([]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    onEngineDead((payload) => {
      setDead(true);
      setStderrTail(payload.stderrTail ?? []);
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  async function handleRestart() {
    setRestarting(true);
    try {
      await invoke("restart_engine");
      setDead(false);
      setStderrTail([]);
      onRestarted();
    } catch (e) {
      onError("엔진 재시작 실패", toEngineError(e));
    } finally {
      setRestarting(false);
    }
  }

  if (!dead) return null;

  return (
    <div className="engine-status-banner" role="alert">
      <div className="engine-status-banner-row">
        <span>
          엔진 프로세스가 종료되었습니다. 열려 있던 모든 파일 세션이 사라졌습니다 — 재시작 후 파일을 다시 선택하면
          새로 열립니다.
        </span>
        <button type="button" onClick={() => void handleRestart()} disabled={restarting}>
          {restarting ? "재시작 중..." : "재시작"}
        </button>
      </div>
      {stderrTail.length > 0 && <pre className="engine-status-stderr">{stderrTail.join("\n")}</pre>}
    </div>
  );
}
