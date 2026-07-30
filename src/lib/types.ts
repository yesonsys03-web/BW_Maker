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
  merge: "none" | "all" | "perGroup";
  naming: "pathPrefix" | "original";
  outputSuffix: string;
  embedPreview: boolean;
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
