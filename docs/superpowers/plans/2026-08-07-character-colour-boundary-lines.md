# 캐릭터 색 경계선 생성 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 캐릭터 모델 PSD에서 색으로만 갈려 있고 선이 없는 경계를 찾아 획을 만들고, 그 뷰의 라인 레이어에 합쳐 내보낸다.

**Architecture:** 두 개의 새 엔진 모듈로 갇힌다. `edges.py`는 배열만 다루는 순수 계산(색 변화 → 기존 선 제외 → 조각 필터 → 획)이고, `character.py`는 PSD 트리에서 뷰(색 그룹 + 그 뷰의 라인)를 찾는다. 둘을 붙이는 곳은 `rpc.py`/`batch.py`가 엔트리를 만든 직후 한 지점뿐이고, 생성된 획은 엔트리에 `edgeOverlay`로 실려 `entry_pixels`가 합성한다 — 색 통일(`lineRgb`)이 이미 쓰는 것과 같은 방식이다.

**Tech Stack:** Python 3.12 / numpy / PIL(Pillow) / psd-tools / pytest — 엔진. TypeScript / React / vitest — 프런트.

## Global Constraints

- **scipy를 쓰지 않는다.** 엔진 venv에 없다. 모폴로지는 `PIL.ImageFilter.MaxFilter`/`MinFilter`, 연결 요소는 직접 구현한다.
- **BG 경로는 바뀌지 않는다.** `render.py` / `matching.py` / `raster.py`의 기존 로직에 손대지 않는다. `export.py`는 `entry_pixels` 한 곳만 확장한다.
- **기본값은 꺼짐.** `edgeLines.enabled` 기본 `false`. 이 값이 거짓이면 기존 산출물과 픽셀 단위로 동일해야 한다.
- **색 그룹 이름은 닫힌 집합에 전체 일치.** `colors` / `colours` / `color` / `colour` / `fills`. 부분 일치는 `colour palette`(46장)를 오인하므로 금지.
- **수동은 자동에 보탠다.** 합집합이며, 자동 결과를 지우지 않는다.
- 기본값: `threshold=24`, `gap=4`, `width=5`, `minLength=8`, `lineAlpha=64`.
- 테스트 명령: 엔진 `cd engine && ./.venv/bin/python -m pytest tests -q`, 프런트 `npm test -- --run` 및 `npx tsc --noEmit`.
- 커밋 메시지 끝에 `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

## 파일 구조

| 파일 | 책임 |
|---|---|
| `engine/psd_engine/edges.py` (신규) | 배열 계산 전부 + 뷰 하나에 대한 오버레이 생성 |
| `engine/psd_engine/character.py` (신규) | PSD 트리 → 뷰 목록(색 레이어 id, 라인 레이어 id) |
| `engine/tests/test_edges.py` (신규) | `edges.py` 단위 테스트 (합성 배열) |
| `engine/tests/test_character.py` (신규) | `character.py` 단위 테스트 (합성 PSD) |
| `engine/tests/conftest.py` | RGB 픽스처 헬퍼 추가 |
| `engine/psd_engine/export.py` | `entry_pixels`가 `edgeOverlay`를 합성 |
| `engine/psd_engine/rpc.py` | `export_psd`/`render_preview`에 진입점 |
| `engine/psd_engine/batch.py` | 배치에도 같은 진입점 |
| `engine/psd_engine/render.py` | `render_preview`가 오버레이를 받아 합성 |
| `src/lib/types.ts`, `src/lib/presets.ts` | 프리셋 스키마 + 검증 + 기본값 |
| `src/components/PresetDialog.tsx` | 설정 UI |
| `src/lib/engine.ts`, `src/App.tsx`, `src/components/PreviewCanvas.tsx`, `src/components/ExportDialog.tsx` | 설정 전달 |

---

### Task 1: `edges.py` — 색 변화 경계

**Files:**
- Create: `engine/psd_engine/edges.py`
- Test: `engine/tests/test_edges.py`

**Interfaces:**
- Consumes: 없음 (순수 배열 계산)
- Produces:
  - `EDGE_DEFAULTS: dict` — `{"threshold": 24, "gap": 4, "width": 5, "minLength": 8, "lineAlpha": 64}`
  - `colour_change(rgba: np.ndarray, threshold: int) -> tuple[np.ndarray, np.ndarray]` — `(HxW bool 경계, HxWx3 uint8 어두운 쪽 색)`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`engine/tests/test_edges.py`:

```python
import numpy as np

from psd_engine.edges import EDGE_DEFAULTS, colour_change


def _rgba(rows, alpha=255):
    """rows: HxWx3 리스트 → RGBA 배열."""
    arr = np.array(rows, np.uint8)
    a = np.full(arr.shape[:2] + (1,), alpha, np.uint8)
    return np.concatenate([arr, a], axis=2)


def test_colour_change_marks_the_seam_between_two_flat_regions():
    # 왼쪽 두 칸 빨강, 오른쪽 두 칸 검정. 경계는 x=1 (차이가 나는 쌍의 왼쪽 픽셀).
    red, black = [200, 20, 40], [10, 10, 10]
    rgba = _rgba([[red, red, black, black]] * 3)
    mask, _ = colour_change(rgba, EDGE_DEFAULTS["threshold"])
    assert mask[:, 1].all(), "색이 갈리는 자리가 경계로 잡히지 않았다"
    assert not mask[:, [0, 2, 3]].any(), "같은 색끼리 붙은 자리가 경계로 잡혔다"


def test_colour_change_ignores_a_difference_under_the_threshold():
    a, b = [100, 100, 100], [110, 110, 110]      # 차이 10 < 24
    rgba = _rgba([[a, a, b, b]] * 3)
    mask, _ = colour_change(rgba, EDGE_DEFAULTS["threshold"])
    assert not mask.any()


def test_colour_change_ignores_edges_against_transparency():
    # 실루엣(색 vs 투명)은 이미 라인이 그려주는 자리다. 여기서 잡으면 안 된다.
    red = [200, 20, 40]
    rgba = _rgba([[red, red, red, red]] * 3)
    rgba[:, 2:, 3] = 0
    mask, _ = colour_change(rgba, EDGE_DEFAULTS["threshold"])
    assert not mask.any()


def test_colour_change_reports_the_darker_side_colour():
    # 시안의 빨간 획이 전부 어두운 영역 가장자리에 놓여 있었다 — 어두운 쪽을 쓴다.
    light, dark = [200, 200, 200], [30, 20, 10]
    rgba = _rgba([[light, light, dark, dark]] * 3)
    mask, colour = colour_change(rgba, EDGE_DEFAULTS["threshold"])
    assert (colour[mask] == dark).all()
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd engine && ./.venv/bin/python -m pytest tests/test_edges.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'psd_engine.edges'`

- [ ] **Step 3: 최소 구현**

`engine/psd_engine/edges.py`:

```python
"""색으로만 갈린 경계에 획을 만든다 — 캐릭터 모델 전용.

**레이어별 알파 경계가 아니라 합성된 그림의 색 변화를 본다.** 레이어의 알파를 그대로
쓰면 다른 레이어에 가려져 실제로는 보이지 않는 경계까지 후보가 된다. 실측에서 그 방식은
셔츠 전체에 격자 모양 획을 만들었고, 합성 후에는 그것이 통째로 사라졌다.

scipy를 쓰지 않는다(엔진 venv에 없다). 모폴로지는 PIL, 연결 요소는 직접 구현한다.
"""
import numpy as np

#: 실측에 근거한 기본값. 설계 문서 7절 참고.
EDGE_DEFAULTS = {
    "threshold": 24,    # 이웃과의 RGB 최대 채널 차가 이보다 크면 색이 바뀐 것으로 본다
    "gap": 4,           # 기존 선을 이만큼 부풀려 뺀다
    "width": 5,         # 획 굵기. LINES 실측 중앙값 4px, 25~75% 4~5px
    "minLength": 8,     # 이보다 짧은 조각은 선이 아니라 점이다
    "lineAlpha": 64,    # 기존 라인으로 칠 알파 문턱. LINES가 79.7% 반투명이라 낮게 잡는다
}


def colour_change(rgba, threshold):
    """
    이웃과 색이 달라지는 자리와, 그 자리에 쓸 색(양쪽 중 어두운 쪽)을 돌려준다.

    양쪽이 모두 불투명한 쌍만 본다. 색 vs 투명(실루엣)은 이미 라인이 그리는 자리이고,
    그것까지 잡으면 캐릭터 윤곽을 통째로 다시 긋게 된다.

    차이가 나는 쌍에서 **왼쪽/위쪽 픽셀**을 경계로 삼는다. 어느 쪽을 골라도 획을
    굵히는 단계에서 같은 자리를 덮으므로, 한쪽으로 정해 두기만 하면 된다.
    """
    rgb = rgba[..., :3].astype(np.int16)
    solid = rgba[..., 3] > 127
    mask = np.zeros(solid.shape, bool)
    colour = np.zeros(rgba.shape[:2] + (3,), np.uint8)

    for axis in (0, 1):
        a = rgb[:-1, :] if axis == 0 else rgb[:, :-1]
        b = rgb[1:, :] if axis == 0 else rgb[:, 1:]
        sa = solid[:-1, :] if axis == 0 else solid[:, :-1]
        sb = solid[1:, :] if axis == 0 else solid[:, 1:]
        hit = (np.abs(a - b).max(axis=2) > threshold) & sa & sb
        # 어두운 쪽 = 채널 합이 작은 쪽.
        darker = np.where((a.sum(axis=2) <= b.sum(axis=2))[..., None], a, b).astype(np.uint8)
        if axis == 0:
            mask[:-1, :] |= hit
            np.copyto(colour[:-1, :], darker, where=hit[..., None])
        else:
            mask[:, :-1] |= hit
            np.copyto(colour[:, :-1], darker, where=hit[..., None])
    return mask, colour
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd engine && ./.venv/bin/python -m pytest tests/test_edges.py -q`
Expected: PASS (4 passed)

- [ ] **Step 5: 커밋**

```bash
git add engine/psd_engine/edges.py engine/tests/test_edges.py
git commit -m "feat: detect colour-change boundaries in a composited image

Compares each pixel with its right and lower neighbour and marks the pair
as a boundary when the largest channel difference clears the threshold and
both sides are opaque. Colour-against-transparency is deliberately not a
boundary: that is the silhouette, which the line art already draws, and
tracing it would redraw the whole character outline.

The colour reported for each boundary is the darker of the two sides. The
strokes in the reference the artist drew all sit on the edge of the darker
region, so a generated stroke reads as that region's outline.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `edges.py` — 기존 선 제외, 조각 필터, 획 만들기

**Files:**
- Modify: `engine/psd_engine/edges.py`
- Test: `engine/tests/test_edges.py`

**Interfaces:**
- Consumes: Task 1의 `colour_change`, `EDGE_DEFAULTS`
- Produces:
  - `subtract_lines(mask: np.ndarray, line_alpha: np.ndarray, gap: int, line_alpha_threshold: int) -> np.ndarray`
  - `label_components(mask: np.ndarray) -> tuple[np.ndarray, int]` — `(HxW int32 라벨(0=배경), 라벨 수)`
  - `drop_small(mask, labels, count, min_length) -> np.ndarray`
  - `stroke_rgba(mask, labels, colour, width) -> np.ndarray` — HxWx4 uint8
  - `build_overlay(colour_rgba: np.ndarray, line_alpha: np.ndarray, opts: dict) -> np.ndarray` — HxWx4 uint8

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`engine/tests/test_edges.py` 끝에 덧붙인다:

```python
from psd_engine.edges import (build_overlay, drop_small, label_components,
                              stroke_rgba, subtract_lines)


def test_subtract_lines_removes_the_boundary_that_already_has_a_line():
    mask = np.zeros((9, 9), bool)
    mask[4, :] = True                       # 가로 경계 한 줄
    line = np.zeros((9, 9), np.uint8)
    line[4, 0:3] = 255                      # 그중 왼쪽 세 칸에만 이미 선이 있다
    out = subtract_lines(mask, line, gap=1, line_alpha_threshold=64)
    assert not out[4, 0:3].any(), "이미 선이 있는 자리가 남았다"
    assert out[4, 6:].any(), "선이 없는 자리까지 지워졌다"


def test_subtract_lines_uses_the_alpha_threshold_not_mere_presence():
    # LINES는 불투명 픽셀의 79.7%가 반투명이다. 문턱을 넘지 못하는 흐린 자국은
    # 선으로 치지 않아야 그 아래 색 경계가 살아남는다.
    mask = np.zeros((5, 5), bool)
    mask[2, :] = True
    faint = np.full((5, 5), 10, np.uint8)
    out = subtract_lines(mask, faint, gap=0, line_alpha_threshold=64)
    assert out[2, :].all()


def test_label_components_separates_two_disconnected_runs():
    mask = np.zeros((5, 9), bool)
    mask[1, 0:3] = True
    mask[3, 5:9] = True
    labels, count = label_components(mask)
    assert count == 2
    assert labels[1, 0] != labels[3, 5]
    assert labels[0, 0] == 0, "배경이 라벨을 받았다"


def test_drop_small_removes_specks_and_keeps_real_strokes():
    mask = np.zeros((5, 20), bool)
    mask[1, 0:2] = True                     # 2px 점
    mask[3, 5:18] = True                    # 13px 획
    labels, count = label_components(mask)
    out = drop_small(mask, labels, count, min_length=8)
    assert not out[1, :].any()
    assert out[3, 5:18].all()


def test_stroke_rgba_thickens_the_line_and_carries_the_component_colour():
    mask = np.zeros((11, 11), bool)
    mask[5, 2:9] = True
    colour = np.zeros((11, 11, 3), np.uint8)
    colour[5, 2:9] = [30, 20, 10]
    labels, _ = label_components(mask)
    out = stroke_rgba(mask, labels, colour, width=5)
    assert out.shape == (11, 11, 4)
    assert out[3, 5, 3] > 0 and out[7, 5, 3] > 0, "굵어지지 않았다"
    assert out[0, 0, 3] == 0, "빈 곳까지 칠해졌다"
    assert tuple(out[5, 5, :3]) == (30, 20, 10)


def test_build_overlay_is_empty_when_every_boundary_already_has_a_line():
    red, black = [200, 20, 40], [10, 10, 10]
    rgba = _rgba([[red] * 6 + [black] * 6] * 12)
    line = np.zeros((12, 12), np.uint8)
    line[:, 3:9] = 255                       # 경계(x=5)를 넉넉히 덮는다
    out = build_overlay(rgba, line, EDGE_DEFAULTS)
    assert out[..., 3].max() == 0


def test_build_overlay_draws_where_no_line_covers_the_colour_change():
    red, black = [200, 20, 40], [10, 10, 10]
    rgba = _rgba([[red] * 6 + [black] * 6] * 20)
    line = np.zeros((20, 12), np.uint8)
    out = build_overlay(rgba, line, EDGE_DEFAULTS)
    assert out[..., 3].max() > 0
    assert out[10, 5, 3] > 0
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd engine && ./.venv/bin/python -m pytest tests/test_edges.py -q`
Expected: FAIL — `ImportError: cannot import name 'subtract_lines'`

- [ ] **Step 3: 구현**

`engine/psd_engine/edges.py`에 덧붙인다 (파일 맨 위 import에 `from PIL import Image, ImageFilter` 추가):

```python
def _morph(mask, size, grow):
    """PIL로 하는 팽창/침식. size는 홀수여야 한다."""
    if size <= 1:
        return mask
    size = size if size % 2 else size + 1
    f = ImageFilter.MaxFilter(size) if grow else ImageFilter.MinFilter(size)
    return np.array(Image.fromarray((mask * 255).astype(np.uint8)).filter(f)) > 127


def subtract_lines(mask, line_alpha, gap, line_alpha_threshold):
    """
    이미 선이 있는 자리를 뺀다.

    알파 문턱으로 먼저 거르는 것이 중요하다. LINES는 불투명 픽셀의 79.7%가
    반투명이라 "0이 아니면 선"으로 치면 흐린 자국까지 선이 되어, 그 아래 살아 있어야
    할 색 경계가 통째로 사라진다.

    gap은 반지름이다 — 선 굵기의 절반쯤을 잡아야 안티에일리어싱 자락까지 덮인다.
    """
    lines = line_alpha > line_alpha_threshold
    if gap > 0:
        lines = _morph(lines, gap * 2 + 1, grow=True)
    return mask & ~lines


def label_components(mask):
    """
    8-이웃 연결 요소. 배경은 0.

    scipy.ndimage.label을 못 쓰므로 직접 훑는다. 대상은 경계 픽셀뿐이라(실측 한 뷰에
    4천 개 수준) 파이썬 반복으로도 부담이 없다 — 캔버스 전체를 도는 것이 아니다.
    """
    labels = np.zeros(mask.shape, np.int32)
    h, w = mask.shape
    count = 0
    ys, xs = np.nonzero(mask)
    for sy, sx in zip(ys.tolist(), xs.tolist()):
        if labels[sy, sx]:
            continue
        count += 1
        stack = [(sy, sx)]
        labels[sy, sx] = count
        while stack:
            y, x = stack.pop()
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not labels[ny, nx]:
                        labels[ny, nx] = count
                        stack.append((ny, nx))
    return labels, count


def drop_small(mask, labels, count, min_length):
    """
    픽셀 수가 min_length 미만인 조각을 버린다.

    경계는 1px 폭이라 픽셀 수가 곧 길이에 가깝다. 길이를 따로 재지 않는 이유다.
    """
    if min_length <= 1 or count == 0:
        return mask
    sizes = np.bincount(labels.ravel(), minlength=count + 1)
    keep = np.zeros(count + 1, bool)
    keep[1:] = sizes[1:] >= min_length
    return keep[labels]


def stroke_rgba(mask, labels, colour, width):
    """
    경계를 width 굵기의 획으로 만든다. 색은 **조각마다 하나**로 정한다.

    조각별로 색을 고르는 것은 굵히면서 생기는 문제를 피하려는 것이다 — 1px 경계에만
    있던 색을 어떻게 바깥으로 퍼뜨릴지 정해야 하는데, 거리 변환은 scipy 없이 비싸다.
    한 조각은 같은 두 색이 만나는 자리이므로 대표색 하나로 충분하다.

    가장자리를 살짝 흐린다. LINES가 79.7% 반투명일 만큼 안티에일리어싱이 강해서,
    딱딱한 획을 나란히 놓으면 그것만 튄다.
    """
    thick = _morph(mask, width, grow=True)
    alpha = np.array(
        Image.fromarray((thick * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.8))
    )
    out = np.zeros(mask.shape + (4,), np.uint8)
    out[..., 3] = alpha
    if not thick.any():
        return out
    # 조각별 대표색을 굵어진 영역 전체에 칠한다. 굵힌 뒤의 라벨은 원본 라벨을 같은
    # 크기로 팽창시켜 얻는다 — MaxFilter가 라벨 번호에도 그대로 통한다.
    grown = np.array(
        Image.fromarray(labels.astype(np.int32), mode="I").filter(
            ImageFilter.MaxFilter(width if width % 2 else width + 1))
    )
    for lab in range(1, labels.max() + 1):
        src = labels == lab
        if not src.any():
            continue
        rep = np.median(colour[src], axis=0).astype(np.uint8)
        out[(grown == lab) & thick, :3] = rep
    return out


def build_overlay(colour_rgba, line_alpha, opts):
    """
    합성된 색 그림과 그 자리의 기존 라인 알파에서 획 오버레이를 만든다.

    돌려주는 것은 입력과 같은 크기의 RGBA다. 그릴 것이 없으면 알파가 전부 0이다.
    """
    o = {**EDGE_DEFAULTS, **(opts or {})}
    mask, colour = colour_change(colour_rgba, o["threshold"])
    mask = subtract_lines(mask, line_alpha, o["gap"], o["lineAlpha"])
    labels, count = label_components(mask)
    mask = drop_small(mask, labels, count, o["minLength"])
    labels, _ = label_components(mask)
    return stroke_rgba(mask, labels, colour, o["width"])
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd engine && ./.venv/bin/python -m pytest tests/test_edges.py -q`
Expected: PASS (11 passed)

- [ ] **Step 5: 커밋**

```bash
git add engine/psd_engine/edges.py engine/tests/test_edges.py
git commit -m "feat: turn colour boundaries into strokes, minus the ones already drawn

Subtracting the existing line art is the whole point of the feature: of
one layer's 4,599 boundary pixels, 82.2 percent already sit under a line,
and redrawing those would only thicken the silhouette. The subtraction
gates on an alpha threshold rather than mere presence, because the line
art is 79.7 percent semi-transparent and treating every faint pixel as a
line erases colour boundaries that should survive.

Connected components are labelled here rather than with scipy, which the
engine venv does not carry. The loop only walks boundary pixels — a few
thousand per view — not the canvas.

Each component gets one colour instead of propagating per-pixel colour
outward as the stroke thickens; a component is where the same two colours
meet, so one representative is enough and it avoids a distance transform.
Stroke edges are softened to sit beside line art that is itself heavily
anti-aliased.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `character.py` — 뷰 찾기

**Files:**
- Create: `engine/psd_engine/character.py`
- Create: `engine/tests/test_character.py`
- Modify: `engine/tests/conftest.py`

**Interfaces:**
- Consumes: 세션 dict(`session["psd"]`, `session["layers_by_id"]`)
- Produces:
  - `COLOUR_GROUP_NAMES: frozenset[str]`
  - `find_views(session) -> list[dict]` — 각 원소 `{"name": str, "colourIds": list[int], "lineIds": list[int]}`

- [ ] **Step 1: 픽스처 헬퍼와 실패하는 테스트를 쓴다**

`engine/tests/conftest.py`의 `make_image` 바로 아래에 덧붙인다:

```python
def make_rgb_image(name, rgb, x, y, w, h, alpha=255, visible=True):
    """채널마다 다른 값을 넣는 픽셀 레이어. 색 경계 테스트에 쓴다 —
    make_image는 세 채널이 같은 값이라 색이 갈리는 상황을 만들 수 없다."""
    ch = {i: np.full((h, w), rgb[i], np.uint8) for i in range(3)}
    ch[-1] = np.full((h, w), alpha, np.uint8)
    return nested_layers.Image(
        name=name, channels=ch, top=y, left=x, opacity=255, visible=visible,
        blend_mode=enums.BlendMode.normal,
    )
```

`engine/tests/test_character.py`:

```python
import pytest
from pytoshop import enums
from pytoshop.user import nested_layers

from psd_engine.character import COLOUR_GROUP_NAMES, find_views
from psd_engine.session import SessionStore

from conftest import make_rgb_image, write_psd


def _session(path):
    store = SessionStore()
    return store.get(store.open(str(path)))


def _view_psd(tmp_path, colour_group_name, line_as_group):
    """뷰 하나짜리 문서. 라인을 잎으로 둘지 그룹으로 둘지 고른다."""
    colours = nested_layers.Group(name=colour_group_name, layers=[
        make_rgb_image("hair", (40, 20, 20), 0, 0, 16, 16),
        make_rgb_image("base", (200, 30, 60), 0, 0, 32, 24),
    ])
    line = (nested_layers.Group(name="LINES", layers=[
        make_rgb_image("LINE", (0, 0, 0), 0, 0, 32, 24)])
        if line_as_group else make_rgb_image("LINES", (0, 0, 0), 0, 0, 32, 24))
    p = tmp_path / f"{colour_group_name}_{line_as_group}.psd"
    write_psd(p, [nested_layers.Group(name="FRONT 3/4", layers=[line, colours])])
    return p


@pytest.mark.parametrize("group_name", sorted(COLOUR_GROUP_NAMES))
def test_every_colour_group_name_in_the_closed_set_is_found(tmp_path, group_name):
    s = _session(_view_psd(tmp_path, group_name, line_as_group=False))
    views = find_views(s)
    assert len(views) == 1
    assert views[0]["name"] == "FRONT 3/4"
    assert len(views[0]["colourIds"]) == 2


def test_a_line_group_is_flattened_to_its_leaves(tmp_path):
    # 실파일에서 lines가 그룹 이름으로만 130회 나온다. 잎만 찾으면 100장 중 22장만 걸렸다.
    s = _session(_view_psd(tmp_path, "COLORS", line_as_group=True))
    views = find_views(s)
    assert len(views) == 1
    assert len(views[0]["lineIds"]) == 1


def test_a_palette_group_is_not_a_colour_group(tmp_path):
    # colour palette 는 46장, color palette 는 36장에 있다. 부분 일치면 전부 오인한다.
    colours = nested_layers.Group(name="COLOUR PALETTE", layers=[
        make_rgb_image("swatch", (200, 30, 60), 0, 0, 8, 8)])
    line = make_rgb_image("LINES", (0, 0, 0), 0, 0, 32, 24)
    p = tmp_path / "palette.psd"
    write_psd(p, [nested_layers.Group(name="TEMPLATE", layers=[line, colours])])
    assert find_views(_session(p)) == []


def test_a_document_with_no_colour_group_yields_no_views(tmp_path):
    # 군중·배치 시트가 이렇다(실폴더 100장 중 17장). 실패가 아니라 대상이 아니다.
    p = tmp_path / "crowd.psd"
    write_psd(p, [nested_layers.Group(name="CROWD", layers=[
        make_rgb_image("figure", (10, 10, 10), 0, 0, 16, 16)])])
    assert find_views(_session(p)) == []


def test_views_are_found_at_any_nesting_depth(tmp_path):
    # 실파일에 TURN/CHARACTER/PROFILE/FILLS 처럼 더 깊은 중첩이 있다.
    inner = nested_layers.Group(name="PROFILE", layers=[
        make_rgb_image("LINES", (0, 0, 0), 0, 0, 32, 24),
        nested_layers.Group(name="FILLS", layers=[
            make_rgb_image("fill", (200, 30, 60), 0, 0, 32, 24)]),
    ])
    p = tmp_path / "deep.psd"
    write_psd(p, [nested_layers.Group(name="TURN", layers=[
        nested_layers.Group(name="CHARACTER", layers=[inner])])])
    views = find_views(_session(p))
    assert [v["name"] for v in views] == ["PROFILE"]
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd engine && ./.venv/bin/python -m pytest tests/test_character.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'psd_engine.character'`

- [ ] **Step 3: 구현**

`engine/psd_engine/character.py`:

```python
"""캐릭터 모델 PSD의 구조 해석 — 색 그룹에서 뷰를 찾는다.

에피소드 하나의 캐릭터 폴더 100장을 전수 조사해 정한 규칙이다. 이 규칙으로 83장에서
뷰를 찾고, 찾은 뷰 355개 중 352개(99%)가 라인을 함께 찾는다. 나머지 17장은 군중·
스토리보드·배치 시트라 색 분리가 없다 — 실패가 아니라 대상이 아니다.
"""

#: 색 그룹으로 칠 이름. **전체 일치**여야 한다.
#:
#: 부분 일치는 쓰면 안 된다. 라인과 형제인 그룹 이름을 전수로 뽑으면 `colour palette`가
#: 46장, `color palette`가 36장에 있는데 그건 팔레트 견본이지 색 레이어가 아니다.
#: `colour`로 부분 일치하면 그것들을 색 그룹으로 오인한다.
#:
#: 이 집합은 관측이지 보장이 아니고 이미 두 번 늘어났다(넷 → `fills`를 더해 다섯).
#: 여섯 번째가 나오면 여기에 더하되, 그 전까지는 수동 지정이 메운다.
COLOUR_GROUP_NAMES = frozenset({"colors", "colours", "color", "colour", "fills"})


def _is_line_named(layer):
    return "line" in layer.name.lower()


def _pixel_leaves(layer):
    """그룹이면 그릴 수 있는 잎까지 펼치고, 잎이면 자기 자신."""
    if not layer.is_group():
        return [layer] if layer.width > 0 and layer.height > 0 else []
    out = []
    for child in layer:
        out += _pixel_leaves(child)
    return out


def find_views(session):
    """
    (뷰 이름, 색 레이어 id, 라인 레이어 id) 목록. 문서 순서대로.

    뷰는 색 그룹의 **부모**다. 라인은 그 부모 아래에서 이름에 line이 든 형제인데,
    **잎일 수도 그룹일 수도 있다** — 실폴더에서 `lines`가 그룹 이름으로만 130회
    나오고, 잎만 찾던 첫 규칙은 100장 중 22장밖에 걸리지 못했다.
    """
    psd = session["psd"]
    ids = {id(layer): lid for lid, layer in session["layers_by_id"].items()}
    views = []

    def walk(node, name):
        for child in node:
            if not child.is_group():
                continue
            if child.name.strip().lower() in COLOUR_GROUP_NAMES:
                colour_ids = [ids[id(l)] for l in _pixel_leaves(child) if id(l) in ids]
                line_ids = [
                    ids[id(l)]
                    for sib in node if sib is not child and _is_line_named(sib)
                    for l in _pixel_leaves(sib) if id(l) in ids
                ]
                if colour_ids:
                    views.append({"name": name, "colourIds": colour_ids,
                                  "lineIds": line_ids})
            walk(child, child.name)

    walk(psd, "(root)")
    return views
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd engine && ./.venv/bin/python -m pytest tests/test_character.py -q`
Expected: PASS (9 passed — 파라미터 5개 + 나머지 4개)

- [ ] **Step 5: 전체 엔진 테스트가 깨지지 않았는지 본다**

Run: `cd engine && ./.venv/bin/python -m pytest tests -q`
Expected: 기존 255 passed + 새 테스트, 실패 0

- [ ] **Step 6: 커밋**

```bash
git add engine/psd_engine/character.py engine/tests/test_character.py engine/tests/conftest.py
git commit -m "feat: locate character views by their colour group

A census of one episode's character folder fixed two guesses that looked
reasonable and were not. Searching for line leaves found 22 of 100 files;
59 of the misses had both a colour group and line art, with the lines
gathered into a group — 'lines' appears 130 times as a group name. And
the colour-group name set had four entries until a real model, 65 pixel
leaves, turned out to use FILLS.

Matching is whole-name against a closed set for a measured reason:
'colour palette' appears in 46 files and 'color palette' in 36, so a
substring rule would claim palette swatches as colour art.

Files with no colour group yield no views. In the folder that is 17 of
100 — crowd, storyboard and placement sheets with no colour separation to
trace — so silence is the right answer rather than an error.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: 뷰 하나에서 오버레이 만들기

**Files:**
- Modify: `engine/psd_engine/edges.py`
- Test: `engine/tests/test_edges.py`

**Interfaces:**
- Consumes: Task 2의 `build_overlay`, Task 3의 `find_views`
- Produces:
  - `overlay_for_view(session, colour_ids, line_ids, opts) -> tuple[np.ndarray, int, int] | None` — `(RGBA, left, top)`, 그릴 것이 없으면 `None`
  - `plan_overlays(session, views, opts) -> list[dict]` — `{"lineIds": [...], "rgba": ..., "left": int, "top": int}`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`engine/tests/test_edges.py` 끝에 덧붙인다:

```python
from psd_engine.character import find_views
from psd_engine.edges import overlay_for_view, plan_overlays
from psd_engine.session import SessionStore
from pytoshop.user import nested_layers

from conftest import make_rgb_image, write_psd


def _two_tone_session(tmp_path):
    """빨강 바탕 위에 어두운 조각이 얹힌 뷰 하나. 그 경계에는 선이 없다."""
    colours = nested_layers.Group(name="COLORS", layers=[
        make_rgb_image("dark", (40, 20, 20), 0, 0, 32, 12),
        make_rgb_image("base", (200, 30, 60), 0, 0, 32, 24),
    ])
    line = make_rgb_image("LINES", (0, 0, 0), 0, 0, 4, 24)
    p = tmp_path / "twotone.psd"
    write_psd(p, [nested_layers.Group(name="FRONT 3/4", layers=[line, colours])])
    store = SessionStore()
    return store.get(store.open(str(p)))


def test_overlay_for_view_draws_the_unlined_colour_seam(tmp_path):
    s = _two_tone_session(tmp_path)
    view = find_views(s)[0]
    rgba, left, top = overlay_for_view(s, view["colourIds"], view["lineIds"], EDGE_DEFAULTS)
    assert rgba[..., 3].max() > 0, "경계에 획이 생기지 않았다"
    assert rgba.shape[2] == 4


def test_overlay_for_view_is_none_when_there_is_no_unlined_boundary(tmp_path):
    # 색이 한 가지뿐이면 색 변화가 없다.
    colours = nested_layers.Group(name="COLORS", layers=[
        make_rgb_image("base", (200, 30, 60), 0, 0, 32, 24)])
    line = make_rgb_image("LINES", (0, 0, 0), 0, 0, 4, 24)
    p = tmp_path / "flat.psd"
    write_psd(p, [nested_layers.Group(name="FRONT 3/4", layers=[line, colours])])
    store = SessionStore()
    s = store.get(store.open(str(p)))
    view = find_views(s)[0]
    assert overlay_for_view(s, view["colourIds"], view["lineIds"], EDGE_DEFAULTS) is None


def test_plan_overlays_carries_the_line_ids_it_belongs_to(tmp_path):
    s = _two_tone_session(tmp_path)
    plans = plan_overlays(s, find_views(s), EDGE_DEFAULTS)
    assert len(plans) == 1
    assert plans[0]["lineIds"] == find_views(s)[0]["lineIds"]
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd engine && ./.venv/bin/python -m pytest tests/test_edges.py -q`
Expected: FAIL — `ImportError: cannot import name 'overlay_for_view'`

- [ ] **Step 3: 구현**

`engine/psd_engine/edges.py`에 덧붙인다:

```python
def _union_bbox(layers):
    boxes = [l.bbox for l in layers if l.bbox != (0, 0, 0, 0)]
    if not boxes:
        return None
    return (min(b[0] for b in boxes), min(b[1] for b in boxes),
            max(b[2] for b in boxes), max(b[3] for b in boxes))


def _paste_alpha(layers, box):
    """레이어들의 알파를 box 좌표계의 한 장으로 모은다(최댓값 합성)."""
    left, top, right, bottom = box
    out = np.zeros((bottom - top, right - left), np.uint8)
    for layer in layers:
        if layer.bbox == (0, 0, 0, 0):
            continue
        arr = np.array(layer.topil().convert("RGBA"))[..., 3]
        lx, ly = layer.bbox[0] - left, layer.bbox[1] - top
        y0, x0 = max(0, ly), max(0, lx)
        y1 = min(out.shape[0], ly + arr.shape[0])
        x1 = min(out.shape[1], lx + arr.shape[1])
        if y1 <= y0 or x1 <= x0:
            continue
        np.maximum(out[y0:y1, x0:x1], arr[y0 - ly:y1 - ly, x0 - lx:x1 - lx],
                   out=out[y0:y1, x0:x1])
    return out


def overlay_for_view(session, colour_ids, line_ids, opts):
    """
    뷰 하나의 획 오버레이. 그릴 것이 없으면 None.

    색 레이어를 **합성해서** 본다. 레이어별 알파 경계를 쓰면 다른 레이어에 가려져
    실제로는 보이지 않는 경계까지 후보가 되기 때문이다(모듈 docstring 참고).

    뷰포트는 색 레이어들의 합집합이다. 기존 라인은 그 좌표계로 옮겨 담는다 —
    라인이 색보다 넓어도 겹치는 부분만 있으면 된다.
    """
    layers_by_id = session["layers_by_id"]
    colour_layers = [layers_by_id[i] for i in colour_ids]
    box = _union_bbox(colour_layers)
    if box is None:
        return None

    wanted = {id(l) for l in colour_layers}
    img = session["psd"].composite(
        viewport=box, force=True, color=1.0, alpha=0.0,
        layer_filter=lambda l: id(l) in wanted or l.is_group(),
    )
    colour_rgba = np.array(img.convert("RGBA"))
    line_alpha = _paste_alpha([layers_by_id[i] for i in line_ids], box)

    out = build_overlay(colour_rgba, line_alpha, opts)
    if out[..., 3].max() == 0:
        return None
    return out, box[0], box[1]


def plan_overlays(session, views, opts):
    """뷰 목록 → 오버레이 목록. 그릴 것이 없는 뷰는 빠진다."""
    plans = []
    for view in views:
        made = overlay_for_view(session, view["colourIds"], view["lineIds"], opts)
        if made is None:
            continue
        rgba, left, top = made
        plans.append({"lineIds": view["lineIds"], "rgba": rgba,
                      "left": left, "top": top})
    return plans
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd engine && ./.venv/bin/python -m pytest tests/test_edges.py -q`
Expected: PASS (14 passed)

- [ ] **Step 5: 실물로 문턱값을 확인한다**

설계 9절이 남긴 미확인 두 가지(`threshold`가 캐릭터마다 흔들리는지, `minLength` 8px이 맞는지)를 여기서 잰다. 사용자가 준 캐릭터 PSD 경로로 아래를 돌리고, 결과 px 수를 기록한다.

```bash
cd /Users/usabatch/coding/psd_line_export && ./engine/.venv/bin/python - <<'PY'
import sys
sys.path.insert(0, "engine")
from psd_engine.character import find_views
from psd_engine.edges import EDGE_DEFAULTS, plan_overlays
from psd_engine.session import SessionStore

PATH = "<캐릭터 PSD 경로>"          # 사용자에게 받은 파일
s = SessionStore().open(PATH)
store = SessionStore(); s = store.get(store.open(PATH))
views = find_views(s)
print(f"뷰 {len(views)}개")
for ml in (1, 4, 8, 16):
    opts = {**EDGE_DEFAULTS, "minLength": ml}
    total = sum(int((p["rgba"][..., 3] > 0).sum()) for p in plan_overlays(s, views, opts))
    print(f"  minLength={ml:>2}  획 {total:,} px")
PY
```

`minLength`를 키울수록 획이 줄어드는 정도를 보고, 눈·이빨의 짧은 획이 사라지지 않는 최대값을 기본값으로 정한다(설계 2절이 그것들을 남기기로 했다). 기본값을 바꿨다면 `EDGE_DEFAULTS`와 설계 문서 7절을 함께 고친다.

- [ ] **Step 6: 커밋**

```bash
git add engine/psd_engine/edges.py engine/tests/test_edges.py
git commit -m "feat: build the stroke overlay for one view

Composites the view's colour layers and reads boundaries off that image
rather than off each layer's own alpha. Tracing layer alpha picks up edges
that sit underneath other layers and are never visible; measured on a real
model, that difference was a shirt covered in a grid of strokes versus
nothing at all.

The viewport is the union of the colour layers, and the existing line art
is pasted into that frame by taking the per-pixel maximum alpha, so line
art wider than the colour art contributes only where the two overlap.

A view with nothing to draw returns None rather than an empty image, so
callers do not have to test the alpha channel to find out.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: 내보내기에 붙이기

**Files:**
- Modify: `engine/psd_engine/export.py`
- Modify: `engine/psd_engine/rpc.py`
- Modify: `engine/psd_engine/batch.py`
- Test: `engine/tests/test_export.py`

**Interfaces:**
- Consumes: Task 4의 `plan_overlays`, Task 3의 `find_views`
- Produces:
  - `edges.attach_overlays(entries, plans) -> entries` — 엔트리에 `edgeOverlay` 를 단다
  - `entry_pixels`가 `entry.get("edgeOverlay")`를 합성

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`engine/tests/test_export.py` 끝에 덧붙인다:

```python
def test_edge_overlay_is_composited_into_the_line_entry(session, tmp_path):
    # 생성된 획은 그 뷰의 라인 엔트리에 합쳐 뷰당 한 장으로 나간다(설계 5절).
    import numpy as np
    from psd_engine.edges import attach_overlays

    entries = _plan(session, [4], [])
    overlay = np.zeros((6, 6, 4), np.uint8)
    overlay[..., :3] = [10, 20, 30]
    overlay[..., 3] = 255
    attach_overlays(entries, [{"lineIds": [4], "rgba": overlay, "left": 0, "top": 0}])
    assert entries[0]["edgeOverlay"] is not None

    out_path = tmp_path / "out.psd"
    export_psd(session, entries, out_path)
    arr = np.array(list(PSDImage.open(out_path))[0].topil().convert("RGBA"))
    assert (arr[0, 0, :3] == [10, 20, 30]).all(), "획이 합성되지 않았다"


def test_an_overlay_outside_the_layer_bbox_widens_the_entry(session, tmp_path):
    # 획은 라인 레이어 bbox 밖에도 생길 수 있다. 잘라내면 그만큼 사라진다.
    import numpy as np
    from psd_engine.edges import attach_overlays

    entries = _plan(session, [4], [])
    src = session["layers_by_id"][4]
    overlay = np.zeros((4, 4, 4), np.uint8)
    overlay[..., 3] = 255
    attach_overlays(entries, [{"lineIds": [4], "rgba": overlay,
                               "left": src.bbox[2] + 2, "top": src.bbox[1]}])
    out_path = tmp_path / "wide.psd"
    export_psd(session, entries, out_path)
    layer = list(PSDImage.open(out_path))[0]
    assert layer.bbox[2] >= src.bbox[2] + 6


def test_attach_overlays_skips_a_view_whose_lines_are_not_exported(session, tmp_path):
    # 라인을 체크하지 않았으면 합칠 엔트리가 없다. 조용히 건너뛴다.
    import numpy as np
    from psd_engine.edges import attach_overlays

    entries = _plan(session, [4], [])
    overlay = np.ones((4, 4, 4), np.uint8) * 255
    attach_overlays(entries, [{"lineIds": [999], "rgba": overlay, "left": 0, "top": 0}])
    assert entries[0].get("edgeOverlay") is None


def test_export_is_byte_identical_when_the_feature_is_off(session, tmp_path):
    # 기본값 꺼짐. 켜지 않으면 기존 산출물과 같아야 한다.
    a, b = tmp_path / "a.psd", tmp_path / "b.psd"
    export_psd(session, _plan(session, [3, 4, 5], []), a)
    entries = _plan(session, [3, 4, 5], [])
    from psd_engine.edges import attach_overlays
    attach_overlays(entries, [])
    export_psd(session, entries, b)
    assert a.read_bytes() == b.read_bytes()
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd engine && ./.venv/bin/python -m pytest tests/test_export.py -q -k edge`
Expected: FAIL — `ImportError: cannot import name 'attach_overlays'`

- [ ] **Step 3: `attach_overlays` 를 만든다**

`engine/psd_engine/edges.py`에 덧붙인다:

```python
def attach_overlays(entries, plans):
    """
    오버레이를 그 뷰의 라인 엔트리에 실어 둔다. 판단은 여기 한 번뿐이고
    entry_pixels는 읽기만 한다 — 색 통일(lineRgb)과 같은 방식이다.

    라인이 내보내기에 포함되지 않았으면 합칠 자리가 없으므로 그 뷰는 건너뛴다.
    아티스트가 라인을 체크하지 않았다는 뜻이고, 그때 획만 따로 내보내는 것은
    "최종 라인 레이어에 넣는다"는 이 기능의 목적과 어긋난다.
    """
    for entry in entries:
        entry.setdefault("edgeOverlay", None)
    for plan in plans:
        wanted = set(plan["lineIds"])
        target = next((e for e in entries if wanted & set(e["sourceIds"])), None)
        if target is None:
            continue
        target["edgeOverlay"] = (plan["rgba"], plan["left"], plan["top"])
    return entries
```

- [ ] **Step 4: `entry_pixels` 가 합성하게 한다**

`engine/psd_engine/export.py`의 `entry_pixels`를 바꾼다:

```python
def entry_pixels(session, entry):
    """
    엔트리의 픽셀. 덮을 색은 `entry["lineRgb"]`에서 읽는다 — assign_line_color가
    미리 정해 둔 값이고, 없으면 KeyError로 드러난다(조용히 색 통일을 빠뜨리느니
    호출자가 assign_line_color를 잊었다는 사실이 터져 나오는 편이 낫다).

    생성된 색 경계 획(`edgeOverlay`)이 있으면 **색 통일보다 먼저** 합성한다. 그것도
    라인이므로 색 통일 대상이고, 나중에 얹으면 혼자만 원본 색으로 남는다.
    """
    if len(entry["sourceIds"]) == 1:
        layer = session["layers_by_id"][entry["sourceIds"][0]]
        rgba, left, top = extract_rgba(layer), layer.left, layer.top
    else:
        layers = [session["layers_by_id"][sid] for sid in entry["sourceIds"]]
        rgba, left, top = merge_rgba(session["psd"], layers)
    overlay = entry.get("edgeOverlay")
    if overlay is not None:
        rgba, left, top = _composite_overlay(rgba, left, top, *overlay)
    # 병합 뒤에 덮는다. 소스가 서로 다른 색이어도 결과 알파는 같으므로 레이어마다
    # 먼저 덮고 병합한 것과 같은 그림이 되고, 병합 경로가 한 갈래로 유지된다.
    # 이 등식이 성립하려면 소스가 **전부** 대상이어야 한다 — assign_line_color가
    # 섞인 엔트리를 아예 대상에서 빼는 이유가 그것이다.
    return apply_line_color(rgba, entry["lineRgb"]), left, top


def _composite_overlay(rgba, left, top, overlay, ox, oy):
    """
    획을 엔트리 픽셀 위에 알파 합성한다. 필요하면 캔버스를 넓힌다.

    넓히는 것이 요점이다. 획은 라인 레이어 bbox 밖에 생길 수 있고(색 영역이 라인보다
    넓은 자리), 잘라내면 그만큼 결과에서 사라진다.
    """
    from PIL import Image

    h, w = rgba.shape[:2]
    oh, ow = overlay.shape[:2]
    nl, nt = min(left, ox), min(top, oy)
    nr, nb = max(left + w, ox + ow), max(top + h, oy + oh)
    canvas = Image.new("RGBA", (nr - nl, nb - nt), (0, 0, 0, 0))
    canvas.alpha_composite(Image.fromarray(rgba, "RGBA"), dest=(left - nl, top - nt))
    canvas.alpha_composite(Image.fromarray(overlay, "RGBA"), dest=(ox - nl, oy - nt))
    return np.array(canvas), nl, nt
```

- [ ] **Step 5: 통과를 확인한다**

Run: `cd engine && ./.venv/bin/python -m pytest tests/test_export.py -q`
Expected: PASS (기존 + 새 4개)

- [ ] **Step 6: rpc와 batch에 진입점을 단다**

`engine/psd_engine/rpc.py` — import에 추가:

```python
from .character import find_views
from .edges import EDGE_DEFAULTS, attach_overlays, plan_overlays
```

`export_psd` 시그니처에 `edgeLines=None`을 더하고, `assign_line_color` 호출 바로 뒤에:

```python
        # 색 경계선. 켜져 있을 때만 돈다 — 꺼져 있으면 엔트리가 그대로이므로
        # 산출물이 이 기능 이전과 바이트 단위로 같다.
        if edgeLines and edgeLines.get("enabled"):
            opts = {**EDGE_DEFAULTS, **edgeLines}
            attach_overlays(entries, plan_overlays(s, find_views(s), opts))
        else:
            attach_overlays(entries, [])
```

`engine/psd_engine/batch.py` — import에 같은 두 줄을 더하고, `assign_line_color(...)` 뒤에:

```python
        edge = preset.get("edgeLines") or {}
        if edge.get("enabled"):
            attach_overlays(entries, plan_overlays(s, find_views(s),
                                                   {**EDGE_DEFAULTS, **edge}))
        else:
            attach_overlays(entries, [])
```

- [ ] **Step 7: 전체 엔진 테스트**

Run: `cd engine && ./.venv/bin/python -m pytest tests -q`
Expected: 실패 0

- [ ] **Step 8: 커밋**

```bash
git add engine/psd_engine/edges.py engine/psd_engine/export.py engine/psd_engine/rpc.py engine/psd_engine/batch.py engine/tests/test_export.py
git commit -m "feat: composite generated strokes into the view's line entry

The stroke rides on the entry as edgeOverlay and entry_pixels reads it,
the same shape the line-colour decision already uses. Deciding once and
reading everywhere is what keeps export and verification from diverging.

Compositing happens before colour unification, not after. A generated
stroke is line art, so it belongs under the same colour rule; laying it
on afterwards would leave it the only thing in the file still wearing its
source colour.

The entry widens to fit. Strokes can land outside the line layer's bbox
wherever the colour art reaches further than the line art, and cropping
to the original box would silently drop exactly those.

A view whose line art is not in the export has nowhere to merge into and
is skipped rather than exported on its own, which would contradict the
one thing this feature is for.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: 미리보기에 보이게 하기

**Files:**
- Modify: `engine/psd_engine/render.py`
- Modify: `engine/psd_engine/rpc.py`
- Test: `engine/tests/test_render.py`

**Interfaces:**
- Consumes: Task 4의 `plan_overlays`
- Produces: `render_preview(session, visible_layer_ids, max_size, out_dir, line_color=None, line_color_ids=None, edge_overlays=None)`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`engine/tests/test_render.py` 끝에 덧붙인다:

```python
def test_render_preview_draws_the_edge_overlays_it_is_given(fixture_psd, tmp_path):
    # 화면에서 확인할 수 없으면 내보내기 전에 알 방법이 없다.
    from PIL import Image
    s = _session(fixture_psd)
    overlay = np.zeros((8, 8, 4), np.uint8)
    overlay[..., :3] = [255, 0, 0]
    overlay[..., 3] = 255
    png = render_preview(s, [4], max_size=256, out_dir=tmp_path,
                         edge_overlays=[{"rgba": overlay, "left": 0, "top": 0,
                                         "lineIds": [4]}])
    arr = np.array(Image.open(png).convert("RGBA"))
    assert tuple(arr[2, 2][:3]) == (255, 0, 0)


def test_render_preview_without_overlays_is_unchanged(fixture_psd, tmp_path):
    from PIL import Image
    s = _session(fixture_psd)
    a = np.array(Image.open(render_preview(s, [2, 5], 256, tmp_path)).convert("RGBA"))
    b = np.array(Image.open(
        render_preview(s, [2, 5], 256, tmp_path, edge_overlays=[])).convert("RGBA"))
    assert np.array_equal(a, b)
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd engine && ./.venv/bin/python -m pytest tests/test_render.py -q -k edge_overlay`
Expected: FAIL — `TypeError: render_preview() got an unexpected keyword argument 'edge_overlays'`

- [ ] **Step 3: 구현**

`engine/psd_engine/render.py`의 `render_preview` 시그니처에 `edge_overlays=None`을 더하고, `canvas.alpha_composite` 루프가 끝난 **뒤**(`return _save_png` 앞)에 넣는다:

```python
    # 생성된 색 경계 획. 내보내기에서는 라인 엔트리에 합쳐지므로 여기서도 라인과
    # 같은 자리에 놓이면 되는데, 라인이 스택 맨 위인 경우가 대부분이라 마지막에
    # 얹는다. 미리보기 배율로 줄여서 얹는다.
    for overlay in edge_overlays or []:
        arr = overlay["rgba"]
        if rgb is not None:
            arr = apply_line_color(arr, rgb)
        h, w = arr.shape[:2]
        x0, y0 = round(overlay["left"] * scale), round(overlay["top"] * scale)
        tw = max(1, round((overlay["left"] + w) * scale) - x0)
        th = max(1, round((overlay["top"] + h) * scale) - y0)
        img = Image.fromarray(arr, "RGBA")
        if (tw, th) != img.size:
            img = img.resize((tw, th), Image.LANCZOS)
        sx0, sy0 = max(0, -x0), max(0, -y0)
        sx1 = img.width - max(0, x0 + img.width - pw)
        sy1 = img.height - max(0, y0 + img.height - ph)
        if sx1 <= sx0 or sy1 <= sy0:
            continue
        if (sx0, sy0, sx1, sy1) != (0, 0, img.width, img.height):
            img = img.crop((sx0, sy0, sx1, sy1))
        canvas.alpha_composite(img, dest=(x0 + sx0, y0 + sy0))
```

`engine/psd_engine/rpc.py`의 `render_preview`에 `edgeLines=None`을 더하고:

```python
    def render_preview(self, sessionId, visibleLayerIds, maxSize=1500, lineColor=None,
                       lineColorIds=None, edgeLines=None):
        s = self.store.get(sessionId)
        out_dir = self._fresh_render_dir("preview")
        overlays = None
        if edgeLines and edgeLines.get("enabled"):
            overlays = plan_overlays(s, find_views(s), {**EDGE_DEFAULTS, **edgeLines})
        return {"pngPath": render_preview(s, visibleLayerIds, maxSize, out_dir,
                                          line_color=lineColor,
                                          line_color_ids=lineColorIds,
                                          edge_overlays=overlays)}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd engine && ./.venv/bin/python -m pytest tests -q`
Expected: 실패 0

- [ ] **Step 5: 커밋**

```bash
git add engine/psd_engine/render.py engine/psd_engine/rpc.py engine/tests/test_render.py
git commit -m "feat: show generated boundary strokes in the preview

Without this the artist cannot tell what the feature did until the file
is written, and the preview would be claiming to show the export while
omitting part of it.

The strokes go on last. Export merges them into the line entry, and line
art sits at the top of the stack in these files, so compositing them over
everything lands them where they belong. Colour unification is applied to
them here too, matching what export does.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: 프리셋 스키마와 UI

**Files:**
- Modify: `src/lib/types.ts`, `src/lib/presets.ts`, `src/lib/presets.test.ts`
- Modify: `src/components/PresetDialog.tsx`
- Modify: `src/lib/engine.ts`, `src/App.tsx`, `src/components/PreviewCanvas.tsx`, `src/components/ExportDialog.tsx`

**Interfaces:**
- Consumes: 엔진의 `edgeLines` 인자 (Task 5, 6)
- Produces: `Preset["edgeLines"]: EdgeLines`, `EdgeLines = { enabled: boolean; threshold: number; gap: number; width: number; minLength: number; lineAlpha: number }`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/lib/presets.test.ts` 끝에 덧붙인다:

```ts
test("a preset saved before this feature reads as edge lines off", () => {
  // lineColor·outputFormat 때와 같은 규칙 — 구버전 파일은 잘못된 것이 아니다.
  const { edgeLines, ...withoutEdges } = DEFAULT_PRESET;
  const parsed = parsePresets(JSON.stringify([withoutEdges]));
  expect(parsed[0].edgeLines.enabled).toBe(false);
  expect(parsed[0].edgeLines.threshold).toBe(24);
});

test("edge line settings round-trip", () => {
  const preset = { ...DEFAULT_PRESET, edgeLines: { ...DEFAULT_PRESET.edgeLines, enabled: true, width: 7 } };
  const parsed = parsePresets(JSON.stringify([preset]));
  expect(parsed[0].edgeLines.enabled).toBe(true);
  expect(parsed[0].edgeLines.width).toBe(7);
});

test("a non-numeric edge line setting is rejected rather than coerced", () => {
  const bad = { ...DEFAULT_PRESET, edgeLines: { ...DEFAULT_PRESET.edgeLines, width: "굵게" } };
  expect(() => parsePresets(JSON.stringify([bad]))).toThrow(/edgeLines\.width/);
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/lib/presets.test.ts`
Expected: FAIL — `edgeLines` 가 없다

- [ ] **Step 3: 타입과 기본값**

`src/lib/types.ts`의 `Preset` 안에 더한다:

```ts
  /**
   * 캐릭터 모델 전용 색 경계선 생성. 색으로만 갈려 있고 선이 없는 경계에 획을
   * 만들어 그 뷰의 라인 레이어에 합친다. 기본은 꺼짐이라 BG 프리셋은 영향받지 않는다.
   * 기본값의 근거는 docs/superpowers/specs/2026-08-07-character-colour-boundary-lines-design.md 7절.
   */
  edgeLines: EdgeLines;
```

같은 파일에 더한다:

```ts
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
}
```

`src/lib/presets.ts`:

```ts
export const DEFAULT_EDGE_LINES: EdgeLines = {
  enabled: false, threshold: 24, gap: 4, width: 5, minLength: 8, lineAlpha: 64,
};
```

`DEFAULT_PRESET`에 `edgeLines: { ...DEFAULT_EDGE_LINES },` 를 더하고, 검증부에 더한다:

```ts
  // edgeLines도 나중에 추가된 항목이라 그 이전 presets.json에는 없다. 없는 것은
  // 꺼짐으로 읽는다 — 구버전 파일은 잘못된 것이 아니다. 반대로 들어있는데 형식이
  // 어긋나면 통과시키지 않는다.
  const edge = { ...DEFAULT_EDGE_LINES, ...((v.edgeLines as object | undefined) ?? {}) };
  if (typeof edge.enabled !== "boolean") {
    throw new Error(`${prefix}.edgeLines.enabled: boolean이 아닙니다.`);
  }
  for (const key of ["threshold", "gap", "width", "minLength", "lineAlpha"] as const) {
    if (typeof edge[key] !== "number" || !Number.isFinite(edge[key]) || edge[key] < 0) {
      throw new Error(`${prefix}.edgeLines.${key}: 0 이상의 숫자가 아닙니다.`);
    }
  }
```

그리고 반환 객체에 `edgeLines: edge,` 를 더한다.

- [ ] **Step 4: 통과를 확인한다**

Run: `npx vitest run src/lib/presets.test.ts && npx tsc --noEmit`
Expected: PASS, 타입 오류 0 (다른 파일의 `Preset` 리터럴에서 오류가 나면 `edgeLines`를 채운다)

- [ ] **Step 5: UI를 단다**

`src/components/PresetDialog.tsx` — "라인 색 통일" 블록 아래에 더한다:

```tsx
        <label className="preset-checkbox">
          <input
            type="checkbox"
            checked={edgeEnabled}
            onChange={(e) => setEdgeEnabled(e.currentTarget.checked)}
          />
          <span>색 경계선 생성 (캐릭터 모델)</span>
        </label>
        <p className="preset-hint">
          색으로만 갈려 있고 선이 없는 경계에 획을 만들어 그 뷰의 라인 레이어에 합칩니다.
          이미 선이 있는 자리에는 긋지 않습니다. 배경(BG) 파일에는 쓰지 마세요 — 뷰·색 그룹
          구조가 있는 캐릭터 모델 전용입니다.
        </p>
```

`useState(preset.edgeLines.enabled)`로 상태를 만들고, 저장 시 `edgeLines: { ...preset.edgeLines, enabled: edgeEnabled }`로 합친다. 나머지 수치는 이번 UI에 노출하지 않는다 — 기본값이 실측에서 나왔고, 노출하면 조정 손잡이가 여섯 개로 늘어난다.

- [ ] **Step 6: 엔진까지 값을 전달한다**

`src/lib/engine.ts`의 `renderPreview`와 `exportPsd`에 각각 `edgeLines: EdgeLines | null = null` 인자를 마지막에 더하고 payload에 넣는다. `PreviewCanvas`는 `lineColor`와 같은 방식으로 prop을 받아 `RenderSpec`에 싣고 캐시 키에도 넣는다(설정이 바뀌면 그림이 달라진다). `App.tsx`는 `selectedPreset?.edgeLines ?? null`을, `ExportDialog`는 `preset?.edgeLines ?? null`을 넘긴다.

- [ ] **Step 7: 전체 테스트**

Run: `npx tsc --noEmit && npm test -- --run`
Expected: 타입 오류 0. `src/App.test.tsx > resume picks the remaining files back up`는 이 변경과 무관하게 3회 중 1회 실패하는 기존 flake다 — 그것만 실패하면 통과로 본다.

- [ ] **Step 8: 커밋**

```bash
git add src/
git commit -m "feat: preset switch for character colour-boundary lines

Off by default, so BG presets and everything already saved behave exactly
as before. A preset written before this feature has no edgeLines key and
reads as off rather than as malformed, matching how lineColor and
outputFormat were introduced.

Only the on/off switch reaches the dialog. The five numeric settings came
out of measurements against real files, and exposing them would put six
knobs in front of an artist for a feature whose defaults are already the
answer; they stay in the preset file for the case where a show needs them.

The cache key includes the settings, because changing them changes the
picture and a stale preview would be worse than a slow one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## 자체 검토

**스펙 커버리지**

| 스펙 절 | 구현 태스크 |
|---|---|
| 2. 계산 규칙(색 변화 → 선 제외 → 조각 → 획) | Task 1, 2 |
| 2. 어두운 쪽 색 | Task 1 (`colour_change`), Task 2 (`stroke_rgba` 조각별 대표색) |
| 2. 색 통일과의 순서 | Task 5 (`entry_pixels`가 오버레이 → `apply_line_color`) |
| 3. 구조 탐지(닫힌 집합, 라인 잎/그룹) | Task 3 |
| 3.1 수동 지정 | **Task 3의 `find_views`가 id를 돌려주고 Task 4의 `overlay_for_view`가 id를 받는다** — 수동은 같은 함수에 아티스트가 고른 id를 넘기는 것이다. UI 노출은 이 계획의 범위 밖이며, 아래 "다음 계획"에 남긴다 |
| 5. 뷰의 라인 엔트리에 합침 | Task 5 (`attach_overlays`) |
| 6. 코드 배치 | Task 1~4가 새 모듈, Task 5~7이 최소 접점 |
| 7. 설정값 | Task 7 (스키마), Task 2 (`EDGE_DEFAULTS`) |
| 9. 문턱값·minLength 실측 | Task 4 Step 5 |

**남은 것 — 다음 계획으로 뺀다**

3.1의 수동 지정은 **UI 작업**이 본체다(레이어 트리에서 색·라인을 짚는 조작, 그 선택을 세션에 들고 다니기, 자동 결과와 합치기). 엔진 쪽은 이 계획으로 이미 준비된다 — `overlay_for_view(session, colour_ids, line_ids, opts)`가 id 목록만 받으므로, 누가 골랐는지는 묻지 않는다. 자동만으로 83/100장이 덮이므로 그것을 먼저 실물로 확인한 뒤 수동 UI를 설계하는 편이 낫다.

**구현 중 지켜볼 비용**

`stroke_rgba`의 조각 루프는 조각마다 `(grown == lab) & thick`으로 배열 전체를 훑는다.
배열이 캔버스가 아니라 뷰 상자라(실측 523×2379 ≈ 1.2Mpx) 조각이 수백 개여도 몇 초
수준이지만, 조각 수는 파일에 달렸고 미리 알 수 없다. Task 4 Step 5에서 실물을 돌릴 때
시간을 함께 재고, 눈에 띄게 느리면 전체 배열 비교 대신 조각의 바운딩 박스 안에서만
돌도록 좁힌다. `PIL.ImageFilter.MaxFilter`가 int32(`mode="I"`) 라벨 배열에 동작하는 것은
확인했다.

**타입 일관성**

- `find_views` → `{"name", "colourIds", "lineIds"}` (Task 3) → `plan_overlays`가 그대로 소비 (Task 4) → `plan` dict `{"lineIds", "rgba", "left", "top"}` → `attach_overlays` (Task 5), `render_preview`의 `edge_overlays` (Task 6) — 같은 키를 쓴다.
- `EDGE_DEFAULTS`(Python)와 `DEFAULT_EDGE_LINES`(TS)의 키가 같다: `threshold`, `gap`, `width`, `minLength`, `lineAlpha`. TS 쪽에만 `enabled`가 더 있고, 엔진은 `edgeLines.get("enabled")`로 읽는다.
- `entry["edgeOverlay"]`는 `(rgba, left, top)` 튜플 또는 `None`. `attach_overlays`가 항상 채우므로 `entry_pixels`는 `.get`으로 읽어도 안전하다.
