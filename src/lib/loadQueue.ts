export interface LoadProgress {
  done: number;
  total: number;
}

export interface DrainOptions {
  /** 지금 아직 안 연 파일들의 경로. 매 회차마다 다시 읽으므로 도중에 늘어나도 따라간다. */
  pendingPaths: () => string[];
  /** 파일 하나를 여는(그리고 프리셋까지 적용하는) 실제 작업. 실패는 안에서 보고하고 삼킨다. */
  processPath: (path: string) => Promise<void>;
  onProgress: (progress: LoadProgress | null) => void;
  cancelled: () => boolean;
}

/**
 * 목록에 들어온 파일을 하나씩 열어두는 큐. 클릭해야 열리던 단계를 없애기 위한
 * 것이다.
 *
 * 한 번에 하나씩 도는 데는 이유가 있다. 엔진은 stdin 큐를 순서대로 처리하므로
 * 동시에 던져봐야 줄을 설 뿐이고, 파일 사이에서 한 번씩 양보해야 그 틈에 사람이
 * 누른 미리보기 요청이 끼어들 수 있다.
 *
 * 종료는 pendingPaths의 내용이 아니라 `started`가 보장한다. 이미 손댄 경로는 다시
 * 집지 않으므로, 호출자가 넘겨주는 목록이 (상태 반영이 늦어) 옛 값이더라도 같은
 * 파일을 두 번 열거나 영영 돌지 않는다. 회차당 경로 하나씩 줄어드는 셈이다.
 */
export async function drainLoadQueue({ pendingPaths, processPath, onProgress, cancelled }: DrainOptions): Promise<void> {
  const started = new Set<string>();
  let done = 0;
  try {
    for (;;) {
      if (cancelled()) return;
      const pending = pendingPaths().filter((p) => !started.has(p));
      const next = pending[0];
      if (next === undefined) return;
      started.add(next);
      onProgress({ done, total: done + pending.length });

      await processPath(next);

      done += 1;
      const remaining = pendingPaths().filter((p) => !started.has(p)).length;
      onProgress({ done, total: done + remaining });
    }
  } finally {
    // 중간에 예외로 빠져나가더라도 진행 표시는 반드시 걷는다 — 남아 있으면
    // 끝나지 않은 작업이 있는 것처럼 보인다.
    onProgress(null);
  }
}
