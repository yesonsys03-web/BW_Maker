import { EngineRpcError } from "./engine";
import type { EngineError, TreeNode } from "./types";

function isGroup(node: TreeNode): boolean {
  return node.kind === "group";
}

/**
 * Preview-visible pixel leaf ids, in document order.
 *
 * solo가 비어 있으면 지금까지와 같다: 체크됐고(includedIds) 눈이 켜진
 * (previewHiddenIds에 없는) pixel leaf.
 *
 * solo가 하나라도 있으면 solo된 것만 그린다 — 체크박스와 눈을 둘 다 무시한다.
 * "이게 라인인가?"를 확인하려면 아직 체크하지 않은 레이어도 봐야 하고, 앞서 무엇을
 * 꺼뒀는지 기억하지 않아도 되어야 하기 때문이다. solo를 풀면 두 상태가 그대로
 * 살아 있으므로 원래 화면으로 돌아온다.
 *
 * Merge/rename/flatten/reorder ops never change which source pixels compose the
 * flattened image, so this only needs the original tree shape — the
 * `entries`/ops layer is irrelevant to what gets rendered.
 */
export function visibleIdsForPreview(
  tree: TreeNode[],
  includedIds: number[],
  previewHiddenIds: number[],
  soloIds: number[]
): number[] {
  const includedSet = new Set(includedIds);
  const hiddenSet = new Set(previewHiddenIds);
  const soloSet = new Set(soloIds);
  const out: number[] = [];

  function walk(nodes: TreeNode[]) {
    for (const node of nodes) {
      if (isGroup(node)) {
        walk(node.children ?? []);
        continue;
      }
      if (node.kind !== "pixel") continue;
      const visible = soloSet.size > 0
        ? soloSet.has(node.id)
        : includedSet.has(node.id) && !hiddenSet.has(node.id);
      if (visible) out.push(node.id);
    }
  }

  walk(tree);
  return out;
}

/**
 * Every pixel leaf id in a tree, document order, regardless of
 * included/preview-hidden state — the request set for the one-shot
 * background thumbnail render after a tree loads.
 */
export function pixelLeafIds(tree: TreeNode[]): number[] {
  const out: number[] = [];

  function walk(nodes: TreeNode[]) {
    for (const node of nodes) {
      if (isGroup(node)) {
        walk(node.children ?? []);
      } else if (node.kind === "pixel") {
        out.push(node.id);
      }
    }
  }

  walk(tree);
  return out;
}

/**
 * 그룹(또는 병합 행)의 solo 대상 id. pixel leaf만 남긴다.
 *
 * solo는 필터가 아니라 모드다(visibleIdsForPreview 참고) — soloIds가 하나라도
 * 있으면 화면은 그 목록만 그린다. type/adjustment/shape leaf는 애초에 그릴 수
 * 없으므로 이런 id가 soloIds에 섞이면 "solo 중인데 아무 행도 solo로 안 보이는"
 * 막다른 상태에 빠질 수 있다 — 그 id를 낼 수 있는 유일한 버튼(그 행 자신)이
 * 애초에 비활성이기 때문이다. 그래서 solo에 넣을 id는 pixelLeafIds로 한 번 더
 * 좁힌다. 같은 이유로 solo를 켜는 쪽(핸들러)과 "지금 전부 solo인가"를 보는
 * 쪽(행 표시)이 반드시 이 함수 하나를 같이 써야 한다 — 둘이 다른 목록을 보면
 * 버튼의 켜짐 표시가 실제로 눌렀을 때 벌어질 일과 어긋난다.
 *
 * 눈(hide)은 필터라서 이 좁힘이 필요 없다 — 그릴 수 없는 id가 previewHiddenIds에
 * 있어도 애초에 안 그려지니 무해하다. 그래서 handleGroupEye/allHidden은
 * collectLeafIds(모든 leaf)를 그대로 쓴다.
 */
export function groupSoloIds(nodes: TreeNode[]): number[] {
  return pixelLeafIds(nodes);
}

/**
 * True when the visible set is still exactly what opening the file produced —
 * every pixel leaf the PSD had switched on (see buildInitialOpsState).
 *
 * That state has no export to preview yet, and composing it means decoding
 * every layer in the document (seconds on a real plate), so the canvas shows
 * the PSD's own stored flattened preview instead, which is instant. The two
 * are not the same picture: the stored one is the artwork with its blend modes
 * and clipping intact, while a composed preview shows what export writes —
 * a flat stack. PreviewCanvas labels which one is on screen rather than
 * letting them be mistaken for each other.
 */
export function isDocumentView(tree: TreeNode[] | undefined, visibleIds: number[]): boolean {
  if (!tree) return false;
  const initial: number[] = [];

  function walk(nodes: TreeNode[]) {
    for (const node of nodes) {
      if (isGroup(node)) walk(node.children ?? []);
      else if (node.kind === "pixel" && node.visible) initial.push(node.id);
    }
  }

  walk(tree);
  if (initial.length !== visibleIds.length) return false;
  const visible = new Set(visibleIds);
  return initial.every((id) => visible.has(id));
}

/** Normalizes a thrown value into the app's EngineError shape (mirrors appStore's errorFrom). */
export function toEngineError(e: unknown): EngineError {
  if (e instanceof EngineRpcError) return { message: e.message, traceback: e.traceback };
  if (e instanceof Error) return { message: e.message, traceback: e.stack ?? e.message };
  return { message: String(e), traceback: String(e) };
}

/**
 * True when an engine RPC failure is SessionStore.get raising "unknown or
 * evicted session: {id}" (engine/psd_engine/session.py) — i.e. the LRU
 * cache (max 2 sessions) dropped this file's session in favor of more
 * recently used files. Callers use this to distinguish "transparently
 * reopen and retry" from a real failure that belongs on the ErrorPanel.
 * Substring match (not exact), because Python's KeyError.__str__ wraps the
 * message in repr() quotes: str(KeyError("unknown or evicted session: 2"))
 * === "'unknown or evicted session: 2'".
 */
export function isEvictedSessionError(e: unknown): boolean {
  return toEngineError(e).message.includes("unknown or evicted session");
}

/**
 * 미리보기 뒤에 깔리는 배경. 라인 추출 결과는 투명 배경에 어두운 선만 남는
 * 경우가 많아 체커보드 위에서는 사실상 보이지 않는다. 그래서 기본값은
 * "white"이고, 대신 체커보드(투명 여부 확인용)와 검정(밝은 선 확인용)을
 * 언제든 고를 수 있게 남겨둔다.
 */
/**
 * 미리보기 렌더의 긴 변 상한(px). 화면에 띄우는 쪽(PreviewCanvas)과 미리 만들어
 * 두는 쪽(App.tsx의 미리보기 준비 큐)이 같은 값을 써야 한다 — 다르면 준비해둔
 * 그림의 캐시 키가 어긋나 클릭할 때마다 다시 합성한다.
 */
export const PREVIEW_MAX_SIZE = 1500;

/**
 * 연속된 토글을 한 번의 렌더로 묶는 창(ms).
 *
 * **값이 아니라 언제 세는지가 바뀌었다.** 예전에는 토글이 들어올 때마다 이만큼
 * 기다렸다가 그렸다(trailing). 그래서 한 번만 눌러도 무조건 이 시간을 냈고,
 * 실측한 체감 지연에서 가장 큰 몫이 그 대기였다:
 *
 *     디바운스 대기        120 ms   ← 클릭 한 번에도 무조건
 *     보이는 N장 재합성     ~60 ms   (캐시된 타일 20장)
 *     PNG 인코딩          27.7 ms
 *     브라우저 PNG 디코딩   17.8 ms
 *
 * 지금은 **직전 렌더로부터** 이만큼을 센다(leading edge). 조용하다가 누른 첫
 * 토글은 기다리지 않고 곧바로 나가고, 그 뒤 이 창 안에 들어온 것들만 묶인다.
 *
 * **창 자체를 없애면 안 된다.** 엔진은 stdin을 순서대로 처리하므로 빠르게 열 번
 * 누르면 전체 렌더 열 개가 큐에 쌓인다. `requestIdRef`가 오래된 *결과*는 버리지만
 * 엔진은 그 일을 전부 한다 — 사람이 기다리는 것은 그 뒤에 선다. 그래서 값은
 * 그대로 두고 세는 시점만 옮겼다.
 */
export const PREVIEW_COALESCE_MS = 120;

/**
 * 이번 토글을 얼마나 기다렸다 엔진에 낼지(ms). 0이면 곧바로.
 *
 * @param lastRenderStartedAt 직전에 렌더를 건 시각. 아직 없으면 null.
 * @param now 지금 시각.
 */
export function previewRenderDelay(lastRenderStartedAt: number | null, now: number): number {
  if (lastRenderStartedAt === null) return 0;
  const since = now - lastRenderStartedAt;
  // since < 0 이면 시계가 뒤로 간 것이다 — 이 값을 그대로 크기 비교(>=)에 넣으면
  // "충분히 지났다" 판정을 피해가면서 120 - since가 커다란 양수로 나가버려, 뒤에
  // 있는 Math.max(0, …)가 음수 클램프로는 잡아내지 못한다. 그래서 부호는 여기,
  // 가드에서 먼저 걸러낸다.
  if (since >= PREVIEW_COALESCE_MS || since < 0) return 0;
  return PREVIEW_COALESCE_MS - since;
}

export type PreviewBackground = "white" | "checker" | "black";

export const PREVIEW_BACKGROUNDS: readonly PreviewBackground[] = ["white", "checker", "black"];

export const PREVIEW_BACKGROUND_LABELS: Record<PreviewBackground, string> = {
  white: "흰색",
  checker: "투명",
  black: "검정",
};

export const DEFAULT_PREVIEW_BACKGROUND: PreviewBackground = "white";

export const PREVIEW_BACKGROUND_STORAGE_KEY = "bwMaker.previewBackground";

/**
 * localStorage에 저장된 배경 설정을 읽는다. 값이 없거나(첫 실행) 아는 값이
 * 아니면(옵션 이름이 바뀐 구버전 설정) 기본값으로 되돌린다 — 이건 에러 흡수가
 * 아니라 저장된 문자열의 파싱 규칙이다. localStorage 접근 자체가 실패하면
 * 그대로 throw시켜 드러낸다.
 */
export function parsePreviewBackground(raw: string | null): PreviewBackground {
  return PREVIEW_BACKGROUNDS.includes(raw as PreviewBackground)
    ? (raw as PreviewBackground)
    : DEFAULT_PREVIEW_BACKGROUND;
}

export const MIN_PREVIEW_SCALE = 0.1;
export const MAX_PREVIEW_SCALE = 8;

/**
 * Wheel-driven zoom step for PreviewCanvas: exponential response to deltaY
 * (negative deltaY == scroll up == zoom in), clamped to
 * [MIN_PREVIEW_SCALE, MAX_PREVIEW_SCALE]. Pure so the clamp/direction
 * behavior is unit-testable without a DOM wheel event.
 */
export function nextScale(current: number, deltaY: number): number {
  return scaledBy(current, Math.exp(-deltaY * 0.001));
}

/** 배율에 factor를 곱하고 상하한으로 자른다. 휠과 키가 같은 한 곳에서 잘린다. */
export function scaledBy(current: number, factor: number): number {
  return Math.min(MAX_PREVIEW_SCALE, Math.max(MIN_PREVIEW_SCALE, current * factor));
}

/**
 * 키 한 번에 바뀌는 배율.
 *
 * 휠 한 칸(deltaY 100)은 약 10%인데, 그건 굴리는 손에는 맞아도 키에는 잘다 —
 * 두 배로 키우려면 일곱 번을 눌러야 한다. 25%면 세 번에 두 배가 된다.
 */
export const KEY_ZOOM_FACTOR = 1.25;

export type ViewCommand = "zoomIn" | "zoomOut" | "recenter" | "reset";

/**
 * 눌린 키가 뷰에 무엇을 시키는지. 해당 없으면 null.
 *
 * `key`가 아니라 **`code`** 로 판정하는 것이 요점이다. 한글 입력 상태에서 N을
 * 누르면 `key`는 "ㅜ"로 오지만 `code`는 자판 배열과 무관하게 KeyN이다. code로
 * 보면 입력기 상태를 신경 쓸 일도, 글자를 나열해 둘 일도 없다.
 *
 * ctrl/alt/meta가 끼면 넘긴다 — Cmd+1 같은 것은 OS와 앱의 몫이다. 다만 확대
 * 키의 shift는 무시한다: Shift+2는 자판에 따라 "@"가 되지만 code는 Digit2
 * 그대로이고, 확대를 기대한 손가락이 shift에 걸려 아무 일도 안 일어나는 편이
 * 더 나쁘다. reset은 그 shift 자체가 조합의 일부라 따로 본다.
 */
export function viewCommandFor(e: {
  code: string;
  /** 읽지 않는다. 받아만 두는 것은 한글 상태("ㅜ")를 테스트가 그대로 흉내 낼 수 있게 하려는 것이다. */
  key?: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}): ViewCommand | null {
  if (e.ctrlKey || e.altKey || e.metaKey) return null;
  if (e.code === "KeyM") return e.shiftKey ? "reset" : null;
  if (e.code === "Digit1") return "zoomOut";
  if (e.code === "Digit2") return "zoomIn";
  if (e.code === "KeyN") return "recenter";
  return null;
}

/** 뷰포트 중앙을 원점으로 하는 좌표. 커서 위치와 이동량이 모두 이 좌표계다. */
export interface ViewPoint {
  x: number;
  y: number;
}

/**
 * 커서 아래의 그림을 붙잡은 채로 배율만 바꿨을 때의 새 이동량.
 *
 * 그림은 뷰포트 가운데 놓이고 `translate(offset) scale(scale)`로 그려지므로,
 * 이미지 중앙 기준 문서 좌표 v가 화면에 오는 자리는 `c = offset + v·s`다.
 * 커서 c를 붙잡으려면 v = (c − offset)/s를 새 배율에서도 c로 보내면 되고,
 * 정리하면 `offset' = c − (c − offset)·(s'/s)`.
 *
 * 배율이 상하한에 걸려 그대로면 이동량도 그대로다(s' == s이면 항등식) — 키를
 * 눌러도 배율은 안 변한 채 그림만 미끄러지는 일이 없다.
 */
export function zoomAround(offset: ViewPoint, scale: number, next: number, cursor: ViewPoint): ViewPoint {
  const ratio = next / scale;
  return {
    x: cursor.x - (cursor.x - offset.x) * ratio,
    y: cursor.y - (cursor.y - offset.y) * ratio,
  };
}

/**
 * 커서 아래의 그림을 뷰포트 한가운데로 가져오는 새 이동량. 배율은 안 건드린다.
 *
 * 위 식에서 c를 0으로 보내면 되므로 `offset' = offset − c`. 배율이 안 변하니
 * 곱하기도 나눗셈도 필요 없다.
 */
export function recenterOn(offset: ViewPoint, cursor: ViewPoint): ViewPoint {
  return { x: offset.x - cursor.x, y: offset.y - cursor.y };
}
