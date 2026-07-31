export interface TreeNode {
  id: number;
  name: string;
  kind: string;
  visible: boolean;
  blendMode: string;
  opacity: number;
  bbox: [number, number, number, number];
  hasMask: boolean;
  path: string[];
  children?: TreeNode[];
}

export interface OpenResult {
  sessionId: number;
  width: number;
  height: number;
  colorMode: string;
  depth: number;
  tree: TreeNode[];
}

/**
 * 자동 병합이 "무엇을 한 덩어리로 볼지" 고르는 기준. 실제 파일마다 명명 규칙이
 * 달라 하나로 고정할 수 없다.
 *   role  — 역할 접미사를 뗀 요소 (CHAIR1_UL + CHAIR1_OL → CHAIR1)
 *   group — 최상위 그룹 바로 아래 그룹 (GROUND, MG L BUILDING …)
 *   plane — 깊이 평면 접두사 (BG / MG / FG)
 */
export type MergeRule = "role" | "group" | "plane";

/**
 * 깊이 평면 토큰(아래→위). 애니메이션 BG의 표준 납품 단위라 "이 레이어를 MG에
 * 넣어줘"가 자주 나온다 — 우클릭 메뉴가 아직 없는 평면을 바로 만들 때 쓴다.
 * engine/psd_engine/matching.py의 DEFAULT_PLANE_TOKENS와 같은 값이어야 한다.
 */
export const PLANE_TOKENS = ["BG", "MG", "FG"] as const;

export type Operation =
  | { op: "exclude"; layerIds: number[] }
  | { op: "rename"; layerId: number; name: string }
  | { op: "merge"; layerIds: number[]; name: string }
  | { op: "flatten"; name: string }
  | { op: "reorder"; layerId: number; aboveId: number | null }
  /**
   * 병합에서 빼내 단독 레이어로 되돌린다. 내보내기에서 빼는 것과 다르다 —
   * 자동 병합이 잘못 묶었을 때 그 레이어만 원래 형태로 되돌리는 용도다.
   */
  | { op: "unmerge"; layerIds: number[] };

export interface Preset {
  name: string;
  include: { type: "contains" | "regex"; value: string; caseSensitive: boolean };
  excludeGroupPrefixes: string[];
  matchGroups: boolean;
  includeHidden: boolean;
  merge: "none" | "all" | "perGroup" | "byElement";
  /**
   * 요소별 병합이 쓰는 역할 접미사. 요소 이름에서 이걸 떼어내 같은 요소를
   * 알아낸다(CHAIR1_UL, CHAIR1_OL → CHAIR1). 어디에도 걸리지 않는 레이어는 BG.
   */
  roleTokens: string[];
  /** 자동 병합 기준. 배치 실행이 이 값을 쓴다. */
  mergeRule: MergeRule;
  naming: "pathPrefix" | "original";
  outputSuffix: string;
  embedPreview: boolean;
  /**
   * 라인 색 통일. null이면 원본 레이어 색을 그대로 둔다(기본).
   * "#RRGGBB"이면 내보낼 때 모든 레이어의 RGB를 그 색으로 덮되 알파는 유지해
   * 라인의 안티에일리어싱을 보존한다.
   */
  lineColor: string | null;
  /**
   * 레이어마다 파일을 따로 쓸지. 캔버스 크기는 매 파일 원본 그대로라 나중에
   * 다시 합칠 때 좌표가 맞는다.
   */
  splitLayers: boolean;
}

export interface EngineError {
  message: string;
  traceback: string;
}

export interface Verification {
  ok: boolean;
  canvasOk: boolean;
  layerCountOk: boolean;
  expectedLayers: number;
  actualLayers: number;
  layers: {
    name: string;
    nameOk: boolean;
    pixelChecked: boolean;
    pixelOk: boolean | null;
  }[];
}

export interface ExportResult {
  outputPath: string;
  layerCount: number;
  verification?: Verification;
  /** 레이어별 분리 내보내기일 때만. 파일 하나당 한 항목. */
  outputs?: { outputPath: string; layerCount: number; verification?: Verification }[];
}

export interface BatchItemResult {
  path: string;
  ok: boolean;
  outputPath?: string;
  layerCount?: number;
  verification?: Verification;
  error?: EngineError;
}
