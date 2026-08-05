# 그룹 썸네일 축소 합성기 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 48px 그룹 썸네일을 전해상도 합성 없이 만든다 — 잎을 자기 bbox에서 한 번 디코딩·축소한 뒤 작은 캔버스에서 블렌드·불투명도·클리핑까지 재현해 합성한다.

**Architecture:** 커밋 두 개. ① `extract_rgba`의 마스크 분기를 psd-tools 합성식을 그대로 옮긴 값싼 경로로 바꾼다(가드 필수, 계약은 바이트 동일). ② `0fbbeef`를 되돌리고 `_group_rgba_scaled`를 넣는다. 미리보기 반응속도는 이 계획의 범위가 아니다 — 별도 스펙.

**Tech Stack:** Python 3.12, psd-tools 1.17.4, numpy, Pillow, pytest. 픽스처는 pytoshop 1.2.1로 쓴다.

**설계 문서:** `docs/superpowers/specs/2026-08-05-group-thumbnail-scaled-compositor-design.md`

## Global Constraints

- 엔진 테스트: `cd engine && .venv/bin/python -m pytest -q`. **시작 시점 기준선은 200 passed.**
- 프런트엔드 테스트(`npm test`)와 Rust 테스트는 이 계획에서 건드리지 않는다 — 각각 372, 16이 유지되어야 한다.
- 주석과 docstring은 한국어, 기존 `render.py` 문체를 따른다. 값을 고른 **이유와 실측치**를 적는다.
- **`extract_rgba`는 `export.py:41`과 `verify.py:36`이 함께 쓴다.** 이 함수를 바꾸는 커밋은 `scripts/export-baseline.py --compare`가 **동일**을 낼 때만 완료다.
- float32 산술을 대수적으로 줄이지 않는다. `_merge_rgba_fast`의 docstring이 이유를 적어 두었다 — `(1-a)*c + a*c`는 `c`와 같은 값이 아니고, 마지막 비트가 절삭 경계에 걸리면 픽셀이 1 달라진다.
- uint8 변환은 **절삭**이다: `(255 * x).astype(np.uint8)`. `np.round`가 아니다.
- 커밋 메시지는 영어, 기존 형식. 끝에 `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>` 와 `Claude-Session: https://claude.ai/code/session_01Ltm3qkFkyb9oANqu3A2HRc`.
- 커밋만 하고 **푸시하지 않는다**. 사용자가 직접 민다.

## 참고 — psd-tools가 실제로 하는 일

`extract_rgba`의 마스크 분기는 `layer.composite(viewport=layer.bbox)`다. 그 호출이 하는 일을 소스에서 확인한 결과(`psd_tools/composite/composite.py`):

- `Compositor.apply` (318행): `shape, alpha = _get_object(layer)` → `shape_mask, opacity_mask = _get_mask(layer)` → `shape_const, opacity_const = _get_const(layer)` → `mask = shape_mask * opacity_mask * opacity_const`, `shape *= shape_mask`, `alpha *= mask` → `_apply_source(color, shape*shape_const, alpha*shape_const, blend_mode, knockout)`.
- `_get_mask` (621행): `layer.numpy("mask", real_mask=not force)` 를 `paste(viewport, layer.mask.bbox, mask, layer.mask.background_color/255.0)` 로 뷰포트에 놓는다. **그리고 `layer.mask.parameters`가 있으면 density를 건다**: `shape = density*shape + (1-density)`, density는 `user_mask_density` 우선, 없으면 `vector_mask_density`, 그것도 없으면 255.
- `_get_const` (675행): `shape = BLEND_FILL_OPACITY/255`, `opacity = layer.opacity/255`.
- `_apply_source` (410행): 배경이 `color=1.0, alpha=0.0`이면 `alpha_b = 0`, `color_b = 1.0`, `alpha_previous = 0`이므로 식이 줄어든다 — `color_t = alpha*color`, `_color = clip(divide(alpha*color, alpha))`.
- `utils.divide` (`composite/utils.py`): **0/0을 1.0으로 만든다.** 그래서 알파 0인 자리의 RGB가 흰색이 된다.
- `composite_pil` (22행): RGB 문서에서 `skip_alpha`는 False이므로 알파가 붙고, `Image.fromarray((255*color).astype(np.uint8), "RGBA")` 로 **절삭** 양자화한 뒤 `pil_io.post_process(image, None, icc)`를 태운다.

즉 마스크 하나짜리 평범한 레이어에서 `layer.composite(viewport=bbox)`의 결과는:

```
shape_mask = paste(bbox, mask.bbox, mask_array, mask.background_color/255) * density_term
alpha      = layer_alpha * shape_mask * (opacity/255) * (fill_opacity/255)
RGB        = layer_color        (alpha > 0)
           = 1.0 (흰색)         (alpha == 0)
```

**주의**: `_apply_clip_layers` (606행)는 하위 Compositor를 만들어 `_color`만 돌려준다 — **클리핑 레이어는 베이스의 색만 바꾸고 알파는 바꾸지 않는다.** 설계 문서 §4.1이 "베이스의 알파로 제한"이라고 쓴 것은 부정확하며, Task 9가 이를 바로잡는다.

---

# 커밋 1 — `extract_rgba`의 마스크 경로

### Task 1: 기준선 재기록 (오래 걸림 — 먼저 걸어둔다)

`baseline/hh305.jsonl`은 `4c15c47`보다 앞서 기록돼 stale이다. stale 기준선에서 얻은 "동일"은 의미가 없다.

**Files:**
- 생성: `baseline/hh0306.jsonl` (gitignored)

- [ ] **Step 1: 현재 커밋이 픽셀에 영향이 없음을 확인**

```bash
git log --oneline -1        # fde2310 (docs only) 이어야 한다
git status --short          # 비어 있어야 한다
```

`fde2310`은 문서 한 장이므로 픽셀상 `0fbbeef`와 같다. 여기서 기록한 기준선이 곧 `0fbbeef` 기준선이다.

- [ ] **Step 2: 기준선 기록을 백그라운드로 건다**

```bash
mkdir -p baseline
engine/.venv/bin/python scripts/export-baseline.py \
  "/Volumes/bgfinal/colordata/Hazbin_Hotel/HH03_시즌_자료/HH0306/Design/COLOR/BG/02_Color" \
  --out baseline/hh0306.jsonl --resume
```

파일당 ~82초이고 기계가 바쁘면 3~4배 나빠진다. 26개 파일이므로 35분~2시간. `--resume`이 있으니 중간에 끊겨도 진행 중이던 파일 하나만 잃는다. **볼륨이 마운트돼 있는지 먼저 확인한다** (`ls /Volumes/bgfinal`).

- [ ] **Step 3: 헤더의 `createdAt`이 현재 커밋보다 뒤인지 확인**

```bash
head -1 baseline/hh0306.jsonl | engine/.venv/bin/python -c "import json,sys; print(json.load(sys.stdin))"
git log -1 --format=%cI
```

`createdAt`이 `fde2310`의 커밋 시각보다 **뒤**여야 한다. 앞서면 그 기준선은 못 쓴다.

이 태스크는 커밋을 만들지 않는다(`baseline/`은 gitignored).

---

### Task 2: 마스크 픽스처

**Files:**
- Modify: `engine/tests/conftest.py`
- Test: `engine/tests/test_render.py`

**Interfaces:**
- Produces: `masked_psd` fixture — 경로(str). 레이어 4종을 담는다: `plain_mask`, `bg255_mask`, `dense_mask`, `half_opacity_mask`.

- [ ] **Step 1: `conftest.py`에 마스크를 붙이는 헬퍼를 쓴다**

`write_psd` 바로 아래에 넣는다. `nested_layers.Image`에는 마스크 인자가 없어서 변환이 끝난 레코드에 직접 세운다 — `clipping`을 세우는 기존 방식과 같다.

```python
def attach_mask(psd, name, mask_array, left, top, default_color=0,
                user_mask_density=None):
    """
    변환이 끝난 레코드에 사용자 마스크를 붙인다.

    nested_layers.Image에 마스크 인자가 없어서 write_psd의 clipping과 같은 방식으로
    레코드를 직접 고친다. 채널 -2가 PSD의 사용자 레이어 마스크다.

    default_color는 psd-tools 쪽에서 mask.background_color로 읽히고, 마스크 bbox
    **밖**을 그 값으로 채운다 — 그 조합이 실납품 데이터에서 값싼 경로와 어긋난
    자리라 픽스처가 반드시 덮어야 한다.
    """
    import pytoshop.layers as pl
    from pytoshop import enums as pe

    h, w = mask_array.shape
    for record in psd.layer_and_mask_info.layer_info.layer_records:
        if record.name != name:
            continue
        record.mask = pl.LayerMask(
            top=top, left=left, bottom=top + h, right=left + w,
            default_color=default_color, user_mask_density=user_mask_density,
        )
        record.channels[-2] = pl.ChannelImageData(
            image=mask_array, compression=pe.Compression.raw)
        return
    raise AssertionError(f"layer {name!r} not found")
```

- [ ] **Step 2: `masked_psd` 픽스처를 쓴다**

`conftest.py` 끝에 붙인다.

```python
@pytest.fixture
def masked_psd(tmp_path):
    """
    값싼 마스크 경로가 psd-tools와 같은 픽셀을 내는지 겨루는 픽스처.

    네 장은 각각 실측에서 어긋난 원인을 하나씩 짚는다:
      plain_mask         마스크 bbox == 레이어 bbox, 배경 0 — 가장 쉬운 경우
      bg255_mask         배경 255 + 마스크 bbox < 레이어 bbox — 실납품에서 어긋난 조합
      dense_mask         user_mask_density — _get_mask가 shape에 거는 항
      half_opacity_mask  opacity != 255 — composite는 걸고 topil()은 안 건다
    """
    layers = [
        make_image("plain_mask", 200, 0, 0, 32, 24),
        make_image("bg255_mask", 180, 0, 0, 32, 24),
        make_image("dense_mask", 160, 0, 0, 32, 24),
        make_image("half_opacity_mask", 140, 0, 0, 32, 24),
    ]
    for lyr in layers:
        lyr.opacity = 128 if lyr.name == "half_opacity_mask" else 255
    apply_pytoshop_patches()
    psd = nested_layers.nested_layers_to_psd(
        layers, color_mode=enums.ColorMode.rgb, size=(CANVAS_W, CANVAS_H))

    gradient = np.tile(np.linspace(0, 255, 32, dtype=np.uint8), (24, 1))
    attach_mask(psd, "plain_mask", gradient, left=0, top=0, default_color=0)
    # 마스크가 레이어보다 좁고 배경이 255 — 덮이지 않은 오른쪽 절반이 불투명해진다.
    attach_mask(psd, "bg255_mask", gradient[:, :16], left=0, top=0, default_color=255)
    attach_mask(psd, "dense_mask", gradient, left=0, top=0, default_color=0,
                user_mask_density=128)
    attach_mask(psd, "half_opacity_mask", gradient, left=0, top=0, default_color=0)

    path = tmp_path / "masked.psd"
    with open(path, "wb") as f:
        psd.write(f)
    return str(path)
```

- [ ] **Step 3: 픽스처가 psd-tools에서 마스크로 읽히는지 확인하는 테스트**

`test_render.py`의 `test_extract_rgba_empty_layer_raises` 아래에 넣는다.

```python
def test_masked_fixture_really_carries_masks(masked_psd):
    """
    픽스처가 무엇을 확인하는지부터 확인한다. 마스크가 안 붙으면 아래 동등성
    테스트가 전부 마스크 없는 경로를 재고도 통과한다 — 0fbbeef에서 타일 수를
    안 세서 공허해졌던 테스트와 같은 함정이다.
    """
    psd = PSDImage.open(masked_psd)
    by_name = {l.name: l for l in psd.descendants()}
    assert set(by_name) >= {"plain_mask", "bg255_mask", "dense_mask",
                            "half_opacity_mask"}
    for name in ("plain_mask", "bg255_mask", "dense_mask", "half_opacity_mask"):
        m = by_name[name].mask
        assert m is not None and not m.disabled, f"{name}에 마스크가 없다"
    assert by_name["bg255_mask"].mask.background_color == 255
    assert by_name["bg255_mask"].mask.bbox != by_name["bg255_mask"].bbox
    assert by_name["dense_mask"].mask.parameters is not None
    assert by_name["half_opacity_mask"].opacity == 128
```

- [ ] **Step 4: 실행해서 통과하는지 본다**

```bash
cd engine && .venv/bin/python -m pytest tests/test_render.py::test_masked_fixture_really_carries_masks -v
```

Expected: PASS. 실패하면 `attach_mask`가 psd-tools가 읽는 형태를 못 만든 것이므로 여기서 멈추고 고친다 — 뒤 태스크가 전부 이 픽스처에 얹힌다.

- [ ] **Step 5: 커밋**

```bash
git add engine/tests/conftest.py engine/tests/test_render.py
git commit -m "$(cat <<'EOF'
test: give the suite a masked-layer fixture it never had

extract_rgba branches on layer.mask and the suite only ever exercised the
branch without one. The four layers here are not decoration: each is a case
where a hand-written mask path measurably diverged from psd-tools on real
delivery data — mask bbox smaller than the layer with background_color 255,
a user mask density, and a layer opacity that composite() applies and
topil() does not.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltm3qkFkyb9oANqu3A2HRc
EOF
)"
```

---

### Task 3: 값싼 마스크 경로와 그 가드

**Files:**
- Modify: `engine/psd_engine/render.py` (`extract_rgba` 위에 추가, `extract_rgba` 교체)
- Test: `engine/tests/test_render.py`

**Interfaces:**
- Produces: `_mask_fast_ok(layer) -> bool`, `_extract_rgba_masked(layer) -> np.ndarray | None` (가드를 못 넘으면 `None`), 그리고 이들을 쓰는 `extract_rgba(layer)`.

- [ ] **Step 1: 실패하는 동등성 테스트를 쓴다**

`test_render.py`에 넣는다.

```python
@pytest.mark.parametrize("name", ["plain_mask", "bg255_mask", "dense_mask",
                                  "half_opacity_mask"])
def test_masked_extract_is_byte_identical_to_composite(masked_psd, name):
    """
    값싼 경로는 psd-tools의 합성과 **바이트로** 같아야 한다.

    ±1도 실패다. export.py가 이 함수를 쓰므로 계약이 바이트 동일이고, ±1은
    보통 float32 산술이나 uint8 절삭을 psd-tools와 다르게 했다는 신호다.
    """
    psd = PSDImage.open(masked_psd)
    layer = next(l for l in psd.descendants() if l.name == name)
    reference = np.array(layer.composite(viewport=layer.bbox).convert("RGBA"))

    fast = render_mod._extract_rgba_masked(layer)

    assert fast is not None, f"{name}이 가드를 못 넘어 값싼 경로를 타지 못했다"
    assert fast.shape == reference.shape
    assert np.array_equal(fast, reference), (
        f"최대차 {np.abs(fast.astype(int) - reference.astype(int)).max()}, "
        f"다른 성분 {(fast != reference).sum()}/{fast.size}"
    )
```

- [ ] **Step 2: 실행해서 실패하는 것을 본다**

```bash
cd engine && .venv/bin/python -m pytest tests/test_render.py -k masked_extract -v
```

Expected: FAIL — `AttributeError: module 'psd_engine.render' has no attribute '_extract_rgba_masked'`

- [ ] **Step 3: 가드와 값싼 경로를 쓴다**

`render.py`의 `extract_rgba` **위**에 넣는다.

```python
def _mask_fast_ok(layer):
    """
    값싼 마스크 경로가 psd.composite와 같은 그림을 내는 것이 보장되는 형태인가.

    _plain과 같은 규율이다 — 하나라도 걸리면 예전 경로로 떨어진다. 빠르게 하려다
    그림을 바꾸는 것보다 느린 편이 낫다. 판단 근거는 Compositor.apply가 실제로
    읽는 값들이고, 그쪽이 바뀌면 여기도 같이 봐야 한다.
    """
    from psd_tools.composite import utils
    from psd_tools.constants import BlendMode

    # 효과·획·칠·벡터마스크는 composite가 그린다. 값싼 경로는 그리지 않는다.
    if any(getattr(e, "enabled", True) for e in layer.effects):
        return False
    if layer.stroke is not None and layer.stroke.enabled:
        return False
    if utils.has_fill(layer) or layer.has_vector_mask():
        return False
    # 픽셀이 없으면 numpy("color")가 None이고 composite는 다른 것을 그린다.
    if not layer.has_pixels():
        return False
    # 블렌드는 이 함수의 관심사가 아니다 — extract_rgba는 배경 없이 한 장만 뽑고,
    # 투명한 배경 위에서는 어떤 블렌드도 normal과 결과가 같다. 그래도 knockout은
    # 식을 바꾸므로 막는다.
    if layer.blend_mode == BlendMode.PASS_THROUGH:
        return False
    if layer.tagged_blocks.get_data(Tag.KNOCKOUT_SETTING, 0):
        return False
    # real mask(사용자+벡터 결합)는 별도의 배열이다. force=False인 composite가
    # 그쪽을 읽으므로, 있으면 값싼 경로가 다른 마스크를 보게 된다.
    if layer.mask is not None and layer.mask.has_real():
        return False
    return True


def _extract_rgba_masked(layer):
    """
    마스크 달린 레이어를 layer.composite 없이 읽는다. 가드를 못 넘으면 None.

    **왜 있는가.** composite는 psd-tools의 float32 전체 경로다. 실측(2026-08-05,
    HH03_BG-RosieEmporiumINTShop017_CO_v01.psd의 BG 그룹, 잎 140장):

        마스크 없는 잎  ~50 Mpx/s   29.9Mpx 0.52초, 메모리 미미
        마스크 있는 잎   ~4 Mpx/s   39.6Mpx 10.07초, +5.06GB

    잎 139장 중 마스크 달린 2장이 디코딩 시간의 63%와 peak 13.4GB 전부를 만들었다.
    이 함수는 export.py와 verify.py, 미리보기, 썸네일이 함께 쓴다.

    **식은 Compositor.apply를 그대로 줄인 것이다.** 배경이 color=1.0, alpha=0.0이라
    alpha_b가 0이고, 그때 _apply_source는 color_t = alpha*color 로 줄어든다.
    divide가 0/0을 1.0으로 만들기 때문에 알파 0인 자리의 RGB가 흰색이 된다 —
    그것이 배경이 드러난 것이고, 값싼 경로도 같은 값을 내야 한다.

    대수적으로 더 줄이지 않는다. _merge_rgba_fast의 docstring이 이유를 적어 두었다.
    """
    from psd_tools.composite import utils
    from psd_tools.composite.composite import paste

    if not _mask_fast_ok(layer):
        return None

    color = layer.numpy("color")
    if color is None:
        return None
    shape = layer.numpy("shape")
    if shape is None:
        shape = np.ones(color.shape[:2] + (1,), dtype=np.float32)

    # _get_mask(621행)를 그대로 옮긴다. 뷰포트가 레이어 bbox인 경우다.
    mask_arr = layer.numpy("mask", real_mask=False)
    shape_mask = 1.0
    if mask_arr is not None:
        shape_mask = paste(layer.bbox, layer.mask.bbox, mask_arr,
                           layer.mask.background_color / 255.0)
    if layer.mask.parameters:
        density = layer.mask.parameters.user_mask_density
        if density is None:
            density = layer.mask.parameters.vector_mask_density
        if density is None:
            density = 255
        density = float(density) / 255.0
        shape_mask = density * shape_mask + (1 - density)

    # _get_const(675행).
    shape_const = layer.tagged_blocks.get_data(Tag.BLEND_FILL_OPACITY, 255) / 255.0
    opacity_const = layer.opacity / 255.0

    # apply(348~372행). 배경이 비어 있으므로 alpha 계산만 남는다.
    alpha = shape * (shape_mask * opacity_const) * shape_const
    out_color = utils.clip(utils.divide(alpha * color, alpha))

    merged = np.concatenate((out_color, alpha), axis=2)
    return _quantize_like_psd_tools(layer._psd, merged)


def _quantize_like_psd_tools(psd, merged):
    """
    float32 [0,1] 배열을 composite_pil(22행)과 같은 순서로 uint8 RGBA로 만든다.

    절삭이지 반올림이 아니다. 그리고 문서에 ICC 프로파일이 있으면 같은 후처리를
    태운다 — _merge_rgba_fast의 마무리와 같다.
    """
    from psd_tools.api import pil_io
    from psd_tools.constants import Resource

    img = Image.fromarray((255 * merged).astype(np.uint8), "RGBA")
    icc = None
    if Resource.ICC_PROFILE in psd.image_resources:
        icc = psd.image_resources.get_data(Resource.ICC_PROFILE)
    return np.array(pil_io.post_process(img, None, icc).convert("RGBA"))
```

`render.py` 상단 import에 `Tag`가 필요하다. `_plain`이 함수 안에서 import하는 방식을 따라 각 함수 안에서 `from psd_tools.constants import Tag`를 쓴다 — 모듈 최상단에 psd-tools를 끌어오지 않는 기존 구조를 깨지 않기 위해서다.

- [ ] **Step 4: 실행해서 통과하는지 본다**

```bash
cd engine && .venv/bin/python -m pytest tests/test_render.py -k masked_extract -v
```

Expected: 4개 PASS.

**어긋나면**: 최대차가 1이면 양자화나 ICC 후처리 순서가 다른 것이다. 그보다 크면 `shape_mask` 계산이 다른 것이므로, `layer.composite`를 디버거로 세워 `_get_mask`가 돌려주는 배열과 위 `shape_mask`를 직접 비교한다. **가드를 넓혀 통과시키지 않는다** — 못 맞추는 형태는 `_mask_fast_ok`에서 빼고 fallback으로 둔다.

- [ ] **Step 5: `extract_rgba`를 값싼 경로 우선으로 바꾼다**

`render.py:118`을 교체한다.

```python
def extract_rgba(layer):
    if layer.mask is not None and not layer.mask.disabled:
        fast = _extract_rgba_masked(layer)
        if fast is not None:
            return fast
        img = layer.composite(viewport=layer.bbox)
    else:
        img = layer.topil()
    if img is None:
        raise ValueError(f"layer {layer.name!r} has no pixels")
    return np.array(img.convert("RGBA"))
```

- [ ] **Step 6: 엔진 전체를 돌린다**

```bash
cd engine && .venv/bin/python -m pytest -q
```

Expected: **205 passed** (시작 200 + Task 2의 1 + 여기 4). 하나라도 줄면 멈춘다.

- [ ] **Step 7: 실납품 데이터에서 가드가 실제로 이득을 내는지 확인한다**

임시 스크립트로 잰다(저장소에 남기지 않는다).

```bash
engine/.venv/bin/python - <<'PY'
import sys, time
sys.path.insert(0, "engine")
import numpy as np
from psd_tools import PSDImage
from psd_engine import render

D = "/Volumes/bgfinal/colordata/Hazbin_Hotel/HH03_시즌_자료/HH0306/Design/COLOR/BG/02_Color"
F = f"{D}/HH03_BG-RosieEmporiumINTShop017_CO_v01.psd"
psd = PSDImage.open(F)
ok = slow = 0
for l in psd.descendants():
    if l.is_group() or l.mask is None or l.mask.disabled:
        continue
    if l.width * l.height < 1024 * 1024:
        continue
    t0 = time.perf_counter(); ref = np.array(l.composite(viewport=l.bbox).convert("RGBA")); t_ref = time.perf_counter() - t0
    t0 = time.perf_counter(); fast = render._extract_rgba_masked(l); t_fast = time.perf_counter() - t0
    if fast is None:
        slow += 1
        print(f"  FALLBACK {l.width*l.height/1048576:5.1f}Mpx {l.name[:28]!r}")
        continue
    same = np.array_equal(fast, ref)
    ok += same
    print(f"  {'동일' if same else '다름'} {l.width*l.height/1048576:5.1f}Mpx "
          f"{t_ref:6.2f}s -> {t_fast:5.2f}s ({t_ref/max(t_fast,1e-6):4.1f}x) {l.name[:28]!r}")
print(f"\n값싼 경로 동일 {ok}장, fallback {slow}장")
PY
```

**판정**: 값싼 경로를 탄 것이 전부 `동일`이어야 한다. 하나라도 `다름`이면 `_mask_fast_ok`를 좁혀 그 형태를 빼고 Step 4부터 다시. **fallback이 너무 많아 큰 레이어가 하나도 값싼 경로를 못 타면 Task 5의 중단 규칙으로 간다.**

- [ ] **Step 8: 커밋**

```bash
git add engine/psd_engine/render.py engine/tests/test_render.py
git commit -F - <<'EOF'
perf: read a masked layer without running the whole compositor for it

extract_rgba has always had two branches and they are not the same kind of
work. Without a mask it is topil(); with one it is
layer.composite(viewport=bbox), which is psd-tools' full float32 path.
Measured on one delivery plate, that costs ~4 Mpx/s against ~50 Mpx/s for
the unmasked branch, and two masked leaves out of 139 in a single group
accounted for 63% of the decode time and the entire 13.4 GB peak.

The cheap path ports Compositor.apply rather than approximating it: the
mask goes through the same paste() with background_color, the same density
term from mask.parameters, the same fill-opacity and opacity constants, and
the same reduction of _apply_source that an empty backdrop allows — which
is also why RGB comes out white where alpha is zero, since utils.divide
turns 0/0 into 1.0. Quantisation truncates and runs post_process, the same
finish _merge_rgba_fast already uses.

_mask_fast_ok is the point of the change, not the arithmetic. Effects,
strokes, fills, vector masks, pass-through, knockout and real masks all
fall back to composite, because a wrong picture is worse than a slow one.
export.py and verify.py share this function, so the contract is
byte-identical and export-baseline.py --compare is the gate.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltm3qkFkyb9oANqu3A2HRc
EOF
```

---

### Task 4: export 픽셀이 안 움직였음을 증명한다

**Files:** 없음 (검증만)

- [ ] **Step 1: Task 1의 기준선이 끝났는지 확인**

```bash
wc -l baseline/hh0306.jsonl
```

- [ ] **Step 2: 비교를 돌린다**

```bash
engine/.venv/bin/python scripts/export-baseline.py \
  "/Volumes/bgfinal/colordata/Hazbin_Hotel/HH03_시즌_자료/HH0306/Design/COLOR/BG/02_Color" \
  --compare baseline/hh0306.jsonl
```

Expected: 종료 코드 0, **다름 0**.

- [ ] **Step 3: 다르면**

`--compare`는 어긋난 항목과 필드를 이름으로 찍는다. 그 레이어를 Step 7의 스크립트로 단독 확인하고, 원인을 못 밝히면 `_mask_fast_ok`에서 그 형태를 뺀 뒤 Task 3 Step 4부터 다시 돈다. **"거의 같으니 넘어간다"는 없다.**

---

### Task 5: 중단 판정

- [ ] **Step 1: 이득이 실제로 있었는지 적는다**

Task 3 Step 7의 출력과 Task 4의 판정을 나란히 놓고 판단한다.

- 값싼 경로를 탄 큰 마스크 레이어가 있고 전부 `동일`, `--compare` 동일 → **커밋 1 유지.**
- 큰 레이어가 전부 fallback으로 떨어졌다 → **되돌린다.** 값싼 경로가 정작 비싼 레이어를 못 타면 유지비만 남는다. 설계 문서 §3.4가 이 규칙을 적어 두었고, 커밋 2는 이것 없이도 성립한다(378.8s → 31.1s).

- [ ] **Step 2: 되돌리기로 결정했다면, 두 가지를 남긴다**

`git revert 0fbbeef`처럼 통째로 되돌리면 안 된다. 손으로 지운다.

```bash
git revert --no-commit <커밋 1의 해시>
```

그리고 되돌린 diff에서 **다음 둘을 되살린다**:

- `_quantize_like_psd_tools` — **Task 8이 이 함수를 쓴다.** 마스크 경로와 무관하게 float32 → uint8 RGBA 변환을 psd-tools와 같은 순서로 하는 헬퍼이고, 축소 합성기의 마무리가 이것이다. 지우면 커밋 2가 컴파일되지 않는다.
- Task 2의 픽스처 커밋 — 별도 커밋이므로 손대지 않는다. 마스크 픽스처는 그 자체로 이득이다.

지우는 것은 `_mask_fast_ok`, `_extract_rgba_masked`, `extract_rgba`의 분기, 그리고 `test_masked_extract_is_byte_identical_to_composite` 넷이다.

```bash
cd engine && .venv/bin/python -m pytest -q      # 201 passed (200 + 픽스처 1) 여야 한다
git commit -F - <<'EOF'
Revert "perf: read a masked layer without running the whole compositor for it"

The guard ended up too narrow to pay: on the delivery data every masked
leaf large enough to matter fell back to composite anyway, so the cheap
path bought nothing and left a second mask implementation to keep in step
with psd-tools. _quantize_like_psd_tools is kept — the scaled compositor
uses it, and it is not part of the mask path.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltm3qkFkyb9oANqu3A2HRc
EOF
```

---

# 커밋 2 — `0fbbeef` revert + 축소 합성기

### Task 6: `0fbbeef`를 되돌린다

**Files:**
- Modify: `engine/psd_engine/render.py`, `engine/tests/test_render.py`

- [ ] **Step 1: revert**

```bash
git revert --no-commit 0fbbeef
git status --short
```

`_group_rgba_tiled`, `THUMBNAIL_TILE_PX`, `THUMBNAIL_TILE_SIZE`, 그리고 테스트 3개(`test_large_group_thumbnail_matches_the_single_composite`, `test_a_small_group_thumbnail_keeps_the_old_single_composite`, `test_a_large_group_tiles_even_when_merge_would_refuse_to`)와 `_count_tiled_calls`가 사라진다.

- [ ] **Step 2: 충돌이 있으면 손으로 푼다**

커밋 1이 `extract_rgba`를 바꿨으므로 `render.py`에서 충돌이 날 수 있다. **커밋 1의 변경을 살리고 `0fbbeef`의 것만 지운다.**

- [ ] **Step 3: 테스트를 돌린다**

```bash
cd engine && .venv/bin/python -m pytest -q
```

Expected: **202 passed** (205 - 썸네일 타일 테스트 3). 커밋 1을 되돌렸다면 198.

- [ ] **Step 4: 커밋하지 않는다**

이 revert는 Task 9의 교체와 **한 커밋**으로 묶는다. 되돌리기만 한 중간 상태를 남기면 그 커밋에서 큰 그룹이 다시 OOM으로 죽는다.

---

### Task 7: 잎 하나를 그룹 배율로 줄이는 헬퍼

**Files:**
- Modify: `engine/psd_engine/render.py`
- Test: `engine/tests/test_render.py`

**Interfaces:**
- Produces: `_scaled_leaf(layer, scale, origin) -> (rgba_float32, x0, y0) | None`. `rgba_float32`는 **프리멀티플라이드** RGBA float32 [0,1], `(x0, y0)`는 그룹 캔버스 안의 좌상단 좌표.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```python
def test_scaled_leaf_premultiplies_before_resizing(fixture_psd):
    """
    축소는 프리멀티플라이드 알파에서 해야 한다.

    스트레이트 알파로 R/G/B/A를 따로 줄이면 알파가 0인 자리에 남아 있는 색이
    가장자리로 번진다. 라인아트는 안티에일리어싱이 전부 알파에 들어 있어서 그
    번짐이 그대로 보인다 — apply_line_color의 주석이 같은 이유를 적고 있다.
    """
    s = _session(fixture_psd)
    leaf = s["layers_by_id"][4]          # 'line' value=50, 32x24, 알파 255
    out = render_mod._scaled_leaf(leaf, 0.25, (0, 0))
    assert out is not None
    rgba, x0, y0 = out
    assert rgba.dtype == np.float32
    assert rgba.shape == (6, 8, 4)
    assert (x0, y0) == (0, 0)
    # 알파가 전부 1이므로 프리멀티플라이드 색은 원본과 같다: 50/255
    assert np.allclose(rgba[..., 3], 1.0, atol=1e-3)
    assert np.allclose(rgba[..., :3], 50 / 255, atol=2e-3)
```

- [ ] **Step 2: 실행해서 실패를 본다**

```bash
cd engine && .venv/bin/python -m pytest tests/test_render.py -k scaled_leaf -v
```

Expected: FAIL — `_scaled_leaf` 없음.

- [ ] **Step 3: 구현한다**

```python
def _scaled_leaf(layer, scale, origin):
    """
    잎 하나를 그룹 배율로 줄여 프리멀티플라이드 float32 RGBA로 돌려준다.

    비싼 것은 여기다 — 실측에서 그룹 썸네일 시간의 89%가 이 디코딩이었다. 그래서
    잎마다 **한 번만** 디코딩하고 곧바로 줄인 뒤 전해상도 배열을 버린다. peak
    메모리가 가장 큰 잎 한 장에 묶이는 이유가 그것이다.

    프리멀티플라이드로 바꾼 뒤에 줄인다. 스트레이트 알파로 채널을 따로 줄이면
    알파 0인 자리의 색이 가장자리로 번진다.
    """
    if layer.width <= 0 or layer.height <= 0:
        return None
    rgba = extract_rgba(layer).astype(np.float32) / 255.0
    h, w = rgba.shape[:2]
    x0 = round((layer.left - origin[0]) * scale)
    y0 = round((layer.top - origin[1]) * scale)
    tw = max(1, round((layer.left - origin[0] + w) * scale) - x0)
    th = max(1, round((layer.top - origin[1] + h) * scale) - y0)

    alpha = rgba[..., 3:4]
    premul = np.concatenate((rgba[..., :3] * alpha, alpha), axis=2)
    if (tw, th) != (w, h):
        img = Image.fromarray((255 * premul).astype(np.uint8), "RGBA")
        img = img.resize((tw, th), Image.LANCZOS)
        premul = np.asarray(img).astype(np.float32) / 255.0
    return premul, x0, y0
```

- [ ] **Step 4: 실행해서 통과를 본다**

```bash
cd engine && .venv/bin/python -m pytest tests/test_render.py -k scaled_leaf -v
```

Expected: PASS.

- [ ] **Step 5: 커밋하지 않는다** — Task 9와 묶는다.

---

### Task 8: 축소 합성기

**Files:**
- Modify: `engine/psd_engine/render.py`
- Test: `engine/tests/test_render.py`

**Interfaces:**
- Consumes: `_scaled_leaf` (Task 7)
- Produces: `_group_rgba_scaled(psd, group, bbox, max_size) -> np.ndarray` (uint8 RGBA, 이미 축소된 크기)

- [ ] **Step 1: 블렌드가 평탄화되지 않는다는 실패 테스트를 쓴다**

```python
def test_scaled_group_reproduces_blend_modes(blend_mode_psd, tmp_path, monkeypatch):
    """
    축소 합성기는 평탄화가 아니다.

    실납품에서 8Mpx 넘는 그룹의 80%가 블렌드나 클리핑을 갖고 있고, 비용 상위
    30개 중 29개가 클리핑을 갖는다. 알파 오버로 겹쳐 버리면 정작 사람이 기다리는
    그룹의 그림이 전부 틀린다 — 이 테스트가 그 회귀를 잡는다.

    48px 캔버스 합성은 시간이 0에 가까우므로 이 충실도는 공짜다.
    """
    s = _session(blend_mode_psd)
    gid = next(lid for lid, l in s["layers_by_id"].items() if l.is_group())
    group = s["layers_by_id"][gid]

    exact_img = group.composite(force=True, color=1.0, alpha=0.0).convert("RGBA")
    exact_img.thumbnail((16, 16))
    exact_small = np.array(exact_img)

    scaled = render_mod._group_rgba_scaled(s["psd"], group, group.bbox, 16)

    assert scaled.shape == exact_small.shape
    diff = np.abs(scaled.astype(int) - exact_small.astype(int)).max()
    # 평탄화했다면 블렌드가 통째로 빠져 이보다 훨씬 크게 벌어진다.
    assert diff <= 24, f"블렌드가 재현되지 않았다 — 최대차 {diff}"
```

- [ ] **Step 2: 실행해서 실패를 본다**

```bash
cd engine && .venv/bin/python -m pytest tests/test_render.py -k scaled_group -v
```

Expected: FAIL — `_group_rgba_scaled` 없음.

- [ ] **Step 3: 구현한다**

```python
def _group_rgba_scaled(psd, group, bbox, max_size):
    """
    그룹을 **축소 해상도에서** 합성한다. 48px 그림 한 장에 그룹 bbox 전체를
    전해상도로 부풀리지 않는다.

    **왜 이 모양인가.** 실측(2026-08-05, HH0306 02_Color): 47.4Mpx / 잎 140장짜리
    그룹이 예전 경로로 378.8초, 잎을 각자 bbox에서 한 번씩 디코딩하는 데는 31.1초.
    그중 27.6초(89%)가 디코딩이다. **48px 캔버스 위의 합성은 시간이 0에 가깝다** —
    그래서 블렌드·불투명도·클리핑·중첩 그룹을 전부 재현해도 알파 오버와 속도가
    같다. 충실도는 여기서 공짜다.

    그리고 그것이 필요하다. 8Mpx 넘는 그룹 322개 중 평범한 것은 20%뿐이고, 비용
    상위 30개 중 29개가 클리핑을 갖는다. 평탄화했다면 사람이 기다리는 거의 모든
    그룹의 그림이 틀렸을 것이다.

    **재현하지 않는 것은 효과(그림자·글로우·획)뿐이다.** extract_rgba가 topil()로
    읽으므로 구조적으로 빠진다. 8Mpx 초과 그룹에서 261건. 의도된 손실이다.

    식은 Compositor._apply_source를 프리멀티플라이드 좌표로 옮긴 것이다. 클리핑
    레이어가 베이스의 **색만** 바꾸고 알파는 바꾸지 않는 것도 psd-tools와 같다
    (_apply_clip_layers가 하위 Compositor의 _color만 돌려준다).

    캔버스로 자르지 않는다. 캔버스 밖의 그림도 그 그룹의 내용이고 썸네일에 보이는
    것이 맞다.
    """
    from psd_tools.constants import Tag

    left, top, right, bottom = bbox
    scale = min(max_size / (right - left), max_size / (bottom - top), 1.0)
    pw = max(1, round((right - left) * scale))
    ph = max(1, round((bottom - top) * scale))

    def blank():
        return (np.ones((ph, pw, 3), dtype=np.float32),
                np.zeros((ph, pw, 1), dtype=np.float32))

    def draw(container):
        """container의 자손을 아래→위로 캔버스에 얹는다."""
        color, alpha_g = blank()
        for layer in container:                      # psd-tools는 아래→위로 준다
            if not layer.visible:
                continue
            if layer.clipping:
                continue                             # 베이스를 그릴 때 함께 처리한다
            if layer.is_group():
                sub_color, sub_alpha = draw(layer)
                src_color, src_alpha = sub_color, sub_alpha
            else:
                got = _scaled_leaf(layer, scale, (left, top))
                if got is None:
                    continue
                premul, x0, y0 = got
                src_color, src_alpha = blank()
                _place(src_color, src_alpha, premul, x0, y0)
            # 클리핑 레이어들은 베이스의 색만 바꾼다.
            for clip in layer.clip_layers:
                if not clip.visible:
                    continue
                got = _scaled_leaf(clip, scale, (left, top))
                if got is None:
                    continue
                c_premul, cx, cy = got
                c_color, c_alpha = blank()
                _place(c_color, c_alpha, c_premul, cx, cy)
                src_color = _over(src_color, src_alpha, c_color, c_alpha,
                                  clip.blend_mode)[0]
            # 그룹/레이어 자신의 불투명도. 마스크는 잎 쪽에서 extract_rgba가 이미
            # 걸었고, 그룹 마스크는 여기서 건다.
            k = (layer.opacity / 255.0) * (
                layer.tagged_blocks.get_data(Tag.BLEND_FILL_OPACITY, 255) / 255.0)
            if k != 1.0:
                src_alpha = src_alpha * k
            color, alpha_g = _over(color, alpha_g, src_color, src_alpha,
                                   layer.blend_mode)
        return color, alpha_g

    color, alpha_g = draw(group)
    merged = np.concatenate((color, alpha_g), axis=2)
    return _quantize_like_psd_tools(psd, merged)


def _place(color, alpha_g, premul, x0, y0):
    """프리멀티플라이드 타일을 캔버스 좌표에 놓는다. 넘치는 부분은 잘라낸다."""
    ph, pw = color.shape[:2]
    h, w = premul.shape[:2]
    sx0, sy0 = max(0, -x0), max(0, -y0)
    sx1 = w - max(0, x0 + w - pw)
    sy1 = h - max(0, y0 + h - ph)
    if sx1 <= sx0 or sy1 <= sy0:
        return
    tile = premul[sy0:sy1, sx0:sx1]
    dy, dx = y0 + sy0, x0 + sx0
    box = (slice(dy, dy + tile.shape[0]), slice(dx, dx + tile.shape[1]))
    a = tile[..., 3:4]
    # 프리멀티플라이드를 스트레이트 색으로 되돌려 놓는다 — 합성식이 스트레이트를
    # 받는다. 알파 0인 자리는 divide 규약대로 1.0(흰색)이 된다.
    with np.errstate(divide="ignore", invalid="ignore"):
        straight = np.true_divide(tile[..., :3], a)
    straight[~np.isfinite(straight)] = 1.0
    color[box] = np.clip(straight, 0.0, 1.0)
    alpha_g[box] = a


def _over(color_b, alpha_b, color_s, alpha_s, blend_mode):
    """
    _apply_source(410행)의 배경 있는 경우. shape == alpha 인 평범한 소스만 다룬다.

    대수적으로 줄이지 않는다 — 줄이면 float32에서 마지막 비트가 달라진다.
    """
    from psd_tools.composite import utils
    from psd_tools.composite.blend import BLEND_FUNC, normal

    alpha_new = utils.union(alpha_b, alpha_s)
    blend_fn = BLEND_FUNC.get(blend_mode, normal)
    color_t = (alpha_s - alpha_s) * alpha_b * color_b + alpha_s * (
        (1.0 - alpha_b) * color_s + alpha_b * blend_fn(color_b, color_s)
    )
    out = utils.clip(utils.divide(
        (1.0 - alpha_s) * alpha_b * color_b + color_t, alpha_new))
    return out, alpha_new
```

- [ ] **Step 4: 실행해서 통과를 본다**

```bash
cd engine && .venv/bin/python -m pytest tests/test_render.py -k scaled_group -v
```

Expected: PASS.

- [ ] **Step 5: 클리핑 테스트를 더한다**

`clip_layer_psd` 픽스처가 이미 있다.

```python
def test_scaled_group_reproduces_clipping(clip_layer_psd, tmp_path):
    """
    클리핑 레이어는 베이스의 **색만** 바꾸고 알파는 바꾸지 않는다 —
    _apply_clip_layers가 하위 Compositor의 _color만 돌려주기 때문이다.

    평탄화 구현은 클리핑 레이어를 베이스 밖에까지 그려서 알파가 넓어진다.
    그래서 알파를 비교하면 그 실수가 잡힌다.
    """
    s = _session(clip_layer_psd)
    gid = next(lid for lid, l in s["layers_by_id"].items() if l.is_group())
    group = s["layers_by_id"][gid]

    exact_img = group.composite(force=True, color=1.0, alpha=0.0).convert("RGBA")
    exact_img.thumbnail((16, 16))
    exact_small = np.array(exact_img)

    scaled = render_mod._group_rgba_scaled(s["psd"], group, group.bbox, 16)

    assert scaled.shape == exact_small.shape
    alpha_diff = np.abs(scaled[..., 3].astype(int) - exact_small[..., 3].astype(int)).max()
    assert alpha_diff <= 24, f"클리핑이 알파를 넓혔다 — 최대차 {alpha_diff}"
```

- [ ] **Step 6: 실행해서 통과를 본다**

```bash
cd engine && .venv/bin/python -m pytest tests/test_render.py -k "scaled_group" -v
```

Expected: 2 PASS. 실패하면 `draw`의 `layer.clipping` 건너뛰기와 `layer.clip_layers` 처리를 점검한다.

- [ ] **Step 7: 커밋하지 않는다** — Task 9와 묶는다.

---

### Task 9: 임계값과 배선, 그리고 오차 한계 측정

**Files:**
- Modify: `engine/psd_engine/render.py` (`render_thumbnails`, 새 상수)
- Modify: `docs/superpowers/specs/2026-08-05-group-thumbnail-scaled-compositor-design.md` (§4.1 클리핑 서술 정정)
- Test: `engine/tests/test_render.py`

- [ ] **Step 1: 예전 경로의 처리율을 잰다**

임계값 상수는 실측에서만 나온다. `bbox_area × leaves` 대비 시간을 여섯 점 잰다.

```bash
engine/.venv/bin/python - <<'PY'
import sys, time
sys.path.insert(0, "engine")
from psd_tools import PSDImage
from psd_engine import render
MP = 1024**2
D = "/Volumes/bgfinal/colordata/Hazbin_Hotel/HH03_시즌_자료/HH0306/Design/COLOR/BG/02_Color"
targets = [  # (파일, 그룹명) — 작은 것부터. 큰 것은 몇 분 걸린다.
    ("HH03_BG-HotelINTHallway012_CO_v02.psd", "Hallway"),
    ("HH03_BG-RosieEmporiumINTShop017_CO_v01.psd", "BG"),
]
for fname, gname in targets:
    psd = PSDImage.open(f"{D}/{fname}")
    g = next(x for x in psd.descendants() if x.is_group() and x.name == gname)
    leaves = [d for d in g.descendants() if d.visible and not d.is_group()]
    bbox = g.bbox
    area = (bbox[2]-bbox[0]) * (bbox[3]-bbox[1])
    session = {"psd": psd, "layers_by_id": {1: g}}
    import tempfile, pathlib
    t0 = time.perf_counter()
    render.render_thumbnails(session, [1], 48, pathlib.Path(tempfile.mkdtemp()))
    dt = time.perf_counter() - t0
    cost = area * len(leaves) / MP
    print(f"{gname:12} {area/MP:7.1f}Mpx x {len(leaves):4} = {cost:10.0f} Mpx·leaf  {dt:7.1f}s  "
          f"{cost/dt:8.1f} Mpx·leaf/s")
PY
```

- [ ] **Step 2: 상수를 정하고 쓴다**

**시간 예산은 5초다.** 이유: 썸네일은 화면에 보이는 행만, 청크로 만든다. 엔진은 stdin을 순서대로 처리하므로 썸네일 한 장이 도는 동안 사람이 누른 것이 전부 그 뒤에 선다. 5초는 이미 나쁘고, 그 위는 못 견딘다.

`THUMBNAIL_TILE_PX`가 있던 자리에 넣는다.

```python
#: 예전 경로(psd.composite 한 번)를 포기하고 축소 합성기로 넘어가는 지점.
#: 단위는 **Mpx·leaf** — 그룹 bbox 넓이 × 보이는 잎 수다.
#:
#: **넓이가 아니라 비용 모델인 이유.** 넓이는 시간을 예측하지 못한다 — 실측에서
#: 13.4Mpx가 29.4초인데 더 큰 38.3Mpx는 27.8초였다. 시간을 정하는 것은 잎의 수다.
#: 예전 경로는 잎마다 그룹 bbox 크기의 float32 버퍼를 훑으므로 비용이 넓이 × 잎
#: 수에 붙는다. 0fbbeef의 8Mpx는 메모리 예산에서 나온 값이라 성질이 다르다.
#:
#: 시간 예산 5초에서 역산한다. 썸네일은 보이는 행만 청크로 만들고 엔진은 stdin을
#: 순서대로 처리하므로, 썸네일 한 장이 도는 동안 사람이 누른 것이 전부 뒤에 선다.
#:
#: 실측 처리율(HH0306 02_Color, 2026-08-05): <Step 1의 Mpx·leaf/s를 적는다>
THUMBNAIL_EXACT_BUDGET = <Step 1에서 나온 처리율 × 5>   # Mpx·leaf
```

`<...>` 두 곳을 Step 1의 실제 출력으로 채운다. 채웠는지 기계로 확인한다:

```bash
grep -n "Step 1" engine/psd_engine/render.py && echo "채워넣기 자리가 남았다" && exit 1
grep -n "THUMBNAIL_EXACT_BUDGET = " engine/psd_engine/render.py
```

두 번째 grep이 숫자 하나를 보여야 한다.

- [ ] **Step 3: `render_thumbnails`를 배선한다**

`0fbbeef`가 있던 자리(`render.py:489~506`)를 바꾼다.

```python
            bbox = layer.bbox
            leaves = [d for d in layer.descendants()
                      if d.visible and not d.is_group()]
            cost = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) * len(leaves) \
                / (1024 * 1024)
            if cost > THUMBNAIL_EXACT_BUDGET:
                img = Image.fromarray(
                    _group_rgba_scaled(psd, layer, bbox, max_size), "RGBA")
            else:
                img = layer.composite(
                    force=True,
                    color=1.0,
                    alpha=0.0,
                    layer_filter=lambda l: id(l) in ancestors_and_self or id(l) in descendant_ids,
                )
```

`_group_rgba_scaled`는 이미 축소된 그림을 돌려주므로, 아래 `img.thumbnail((max_size, max_size))`는 그대로 두면 no-op이다 — 크기가 이미 맞다.

- [ ] **Step 4: 작은 그룹은 예전 경로를 그대로 탄다는 테스트**

```python
def test_a_cheap_group_keeps_the_exact_composite(fixture_psd, tmp_path, monkeypatch):
    """
    축소 합성기는 비싼 그룹만 위한 것이다. 잘 나오고 있는 썸네일은 결과만 같으면
    되는 것이 아니라 들르지도 말아야 한다 — 근사 경로가 조용히 기본이 되면
    바이트 동일이라는 성질을 잃고도 아무도 모른다.
    """
    calls = []
    real = render_mod._group_rgba_scaled
    monkeypatch.setattr(render_mod, "_group_rgba_scaled",
                        lambda *a, **k: calls.append(1) or real(*a, **k))
    s = _session(fixture_psd)
    gid = next(lid for lid, l in s["layers_by_id"].items() if l.is_group())

    render_thumbnails(s, [gid], max_size=16, out_dir=tmp_path)

    assert calls == [], "싼 그룹인데 축소 합성기로 갔다"


def test_an_expensive_group_uses_the_scaled_compositor(fixture_psd, tmp_path, monkeypatch):
    calls = []
    real = render_mod._group_rgba_scaled
    monkeypatch.setattr(render_mod, "_group_rgba_scaled",
                        lambda *a, **k: calls.append(1) or real(*a, **k))
    monkeypatch.setattr(render_mod, "THUMBNAIL_EXACT_BUDGET", 0)
    s = _session(fixture_psd)
    gid = next(lid for lid, l in s["layers_by_id"].items() if l.is_group())

    paths = render_thumbnails(s, [gid], max_size=16, out_dir=tmp_path)

    assert calls, "예산을 0으로 낮췄는데도 축소 합성기를 타지 않았다"
    assert Image.open(paths[str(gid)]).size[0] <= 16
```

- [ ] **Step 5: 엔진 전체를 돌린다**

```bash
cd engine && .venv/bin/python -m pytest -q
```

Expected: 커밋 1을 유지했다면 **207 passed** (200 - 타일 테스트 3 + Task 3의 4 + Task 2의 1 + Task 7의 1 + Task 8의 2 + Task 9의 2). 커밋 1을 되돌렸다면 203. 숫자가 안 맞으면 무엇이 빠졌는지 확인하고 넘어가지 않는다.

- [ ] **Step 6: 평범한 그룹의 오차 한계를 실납품 데이터에서 잰다 — 사전 선언된 막대로 판정**

```bash
engine/.venv/bin/python - <<'PY'
import sys, tempfile, pathlib
sys.path.insert(0, "engine")
import numpy as np
from PIL import Image
from psd_tools import PSDImage
from psd_engine import render

D = "/Volumes/bgfinal/colordata/Hazbin_Hotel/HH03_시즌_자료/HH0306/Design/COLOR/BG/02_Color"
import os
worst = 0
for fname in sorted(os.listdir(D)):
    if not fname.lower().endswith((".psd", ".psb")):
        continue
    psd = PSDImage.open(f"{D}/{fname}")
    for g in psd.descendants():
        if not g.is_group():
            continue
        leaves = [d for d in g.descendants() if d.visible and not d.is_group()]
        if not leaves or len(leaves) > 40:      # 정확 경로가 끝나야 비교가 된다
            continue
        # 평범한 그룹만: _plain이 그룹과 모든 자손에 대해 참
        if not all(render._plain(d, allow_passthrough=d.is_group())
                   for d in g.descendants()):
            continue
        if not render._plain(g, allow_passthrough=True):
            continue
        bbox = g.bbox
        if bbox[2] <= bbox[0] or bbox[3] <= bbox[1]:
            continue
        exact = g.composite(force=True, color=1.0, alpha=0.0).convert("RGBA")
        exact.thumbnail((48, 48))
        a = np.array(exact)
        b = render._group_rgba_scaled(psd, g, bbox, 48)
        if a.shape != b.shape:
            print(f"  SHAPE {fname} {g.name!r} {a.shape} vs {b.shape}")
            continue
        vis = (a[..., 3] > 0) | (b[..., 3] > 0)
        d = np.abs(a.astype(int) - b.astype(int))
        m = max(d[..., 3].max(), d[..., :3][vis].max() if vis.any() else 0)
        worst = max(worst, m)
        if m > 4:
            print(f"  {m:3d}  {g.name[:24]!r} {fname[:40]}")
print(f"\n평범한 그룹 최대 성분차: {worst}")
PY
```

**사전 선언된 판정** (설계 문서 §4.3):

- `≤ 4` → 통과. 다음 스텝으로.
- `5 ~ 24` → **원인을 밝혀야 통과한다.** 가장 먼저 볼 곳: `_scaled_leaf`의 LANCZOS는 프리멀티플라이드에서 줄이는데 예전 경로는 합성이 끝난 그림(알파 0인 자리가 흰색)을 줄이므로, 가장자리에 흰색이 번지는 정도가 다르다. 원인을 밝히지 못하면 정지하고 사용자에게 보고한다.
- `> 24` → **정지.** 설계 재검토다. 숫자를 올리지 않는다.

- [ ] **Step 7: 실납품 그룹에서 속도를 확인한다**

```bash
engine/.venv/bin/python - <<'PY'
import sys, time, tempfile, pathlib
sys.path.insert(0, "engine")
from psd_tools import PSDImage
from psd_engine import render
D = "/Volumes/bgfinal/colordata/Hazbin_Hotel/HH03_시즌_자료/HH0306/Design/COLOR/BG/02_Color"
psd = PSDImage.open(f"{D}/HH03_BG-RosieEmporiumINTShop017_CO_v01.psd")
g = next(x for x in psd.descendants() if x.is_group() and x.name == "BG")
t0 = time.perf_counter()
render.render_thumbnails({"psd": psd, "layers_by_id": {1: g}}, [1], 48,
                         pathlib.Path(tempfile.mkdtemp()))
print(f"{time.perf_counter()-t0:.1f}s   (기준: 예전 경로 378.8s)")
PY
```

Expected: 30초 안쪽. 커밋 1을 유지했다면 20초 안쪽. 훨씬 느리면 `_scaled_leaf`가 잎을 두 번 이상 디코딩하고 있는지 본다.

- [ ] **Step 8: 설계 문서의 클리핑 서술을 고친다**

`§4.1`의 다음 줄을 바꾼다.

```
- **클리핑** — `clipping=True`인 잎들은 바로 아래 베이스의 알파로 제한한다. psd-tools의
  `_apply_clip_layers`가 하는 일을 축소 해상도에서 한다.
```

→

```
- **클리핑** — `clipping=True`인 잎은 베이스의 **색만** 바꾸고 알파는 바꾸지 않는다.
  psd-tools의 `_apply_clip_layers`가 하위 Compositor의 `_color`만 돌려주기 때문이다.
  설계 당시에는 "베이스의 알파로 제한"이라고 적었는데, 소스를 읽어 보니 그것이
  아니었다.
```

- [ ] **Step 9: 커밋 (revert + 교체를 한 커밋으로)**

```bash
git add -A
git commit -F - <<'EOF'
perf: build a group thumbnail at thumbnail resolution, not at full resolution

0fbbeef bounded the memory a group thumbnail costs and said in its own
message that it did not bound the time: the worst group went from dying at
24.1 GB to finishing at 9.42 GB, but it took 39.6 minutes to produce a
48x20 image. This reverts it and replaces it, which is why it was a
separate commit.

Leaves are now decoded once at their own bbox, downsampled immediately and
composited on a 48 px canvas, so peak memory is one leaf rather than the
group. Measured on a 47.4 Mpx / 140-leaf delivery group: 378.8 s before,
and 27.6 s of the replacement's 31.1 s is the decode itself.

The compositing is not a flattening. Of the 322 groups over 8 Mpx in
HH0306/02_Color only 20% are plain, and 29 of the 30 most expensive groups
carry clipping — alpha-over would have produced a wrong picture for almost
every group anyone waits on. Since a 48 px canvas costs nothing to
composite, blend modes, opacity, clipping and nested groups are reproduced
at the same speed alpha-over would have run at. Only effects are dropped,
because extract_rgba reads through topil().

The threshold is a cost model (bbox area x leaf count) rather than an area,
because area does not predict time — a 13.4 Mpx group outran a 38.3 Mpx one
— and it is derived from a 5 s budget, since the engine serves stdin in
order and everything a person clicks queues behind one thumbnail.

The equivalence bound was declared before the code, not after: on plain
groups the 48 px thumbnail must be within 4 of the exact path, 5-24 needs
its cause explained, and above 24 stops the design.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Ltm3qkFkyb9oANqu3A2HRc
EOF
```

---

### Task 10: 마무리 확인

- [ ] **Step 1: 세 스위트를 전부 돌린다**

```bash
cd engine && .venv/bin/python -m pytest -q
cd .. && npm test 2>&1 | tail -5
cd src-tauri && cargo test 2>&1 | tail -5
```

Expected: 엔진 207 (또는 203), 프런트 372, Rust 16.

- [ ] **Step 2: export 픽셀이 안 움직였는지 다시 본다**

커밋 2는 `render_thumbnails`만 건드리므로 export에 닿지 않지만, 커밋 1이 이 브랜치에 있으므로 최종 상태에서 한 번 더 돌린다.

```bash
engine/.venv/bin/python scripts/export-baseline.py \
  "/Volumes/bgfinal/colordata/Hazbin_Hotel/HH03_시즌_자료/HH0306/Design/COLOR/BG/02_Color" \
  --compare baseline/hh0306.jsonl
```

Expected: 다름 0.

- [ ] **Step 3: 사용자에게 보고한다**

다음을 숫자로 적어 보고한다: 실납품 그룹의 전/후 시간, 평범한 그룹의 최대 성분차와 그것이 어느 막대에 들었는지, `--compare` 판정, 세 스위트의 수, 그리고 커밋 1을 유지했는지 되돌렸는지.

푸시는 사용자가 한다 — `! git push origin feat/line-layer-matching`을 제안만 한다.
