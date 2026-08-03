# 라인 레이어 판별 규칙 — 설계 문서

날짜: 2026-08-03
상태: 설계 승인됨 (구현 계획 작성 전)

## 1. 문제

프리셋 `contains "line"` + `matchGroups: true`가 라인이 아닌 레이어를 대량으로 포함시킨다.
사용자가 화면에서 직접 발견한 것만 세 종류다.

1. `lines` 그룹이 이름으로 걸리면서 그 안의 `fill` / `white` / `heart` / `GRAD_MULTIPLY` /
   `GRAIN_OVERLAY` / `B` / `h`까지 전부 체크됨. 정작 그 그룹의 진짜 라인은 `lines` leaf 하나뿐.
2. `line col`, `LINE_COL`, `Line Colour` — 이름에 line이 있지만 색 지정 레이어다.
3. `Layer 866 (LINEAR DODGE)`, `Linear Light`, `Linear dodge 75%` — **"LINEAR"의 앞 네 글자**가
   부분 문자열로 걸렸다.

원인은 `engine/psd_engine/matching.py`의 두 곳이다. `_name_matches`의 `contains`가 부분 문자열
검사라는 점(3번), 그리고 `match_preset`의 `inside_matched_group`이 이름으로 걸린 그룹의 자손을
무조건 포함시킨다는 점(1번)이다. 2번은 이름만으로는 구분할 수 없어 새 신호가 필요하다.

## 2. 근거 데이터

규칙은 추측이 아니라 실제 납품 파일에서 뽑았다. `HH0306/Design/COLOR/BG/02_Color`의 PSD 25개를
psd-tools로 열어 현재 규칙에 걸리는 leaf 전부(740건)를 덤프하고, 후보 규칙을 그 740건에 대고
검증했다. 재현 스크립트는 이 문서의 부록에 요지를 남긴다.

> **이 절과 4절의 절대 수치에 대한 정정 (구현 후 실측으로 확인).** 덤프 스크립트가 기본
> 프리셋의 `excludeGroupPrefixes: ["-"]`를 적용하지 않아, 엔진이 애초에 방문하지 않는
> `-BGCU`(47건)·`-LayOut`(19건) 아래 leaf 66건까지 후보에 넣고 셌다. 규칙별 **효과**는
> 아래 수치 그대로지만, 기본 프리셋 전체를 적용한 엔진의 참값은 다르다:
> **포함 587건, `groupHasOwnLine` 55, `excludedToken` 18, `notLineWord` 5, `blendMode` 5,
> `noPixels` 4.** 대사는 정확히 맞는다 — `645 − 54 = 591 = 587 + 4`, `67 − 12 = 55`.
> 자세한 대조는 구현 계획의 Task 9에 있다.

| | 건수 |
|---|---|
| 현재 규칙이 포함하는 leaf | 740 |
| ─ 자기 이름으로 걸린 것 | 670 |
| ─ 그룹 때문에만 걸린 것 | 70 |

핵심 관찰:

- **자기 이름으로 걸린 670건 중 659건이 blend=normal이고, normal이 아닌 11건은 전부 오탐이다**
  (`LINE WIN` overlay ×5, `Line Colour` overlay ×2, LINEAR 계열 ×4).
- 그룹 때문에만 걸린 70건 중 **67건은 그 그룹 안에 이미 자기 이름으로 걸린 leaf가 있다.**
- `LINE WIN`은 렌더해 확인했다: **순백색(255,255,255) 단색 6,629픽셀, overlay 합성.**
  창문에 빛줄기를 얹는 하이라이트 패스이지 라인 아트가 아니다. 같은 그룹의 `LINE BLD`
  (blend normal)가 진짜 라인이다.

기각한 후보도 남긴다. **조상 그룹의 색 토큰**(`... / MG BLD 01 COL / LINE WIN`)은 신호로 쓸 수
없다. 이 파일들은 색 작업 PSD라 루트 그룹부터가 `BGCOLOR`(177건) / `BG Color` / `COLOUR`이고,
`COLOR` 그룹 안에 진짜 `LINE`·`HANDLE LINE`이 들어있는 경우도 7건 있다.

## 3. 규칙

규칙 ①②는 leaf가 **후보로 잡히는지**를 정하고, ③④는 그렇게 잡힌 **모든 후보 leaf**에
적용된다 — 자기 이름으로 걸렸든 그룹이 끌어왔든 똑같이 본다.

### 규칙 ① 토큰 매칭 — `include.type == "contains"`의 기본 동작 변경

`contains`를 부분 문자열이 아니라 **토큰 단위**로 본다. 토큰 구분자는 세 가지다.

- 비영숫자 — `_`, `-`, 공백, 괄호 …
- camelCase 경계 — `CurtainsLine` → `Curtains` + `Line`
- 글자↔숫자 경계 — `line2` → `line` + `2`

이름의 토큰 열에 검색값의 토큰 열이 **연속으로** 나타나면 매치다. 토큰 비교는
`include.caseSensitive`를 따르고, **끝의 `s`를 허용**한다(`line` → `LINES`, 103건).
검색값이 토큰을 하나도 만들지 못하면(예: `"-"`) 기존 부분 문자열 검사로 되돌아간다.
`include.type == "regex"`는 손대지 않는다 — 순수 부분 문자열이 필요하면 그쪽을 쓴다.

`\blines?\b` 같은 단순 정규식으로는 안 되는 이유를 못박아 둔다. 정규식 `\b`는 `_`에서 끊기지
않아서 `Wall_Line`, `Ring_Line`, `Chair_Line`, `Bookcase_Line`, `TopWindowArches_line`,
`CurtainsLine`, `line2` 같은 **진짜 라인 43건이 같이 날아간다.** `_`와 camelCase와 숫자 경계를
구분자로 쳐야 이것들이 살아남는다.

효과: **-5건** (`Layer 866 (LINEAR DODGE)`, `Linear Light`, `Linear Light 50%`,
`Linear dodge 75%`, `kline col`). 진짜 라인 손실 0.

### 규칙 ② 그룹 규칙 — `matchGroups`의 의미 변경

그룹이 이름으로 걸렸을 때, **그 하위 트리에 자기 이름으로 걸리는 leaf가 하나라도 있으면
일괄 포함을 하지 않는다.** 하나도 없을 때만 지금처럼 하위 전체를 끌어온다.

`matchGroups`의 원래 목적은 그대로 살아있다 — `CHAIR1_LINE` 그룹의 자식이 `1`, `2`, `3`처럼
아무 단서가 없을 때 끌어오는 것. 안쪽에 이미 `lines` leaf가 있으면 그룹 규칙이 더할 것이 없다.

판정은 매치된 그룹마다 자기 하위 트리를 대상으로 하고, 그 결정은 해당 하위 트리에 적용된다.
바깥 그룹이 걸렸는데 깊은 곳에만 자기 이름 매치가 있으면 그 사이의 단서 없는 leaf들이 빠질 수
있다 — 알려진 한계이며, 실제 25개 파일에서는 발생하지 않았다.

효과: **-67건** (그룹 때문에만 걸린 70건 중). 스크린샷의 `fill`/`white`/`heart`/
`GRAD_MULTIPLY`/`GRAIN_OVERLAY`/`B`/`h`가 전부 여기서 빠진다.

### 규칙 ③ 제외 토큰 — 새 프리셋 필드 `excludeTokens`

leaf **자기 이름**의 토큰에 제외 토큰이 있으면 뺀다. 기본값 `["col", "colour", "color"]`,
비교는 규칙 ①과 같다(대소문자 무시 + 끝의 `s` 허용). 조상 그룹 이름은 **보지 않는다**(2절 참조).

프리셋 필드로 두는 이유는 새 오탐 어휘가 나오면 프리셋 다이얼로그에서 추가할 수 있어야 하기
때문이다. 다른 세 규칙과 달리 이것만 어휘에 의존한다.

효과: **-18건** (`line col` 7, `Line Colour` 4, `LINE_COL` 3, `line colour` 2, `LINE COL` 1,
`Wall_Line_Col` 1).

### 규칙 ④ blend ≠ normal 제외 — 기본 동작

합성 모드가 normal이 아닌 leaf는 라인 아트가 아니다. `tree.py`가 이미 `blendMode`를 싣고
있으므로 `match_preset`이 그대로 읽는다. 필드가 없는 옛 트리는 `normal`로 본다.

라인을 multiply로 깔고 작업하는 파일이 나중에 들어오면 이 규칙이 그것을 놓친다. 25개 파일에는
그런 예가 하나도 없었고(생존자 645건 전원 normal), 빠진 이유가 화면에 남으므로 감수한다.

효과: **-5건** (`LINE WIN`).

## 4. 누적 효과

| | |
|---|---|
| 현재 규칙 | 740건 포함 |
| ① 토큰 매칭 | −5 |
| ② 그룹 규칙 | −67 |
| ③ 제외 토큰 | −18 |
| ④ blend | −5 |
| **최종** | **645건 (오탐 95건 제거, 진짜 라인 손실 0, 생존자 전원 blend=normal)** |

이 표는 `-` 접두사 그룹을 빼지 않은 후보 740건 기준이다(2절의 정정 참조). 기본 프리셋을
그대로 적용한 엔진의 실측은 **587건**이고, 규칙별 제거는 55 / 18 / 5 / 5 + `noPixels` 4다.

남는 오탐 3건은 이름으로는 단서가 없다 — 그 그룹에 자기 이름 매치가 아예 없어서 규칙 ②가
개입할 수 없다.

- `TABLE / FLAT DESIGN / lines / CLUB PAW PRINT`
- `TABLE / FLAT DESIGN / lines / CRAPS DESING`
- `Artwork / Front View / Bar / AppleShelfBar / bottles / line / glow`

## 5. 빠진 이유의 보고

엔진의 기존 `skipped` 채널을 재사용해 규칙별 사유를 함께 돌려준다.
새 사유: `notLineWord`(①), `groupHasOwnLine`(②), `excludedToken`(③), `blendMode`(④).

**다만 이것들을 지금의 오류 카드에 띄우면 안 된다.** `App.tsx`는 대량 로드가 끝나면 skipped를
모아 "그릴 픽셀이 없어 뺀 레이어 N개" 카드를 띄우는데, 25개 파일 기준 95건이 매번 거기 뜨면
그 카드가 경고하려던 진짜 오류가 묻힌다. 규칙으로 **의도해서** 뺀 것은 이상 징후가 아니다.

따라서 `appStore.tsx`의 필터를 거부 목록(`reason !== "text"`)에서 **허용 목록**
(`reason === "noPixels"`)으로 바꾼다. 새 사유들은 엔진 응답에 남아 테스트와 디버깅에서 쓰이되
카드를 띄우지 않는다.

레이어 행에 "왜 빠졌는지" 툴팁을 다는 것은 **이번 범위 밖**이다.

## 6. 변경 범위

**엔진**
- `engine/psd_engine/matching.py` — 토크나이저 추가, `_name_matches` 토큰 매칭,
  `match_preset`의 그룹 규칙 · `excludeTokens` · blend 판정, 새 skip 사유 상수.

**프론트엔드**
- `src/lib/types.ts` — `Preset.excludeTokens: string[]`
- `src/lib/presets.ts` — `DEFAULT_PRESET`에 기본값, `validatePreset`에서 검증
  (없으면 기본값 — `roleTokens`/`splitLayers`와 같은 하위 호환 처리)
- `src/components/PresetDialog.tsx` — 제외 토큰 입력 UI
- `src/lib/engine.ts` — `SkippedLayer.reason` 유니온 확장
- `src/state/appStore.tsx` — skipped 필터를 허용 목록으로
- `src/lib/layerFilter.ts` — `LINE_NAME_FALLBACK`의 `.includes("line")`도 같은 토큰 매칭으로
  (프리셋 적용 전 "라인만" 패널이 화면과 다른 규칙을 쓰면 안 된다)

토크나이저는 엔진과 프론트엔드 양쪽에 존재한다. `DEFAULT_ROLE_TOKENS`가 이미 그런 것처럼
서로를 가리키는 주석을 단다.

## 7. 하위 호환

`contains`의 의미가 저장된 모든 프리셋에서 바뀐다. 의도한 변경이다 — 부분 문자열 매칭은
`OL`이 `GOLD`에 걸리는 것과 같은 종류의 오탐을 계속 만든다. 순수 부분 문자열이 필요하면
`regex` 타입이 그대로 있다.

`excludeTokens`가 없는 옛 `presets.json`은 기본값으로 읽는다. 즉 기존 프리셋도 색 토큰 제외를
받는다 — "기본 동작으로 넣는다"는 결정에 따른 것이다.

## 8. 테스트

**엔진** (`engine/tests/test_matching.py`)
- 토큰 매칭: `Wall_Line` / `Ring_Line` / `CurtainsLine` / `line2` / `LINES` / `line ol` 통과,
  `LINEAR DODGE` / `Linear Light` / `kline col` 탈락
- 토큰을 못 만드는 검색값은 부분 문자열로 되돌아감
- `caseSensitive: true`에서 토큰 비교가 대소문자를 지킴
- 그룹 규칙 양쪽 분기: 자기 이름 매치가 있는 그룹 / 없는 그룹
- 기존 `test_matched_group_pulls_descendants`는 새 동작에 맞게 갱신
- `excludeTokens` 기본값과 사용자 지정값
- blend가 normal이 아닌 leaf 제외, `blendMode` 없는 옛 트리는 통과
- 각 규칙이 올바른 skip 사유를 돌려줌

**프론트엔드**
- `src/lib/presets.test.ts` — `excludeTokens` 없는 파일이 기본값으로 읽히고, 배열이 아니면 거부
- `src/lib/layerFilter.test.ts` — 폴백 라인 판정이 엔진과 같은 결과
- `src/state/appStore.test.ts` — 규칙 기반 skip 사유가 오류 카드로 올라가지 않음

**회귀 검증**
25개 실파일 덤프에 대해 최종 645건 / 사유별 5·67·18·5가 재현되는지 확인한다.

## 부록 — 데이터 재현

1. `psd_tools.PSDImage.open`으로 `02_Color/*.psd`를 열고, 현재 규칙
   (`contains "line"`, `matchGroups: true`)에 걸리는 leaf를 전부 덤프한다.
   각 행에 이름·경로·kind·blendMode·opacity·visible·hasPixels·자기이름매치여부·끌어온 그룹을 담는다.
2. 후보 규칙을 그 덤프에 적용해 제거·생존 건수와 실제 이름을 센다.
3. 판단이 갈리는 레이어는 `psd_engine.render.extract_rgba`로 렌더해 눈으로 확인한다
   (`LINE WIN`은 흰 배경에서 안 보여 회색 배경에 올려 순백색 단색임을 확인했다).
