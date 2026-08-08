/** 내보내기 출력 포맷. "psd"는 "원본 따름"이라 .psd/.psb를 원본에서 물려받는다. */
export type OutputFormat = "psd" | "png" | "jpg";

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
  /**
   * 파일이 마지막으로 바뀐 시각(엔진의 os.path.getmtime). 만들어둔 미리보기를
   * 언제까지 재사용해도 되는지의 기준이다 — previewCache 참고. 이 필드가 생기기
   * 전 세션과 섞일 수 있어 optional로 둔다.
   */
  mtime?: number;
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
  /**
   * 출력 포맷. "psd"는 "원본 따름"이라 .psd/.psb를 원본에서 물려받는다.
   * "png"는 투명 배경 RGBA, "jpg"는 흰 배경에 구운 불투명 이미지다.
   * 둘 다 평탄화되며, splitLayers를 켜면 레이어당 이미지 한 장이 된다.
   */
  outputFormat: OutputFormat;
  /**
   * 이름에 검색어가 들어있어도 라인 아트가 아닌 것을 걸러내는 토큰.
   * `line col`, `LINE_COL`, `Line Colour`는 색 지정 레이어지 라인이 아니다.
   * 네 판별 규칙 중 이것만 어휘에 의존해서 편집 가능하게 둔다.
   * engine/psd_engine/matching.py의 DEFAULT_EXCLUDE_TOKENS와 기본값이 같아야 한다.
   */
  excludeTokens: string[];
  /**
   * 캐릭터 모델 전용 색 경계선 생성. 색으로만 갈려 있고 선이 없는 경계에 획을
   * 만들어 그 뷰의 라인 레이어에 합친다. 기본은 꺼짐이라 BG 프리셋은 영향받지 않는다.
   * 기본값의 근거는 docs/superpowers/specs/2026-08-07-character-colour-boundary-lines-design.md 7절.
   */
  edgeLines: EdgeLines;
}

export interface EdgeLines {
  enabled: boolean;
  /** 이웃과의 RGB 최대 채널 차가 이보다 크면 색이 바뀐 것으로 본다. */
  threshold: number;
  /** 기존 선을 이만큼(반지름 px) 부풀려 뺀다. */
  gap: number;
  /** 획 굵기(px). */
  width: number;
  /** 이보다 짧은 조각은 점으로 보고 버린다. */
  minLength: number;
  /** 기존 라인으로 칠 알파 문턱. 라인이 반투명이 많아 낮게 잡는다. */
  lineAlpha: number;
  /**
   * 뷰의 색 그림을 만드는 방법. 엔진 edges.COLOUR_MODES와 같은 값이어야 한다.
   *
   * `composite`가 지금까지의 동작이고 정확하다(포토샵 합성 모델 그대로).
   * `paste`는 잎을 알파 합성만 해서 빠르다 — 실측 한 뷰에서 145.5초 → 19.2초.
   * 대신 클리핑을 지키지 않아 색 그림이 갈릴 수 있다. 산출물인 검은 획은 같은
   * 뷰에서 1.09%만 달랐는데, 그 차이가 가짜 획인지 무해한지는 사람이 봐야
   * 하므로 당분간 고를 수 있게 둔다.
   */
  colourMode: "composite" | "paste";
  /**
   * 색 경계를 찾는 방법. `region`이 기본이다 — 색 그림을 평평한 색 영역으로 나눠
   * 라벨 경계를 두른다. `change`는 지금까지의 동작(중앙차분 + 비최대 억제)이고,
   * 그 두 단계가 획을 지글거리게 만들었다.
   *
   * 부풀리기 전 1px 마스크에서 `change`의 중심선은 끊기고 겹줄이 나는데 `region`은
   * 이어진 한 줄이다. 대신 `region`이 최종 경계 픽셀을 파일마다 +5~91% 더 그리고,
   * 그게 진짜 경계인지는 사람이 봐야 하므로 당분간 고를 수 있게 둔다.
   */
  edgeMode: "region" | "change";
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
