# 색 영역 분할로 경계 찾기 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 캐릭터 색 경계선의 검출을 중앙차분+비최대억제에서 **색 영역 분할+라벨 경계**로 바꿔 획의 지글거림을 없애고, 기존 검출은 판정용 옵션으로 남긴다.

**Architecture:** 검출 단계만 교체한다. 합성된 색 그림을 평평한 색 영역으로 나눠(`segment_colours`) 라벨이 바뀌는 1px 자리를 경계로 잡고(`region_boundary`), 두 영역의 대표색 차가 `threshold`를 넘을 때만 남긴다. 하류(`subtract_lines` → `drop_small` → `reconnect_to_lines` → `stroke_rgba`)와 자동 굵기는 그대로다. 덤으로 `stroke_rgba`가 자락을 안 칠해 생기던 검은 후광을 고친다.

**Tech Stack:** Python 3.12 + numpy + PIL (엔진), TypeScript + React + Vitest (프런트). **scipy·sklearn·cv2·skimage는 엔진 venv에 없다 — 쓰지 말 것.**

## Global Constraints

- 스펙: `docs/superpowers/specs/2026-08-08-colour-region-stroke-design.md`
- 엔진 테스트: `cd /Users/usabatch/coding/psd_line_export/engine && .venv/bin/python -m pytest tests/ -q`
- 프런트 테스트: `cd /Users/usabatch/coding/psd_line_export && npm test`
- 타입 검사: `cd /Users/usabatch/coding/psd_line_export && npx tsc --noEmit`
- **엔진(파이썬) 변경은 HMR로 안 들어간다 — 앱에서 확인하려면 재시작 필수.**
- `App.test.tsx`의 resume 테스트 하나가 깨끗한 트리에서도 3번에 1번쯤 실패한다. 그건 이 작업 탓이 아니다.
- **납품 PSD 파일명은 표준출력·문서·커밋 메시지에 절대 쓰지 않는다.** 번호로만 부른다.
- 새 상수·옵션 주석은 이 저장소 방식대로 **한국어로, 실측 숫자를 근거로** 적는다.

---

### Task 1: 평평한 색으로 뷰를 나눈다

**Files:**
- Modify: `engine/psd_engine/edges.py` (`ANTIALIAS_RADIUS` 정의 아래, `colour_change` 앞)
- Test: `engine/tests/test_edges.py`

**Interfaces:**
- Consumes: 없음
- Produces: `FLAT_COLOUR_FLOOR: float`, `segment_colours(rgba, floor=FLAT_COLOUR_FLOOR) -> (labels: np.ndarray[int32], flats: np.ndarray[int16, (F,3)])`. `labels`는 입력과 같은 (H,W), 투명한 자리는 `-1`, 나머지는 `flats`의 행 번호.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`engine/tests/test_edges.py` 맨 위 import를 이렇게 바꾼다:

```python
from psd_engine.edges import EDGE_DEFAULTS, colour_change, segment_colours
```

그리고 `test_colour_change_ignores_edges_against_transparency` 뒤에 넣는다:

```python
def test_segment_colours_splits_two_flat_regions():
    red, black = [200, 20, 40], [10, 10, 10]
    rgba = _rgba([[red] * 6 + [black] * 6] * 4)
    labels, flats = segment_colours(rgba)
    assert len(flats) == 2, f"평평한 색이 둘이 아니다: {flats.tolist()}"
    assert (labels[:, :6] == labels[0, 0]).all(), "왼쪽이 한 영역으로 안 묶였다"
    assert (labels[:, 6:] == labels[0, 11]).all(), "오른쪽이 한 영역으로 안 묶였다"
    assert labels[0, 0] != labels[0, 11], "다른 두 색이 같은 영역이 됐다"


def test_segment_colours_leaves_transparent_pixels_unlabelled():
    # 실루엣(색 vs 투명)은 이미 라인이 그리는 자리다. 영역이 되면 안 된다.
    red = [200, 20, 40]
    rgba = _rgba([[red] * 8] * 4)
    rgba[:, 4:, 3] = 0
    labels, _ = segment_colours(rgba)
    assert (labels[:, 4:] == -1).all(), "투명한 자리에 라벨이 붙었다"
    assert (labels[:, :4] >= 0).all(), "불투명한 자리에 라벨이 안 붙었다"


def test_segment_colours_assigns_an_antialiased_pixel_to_the_nearer_flat():
    # 안티에일리어싱 잔여는 개수가 적어 평평한 색이 못 된다(한 뷰에 600~1900개).
    # 가까운 쪽에 붙어야 경계가 전이 한가운데에 선다.
    dark, light, blend = [100, 100, 100], [200, 200, 200], [120, 120, 120]
    rgba = _rgba([[dark] * 5 + [blend] + [light] * 5])
    labels, flats = segment_colours(rgba, floor=0.15)
    assert len(flats) == 2, f"전이색이 자기 영역을 차지했다: {flats.tolist()}"
    assert labels[0, 5] == labels[0, 0], "전이 픽셀이 먼 쪽에 붙었다"


def test_segment_colours_handles_a_fully_transparent_view():
    rgba = _rgba([[[0, 0, 0]] * 4] * 4, alpha=0)
    labels, flats = segment_colours(rgba)
    assert (labels == -1).all()
    assert flats.shape == (0, 3)
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd /Users/usabatch/coding/psd_line_export/engine && .venv/bin/python -m pytest tests/test_edges.py -q -k segment_colours`
Expected: FAIL — `ImportError: cannot import name 'segment_colours'`

- [ ] **Step 3: 구현한다**

`engine/psd_engine/edges.py`의 `ANTIALIAS_RADIUS = 3` 아래, `def colour_change` 위에 넣는다:

```python
#: 평평한 색으로 칠 최소 점유율 — 그 뷰 불투명 픽셀 대비.
#:
#: **상위 N개로 자르면 안 된다.** 상위 12색이 화면의 95.0~98.6%를 덮지만, 못 덮는
#: 1.4~5.0%가 곧 리본·작은 별 같은 작은 것들이고 지글거린다고 지목된 대상이 정확히
#: 그것들이다. 개수 바닥값으로 자르면 작아도 평평하면 살아남는다.
#:
#: 실측 세 파일(뷰 0)에서 서로 다른 색 2632~3696개 중 이 값이 평평한 색 12~21개를
#: 남긴다. 프리셋 키로 노출하지 않는다 — 아티스트가 돌릴 손잡이가 하나 더 느는
#: 값어치가 없다. ANTIALIAS_RADIUS와 같은 성격의 상수다.
FLAT_COLOUR_FLOOR = 0.0005


def _pack_rgb(rgb):
    return ((rgb[..., 0].astype(np.uint32) << 16)
            | (rgb[..., 1].astype(np.uint32) << 8)
            | rgb[..., 2].astype(np.uint32))


def _unpack_rgb(keys):
    return np.stack([(keys >> 16) & 255, (keys >> 8) & 255, keys & 255],
                    -1).astype(np.int16)


def segment_colours(rgba, floor=FLAT_COLOUR_FLOOR):
    """
    합성된 색 그림을 평평한 색 영역으로 나눈다. (labels, flats)를 돌려준다.

    labels는 입력과 같은 크기의 int32이고 **투명한 자리는 -1**이다. 나머지는 flats의
    행 번호이고 flats는 (F,3) int16이다.

    평평한 색 = 개수가 floor 이상인 색(FLAT_COLOUR_FLOOR 참고). 나머지는 대부분
    1픽셀짜리 안티에일리어싱 잔여이고, **가장 가까운 평평한 색**에 붙인다. 거리는
    채널 최대차 — threshold와 같은 척도라 region_boundary의 게이트와 어긋나지 않는다.

    33 Mpx를 픽셀마다 재지 않는다. 한 뷰의 서로 다른 색은 2600~3700개뿐이므로 **색마다
    한 번** 재고 역인덱스로 펼친다 — 실측 11717x2820 뷰에서 분할이 2.4초다.
    """
    solid = rgba[..., 3] > 127
    labels = np.full(solid.shape, -1, np.int32)
    if not solid.any():
        return labels, np.zeros((0, 3), np.int16)
    keys = _pack_rgb(rgba[..., :3])[solid]
    vals, inv, counts = np.unique(keys, return_inverse=True, return_counts=True)
    cut = max(1, int(round(floor * int(solid.sum()))))
    keep = np.nonzero(counts >= cut)[0]
    if len(keep) == 0:
        # 바닥값이 그 뷰에 비해 너무 높다 — 제일 흔한 색 하나라도 남겨야 라벨이 선다.
        keep = np.array([int(counts.argmax())])
    flats = _unpack_rgb(vals[keep])
    nearest = np.abs(_unpack_rgb(vals)[:, None, :] - flats[None, :, :]).max(2).argmin(1)
    labels[solid] = nearest[inv].astype(np.int32)
    return labels, flats
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd /Users/usabatch/coding/psd_line_export/engine && .venv/bin/python -m pytest tests/test_edges.py -q -k segment_colours`
Expected: PASS — 4 passed

- [ ] **Step 5: 커밋**

```bash
cd /Users/usabatch/coding/psd_line_export
git add engine/psd_engine/edges.py engine/tests/test_edges.py
git commit -m "feat: split a view's colour image into flat colour regions

A count floor rather than a top-N palette: the top twelve colours cover
95.0-98.6% of a view, and what they miss is the ribbons and small stars the
artist called jittery. Anti-aliasing residue attaches to the nearest flat
colour by max channel difference, the same measure the threshold uses.

Measured once per distinct colour, not per pixel — a view has 2632-3696 of
them against 33 megapixels, so an 11717x2820 view segments in 2.4 seconds.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: 라벨 경계를 색차로 걸러 경계로 삼는다

**Files:**
- Modify: `engine/psd_engine/edges.py` (`segment_colours` 바로 아래)
- Test: `engine/tests/test_edges.py`

**Interfaces:**
- Consumes: `segment_colours(rgba)` → `(labels, flats)`
- Produces: `region_boundary(labels, flats, threshold) -> (mask: np.ndarray[bool], colour: np.ndarray[uint8, (H,W,3)])`. `colour_change`와 **같은 반환 모양**이라 `build_overlay`의 하류가 그대로 붙는다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

import에 `region_boundary`를 더한다:

```python
from psd_engine.edges import EDGE_DEFAULTS, colour_change, region_boundary, segment_colours
```

Task 1의 테스트들 뒤에 넣는다:

```python
def test_region_boundary_marks_one_pixel_at_the_seam():
    # 라벨 경계는 이미 1px이다 — 비최대 억제가 필요 없고, 계단과 잔가시를 만들던
    # 두 단계가 여기서 통째로 사라진다. 경계는 두 색이 실제로 맞닿는 x=5에 선다
    # (colour_change는 중앙차분 k=3의 고지 왼쪽 끝인 x=3에 세운다).
    red, black = [200, 20, 40], [10, 10, 10]
    rgba = _rgba([[red] * 6 + [black] * 6] * 4)
    labels, flats = segment_colours(rgba)
    mask, _ = region_boundary(labels, flats, EDGE_DEFAULTS["threshold"])
    assert mask[:, 5].all(), "색이 갈리는 자리가 경계로 잡히지 않았다"
    other = [c for c in range(12) if c != 5]
    assert not mask[:, other].any(), "경계가 한 칸을 넘어 번졌다"


def test_region_boundary_gates_a_difference_under_the_threshold():
    # 게이트가 없으면 분할은 완만한 그라데이션을 양자화 단계마다 갈라, 아티스트가
    # 아무 경계도 못 보는 자리에 등고선을 긋는다 — colour_change에는 원리상 없던
    # 결함이다. 실측에서 이 게이트는 인접 쌍 92~308개 중 6~118개를 기각한다.
    a, b = [100, 100, 100], [110, 110, 110]      # 차이 10 < 24
    rgba = _rgba([[a] * 6 + [b] * 6] * 4)
    labels, flats = segment_colours(rgba)
    assert len(flats) == 2, "두 색이 각자 영역이 돼야 게이트를 시험할 수 있다"
    mask, _ = region_boundary(labels, flats, EDGE_DEFAULTS["threshold"])
    assert not mask.any(), "문턱 아래인데 획을 그었다 — 그라데이션에 등고선이 생긴다"


def test_region_boundary_ignores_the_silhouette():
    red = [200, 20, 40]
    rgba = _rgba([[red] * 8] * 4)
    rgba[:, 4:, 3] = 0
    labels, flats = segment_colours(rgba)
    mask, _ = region_boundary(labels, flats, EDGE_DEFAULTS["threshold"])
    assert not mask.any(), "실루엣을 경계로 잡았다 — 캐릭터 윤곽을 다시 긋게 된다"


def test_region_boundary_uses_the_darker_of_the_two_regions():
    # colour_change와 같은 규칙이라 하류(stroke_rgba의 조각별 대표색)가 그대로 붙는다.
    red, black = [200, 20, 40], [10, 10, 10]
    rgba = _rgba([[red] * 6 + [black] * 6] * 4)
    labels, flats = segment_colours(rgba)
    mask, colour = region_boundary(labels, flats, EDGE_DEFAULTS["threshold"])
    assert (colour[mask] == np.array(black, np.uint8)).all(), "어두운 쪽을 안 골랐다"


def test_region_boundary_handles_a_view_with_no_flat_colours():
    rgba = _rgba([[[0, 0, 0]] * 4] * 4, alpha=0)
    labels, flats = segment_colours(rgba)
    mask, colour = region_boundary(labels, flats, EDGE_DEFAULTS["threshold"])
    assert not mask.any()
    assert colour.shape == (4, 4, 3)
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd /Users/usabatch/coding/psd_line_export/engine && .venv/bin/python -m pytest tests/test_edges.py -q -k region_boundary`
Expected: FAIL — `ImportError: cannot import name 'region_boundary'`

- [ ] **Step 3: 구현한다**

`segment_colours` 바로 아래에 넣는다:

```python
def region_boundary(labels, flats, threshold):
    """
    라벨이 바뀌는 자리와, 그 자리에 쓸 색(두 대표색 중 어두운 쪽)을 돌려준다.

    `colour_change`와 같은 모양을 돌려주므로 `build_overlay`의 하류가 그대로 붙는다.
    자리는 두 픽셀 중 왼쪽/위쪽, 색은 어두운 쪽(채널 합이 작은 쪽)으로 규칙도 같다.

    **비최대 억제가 없다.** 라벨 경계는 이미 1px이다 — 중앙차분으로 띠를 부풀린 뒤
    억제로 능선을 되찾는 두 단계가 여기서는 필요 없고, 계단과 잔가시가 그 두 단계의
    부산물이었다.

    **색차 게이트는 빼면 안 된다.** 분할은 완만한 그라데이션을 양자화 단계마다 갈라
    놓으므로, 게이트가 없으면 아티스트가 아무 경계도 못 보는 자리에 등고선을 긋는다.
    지금까지의 colour_change에는 원리상 없던 결함이다(걸음당 색차가 문턱을 못 넘어
    아무것도 안 그렸다). 실측에서 인접 쌍 92~308개 중 6~118개를 기각한다.

    투명(라벨 -1)과 맞닿은 자리는 실루엣이라 잡지 않는다. 이미 라인이 그리는 자리다.
    """
    h, w = labels.shape
    mask = np.zeros((h, w), bool)
    colour = np.zeros((h, w, 3), np.uint8)
    if len(flats) == 0:
        return mask, colour
    pair = np.abs(flats[:, None, :] - flats[None, :, :]).max(2)
    sums = flats.sum(1)
    darker = np.where((sums[:, None] <= sums[None, :])[..., None],
                      flats[:, None, :], flats[None, :, :]).astype(np.uint8)
    for axis in (0, 1):
        a = labels[:-1, :] if axis == 0 else labels[:, :-1]
        b = labels[1:, :] if axis == 0 else labels[:, 1:]
        # 경계 픽셀에서만 색차를 조회한다. 전체 크기로 pair[a, b]를 만들면 33 Mpx
        # 뷰에서 수십 MB짜리 중간 배열이 축마다 생긴다.
        ys, xs = np.nonzero((a >= 0) & (b >= 0) & (a != b))
        if len(ys) == 0:
            continue
        av, bv = a[ys, xs], b[ys, xs]
        hit = pair[av, bv] > threshold
        if not hit.any():
            continue
        ys, xs, av, bv = ys[hit], xs[hit], av[hit], bv[hit]
        mask[ys, xs] = True
        colour[ys, xs] = darker[av, bv]
    return mask, colour
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd /Users/usabatch/coding/psd_line_export/engine && .venv/bin/python -m pytest tests/test_edges.py -q`
Expected: PASS — 기존 테스트를 포함해 전부 통과

- [ ] **Step 5: 커밋**

```bash
cd /Users/usabatch/coding/psd_line_export
git add engine/psd_engine/edges.py engine/tests/test_edges.py
git commit -m "feat: outline where two colour regions meet

A label boundary is already one pixel wide, so the two stages that produced
the staircase — widening the comparison across the anti-aliased transition,
then suppressing non-maxima to recover a ridge — are simply absent. Placement
and colour follow colour_change's rules so the downstream stages attach
unchanged.

The colour-difference gate ships with it rather than after it. Segmentation
splits a smooth gradient at every quantisation step, so without the gate a
contour appears where the artist sees no edge at all — a failure the previous
detection could not have. It rejects 6-118 of 92-308 adjacent pairs on the
three files measured.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `edgeMode`로 두 검출을 고르게 하고 캐시 키에 넣는다

**Files:**
- Modify: `engine/psd_engine/edges.py` (`EDGE_DEFAULTS`, `COLOUR_MODES` 아래, `build_overlay`)
- Modify: `engine/psd_engine/rpc.py:71`
- Test: `engine/tests/test_edges.py`, `engine/tests/test_rpc.py`

**Interfaces:**
- Consumes: `segment_colours`, `region_boundary`
- Produces: `EDGE_MODES = ("region", "change")`, `EDGE_DEFAULTS["edgeMode"] == "region"`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

import에 `EDGE_MODES`와 `build_overlay`를 더한다(이미 있으면 그대로 둔다):

```python
from psd_engine.edges import (
    EDGE_DEFAULTS, EDGE_MODES, build_overlay, colour_change, region_boundary,
    segment_colours)
```

Task 2의 테스트들 뒤에 넣는다:

```python
def test_edge_mode_defaults_to_region():
    # 아티스트가 신고한 결함이 change의 동작이다. 기본을 결함 쪽에 두면 고친 것을
    # 보려고 스위치를 찾아야 한다.
    assert EDGE_DEFAULTS["edgeMode"] == "region"
    assert set(EDGE_MODES) == {"region", "change"}


def test_edge_mode_picks_which_detection_runs():
    # 중앙차분(k=3)은 문턱을 넘는 고지의 왼쪽 끝인 x=3에, 라벨 경계는 두 색이 실제로
    # 맞닿는 x=5에 획을 세운다. 어느 자리에 섰는지로 어느 검출이 돌았는지 갈린다.
    red, black = [200, 20, 40], [10, 10, 10]
    rgba = _rgba([[red] * 6 + [black] * 6] * 8)
    line = np.zeros((8, 12), np.uint8)
    opts = {**EDGE_DEFAULTS, "width": 1, "gap": 0, "minLength": 1}
    change = build_overlay(rgba, line, {**opts, "edgeMode": "change"})
    region = build_overlay(rgba, line, {**opts, "edgeMode": "region"})
    assert int(change[..., 3].sum(0).argmax()) == 3, "change가 옛 검출을 안 썼다"
    assert int(region[..., 3].sum(0).argmax()) == 5, "region이 라벨 경계를 안 썼다"


def test_edge_mode_absent_behaves_as_region():
    # 프런트가 이 키를 안 실어 보내도 기본 동작이어야 한다.
    red, black = [200, 20, 40], [10, 10, 10]
    rgba = _rgba([[red] * 6 + [black] * 6] * 8)
    line = np.zeros((8, 12), np.uint8)
    opts = {k: v for k, v in EDGE_DEFAULTS.items() if k != "edgeMode"}
    opts = {**opts, "width": 1, "gap": 0, "minLength": 1}
    without = build_overlay(rgba, line, opts)
    explicit = build_overlay(rgba, line, {**opts, "edgeMode": "region"})
    assert (without == explicit).all(), "키가 없을 때와 region을 줬을 때가 다르다"
```

`engine/tests/test_rpc.py`의 `test_render_preview_recomputes_when_the_colour_mode_changes` 바로 뒤에 넣는다:

```python
def test_render_preview_recomputes_when_the_edge_mode_changes(tmp_path, monkeypatch):
    # edgeMode는 그려지는 획 자체를 바꾼다. 캐시 키에서 빠져 있으면, 두 검출을
    # 비교하려고 모드만 바꿔 다시 렌더한 사람이 **이전 모드의 오버레이를 그대로
    # 보고** "차이 없음"이라는 틀린 판정을 내린다 — colourMode 때와 같은 함정이다.
    p = _two_view_psd(tmp_path)
    engine = rpc.Engine(out=io.StringIO())
    r = engine.open_psd(str(p))
    sid = r["sessionId"]
    s = engine.store.get(sid)
    front_line_id = next(
        lid for lid, l in s["layers_by_id"].items()
        if l.name == "LINES" and l.parent.name == "FRONT"
    )

    calls = _spy_on_plan_overlays(monkeypatch)

    engine.render_preview(sid, visibleLayerIds=[front_line_id],
                          edgeLines={"enabled": True, "edgeMode": "region"})
    engine.render_preview(sid, visibleLayerIds=[front_line_id],
                          edgeLines={"enabled": True, "edgeMode": "change"})

    assert len(calls) == 2, (
        f"모드가 바뀌었는데도 캐시를 재사용했다: {len(calls)}번만 호출됨")
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd /Users/usabatch/coding/psd_line_export/engine && .venv/bin/python -m pytest tests/test_edges.py tests/test_rpc.py -q -k edge_mode`
Expected: FAIL — `ImportError: cannot import name 'EDGE_MODES'`

- [ ] **Step 3: 구현한다**

`edges.py`의 `EDGE_DEFAULTS`에 키를 더한다(`"colourMode"` 줄 아래):

```python
    "edgeMode": "region",       # 색 경계를 찾는 방법. EDGE_MODES 참고
```

`COLOUR_MODES = (...)` 정의 아래에 넣는다:

```python
#: 뷰의 색 경계를 찾는 두 가지 방법.
#:
#: `region`이 기본이다 — 색 그림을 평평한 색 영역으로 나눠(`segment_colours`) 라벨이
#: 바뀌는 자리를 두른다(`region_boundary`). `change`는 지금까지의 동작으로, 중앙차분
#: 으로 색차를 재고 비최대 억제로 능선을 남긴다(`colour_change`).
#:
#: 그 두 단계가 아티스트가 "지글거린다"고 한 것을 만들었다. **부풀리기 전 1px
#: 마스크를 그리면 갈린다** — `change`의 중심선은 끊기고 겹줄이 나고 가시가 돋는데
#: `region`은 이어진 한 줄이다. 알파만 보면 판정이 기운다: `stroke_rgba`가 마지막에
#: 블러 0.8을 걸어 `change`의 계단을 이미 덮어 놓기 때문이다.
#:
#: 실측 세 파일에서 `region` 마스크는 `change`가 잡던 것의 89.3~97.7%를 담고, 최종
#: 경계 픽셀은 +5% / +50% / +91%로 늘어난다. 늘어난 폭이 파일마다 크게 다르고 그
#: 초과분이 진짜 경계인지는 눈으로 봐야 하므로, `change`를 남겨 같은 세션에서 비교할
#: 수 있게 둔다. 판정이 끝나면 둘 중 하나만 남기고 이 옵션은 없앤다.
EDGE_MODES = ("region", "change")
```

`build_overlay`의 첫 두 줄을 바꾼다. 지금:

```python
    o = {**EDGE_DEFAULTS, **(opts or {})}
    raw_mask, colour = colour_change(colour_rgba, o["threshold"])
```

이렇게:

```python
    o = {**EDGE_DEFAULTS, **(opts or {})}
    if o.get("edgeMode") == "change":
        raw_mask, colour = colour_change(colour_rgba, o["threshold"])
    else:
        raw_mask, colour = region_boundary(*segment_colours(colour_rgba),
                                           o["threshold"])
```

`engine/psd_engine/rpc.py:71`을 바꾼다:

```python
_PIXEL_SETTINGS = ("threshold", "gap", "width", "minLength", "lineAlpha",
                   "colourMode", "edgeMode")
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd /Users/usabatch/coding/psd_line_export/engine && .venv/bin/python -m pytest tests/ -q`
Expected: PASS — 엔진 전체 통과. **`region`이 기본이 되면서 기존 오버레이 테스트의 획 자리가 바뀔 수 있다.** 깨지면 그 테스트가 무엇을 지키던 것인지 읽고, 검출과 무관한 것이면 픽스처를 고치고, 검출 자체를 재던 것이면 `edgeMode="change"`를 명시해 옛 동작을 계속 지키게 한다.

- [ ] **Step 5: 커밋**

```bash
cd /Users/usabatch/coding/psd_line_export
git add engine/psd_engine/edges.py engine/psd_engine/rpc.py engine/tests/
git commit -m "feat: let a view's boundaries be found by region, and keep the old way

Region detection becomes the default because the artist's complaint is what
the old path does; leaving the default on the defect would mean hunting for a
switch to see the fix. The old path stays reachable under edgeMode=change as
the place to return to when a regression is suspected, on the same contract as
colourMode: when the judgement is made, one of the two goes and the option
goes with it.

edgeMode joins _PIXEL_SETTINGS. A setting that changes drawn pixels has to be
in the overlay cache key; left out, switching modes in one session returns the
previous mode's overlays and the comparison silently compares nothing against
itself.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: 획의 검은 후광을 없앤다

**Files:**
- Modify: `engine/psd_engine/edges.py` (`stroke_rgba`)
- Test: `engine/tests/test_edges.py`

**Interfaces:**
- Consumes: 없음 (`stroke_rgba(mask, labels, colour, width)` 시그니처 그대로)
- Produces: `BLUR_REACH: int`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

import에 `label_components`, `stroke_rgba`를 더한다. 테스트 파일 끝에 넣는다:

```python
def test_stroke_rgba_paints_every_pixel_it_makes_visible():
    # 알파는 블러로 thick 밖까지 넓어지는데 색은 thick 안에만 칠하면, 자락이
    # (0,0,0)으로 남아 모든 생성 획에 **검은 후광**이 둘린다. 실측 한 뷰에서
    # 알파>0 픽셀 10204개 중 4296개(42.1%)가 그랬고 전부 thick 밖이었다.
    from psd_engine.edges import label_components, stroke_rgba

    mask = np.zeros((16, 16), bool)
    mask[:, 8] = True
    labels, _ = label_components(mask)
    colour = np.zeros((16, 16, 3), np.uint8)
    colour[mask] = [150, 140, 110]
    out = stroke_rgba(mask, labels, colour, 5)
    visible = out[..., 3] > 0
    unpainted = visible & (out[..., :3].max(2) == 0)
    assert visible.any(), "픽스처에 획이 없다 — 테스트가 무의미하다"
    assert not unpainted.any(), (
        f"알파는 있는데 색이 안 칠해진 픽셀이 {int(unpainted.sum())}개다 — 검은 후광")
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd /Users/usabatch/coding/psd_line_export/engine && .venv/bin/python -m pytest tests/test_edges.py -q -k paints_every_pixel`
Expected: FAIL — `알파는 있는데 색이 안 칠해진 픽셀이 64개다 — 검은 후광`

- [ ] **Step 3: 구현한다**

`AUTO_WIDTH_FALLBACK` 정의 위(또는 `stroke_rgba` 바로 위)에 상수를 넣는다:

```python
#: 알파에 거는 가우시안 블러(σ=0.8)가 thick 밖으로 번지는 폭(px).
#:
#: 라벨을 이만큼 더 키우지 않으면 그 자락이 색 없이 (0,0,0)으로 남아 모든 생성 획에
#: 검은 후광이 둘린다 — 실측 한 뷰에서 알파>0 픽셀의 42.1%가 그랬고 평균 알파 32.4,
#: 그 100%가 thick 밖이었다. 지금 획이 진해 보이는 이유의 일부가 이것이라, 고치면
#: 획이 **옅어진다**. 그건 의도된 결과다.
BLUR_REACH = 2
```

`stroke_rgba` 안에서 두 곳을 바꾼다. 지금:

```python
    size = width if width % 2 else width + 1
    grown = labels
    for _ in range(size // 2):
```

이렇게:

```python
    size = width if width % 2 else width + 1
    grown = labels
    for _ in range(size // 2 + BLUR_REACH):
```

그리고 색을 칠하는 줄. 지금:

```python
        out[(grown == lab) & thick, :3] = rep
```

이렇게(루프 앞에 `painted`를 만든다):

```python
    painted = alpha > 0
    for lab in range(1, labels.max() + 1):
        src = labels == lab
        if not src.any():
            continue
        rep = np.median(colour[src], axis=0).astype(np.uint8)
        out[(grown == lab) & painted, :3] = rep
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd /Users/usabatch/coding/psd_line_export/engine && .venv/bin/python -m pytest tests/ -q`
Expected: PASS — 엔진 전체 통과. 라벨을 두 링 더 키우므로 **두 조각이 굵기 안에서 만나는 자리의 소유권이 바뀔 수 있다.** 관련 테스트(조각별 대표색·라벨 팽창 편향)가 깨지면, 링을 하나씩 퍼뜨리는 성질(먼저 도착한 라벨이 더 가깝다)은 그대로이므로 픽스처의 기대값을 다시 계산해 고친다.

- [ ] **Step 5: 커밋**

```bash
cd /Users/usabatch/coding/psd_line_export
git add engine/psd_engine/edges.py engine/tests/test_edges.py
git commit -m "fix: paint the whole stroke, not just its core

stroke_rgba widens alpha with a gaussian blur but painted colour only inside
thick, so the fringe shipped as pure black with no colour of its own. On one
view 4296 of 10204 stroke pixels — 42.1% — were (0,0,0) at a mean alpha of
32.4, and every one of them was outside thick.

Growing the label map two more rings covers where the blur reaches, and colour
now fills wherever alpha does. Strokes get lighter as a result: part of why
they read as dark today was a halo nobody asked for.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: 프런트에 `edgeMode`를 태우고 엔진과 대조한다

**Files:**
- Modify: `src/lib/types.ts` (`EdgeLines`의 `colourMode` 아래)
- Modify: `src/lib/presets.ts` (`DEFAULT_EDGE_LINES`, `parsePresets`의 검증)
- Modify: `src/lib/presets.test.ts` (마지막 대조 테스트)
- Modify: `src/lib/previewCache.test.ts:17,112,113`, `src/lib/engine.test.ts:41`, `src/components/BatchPanel.test.tsx:40`

**Interfaces:**
- Consumes: 엔진의 `EDGE_DEFAULTS["edgeMode"]`, `EDGE_MODES`
- Produces: `EdgeLines["edgeMode"]: "region" | "change"`, `DEFAULT_EDGE_LINES.edgeMode === "region"`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/lib/presets.test.ts`의 마지막 테스트 `"the five numeric edge-line defaults match the engine's EDGE_DEFAULTS"` 안, `COLOUR_MODES`를 보는 블록 **뒤**에 이어 붙인다:

```typescript
  // edgeMode도 같은 이유로 대조한다. 이 대조가 없으면 프런트가 항상 값을 실어
  // 보내는 탓에 엔진 기본값이 매번 덮어써지고, 양쪽 테스트는 각자 자기 상수만
  // 보므로 둘 다 통과한다 — width 자동이 앱에서 한 번도 안 돌았던 그 사고다.
  const emode = /"edgeMode":\s*"(\w+)"/.exec(body);
  expect(emode, "engine EDGE_DEFAULTS에 edgeMode가 없다").not.toBeNull();
  expect(emode![1], "edgeMode: 엔진과 DEFAULT_EDGE_LINES가 다르다").toBe(
    DEFAULT_EDGE_LINES.edgeMode,
  );
  const emodes = /EDGE_MODES = \(([^)]*)\)/.exec(edgesSource);
  expect(emodes, "engine에 EDGE_MODES가 없다").not.toBeNull();
  for (const value of ["region", "change"]) {
    expect(emodes![1], `EDGE_MODES에 ${value}가 없다`).toContain(`"${value}"`);
  }
```

같은 파일에 검증 테스트를 하나 더 넣는다(`edgeLines.width` 관련 테스트 옆):

```typescript
test("an unknown edgeMode is rejected rather than passed to the engine", () => {
  const bad = {
    ...DEFAULT_PRESET,
    edgeLines: { ...DEFAULT_EDGE_LINES, edgeMode: "sdf" },
  };
  expect(() => parsePresets(JSON.stringify([bad]))).toThrow(/edgeLines\.edgeMode/);
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd /Users/usabatch/coding/psd_line_export && npm test -- presets`
Expected: FAIL — `edgeMode: 엔진과 DEFAULT_EDGE_LINES가 다르다`(또는 타입 오류)

- [ ] **Step 3: 구현한다**

`src/lib/types.ts`의 `colourMode: "composite" | "paste";` 아래에 넣는다:

```typescript
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
```

`src/lib/presets.ts`의 `DEFAULT_EDGE_LINES`를 바꾼다:

```typescript
export const DEFAULT_EDGE_LINES: EdgeLines = {
  enabled: false, threshold: 24, gap: 4, width: 0, minLength: 8, lineAlpha: 64,
  colourMode: "composite", edgeMode: "region",
};
```

`parsePresets`의 `colourMode` 검증 바로 아래에 넣는다:

```typescript
  if (edge.edgeMode !== "region" && edge.edgeMode !== "change") {
    throw new Error(`${prefix}.edgeLines.edgeMode: region 또는 change가 아닙니다.`);
  }
```

`EdgeLines` 리터럴을 만드는 세 파일에 `edgeMode: "region"`을 더한다(`as const`가 붙은 자리는 그대로 맞춘다):
- `src/lib/previewCache.test.ts:17`, `:112`, `:113`
- `src/lib/engine.test.ts:41`
- `src/components/BatchPanel.test.tsx:40` — 여기는 `colourMode: "composite" as const` 형식이므로 `edgeMode: "region" as const`

- [ ] **Step 4: 통과를 확인한다**

Run: `cd /Users/usabatch/coding/psd_line_export && npx tsc --noEmit && npm test`
Expected: PASS — 타입 검사 클린, 프런트 전체 통과(`App.test.tsx`의 resume 플레이크 하나는 제외)

- [ ] **Step 5: 커밋**

```bash
cd /Users/usabatch/coding/psd_line_export
git add src/lib/types.ts src/lib/presets.ts src/lib/presets.test.ts \
        src/lib/previewCache.test.ts src/lib/engine.test.ts \
        src/components/BatchPanel.test.tsx
git commit -m "feat: carry the edge mode from the preset to the engine

The front end always sends every edge-line value, so a key it does not know
about is a key the engine's default never survives. presets.test.ts reads
edges.py and compares, because the two sides passing their own tests is
exactly what happened the last time these defaults drifted.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: 프리셋 대화상자에 검출 선택을 노출한다

**Files:**
- Modify: `src/components/PresetDialog.tsx` (상태 선언 `:79` 아래, 저장하는 `:134`, 색 그림 셀렉트 `:393` 아래)
- Create: `src/components/PresetDialog.test.tsx`

**Interfaces:**
- Consumes: `EdgeLines["edgeMode"]`, `PresetDialog({ mode, preset, existingNames, onSave, onCancel })`
- Produces: 없음

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/components/PresetDialog.test.tsx`를 만든다. `@testing-library/user-event`는 이 저장소 의존성이 **아니므로** `@testing-library/react`가 다시 내보내는 `fireEvent`를 쓴다(의존성이 늘지 않는다). `mode="edit"` + `existingNames={[]}`면 `handleSubmit`이 확인 단계 없이 바로 `onSave`를 부른다.

```tsx
// @vitest-environment jsdom
/**
 * 검출 선택이 실제로 저장까지 이어지는지 잠근다.
 *
 * 두 검출을 비교하라고 남긴 옵션이라 아티스트가 앱에서 고를 수 있어야 의미가 있다.
 * 상태만 있고 저장 객체에서 빠지면 화면은 바뀐 것처럼 보이는데 프리셋에는 안 들어가
 * 비교가 조용히 무의미해진다 — colourMode가 지금 이 테스트 없이 돌고 있다.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { PresetDialog } from "./PresetDialog";
import { DEFAULT_EDGE_LINES, DEFAULT_PRESET } from "../lib/presets";

afterEach(cleanup);

/** 검출 셀렉트. 라벨이 힌트 문단까지 감싸고 있어 getByLabelText로는 안 잡힌다. */
function edgeModeSelect(): HTMLSelectElement {
  const found = screen
    .getAllByRole("combobox")
    .find((el) => el.querySelector('option[value="region"]') !== null);
  if (!found) throw new Error("검출 선택 셀렉트를 못 찾았다");
  return found as HTMLSelectElement;
}

function renderDialog(enabled: boolean, onSave = vi.fn()) {
  render(
    <PresetDialog
      mode="edit"
      preset={{
        ...DEFAULT_PRESET,
        edgeLines: { ...DEFAULT_EDGE_LINES, enabled },
      }}
      existingNames={[]}
      onSave={onSave}
      onCancel={() => {}}
    />,
  );
  return onSave;
}

test("the edge-mode choice reaches the saved preset", () => {
  const onSave = renderDialog(true);
  fireEvent.change(edgeModeSelect(), { target: { value: "change" } });
  fireEvent.click(screen.getByRole("button", { name: "저장" }));
  expect(onSave).toHaveBeenCalledTimes(1);
  expect(onSave.mock.calls[0][0].edgeLines.edgeMode).toBe("change");
});

test("the preset's own edge mode is what the control starts on", () => {
  renderDialog(true);
  expect(edgeModeSelect().value).toBe(DEFAULT_EDGE_LINES.edgeMode);
});

test("the edge-mode control is not offered when edge lines are off", () => {
  renderDialog(false);
  expect(
    screen
      .queryAllByRole("combobox")
      .some((el) => el.querySelector('option[value="region"]') !== null),
  ).toBe(false);
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd /Users/usabatch/coding/psd_line_export && npm test -- PresetDialog`
Expected: FAIL — 앞의 두 테스트가 `Error: 검출 선택 셀렉트를 못 찾았다`로 떨어진다. 세 번째("off일 때 안 보인다")는 컨트롤이 아직 없으므로 **이미 통과한다** — 그게 정상이고, 그 테스트는 구현 뒤에도 통과해야 의미가 생긴다.

- [ ] **Step 3: 구현한다**

`src/components/PresetDialog.tsx`의 `colourMode` 상태 아래에 넣는다:

```typescript
  // 색 경계를 찾는 방법. 어느 쪽이 옳은지 아직 사람이 판정하는 중이라 노출한다
  // (types.ts의 EdgeLines.edgeMode 참고). 판정이 끝나면 이 컨트롤은 없앤다.
  const [edgeMode, setEdgeMode] =
    useState<EdgeLines["edgeMode"]>(preset.edgeLines.edgeMode);
```

저장하는 줄(`edgeLines: { ...preset.edgeLines, enabled: edgeEnabled, colourMode },`)을 바꾼다:

```typescript
      edgeLines: { ...preset.edgeLines, enabled: edgeEnabled, colourMode, edgeMode },
```

색 그림 셀렉트를 담은 `</label>` 바로 아래, 같은 `{edgeEnabled && (...)}` 블록 안에 넣는다:

```tsx
          <label className="preset-field">
            <span>색 경계 찾는 방법</span>
            <select
              value={edgeMode}
              onChange={(e) => setEdgeMode(e.target.value as EdgeLines["edgeMode"])}
            >
              <option value="region">영역 — 색 영역을 나눠 경계를 두름 (기본)</option>
              <option value="change">예전 — 픽셀 색차의 능선</option>
            </select>
            <span className="preset-hint">
              <b>영역</b>이 획의 지글거림을 없앤 방법입니다. 대신 획이 파일에 따라
              5~91% 더 그어집니다 — 늘어난 자리가 맞는지 미리보기로 확인해 보세요.
              <b>예전</b>은 되돌아가 비교할 자리로 남겨 둔 것입니다.
            </span>
          </label>
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd /Users/usabatch/coding/psd_line_export && npx tsc --noEmit && npm test`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
cd /Users/usabatch/coding/psd_line_export
git add src/components/PresetDialog.tsx src/components/PresetDialog.test.tsx
git commit -m "feat: let the artist choose how boundaries are found

Keeping the old detection reachable is only worth anything if it can be
reached from the app. The hint says what changed and what it costs — the new
way draws 5-91% more stroke depending on the file, and whether that extra is
right is the judgement this control exists to collect.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: 납품 파일로 실물 확인한다

스펙 7절의 열린 것들을 닫는다. **코드 변경은 프로토타입을 엔진 함수로 갈아끼우는 것 하나뿐이고, 나머지는 눈으로 보는 일이다.** 그림 없이 통과시키면 안 된다 — 조각 수는 지글거림의 지표가 아니다.

**Files:**
- Modify: `.superpowers/sdd/2026-08-08-colour-region-stroke/segment-stroke.py` (자체 구현을 엔진 것으로 교체)

**Interfaces:**
- Consumes: `psd_engine.edges.segment_colours`, `psd_engine.edges.region_boundary`
- Produces: 없음

- [ ] **Step 1: 프로토타입이 엔진 코드를 보게 한다**

프로토타입 안의 `segment`, `region_boundary`, `_pack_rgb`, `_unpack_rgb` 정의를 지우고 import로 바꾼다. 그림이 **실제로 배포될 코드**를 그려야 판정이 의미가 있다:

```python
from psd_engine.edges import region_boundary, segment_colours
```

`main()`의 호출부를 맞춘다:

```python
    labels, flats = segment_colours(colour_rgba)
    b_mask, b_colour = region_boundary(labels, flats, o["threshold"])
```

`soft_band`(A)에 넘기던 `coords`는 엔진 함수가 안 돌려준다. **A는 스펙에서 뺐으므로 A 패널과 `soft_band`를 통째로 지운다** — 남겨두면 엔진과 갈라진 코드가 조용히 썩는다.

- [ ] **Step 2: 볼륨이 붙어 있는지 확인한다**

Run: `test -d "/Volumes/bgfinal/colordata/Hazbin_Hotel/HH03_시즌_자료/HH0305/Design/Color/CH" && echo 붙어있음`
Expected: `붙어있음` — 안 나오면 외장 볼륨을 먼저 마운트한다.

- [ ] **Step 3: #001의 과생성 여부를 가린다**

`#001`은 아티스트가 "잘 된다"고 확인한 파일이고, 최종 경계가 1807 → 2713(+50%)으로 가장 많이 늘었다. **여기서 늘어난 것이 가장 위험하다.**

```bash
cd /Users/usabatch/coding/psd_line_export
for V in 0 1 2; do
  engine/.venv/bin/python .superpowers/sdd/2026-08-08-colour-region-stroke/segment-stroke.py \
    001 --view $V --size 96 --zoom 8
done
```

`out/`의 그림에서 **셋째 줄(1px 마스크)** 을 본다. 늘어난 자리가 (a) 기존이 조각내 버렸던 연속 경계인지, (b) 없던 자리에 새로 생긴 것인지 판정한다. (b)가 보이면 `FLAT_COLOUR_FLOOR`를 올려 다시 잰다.

- [ ] **Step 4: 그라데이션 면에 등고선이 없는지 본다**

`#020`에 그라데이션이 있다. 게이트가 인접 쌍 302개 중 80개를 기각하고 있지만, **기각했다는 사실이 그 면이 깨끗하다는 증거는 아니다.**

먼저 넓게 훑어 그라데이션 면의 좌표를 읽는다. 뷰가 11717x2820이므로 X를 옮겨가며 몇 장 뽑는다:

```bash
cd /Users/usabatch/coding/psd_line_export
for X in 0 1400 2800 4200 5600 7000 8400 9800; do
  engine/.venv/bin/python .superpowers/sdd/2026-08-08-colour-region-stroke/segment-stroke.py \
    020 --view 0 --crop 700 $X 1400 --zoom 1
done
```

그 그림들에서 **색이 완만하게 변하는 면**을 찾아 좌표를 읽고, 그 자리를 확대한다(`700`과 `X`를 읽은 값으로 바꾼다):

```bash
engine/.venv/bin/python .superpowers/sdd/2026-08-08-colour-region-stroke/segment-stroke.py \
  020 --view 0 --crop 700 8400 160 --zoom 6
```

**평평해 보이는 면에 줄무늬가 서면 실패다.** 그러면 `region_boundary`의 게이트가 그 쌍을 왜 통과시켰는지 본다 — 두 대표색 차가 정말 24를 넘는다면 그건 분할이 아니라 문턱의 문제다.

- [ ] **Step 5: `composite`와 대조한다**

프로토타입은 `paste`로만 돌렸다. `#001`에 클리핑 잎 3개, `#020`에 4개가 있다.

3단계에서 쓴 것과 **같은 크롭 자리**로 `composite`를 한 번 더 뽑는다. 자리가 다르면 비교가 아니다:

```bash
cd /Users/usabatch/coding/psd_line_export
engine/.venv/bin/python .superpowers/sdd/2026-08-08-colour-region-stroke/segment-stroke.py \
  001 --view 0 --colour-mode composite --crop 812 693 96 --zoom 8
```

출력 파일 이름에 크롭 좌표가 들어가므로 `paste` 그림을 덮어쓴다 — **먼저 이름을 바꿔 둔다**:

```bash
mv .superpowers/sdd/2026-08-08-colour-region-stroke/out/seg_001_v0_812_693_96.png \
   .superpowers/sdd/2026-08-08-colour-region-stroke/out/seg_001_v0_812_693_96_paste.png
```

두 장을 나란히 놓고 획이 갈리는지 본다. 갈리면 그 사실을 스펙 7절에 적는다 — 이 작업에서 고칠 것은 아니다(`colourMode` 판정은 별개 축이다).

- [ ] **Step 6: 앱에서 두 모드를 토글해 본다**

**엔진 변경은 HMR로 안 들어간다 — 앱을 재시작하고 시작한다.** 프리셋 대화상자에서 `영역` ↔ `예전`을 바꿔가며 같은 뷰를 미리보기한다. 확인할 것 둘:

1. 모드를 바꾸면 그림이 **실제로 바뀐다**(안 바뀌면 캐시 키가 빠진 것이다 — Task 3의 회귀 테스트가 잡았어야 한다).
2. 획이 `region`에서 옅어 보인다면 그건 Task 4의 검은 후광 수정 때문이고, 의도된 결과다.

- [ ] **Step 7: 확인 결과를 스펙에 적고 커밋한다**

`docs/superpowers/specs/2026-08-08-colour-region-stroke-design.md` 7절의 항목마다 무엇을 봤고 무엇으로 판정했는지 한 줄씩 적는다. **"확인함"이 아니라 무엇을 보고 그렇게 판정했는지**를 적는다.

```bash
cd /Users/usabatch/coding/psd_line_export
git add docs/superpowers/specs/2026-08-08-colour-region-stroke-design.md
git commit -F - <<'MSG'
docs: record what the delivery files showed

본문은 이 커밋을 만들 때 직접 쓴다. 4단계에서 본 것을 그대로 적는다 — 어느 번호의
어느 뷰에서 무엇을 봤고, 그래서 7절의 어느 항목을 닫았는지. 파일명은 쓰지 않고
번호로만 부른다. "확인함"은 근거가 아니다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
MSG
```

---

## 되돌리는 법

`edgeMode`를 `change`로 두면 검출은 이 작업 이전과 같다. 다만 **Task 4(검은 후광)는 모드와 무관하게 적용된다** — 획의 진하기까지 옛날 그대로 보려면 그 커밋을 따로 되돌려야 한다.
