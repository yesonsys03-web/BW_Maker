# PSD Layer Tool — 설계 문서

날짜: 2026-07-30
상태: 설계 승인됨 (구현 계획 작성 전)

## 1. 목적

애니메이션 배경(BG) 작업용 PSD에서 규칙(예: 레이어명에 `line` 포함)에 맞는 레이어를 추출·편집해
새 PSD로 내보내는 데스크톱 앱. 기존에 수작업 스크립트(psd-tools + pytoshop 파이프라인)로 검증한
프로세스를 GUI로 제품화한다.

**사용자/배포**: 팀 아티스트에게 배포. macOS + Windows.
아티스트 PC에는 Python이 없다고 가정한다 — 처리 엔진을 앱에 동봉한다.

## 2. 요구사항

### 기능 요구사항
- PSD 파일을 열어 **원본의 전체 레이어 트리(그룹 포함, 모든 레이어명)** 표시.
- 규칙 기반 레이어 선택: 사용자 정의 규칙 + 프리셋 저장/재사용.
  - 예: "이름에 line 포함(대소문자 무시)", "`-`로 시작하는 그룹 제외".
- 레이어 편집(모두 비파괴, 내보내기 시 적용):
  - 선택 레이어 **병합(merge)** — 여러 레이어를 하나로, 새 이름 지정
  - **전체 flatten** — 포함된 레이어 전부를 한 장으로
  - **삭제**(내보내기 제외), **이름변경**, **순서변경**(드래그)
  - **표시/숨김 토글** + 합성 **미리보기** 실시간 반영
- 일괄 처리 (둘 다):
  - 여러 PSD 파일에 같은 프리셋을 적용해 자동 추출/병합/내보내기 (큐 + 진행률 + 결과 리포트)
  - 한 파일 안에서 다중 레이어 선택 후 일괄 병합/삭제/토글
- 결과물은 항상 **새 PSD 파일** (원본 절대 수정 안 함). 저장 위치·파일명은 **사용자가 선택**
  (저장 다이얼로그, 기본 제안: 원본 폴더 + 접미사 `_LINE`). 배치는 실행 전 출력 폴더 1회 선택.

### 비기능 요구사항
- 640MB급 PSD 처리 가능 (실측: 열기 수 초, 내보내기 ~1분).
- 에러는 fallback 없이 그대로 노출 — Python traceback 전문을 UI에 표시.
- 내보내기 직후 자동 검증(구조 + 픽셀 일치)으로 결과 신뢰성 보장.

### 논외 (Non-goals)
- 픽셀 편집(브러시, 지우개 등) 없음.
- PSD 원본 덮어쓰기 저장 없음.
- 16bit/CMYK 지원은 v1에서 명시적 에러로 거부 (RGB 8bit만).
- 조정 레이어·텍스트 레이어의 병합은 v1 논외 — 매치되면 명시적 에러.

## 3. 아키텍처

```
┌────────────────── Tauri v2 앱 ──────────────────┐
│  React + TypeScript UI (Vite)                    │
│    파일 패널 │ 레이어 트리 │ 미리보기 │ 배치 큐     │
│         │ tauri invoke (JSON)                    │
│  Rust 쉘 — 파일 다이얼로그, 사이드카 프로세스 관리    │
│         │ stdin/stdout, 줄 단위 JSON-RPC          │
│  Python 엔진 (PyInstaller onedir 사이드카)         │
│    psd-tools(읽기·합성) + pytoshop(쓰기)           │
└──────────────────────────────────────────────────┘
```

- **Python 엔진은 장수명 프로세스.** 앱 시작 시 1회 기동, 연 PSD를 세션(메모리)으로 유지.
- **IPC**: 요청/응답 모두 한 줄 JSON. 요청 `{id, method, params}`, 응답 `{id, result}` 또는
  `{id, error: {message, traceback}}`. 진행률은 `{event: "progress", ...}` 알림으로 스트리밍.
- **큰 바이너리(썸네일/미리보기)는 JSON에 넣지 않는다** — 엔진이 임시 디렉터리에 PNG로 쓰고
  경로만 반환. UI는 `convertFileSrc`로 로드.
- 검증된 기존 코드를 엔진에 이식: pytoshop RLE 인코더 패치(psd-tools C 확장 사용),
  유니코드 레이어명 NUL 종료 패치, 내보내기 후 검증 로직.

### 엔진 명령 (JSON-RPC method)

| method | params | result |
|---|---|---|
| `open_psd` | `{path}` | `{sessionId, width, height, colorMode, depth, tree}` |
| `close_session` | `{sessionId}` | `{}` |
| `render_thumbnails` | `{sessionId, layerIds, maxSize}` | `{thumbs: {layerId: pngPath}}` |
| `render_preview` | `{sessionId, visibleLayerIds, maxSize}` | `{pngPath}` |
| `export_psd` | `{sessionId, operations, outputPath, verify: true}` | `{outputPath, layerCount, verification}` |
| `batch_run` | `{paths, preset}` | `{results: [{path, ok, outputPath?, layerCount?, error?}]}` |
| `apply_preset` | `{sessionId, preset}` | `{matchedLayerIds, operations}` (미리 확인용) |

`tree`의 각 노드: `{id, name, kind(pixel|group|type|...), visible, blendMode, opacity,
bbox, hasMask, children?}`. `id`는 엔진이 트리 순회 순서로 부여하는 정수(세션 내 고정).

## 4. 편집 모델 — 비파괴 operation list

UI의 모든 편집은 원본을 건드리지 않고 작업 목록으로 쌓인다. undo = 목록에서 제거.
내보내기 시 엔진이 순서대로 적용해 새 PSD를 만든다.

```jsonc
{"op": "exclude",  "layerIds": [3, 7]}                  // 내보내기에서 제외(삭제)
{"op": "rename",   "layerId": 5, "name": "BG_line"}
{"op": "merge",    "layerIds": [2, 4, 6], "name": "merged_line"}  // 쌓임 순서대로 합성
{"op": "flatten",  "name": "flattened"}                 // 포함된 전체를 한 장으로
{"op": "reorder",  "layerId": 5, "aboveId": 2}          // 5를 2 바로 위로; aboveId null = 맨 아래로
```

- **merge 의미론**: 선택 레이어들을 원본 쌓임 순서·블렌드모드·불투명도로 psd-tools가 합성해
  투명 배경 위의 단일 normal 레이어로 만든다. Photoshop의 "레이어 병합"과 동일한 개념.
  (비 normal 블렌드 레이어가 최하단인 경우 Photoshop과 미세 차이가 있을 수 있음 — 문서화)
- 복사(비병합) 레이어도 내보내기 시 blend=normal, 불투명도 100%, visible로 기록된다(원본 블렌드/불투명도는 픽셀에 반영되지 않음 — 라인아트 추출 용도에 맞춘 의도된 동작).
- **flatten** = 포함된 모든 레이어 대상 merge.
- 레이어 마스크는 병합/추출 시 픽셀에 적용(오늘 파이프라인과 동일).
- 내보내기 기본 구조는 **평탄한 레이어 목록**(그룹 없이), 레이어명은 프리셋의 naming 규칙
  (`pathPrefix`: `FG R_bldg_LINE` 식 / `original`: 원본 이름, 중복 시 `_2` 접미사).

## 5. 프리셋 스키마

```jsonc
{
  "name": "line 추출",
  "include": {"type": "contains", "value": "line", "caseSensitive": false},
  // type: "contains" | "regex"
  "excludeGroupPrefixes": ["-"],
  "matchGroups": true,          // 매치된 그룹의 하위 픽셀 레이어 포함
  "merge": "none",              // "none" | "all"(전부 한 장) | "perGroup"(같은 부모 그룹의 매치 레이어끼리)
  "naming": "pathPrefix",       // "pathPrefix" | "original"
  "outputSuffix": "_LINE",
  "includeHidden": true,        // 원본에서 숨김 상태여도 매치되면 포함, 내보내기 시 visible 처리
  "embedPreview": true          // flattened 미리보기(흰 배경) 임베드
}
```

**출력 위치는 사용자가 선택한다.**
- 단일 내보내기: OS 저장 다이얼로그를 띄워 위치·파일명을 사용자가 정한다.
  기본값 제안: 원본 폴더 + `<원본이름><outputSuffix>.psd`.
- 배치 실행: 시작 전에 출력 폴더를 1회 선택한다(기본값 제안: 각 원본과 같은 폴더 유지 옵션 포함).
  파일명은 `<원본이름><outputSuffix>.psd`. 동명 파일이 있으면 실행 전에 목록으로 보여주고 일괄 확인.

프리셋은 앱 데이터 폴더(`appDataDir`)에 `presets.json`으로 저장.

## 6. UI 구성

- **좌측 — 파일 패널**: 드래그&드롭으로 PSD 추가. 파일별 상태 뱃지(대기/처리중/완료/실패).
  클릭하면 해당 파일 세션을 연다.
- **중앙 — 미리보기 캔버스**: 프록시 해상도(~1500px) 합성 결과. 줌/팬, 투명 영역 체커보드.
  토글/편집 시 디바운스 재렌더.
- **우측 — 레이어 트리**: 전체 트리, 그룹 접기/펴기. 규칙 매치 하이라이트.
  체크박스 = 내보내기 포함, 눈 아이콘 = 미리보기 표시. Shift/Cmd 다중 선택,
  우클릭 메뉴(병합/삭제/이름변경). 순서변경 드래그는 트리가 아니라 **내보내기
  다이얼로그의 평탄한 내보내기 목록**에서 수행한다(순서는 내보내기 목록의 속성,
  트리는 원본 구조 보존).
- **상단 툴바**: 프리셋 선택/저장, 규칙 편집 다이얼로그, 내보내기, 배치 실행.
- **하단 — 작업 히스토리**: operation list 표시, 개별 취소.

## 7. 에러 처리

- 엔진의 모든 예외는 traceback 전문과 함께 JSON error로 반환, UI 에러 패널에 그대로 표시.
  **조용한 fallback·에러 흡수 금지** (팀 방침).
- 미지원 입력(16bit, CMYK, 조정/텍스트 레이어 병합 시도)은 명시적 에러 + 이유.
- 배치 중 개별 파일 실패는 큐를 멈추지 않고 결과 리포트에 실패로 기록(traceback 포함).
- **내보내기 후 자동 검증**: 캔버스 크기/레이어 수/이름/위치 + 병합하지 않은 레이어의
  원본 대비 픽셀 일치(RGBA 완전 비교). 검증 실패 시 성공으로 표시하지 않는다.
- 사이드카 프로세스 사망 시: UI에 명확히 표시하고 재시작 버튼 제공(자동 재시작 안 함).

## 8. 성능

- 프록시 미리보기·썸네일은 세션 캐시(파일당 1회 생성).
- 진행률: 엔진이 단계별(열기/레이어 추출/합성/쓰기/검증) 이벤트 스트리밍.
- 메모리: 세션은 LRU로 최대 2개 유지(640MB 파일 × 다수 동시 오픈 방지).
  배치는 파일당 열고-처리하고-닫는 순차 실행.

## 9. 테스트

- **엔진(pytest)**:
  - 프로그램 생성 소형 PSD 픽스처로 각 op(merge/flatten/exclude/rename/reorder) 라운드트립.
  - 마스크 적용, 이름 중복 처리, 프리셋 매칭 규칙 단위 테스트.
  - 실파일 통합 테스트(오늘 검증 스크립트 이식) — 로컬 전용, CI 제외.
- **UI**: operation list 리듀서/프리셋 매칭 미리보기 로직 단위 테스트(vitest).
- **패키징**: macOS/Windows 빌드 각 1회 스모크(열기→추출→내보내기→검증 통과).

## 10. 프로젝트 구조 · 패키징

```
psd_line_export/
  src/                # React + TS (Vite)
  src-tauri/          # Rust 쉘, tauri.conf.json (sidecar 등록)
  engine/             # Python 엔진 (uv 프로젝트)
    engine.py         # JSON-RPC 루프
    psd_ops.py        # 열기/합성/병합/내보내기/검증
    tests/
    pyinstaller.spec
  docs/superpowers/specs/
```

- 사이드카: PyInstaller **onedir** 빌드(기동 속도 우선), Tauri `externalBin`으로 동봉.
- macOS는 codesign/notarize, Windows는 서명 선택. CI(GitHub Actions)에서 양 OS 빌드.

## 11. 리스크와 대응

| 리스크 | 대응 |
|---|---|
| pytoshop 유지보수 중단 상태 | 이미 검증된 2개 패치로 커버, 엔진 테스트로 회귀 방지 |
| 비 normal 블렌드 병합의 Photoshop 미세 차이 | 문서화 + 검증 단계에서 병합 레이어는 구조만 검증 |
| PyInstaller 오탐(백신) | Windows 서명 또는 팀 내 예외 등록 안내 |
| 640MB×다중 세션 메모리 | 세션 LRU 2개 제한, 배치는 순차 처리 |
