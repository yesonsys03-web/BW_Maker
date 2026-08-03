# 레이어 solo — 설계 문서

날짜: 2026-08-03
상태: 설계 승인됨 (구현 계획 작성 전)

## 1. 문제

이름이 `line`인데 실제로는 채움인 레이어가 있다. `HuskCasino`의 `BG/FLOOR/line`이 그렇다 —
알파가 bbox를 100% 덮는 보라색 채움이고, 이름만으로는 진짜 라인과 구분할 방법이 없다.
이런 것은 결국 **눈으로 봐야** 판정된다.

그런데 지금 미리보기에서 한 장만 보려면 나머지를 전부 꺼야 한다. 👁 토글
(`previewHiddenIds`)은 빼기만 할 수 있고, 수백 장짜리 트리에서 그것은 쓸 수 없다.

툰붐 하모니에는 이 용도의 solo가 있고, 작업자가 이미 그 동작에 익숙하다.

## 2. 동작

**solo가 하나라도 걸려 있으면, 미리보기는 solo된 것만 그린다.** 하나도 없으면 지금과
완전히 같다.

```
soloIds 비어있음  →  included && !hidden      (현재 동작 그대로)
soloIds 있음      →  soloIds에 든 것만
```

두 갈래 모두 **pixel leaf만** 내놓는다. 그릴 수 있는 것이 그것뿐이라 지금도 그렇고, solo가
그 제약을 풀어주지는 않는다. `soloIds`에 pixel이 아닌 id가 섞여 들어와도 결과에 나타나지
않으므로 별도 방어가 필요 없다.

**solo는 체크박스와 숨기기를 둘 다 무시한다.** 체크 안 된 레이어도, 숨겨둔 레이어도 solo하면
보인다. 그래야 "이게 라인인가?"를 확인하고 나서 체크하는 흐름이 성립한다 — 무시하지 않으면
체크 안 된 레이어를 solo했을 때 빈 화면이 나와서 기능이 무의미해진다. 하모니의 solo도 내보내기
선택과 무관한 순수 보기 기능이다.

**여러 장을 동시에 solo할 수 있다.** 라인 후보 몇 장을 한꺼번에 비교하거나, 그룹과 그 안의 한
장을 같이 보는 것이 된다.

**비파괴다.** solo를 걸어도 `previewHiddenIds`는 그대로 남아 있고, solo를 전부 풀면 공들여
만든 숨기기 조합이 그대로 돌아온다. 이것이 "solo를 켤 때 숨기기를 초기화한다"를 기각한 이유다.

**내보내기에는 전혀 영향이 없다.** `includedIds`·`ops`·`entries`를 건드리지 않는다. solo는
화면에만 사는 상태다.

## 3. 상태

파일별 ops 상태에 `soloIds: number[]`를 더한다. `previewHiddenIds`와 나란히 있는 형제이며,
서로 독립이다.

새 액션 둘:

- `toggleSolo(layerId)` — leaf 하나를 solo 집합에 넣고 뺀다
- `setSolo(layerIds, solo)` — 여러 id를 한꺼번에 (그룹 버튼과 "solo 해제"가 쓴다)

`previewHiddenIds`가 이미 이 두 모양(`togglePreview` / `setPreviewHidden`)을 갖고 있으므로 그
관례를 그대로 따른다.

## 4. UI

**행마다 solo 버튼 하나.** 체크박스와 👁 사이에 놓는다. 그룹 행에도 같은 자리에 놓아, 하위
pixel leaf 전부를 한꺼번에 solo한다 — 지금 그룹 👁이 하는 방식 그대로다. 하위가 전부 solo면
켜진 상태로 보이고, 그 상태에서 누르면 전부 풀린다. 일부만 solo면 꺼진 상태로 보이고, 누르면
전부 solo된다.

pixel이 아닌 leaf(조정 레이어, 텍스트 등)에는 체크박스가 이미 비활성이다. solo 버튼도 같이
비활성으로 둔다 — 눌러도 미리보기가 바뀌지 않으므로 눌리는 것처럼 보이면 안 된다.

**툴팁은 "이 레이어만 보기"** (그룹은 "이 그룹만 보기"). 작업자가 요청한 문구다.

**"solo 해제" 버튼**을 레이어 패널 상단에 둔다. solo가 하나라도 걸려 있을 때만 나타난다 —
여러 장을 solo해두고 어디를 껐는지 잊었을 때 빠져나올 구멍이다. 평소에는 자리를 차지하지 않는다.

행은 이미 `[접기][체크박스][👁][썸네일][이름]`으로 빽빽하다. 버튼이 하나 더 붙는 것은
감수하되, 아이콘은 👁과 확실히 달라야 한다(예: `◉`). 두 개가 헷갈리면 기능이 서로를 방해한다.

## 5. 지속성

solo는 세션 한정이다. 파일을 닫았다 열면 사라진다. 저장할 이유가 없다 — 판정하는 동안만 쓰는
상태이고, 남아 있으면 다음에 열었을 때 "왜 한 장만 보이지?"가 된다.

다만 **파일을 오가는 동안에는 유지된다.** `previewHiddenIds`가 파일별로 사는 것과 같은
자리에 두므로, 다른 파일을 봤다 돌아와도 그대로다.

## 6. 변경 범위

- `src/lib/preview.ts` — `visibleIdsForPreview`가 `soloIds`를 받는다
- `src/lib/opsReducer.ts` — `toggleSolo` / `setSolo`
- `src/state/appStore.tsx` — `OpsState.soloIds`, 액션, 컨텍스트 노출
- `src/components/LayerTree.tsx` — 행마다 solo 버튼, 그룹 버튼, "solo 해제"
- `src/components/PreviewCanvas.tsx` — `soloIds`를 넘긴다
- `src/App.tsx` — `soloIds`를 내려보낸다
- `src/App.css` — solo 버튼 스타일

`EMPTY_OPS`와 `initialOpsFor`에도 `soloIds: []`를 더한다.

## 7. 테스트

**`src/lib/preview.test.ts`**
- solo가 비어 있으면 결과가 지금과 동일
- solo가 있으면 solo된 것만
- solo가 체크박스를 무시한다 — 체크 안 된 leaf를 solo하면 그것이 나온다
- solo가 숨기기를 무시한다 — 숨긴 leaf를 solo하면 그것이 나온다
- 문서 순서가 유지된다

**`src/lib/opsReducer.test.ts`**
- `toggleSolo`가 넣고 뺀다
- `setSolo`가 여러 id를 한꺼번에 처리한다
- solo를 걸었다 풀어도 `previewHiddenIds`가 변하지 않는다 (비파괴)

**`src/state/appStore.test.ts`**
- solo가 파일별로 산다 — 다른 파일로 갔다 와도 유지되고, 파일끼리 섞이지 않는다

## 8. 논외

- solo 상태를 디스크에 저장하는 것
- 키보드 단축키
- 👁 Alt+클릭 같은 대체 조작 (버튼 하나로 충분한지 먼저 써보고 정한다)
- solo된 레이어를 내보내기에 반영하는 것 — solo는 보기 전용이라는 것이 이 설계의 전제다
