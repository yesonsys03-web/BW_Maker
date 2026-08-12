/**
 * 전체 캐시 워커 스윕의 디스패처.
 *
 * 워커(엔진 --warm-worker 프로세스)는 Rust가 띄우고 거두지만, **어떤 파일을
 * 어느 워커에 주는지는 여기서 정한다** — 남은 파일 목록과 순서는 화면 상태라
 * Rust가 복제해 들면 두 곳이 어긋난다. 워커가 파일 하나를 끝낼 때마다 큐의
 * 다음 파일을 그 워커에 준다(당겨 가기). 파일 크기가 들쭉날쭉해도 빠른 워커가
 * 알아서 더 가져가므로 미리 나눌 필요가 없다.
 *
 * 워커가 도중에 죽으면(크래시) 하던 파일을 큐에 되돌리고 남은 워커로 계속
 * 간다 — 파일 하나·워커 하나의 사고로 몇 시간짜리 스윕 전체를 버리지 않는다.
 * 전부 죽으면 그때까지의 결과로 끝낸다.
 *
 * Tauri API(invoke/listen)는 의존성으로 주입받는다 — 이 규칙 전부를 jsdom에서
 * 가짜 워커로 검증하기 위해서다(warmupQueue와 같은 구조).
 */

export interface WorkerEvent {
  event: "ready" | "progress" | "file";
  path?: string;
  done?: number;
  total?: number;
  ok?: boolean;
  message?: string;
  /** 파일 완료 이벤트에 실려 오는 그 파일의 mtime. 프런트는 앱에서 아직 안 연
   * 파일도 워커에 맡기므로, "이 판을 쓸었다"(path+mtime) 기록의 mtime은 워커가
   * 재서 준다. */
  mtime?: number;
}

export interface WorkerSweepProgress {
  /** 지금까지 처리한 드로잉 레이어 수(끝난 파일 + 진행 중 파일의 합). */
  doneLeaves: number;
  /** 워커가 지금까지 보고한 파일별 총량의 합 — 시작 전 파일은 모른다.
   * 호출자는 자기 추정치와 max로 합쳐 진행바 총량을 만든다. */
  totalLeavesKnown: number;
  filesDone: number;
  filesTotal: number;
}

export interface WorkerSweepResult {
  done: Array<{ path: string; mtime?: number }>;
  failed: Array<{ path: string; message: string }>;
}

export interface WorkerSweepDeps {
  /** 스윕할 파일 경로, 목록 순서. */
  paths: string[];
  workerCount: number;
  start: (count: number) => Promise<{ generation: number; ids: number[] }>;
  send: (id: number, path: string) => Promise<void>;
  stop: () => Promise<void>;
  /** warm-worker-line 구독. 반환은 해제 함수. */
  onLine: (cb: (e: { generation: number; id: number; line: string }) => void) => Promise<() => void>;
  /** warm-worker-exit 구독. */
  onExit: (cb: (e: { generation: number; id: number }) => void) => Promise<() => void>;
  onProgress?: (p: WorkerSweepProgress) => void;
}

export interface WorkerSweepHandle {
  /** 취소로 끝나면 null — 몇 개를 했는지가 아니라 "끝까지 못 갔다"가 정보다. */
  finished: Promise<WorkerSweepResult | null>;
  cancel: () => void;
}

export function runWorkerSweep(deps: WorkerSweepDeps): WorkerSweepHandle {
  const queue = [...deps.paths];
  const inflight = new Map<number, string>();
  /** 진행 중 파일의 마지막 done — 죽은 파일도 여기까지는 처리한 것으로 센다. */
  const partial = new Map<string, number>();
  /** 워커가 보고한 파일별 드로잉 레이어 총량. 시작 전 파일은 없다. */
  const totals = new Map<string, number>();
  const result: WorkerSweepResult = { done: [], failed: [] };
  let finishedLeaves = 0;
  let cancelled = false;
  let unlisteners: Array<() => void> = [];
  let resolveFinished!: (r: WorkerSweepResult | null) => void;
  const finished = new Promise<WorkerSweepResult | null>((r) => (resolveFinished = r));

  const report = () => {
    let doneLeaves = finishedLeaves;
    for (const p of inflight.values()) doneLeaves += partial.get(p) ?? 0;
    let totalLeavesKnown = 0;
    for (const t of totals.values()) totalLeavesKnown += t;
    deps.onProgress?.({
      doneLeaves,
      totalLeavesKnown,
      filesDone: result.done.length + result.failed.length,
      filesTotal: deps.paths.length,
    });
  };

  const settle = (value: WorkerSweepResult | null) => {
    for (const un of unlisteners) un();
    unlisteners = [];
    void deps.stop();
    resolveFinished(value);
  };

  const feed = (id: number) => {
    const next = queue.shift();
    if (next === undefined) {
      if (inflight.size === 0 && !cancelled) settle(result);
      return;
    }
    inflight.set(id, next);
    deps.send(id, next).catch(() => {
      // 워커가 이미 죽어 못 먹였다 — 파일을 되돌리고, 정리는 exit 이벤트가 한다.
      inflight.delete(id);
      queue.unshift(next);
    });
  };

  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    settle(null);
  };

  void (async () => {
    const { generation, ids } = await deps.start(deps.workerCount);
    if (cancelled) return;
    let alive = new Set(ids);

    unlisteners.push(
      await deps.onLine((e) => {
        if (e.generation !== generation || cancelled) return;
        let ev: WorkerEvent;
        try {
          ev = JSON.parse(e.line) as WorkerEvent;
        } catch {
          return; // 워커 stdout에 섞인 잡음은 버린다
        }
        if (ev.event === "progress" && ev.path !== undefined) {
          partial.set(ev.path, ev.done ?? 0);
          if (ev.total !== undefined) totals.set(ev.path, ev.total);
          report();
        } else if (ev.event === "file" && ev.path !== undefined) {
          inflight.delete(e.id);
          if (ev.ok) {
            result.done.push({ path: ev.path, mtime: ev.mtime });
            finishedLeaves += ev.total ?? partial.get(ev.path) ?? 0;
            if (ev.total !== undefined) totals.set(ev.path, ev.total);
          } else {
            result.failed.push({ path: ev.path, message: ev.message ?? "unknown" });
            finishedLeaves += partial.get(ev.path) ?? 0;
          }
          partial.delete(ev.path);
          report();
          feed(e.id);
        }
      })
    );
    unlisteners.push(
      await deps.onExit((e) => {
        if (e.generation !== generation || cancelled) return;
        alive.delete(e.id);
        const orphan = inflight.get(e.id);
        if (orphan !== undefined) {
          inflight.delete(e.id);
          queue.unshift(orphan);
        }
        if (alive.size === 0) {
          // 워커가 전부 죽었다. 남은 파일은 실패로 적어 호출자가 알게 한다.
          for (const p of [...inflight.values(), ...queue]) {
            result.failed.push({ path: p, message: "worker died" });
          }
          settle(result);
          return;
        }
        // 남은 워커 중 노는 것이 있으면 되돌린 파일을 바로 잇는다.
        for (const id of alive) {
          if (!inflight.has(id) && queue.length > 0) feed(id);
        }
      })
    );
    if (cancelled) {
      for (const un of unlisteners) un();
      unlisteners = [];
      return;
    }

    if (queue.length === 0) {
      settle(result);
      return;
    }
    for (const id of ids) feed(id);
    report();
  })();

  return { finished, cancel };
}
