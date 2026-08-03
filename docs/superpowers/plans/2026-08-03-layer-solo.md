# 레이어 solo 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 레이어 패널에서 한 장(또는 여러 장)만 골라 미리보기에 띄우는 solo 토글 — 이름만으로는 라인인지 채움인지 알 수 없는 레이어를 눈으로 판정하기 위해.

**Architecture:** `previewHiddenIds` 옆에 `soloIds`를 나란히 두고, 미리보기 가시성 규칙 한 곳(`visibleIdsForPreview`)에서 분기한다. solo가 비어 있으면 지금과 완전히 같고, 하나라도 있으면 solo된 것만 그린다. 상태·액션·UI 모두 `previewHiddenIds`가 이미 쓰는 모양을 그대로 따라간다.

**Tech Stack:** TypeScript + React + Vite (vitest). 엔진(Python)은 건드리지 않는다 — solo는 순수 프론트엔드 상태다.

**설계 문서:** `docs/superpowers/specs/2026-08-03-layer-solo-design.md`

## Global Constraints

- **solo는 미리보기 전용이다.** `includedIds`·`ops`·`entries`를 절대 건드리지 않는다. 내보내기 결과가 solo에 따라 달라지면 그것은 버그다.
- **비파괴다.** solo를 걸고 푸는 동안 `previewHiddenIds`는 변하지 않는다. 전부 풀면 숨기기 조합이 그대로 돌아와야 한다.
- **solo는 체크박스와 숨기기를 둘 다 무시한다.** 체크 안 된 leaf도, 숨긴 leaf도 solo하면 보인다.
- **여러 장 동시 solo가 기본이다.** 새로 solo해도 기존 solo는 유지된다.
- **주석은 한국어로, "무엇"이 아니라 "왜"를 쓴다.** 기존 코드 관례다.
- **`tsconfig.json`에 `noUnusedLocals`/`noUnusedParameters`가 켜져 있다.**
- **커밋 메시지**: `feat:` / `test:` / `refactor:` 접두사 + 소문자 설명문. 트레일러를 반드시 붙인다:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Ltm3qkFkyb9oANqu3A2HRc
  ```
- **브랜치**: `feat/line-layer-matching`에 이어서 커밋한다(설계 문서가 이미 거기 있다).
- **기준선**: 프론트엔드 15파일 / 261 테스트 통과, `tsc --noEmit` 클린. 엔진은 이 계획과 무관하다.
- **테스트 실행**: `npx vitest run <파일>` (집중), `npm test` (전체), `npx tsc --noEmit` (타입).

## 파일 구조

| 파일 | 이 계획에서 맡는 것 |
|---|---|
| `src/lib/preview.ts` (수정) | `visibleIdsForPreview`가 `soloIds`를 받아 분기한다. 가시성 규칙이 사는 유일한 자리. |
| `src/lib/preview.test.ts` (수정) | 기존 8개 호출부에 인자 추가 + solo 규칙 테스트 |
| `src/lib/opsReducer.ts` (수정) | `OpsState.soloIds`, `toggleSolo` / `setSolo` 액션 |
| `src/lib/opsReducer.test.ts` (수정) | 토글·일괄·비파괴 테스트 |
| `src/state/appStore.tsx` (수정) | 파일별 상태에 배선, 컨텍스트로 노출 |
| `src/state/appStore.test.ts` (수정) | 파일별로 따로 산다는 테스트 |
| `src/lib/previewCache.ts` (수정) | `previewRenderSpec`이 `soloIds`를 받아 규칙에 넘긴다. 캐시 키는 `visibleIds`에서 파생되므로 자동으로 solo를 반영한다. |
| `src/lib/previewCache.test.ts` (수정) | 호출부 6곳에 인자 추가 |
| `src/components/PreviewCanvas.tsx` (수정) | `soloIds`를 규칙에 넘긴다 |
| `src/App.tsx` (수정) | `soloIds`와 핸들러를 내려보낸다 (화면용 · 미리 렌더용 두 자리) |
| `src/components/LayerTree.tsx` (수정) | 행마다 solo 버튼, 그룹 버튼, "solo 해제" |
| `src/App.css` (수정) | solo 버튼 스타일 |

새 파일은 없다. solo는 기존 미리보기 상태에 얹히는 것이라 새 모듈을 만들면 오히려 규칙이 두 군데로 갈라진다.

---

### Task 1: 가시성 규칙에 solo 분기

**Files:**
- Modify: `src/lib/preview.ts:8-36` (`visibleIdsForPreview`)
- Test: `src/lib/preview.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `visibleIdsForPreview(tree: TreeNode[], includedIds: number[], previewHiddenIds: number[], soloIds: number[]): number[]` — 네 번째 인자는 **필수**다. 옵셔널로 두면 호출부가 빠뜨려도 컴파일이 통과해 기능이 조용히 죽는다.

- [ ] **Step 1: 기존 8개 호출부에 `[]`를 더한다**

`src/lib/preview.test.ts`의 `visibleIdsForPreview(...)` 호출 8개 모두에 네 번째 인자 `[]`를 붙인다. 예:

```ts
test("all included and not preview-hidden yields every pixel leaf in document order", () => {
  expect(visibleIdsForPreview(tree, [1, 2, 5, 7, 8], [], [])).toEqual([1, 2, 5, 7, 8]);
});
```

나머지 7개(줄 48, 52, 56, 60, 65, 69, 73)도 같은 방식으로 `, []`를 더한다. **기대값은 하나도 바꾸지 않는다** — solo가 비면 동작이 같아야 한다는 것이 이 태스크의 핵심 계약이다.

- [ ] **Step 2: 실패하는 새 테스트를 쓴다**

`src/lib/preview.test.ts`에 덧붙인다. 파일 위쪽의 기존 `tree` 픽스처를 쓴다(pixel leaf는 문서 순서로 1, 2, 5, 7, 8이고, 4는 non-pixel, 3·6은 그룹이다).

```ts
// --- solo (설계 문서 2절) ---

test("solo shows only the soloed leaves", () => {
  expect(visibleIdsForPreview(tree, [1, 2, 5, 7, 8], [], [2, 7])).toEqual([2, 7]);
});

// solo는 "이것만 보여달라"는 뜻이지 "내보낼 것 중에서 고른다"가 아니다. 아직
// 체크하지 않은 레이어가 라인인지 확인하는 것이 이 기능의 목적이다.
test("solo ignores the include checkbox", () => {
  expect(visibleIdsForPreview(tree, [], [], [5])).toEqual([5]);
});

test("solo ignores the eye toggle", () => {
  expect(visibleIdsForPreview(tree, [1, 2, 5, 7, 8], [5], [5])).toEqual([5]);
});

test("solo still yields document order, not the order they were soloed", () => {
  expect(visibleIdsForPreview(tree, [1, 2, 5, 7, 8], [], [8, 1])).toEqual([1, 8]);
});

// 그릴 수 있는 것은 pixel leaf뿐이라는 제약은 solo가 풀어주지 않는다.
test("solo cannot conjure a non-pixel leaf into the preview", () => {
  expect(visibleIdsForPreview(tree, [], [], [4])).toEqual([]);
});

test("a solo id that is not in the tree is simply absent", () => {
  expect(visibleIdsForPreview(tree, [1, 2], [], [99])).toEqual([]);
});
```

- [ ] **Step 3: 실패를 확인한다**

Run: `npx vitest run src/lib/preview.test.ts`
Expected: 새 테스트 6개 FAIL(네 번째 인자를 아직 안 읽으므로 solo가 무시된다). 기존 8개는 PASS.

- [ ] **Step 4: 구현한다**

`src/lib/preview.ts`의 `visibleIdsForPreview`를 통째로 바꾼다. 주석도 새 동작에 맞게 고친다:

```ts
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
```

- [ ] **Step 5: 통과를 확인한다**

Run: `npx vitest run src/lib/preview.test.ts && npx tsc --noEmit`
Expected: preview 테스트 전부 PASS. `tsc`는 인자가 3개라고 **두 곳**에서 에러를 낸다 — `src/components/PreviewCanvas.tsx:122`와 `src/lib/previewCache.ts:24`. 둘 다 **정상이며 Task 4가 고친다.** 그 둘 말고 다른 에러가 나오면 멈추고 보고한다.

`previewCache.ts`는 놓치기 쉬운 두 번째 호출부다. 미리보기를 미리 렌더해 캐시에 담는 경로이고, 캐시 키가 `visibleIds`에서 파생되므로 solo가 자동으로 키에 반영된다 — 따로 키를 손댈 필요는 없지만 인자는 넘겨줘야 한다.

- [ ] **Step 6: 커밋**

```bash
git add src/lib/preview.ts src/lib/preview.test.ts
git commit -m "$(cat <<'EOF'
feat: let the preview show only what is soloed

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltm3qkFkyb9oANqu3A2HRc
EOF
)"
```

---

### Task 2: `soloIds` 상태와 액션

**Files:**
- Modify: `src/lib/opsReducer.ts:12-25` (`OpsState`, `OpsAction`), `:283-299` (`opsReducer`)
- Test: `src/lib/opsReducer.test.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `OpsState.soloIds: number[]`
  - 액션 `{ type: "toggleSolo"; layerId: number }`
  - 액션 `{ type: "setSolo"; layerIds: number[]; solo: boolean }`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/lib/opsReducer.test.ts` 맨 아래에 덧붙인다. 파일 위쪽에 이미 있는 초기 상태 만드는 방식을 그대로 따르되, 없으면 아래처럼 직접 만든다:

```ts
// --- solo (설계 문서 3절) ---

const soloBase: OpsState = {
  includedIds: [1, 2, 3],
  previewHiddenIds: [2],
  soloIds: [],
  ops: [],
  entries: [],
};

test("toggleSolo adds a leaf, then removes it", () => {
  const on = opsReducer(soloBase, { type: "toggleSolo", layerId: 1 });
  expect(on.soloIds).toEqual([1]);
  const off = opsReducer(on, { type: "toggleSolo", layerId: 1 });
  expect(off.soloIds).toEqual([]);
});

test("toggleSolo keeps earlier solos — several layers can be soloed at once", () => {
  const one = opsReducer(soloBase, { type: "toggleSolo", layerId: 1 });
  const two = opsReducer(one, { type: "toggleSolo", layerId: 3 });
  expect(two.soloIds).toEqual([1, 3]);
});

test("setSolo turns a whole group on and off in one action", () => {
  const on = opsReducer(soloBase, { type: "setSolo", layerIds: [1, 2, 3], solo: true });
  expect(on.soloIds).toEqual([1, 2, 3]);
  const off = opsReducer(on, { type: "setSolo", layerIds: [1, 2, 3], solo: false });
  expect(off.soloIds).toEqual([]);
});

test("setSolo does not duplicate ids that are already soloed", () => {
  const one = opsReducer(soloBase, { type: "toggleSolo", layerId: 2 });
  const many = opsReducer(one, { type: "setSolo", layerIds: [1, 2], solo: true });
  expect(many.soloIds).toEqual([2, 1]);
});

// 비파괴가 이 기능의 전제다 — solo를 풀면 공들여 만든 숨기기 조합이 그대로
// 돌아와야 한다.
test("solo never disturbs the eye toggles or the export state", () => {
  const on = opsReducer(soloBase, { type: "setSolo", layerIds: [1, 3], solo: true });
  const off = opsReducer(on, { type: "setSolo", layerIds: [1, 3], solo: false });
  expect(off.previewHiddenIds).toEqual([2]);
  expect(off.includedIds).toEqual([1, 2, 3]);
  expect(off.ops).toEqual([]);
  expect(off.entries).toEqual([]);
});
```

`OpsState`를 import 하고 있지 않으면 파일 위쪽 import에 `type OpsState`를 더한다.

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/lib/opsReducer.test.ts`
Expected: FAIL — `soloIds`가 `OpsState`에 없어 타입 에러가 나고, 새 액션들이 `default` 분기로 떨어져 상태가 그대로 돌아온다.

- [ ] **Step 3: 구현한다**

`src/lib/opsReducer.ts`의 `OpsState`에 필드를 더한다 (`previewHiddenIds` 바로 아래):

```ts
  /**
   * solo (미리보기 전용). 하나라도 있으면 미리보기는 이것만 그리고 체크박스와
   * 눈을 무시한다 — 이름만으로 라인인지 알 수 없는 레이어를 눈으로 판정하는 용도다.
   * previewHiddenIds와 독립이라, solo를 풀면 원래 화면이 그대로 돌아온다.
   */
  soloIds: number[];
```

`OpsAction` 유니온에 둘을 더한다 (`togglePreview` 아래):

```ts
  | { type: "toggleSolo"; layerId: number }
  | { type: "setSolo"; layerIds: number[]; solo: boolean }
```

`opsReducer`의 `case "togglePreview"` 바로 아래에 두 case를 더한다:

```ts
    case "toggleSolo": {
      const { layerId } = action;
      const soloIds = state.soloIds.includes(layerId)
        ? state.soloIds.filter((id) => id !== layerId)
        : [...state.soloIds, layerId];
      return { ...state, soloIds };
    }
    case "setSolo": {
      const target = new Set(action.layerIds);
      const soloIds = action.solo
        ? Array.from(new Set([...state.soloIds, ...action.layerIds]))
        : state.soloIds.filter((id) => !target.has(id));
      return { ...state, soloIds };
    }
```

- [ ] **Step 4: 통과를 확인한다**

Run: `npx vitest run src/lib/opsReducer.test.ts`
Expected: 새 테스트 5개 PASS. `tsc`는 아직 `OpsState`를 만드는 다른 자리(`EMPTY_OPS`, `buildInitialOpsState`)에서 `soloIds` 누락을 지적한다 — Task 3이 고친다.

- [ ] **Step 5: 커밋**

```bash
git add src/lib/opsReducer.ts src/lib/opsReducer.test.ts
git commit -m "$(cat <<'EOF'
feat: track which layers are soloed, without touching what is exported

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltm3qkFkyb9oANqu3A2HRc
EOF
)"
```

---

### Task 3: 앱 상태에 배선

**Files:**
- Modify: `src/state/appStore.tsx:73-74` (`AppAction`), `:86` (`EMPTY_OPS`), `:116-123` (`buildInitialOpsState`), `:194-212` (리듀서), `:255-265` (세션 갱신 시 상태 보존), `:464-475` (컨텍스트 타입), `:504-520` (콜백), `:580-610` (컨텍스트 값)
- Test: `src/state/appStore.test.ts`

**Interfaces:**
- Consumes: Task 2의 `OpsState.soloIds`, `toggleSolo`, `setSolo`
- Produces: 컨텍스트에 `toggleSolo(layerId: number): void`와 `setSolo(layerIds: number[], solo: boolean): void`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/state/appStore.test.ts`에 덧붙인다. 파일에서 이미 쓰고 있는 리듀서 호출 방식을 따른다:

```ts
// --- solo (설계 문서 5절) ---

test("EMPTY_OPS carries an empty solo set", () => {
  expect(EMPTY_OPS.soloIds).toEqual([]);
});

test("a freshly opened tree starts with nothing soloed", () => {
  const state = buildInitialOpsState([
    { id: 1, name: "a", kind: "pixel", visible: true, blendMode: "normal", opacity: 100,
      bbox: [0, 0, 1, 1], hasMask: false, path: ["a"] },
  ]);
  expect(state.soloIds).toEqual([]);
});

test("toggleSolo flips a layer id in soloIds", () => {
  const s0 = opened();
  expect(s0.opsByPath["/a.psd"].soloIds).toEqual([]);
  const on = appReducer(s0, { type: "toggleSolo", path: "/a.psd", layerId: 1 });
  expect(on.opsByPath["/a.psd"].soloIds).toEqual([1]);
  const off = appReducer(on, { type: "toggleSolo", path: "/a.psd", layerId: 1 });
  expect(off.opsByPath["/a.psd"].soloIds).toEqual([]);
});

test("setSolo turns a batch on and off (used by the group solo toggle)", () => {
  const s0 = opened();
  const on = appReducer(s0, { type: "setSolo", path: "/a.psd", layerIds: [1, 5], solo: true });
  expect(on.opsByPath["/a.psd"].soloIds).toEqual([1, 5]);
  const off = appReducer(on, { type: "setSolo", path: "/a.psd", layerIds: [1, 5], solo: false });
  expect(off.opsByPath["/a.psd"].soloIds).toEqual([]);
});

// solo를 걸고 푸는 동안 눈과 체크박스는 그대로여야 한다. 이것이 깨지면 solo를
// 풀었을 때 원래 화면이 돌아오지 않는다.
test("solo leaves the eye toggles and the export selection alone", () => {
  const s0 = opened();
  const before = s0.opsByPath["/a.psd"];
  const on = appReducer(s0, { type: "setSolo", path: "/a.psd", layerIds: [1, 5], solo: true });
  const after = appReducer(on, { type: "setSolo", path: "/a.psd", layerIds: [1, 5], solo: false })
    .opsByPath["/a.psd"];
  expect(after.previewHiddenIds).toEqual(before.previewHiddenIds);
  expect(after.includedIds).toEqual(before.includedIds);
  expect(after.entries).toEqual(before.entries);
});
```

이 파일의 기존 테스트는 `appReducer`와 `opened()` 헬퍼를 쓴다(`/a.psd`를 열어둔 상태를 돌려준다). 그 관례를 그대로 따르고 **새 헬퍼를 만들지 않는다.** 트리의 pixel leaf는 1, 2, 5이고 2는 원본에서 숨겨져 있어 `previewHiddenIds`가 `[2]`로 시작한다 — 위 테스트는 그 사실에 기대지 않도록 `before`와 비교하는 식으로 썼다.

`EMPTY_OPS`와 `buildInitialOpsState`가 아직 import 되지 않았으면 파일 위쪽 import에 더한다.

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/state/appStore.test.ts`
Expected: FAIL — `soloIds`가 없고 `toggleSolo`/`setSolo` 액션이 처리되지 않는다.

- [ ] **Step 3: 상태와 리듀서를 고친다**

`AppAction` 유니온에 더한다 (`setPreviewHidden` 아래):

```ts
  | { type: "toggleSolo"; path: string; layerId: number }
  | { type: "setSolo"; path: string; layerIds: number[]; solo: boolean }
```

`EMPTY_OPS`에 `soloIds: []`를 더한다:

```ts
export const EMPTY_OPS: OpsState = { includedIds: [], previewHiddenIds: [], soloIds: [], ops: [], entries: [] };
```

`buildInitialOpsState`의 반환 객체에 `soloIds: []`를 더한다. 주석도 갱신한다 — 새로 연 파일은 아무것도 solo되지 않은 상태로 시작한다.

리듀서에 두 case를 더한다 (`setPreviewHidden` 아래). `togglePreview`가 하위 리듀서에 위임하는 방식을 그대로 따른다:

```ts
    case "toggleSolo": {
      const current = state.opsByPath[action.path];
      if (!current) return state;
      const next = opsReducer(current, { type: "toggleSolo", layerId: action.layerId });
      return { ...state, opsByPath: { ...state.opsByPath, [action.path]: next } };
    }
    case "setSolo": {
      const current = state.opsByPath[action.path];
      if (!current) return state;
      const next = opsReducer(current, {
        type: "setSolo", layerIds: action.layerIds, solo: action.solo,
      });
      return { ...state, opsByPath: { ...state.opsByPath, [action.path]: next } };
    }
```

`appStore.tsx:262` 부근에 세션이 갱신될 때 기존 ops 상태를 보존하는 자리가 있다(`previewHiddenIds: current.previewHiddenIds`처럼 필드를 하나씩 옮겨 담는다). **거기에 `soloIds: current.soloIds`도 더한다** — 빠뜨리면 세션이 재생성될 때 solo가 조용히 풀린다.

설계 문서 5절의 "파일을 오가는 동안 유지된다"는 별도 테스트를 두지 않는다. solo가 `opsByPath[path]` 안에 사는 것 자체가 그 보장이고, `previewHiddenIds`도 같은 이유로 파일 간 유지 테스트가 없다. 구조가 이미 답인 것을 테스트로 다시 쓰면 관리 대상만 늘어난다.

- [ ] **Step 4: 콜백과 컨텍스트를 잇는다**

컨텍스트 타입에 더한다 (`setPreviewHidden` 아래):

```ts
  toggleSolo: (layerId: number) => void;
  setSolo: (layerIds: number[], solo: boolean) => void;
```

콜백을 만든다 (`setPreviewHidden` 콜백 바로 아래, 같은 모양으로):

```ts
  const toggleSolo = useCallback(
    (layerId: number) => {
      if (!state.activePath) return;
      dispatch({ type: "toggleSolo", path: state.activePath, layerId });
    },
    [state.activePath]
  );

  const setSolo = useCallback(
    (layerIds: number[], solo: boolean) => {
      if (!state.activePath) return;
      dispatch({ type: "setSolo", path: state.activePath, layerIds, solo });
    },
    [state.activePath]
  );
```

컨텍스트 값 객체와 그 `useMemo` 의존성 배열 **양쪽에** `toggleSolo`, `setSolo`를 더한다 — `togglePreview`/`setPreviewHidden`이 두 곳에 모두 나타나는 것과 같다. 한쪽만 더하면 값이 갱신되지 않는다.

- [ ] **Step 5: 통과를 확인한다**

Run: `npx vitest run src/state/appStore.test.ts && npx tsc --noEmit`
Expected: appStore 테스트 PASS. `tsc`는 여전히 `PreviewCanvas.tsx`의 3인자 호출만 지적해야 한다.

- [ ] **Step 6: 커밋**

```bash
git add src/lib/opsReducer.ts src/state/appStore.tsx src/state/appStore.test.ts
git commit -m "$(cat <<'EOF'
feat: keep a solo set per open file

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltm3qkFkyb9oANqu3A2HRc
EOF
)"
```

---

### Task 4: 미리보기와 캐시가 solo를 반영

**Files:**
- Modify: `src/lib/previewCache.ts:17-31` (`previewRenderSpec`), `src/lib/previewCache.test.ts` (호출부 6곳), `src/components/PreviewCanvas.tsx:31` (props), `:87` (구조분해), `:122-123` (`useMemo`), `src/App.tsx:238` (`previewPlanFor`), `:501` 부근 (`<PreviewCanvas>`)

**Interfaces:**
- Consumes: Task 1의 4인자 `visibleIdsForPreview`, Task 3의 `ops.soloIds`
- Produces: `previewRenderSpec(file, tree, includedIds, previewHiddenIds, soloIds, lineColor)` — `soloIds`가 `previewHiddenIds` 바로 뒤에 들어가, `visibleIdsForPreview`와 인자 순서가 같아진다

- [ ] **Step 1: `previewRenderSpec`에 인자를 더한다**

`src/lib/previewCache.ts`:

```ts
export function previewRenderSpec(
  file: PreviewFileId,
  tree: TreeNode[],
  includedIds: number[],
  previewHiddenIds: number[],
  soloIds: number[],
  lineColor: string | null
): { visibleIds: number[]; documentView: boolean; key: string | null } {
  const visibleIds = visibleIdsForPreview(tree, includedIds, previewHiddenIds, soloIds);
```

나머지 본문은 그대로 둔다. **캐시 키는 손대지 않는다** — 키가 이미 `visibleIds`에서 파생되므로 solo는 자동으로 반영된다. 키에 `soloIds`를 따로 넣으면 같은 그림에 두 개의 키가 생겨 캐시가 헛돈다.

`src/lib/previewCache.test.ts`의 호출 6곳(줄 28, 36, 41, 46, 47, 73)에 `previewHiddenIds` 다음 자리로 `[]`를 끼워 넣는다. 예:

```ts
const spec = previewRenderSpec(F7, tree, [1, 3], [3], [], "#000000");
```

기대값은 하나도 바꾸지 않는다.

- [ ] **Step 2: `PreviewCanvas`에 prop을 더한다**

props 인터페이스의 `previewHiddenIds: number[];` 바로 아래:

```ts
  soloIds: number[];
```

구조분해에도 `soloIds,`를 더한다.

`useMemo`를 고친다 — **의존성 배열에 `soloIds`를 반드시 넣는다.** 빠뜨리면 solo를 눌러도 화면이 안 바뀌는, 원인을 찾기 어려운 버그가 된다:

```ts
    () => (tree ? visibleIdsForPreview(tree, includedIds, previewHiddenIds, soloIds) : []),
    [tree, includedIds, previewHiddenIds, soloIds]
```

- [ ] **Step 3: `App.tsx`의 두 자리를 잇는다**

`App.tsx:238`의 `previewPlanFor`는 배경에서 미리보기를 미리 렌더해 캐시에 담는 경로다. 여기에도 solo를 넘겨야 한다 — 안 넘기면 solo를 걸어둔 파일로 돌아왔을 때 캐시된 옛 그림이 먼저 뜬다:

```tsx
    return previewRenderSpec(
      { path: file.path, mtime: file.mtime },
      file.tree,
      ops.includedIds,
      ops.previewHiddenIds,
      ops.soloIds,
      presetRef.current?.lineColor ?? null
    );
```

`App.tsx:501` 부근의 `<PreviewCanvas ... previewHiddenIds={ops.previewHiddenIds}` 옆에 더한다:

```tsx
          soloIds={ops.soloIds}
```

- [ ] **Step 4: 타입과 테스트를 확인한다**

Run: `npx tsc --noEmit && npm test`
Expected: `tsc` 클린(Task 1이 남긴 두 에러가 여기서 사라진다). 테스트 전부 PASS.

- [ ] **Step 5: 커밋**

```bash
git add src/lib/previewCache.ts src/lib/previewCache.test.ts src/components/PreviewCanvas.tsx src/App.tsx
git commit -m "$(cat <<'EOF'
feat: wire the solo set through the preview and its cache

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltm3qkFkyb9oANqu3A2HRc
EOF
)"
```

---

### Task 5: 레이어 패널의 solo 버튼

**Files:**
- Modify: `src/components/LayerTree.tsx` (props, 파생 Set, 그룹 핸들러, 세 행 렌더러, 패널 상단), `src/App.tsx` (핸들러 전달), `src/App.css`

**Interfaces:**
- Consumes: Task 3의 `toggleSolo`/`setSolo`, Task 2의 `ops.soloIds`
- Produces: 없음 (UI)

**행이 세 군데서 그려진다.** 하나만 고치면 보기 모드에 따라 버튼이 사라진다:
- `renderNode` (`:433`) — 트리 보기의 **그룹** 행
- `renderLeaf` (`:479`) — 트리 보기와 평면 목록의 **leaf** 행 (같은 함수를 공유한다)
- `renderMergedRow` (`:556`) — 평면 목록의 **병합** 행

- [ ] **Step 1: props와 파생 Set을 더한다**

`LayerTreeProps`에 더한다 (`onSetPreviewHidden` 아래):

```ts
  onToggleSolo: (layerId: number) => void;
  onSetSolo: (layerIds: number[], solo: boolean) => void;
```

`previewHiddenSet`(`:143`) 옆에 더한다:

```ts
  const soloSet = useMemo(() => new Set(ops.soloIds), [ops.soloIds]);
```

- [ ] **Step 2: 그룹 핸들러를 더한다**

`handleGroupEye`(`:309-313`) 바로 아래에, 같은 모양으로:

```ts
  // 하위가 전부 solo면 누를 때 전부 풀고, 아니면 전부 건다. 그룹 눈과 같은 규약이다.
  function handleGroupSolo(node: TreeNode) {
    const leafIds = collectLeafIds(node);
    const allSoloed = leafIds.length > 0 && leafIds.every((id) => soloSet.has(id));
    onSetSolo(leafIds, !allSoloed);
  }
```

- [ ] **Step 3: 세 행 렌더러에 버튼을 넣는다**

**그룹 행** (`renderNode`, `<span className="checkbox-slot" />` 다음, 눈 버튼 앞):

```tsx
            <button
              type="button"
              className={`solo-toggle${allSoloed ? " solo-on" : ""}`}
              onClick={() => handleGroupSolo(node)}
              aria-label="그룹 solo 토글"
              title="이 그룹만 보기"
            >
              ◉
            </button>
```

같은 렌더러 안, `allHidden`(`:440`)을 계산하는 자리 옆에 더한다:

```ts
      const allSoloed = leafIds.length > 0 && leafIds.every((id) => soloSet.has(id));
```

**leaf 행** (`renderLeaf`, 체크박스 다음, 눈 버튼 앞):

```tsx
        <button
          type="button"
          className={`solo-toggle${soloed ? " solo-on" : ""}`}
          disabled={disabledCheckbox}
          onClick={(e) => {
            e.stopPropagation();
            onToggleSolo(node.id);
          }}
          aria-label="solo 토글"
          title={disabledCheckbox ? "pixel 레이어만 미리보기에 그릴 수 있습니다" : "이 레이어만 보기"}
        >
          ◉
        </button>
```

`renderLeaf` 위쪽, `const hidden = ...`(`:482`) 옆에 더한다:

```ts
    const soloed = soloSet.has(node.id);
```

`disabledCheckbox`는 이미 그 함수 안에 있다(`node.kind !== "pixel"`). pixel이 아닌 leaf는 그려질 수 없으니 solo 버튼도 비활성이다.

**병합 행** (`renderMergedRow`, 체크박스 다음, 눈 버튼 앞):

```tsx
        <button
          type="button"
          className={`solo-toggle${allSoloed ? " solo-on" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            onSetSolo(sourceIds, !allSoloed);
          }}
          aria-label="solo 토글"
          title="이 병합의 소스만 보기"
        >
          ◉
        </button>
```

그 함수 안에서 `hidden`을 계산하는 자리 옆에 더한다:

```ts
    const allSoloed = sourceIds.length > 0 && sourceIds.every((id) => soloSet.has(id));
```

- [ ] **Step 4: "solo 해제" 버튼을 패널 상단에 놓는다**

레이어 필터 토글(`전체` / `라인만`)이 있는 줄에, solo가 하나라도 걸려 있을 때만 나타나게 한다:

```tsx
        {ops.soloIds.length > 0 && (
          <button
            type="button"
            className="solo-clear"
            onClick={() => onSetSolo(ops.soloIds, false)}
            title="solo를 모두 풀고 원래 화면으로 돌아갑니다"
          >
            solo 해제 ({ops.soloIds.length})
          </button>
        )}
```

평소에 자리를 차지하지 않는 것이 요점이다 — 여러 장을 solo해두고 어디를 켰는지 잊었을 때의 탈출구다.

- [ ] **Step 5: `App.tsx`에서 핸들러를 넘긴다**

`<LayerTree ... onSetPreviewHidden={...}` 옆에 더한다:

```tsx
          onToggleSolo={toggleSolo}
          onSetSolo={setSolo}
```

`useAppStore()`(또는 이 파일이 컨텍스트를 꺼내 쓰는 방식)에서 `toggleSolo`, `setSolo`를 구조분해해 가져온다.

- [ ] **Step 6: 스타일을 더한다**

`src/App.css`의 `.eye-toggle` 규칙(`:684`) 옆에 더한다. 눈과 확실히 구분돼야 한다 — 두 개가 헷갈리면 서로를 방해한다:

```css
.solo-toggle {
  flex-shrink: 0;
  background: transparent;
  border: none;
  padding: 0 0.2em;
  color: var(--text-dim);
  line-height: 1;
  opacity: 0.45;
}

/* solo가 걸린 행은 한눈에 띄어야 한다 — 지금 화면이 왜 이 레이어만 보이는지의
   유일한 단서다. */
.solo-toggle.solo-on {
  color: var(--accent);
  opacity: 1;
}

.solo-toggle:disabled {
  opacity: 0.15;
  cursor: default;
}

.solo-clear {
  margin-left: auto;
}
```

`--accent`가 없으면 이 파일이 강조에 쓰는 변수를 찾아 그것을 쓴다. 새 색 변수를 만들지 않는다.

- [ ] **Step 7: 확인한다**

Run: `npm test && npx tsc --noEmit && npm run build`
Expected: 전부 PASS.

- [ ] **Step 8: 커밋**

```bash
git add src/components/LayerTree.tsx src/App.tsx src/App.css
git commit -m "$(cat <<'EOF'
feat: a solo toggle on every layer, group and merged row

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltm3qkFkyb9oANqu3A2HRc
EOF
)"
```

---

## 남는 것 — 이 계획의 범위 밖

설계 문서 8절이 명시적으로 범위 밖에 둔 것들이다. 구현 중에 손대지 않는다.

- solo 상태를 디스크에 저장하는 것
- 키보드 단축키
- 👁 Alt+클릭 같은 대체 조작 — 버튼 하나로 충분한지 써보고 정한다
- solo를 내보내기에 반영하는 것 — solo가 보기 전용이라는 것이 이 설계의 전제다
