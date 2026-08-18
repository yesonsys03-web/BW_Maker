export interface WarmupSummary {
  warmed: number;
  skipped: number;
}

export interface WarmupRequestResult {
  warmed: number[];
  skipped: number[];
  remaining: number[];
}

export interface WarmupOptions {
  /** 데울 잎 id 목록. 엔진이 이미 핫인 것은 비용 없이 걸러 준다. */
  leafIds: number[];
  /** 엔진 warm_preview_tiles 한 번. remaining이 빌 때까지 반복 호출된다. */
  request: (ids: number[]) => Promise<WarmupRequestResult>;
  /** 사람이 쓰는 중(캔버스 렌더·프리페치·배치)이면 참 — 이번 회차를 미룬다. */
  shouldPause: () => boolean;
  cancelled: () => boolean;
  /** 테스트가 시간을 쥘 수 있게 주입한다. 기본은 setTimeout. */
  wait?: (ms: number) => Promise<void>;
  /**
   * 요청 하나가 끝날 때마다 누적 (데움, 건너뜀)을 알린다. 진행 표시용이다 —
   * 눈에 보이는 진행이 없으면 사용자는 앱이 멈췄다고 보고 아무거나 누르고,
   * 그때마다 이 큐는 비켜서느라 더 안 끝난다.
   */
  onProgress?: (warmed: number, skipped: number) => void;
}

/** shouldPause가 참인 동안 다시 물어보는 간격. 프리페치 큐의 양보 폴링과 같은 값. */
export const WARMUP_POLL_MS = 200;

const defaultWait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 활성 파일의 안 데운 잎 타일을 엔진 유휴 시간에 미리 디코드하는 큐.
 *
 * 실측(2026-08-11, 납품 판): 타일이 핫이면 토글이 0.04~0.1초, 콜드면 그 잎의
 * 원본 해상도 디코드가 0.7~50초다. 프리페치는 라인 조합 한 장만 만들므로
 * 라인이 아닌 잎은 전부 콜드로 남는다 — 이 큐가 그 잎들을 데워, 첫 토글도
 * 핫 토글과 같게 만든다.
 *
 * 엔진이 요청당 시간 예산으로 잘게 자르고(warm_preview_tiles) 이 큐는 남은
 * 목록으로 반복 호출만 한다 — 자르는 규칙(순서·예산·건너뛰기)은 엔진에 있어야
 * 프런트가 레이어 크기를 알 필요가 없다. 요청 사이마다 shouldPause를 물어
 * 사람이 쓰는 중이면 비켜선다. stdin이 직렬이라 요청 하나가 나가 있으면 그
 * 뒤의 사용자 렌더는 어차피 기다린다 — 그래서 자르기가 엔진의 예산이고,
 * 비켜서기가 이 큐의 일이다.
 *
 * 취소되면 null을 돌려준다 — 몇 장을 데웠는지가 아니라 "끝까지 돌지 않았다"가
 * 호출자에게 필요한 정보다(다음 유휴 때 처음부터 다시 물어보면 이미 데운 잎은
 * 엔진이 비용 없이 걸러 준다).
 */
export async function drainWarmupQueue({
  leafIds,
  request,
  shouldPause,
  cancelled,
  wait = defaultWait,
  onProgress,
}: WarmupOptions): Promise<WarmupSummary | null> {
  let pending = leafIds;
  let warmed = 0;
  let skipped = 0;
  while (pending.length > 0) {
    if (cancelled()) return null;
    if (shouldPause()) {
      await wait(WARMUP_POLL_MS);
      continue;
    }
    const res = await request(pending);
    warmed += res.warmed.length;
    skipped += res.skipped.length;
    onProgress?.(warmed, skipped);
    // 엔진은 호출당 최소 한 장을 데우므로 remaining은 반드시 줄어든다. 혹시
    // 그 약속이 깨져도(버전 어긋남 등) 같은 목록으로 영원히 돌지는 않는다.
    if (res.remaining.length >= pending.length) return { warmed, skipped };
    pending = res.remaining;
  }
  return { warmed, skipped };
}

export interface PooledWarmupResult {
  warmed: number;
  skipped: number;
  /** 풀이 끝났는데 디스크에 안 놓인 잎 — 호출자가 디코드 경로로 마저 굽는다. */
  leftover: number[];
}

export interface PooledWarmupOptions extends Omit<WarmupOptions, "request"> {
  /** 디스크 전용 warm_preview_tiles 한 번(diskOnly=true). 절대 디코드하지 않는다. */
  request: (ids: number[]) => Promise<WarmupRequestResult & { poolAlive: boolean }>;
}

/**
 * 타일 자식들(warm_tiles_pooled)이 디스크에 굽는 동안, 놓인 타일을 RAM으로
 * 쓸어담는 루프. 진행바는 이 루프가 움직인다.
 *
 * drainWarmupQueue와 계약이 하나 다르다: **진행이 없어도 풀이 살아 있으면
 * 끝내지 않는다.** 디스크 전용 요청은 자식이 아직 안 구운 잎을 못 담는 것이
 * 정상이므로, 무진행은 "자식이 굽는 중"이지 프로토콜 위반이 아니다 — 기다렸다가
 * 다시 묻는다. 풀이 죽었는데 남은 잎이 있으면 그 목록을 leftover로 돌려주고,
 * 호출자(App의 warmIds)가 기존 디코드 경로로 마저 굽는다 — 자식이 몇 개가
 * 죽든 결과는 안 바뀌고 속도만 준다.
 */
export async function drainPooledWarmup({
  leafIds,
  request,
  shouldPause,
  cancelled,
  wait = defaultWait,
  onProgress,
}: PooledWarmupOptions): Promise<PooledWarmupResult | null> {
  let pending = leafIds;
  let warmed = 0;
  let skipped = 0;
  while (pending.length > 0) {
    if (cancelled()) return null;
    if (shouldPause()) {
      await wait(WARMUP_POLL_MS);
      continue;
    }
    const res = await request(pending);
    warmed += res.warmed.length;
    skipped += res.skipped.length;
    if (res.warmed.length + res.skipped.length > 0) onProgress?.(warmed, skipped);
    const progressed = res.remaining.length < pending.length;
    pending = res.remaining;
    if (pending.length === 0) break;
    if (!res.poolAlive) return { warmed, skipped, leftover: pending };
    if (!progressed) await wait(WARMUP_POLL_MS);
  }
  return { warmed, skipped, leftover: [] };
}
