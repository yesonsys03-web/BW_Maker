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

export type Operation =
  | { op: "exclude"; layerIds: number[] }
  | { op: "rename"; layerId: number; name: string }
  | { op: "merge"; layerIds: number[]; name: string }
  | { op: "flatten"; name: string }
  | { op: "reorder"; layerId: number; aboveId: number | null };

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
  naming: "pathPrefix" | "original";
  outputSuffix: string;
  embedPreview: boolean;
  /**
   * 라인 색 통일. null이면 원본 레이어 색을 그대로 둔다(기본).
   * "#RRGGBB"이면 내보낼 때 모든 레이어의 RGB를 그 색으로 덮되 알파는 유지해
   * 라인의 안티에일리어싱을 보존한다.
   */
  lineColor: string | null;
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
}

export interface BatchItemResult {
  path: string;
  ok: boolean;
  outputPath?: string;
  layerCount?: number;
  verification?: Verification;
  error?: EngineError;
}
