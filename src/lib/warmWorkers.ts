/**
 * 워커 잡 큐의 디스패처 — 전체 캐시 스윕과 배치 내보내기가 함께 쓴다.
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
 * 큐·끌어가기·실패 가시화(무소식 워치독, 전달 실패 한도, 시작 실패 처리)는
 * runWorkerQueue 한 벌뿐이다 — v0.2.7의 침묵 멈춤(아래 WORKER_SILENCE_TIMEOUT_MS
 * 주석)을 소리 나게 만든 기계이므로, 잡 종류가 늘어도 여기서 갈라지면 안 된다.
 *
 * Tauri API(invoke/listen)는 의존성으로 주입받는다 — 이 규칙 전부를 jsdom에서
 * 가짜 워커로 검증하기 위해서다(warmupQueue와 같은 구조).
 */

import type { StrokeFeatures } from "./engine";

export interface WorkerEvent {
  event: "ready" | "progress" | "file" | "strokes";
  path?: string;
  done?: number;
  total?: number;
  ok?: boolean;
  message?: string;
  /** 파일 완료 이벤트에 실려 오는 그 파일의 mtime. 프런트는 앱에서 아직 안 연
   * 파일도 워커에 맡기므로, "이 판을 쓸었다"(path+mtime) 기록의 mtime은 워커가
   * 재서 준다. */
  mtime?: number;
  /** strokes 이벤트에 실려 오는 파일의 잎 굵기 특징(잎 id 문자열 → 특징|null). */
  features?: Record<string, StrokeFeatures | null>;
  /** 배치 내보내기 완료에 실려 오는 run_batch 모양의 결과 항목. */
  result?: BatchWorkerResultEntry;
  /** 배치 내보내기 진행의 단계 이름(엔진 batch.py의 progress cb). */
  stage?: string;
  current?: number;
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
  /** 처리할 파일 경로, 목록 순서. */
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
  /** 워커가 잎을 구운 김에 재둔 굵기 특징 — 무세션 검출(App)의 입력. */
  onStrokes?: (path: string, features: Record<string, StrokeFeatures | null>) => void;
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

/** runWorkerQueue가 모드(워밍업/내보내기)에 위임하는 부분. 목록과 진행 보고는
 * 모드 소유고, 코어는 큐·inflight·실패 가시화만 안다. */
interface WorkerQueueMode {
  /** file 이벤트 기록. 코어가 inflight 정리와 다음 먹이기를 맡는다. */
  onFile: (ev: WorkerEvent) => void;
  /** file이 아닌 이벤트(ready/progress). */
  onOther: (ev: WorkerEvent) => void;
  /** 코어가 만든 실패 — 전달 실패·워커 전멸·무소식·시작 실패. */
  onAbandoned: (path: string, message: string) => void;
  report: () => void;
  /** true면 cancel()이 즉시 접는 대신 **먹이기만 멈추고 inflight를 기다린다.**
   * 내보내기용이다: 산출물 쓰기가 원자적이지 않아(export.py에 temp+rename이
   * 없다) 도중에 워커를 죽이면 반쪽 PSD가 남는다 — 중지는 진행 중 파일을
   * 마치는 것으로 정의한다(직렬 배치의 "현재 파일 마치는 중..."과 같은 약속). */
  drainOnCancel: boolean;
}

interface WorkerQueueHandle {
  /** "done"은 정상 종료(배선 실패·전멸 포함 — 그 실패는 onAbandoned로 이미
   * 모드에 적혔다), "cancelled"는 취소(드레인이면 inflight를 마친 뒤). */
  finished: Promise<"done" | "cancelled">;
  cancel: () => void;
  /** settle 시점에 시작도 못 한 파일들. 중지 후 재개 목록이 된다. */
  remaining: () => string[];
}

function runWorkerQueue(deps: WorkerSweepDeps, mode: WorkerQueueMode): WorkerQueueHandle {
  const queue = [...deps.paths];
  const inflight = new Map<number, string>();
  let cancelled = false;
  /** 드레인 중지: 새 파일은 안 먹이고 inflight가 비면 접는다. */
  let draining = false;
  let unlisteners: Array<() => void> = [];
  let resolveFinished!: (r: "done" | "cancelled") => void;
  const finished = new Promise<"done" | "cancelled">((r) => (resolveFinished = r));
  /** 워커 신호를 하나라도 받았는지 + 지금 어느 단계인지(무소식 실패의 진단문). */
  let sawWorkerEvent = false;
  let stage = "워커 시작";
  let silenceTimer: ReturnType<typeof setTimeout> | undefined;
  /** 연속 전달 실패 수. 성공이 하나라도 끼면 0으로 돌아간다. */
  let sendFailStreak = 0;
  let settled = false;

  const settle = (value: "done" | "cancelled") => {
    if (settled) return;
    settled = true;
    if (silenceTimer !== undefined) clearTimeout(silenceTimer);
    for (const un of unlisteners) un();
    unlisteners = [];
    void deps.stop();
    resolveFinished(value);
  };

  /**
   * 배선 고장으로 접는다 — 남은 파일 전부를 이 사유로 모드에 적고 끝낸다.
   * 조용히 멈추지 않는 것이 요점이다. v0.2.7에서 디스패치가 실패하고도 아무
   * 데도 알리지 않아, 진행바가 0에서 멈춘 채 워커 여섯이 몇 시간을 놀았다 —
   * 사용자에게는 "전체 캐시가 고장"으로만 보였고 원인 문장은 어디에도 없었다.
   */
  const failAll = (message: string) => {
    if (cancelled || settled) return;
    for (const p of [...inflight.values(), ...queue]) {
      mode.onAbandoned(p, message);
    }
    inflight.clear();
    queue.length = 0;
    mode.report();
    settle("done");
  };

  const feed = (id: number) => {
    if (draining) {
      if (inflight.size === 0) settle("cancelled");
      return;
    }
    const next = queue.shift();
    if (next === undefined) {
      if (inflight.size === 0 && !cancelled) settle("done");
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
    if (cancelled || settled) return;
    if (mode.drainOnCancel) {
      draining = true;
      if (inflight.size === 0) settle("cancelled");
      return;
    }
    cancelled = true;
    settle("cancelled");
  };

  void (async () => {
    // 무소식 시계는 start를 기다리기 **전에** 건다. 걸림(hang)은 예외와 달리
    // catch에 안 잡히므로, 아래 어느 await가 영영 안 돌아와도 이 시계만이
    // "어느 단계에서 멈췄는지"를 실어 실패로 끝낼 수 있다.
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
      const alive = new Set(ids);

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
          if (ev.event === "file" && ev.path !== undefined) {
            inflight.delete(e.id);
            mode.onFile(ev);
            mode.report();
            feed(e.id);
          } else {
            mode.onOther(ev);
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
              mode.onAbandoned(p, "worker died");
            }
            inflight.clear();
            queue.length = 0;
            mode.report();
            settle("done");
            return;
          }
          // 드레인 중이면 죽은 워커의 파일도 더는 안 먹인다 — inflight가 비면 접는다.
          if (draining) {
            if (inflight.size === 0) settle("cancelled");
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
        settle("done");
        return;
      }
      stage = "파일 전달";
      for (const id of ids) feed(id);
      mode.report();
      stage = "워커 응답 대기";
    } catch (e) {
      // 시작·구독의 실패는 예전에는 아무 데도 안 닿는 unhandled rejection이었다
      // — 진행바만 0에서 멈추는 그 침묵이다. 사유를 실어 실패로 끝낸다.
      failAll(`워커를 시작하지 못함 (단계: ${stage}): ${String(e)}`);
    }
  })();

  return { finished, cancel, remaining: () => [...queue] };
}

/** 전체 캐시 스윕 — 파일마다 타일·오버레이·프리셋 미리보기를 디스크에 쌓는다. */
export function runWorkerSweep(deps: WorkerSweepDeps): WorkerSweepHandle {
  /** 진행 중 파일의 마지막 done — 죽은 파일도 여기까지는 처리한 것으로 센다.
   * 파일이 끝나거나 버려지면 지운다 — 그래서 이 맵에 남은 것 = 진행 중인 것이고,
   * report가 코어의 inflight를 몰라도 같은 합이 나온다. */
  const partial = new Map<string, number>();
  /** 워커가 보고한 파일별 드로잉 레이어 총량. 시작 전 파일은 없다. */
  const totals = new Map<string, number>();
  const result: WorkerSweepResult = { done: [], failed: [] };
  let finishedLeaves = 0;

  const core = runWorkerQueue(deps, {
    drainOnCancel: false,
    onOther: (ev) => {
      if (ev.event === "progress" && ev.path !== undefined) {
        partial.set(ev.path, ev.done ?? 0);
        if (ev.total !== undefined) totals.set(ev.path, ev.total);
        report();
      }
      if (ev.event === "strokes" && ev.path !== undefined && ev.features !== undefined) {
        deps.onStrokes?.(ev.path, ev.features);
      }
    },
    onFile: (ev) => {
      const path = ev.path!;
      if (ev.ok) {
        result.done.push({ path, mtime: ev.mtime });
        finishedLeaves += ev.total ?? partial.get(path) ?? 0;
        if (ev.total !== undefined) totals.set(path, ev.total);
      } else {
        result.failed.push({ path, message: ev.message ?? "unknown" });
        finishedLeaves += partial.get(path) ?? 0;
      }
      partial.delete(path);
    },
    onAbandoned: (path, message) => {
      result.failed.push({ path, message });
      partial.delete(path);
    },
    report,
  });

  function report() {
    let doneLeaves = finishedLeaves;
    for (const d of partial.values()) doneLeaves += d;
    let totalLeavesKnown = 0;
    for (const t of totals.values()) totalLeavesKnown += t;
    deps.onProgress?.({
      doneLeaves,
      totalLeavesKnown,
      filesDone: result.done.length + result.failed.length,
      filesTotal: deps.paths.length,
    });
  }

  return {
    finished: core.finished.then((kind) => (kind === "cancelled" ? null : result)),
    cancel: core.cancel,
  };
}

/** run_batch의 결과 항목과 같은 모양(engine/psd_engine/batch.py). 프런트의 배치
 * 보고서(verifyReport 등)가 순차 배치와 같은 코드로 읽는다. */
export interface BatchWorkerResultEntry {
  path: string;
  ok: boolean;
  [key: string]: unknown;
}

export interface BatchExportProgress {
  /** 가장 최근 진행 이벤트의 파일·단계. 여러 파일이 동시에 도니 "지금 하나"가
   * 아니라 "마지막으로 들린 것"이다 — 진행바의 주 지표는 filesDone이다. */
  path?: string;
  stage?: string;
  current?: number;
  total?: number;
  filesDone: number;
  filesTotal: number;
}

export interface BatchExportOutcome {
  /** 완료(성공+실패) 항목, **입력 순서**로 정렬. 워커 완주 순서는 매번 달라서
   * 그대로 내보내면 보고서가 실행마다 다른 순서로 나온다. */
  results: BatchWorkerResultEntry[];
  /** 시작도 못 한 파일(중지 시). 재개 목록이 된다. */
  remaining: string[];
  /** 중지로 끝났는가(드레인 완료 후). false면 끝까지 갔다. */
  stopped: boolean;
}

export interface BatchExportDeps extends Omit<WorkerSweepDeps, "onProgress"> {
  onProgress?: (p: BatchExportProgress) => void;
  /** 파일 하나가 끝날 때마다(성공·실패 모두). 표를 점진 갱신하는 용도다 —
   * 끝까지 기다려야 아무것도 안 보이면, 무엇이 실패했는지 알기까지 한 시간을
   * 기다리게 된다(직렬 배치와 같은 약속). 최종 목록은 finished가 입력 순서로
   * 정렬해 다시 준다. */
  onResult?: (entry: BatchWorkerResultEntry) => void;
}

export interface BatchExportHandle {
  finished: Promise<BatchExportOutcome>;
  /** 중지 — 새 파일은 안 먹이고 **진행 중 파일은 마친다**(드레인). 산출물
   * 쓰기가 원자적이지 않아 즉시 죽이면 반쪽 PSD가 남기 때문이다. */
  stop: () => void;
}

/** 배치 내보내기 — 파일마다 워커가 batch._process_one을 돌린다. */
export function runBatchExport(deps: BatchExportDeps): BatchExportHandle {
  const byPath = new Map<string, BatchWorkerResultEntry>();
  let last: { path?: string; stage?: string; current?: number; total?: number } = {};

  const core = runWorkerQueue(deps as WorkerSweepDeps, {
    drainOnCancel: true,
    onOther: (ev) => {
      if (ev.event === "progress" && ev.path !== undefined) {
        last = { path: ev.path, stage: ev.stage, current: ev.current, total: ev.total };
        report();
      }
    },
    onFile: (ev) => {
      const path = ev.path!;
      // 워커가 실은 result가 정본이다(실패도 error.traceback째 들어 있다).
      // 없으면(프로토콜이 어긋난 옛 워커 등) 최소 항목으로 만들어 보고서에 남긴다.
      const entry = ev.result ?? {
        path, ok: ev.ok === true,
        error: ev.ok === true ? undefined : { message: ev.message ?? "unknown", traceback: "" },
      };
      byPath.set(path, entry);
      deps.onResult?.(entry);
    },
    onAbandoned: (path, message) => {
      const entry: BatchWorkerResultEntry = {
        path, ok: false, error: { message, traceback: "" },
      };
      byPath.set(path, entry);
      deps.onResult?.(entry);
    },
    report,
  });

  function report() {
    deps.onProgress?.({
      ...last,
      filesDone: byPath.size,
      filesTotal: deps.paths.length,
    });
  }

  const order = new Map(deps.paths.map((p, i) => [p, i]));
  return {
    finished: core.finished.then((kind) => ({
      results: [...byPath.values()].sort(
        (a, b) => (order.get(a.path) ?? 0) - (order.get(b.path) ?? 0)
      ),
      remaining: core.remaining(),
      stopped: kind === "cancelled",
    })),
    stop: core.cancel,
  };
}

export interface PrepareProgress {
  filesDone: number;
  filesTotal: number;
}

export interface PrepareOutcome {
  failed: Array<{ path: string; message: string }>;
  /** 시작도 못 한 파일. 취소 후 현행 순차 경로가 이어받는다. */
  remaining: string[];
  /** 취소로 끝났는가. 전체 캐시·배치 내보내기가 작업 프로세스를 가져가면 true. */
  stopped: boolean;
}

export interface PrepareDeps extends Omit<WorkerSweepDeps, "onProgress"> {
  onProgress?: (p: PrepareProgress) => void;
  /** 파일 하나가 준비될 때마다. 끝까지 기다렸다 한 번에 넘기면 100장짜리
   * 폴더에서 화면이 오래 비어 있다 — 배치 내보내기의 onResult와 같은 약속. */
  onResult: (path: string, result: Record<string, unknown>) => void;
}

/**
 * 파일 준비 큐 — 폴더 로드 직후의 "여는 중"과 "미리보기 준비 중"을 작업
 * 프로세스가 파일 단위로 나눠 처리한다. 워커가 파일을 한 번 열어 트리·프리셋
 * 매칭·미리보기를 만들어 돌려준다(엔진 warmworker.prepare_file).
 *
 * 취소는 **즉시**다(drainOnCancel: false). 배치 내보내기와 달리 산출물이
 * 디스크 캐시와 PNG 한 장뿐이라 도중에 죽여도 반쪽 파일이 안 남는다 —
 * tilecache의 쓰기가 원자적이다. 남은 파일은 현행 순차 경로가 이어받는다.
 */
export function runPrepareQueue(deps: PrepareDeps) {
  const failed: Array<{ path: string; message: string }> = [];
  // 성공만 센다 — 실패는 failed 배열 하나에만 적히므로, filesDone은
  // succeeded + failed.length로 파일마다 정확히 한 번씩만 잡힌다(예전에는
  // 실패한 파일이 done과 failed 양쪽에 잡혀 진행바가 한 파일에 2씩 밀렸다).
  let succeeded = 0;

  const core = runWorkerQueue(deps as WorkerSweepDeps, {
    drainOnCancel: false,
    onOther: () => {},
    onFile: (ev) => {
      const path = ev.path!;
      if (ev.ok && ev.result !== undefined) {
        succeeded += 1;
        deps.onResult(path, ev.result as unknown as Record<string, unknown>);
      } else {
        failed.push({ path, message: ev.message ?? "unknown" });
      }
    },
    // 취소로 죽은 워커의 남은 파일은 여기 오지 않는다(코어가 cancelled면
    // onAbandoned를 안 부른다). 여기 오는 것은 배선 고장·전멸뿐이다.
    onAbandoned: (path, message) => {
      failed.push({ path, message });
    },
    report,
  });

  function report() {
    deps.onProgress?.({ filesDone: succeeded + failed.length, filesTotal: deps.paths.length });
  }

  return {
    finished: core.finished.then((kind) => ({
      failed,
      remaining: core.remaining(),
      stopped: kind === "cancelled",
    })),
    cancel: core.cancel,
  };
}
