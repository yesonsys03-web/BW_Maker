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

/**
 * 워커에서 아무 신호(ready/progress/file)가 없을 때 스윕을 실패로 접기까지
 * 기다리는 시간. 워커는 뜨자마자 ready 한 줄을 내므로(warmworker.py) 정상
 * 경로에서 첫 신호는 수 초 안에 온다 — 30초 무소식은 배선(스폰·이벤트 구독·
 * 전달)의 어딘가가 끊긴 것이다.
 *
 * 이 시계가 있는 이유는 v0.2.7 실사용 사고다: 빌드 앱에서 워커 6개가 떠서
 * stdin만 기다리는데 진행바는 0/6869에서 영원히 멈췄다 — 디스패치의 어느
 * 단계가 실패했는지 화면 어디에도 남지 않았다. 멈춘 채 침묵하는 대신, 어느
 * 단계(stage)까지 갔는지를 실은 실패로 끝낸다.
 */
export const WORKER_SILENCE_TIMEOUT_MS = 30_000;

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
  /** 워커 신호를 하나라도 받았는지 + 지금 어느 단계인지(무소식 실패의 진단문). */
  let sawWorkerEvent = false;
  let stage = "워커 시작";
  let silenceTimer: ReturnType<typeof setTimeout> | undefined;
  /** 연속 전달 실패 수. 성공이 하나라도 끼면 0으로 돌아간다. */
  let sendFailStreak = 0;
  let settled = false;

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
    if (settled) return;
    settled = true;
    if (silenceTimer !== undefined) clearTimeout(silenceTimer);
    for (const un of unlisteners) un();
    unlisteners = [];
    void deps.stop();
    resolveFinished(value);
  };

  /**
   * 배선 고장으로 스윕을 접는다 — 남은 파일 전부를 이 사유로 실패에 적고 끝낸다.
   * 조용히 멈추지 않는 것이 요점이다. v0.2.7에서 디스패치가 실패하고도 아무
   * 데도 알리지 않아, 진행바가 0에서 멈춘 채 워커 여섯이 몇 시간을 놀았다 —
   * 사용자에게는 "전체 캐시가 고장"으로만 보였고 원인 문장은 어디에도 없었다.
   */
  const failAll = (message: string) => {
    if (cancelled || settled) return;
    for (const p of [...inflight.values(), ...queue]) {
      result.failed.push({ path: p, message });
    }
    inflight.clear();
    queue.length = 0;
    report();
    settle(result);
  };

  const feed = (id: number) => {
    const next = queue.shift();
    if (next === undefined) {
      if (inflight.size === 0 && !cancelled) settle(result);
      return;
    }
    inflight.set(id, next);
    deps.send(id, next).then(
      () => {
        sendFailStreak = 0;
      },
      (e) => {
        // 워커가 이미 죽어 못 먹였다 — 파일을 되돌리고, 정리는 exit 이벤트가 한다.
        inflight.delete(id);
        queue.unshift(next);
        // 다만 워커가 죽은 게 아니라 전달 자체가 고장이면 exit는 영영 안 온다.
        // 워커 수만큼 연달아 실패하면 배선 고장으로 보고 사유를 실어 끝낸다.
        sendFailStreak += 1;
        if (sendFailStreak >= Math.max(1, deps.workerCount)) {
          failAll(`워커에 파일을 전달하지 못함: ${String(e)}`);
        }
      }
    );
  };

  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    settle(null);
  };

  void (async () => {
    // 무소식 시계는 start를 기다리기 **전에** 건다. 걸림(hang)은 예외와 달리
    // catch에 안 잡히므로, 아래 어느 await가 영영 안 돌아와도 이 시계만이
    // "어느 단계에서 멈췄는지"를 실어 스윕을 실패로 끝낼 수 있다.
    silenceTimer = setTimeout(() => {
      if (!sawWorkerEvent) {
        failAll(
          `워커가 ${WORKER_SILENCE_TIMEOUT_MS / 1000}초 동안 신호가 없음` +
          ` (멈춘 단계: ${stage})`
        );
      }
    }, WORKER_SILENCE_TIMEOUT_MS);
    try {
      const { generation, ids } = await deps.start(deps.workerCount);
      if (cancelled) return;
      stage = "워커 이벤트 구독";
      let alive = new Set(ids);

      unlisteners.push(
      await deps.onLine((e) => {
        if (e.generation !== generation || cancelled) return;
        sawWorkerEvent = true;
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
          sawWorkerEvent = true;
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
      stage = "파일 전달";
      for (const id of ids) feed(id);
      report();
      stage = "워커 응답 대기";
    } catch (e) {
      // 시작·구독의 실패는 예전에는 아무 데도 안 닿는 unhandled rejection이었다
      // — 진행바만 0에서 멈추는 그 침묵이다. 사유를 실어 실패로 끝낸다.
      failAll(`워커 스윕을 시작하지 못함 (단계: ${stage}): ${String(e)}`);
    }
  })();

  return { finished, cancel };
}
