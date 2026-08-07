import { isDocumentView, visibleIdsForPreview } from "./preview";
import type { EdgeLines, TreeNode } from "./types";

/**
 * 렌더된 미리보기 이미지(data URL) 캐시 상한(문자 수). 초과하면 LRU로 버린다 —
 * 엔진의 PREVIEW_TILE_BUDGET_BYTES(engine/psd_engine/render.py)와 같은 방식이다.
 *
 * 처음에는 48MB였다. "한 컷 분량"을 기준으로 잡은 값인데, 폴더를 통째로 열어
 * 25개를 오가는 지금 방식에는 모자란다: 1500px PNG 한 장이 base64로 1~4MB이고
 * 여기에 토글 조합마다 다른 판이 더 쌓이므로, 예산을 넘긴 순간부터 오래된 파일이
 * 버려진다. 그 파일을 다시 누르면 합성을 처음부터 다시 하는데, 실측으로 가장
 * 무거운 파일이 **41초**였다(1.3GB / VtINTVoxOfficeDeskFrontWDa).
 *
 * 버리는 대가가 그만큼 크므로 넉넉히 잡는다. 문자 하나가 2바이트여도 512MB
 * 수준이고, 세션 하나가 파일 크기만큼(700MB급) 먹는 엔진 쪽에 비하면 작다.
 */
export const PREVIEW_CACHE_BUDGET_CHARS = 256 * 1024 * 1024;

/**
 * 한 파일을 어떻게 렌더하고 그 결과를 어느 키에 담을지. 화면에 띄우는 쪽과 미리
 * 만들어 두는 쪽이 이 함수를 함께 써야 한다 — 두 곳이 visibleIds나 documentView를
 * 각자 계산하면 키가 미묘하게 어긋나 준비해둔 그림을 못 찾는다.
 */
export function previewRenderSpec(
  file: PreviewFileId,
  tree: TreeNode[],
  includedIds: number[],
  previewHiddenIds: number[],
  soloIds: number[],
  lineColor: string | null,
  matchedIds: number[] | undefined,
  edgeLines: EdgeLines | null
): {
  visibleIds: number[];
  documentView: boolean;
  lineColorIds: number[] | null;
  key: string | null;
} {
  const visibleIds = visibleIdsForPreview(tree, includedIds, previewHiddenIds, soloIds);
  const documentView = isDocumentView(tree, visibleIds);
  return {
    visibleIds,
    documentView,
    lineColorIds: lineColorIdsFor(visibleIds, lineColor, matchedIds),
    key: previewCacheKey(file, documentView, visibleIds, lineColor, matchedIds, edgeLines),
  };
}

/**
 * 색 통일을 걸 레이어 id — 지금 그리는 것들 중 **프리셋 규칙에 걸린 라인**뿐이다.
 * 아티스트가 손으로 체크해 넣은 색 레이어는 여기 없으므로 원본 색이 남는다
 * (엔진의 assign_line_color가 내보내기 쪽에서 같은 판단을 한다).
 *
 * 그릴 것과 교집합을 내는 것은 두 가지를 한 번에 해결한다. 엔진에 보내는 목록이
 * 짧아지고(납품 파일은 매칭만 600장 규모다), 캐시 키도 지금 그림에 실제로 영향을
 * 주는 것만 담게 된다.
 *
 * `matchedIds`가 아직 없으면(프리셋을 적용하기 전) null을 준다 — 엔진에서 그것은
 * "전부 건다"는 뜻이고, 색 통일을 켜둔 프리셋이 선택돼 있는 한 App이 곧 프리셋을
 * 적용해 다시 그린다.
 */
export function lineColorIdsFor(
  visibleIds: number[],
  lineColor: string | null,
  matchedIds: number[] | undefined
): number[] | null {
  if (lineColor === null || matchedIds === undefined) return null;
  const matched = new Set(matchedIds);
  return visibleIds.filter((id) => matched.has(id));
}

/** 캐시가 그림을 어느 파일의 어느 판(version)에 붙여둘지. */
export interface PreviewFileId {
  path: string;
  /** 엔진이 파일을 열며 읽어온 수정 시각. 없으면 캐시를 쓰지 않는다. */
  mtime?: number;
}

/**
 * 캐시 키. 같은 키면 엔진이 같은 그림을 돌려준다는 뜻이어야 하므로, 렌더 결과를
 * 바꾸는 입력을 전부 담는다.
 *
 * 파일을 가리키는 데 sessionId가 아니라 경로+수정시각을 쓴다. 처음에는 세션 id를
 * 썼는데 — 재오픈된 파일에 옛 그림이 붙는 것을 막으려는 의도였다 — 실제로는
 * 캐시를 무력화했다. 세션은 LRU(2개)에 밀려 수시로 새로 열리고, 그때마다 id가
 * 바뀌면서 애써 만들어둔 그림이 통째로 조회 불가가 된다. 증상은 "다른 파일 갔다
 * 돌아오면 또 합성한다"였다.
 *
 * 수정 시각은 그 의도를 정확히 지킨다: 세션이 몇 번을 다시 열리든 파일이 그대로면
 * 같은 키이고(재사용), 아티스트가 포토샵에서 저장하면 키가 달라진다(다시 그림).
 *
 * mtime을 모르면(옛 세션에서 온 파일) 키를 만들지 않는다 — 확인할 수 없는 것을
 * 재사용하느니 다시 그리는 편이 낫다.
 */
export function previewCacheKey(
  file: PreviewFileId,
  documentView: boolean,
  visibleIds: number[],
  lineColor: string | null,
  matchedIds: number[] | undefined,
  edgeLines: EdgeLines | null
): string | null {
  if (file.mtime === undefined) return null;
  // 문서 보기는 visibleIds/lineColor/edgeLines를 쓰지 않지만 키에 남겨도 해롭지
  // 않다(같은 입력이면 같은 키다). 빠뜨렸을 때만 문제가 된다.
  //
  // 색 통일 **대상**도 키에 든다. 같은 레이어를 같은 색 설정으로 그려도 어느
  // 것에 색을 거느냐에 따라 그림이 다르기 때문이다 — 프리셋을 적용하기 전후가
  // 정확히 그 경우다.
  //
  // edgeLines도 켜짐 여부와 다섯 수치 전부가 그림을 바꾼다 — JSON.stringify로
  // 통째로 담는다. 켰다 껐다 하거나 프리셋을 바꿨는데 캐시가 이전 그림을 그대로
  // 돌려주면, 아티스트는 계속 옛 미리보기를 보면서 다른 설정을 확인했다고
  // 믿게 된다. 느린 편이 그보다 낫다.
  const lineColorIds = lineColorIdsFor(visibleIds, lineColor, matchedIds);
  return [
    file.path,
    file.mtime,
    documentView ? "doc" : "composite",
    lineColor ?? "",
    lineColorIds === null ? "all" : lineColorIds.join(","),
    visibleIds.join(","),
    JSON.stringify(edgeLines),
  ].join("\n");
}

/**
 * data URL을 담는 LRU 캐시. 파일을 오갈 때마다 같은 그림을 다시 렌더하지 않기
 * 위한 것이다 — PreviewCanvas는 파일이 바뀌면 화면의 이미지를 버리므로, 이게
 * 없으면 돌아올 때마다 합성 렌더와 base64 왕복을 처음부터 되풀이한다.
 */
/**
 * 준비 큐가 이 그림을 (다시) 만들어야 하는가.
 *
 * "캐시에 없으면 만든다"로는 끝나지 않는다. 캐시는 예산제 LRU라 폴더가 예산을
 * 넘기면 앞쪽부터 버려지는데, 그 축출을 만들 근거로 삼으면 큐가 방금 만든 것을
 * 곧바로 다시 집는다 — 실제로 107개 폴더에서 큐가 0/105로 무한 재시작하며 엔진을
 * 영원히 붙잡았고, 배치가 그 뒤에서 절반 속도로 기었다.
 *
 * 그래서 이번에 만든 키를 함께 본다. 키에는 경로·수정시각·표시 레이어·라인색이
 * 모두 들어가므로, 레이어를 토글하거나 프리셋을 다시 걸거나 포토샵에서 저장하면
 * 키가 달라져 정상적으로 다시 만든다. 바뀐 것이 없는데 축출됐다는 이유만으로
 * 다시 만드는 경우만 사라진다 — 그 파일은 눌렀을 때 화면이 그린다.
 */
export function needsPrefetch(
  key: string | null,
  cache: PreviewCache,
  alreadyMade: ReadonlySet<string>
): boolean {
  if (key === null) return false;
  return !alreadyMade.has(key) && cache.get(key) === undefined;
}

export class PreviewCache {
  private entries = new Map<string, string>();
  private total = 0;

  constructor(private budget: number = PREVIEW_CACHE_BUDGET_CHARS) {}

  get(key: string): string | undefined {
    const hit = this.entries.get(key);
    if (hit === undefined) return undefined;
    // 최근 사용으로 올린다: Map은 삽입 순서를 지키므로 지웠다 다시 넣으면 된다.
    this.entries.delete(key);
    this.entries.set(key, hit);
    return hit;
  }

  set(key: string, dataUrl: string): void {
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      this.entries.delete(key);
      this.total -= existing.length;
    }
    this.entries.set(key, dataUrl);
    this.total += dataUrl.length;
    // 방금 넣은 것 하나는 예산을 넘더라도 남긴다 — 지금 화면에 띄울 그림이다.
    while (this.total > this.budget && this.entries.size > 1) {
      const oldest = this.entries.keys().next().value as string;
      this.total -= this.entries.get(oldest)!.length;
      this.entries.delete(oldest);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}
