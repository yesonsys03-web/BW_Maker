# PSD Engine (Plan A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PSD 레이어 추출·편집·내보내기를 수행하는 JSON-RPC 사이드카 엔진(Python)을 완성한다. UI 없이 stdin/stdout만으로 완결 동작·테스트 가능.

**Architecture:** psd-tools(읽기·합성) + pytoshop(쓰기, 2개 패치 적용). 장수명 프로세스가 세션(LRU 2)을 유지하고, 줄 단위 JSON-RPC로 open/tree/thumbnail/preview/export/batch 명령을 처리한다. 편집은 비파괴 operation list를 내보내기 시점에 적용한다.

**Tech Stack:** Python 3.12, uv, psd-tools 1.17.x, pytoshop 1.2.1, numpy 2.x, Pillow, pytest.

**Spec:** `docs/superpowers/specs/2026-07-30-psd-layer-tool-design.md`

## Global Constraints

- RGB 8bit PSD만 지원. 그 외(16bit, CMYK 등)는 **명시적 에러로 거부**.
- 원본 PSD는 절대 수정하지 않는다. 출력은 항상 호출자가 지정한 경로의 새 파일.
- **에러 fallback·흡수 금지.** 모든 예외는 `{message, traceback}`로 호출자에게 그대로 전달.
- IPC는 줄 단위 JSON: 요청 `{id, method, params}` → 응답 `{id, result}` 또는 `{id, error:{message, traceback}}`. 진행률은 `{"event":"progress",...}` 알림.
- 썸네일/미리보기 등 큰 바이너리는 JSON에 넣지 않고 임시 PNG 파일 경로로 반환.
- 세션은 LRU 최대 2개. 배치는 파일당 열고-처리-닫기 순차 실행.
- pytoshop 주의사항(이미 실파일 검증됨): nested_layers 리스트는 **index 0이 최상단**, `nested_layers_to_psd(size=(width, height))`, cython packbits 부재 → psd-tools C RLE로 패치, 유니코드 레이어명 길이에 NUL 포함 → 패치.
- 레이어 id는 psd-tools 트리 pre-order 순회 순서의 정수(0부터). 리프끼리는 id 오름차순 = 쌓임 순서(아래→위).
- 레이어 마스크는 추출/병합 시 픽셀에 적용.
- 커밋 메시지 끝에 항상:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` 와
  `Claude-Session: https://claude.ai/code/session_015qxsoeck1KQRvYE2KqBxK7`
- 모든 명령은 `engine/` 디렉터리에서 실행: `uv sync`, `uv run pytest ...`

---

### Task 1: 엔진 스캐폴드 + pytoshop 패치 모듈

**Files:**
- Create: `engine/pyproject.toml`
- Create: `engine/psd_engine/__init__.py` (빈 파일)
- Create: `engine/psd_engine/patches.py`
- Test: `engine/tests/test_patches.py`

**Interfaces:**
- Produces: `psd_engine.patches.apply_pytoshop_patches() -> None` — 멱등(여러 번 호출해도 1회만 적용). 이후 pytoshop으로 쓴 PSD가 RLE 압축으로 저장되고 레이어명에 NUL이 붙지 않는다.

- [ ] **Step 1: 프로젝트 파일 작성**

`engine/pyproject.toml`:

```toml
[project]
name = "psd-engine"
version = "0.1.0"
description = "PSD layer extraction/edit/export JSON-RPC engine"
requires-python = ">=3.12"
dependencies = [
    "psd-tools>=1.17,<2",
    "pytoshop==1.2.1",
    "six>=1.16",
    "numpy>=2",
    "pillow>=10",
]

[dependency-groups]
dev = ["pytest>=8"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["psd_engine"]
```

`engine/psd_engine/__init__.py`: 빈 파일.

Run: `cd engine && uv sync` → 성공 확인.

- [ ] **Step 2: 실패하는 테스트 작성**

`engine/tests/test_patches.py`:

```python
import numpy as np


def test_patched_pytoshop_writes_rle_psd_with_clean_names(tmp_path):
    from psd_engine.patches import apply_pytoshop_patches

    apply_pytoshop_patches()
    apply_pytoshop_patches()  # 멱등성

    from psd_tools import PSDImage
    from pytoshop import enums
    from pytoshop.user import nested_layers

    a = np.full((10, 10), 200, np.uint8)
    img = nested_layers.Image(
        name="한글layer", channels={0: a, 1: a, 2: a, -1: a},
        top=2, left=3, opacity=255, visible=True,
        blend_mode=enums.BlendMode.normal,
    )
    psd = nested_layers.nested_layers_to_psd(
        [img], color_mode=enums.ColorMode.rgb, size=(20, 15)
    )
    path = tmp_path / "out.psd"
    with open(path, "wb") as f:
        psd.write(f)

    out = PSDImage.open(path)
    assert (out.width, out.height) == (20, 15)
    layer = list(out)[0]
    assert layer.name == "한글layer"          # 후행 NUL 없음
    assert layer.bbox == (3, 2, 13, 12)
    arr = np.array(layer.topil().convert("RGBA"))
    assert arr.shape == (10, 10, 4)
    assert (arr == 200).all()
```

- [ ] **Step 3: 실패 확인**

Run: `uv run pytest tests/test_patches.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'psd_engine.patches'`

- [ ] **Step 4: 구현**

`engine/psd_engine/patches.py`:

```python
"""pytoshop 호환 패치 2종.

1. pytoshop 휠에 cython packbits 모듈이 없어 RLE 저장이 NameError로 죽는다
   → psd-tools의 C 확장 RLE 인코더로 대체.
2. pytoshop이 유니코드 문자열 길이에 NUL 종료 문자를 포함해 레이어명 끝에
   \x00이 붙는다 → 길이에서 제외(바이트 배치는 동일하게 유지).
"""
import struct

import numpy as np

_applied = False


def apply_pytoshop_patches() -> None:
    global _applied
    if _applied:
        return

    import pytoshop.codecs as codecs
    import pytoshop.util as putil
    from psd_tools.compression import rle_impl

    class _PackbitsShim:
        @staticmethod
        def encode(row):
            return rle_impl.encode(np.ascontiguousarray(row).tobytes())

    codecs.packbits = _PackbitsShim

    def _encode_unicode_string(s):
        # 데이터 + 2바이트 패딩은 유지(블록 길이 계산 일관성), 문자 수에서 NUL 제외
        return struct.pack(">L", len(s)) + s.encode("utf_16_be") + b"\0\0"

    putil.encode_unicode_string = _encode_unicode_string
    _applied = True
```

- [ ] **Step 5: 통과 확인**

Run: `uv run pytest tests/test_patches.py -v`
Expected: PASS

- [ ] **Step 6: 커밋**

```bash
git add engine/
git commit -m "feat(engine): scaffold + pytoshop RLE/unicode patches"
```

---

### Task 2: 테스트 픽스처 PSD 빌더

**Files:**
- Create: `engine/tests/conftest.py`
- Test: `engine/tests/test_fixture.py`

**Interfaces:**
- Produces (conftest):
  - `make_image(name, value, x, y, w, h, alpha=255, visible=True, blend=None) -> nested_layers.Image`
  - `write_psd(path, layers_top_first, width=64, height=48) -> str(path)`
  - pytest fixture `fixture_psd(tmp_path) -> pathlib.Path` — 아래 고정 구조의 PSD 파일 경로.

픽스처 구조 — psd-tools 순회(아래→위) pre-order id 부여 결과:

```
id 0: group '*ART'
id 1:   group 'BG'
id 2:     pixel 'fill'        value=128, bbox=(0,0,64,48), visible
id 3:     pixel 'hidden line' value=77,  bbox=(5,5,9,9),   visible=False
id 4:     pixel 'line'        value=50,  bbox=(0,0,32,24), visible
id 5:   pixel 'lines'         value=200, bbox=(10,10,30,20), visible
id 6: group '-REF'
id 7:   pixel 'line'          value=10,  bbox=(0,0,8,8),   visible
```

- [ ] **Step 1: conftest 작성**

`engine/tests/conftest.py`:

```python
import numpy as np
import pytest
from pytoshop import enums
from pytoshop.user import nested_layers

from psd_engine.patches import apply_pytoshop_patches

CANVAS_W, CANVAS_H = 64, 48


def make_image(name, value, x, y, w, h, alpha=255, visible=True, blend=None):
    px = np.full((h, w), value, np.uint8)
    a = np.full((h, w), alpha, np.uint8)
    return nested_layers.Image(
        name=name, channels={0: px, 1: px, 2: px, -1: a},
        top=y, left=x, opacity=255, visible=visible,
        blend_mode=blend or enums.BlendMode.normal,
    )


def write_psd(path, layers_top_first, width=CANVAS_W, height=CANVAS_H):
    apply_pytoshop_patches()
    psd = nested_layers.nested_layers_to_psd(
        layers_top_first, color_mode=enums.ColorMode.rgb, size=(width, height)
    )
    with open(path, "wb") as f:
        psd.write(f)
    return str(path)


@pytest.fixture
def fixture_psd(tmp_path):
    # 리스트는 index 0 = 최상단. 문서 아래→위 = *ART(fill, hidden line, line, lines), -REF(line)
    art = nested_layers.Group(name="*ART", layers=[
        make_image("lines", 200, 10, 10, 20, 10),
        nested_layers.Group(name="BG", layers=[
            make_image("line", 50, 0, 0, 32, 24),
            make_image("hidden line", 77, 5, 5, 4, 4, visible=False),
            make_image("fill", 128, 0, 0, 64, 48),
        ]),
    ])
    ref = nested_layers.Group(name="-REF", layers=[
        make_image("line", 10, 0, 0, 8, 8),
    ])
    p = tmp_path / "fixture.psd"
    write_psd(p, [ref, art])
    return p
```

- [ ] **Step 2: 실패하는 테스트 작성**

`engine/tests/test_fixture.py`:

```python
from psd_tools import PSDImage


def _walk(layers, out, depth=0):
    for l in layers:
        out.append((depth, l.name, "group" if l.is_group() else l.kind, l.visible))
        if l.is_group():
            _walk(l, out, depth + 1)


def test_fixture_structure(fixture_psd):
    psd = PSDImage.open(fixture_psd)
    assert (psd.width, psd.height) == (64, 48)
    got = []
    _walk(psd, got)
    assert got == [
        (0, "*ART", "group", True),
        (1, "BG", "group", True),
        (2, "fill", "pixel", True),
        (2, "hidden line", "pixel", False),
        (2, "line", "pixel", True),
        (1, "lines", "pixel", True),
        (0, "-REF", "group", True),
        (1, "line", "pixel", True),
    ]
```

- [ ] **Step 3: 실패 확인**

Run: `uv run pytest tests/test_fixture.py -v`
Expected: FAIL (conftest 미완성 상태면 에러, 완성했다면 PASS — PASS면 Step 4 생략)

- [ ] **Step 4: 통과할 때까지 conftest 수정**

Run: `uv run pytest tests/test_fixture.py -v`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add engine/tests/
git commit -m "test(engine): programmatic fixture PSD builder"
```

---

### Task 3: 레이어 트리 구축 (tree.py)

**Files:**
- Create: `engine/psd_engine/tree.py`
- Test: `engine/tests/test_tree.py`

**Interfaces:**
- Consumes: psd-tools `PSDImage`
- Produces: `build_tree(psd) -> {"tree": [node...], "nodes_by_id": {int: node}, "layers_by_id": {int: psd_tools layer}}`
  - node = `{"id": int, "name": str, "kind": "group"|"pixel"|..., "visible": bool, "blendMode": str, "opacity": int, "bbox": [l,t,r,b], "hasMask": bool, "path": [str,...], "children": [node...]?}` (`children`은 group에만 존재)
  - id는 pre-order 순회 순서 정수(0부터).

- [ ] **Step 1: 실패하는 테스트 작성**

`engine/tests/test_tree.py`:

```python
from psd_tools import PSDImage

from psd_engine.tree import build_tree


def test_build_tree_ids_and_fields(fixture_psd):
    built = build_tree(PSDImage.open(fixture_psd))
    n = built["nodes_by_id"]

    assert [n[i]["name"] for i in range(8)] == [
        "*ART", "BG", "fill", "hidden line", "line", "lines", "-REF", "line",
    ]
    assert n[0]["kind"] == "group" and "children" in n[0]
    assert n[2]["kind"] == "pixel" and "children" not in n[2]
    assert n[3]["visible"] is False
    assert n[4]["path"] == ["*ART", "BG", "line"]
    assert n[4]["bbox"] == [0, 0, 32, 24]
    assert n[2]["blendMode"] == "normal"
    assert n[2]["opacity"] == 255
    assert n[2]["hasMask"] is False
    assert built["layers_by_id"][5].name == "lines"
    # 트리 루트는 최상위 노드 2개
    assert [t["name"] for t in built["tree"]] == ["*ART", "-REF"]
```

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/test_tree.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: 구현**

`engine/psd_engine/tree.py`:

```python
"""psd-tools PSDImage → 직렬화 가능한 레이어 트리(JSON) + id 인덱스."""


def build_tree(psd):
    nodes_by_id = {}
    layers_by_id = {}

    def walk(layers, path):
        children = []
        for layer in layers:
            node_id = len(nodes_by_id)
            node = {
                "id": node_id,
                "name": layer.name,
                "kind": "group" if layer.is_group() else layer.kind,
                "visible": bool(layer.visible),
                "blendMode": layer.blend_mode.name.lower(),
                "opacity": int(layer.opacity),
                "bbox": list(layer.bbox),
                "hasMask": layer.mask is not None,
                "path": path + [layer.name],
            }
            nodes_by_id[node_id] = node
            layers_by_id[node_id] = layer
            if layer.is_group():
                node["children"] = walk(layer, node["path"])
            children.append(node)
        return children

    tree = walk(psd, [])
    return {"tree": tree, "nodes_by_id": nodes_by_id, "layers_by_id": layers_by_id}
```

- [ ] **Step 4: 통과 확인**

Run: `uv run pytest tests/test_tree.py -v`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add engine/psd_engine/tree.py engine/tests/test_tree.py
git commit -m "feat(engine): layer tree builder with stable ids"
```

---

### Task 4: 세션 스토어 (session.py)

**Files:**
- Create: `engine/psd_engine/session.py`
- Test: `engine/tests/test_session.py`

**Interfaces:**
- Consumes: `tree.build_tree`
- Produces: `SessionStore(max_sessions=2)`
  - `.open(path) -> int(sessionId)` — RGB 8bit 아니면 `ValueError`. LRU 초과 시 가장 오래된 세션 자동 제거.
  - `.get(sessionId) -> session dict` `{"psd", "path", "tree", "nodes_by_id", "layers_by_id"}` — 없으면 `KeyError`. 호출 시 최근 사용으로 갱신.
  - `.close(sessionId) -> None` — 없어도 에러 아님.

- [ ] **Step 1: 실패하는 테스트 작성**

`engine/tests/test_session.py`:

```python
import pytest

from psd_engine.session import SessionStore


def test_open_get_close(fixture_psd):
    store = SessionStore()
    sid = store.open(fixture_psd)
    s = store.get(sid)
    assert s["path"] == str(fixture_psd)
    assert s["nodes_by_id"][5]["name"] == "lines"
    store.close(sid)
    with pytest.raises(KeyError):
        store.get(sid)


def test_lru_evicts_oldest(fixture_psd, tmp_path):
    import shutil
    p2 = tmp_path / "b.psd"; shutil.copy(fixture_psd, p2)
    p3 = tmp_path / "c.psd"; shutil.copy(fixture_psd, p3)

    store = SessionStore(max_sessions=2)
    s1 = store.open(fixture_psd)
    s2 = store.open(p2)
    store.get(s1)               # s1을 최근 사용으로
    s3 = store.open(p3)         # s2가 밀려남
    store.get(s1)
    store.get(s3)
    with pytest.raises(KeyError):
        store.get(s2)


def test_rejects_non_rgb8(tmp_path):
    store = SessionStore()
    bad = tmp_path / "bad.psd"
    bad.write_bytes(b"not a psd")
    with pytest.raises(Exception):   # psd-tools 파싱 에러가 그대로 전파되어야 함
        store.open(bad)
```

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/test_session.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: 구현**

`engine/psd_engine/session.py`:

```python
"""열린 PSD 세션 관리. LRU 최대 2개 (640MB급 파일 메모리 보호)."""
import itertools
from collections import OrderedDict

from psd_tools import PSDImage
from psd_tools.constants import ColorMode

from .tree import build_tree


class SessionStore:
    def __init__(self, max_sessions=2):
        self._sessions = OrderedDict()
        self._ids = itertools.count(1)
        self._max = max_sessions

    def open(self, path):
        psd = PSDImage.open(path)
        if psd.color_mode != ColorMode.RGB:
            raise ValueError(f"unsupported color mode: {psd.color_mode!r} (RGB only)")
        if psd.depth != 8:
            raise ValueError(f"unsupported bit depth: {psd.depth} (8-bit only)")
        built = build_tree(psd)
        sid = next(self._ids)
        self._sessions[sid] = {
            "psd": psd,
            "path": str(path),
            "tree": built["tree"],
            "nodes_by_id": built["nodes_by_id"],
            "layers_by_id": built["layers_by_id"],
        }
        while len(self._sessions) > self._max:
            self._sessions.popitem(last=False)
        return sid

    def get(self, sid):
        if sid not in self._sessions:
            raise KeyError(f"unknown or evicted session: {sid}")
        self._sessions.move_to_end(sid)
        return self._sessions[sid]

    def close(self, sid):
        self._sessions.pop(sid, None)
```

- [ ] **Step 4: 통과 확인**

Run: `uv run pytest tests/test_session.py -v`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add engine/psd_engine/session.py engine/tests/test_session.py
git commit -m "feat(engine): session store with LRU eviction and RGB8 gate"
```

---

### Task 5: 프리셋 매칭 (matching.py)

**Files:**
- Create: `engine/psd_engine/matching.py`
- Test: `engine/tests/test_matching.py`

**Interfaces:**
- Consumes: `tree` (node dict 리스트)
- Produces:
  - `match_preset(tree, preset) -> [int]` — 매치된 pixel 레이어 id, 문서 순서(아래→위). 매치가 non-pixel 레이어면 `ValueError`.
  - `preset_operations(tree, matched_ids, preset) -> [operation dict]` — preset의 merge 모드를 operation list로 변환.
- preset dict 형식 (스펙 5절):
  `{"include": {"type": "contains"|"regex", "value": str, "caseSensitive": bool}, "excludeGroupPrefixes": [str], "matchGroups": bool, "includeHidden": bool, "merge": "none"|"all"|"perGroup", "naming": "pathPrefix"|"original", "outputSuffix": str, "embedPreview": bool}`

- [ ] **Step 1: 실패하는 테스트 작성**

`engine/tests/test_matching.py`:

```python
import pytest
from psd_tools import PSDImage

from psd_engine.matching import match_preset, preset_operations
from psd_engine.tree import build_tree


def _preset(**over):
    p = {
        "include": {"type": "contains", "value": "line", "caseSensitive": False},
        "excludeGroupPrefixes": ["-"],
        "matchGroups": True,
        "includeHidden": True,
        "merge": "none",
        "naming": "pathPrefix",
        "outputSuffix": "_LINE",
        "embedPreview": True,
    }
    p.update(over)
    return p


@pytest.fixture
def tree(fixture_psd):
    return build_tree(PSDImage.open(fixture_psd))["tree"]


def test_contains_with_exclude_prefix(tree):
    # 'hidden line'(3), 'line'(4), 'lines'(5). -REF의 line(7)은 제외
    assert match_preset(tree, _preset()) == [3, 4, 5]


def test_include_hidden_false(tree):
    assert match_preset(tree, _preset(includeHidden=False)) == [4, 5]


def test_no_exclude_prefix_includes_ref(tree):
    assert match_preset(tree, _preset(excludeGroupPrefixes=[])) == [3, 4, 5, 7]


def test_regex(tree):
    p = _preset(include={"type": "regex", "value": r"^line$", "caseSensitive": False})
    assert match_preset(tree, p) == [4]


def test_matched_group_pulls_descendants(tree):
    # 'BG'가 매치되는 규칙 → BG 하위 픽셀 전부 포함
    p = _preset(include={"type": "contains", "value": "bg", "caseSensitive": False})
    assert match_preset(tree, p) == [2, 3, 4]


def test_preset_operations_merge_all(tree):
    ids = match_preset(tree, _preset())
    ops = preset_operations(tree, ids, _preset(merge="all"))
    assert ops == [{"op": "merge", "layerIds": [3, 4, 5], "name": "merged"}]


def test_preset_operations_per_group(tree):
    ids = match_preset(tree, _preset())
    ops = preset_operations(tree, ids, _preset(merge="perGroup"))
    # BG 그룹 안의 3,4만 2개 이상 → 병합. 'lines'(5)는 단독이라 그대로.
    assert ops == [{"op": "merge", "layerIds": [3, 4], "name": "BG"}]
```

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/test_matching.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: 구현**

`engine/psd_engine/matching.py`:

```python
"""프리셋 규칙 → 매치 레이어 id 목록 / operation list 변환."""
import re


def _name_matches(name, include):
    kind = include["type"]
    if kind == "contains":
        if include.get("caseSensitive"):
            return include["value"] in name
        return include["value"].lower() in name.lower()
    if kind == "regex":
        flags = 0 if include.get("caseSensitive") else re.IGNORECASE
        return re.search(include["value"], name, flags) is not None
    raise ValueError(f"unknown include type: {kind!r}")


def match_preset(tree, preset):
    matched = []
    prefixes = tuple(preset.get("excludeGroupPrefixes", []))

    def walk(nodes, inside_matched_group):
        for node in nodes:
            if node["kind"] == "group":
                if prefixes and node["name"].startswith(prefixes):
                    continue
                hit = preset.get("matchGroups", True) and _name_matches(
                    node["name"], preset["include"]
                )
                walk(node["children"], inside_matched_group or hit)
                continue
            if not (_name_matches(node["name"], preset["include"]) or inside_matched_group):
                continue
            if not node["visible"] and not preset.get("includeHidden", True):
                continue
            if node["kind"] != "pixel":
                raise ValueError(
                    f"matched non-pixel layer {'/'.join(node['path'])!r} "
                    f"(kind={node['kind']}) — not supported in v1"
                )
            matched.append(node["id"])

    walk(tree, False)
    return matched


def preset_operations(tree, matched_ids, preset):
    mode = preset.get("merge", "none")
    if mode == "none":
        return []
    if mode == "all":
        if len(matched_ids) < 2:
            return []
        return [{"op": "merge", "layerIds": list(matched_ids), "name": "merged"}]
    if mode == "perGroup":
        matched_set = set(matched_ids)
        groups = {}  # parent id -> (parent name, [leaf ids])

        def walk(nodes, parent):
            for node in nodes:
                if node["kind"] == "group":
                    walk(node["children"], node)
                elif node["id"] in matched_set:
                    key = parent["id"] if parent else -1
                    name = parent["name"] if parent else "root"
                    groups.setdefault(key, (name, []))[1].append(node["id"])

        walk(tree, None)
        return [
            {"op": "merge", "layerIds": ids, "name": name}
            for name, ids in groups.values()
            if len(ids) >= 2
        ]
    raise ValueError(f"unknown merge mode: {mode!r}")
```

- [ ] **Step 4: 통과 확인**

Run: `uv run pytest tests/test_matching.py -v`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add engine/psd_engine/matching.py engine/tests/test_matching.py
git commit -m "feat(engine): preset matching and preset-to-operations"
```

---

### Task 6: 편집 연산 적용 (ops.py)

**Files:**
- Create: `engine/psd_engine/ops.py`
- Test: `engine/tests/test_ops.py`

**Interfaces:**
- Consumes: `nodes_by_id` (tree), 포함 레이어 id 목록, operation list
- Produces:
  - `build_export_plan(included_ids, operations) -> [entry...]` — 아래→위 순서.
    entry = `{"entryId": int, "sourceIds": [int], "name": str|None}`.
    원본 레이어 entry의 entryId == 레이어 id. merge로 생긴 entry는 entryId가 음수(-1부터 감소).
    잘못된 참조는 `KeyError`, merge 대상 < 2개는 `ValueError`.
  - `finalize_names(entries, nodes_by_id, naming) -> entries` — 각 entry에 `"finalName"` 추가.
    naming="original"이면 원본 이름, "pathPrefix"면 경로 접두어(`*`로 시작하는 조각과 `Group N` 조각 제거, 연속 중복 제거, `_` 연결). 이름 충돌 시 `_2`, `_3` 접미사. merge entry는 op의 name 사용.
- operation 형식 (스펙 4절): `exclude{layerIds}`, `rename{layerId,name}`, `merge{layerIds,name}`, `flatten{name}`, `reorder{layerId,aboveId|null}` — layerId 자리는 entryId를 받는다(병합 결과 재참조 가능).

- [ ] **Step 1: 실패하는 테스트 작성**

`engine/tests/test_ops.py`:

```python
import pytest
from psd_tools import PSDImage

from psd_engine.ops import build_export_plan, finalize_names
from psd_engine.tree import build_tree

INCLUDED = [3, 4, 5]  # fixture: hidden line, line, lines (아래→위)


def ids(entries):
    return [e["entryId"] for e in entries]


def test_no_ops_keeps_order():
    assert ids(build_export_plan(INCLUDED, [])) == [3, 4, 5]


def test_exclude():
    plan = build_export_plan(INCLUDED, [{"op": "exclude", "layerIds": [4]}])
    assert ids(plan) == [3, 5]


def test_exclude_unknown_raises():
    with pytest.raises(KeyError):
        build_export_plan(INCLUDED, [{"op": "exclude", "layerIds": [99]}])


def test_rename():
    plan = build_export_plan(INCLUDED, [{"op": "rename", "layerId": 5, "name": "L"}])
    assert plan[2]["name"] == "L"


def test_merge_replaces_at_topmost_and_orders_sources():
    plan = build_export_plan(INCLUDED, [{"op": "merge", "layerIds": [5, 3], "name": "M"}])
    assert ids(plan) == [4, -1]
    merged = plan[1]
    assert merged["sourceIds"] == [3, 5]   # 아래→위 순서 유지
    assert merged["name"] == "M"


def test_merge_result_can_be_merged_again():
    plan = build_export_plan(INCLUDED, [
        {"op": "merge", "layerIds": [3, 4], "name": "A"},
        {"op": "merge", "layerIds": [-1, 5], "name": "B"},
    ])
    assert ids(plan) == [-2]
    assert plan[0]["sourceIds"] == [3, 4, 5]


def test_flatten():
    plan = build_export_plan(INCLUDED, [{"op": "flatten", "name": "F"}])
    assert ids(plan) == [-1]
    assert plan[0]["sourceIds"] == [3, 4, 5]


def test_reorder_above_and_bottom():
    plan = build_export_plan(INCLUDED, [{"op": "reorder", "layerId": 3, "aboveId": 5}])
    assert ids(plan) == [4, 5, 3]
    plan = build_export_plan(INCLUDED, [{"op": "reorder", "layerId": 5, "aboveId": None}])
    assert ids(plan) == [5, 3, 4]


def test_finalize_names(fixture_psd):
    nodes = build_tree(PSDImage.open(fixture_psd))["nodes_by_id"]
    entries = build_export_plan(INCLUDED, [])
    finalize_names(entries, nodes, "pathPrefix")
    # path: *ART/BG/hidden line → BG_hidden line, *ART/BG/line → BG_line, *ART/lines → lines
    assert [e["finalName"] for e in entries] == ["BG_hidden line", "BG_line", "lines"]

    entries = build_export_plan(INCLUDED, [])
    finalize_names(entries, nodes, "original")
    assert [e["finalName"] for e in entries] == ["hidden line", "line", "lines"]


def test_finalize_names_dedup(fixture_psd):
    nodes = build_tree(PSDImage.open(fixture_psd))["nodes_by_id"]
    entries = build_export_plan([4, 7], [])   # 둘 다 원본 이름 'line'
    finalize_names(entries, nodes, "original")
    assert [e["finalName"] for e in entries] == ["line", "line_2"]
```

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/test_ops.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: 구현**

`engine/psd_engine/ops.py`:

```python
"""비파괴 operation list → export plan(entry 목록, 아래→위)."""


def build_export_plan(included_ids, operations):
    entries = [{"entryId": i, "sourceIds": [i], "name": None} for i in included_ids]
    by_id = {e["entryId"]: e for e in entries}
    merge_counter = 0

    def require(entry_id):
        if entry_id not in by_id:
            raise KeyError(f"unknown entry id: {entry_id}")
        return by_id[entry_id]

    def do_merge(entry_ids, name):
        nonlocal merge_counter
        group = [require(i) for i in entry_ids]
        if len(group) < 2:
            raise ValueError("merge needs at least 2 layers")
        group_sorted = sorted(group, key=entries.index)
        top_index = entries.index(group_sorted[-1])
        merge_counter -= 1
        merged = {
            "entryId": merge_counter,
            "sourceIds": [sid for e in group_sorted for sid in e["sourceIds"]],
            "name": name,
        }
        entries.insert(top_index + 1, merged)
        for e in group:
            entries.remove(e)
            del by_id[e["entryId"]]
        by_id[merged["entryId"]] = merged

    for op in operations:
        kind = op["op"]
        if kind == "exclude":
            for lid in op["layerIds"]:
                e = require(lid)
                entries.remove(e)
                del by_id[lid]
        elif kind == "rename":
            require(op["layerId"])["name"] = op["name"]
        elif kind == "merge":
            do_merge(op["layerIds"], op["name"])
        elif kind == "flatten":
            do_merge([e["entryId"] for e in entries], op["name"])
        elif kind == "reorder":
            e = require(op["layerId"])
            entries.remove(e)
            above = op.get("aboveId")
            if above is None:
                entries.insert(0, e)
            else:
                entries.insert(entries.index(require(above)) + 1, e)
        else:
            raise ValueError(f"unknown op: {kind!r}")
    return entries


def _path_prefix_name(path):
    parts = [p for p in path if not p.startswith("*") and not p.lower().startswith("group ")]
    out = []
    for p in parts:
        if not out or out[-1].lower() != p.lower():
            out.append(p)
    return "_".join(out)


def finalize_names(entries, nodes_by_id, naming):
    if naming not in ("pathPrefix", "original"):
        raise ValueError(f"unknown naming rule: {naming!r}")
    used = {}
    for e in entries:
        if e["name"] is not None:
            base = e["name"]
        else:
            path = nodes_by_id[e["sourceIds"][-1]]["path"]
            base = path[-1] if naming == "original" else _path_prefix_name(path)
        count = used.get(base, 0) + 1
        used[base] = count
        e["finalName"] = base if count == 1 else f"{base}_{count}"
    return entries
```

- [ ] **Step 4: 통과 확인**

Run: `uv run pytest tests/test_ops.py -v`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add engine/psd_engine/ops.py engine/tests/test_ops.py
git commit -m "feat(engine): export plan builder (exclude/rename/merge/flatten/reorder) + naming"
```

---

### Task 7: 픽셀 렌더링 (render.py)

**Files:**
- Create: `engine/psd_engine/render.py`
- Test: `engine/tests/test_render.py`

**Interfaces:**
- Consumes: session dict (`psd`, `layers_by_id`)
- Produces:
  - `extract_rgba(layer) -> np.ndarray (H,W,4) uint8` — 레이어 마스크 적용(비활성 마스크 제외).
  - `merge_rgba(psd, layers) -> (np.ndarray, left, top)` — psd-tools 합성(블렌드모드 존중)으로 union bbox 크롭 병합. 전부 빈 레이어면 `ValueError`.
  - `render_thumbnails(session, layer_ids, max_size, out_dir) -> {str(layerId): pngPath}` — 그룹 id는 해당 그룹 합성 썸네일.
  - `render_preview(session, visible_layer_ids, max_size, out_dir) -> pngPath` — 전체 캔버스 뷰포트, 지정 레이어만 합성 후 다운스케일.

- [ ] **Step 1: 실패하는 테스트 작성**

`engine/tests/test_render.py`:

```python
import numpy as np
from psd_tools import PSDImage

from psd_engine.render import extract_rgba, merge_rgba, render_preview, render_thumbnails
from psd_engine.tree import build_tree


def _session(path):
    psd = PSDImage.open(path)
    built = build_tree(psd)
    return {"psd": psd, "layers_by_id": built["layers_by_id"]}


def test_extract_rgba(fixture_psd):
    s = _session(fixture_psd)
    arr = extract_rgba(s["layers_by_id"][4])   # 'line' value=50, 32x24
    assert arr.shape == (24, 32, 4)
    assert (arr[..., :3] == 50).all() and (arr[..., 3] == 255).all()


def test_merge_rgba_overlap(fixture_psd):
    s = _session(fixture_psd)
    # 'fill'(128, 전체) 위에 'lines'(200, (10,10)-(30,20))
    arr, left, top = merge_rgba(s["psd"], [s["layers_by_id"][2], s["layers_by_id"][5]])
    assert (left, top) == (0, 0)
    assert arr.shape == (48, 64, 4)
    assert (arr[0, 0, :3] == 128).all()        # fill만 있는 곳
    assert (arr[15, 15, :3] == 200).all()      # lines가 위에 있는 곳
    assert (arr[..., 3] == 255)[0, 0]


def test_merge_rgba_respects_hidden_source(fixture_psd):
    # merge 대상으로 명시한 레이어는 원본 visible=False여도 포함되어야 한다
    s = _session(fixture_psd)
    arr, left, top = merge_rgba(s["psd"], [s["layers_by_id"][3]])
    assert (left, top) == (5, 5)
    assert (arr[..., :3] == 77).all()


def test_render_thumbnails_and_preview(fixture_psd, tmp_path):
    s = _session(fixture_psd)
    thumbs = render_thumbnails(s, [4, 5], max_size=16, out_dir=tmp_path)
    from PIL import Image
    im = Image.open(thumbs["4"])
    assert im.size[0] <= 16 and im.size[1] <= 16

    preview = render_preview(s, [2, 5], max_size=32, out_dir=tmp_path)
    im = Image.open(preview)
    assert max(im.size) <= 32
```

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/test_render.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: 구현**

`engine/psd_engine/render.py`:

```python
"""픽셀 추출/병합/썸네일/미리보기. 합성은 psd-tools(블렌드모드 존중)."""
import numpy as np
from PIL import Image


def extract_rgba(layer):
    if layer.mask is not None and not layer.mask.disabled:
        img = layer.composite(viewport=layer.bbox)
    else:
        img = layer.topil()
    return np.array(img.convert("RGBA"))


def _wanted_ids(psd, layers):
    wanted = set()
    for layer in layers:
        cur = layer
        while cur is not psd:
            wanted.add(id(cur))
            cur = cur.parent
    return wanted


def merge_rgba(psd, layers):
    boxes = [l.bbox for l in layers if l.bbox != (0, 0, 0, 0)]
    if not boxes:
        raise ValueError("merge: all source layers are empty")
    left = min(b[0] for b in boxes)
    top = min(b[1] for b in boxes)
    right = max(b[2] for b in boxes)
    bottom = max(b[3] for b in boxes)
    wanted = _wanted_ids(psd, layers)
    img = psd.composite(
        viewport=(left, top, right, bottom),
        force=True,
        color=1.0,
        alpha=0.0,
        layer_filter=lambda l: id(l) in wanted,
    )
    return np.array(img.convert("RGBA")), left, top


def _save_png(img, out_dir, stem):
    path = str(out_dir / f"{stem}.png") if hasattr(out_dir, "__truediv__") \
        else f"{out_dir}/{stem}.png"
    img.save(path)
    return path


def render_thumbnails(session, layer_ids, max_size, out_dir):
    result = {}
    for lid in layer_ids:
        layer = session["layers_by_id"][lid]
        img = layer.composite() if layer.is_group() else Image.fromarray(extract_rgba(layer))
        img = img.convert("RGBA")
        img.thumbnail((max_size, max_size))
        result[str(lid)] = _save_png(img, out_dir, f"thumb_{lid}")
    return result


def render_preview(session, visible_layer_ids, max_size, out_dir):
    psd = session["psd"]
    layers = [session["layers_by_id"][lid] for lid in visible_layer_ids]
    wanted = _wanted_ids(psd, layers)
    img = psd.composite(
        viewport=(0, 0, psd.width, psd.height),
        force=True,
        color=1.0,
        alpha=0.0,
        layer_filter=lambda l: id(l) in wanted,
    ).convert("RGBA")
    img.thumbnail((max_size, max_size))
    return _save_png(img, out_dir, "preview")
```

- [ ] **Step 4: 통과 확인**

Run: `uv run pytest tests/test_render.py -v`
Expected: PASS
(주의: psd-tools의 `layer_filter`가 그룹에도 적용되므로 `_wanted_ids`가 조상 그룹을 포함해야
자식이 렌더된다. `force=True`는 임베드 프리뷰 무시하고 레이어에서 재합성.)

- [ ] **Step 5: 커밋**

```bash
git add engine/psd_engine/render.py engine/tests/test_render.py
git commit -m "feat(engine): pixel extraction, blend-aware merge, thumbnails, preview"
```

---

### Task 8: 내보내기 + 검증 (export.py, verify.py)

**Files:**
- Create: `engine/psd_engine/export.py`
- Create: `engine/psd_engine/verify.py`
- Test: `engine/tests/test_export.py`

**Interfaces:**
- Consumes: session dict, export plan entries(`finalize_names` 완료 상태), `render.extract_rgba`/`merge_rgba`
- Produces:
  - `export_psd(session, entries, output_path, embed_preview=True, overwrite=False, progress=None) -> {"outputPath": str, "layerCount": int}` — 기존 파일 존재 + overwrite=False면 `FileExistsError`. `progress(stage: str, current: int, total: int)` 콜백 선택.
  - `verify_export(session, entries, output_path) -> {"ok": bool, "canvasOk": bool, "layers": [{"name","nameOk","pixelChecked","pixelOk"}]}` — 병합 entry는 구조만, 단일 소스 entry는 RGBA 완전 비교.

- [ ] **Step 1: 실패하는 테스트 작성**

`engine/tests/test_export.py`:

```python
import numpy as np
import pytest
from psd_tools import PSDImage

from psd_engine.export import export_psd
from psd_engine.ops import build_export_plan, finalize_names
from psd_engine.session import SessionStore
from psd_engine.verify import verify_export


@pytest.fixture
def session(fixture_psd):
    store = SessionStore()
    return store.get(store.open(fixture_psd))


def _plan(session, included, operations):
    entries = build_export_plan(included, operations)
    return finalize_names(entries, session["nodes_by_id"], "pathPrefix")


def test_export_copies_and_merge(session, tmp_path):
    # line(50, 0..32/24) 위에 lines(200, 10..30/10..20) — 병합 결과에 둘 다 보인다
    entries = _plan(session, [3, 4, 5], [{"op": "merge", "layerIds": [4, 5], "name": "M"}])
    out_path = tmp_path / "out.psd"
    stats = export_psd(session, entries, out_path)
    assert stats == {"outputPath": str(out_path), "layerCount": 2}

    out = PSDImage.open(out_path)
    layers = list(out)  # 아래→위
    assert [l.name for l in layers] == ["BG_hidden line", "M"]
    m = np.array(layers[1].topil().convert("RGBA"))
    assert layers[1].bbox == (0, 0, 32, 24)     # union bbox
    assert (m[0, 0, :3] == 50).all()            # line만 있는 곳
    assert (m[15, 15, :3] == 200).all()         # lines가 위를 덮은 곳
    # 복사 검증: hidden line 원본 위치 그대로
    assert layers[0].bbox == (5, 5, 9, 9)


def test_export_refuses_overwrite(session, tmp_path):
    entries = _plan(session, [4], [])
    out_path = tmp_path / "out.psd"
    export_psd(session, entries, out_path)
    with pytest.raises(FileExistsError):
        export_psd(session, entries, out_path)
    export_psd(session, entries, out_path, overwrite=True)  # OK


def test_verify_passes_for_copies(session, tmp_path):
    entries = _plan(session, [3, 4, 5], [])
    out_path = tmp_path / "out.psd"
    export_psd(session, entries, out_path)
    v = verify_export(session, entries, out_path)
    assert v["ok"] is True and v["canvasOk"] is True
    assert [c["pixelChecked"] for c in v["layers"]] == [True, True, True]
    assert all(c["pixelOk"] for c in v["layers"])


def test_verify_detects_corruption(session, tmp_path):
    entries = _plan(session, [4], [])
    out_path = tmp_path / "out.psd"
    export_psd(session, entries, out_path)
    # 다른 내용으로 바꿔치기 → 검증 실패해야 함
    entries2 = _plan(session, [5], [{"op": "rename", "layerId": 5, "name": "BG_line"}])
    export_psd(session, entries2, out_path, overwrite=True)
    v = verify_export(session, entries, out_path)
    assert v["ok"] is False
```

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/test_export.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: 구현**

`engine/psd_engine/export.py`:

```python
"""export plan → 새 PSD 파일 생성 (pytoshop). 원본은 절대 수정하지 않는다."""
import os

import numpy as np
from PIL import Image

from .patches import apply_pytoshop_patches
from .render import extract_rgba, merge_rgba


def _entry_pixels(session, entry):
    if len(entry["sourceIds"]) == 1:
        layer = session["layers_by_id"][entry["sourceIds"][0]]
        return extract_rgba(layer), layer.left, layer.top
    layers = [session["layers_by_id"][sid] for sid in entry["sourceIds"]]
    return merge_rgba(session["psd"], layers)


def export_psd(session, entries, output_path, embed_preview=True,
               overwrite=False, progress=None):
    apply_pytoshop_patches()
    from pytoshop import enums
    from pytoshop.image_data import ImageData
    from pytoshop.user import nested_layers

    output_path = str(output_path)
    if os.path.exists(output_path) and not overwrite:
        raise FileExistsError(f"output already exists: {output_path}")

    psd = session["psd"]
    W, H = psd.width, psd.height
    total = len(entries) + 2
    images_bottom_to_top = []
    canvas = Image.new("RGBA", (W, H), (255, 255, 255, 255)) if embed_preview else None

    for i, entry in enumerate(entries):
        rgba, left, top = _entry_pixels(session, entry)
        channels = {c: np.ascontiguousarray(rgba[..., c]) for c in range(3)}
        channels[-1] = np.ascontiguousarray(rgba[..., 3])
        images_bottom_to_top.append(nested_layers.Image(
            name=entry["finalName"], channels=channels, top=top, left=left,
            opacity=255, visible=True, blend_mode=enums.BlendMode.normal,
        ))
        if canvas is not None:
            canvas.alpha_composite(Image.fromarray(rgba), dest=(left, top))
        if progress:
            progress("compose", i + 1, total)

    out = nested_layers.nested_layers_to_psd(
        list(reversed(images_bottom_to_top)),   # index 0 = 최상단
        color_mode=enums.ColorMode.rgb,
        size=(W, H),
    )
    if canvas is not None:
        comp = np.array(canvas.convert("RGB"))
        out.image_data = ImageData(
            channels=np.ascontiguousarray(comp.transpose(2, 0, 1)),
            compression=enums.Compression.rle,
        )
    if progress:
        progress("write", total - 1, total)
    with open(output_path, "wb") as f:
        out.write(f)
    if progress:
        progress("done", total, total)
    return {"outputPath": output_path, "layerCount": len(entries)}
```

`engine/psd_engine/verify.py`:

```python
"""내보낸 PSD 검증: 구조 + (비병합 레이어) 픽셀 완전 일치."""
import numpy as np
from psd_tools import PSDImage

from .render import extract_rgba


def verify_export(session, entries, output_path):
    out = PSDImage.open(output_path)
    psd = session["psd"]
    canvas_ok = (out.width, out.height) == (psd.width, psd.height)
    out_layers = list(out)
    ok = canvas_ok and len(out_layers) == len(entries)

    layer_checks = []
    for entry, out_layer in zip(entries, out_layers):
        check = {
            "name": entry["finalName"],
            "nameOk": out_layer.name == entry["finalName"],
            "pixelChecked": False,
            "pixelOk": None,
        }
        if len(entry["sourceIds"]) == 1:
            src = session["layers_by_id"][entry["sourceIds"][0]]
            check["pixelChecked"] = True
            src_arr = extract_rgba(src)
            out_arr = np.array(out_layer.topil().convert("RGBA"))
            check["pixelOk"] = (
                out_layer.bbox == src.bbox
                and src_arr.shape == out_arr.shape
                and np.array_equal(src_arr, out_arr)
            )
        layer_checks.append(check)
        ok = ok and check["nameOk"] and check["pixelOk"] is not False

    return {"ok": bool(ok), "canvasOk": bool(canvas_ok), "layers": layer_checks}
```

- [ ] **Step 4: 통과 확인**

Run: `uv run pytest tests/test_export.py -v`
Expected: PASS

- [ ] **Step 5: 전체 테스트**

Run: `uv run pytest -v`
Expected: 전부 PASS

- [ ] **Step 6: 커밋**

```bash
git add engine/psd_engine/export.py engine/psd_engine/verify.py engine/tests/test_export.py
git commit -m "feat(engine): PSD export with embedded preview + post-export verification"
```

---

### Task 9: JSON-RPC 루프 (rpc.py, __main__.py)

**Files:**
- Create: `engine/psd_engine/rpc.py`
- Create: `engine/psd_engine/__main__.py`
- Test: `engine/tests/test_rpc.py`

**Interfaces:**
- Consumes: 지금까지의 전 모듈
- Produces: `python -m psd_engine` — stdin 한 줄 = 요청 1개, stdout 한 줄 = 응답/이벤트 1개.
  - `Engine` 클래스 메서드 = RPC method:
    - `open_psd(path) -> {"sessionId", "width", "height", "colorMode", "depth", "tree"}`
    - `close_session(sessionId) -> {}`
    - `render_thumbnails(sessionId, layerIds, maxSize) -> {"thumbs": {id: path}}`
    - `render_preview(sessionId, visibleLayerIds, maxSize) -> {"pngPath": path}`
    - `apply_preset(sessionId, preset) -> {"matchedLayerIds": [...], "operations": [...]}`
    - `export_psd(sessionId, includedIds, operations, naming, outputPath, embedPreview=True, overwrite=False, verify=True) -> {"outputPath", "layerCount", "verification"}`
  - 진행률: export 중 `{"event":"progress","stage":...,"current":...,"total":...}` 를 stdout으로 즉시 emit.
  - 존재하지 않는 method, params 오류, 내부 예외 → `{"id", "error": {"message", "traceback"}}`.
  - `includedIds`는 정렬해서 사용(리프 id 오름차순 = 아래→위). pixel이 아닌 id가 섞이면 `ValueError`.

- [ ] **Step 1: 실패하는 테스트 작성**

`engine/tests/test_rpc.py`:

```python
import json
import subprocess
import sys


class EngineProc:
    def __init__(self):
        self.p = subprocess.Popen(
            [sys.executable, "-m", "psd_engine"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
        )
        self._id = 0

    def call(self, method, **params):
        self._id += 1
        self.p.stdin.write(json.dumps(
            {"id": self._id, "method": method, "params": params}) + "\n")
        self.p.stdin.flush()
        while True:
            line = self.p.stdout.readline()
            msg = json.loads(line)
            if msg.get("event"):
                continue                      # progress 이벤트는 건너뜀
            assert msg["id"] == self._id
            return msg

    def close(self):
        self.p.stdin.close()
        self.p.wait(timeout=10)


def test_rpc_full_flow(fixture_psd, tmp_path):
    eng = EngineProc()
    try:
        r = eng.call("open_psd", path=str(fixture_psd))["result"]
        sid = r["sessionId"]
        assert r["width"] == 64 and r["depth"] == 8
        assert [t["name"] for t in r["tree"]] == ["*ART", "-REF"]

        r = eng.call("apply_preset", sessionId=sid, preset={
            "include": {"type": "contains", "value": "line", "caseSensitive": False},
            "excludeGroupPrefixes": ["-"], "matchGroups": True,
            "includeHidden": True, "merge": "all",
            "naming": "pathPrefix", "outputSuffix": "_LINE", "embedPreview": True,
        })["result"]
        assert r["matchedLayerIds"] == [3, 4, 5]
        assert r["operations"] == [{"op": "merge", "layerIds": [3, 4, 5], "name": "merged"}]

        out_path = str(tmp_path / "rpc_out.psd")
        r = eng.call("export_psd", sessionId=sid,
                     includedIds=[3, 4, 5], operations=[], naming="pathPrefix",
                     outputPath=out_path)["result"]
        assert r["layerCount"] == 3
        assert r["verification"]["ok"] is True

        r = eng.call("close_session", sessionId=sid)
        assert r["result"] == {}
    finally:
        eng.close()


def test_rpc_error_carries_traceback(fixture_psd):
    eng = EngineProc()
    try:
        r = eng.call("open_psd", path="/nonexistent/file.psd")
        assert "error" in r
        assert "Traceback" in r["error"]["traceback"]

        r = eng.call("no_such_method")
        assert "error" in r
    finally:
        eng.close()
```

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/test_rpc.py -v`
Expected: FAIL — `No module named psd_engine.__main__`

- [ ] **Step 3: 구현**

`engine/psd_engine/rpc.py`:

```python
"""줄 단위 JSON-RPC 루프. 모든 예외는 traceback과 함께 반환(흡수 금지)."""
import json
import sys
import tempfile
import traceback
from pathlib import Path

from .export import export_psd as _export
from .matching import match_preset, preset_operations
from .ops import build_export_plan, finalize_names
from .render import render_preview, render_thumbnails
from .session import SessionStore
from .verify import verify_export


def _emit(obj, out):
    out.write(json.dumps(obj) + "\n")
    out.flush()


class Engine:
    def __init__(self, out=None):
        self.store = SessionStore()
        self.out = out or sys.stdout
        self.tmp = Path(tempfile.mkdtemp(prefix="psd_engine_"))

    # ---- RPC methods ----
    def open_psd(self, path):
        sid = self.store.open(path)
        s = self.store.get(sid)
        psd = s["psd"]
        return {
            "sessionId": sid, "width": psd.width, "height": psd.height,
            "colorMode": psd.color_mode.name, "depth": psd.depth, "tree": s["tree"],
        }

    def close_session(self, sessionId):
        self.store.close(sessionId)
        return {}

    def render_thumbnails(self, sessionId, layerIds, maxSize=128):
        s = self.store.get(sessionId)
        return {"thumbs": render_thumbnails(s, layerIds, maxSize, self.tmp)}

    def render_preview(self, sessionId, visibleLayerIds, maxSize=1500):
        s = self.store.get(sessionId)
        return {"pngPath": render_preview(s, visibleLayerIds, maxSize, self.tmp)}

    def apply_preset(self, sessionId, preset):
        s = self.store.get(sessionId)
        matched = match_preset(s["tree"], preset)
        return {
            "matchedLayerIds": matched,
            "operations": preset_operations(s["tree"], matched, preset),
        }

    def export_psd(self, sessionId, includedIds, operations, naming, outputPath,
                   embedPreview=True, overwrite=False, verify=True):
        s = self.store.get(sessionId)
        included = sorted(includedIds)
        for lid in included:
            node = s["nodes_by_id"][lid]
            if node["kind"] != "pixel":
                raise ValueError(
                    f"includedIds contains non-pixel layer {node['name']!r} "
                    f"(kind={node['kind']})"
                )
        entries = finalize_names(
            build_export_plan(included, operations), s["nodes_by_id"], naming
        )

        def progress(stage, current, total):
            _emit({"event": "progress", "stage": stage,
                   "current": current, "total": total}, self.out)

        result = _export(s, entries, outputPath, embed_preview=embedPreview,
                         overwrite=overwrite, progress=progress)
        if verify:
            result["verification"] = verify_export(s, entries, outputPath)
        return result

    # ---- dispatch ----
    def handle(self, request):
        method_name = request.get("method", "")
        method = getattr(self, method_name, None)
        if method is None or method_name.startswith("_") or method_name in ("handle",):
            raise ValueError(f"unknown method: {method_name!r}")
        return method(**request.get("params", {}))


def main(stdin=None, stdout=None):
    from .patches import apply_pytoshop_patches
    apply_pytoshop_patches()
    stdin = stdin or sys.stdin
    stdout = stdout or sys.stdout
    engine = Engine(out=stdout)
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        request = json.loads(line)
        try:
            _emit({"id": request.get("id"), "result": engine.handle(request)}, stdout)
        except Exception as e:  # noqa: BLE001 — traceback 그대로 노출이 정책
            _emit({"id": request.get("id"),
                   "error": {"message": str(e),
                             "traceback": traceback.format_exc()}}, stdout)
```

`engine/psd_engine/__main__.py`:

```python
from .rpc import main

main()
```

- [ ] **Step 4: 통과 확인**

Run: `uv run pytest tests/test_rpc.py -v`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add engine/psd_engine/rpc.py engine/psd_engine/__main__.py engine/tests/test_rpc.py
git commit -m "feat(engine): line-delimited JSON-RPC loop with progress events"
```

---

### Task 10: 배치 실행 (batch.py) + 수동 스모크

**Files:**
- Create: `engine/psd_engine/batch.py`
- Modify: `engine/psd_engine/rpc.py` (batch_run 메서드 추가 — 아래 코드)
- Test: `engine/tests/test_batch.py`

**Interfaces:**
- Consumes: matching/ops/export/verify 모듈
- Produces:
  - `batch.run_batch(paths, preset, output_dir=None, overwrite=False, progress=None) -> {"results": [...]}`
    - result 항목(성공): `{"path", "ok": bool(=verification.ok), "outputPath", "layerCount", "verification"}`
    - result 항목(실패): `{"path", "ok": False, "error": {"message", "traceback"}}` — **한 파일 실패해도 다음 파일 계속.**
    - 출력 경로: `output_dir`가 None이면 원본 폴더, 아니면 그 폴더에 `<원본stem><outputSuffix>.psd`.
    - `progress(path, stage, current, total)` 콜백 선택.
  - RPC method `batch_run(paths, preset, outputDir=None, overwrite=False)` — Engine에 추가.

- [ ] **Step 1: 실패하는 테스트 작성**

`engine/tests/test_batch.py`:

```python
import shutil

from psd_engine.batch import run_batch

PRESET = {
    "include": {"type": "contains", "value": "line", "caseSensitive": False},
    "excludeGroupPrefixes": ["-"], "matchGroups": True,
    "includeHidden": True, "merge": "none",
    "naming": "pathPrefix", "outputSuffix": "_LINE", "embedPreview": True,
}


def test_batch_continues_after_failure(fixture_psd, tmp_path):
    good2 = tmp_path / "good2.psd"
    shutil.copy(fixture_psd, good2)
    corrupt = tmp_path / "corrupt.psd"
    corrupt.write_bytes(b"garbage")
    out_dir = tmp_path / "out"
    out_dir.mkdir()

    r = run_batch([str(fixture_psd), str(corrupt), str(good2)], PRESET,
                  output_dir=str(out_dir))
    results = r["results"]
    assert [x["ok"] for x in results] == [True, False, True]
    assert results[0]["outputPath"] == str(out_dir / "fixture_LINE.psd")
    assert results[0]["layerCount"] == 3
    assert "traceback" in results[1]["error"]
    assert (out_dir / "good2_LINE.psd").exists()


def test_batch_default_output_next_to_source(fixture_psd):
    r = run_batch([str(fixture_psd)], PRESET)
    out = r["results"][0]["outputPath"]
    assert out == str(fixture_psd.parent / "fixture_LINE.psd")


def test_batch_no_match_is_failure(fixture_psd, tmp_path):
    preset = dict(PRESET, include={"type": "contains", "value": "zzz",
                                   "caseSensitive": False})
    r = run_batch([str(fixture_psd)], preset, output_dir=str(tmp_path))
    assert r["results"][0]["ok"] is False
    assert "no layers matched" in r["results"][0]["error"]["message"]
```

- [ ] **Step 2: 실패 확인**

Run: `uv run pytest tests/test_batch.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: 구현**

`engine/psd_engine/batch.py`:

```python
"""여러 PSD에 프리셋 일괄 적용. 파일당 열고-처리-닫기, 실패해도 계속."""
import traceback
from pathlib import Path

from .export import export_psd
from .matching import match_preset, preset_operations
from .ops import build_export_plan, finalize_names
from .session import SessionStore
from .verify import verify_export


def _process_one(store, path, preset, output_dir, overwrite, progress):
    sid = store.open(path)
    try:
        s = store.get(sid)
        matched = match_preset(s["tree"], preset)
        if not matched:
            raise ValueError(f"no layers matched in {path}")
        operations = preset_operations(s["tree"], matched, preset)
        entries = finalize_names(
            build_export_plan(matched, operations),
            s["nodes_by_id"], preset["naming"],
        )
        src = Path(path)
        out_dir = Path(output_dir) if output_dir else src.parent
        out_path = out_dir / f"{src.stem}{preset['outputSuffix']}.psd"

        def cb(stage, current, total):
            if progress:
                progress(str(path), stage, current, total)

        result = export_psd(s, entries, out_path,
                            embed_preview=preset.get("embedPreview", True),
                            overwrite=overwrite, progress=cb)
        verification = verify_export(s, entries, out_path)
        return {
            "path": str(path), "ok": verification["ok"],
            "outputPath": result["outputPath"],
            "layerCount": result["layerCount"],
            "verification": verification,
        }
    finally:
        store.close(sid)


def run_batch(paths, preset, output_dir=None, overwrite=False, progress=None):
    store = SessionStore(max_sessions=1)
    results = []
    for path in paths:
        try:
            results.append(
                _process_one(store, path, preset, output_dir, overwrite, progress))
        except Exception as e:  # noqa: BLE001 — 항목별로 기록하고 계속(정책)
            results.append({
                "path": str(path), "ok": False,
                "error": {"message": str(e), "traceback": traceback.format_exc()},
            })
    return {"results": results}
```

`engine/psd_engine/rpc.py`의 `Engine` 클래스에 메서드 추가 (`apply_preset` 아래):

```python
    def batch_run(self, paths, preset, outputDir=None, overwrite=False):
        from .batch import run_batch

        def progress(path, stage, current, total):
            _emit({"event": "progress", "path": path, "stage": stage,
                   "current": current, "total": total}, self.out)

        return run_batch(paths, preset, output_dir=outputDir,
                         overwrite=overwrite, progress=progress)
```

- [ ] **Step 4: 통과 확인**

Run: `uv run pytest -v`
Expected: 전체 스위트 PASS

- [ ] **Step 5: 실파일 수동 스모크 (로컬 전용, 테스트 파일 아님)**

```bash
printf '%s\n' '{"id":1,"method":"batch_run","params":{"paths":["~/samples/bg_psd/sample_bg_wide_v01.psd"],"preset":{"include":{"type":"contains","value":"line","caseSensitive":false},"excludeGroupPrefixes":["-"],"matchGroups":false,"includeHidden":true,"merge":"none","naming":"pathPrefix","outputSuffix":"_LINE_ENGINE","embedPreview":true}}}' \
  | uv run python -m psd_engine | tail -1 | python3 -m json.tool | head -30
```

Expected: `"ok": true`, `"layerCount": 5`, 검증 통과. 생성된 `*_LINE_ENGINE.psd`는 확인 후 삭제.

- [ ] **Step 6: 커밋**

```bash
git add engine/psd_engine/batch.py engine/psd_engine/rpc.py engine/tests/test_batch.py
git commit -m "feat(engine): batch run with per-file isolation and failure reporting"
```

---

## Plan B 예고 (별도 계획)

엔진 완성 후 작성: Tauri v2 + React 스캐폴드, 사이드카 프로세스 연동(spawn + 줄 단위 JSON), 레이어 트리/미리보기/작업 히스토리 UI, 프리셋 편집, 배치 UI, 저장 다이얼로그, PyInstaller 패키징(macOS/Windows) 및 `externalBin` 등록.
