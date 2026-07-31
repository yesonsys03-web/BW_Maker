/**
 * 레이어 패널 폭. 실제 소스 PSD의 레이어 이름은 `Local_Gradient_...`처럼 길고
 * 그룹 중첩이 깊어 들여쓰기까지 폭을 먹는다. 고정 폭으로는 어떤 값을 잡아도
 * 누군가의 이름은 잘리므로, 아티스트가 직접 끌어서 맞춘다.
 */
export const TREE_PANEL_MIN_WIDTH = 240;
export const TREE_PANEL_MAX_WIDTH = 900;
/**
 * 320px였던 값. 실제 소스 PSD에서 `Local_Gradient_ExtraDark` 같은 이름이 그
 * 폭에서는 잘려서, 드래그 핸들을 발견하지 못한 사람은 처음부터 잘린 화면을
 * 보게 된다. 미리보기를 크게 잠식하지 않으면서 흔한 이름이 들어가는 선.
 */
export const DEFAULT_TREE_PANEL_WIDTH = 380;

export const TREE_PANEL_WIDTH_STORAGE_KEY = "bwMaker.treePanelWidth";

/** 파일 패널(240px) + 미리보기가 최소한 유지해야 할 폭. */
const RESERVED_FOR_OTHER_PANELS = 560;

/**
 * 레이어 패널을 넓히다 미리보기가 사라지면 안 되므로, 창 폭이 주어지면 그
 * 여유분까지 함께 상한으로 본다. 창이 아주 좁으면 최소 폭이 이긴다 —
 * 레이어 패널이 0이 되는 것보다는 낫다.
 */
export function clampTreePanelWidth(px: number, viewportWidth?: number): number {
  let max = TREE_PANEL_MAX_WIDTH;
  if (viewportWidth !== undefined) {
    max = Math.min(max, Math.max(TREE_PANEL_MIN_WIDTH, viewportWidth - RESERVED_FOR_OTHER_PANELS));
  }
  if (!Number.isFinite(px)) return DEFAULT_TREE_PANEL_WIDTH;
  return Math.min(max, Math.max(TREE_PANEL_MIN_WIDTH, Math.round(px)));
}

/**
 * localStorage에 저장된 폭을 읽는다. 값이 없거나(첫 실행) 숫자가 아니면
 * 기본값으로 돌아간다 — 에러 흡수가 아니라 저장된 문자열의 파싱 규칙이다.
 */
export function parseTreePanelWidth(raw: string | null): number {
  if (raw === null || raw.trim() === "") return DEFAULT_TREE_PANEL_WIDTH;
  const px = Number(raw);
  if (!Number.isFinite(px)) return DEFAULT_TREE_PANEL_WIDTH;
  return clampTreePanelWidth(px);
}
