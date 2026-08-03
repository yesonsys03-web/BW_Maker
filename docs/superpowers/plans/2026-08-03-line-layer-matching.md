# 라인 레이어 판별 규칙 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 프리셋 `contains "line"`이 라인 아트가 아닌 레이어를 끌어오는 것을 네 가지 규칙으로 막는다 — 실파일 25개 기준 740건 → 645건, 진짜 라인 손실 0.

**Architecture:** 판별의 핵심은 "이름을 토큰으로 쪼개 비교한다"는 한 가지 개념이고, 이것을 엔진(`psd_engine/names.py`)과 프론트엔드(`src/lib/layerNames.ts`) 양쪽에 같은 규칙으로 둔다. 네 규칙 중 ①②는 `match_preset`의 판정 흐름에, ③은 새 프리셋 필드 `excludeTokens`에, ④는 트리가 이미 싣고 있는 `blendMode`에 붙는다. 뺀 이유는 엔진의 기존 `skipped` 채널로 돌려주되 오류 카드에는 올리지 않는다.

**Tech Stack:** Python 3.12 + psd-tools (엔진, pytest) / TypeScript + React + Vite (프론트엔드, vitest) / Tauri 2

**설계 문서:** `docs/superpowers/specs/2026-08-03-line-layer-matching-design.md`

## Global Constraints

- **토크나이저는 두 곳에 존재하고 규칙이 같아야 한다.** `engine/psd_engine/names.py`와 `src/lib/layerNames.ts`. 서로를 가리키는 주석을 단다 — 이 저장소가 `DEFAULT_ROLE_TOKENS`/`DEFAULT_PLANE_TOKENS`에 이미 쓰는 관례다.
- **정규식에 lookbehind를 쓰지 않는다.** 프론트엔드는 Tauri의 시스템 웹뷰(macOS WKWebView)에서 돌고, lookbehind는 Safari 16.4부터다. 토큰 정규식 `[0-9]+|[A-Z]+(?![a-z])|[A-Z][a-z]*|[a-z]+`는 lookahead만 쓴다. 검증 완료 — 실데이터에서 split 방식과 같은 645건이 나온다.
- **하위 호환: 없는 필드는 기본값으로 읽는다.** `excludeTokens`가 없는 `presets.json`, `blendMode`가 없는 옛 트리 모두 통과해야 한다. `roleTokens`/`splitLayers`/`mergeRule`이 이미 그렇게 처리된다(`src/lib/presets.ts:90-104`).
- **주석은 한국어로, "무엇"이 아니라 "왜"를 쓴다.** 기존 코드 관례다.
- **커밋 메시지**: `feat:` / `test:` / `refactor:` 접두사 + 소문자 설명문. 트레일러를 반드시 붙인다:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Ltm3qkFkyb9oANqu3A2HRc
  ```
- **브랜치**: `feat/line-layer-matching` (이미 만들어져 있고 설계 문서가 커밋돼 있다).
- **테스트 실행**: 엔진 `cd engine && uv run pytest` (uv가 없으면 `engine/.venv/bin/python -m pytest engine/tests`), 프론트엔드 `npm test` 또는 `npx vitest run <파일>`.
- **기존 테스트를 깨뜨리지 않는다.** 단 하나 예외는 Task 8의 `layerFilter.test.ts` "the name fallback is case-insensitive" — `Outline sketch`를 예시로 쓰는데 토큰 매칭에서는 `outline`이 `line`과 다른 토큰이라 더는 걸리지 않는다. 해당 태스크에서 예시를 바꾼다.

## 파일 구조

**엔진**

| 파일 | 책임 |
|---|---|
| `engine/psd_engine/names.py` (신규) | 레이어 이름을 토큰으로 쪼개고 비교한다. 순수 함수만. |
| `engine/tests/test_names.py` (신규) | 위의 단위 테스트. |
| `engine/psd_engine/matching.py` (수정) | 네 규칙을 `match_preset`의 판정 흐름에 엮고 skip 사유를 돌려준다. |
| `engine/tests/test_matching.py` (수정) | 규칙별 테스트 추가. |

**프론트엔드**

| 파일 | 책임 |
|---|---|
| `src/lib/layerNames.ts` (신규) | `names.py`의 거울. "라인만" 패널의 폴백이 쓴다. |
| `src/lib/layerNames.test.ts` (신규) | 위의 단위 테스트. |
| `src/lib/types.ts` (수정) | `Preset.excludeTokens` |
| `src/lib/presets.ts` (수정) | 기본값 + 검증 |
| `src/lib/presets.test.ts` (수정) | 기본값·하위 호환 테스트 |
| `src/components/PresetDialog.tsx` (수정) | 제외 토큰 입력란 |
| `src/lib/engine.ts` (수정) | `SkippedLayer.reason` 유니온 확장 |
| `src/state/appStore.tsx` (수정) | skipped 필터를 허용 목록으로 |
| `src/state/appStore.test.ts` (수정) | 규칙 기반 사유가 카드로 안 올라감 |
| `src/lib/layerFilter.ts` (수정) | 폴백 라인 판정을 토큰 매칭으로 |
| `src/lib/layerFilter.test.ts` (수정) | 위 테스트 + 예시 교체 |

**검증**

| 파일 | 책임 |
|---|---|
| `scripts/audit-line-matching.py` (신규) | 실제 PSD 폴더에 엔진 코드를 그대로 돌려 사유별 건수를 낸다. |

설계 문서 6절은 토크나이저를 `matching.py`에 두는 것으로 적었지만 `names.py`로 분리한다. `matching.py`는 이미 275줄에 이름 매칭·연산 생성·병합 버킷팅을 함께 지고 있고, 토크나이저는 프론트엔드가 거울로 갖는 독립 단위라 경계가 분명하다.

---

### Task 1: 이름 토크나이저 (엔진)

**Files:**
- Create: `engine/psd_engine/names.py`
- Test: `engine/tests/test_names.py`

**Interfaces:**
- Consumes: 없음 (순수 함수 모듈)
- Produces:
  - `tokenize(name: str) -> list[str]`
  - `token_match(name: str, value: str, case_sensitive: bool = False) -> bool`
  - `has_any_token(name: str, wanted: list[str], case_sensitive: bool = False) -> bool`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`engine/tests/test_names.py`:

```python
from psd_engine.names import has_any_token, token_match, tokenize


def test_splits_on_separators_case_boundaries_and_digits():
    assert tokenize("Wall_Line") == ["Wall", "Line"]
    assert tokenize("CurtainsLine") == ["Curtains", "Line"]
    assert tokenize("line2") == ["line", "2"]
    assert tokenize("CHAIR1_LINE") == ["CHAIR", "1", "LINE"]
    assert tokenize("Layer 866 (LINEAR DODGE)") == ["Layer", "866", "LINEAR", "DODGE"]
    assert tokenize("TopWindowArches_line") == ["Top", "Window", "Arches", "line"]
    assert tokenize("GRAIN_OVERLAY copy") == ["GRAIN", "OVERLAY", "copy"]
    assert tokenize("*ART") == ["ART"]


def test_a_name_with_no_ascii_letters_has_no_tokens():
    # 한글만 있는 이름. 호출자는 이 경우 부분 문자열로 되돌아간다.
    assert tokenize("라인") == []


# 실제 납품 파일에서 온 이름들이다(설계 문서 2절).
def test_line_matches_as_a_word_not_as_a_substring():
    for name in ["line", "LINE", "LINES", "lines", "hidden line", "line ol",
                 "Wall_Line", "Ring_Line", "CurtainsLine", "line2",
                 "TopWindowArches_line", "Wall_OL_Line", "BROKEN WALL LINE"]:
        assert token_match(name, "line"), name

    for name in ["Layer 866 (LINEAR DODGE)", "Linear Light", "Linear dodge 75% ",
                 "kline col", "OUTLINE"]:
        assert not token_match(name, "line"), name


def test_case_sensitive_mode_still_accepts_the_plural():
    # 'LINE'을 대소문자까지 지켜 찾더라도 'LINES'가 빠지면 규칙이 쓸모없다.
    assert token_match("LINES", "LINE", case_sensitive=True)
    assert not token_match("lines", "LINE", case_sensitive=True)


def test_a_multi_token_value_must_appear_consecutively():
    assert token_match("BROKEN WALL LINE", "wall line")
    assert not token_match("WALL fill LINE", "wall line")


def test_has_any_token_finds_the_colour_vocabulary():
    colour = ["col", "colour", "color"]
    for name in ["line col", "LINE_COL", "Line Colour", "line colour", "Wall_Line_Col"]:
        assert has_any_token(name, colour), name
    for name in ["COUCH LINE", "line", "Bookcase_Line"]:
        assert not has_any_token(name, colour), name
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd engine && uv run pytest tests/test_names.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'psd_engine.names'`

- [ ] **Step 3: 최소 구현을 쓴다**

`engine/psd_engine/names.py`:

```python
"""레이어 이름을 토큰으로 쪼개고 비교한다.

`contains "line"`을 부분 문자열로 보면 "LINEAR DODGE"의 앞 네 글자가 걸린다.
그렇다고 `\\blines?\\b` 같은 정규식으로 바꾸면 정규식의 `\\b`가 `_`에서 끊기지
않아 `Wall_Line`, `Ring_Line` 같은 진짜 라인 43장이 같이 날아간다. 그래서
직접 토큰을 나눈다.

src/lib/layerNames.ts가 같은 규칙의 거울이다 — 프리셋을 적용하기 전 "라인만"
패널이 엔진과 다른 답을 내면 안 된다. 한쪽을 고치면 다른 쪽도 고쳐야 한다.
"""
import re

#: 토큰 하나. 숫자 덩어리 / 연속 대문자(뒤에 소문자가 오지 않는 것) /
#: 대문자로 시작하는 낱말 / 소문자 덩어리. 그 사이의 `_`, `-`, 공백, 괄호는
#: 자연히 구분자가 된다.
#:
#: lookbehind를 쓰지 않는 것이 중요하다 — 거울인 layerNames.ts가 시스템
#: 웹뷰에서 도는데 lookbehind는 Safari 16.4부터다.
_TOKEN = re.compile(r"[0-9]+|[A-Z]+(?![a-z])|[A-Z][a-z]*|[a-z]+")


def tokenize(name):
    """이름의 토큰 목록. ASCII 영숫자가 없으면 빈 목록이다."""
    return _TOKEN.findall(name)


def _token_eq(token, want, case_sensitive):
    if not case_sensitive:
        token, want = token.lower(), want.lower()
    if token == want:
        return True
    # 복수형 s를 받아준다 — 'line'으로 찾을 때 'LINES'(103장)가 빠지면 안 된다.
    # 대소문자를 지키는 모드에서도 S/s 둘 다 받는다.
    return len(token) == len(want) + 1 and token[:-1] == want and token[-1] in ("s", "S")


def token_match(name, value, case_sensitive=False):
    """
    이름의 토큰 열에 검색값의 토큰 열이 연속으로 나타나는가.

    검색값이 토큰을 하나도 만들지 못하면(예: "-") False다. 그 경우 부분 문자열로
    되돌아갈지는 호출자가 정한다 — 여기서 정하면 되돌아가는 규칙이 숨는다.
    """
    want = tokenize(value)
    if not want:
        return False
    have = tokenize(name)
    span = len(want)
    for i in range(len(have) - span + 1):
        if all(_token_eq(have[i + j], want[j], case_sensitive) for j in range(span)):
            return True
    return False


def has_any_token(name, wanted, case_sensitive=False):
    """이름의 토큰 중 하나라도 wanted에 있는가."""
    have = tokenize(name)
    return any(
        _token_eq(token, w, case_sensitive)
        for token in have
        for w in wanted
        if w and w.strip()
    )
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd engine && uv run pytest tests/test_names.py -v`
Expected: PASS (6 passed)

- [ ] **Step 5: 커밋**

```bash
git add engine/psd_engine/names.py engine/tests/test_names.py
git commit -m "$(cat <<'EOF'
feat: split layer names into tokens so LINEAR stops matching line

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltm3qkFkyb9oANqu3A2HRc
EOF
)"
```

---

### Task 2: 규칙 ① — `contains`를 토큰 매칭으로

**Files:**
- Modify: `engine/psd_engine/matching.py:5-14` (`_name_matches`), `:23-26` (skip 사유 상수), `:44-76` (`match_preset`의 walk)
- Test: `engine/tests/test_matching.py`

**Interfaces:**
- Consumes: Task 1의 `token_match`, `tokenize`
- Produces:
  - 상수 `SKIP_NOT_LINE_WORD = "notLineWord"`
  - `_legacy_contains(name, include) -> bool` (모듈 내부, 보고 전용)
  - `match_preset`이 돌려주는 skipped 항목에 `reason="notLineWord"`가 나타날 수 있다

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`engine/tests/test_matching.py` 맨 아래에 덧붙인다. 파일 중간의 기존 `_node` 헬퍼를 쓴다(id, 이름, kind, hasPixels 순).

```python
# --- 규칙 ①: 이름을 토큰으로 본다 (설계 문서 3절) ---

def test_linear_dodge_is_not_a_line_and_says_why_it_was_dropped():
    tree = [_node(0, "Layer 866 (LINEAR DODGE)", "pixel", True)]
    matched, skipped = match_preset(tree, _preset())
    assert matched == []
    assert skipped == [{
        "id": 0, "path": "Layer 866 (LINEAR DODGE)",
        "kind": "pixel", "reason": "notLineWord",
    }]


def test_underscore_and_camel_case_names_are_still_lines():
    # 정규식 \blines?\b 였다면 이것들이 전부 날아간다 — \b는 _에서 끊기지 않는다.
    tree = [
        _node(0, "Wall_Line", "pixel", True),
        _node(1, "CurtainsLine", "pixel", True),
        _node(2, "Ring_Line", "pixel", True),
        _node(3, "line2", "pixel", True),
    ]
    assert match_preset(tree, _preset()) == ([0, 1, 2, 3], [])


def test_a_value_with_no_tokens_falls_back_to_substring():
    # "-"는 토큰을 만들지 못한다. 그럴 때까지 규칙을 못 쓰게 만들 이유는 없다.
    tree = [_node(0, "-guides", "pixel", True)]
    p = _preset(include={"type": "contains", "value": "-", "caseSensitive": False},
                excludeGroupPrefixes=[])
    assert match_preset(tree, p) == ([0], [])
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd engine && uv run pytest tests/test_matching.py -v`
Expected: `test_linear_dodge_is_not_a_line_and_says_why_it_was_dropped` FAIL (matched가 `[0]`으로 나온다 — 부분 문자열로 걸린다). 나머지 둘은 통과한다(부분 문자열로도 걸리므로). 기존 테스트는 전부 통과 상태여야 한다.

- [ ] **Step 3: 구현한다**

`engine/psd_engine/matching.py` 상단 import에 추가:

```python
from .names import token_match, tokenize
```

`_name_matches`를 통째로 바꾼다:

```python
def _name_matches(name, include):
    kind = include["type"]
    if kind == "contains":
        value = include["value"]
        case_sensitive = bool(include.get("caseSensitive"))
        # 부분 문자열이 아니라 토큰으로 본다 — "LINEAR DODGE"의 앞 네 글자가
        # 걸리면 안 된다(psd_engine/names.py). 검색값이 토큰을 만들지 못하면
        # (예: "-") 예전 규칙으로 되돌아간다.
        if tokenize(value):
            return token_match(name, value, case_sensitive)
        return _legacy_contains(name, include)
    if kind == "regex":
        flags = 0 if include.get("caseSensitive") else re.IGNORECASE
        return re.search(include["value"], name, flags) is not None
    raise ValueError(f"unknown include type: {kind!r}")


def _legacy_contains(name, include):
    """
    토큰 매칭 이전의 부분 문자열 규칙.

    두 곳에서 쓴다. 검색값이 토큰을 못 만들 때의 대체 동작, 그리고 "예전에는
    걸렸는데 이제는 안 걸린다"를 사람에게 알려주는 보고다.
    """
    if include["type"] != "contains":
        return False
    if include.get("caseSensitive"):
        return include["value"] in name
    return include["value"].lower() in name.lower()
```

skip 사유 상수에 추가 (`SKIP_NO_PIXELS` 아래):

```python
#: 이름에 검색어가 부분 문자열로는 들어있지만 토큰으로는 아니다("LINEAR DODGE").
SKIP_NOT_LINE_WORD = "notLineWord"
```

`match_preset`의 walk에서 leaf 판정부를 바꾼다. 지금 이 두 줄을

```python
            if not (_name_matches(node["name"], preset["include"]) or inside_matched_group):
                continue
```

이렇게 바꾸고, 아래쪽 `skipped.append({...})`도 같은 헬퍼를 쓰도록 정리한다:

```python
            self_hit = _name_matches(node["name"], preset["include"])
            if not (self_hit or inside_matched_group):
                # 예전 규칙으로는 걸렸을 이름이라면 왜 빠졌는지 남긴다. 이름이
                # LINE인데 결과에 없으면 사람이 이유를 알 방법이 없다.
                if _legacy_contains(node["name"], preset["include"]):
                    _skip(node, SKIP_NOT_LINE_WORD)
                continue
```

`match_preset` 안, `walk` 정의 바로 위에 헬퍼를 놓는다:

```python
    def _skip(node, reason):
        skipped.append({
            "id": node["id"],
            "path": "/".join(node["path"]),
            "kind": node["kind"],
            "reason": reason,
        })
```

그리고 기존의 인라인 append를 `_skip(node, reason)`으로 바꾼다:

```python
            if reason:
                _skip(node, reason)
                continue
            matched.append(node["id"])
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd engine && uv run pytest tests/ -v`
Expected: PASS — 새 테스트 3개 포함 전부 통과. 특히 `test_contains_with_exclude_prefix`가 여전히 `([3, 4, 5], [])`여야 한다(`hidden line`/`line`/`lines` 모두 토큰 매칭에 걸린다).

- [ ] **Step 5: 커밋**

```bash
git add engine/psd_engine/matching.py engine/tests/test_matching.py
git commit -m "$(cat <<'EOF'
feat: match the include rule on whole words

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltm3qkFkyb9oANqu3A2HRc
EOF
)"
```

---

### Task 3: 규칙 ② — 걸린 그룹 안에 진짜 라인이 있으면 그것만

**Files:**
- Modify: `engine/psd_engine/matching.py` (`match_preset`의 walk, skip 사유 상수)
- Test: `engine/tests/test_matching.py`

**Interfaces:**
- Consumes: Task 2의 `_name_matches`, `_skip`, `_legacy_contains`
- Produces:
  - 상수 `SKIP_GROUP_HAS_OWN_LINE = "groupHasOwnLine"`
  - `_has_own_match(nodes, include, prefixes) -> bool` (모듈 함수)
  - `walk`가 인자 셋을 받는다: `walk(nodes, inside_matched_group, inside_suppressed)`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

먼저 `engine/tests/test_matching.py`의 기존 `_node` 헬퍼 아래에 그룹용 헬퍼를 추가한다:

```python
def _group(node_id, name, children, **over):
    node = {
        "id": node_id, "name": name, "kind": "group", "visible": True,
        "path": [name], "children": children,
    }
    node.update(over)
    return node
```

그리고 테스트를 덧붙인다:

```python
# --- 규칙 ②: 걸린 그룹의 일괄 포함 (설계 문서 3절) ---

def test_a_matched_group_takes_only_the_lines_it_actually_contains():
    """
    실제 파일의 'lines' 그룹이다. 이름이 규칙에 걸리는 바람에 안의 합성
    레이어까지 전부 딸려왔지만, 진짜 라인은 'lines' leaf 하나뿐이다.
    """
    tree = [_group(0, "lines", [
        _node(1, "fill", "pixel", True, path=["lines", "fill"]),
        _node(2, "GRAIN_OVERLAY", "pixel", True, path=["lines", "GRAIN_OVERLAY"]),
        _node(3, "lines", "pixel", True, path=["lines", "lines"]),
        _node(4, "h", "pixel", True, path=["lines", "h"]),
    ])]
    matched, skipped = match_preset(tree, _preset())
    assert matched == [3]
    assert [(s["id"], s["reason"]) for s in skipped] == [
        (1, "groupHasOwnLine"), (2, "groupHasOwnLine"), (4, "groupHasOwnLine"),
    ]


def test_a_matched_group_still_pulls_everything_when_nothing_inside_is_named():
    """
    matchGroups가 존재하는 이유다 — 자식 이름에 아무 단서가 없으면 그룹
    이름만이 유일한 단서다.
    """
    tree = [_group(0, "CHAIR1_LINE", [
        _node(1, "1", "pixel", True, path=["CHAIR1_LINE", "1"]),
        _node(2, "2", "pixel", True, path=["CHAIR1_LINE", "2"]),
    ])]
    assert match_preset(tree, _preset()) == ([1, 2], [])


def test_match_groups_off_ignores_the_group_name_entirely():
    tree = [_group(0, "lines", [
        _node(1, "fill", "pixel", True, path=["lines", "fill"]),
        _node(2, "lines", "pixel", True, path=["lines", "lines"]),
    ])]
    assert match_preset(tree, _preset(matchGroups=False)) == ([2], [])
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd engine && uv run pytest tests/test_matching.py -v`
Expected: `test_a_matched_group_takes_only_the_lines_it_actually_contains` FAIL — `matched`가 `[1, 2, 3, 4]`로 나온다. 나머지 둘은 통과.

- [ ] **Step 3: 구현한다**

`engine/psd_engine/matching.py`의 skip 사유 상수에 추가:

```python
#: 그룹 이름이 걸려 딸려올 뻔했지만, 그 그룹 안에 자기 이름으로 걸리는 leaf가
#: 이미 있어서 뺐다.
SKIP_GROUP_HAS_OWN_LINE = "groupHasOwnLine"
```

`match_preset` 위에 모듈 함수를 추가한다:

```python
def _has_own_match(nodes, include, prefixes):
    """
    하위 트리에 자기 이름으로 걸리는 leaf가 있는가.

    이것이 있으면 그룹의 일괄 포함은 더할 것이 없다 — 그 leaf들이 알아서
    걸린다. 없을 때만 그룹 이름이 유일한 단서다.
    """
    for node in nodes:
        if node["kind"] == "group":
            if prefixes and node["name"].startswith(prefixes):
                continue
            if _has_own_match(node["children"], include, prefixes):
                return True
        elif _name_matches(node["name"], include):
            return True
    return False
```

`match_preset`의 walk를 바꾼다. 그룹 분기는:

```python
    def walk(nodes, inside_matched_group, inside_suppressed):
        for node in nodes:
            if node["kind"] == "group":
                if prefixes and node["name"].startswith(prefixes):
                    continue
                hit = preset.get("matchGroups", True) and _name_matches(
                    node["name"], preset["include"]
                )
                # 걸린 그룹이라도 안에 진짜 라인이 있으면 일괄 포함을 끈다.
                blanket = hit and not _has_own_match(
                    node["children"], preset["include"], prefixes
                )
                walk(node["children"],
                     inside_matched_group or blanket,
                     inside_suppressed or (hit and not blanket))
                continue
```

leaf 분기의 미매치 처리는:

```python
            self_hit = _name_matches(node["name"], preset["include"])
            if not (self_hit or inside_matched_group):
                if inside_suppressed:
                    _skip(node, SKIP_GROUP_HAS_OWN_LINE)
                elif _legacy_contains(node["name"], preset["include"]):
                    _skip(node, SKIP_NOT_LINE_WORD)
                continue
```

마지막으로 최초 호출을 고친다:

```python
    walk(tree, False, False)
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd engine && uv run pytest tests/ -v`
Expected: PASS. `test_matched_group_pulls_descendants`(`contains "bg"` → `[2, 3, 4]`)는 그대로 통과해야 한다 — `BG` 그룹 안에 이름이 `bg`인 leaf가 없으므로 일괄 포함이 유지된다.

- [ ] **Step 5: 기존 테스트에 주석을 단다**

`test_matched_group_pulls_descendants` 위 주석을 새 의미에 맞게 고친다:

```python
def test_matched_group_pulls_descendants(tree):
    # 'BG'가 매치되는 규칙 → BG 하위 픽셀 전부 포함. BG 안에는 이름이 'bg'인
    # leaf가 없으므로 그룹 이름이 유일한 단서고, 일괄 포함이 유지된다.
    p = _preset(include={"type": "contains", "value": "bg", "caseSensitive": False})
    assert match_preset(tree, p) == ([2, 3, 4], [])
```

- [ ] **Step 6: 커밋**

```bash
git add engine/psd_engine/matching.py engine/tests/test_matching.py
git commit -m "$(cat <<'EOF'
feat: stop a matched group from dragging its fill and grain layers along

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltm3qkFkyb9oANqu3A2HRc
EOF
)"
```

---

### Task 4: 규칙 ③ — 제외 토큰 (엔진)

**Files:**
- Modify: `engine/psd_engine/matching.py` (skip 사유 상수, 기본값 상수, `match_preset`)
- Test: `engine/tests/test_matching.py`

**Interfaces:**
- Consumes: Task 1의 `has_any_token`, Task 2의 `_skip`
- Produces:
  - 상수 `DEFAULT_EXCLUDE_TOKENS = ["col", "colour", "color"]`
  - 상수 `SKIP_EXCLUDED_TOKEN = "excludedToken"`
  - 프리셋의 선택 필드 `excludeTokens: list[str]`를 읽는다

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```python
# --- 규칙 ③: 색 지정 레이어 제외 (설계 문서 3절) ---

def test_colour_layers_named_line_are_not_line_art():
    tree = [
        _node(0, "line col", "pixel", True),
        _node(1, "Line Colour", "pixel", True),
        _node(2, "Wall_Line_Col", "pixel", True),
        _node(3, "LINE", "pixel", True),
    ]
    matched, skipped = match_preset(tree, _preset())
    assert matched == [3]
    assert [(s["id"], s["reason"]) for s in skipped] == [
        (0, "excludedToken"), (1, "excludedToken"), (2, "excludedToken"),
    ]


def test_exclude_tokens_can_be_emptied_by_the_preset():
    tree = [_node(0, "line col", "pixel", True)]
    assert match_preset(tree, _preset(excludeTokens=[])) == ([0], [])


def test_exclude_tokens_can_be_replaced_by_the_preset():
    tree = [_node(0, "line col", "pixel", True), _node(1, "NEON LINE", "pixel", True)]
    assert match_preset(tree, _preset(excludeTokens=["neon"])) == ([0], [
        {"id": 1, "path": "NEON LINE", "kind": "pixel", "reason": "excludedToken"},
    ])
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd engine && uv run pytest tests/test_matching.py -v`
Expected: `test_colour_layers_named_line_are_not_line_art`와 `test_exclude_tokens_can_be_replaced_by_the_preset`가 FAIL — 아직 제외가 없어 전부 matched로 나온다. `test_exclude_tokens_can_be_emptied_by_the_preset`는 지금도 통과한다(제외가 없는 상태와 결과가 같다) — 구현 후에도 통과해야 "빈 목록이 기본값으로 되돌아가지 않는다"가 지켜진다.

- [ ] **Step 3: 구현한다**

import를 넓힌다:

```python
from .names import has_any_token, token_match, tokenize
```

상수를 추가한다:

```python
#: 이름에 line이 있어도 라인 아트가 아닌 것을 걸러내는 토큰. 실제 파일에서
#: `line col`, `LINE_COL`, `Line Colour`, `Wall_Line_Col`이 18장 나왔다.
#: 프리셋이 덮어쓸 수 있다 — 네 규칙 중 이것만 어휘에 의존하기 때문이다.
#: src/lib/presets.ts의 DEFAULT_EXCLUDE_TOKENS와 같은 값이어야 한다.
DEFAULT_EXCLUDE_TOKENS = ["col", "colour", "color"]

#: 이름에 제외 토큰이 들어있다.
SKIP_EXCLUDED_TOKEN = "excludedToken"
```

`match_preset` 앞부분에서 값을 읽는다 (`prefixes = ...` 다음 줄):

```python
    exclude_tokens = preset.get("excludeTokens", DEFAULT_EXCLUDE_TOKENS)
```

leaf의 사유 판정 체인에 끼운다. `elif not node.get("hasPixels", ...)` 바로 아래:

```python
            elif has_any_token(node["name"], exclude_tokens):
                reason = SKIP_EXCLUDED_TOKEN
```

순서가 중요하다 — 텍스트와 픽셀 없음이 먼저다. 기존 동작을 그대로 두어야 `test_text_note_is_skipped_even_though_photoshop_rasterized_it`이 계속 `"text"`를 돌려준다.

- [ ] **Step 4: 통과를 확인한다**

Run: `cd engine && uv run pytest tests/ -v`
Expected: PASS 전부.

- [ ] **Step 5: 커밋**

```bash
git add engine/psd_engine/matching.py engine/tests/test_matching.py
git commit -m "$(cat <<'EOF'
feat: drop layers named "line col" — they specify colour, not line

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltm3qkFkyb9oANqu3A2HRc
EOF
)"
```

---

### Task 5: 규칙 ④ — 합성 모드가 normal이 아니면 라인이 아니다

**Files:**
- Modify: `engine/psd_engine/matching.py` (skip 사유 상수, `match_preset`)
- Test: `engine/tests/test_matching.py`

**Interfaces:**
- Consumes: `tree.py`가 싣는 노드의 `blendMode` (문자열, 소문자)
- Produces: 상수 `SKIP_BLEND_MODE = "blendMode"`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```python
# --- 규칙 ④: 합성 모드 (설계 문서 3절) ---

def test_a_line_named_layer_on_overlay_is_not_line_art():
    """
    'LINE WIN'은 창문에 흰 빛을 얹는 overlay 패스다 — 렌더해서 확인했다
    (순백색 단색). 같은 그룹의 'LINE BLD'가 진짜 라인이다.
    """
    tree = [
        _node(0, "LINE WIN", "pixel", True, blendMode="overlay"),
        _node(1, "LINE BLD", "pixel", True, blendMode="normal"),
    ]
    matched, skipped = match_preset(tree, _preset())
    assert matched == [1]
    assert [(s["id"], s["reason"]) for s in skipped] == [(0, "blendMode")]


def test_a_tree_built_before_blend_mode_existed_is_treated_as_normal():
    tree = [_node(0, "LINE", "pixel", True)]  # blendMode 필드 없음
    assert match_preset(tree, _preset()) == ([0], [])
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd engine && uv run pytest tests/test_matching.py -v`
Expected: `test_a_line_named_layer_on_overlay_is_not_line_art` FAIL — `matched`가 `[0, 1]`.

- [ ] **Step 3: 구현한다**

상수를 추가한다:

```python
#: 합성 모드가 normal이 아니다. 라인 아트는 normal로 그린다 — 실파일 25개의
#: 진짜 라인 645장이 전부 normal이었고, normal이 아닌 11장은 전부 오탐이었다.
SKIP_BLEND_MODE = "blendMode"
```

사유 판정 체인의 맨 끝에 붙인다 (`elif has_any_token(...)` 아래):

```python
            # blendMode가 없는 트리는 이 필드가 생기기 전의 것이다. 그때는 모두
            # 통과했으므로 normal로 본다.
            elif node.get("blendMode", "normal") != "normal":
                reason = SKIP_BLEND_MODE
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd engine && uv run pytest tests/ -v`
Expected: PASS 전부. 픽스처 PSD의 레이어는 모두 normal이라 기존 테스트에 영향이 없다(`engine/tests/conftest.py:11-18`).

- [ ] **Step 5: 커밋**

```bash
git add engine/psd_engine/matching.py engine/tests/test_matching.py
git commit -m "$(cat <<'EOF'
feat: a layer composited on overlay is a light pass, not line art

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltm3qkFkyb9oANqu3A2HRc
EOF
)"
```

---

### Task 6: `Preset.excludeTokens` — 타입·기본값·검증·입력란

**Files:**
- Modify: `src/lib/types.ts:57-85` (`Preset`), `src/lib/presets.ts:7-21` (`DEFAULT_PRESET`), `:54-135` (`validatePreset`), `src/components/PresetDialog.tsx`
- Test: `src/lib/presets.test.ts`

**Interfaces:**
- Consumes: Task 4의 `DEFAULT_EXCLUDE_TOKENS` 값 (`["col", "colour", "color"]`)
- Produces:
  - `Preset.excludeTokens: string[]`
  - `export const DEFAULT_EXCLUDE_TOKENS: string[]` (`src/lib/presets.ts`)

다이얼로그를 같은 태스크에 두는 이유: `PresetDialog`의 `validate()`가 `Preset` 리터럴을 그대로 만들어 `onSave`에 넘긴다(`PresetDialog.tsx:106-120`, `:17`). 타입에 필드를 더하면 그 리터럴도 같이 고쳐야 `tsc --noEmit`이 통과한다 — 나눠 놓으면 앞 태스크가 컴파일되지 않는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/lib/presets.test.ts`의 `DEFAULT_PRESET` 계약 테스트에 한 줄 추가한다:

```ts
    mergeRule: "role",
    splitLayers: false,       // 기본은 한 파일에 모두
    excludeTokens: ["col", "colour", "color"],  // line col 류는 색 지정이다
  });
```

그리고 새 테스트를 덧붙인다:

```ts
test("presets saved before excludeTokens existed load with the default vocabulary", async () => {
  // tsconfig에 noUnusedLocals가 켜져 있어 구조분해로 필드를 빼면 tsc가 잡는다.
  const withoutField: Record<string, unknown> = { ...DEFAULT_PRESET };
  delete withoutField.excludeTokens;
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([withoutField]));

  const [loaded] = await loadPresets();

  expect(loaded.excludeTokens).toEqual(["col", "colour", "color"]);
});

test("an empty excludeTokens list is kept, not replaced by the default", async () => {
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([{ ...DEFAULT_PRESET, excludeTokens: [] }]));

  const [loaded] = await loadPresets();

  expect(loaded.excludeTokens).toEqual([]);
});

test("a malformed excludeTokens is rejected rather than silently defaulted", async () => {
  existsMock.mockResolvedValue(true);
  readTextFileMock.mockResolvedValue(JSON.stringify([{ ...DEFAULT_PRESET, excludeTokens: "col" }]));

  await expect(loadPresets()).rejects.toThrow("excludeTokens");
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/lib/presets.test.ts`
Expected: FAIL — `DEFAULT_PRESET` 계약 테스트가 `excludeTokens` 없음으로 떨어지고, 새 테스트 셋도 떨어진다.

- [ ] **Step 3: 구현한다**

`src/lib/types.ts`의 `Preset`에 필드를 추가한다 (`splitLayers` 아래):

```ts
  /**
   * 이름에 검색어가 들어있어도 라인 아트가 아닌 것을 걸러내는 토큰.
   * `line col`, `LINE_COL`, `Line Colour`는 색 지정 레이어지 라인이 아니다.
   * 네 판별 규칙 중 이것만 어휘에 의존해서 편집 가능하게 둔다.
   * engine/psd_engine/matching.py의 DEFAULT_EXCLUDE_TOKENS와 기본값이 같아야 한다.
   */
  excludeTokens: string[];
```

`src/lib/presets.ts`에 상수를 추가하고 `DEFAULT_PRESET`에 넣는다:

```ts
/** 색 지정 레이어를 걸러내는 기본 어휘. 엔진 DEFAULT_EXCLUDE_TOKENS와 같다. */
export const DEFAULT_EXCLUDE_TOKENS = ["col", "colour", "color"];
```

```ts
export const DEFAULT_PRESET: Preset = {
  // ... 기존 필드 그대로 ...
  splitLayers: false,
  excludeTokens: [...DEFAULT_EXCLUDE_TOKENS],
};
```

`validatePreset`에 검증을 추가한다 (`roleTokens` 검증 옆):

```ts
  // excludeTokens도 나중에 추가된 항목 — 없으면 기본 어휘로 읽는다. 빈 배열은
  // "제외하지 않겠다"는 뜻이므로 기본값으로 되돌리지 않는다.
  if (v.excludeTokens !== undefined) {
    if (!Array.isArray(v.excludeTokens) || !v.excludeTokens.every((t) => typeof t === "string")) {
      throw new Error(`${prefix}.excludeTokens: 문자열 배열이 아닙니다.`);
    }
  }
```

반환 객체에 추가한다:

```ts
    excludeTokens: (v.excludeTokens as string[] | undefined) ?? [...DEFAULT_EXCLUDE_TOKENS],
```

- [ ] **Step 4: 다이얼로그에 state를 추가한다**

`src/components/PresetDialog.tsx`의 import에 `DEFAULT_EXCLUDE_TOKENS`를 더한다 (`DEFAULT_ROLE_TOKENS`를 가져오는 곳과 같은 줄).

`roleTokensText` state 아래(`PresetDialog.tsx:57-59`)에 추가한다:

```tsx
  const [excludeTokensText, setExcludeTokensText] = useState(
    (preset.excludeTokens ?? DEFAULT_EXCLUDE_TOKENS).join(", ")
  );
```

- [ ] **Step 5: 저장 페이로드에 넣는다**

`validate()`가 돌려주는 객체의 `excludeGroupPrefixes` 아래에 추가한다. 기존 `parseGroupPrefixes`가 쉼표 구분 문자열을 배열로 바꾼다(`PresetDialog.tsx:32-37`):

```tsx
      excludeTokens: parseGroupPrefixes(excludeTokensText),
```

- [ ] **Step 6: 폼 필드를 추가한다**

`excludeGroupPrefixes` 입력란(`PresetDialog.tsx:190-198`) 바로 아래에, 그 필드와 똑같은 마크업으로 넣는다. 클래스는 `preset-field`이고 이 다이얼로그는 도움말 문장을 따로 달지 않는다 — 라벨과 placeholder만 쓴다:

```tsx
        <label className="preset-field">
          <span>제외 토큰 (쉼표로 구분)</span>
          <input
            type="text"
            value={excludeTokensText}
            onChange={(e) => setExcludeTokensText(e.currentTarget.value)}
            placeholder="예: col, colour, color"
          />
        </label>
```

- [ ] **Step 7: 통과를 확인한다**

Run: `npx vitest run src/lib/presets.test.ts && npx tsc --noEmit && npm test`
Expected: PASS 전부. `tsc`가 다른 곳에서도 필드 누락을 잡으면 그 자리에도 `excludeTokens`를 넣는다.

- [ ] **Step 8: 커밋**

```bash
git add src/lib/types.ts src/lib/presets.ts src/lib/presets.test.ts src/components/PresetDialog.tsx
git commit -m "$(cat <<'EOF'
feat: let a preset carry the vocabulary of things that only look like lines

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltm3qkFkyb9oANqu3A2HRc
EOF
)"
```

---

### Task 7: 새 skip 사유가 오류 카드를 띄우지 않게

**Files:**
- Modify: `src/lib/engine.ts:45-52` (`SkippedLayer`), `src/state/appStore.tsx:431`
- Test: `src/state/appStore.test.ts`

**Interfaces:**
- Consumes: Task 2~5가 만든 사유 문자열 `notLineWord` / `groupHasOwnLine` / `excludedToken` / `blendMode`
- Produces: `applyPresetEffect`가 `reason === "noPixels"`인 항목만 돌려준다

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/state/appStore.test.ts`의 `applyPresetEffect` describe 안에 덧붙인다:

```ts
  // 규칙으로 뺀 것은 이상 징후가 아니다. 실파일 25개 기준 95장이 여기 얹히면
  // 이 카드가 경고하려던 진짜 오류(그릴 픽셀이 없는 레이어)가 묻힌다.
  test("layers dropped on purpose by a rule do not raise the card", async () => {
    mockApplyPreset.mockResolvedValue({
      matchedLayerIds: [1],
      operations: [],
      skippedLayers: [
        { id: 2, path: "*ART/Layer 866 (LINEAR DODGE)", kind: "pixel", reason: "notLineWord" },
        { id: 3, path: "*ART/lines/fill", kind: "pixel", reason: "groupHasOwnLine" },
        { id: 4, path: "*ART/line col", kind: "pixel", reason: "excludedToken" },
        { id: 5, path: "*ART/LINE WIN", kind: "pixel", reason: "blendMode" },
        { id: 9, path: "LayOut/BG/line curves", kind: "curves", reason: "noPixels" },
      ],
    });
    const actions: AppAction[] = [];

    const undrawable = await applyPresetEffect((a) => actions.push(a), "/a.psd", 3, preset);

    expect(undrawable).toEqual([
      { id: 9, path: "LayOut/BG/line curves", kind: "curves", reason: "noPixels" },
    ]);
    expect(actions.some((a) => a.type === "pushError")).toBe(false);
  });
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/state/appStore.test.ts`
Expected: FAIL — 현재 필터가 `reason !== "text"`라 새 사유 넷이 전부 통과해 `undrawable`이 5개가 된다. 타입 에러도 함께 난다.

- [ ] **Step 3: 구현한다**

`src/lib/engine.ts`의 `SkippedLayer`를 넓힌다:

```ts
export interface SkippedLayer {
  id: number;
  /** 그룹 경로까지 포함한 이름. `*ART/120_BG/BOTTOM_FLOOR_WALL/NOTE FOR LINE: ...` */
  path: string;
  kind: string;
  /**
   * 규칙에 걸렸는데도 결과에 없는 이유.
   *
   * "그릴 수 없어서" — "text"는 라인 PSD 안의 텍스트를 작업 메모로 본 것,
   * "noPixels"는 그릴 채널이 없는 것.
   *
   * "라인이 아니라서" — "notLineWord"는 이름에 검색어가 부분 문자열로만
   * 들어있는 것("LINEAR DODGE"), "groupHasOwnLine"은 그룹 이름 때문에 딸려올
   * 뻔했지만 그 그룹에 진짜 라인이 따로 있는 것, "excludedToken"은 제외
   * 토큰이 붙은 것("line col"), "blendMode"는 normal이 아닌 합성으로 얹힌 것.
   * 이쪽은 규칙이 의도한 결과라 오류가 아니다.
   */
  reason:
    | "text"
    | "noPixels"
    | "notLineWord"
    | "groupHasOwnLine"
    | "excludedToken"
    | "blendMode";
}
```

`src/state/appStore.tsx:431`의 필터를 허용 목록으로 바꾸고 위 주석을 갱신한다:

```ts
    // 규칙에 걸렸는데 그릴 것이 없어 빠진 레이어. 이름은 LINE인데 결과에 없으면
    // 사람이 그 이유를 알 방법이 없으므로 돌려준다.
    //
    // 거부 목록이 아니라 허용 목록인 것이 중요하다. 판별 규칙이 "라인이 아니다"라고
    // 뺀 것들(notLineWord/groupHasOwnLine/excludedToken/blendMode)은 의도한
    // 결과이고 수가 많다 — 실파일 25개에서 95장이다. 그것들이 카드에 얹히면
    // 이 카드가 경고하려던 진짜 오류가 묻힌다.
    //
    // 여기서 바로 알리지 않고 돌려주는 이유: 파일을 한꺼번에 불러올 때 파일마다
    // 카드를 띄우면 화면이 카드로 덮여 진짜 오류가 묻힌다. 언제 어떻게 알릴지는
    // 부르는 쪽이 정한다(App.tsx의 로드 큐는 끝에 한 장으로 모아 띄운다).
    return (result.skippedLayers ?? []).filter((s) => s.reason === "noPixels");
```

- [ ] **Step 4: 통과를 확인한다**

Run: `npx vitest run src/state/appStore.test.ts && npx tsc --noEmit`
Expected: PASS. 기존 테스트 "art that matched but had no pixels is handed back..."도 그대로 통과한다(`noPixels`만 남기는 결과가 같다).

- [ ] **Step 5: 커밋**

```bash
git add src/lib/engine.ts src/state/appStore.tsx src/state/appStore.test.ts
git commit -m "$(cat <<'EOF'
refactor: only undrawable art raises the card, not everything a rule dropped

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltm3qkFkyb9oANqu3A2HRc
EOF
)"
```

---

### Task 8: "라인만" 폴백도 같은 규칙으로

**Files:**
- Create: `src/lib/layerNames.ts`, `src/lib/layerNames.test.ts`
- Modify: `src/lib/layerFilter.ts:23-24` (`LINE_NAME_FALLBACK`), `:61-71` (`lineLeafIds`)
- Test: `src/lib/layerFilter.test.ts:83-86`

**Interfaces:**
- Consumes: 없음 (Task 1의 파이썬 구현을 그대로 옮긴다)
- Produces:
  - `tokenize(name: string): string[]`
  - `tokenMatch(name: string, value: string, caseSensitive?: boolean): boolean`
  - `hasAnyToken(name: string, wanted: string[], caseSensitive?: boolean): boolean`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/lib/layerNames.test.ts`:

```ts
import { expect, test } from "vitest";
import { hasAnyToken, tokenMatch, tokenize } from "./layerNames";

// engine/tests/test_names.py와 같은 표본이다 — 두 구현이 갈라지면 프리셋 적용
// 전후로 "라인만" 목록이 달라진다.
test("splits on separators, case boundaries and digits", () => {
  expect(tokenize("Wall_Line")).toEqual(["Wall", "Line"]);
  expect(tokenize("CurtainsLine")).toEqual(["Curtains", "Line"]);
  expect(tokenize("line2")).toEqual(["line", "2"]);
  expect(tokenize("CHAIR1_LINE")).toEqual(["CHAIR", "1", "LINE"]);
  expect(tokenize("Layer 866 (LINEAR DODGE)")).toEqual(["Layer", "866", "LINEAR", "DODGE"]);
  expect(tokenize("TopWindowArches_line")).toEqual(["Top", "Window", "Arches", "line"]);
  expect(tokenize("*ART")).toEqual(["ART"]);
  expect(tokenize("라인")).toEqual([]);
});

test("line matches as a word, not as a substring", () => {
  for (const name of ["line", "LINE", "LINES", "hidden line", "Wall_Line",
                      "CurtainsLine", "line2", "Wall_OL_Line"]) {
    expect(tokenMatch(name, "line"), name).toBe(true);
  }
  for (const name of ["Layer 866 (LINEAR DODGE)", "Linear Light", "kline col", "OUTLINE"]) {
    expect(tokenMatch(name, "line"), name).toBe(false);
  }
});

test("a case-sensitive search still accepts the plural", () => {
  expect(tokenMatch("LINES", "LINE", true)).toBe(true);
  expect(tokenMatch("lines", "LINE", true)).toBe(false);
});

test("a multi-token value must appear consecutively", () => {
  expect(tokenMatch("BROKEN WALL LINE", "wall line")).toBe(true);
  expect(tokenMatch("WALL fill LINE", "wall line")).toBe(false);
});

test("hasAnyToken finds the colour vocabulary", () => {
  expect(hasAnyToken("line col", ["col", "colour", "color"])).toBe(true);
  expect(hasAnyToken("Line Colour", ["col", "colour", "color"])).toBe(true);
  expect(hasAnyToken("COUCH LINE", ["col", "colour", "color"])).toBe(false);
});
```

`src/lib/layerFilter.test.ts`의 기존 테스트를 고친다. 지금 이것을

```ts
test("the name fallback is case-insensitive", () => {
  const mixed = flattenLeaves([leaf(7, "Outline sketch", ["G"])]);
  expect(lineLeafIds(mixed, [])).toEqual([7]);
});
```

이렇게 바꾼다:

```ts
test("the name fallback is case-insensitive", () => {
  const mixed = flattenLeaves([leaf(7, "LINE sketch", ["G"])]);
  expect(lineLeafIds(mixed, [])).toEqual([7]);
});

// 부분 문자열이 아니라 토큰으로 본다 — 엔진과 같은 규칙이어야 프리셋을 적용하기
// 전과 후의 목록이 갈라지지 않는다(engine/psd_engine/names.py).
test("the name fallback does not match line inside another word", () => {
  const linear = flattenLeaves([leaf(8, "Layer 866 (LINEAR DODGE)", ["G"])]);
  expect(lineLeafIds(linear, [])).toEqual([]);
});

test("the name fallback keeps underscore and camel case names", () => {
  const joined = flattenLeaves([leaf(9, "Wall_Line", ["G"]), leaf(10, "CurtainsLine", ["G"])]);
  expect(lineLeafIds(joined, [])).toEqual([9, 10]);
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/lib/layerNames.test.ts src/lib/layerFilter.test.ts`
Expected: `layerNames.test.ts`는 모듈이 없어 전부 FAIL. `layerFilter.test.ts`의 "does not match line inside another word"가 FAIL(부분 문자열로 걸린다).

- [ ] **Step 3: 구현한다**

`src/lib/layerNames.ts`:

```ts
/**
 * 레이어 이름을 토큰으로 쪼개고 비교한다.
 *
 * engine/psd_engine/names.py가 같은 규칙의 원본이다. 프리셋을 적용하기 전
 * "라인만" 패널은 여기 있는 폴백 규칙으로 도는데, 두 구현이 갈라지면 프리셋을
 * 누르는 순간 목록이 바뀐다. 한쪽을 고치면 다른 쪽도 고쳐야 한다.
 */

/**
 * 토큰 하나. 숫자 덩어리 / 연속 대문자(뒤에 소문자가 오지 않는 것) /
 * 대문자로 시작하는 낱말 / 소문자 덩어리.
 *
 * lookbehind를 쓰지 않는다 — 이 코드는 Tauri의 시스템 웹뷰에서 돌고
 * lookbehind는 Safari 16.4부터다.
 */
const TOKEN = /[0-9]+|[A-Z]+(?![a-z])|[A-Z][a-z]*|[a-z]+/g;

/** 이름의 토큰 목록. ASCII 영숫자가 없으면 빈 목록이다. */
export function tokenize(name: string): string[] {
  return name.match(TOKEN) ?? [];
}

function tokenEq(token: string, want: string, caseSensitive: boolean): boolean {
  const a = caseSensitive ? token : token.toLowerCase();
  const b = caseSensitive ? want : want.toLowerCase();
  if (a === b) return true;
  // 복수형 s를 받아준다 — 'line'으로 찾을 때 'LINES'가 빠지면 안 된다.
  return a.length === b.length + 1 && a.slice(0, -1) === b && (a.endsWith("s") || a.endsWith("S"));
}

/**
 * 이름의 토큰 열에 검색값의 토큰 열이 연속으로 나타나는가.
 * 검색값이 토큰을 하나도 만들지 못하면 false다 — 되돌아갈지는 호출자가 정한다.
 */
export function tokenMatch(name: string, value: string, caseSensitive = false): boolean {
  const want = tokenize(value);
  if (want.length === 0) return false;
  const have = tokenize(name);
  for (let i = 0; i + want.length <= have.length; i++) {
    if (want.every((w, j) => tokenEq(have[i + j], w, caseSensitive))) return true;
  }
  return false;
}

/** 이름의 토큰 중 하나라도 wanted에 있는가. */
export function hasAnyToken(name: string, wanted: string[], caseSensitive = false): boolean {
  const have = tokenize(name);
  return have.some((t) => wanted.some((w) => w.trim().length > 0 && tokenEq(t, w, caseSensitive)));
}
```

`src/lib/layerFilter.ts`를 고친다. import에 추가:

```ts
import { tokenMatch } from "./layerNames";
```

`LINE_NAME_FALLBACK` 주석을 갱신한다:

```ts
/**
 * 프리셋 매칭 결과가 아직 없을 때 "라인만"이 대신 쓰는 이름 규칙.
 * 부분 문자열이 아니라 토큰으로 본다 — 엔진과 같은 규칙이라야 프리셋을 누르는
 * 순간 목록이 바뀌지 않는다(engine/psd_engine/names.py).
 */
export const LINE_NAME_FALLBACK = "line";
```

`lineLeafIds`의 폴백 한 줄을 바꾼다:

```ts
  return leaves
    .filter((l) => tokenMatch(l.node.name, LINE_NAME_FALLBACK))
    .map((l) => l.node.id);
```

- [ ] **Step 4: 통과를 확인한다**

Run: `npm test && npx tsc --noEmit`
Expected: PASS 전부.

- [ ] **Step 5: 커밋**

```bash
git add src/lib/layerNames.ts src/lib/layerNames.test.ts src/lib/layerFilter.ts src/lib/layerFilter.test.ts
git commit -m "$(cat <<'EOF'
feat: the line-only panel reads names the same way the engine does

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltm3qkFkyb9oANqu3A2HRc
EOF
)"
```

---

### Task 9: 실파일 회귀 검증

**Files:**
- Create: `scripts/audit-line-matching.py`

**Interfaces:**
- Consumes: `psd_engine.matching.match_preset`, `psd_engine.tree.build_tree` — 감사 도구가 엔진 코드를 **그대로** 쓰는 것이 요점이다. 규칙을 다시 구현하면 갈라진다.
- Produces: 없음 (진단 도구)

- [ ] **Step 1: 스크립트를 쓴다**

`scripts/audit-line-matching.py`:

```python
"""
폴더 하나의 PSD 전부에 프리셋을 적용해, 무엇이 뽑히고 무엇이 왜 빠졌는지 센다.

판별 규칙을 바꿀 때 실제 납품 파일에서 결과가 어떻게 달라지는지 보는 도구다.
엔진의 match_preset을 그대로 부른다 — 여기서 규칙을 다시 구현하면 이 숫자가
앱의 동작과 갈라져 아무 의미가 없어진다.

    python scripts/audit-line-matching.py <폴더> [--verbose]
"""
import argparse
import collections
import glob
import os
import sys
import traceback

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "engine"))

from psd_tools import PSDImage  # noqa: E402

from psd_engine.matching import match_preset  # noqa: E402
from psd_engine.tree import build_tree  # noqa: E402

PRESET = {
    "include": {"type": "contains", "value": "line", "caseSensitive": False},
    "excludeGroupPrefixes": ["-"],
    "matchGroups": True,
    "includeHidden": True,
    "merge": "none",
    "naming": "pathPrefix",
    "outputSuffix": "_LINE",
    "embedPreview": True,
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    ap.add_argument("--verbose", action="store_true", help="빠진 레이어 경로를 전부 찍는다")
    args = ap.parse_args()

    files = sorted(glob.glob(os.path.join(args.folder, "*.psd")))
    if not files:
        sys.exit(f"PSD를 찾지 못했다: {args.folder}")

    total_matched = 0
    by_reason = collections.Counter()
    examples = collections.defaultdict(list)

    for i, path in enumerate(files, 1):
        print(f"[{i}/{len(files)}] {os.path.basename(path)}", file=sys.stderr)
        try:
            tree = build_tree(PSDImage.open(path))["tree"]
        except Exception:
            traceback.print_exc(file=sys.stderr)
            continue
        matched, skipped = match_preset(tree, PRESET)
        total_matched += len(matched)
        for s in skipped:
            by_reason[s["reason"]] += 1
            examples[s["reason"]].append(f"{os.path.basename(path)}: {s['path']}")

    print(f"\n파일 {len(files)}개")
    print(f"포함: {total_matched}장")
    print("빠진 이유:")
    for reason, count in by_reason.most_common():
        print(f"  {reason:<18} {count}")
        shown = examples[reason] if args.verbose else examples[reason][:3]
        for line in shown:
            print(f"      {line}")
        if not args.verbose and len(examples[reason]) > 3:
            print(f"      … 외 {len(examples[reason]) - 3}장")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: 실제 폴더에 돌린다**

```bash
engine/.venv/bin/python scripts/audit-line-matching.py \
  "/Volumes/bgfinal/colordata/Hazbin_Hotel/HH03_시즌_자료/HH0306/Design/COLOR/BG/02_Color"
```

Expected:

```
파일 25개
포함: 587장
빠진 이유:
  groupHasOwnLine    55
  excludedToken      18
  notLineWord         5
  blendMode           5
  noPixels            4
```

숫자가 다르면 구현이 설계와 갈라진 것이다. 어느 규칙의 수가 어긋났는지가 곧 어느 태스크를 다시 볼지를 알려준다.

**설계 문서 2·4절의 645 / 67과 왜 다른지** — 그 수치는 규칙의 효과를 재던 오프라인 분석 스크립트에서 나왔고, 그 스크립트가 기본 프리셋의 `excludeGroupPrefixes: ["-"]`를 적용하지 않았다. 그래서 엔진이 애초에 들어가지도 않는 `-BGCU`(47장)와 `-LayOut`(19장) 아래 leaf 66장까지 후보로 셌다. 대사는 정확히 맞는다:

- 오프라인 "최종 645" 중 54장이 `-` 그룹 아래 → `645 − 54 = 591` = 실측 587 + `noPixels` 4
- `groupHasOwnLine` 67 중 12장이 `-` 그룹 아래 → `67 − 12 = 55` = 실측 55
- `excludedToken` 18 / `notLineWord` 5 / `blendMode` 5 — 오프라인 분석과 정확히 일치

즉 네 규칙의 동작은 설계 그대로이고, 틀린 것은 절대 수치뿐이다. 위 표가 기본 프리셋 전체를 적용한 참값이다.

볼륨이 마운트돼 있지 않으면 이 단계는 건너뛰고, 사용자에게 폴더 경로를 물어 다시 돌린다. **건너뛴 경우 그 사실을 보고한다** — 이 태스크의 산출물은 스크립트가 아니라 숫자다.

- [ ] **Step 3: 전체 테스트를 돌린다**

```bash
cd engine && uv run pytest && cd .. && npm test && npx tsc --noEmit && npm run build
```

Expected: PASS 전부.

- [ ] **Step 4: 커밋**

```bash
git add scripts/audit-line-matching.py
git commit -m "$(cat <<'EOF'
feat: count what the rules keep and drop across a folder of real PSDs

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltm3qkFkyb9oANqu3A2HRc
EOF
)"
```

---

## 남는 것 — 이 계획의 범위 밖

설계 문서가 명시적으로 범위 밖에 둔 것들이다. 구현 중에 손대지 않는다.

- **레이어 행의 "왜 빠졌는지" 툴팁.** 사유는 엔진 응답에 남지만 화면에는 안 나온다.
- **잔여 오탐 3장** (`CLUB PAW PRINT`, `CRAPS DESING`, `glow`). 그 그룹에 자기 이름 매치가 아예 없어 이름으로는 단서가 없다.
- **`OUTLINE`을 라인으로 볼지.** 토큰 매칭에서 `outline`은 `line`과 다른 토큰이라 걸리지 않는다. 검증한 25개 파일에는 `outline` 레이어가 하나도 없었지만, 다른 폴더에 있고 그것이 진짜 라인이라면 판단이 필요하다 — 그때는 검색값을 `regex` 타입의 `outline|line`으로 바꾸는 것으로 프리셋 수준에서 해결된다.
