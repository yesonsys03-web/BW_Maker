# jpg/png 출력 포맷 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 내보내기에 PNG(투명 배경)와 JPG(흰 배경) 출력 포맷을 더한다. 기본값은 지금과 같은 "원본 따름"이다.

**Architecture:** 래스터 쓰기는 새 `engine/psd_engine/raster.py`에 담고 `rpc.py`/`batch.py`가 포맷으로 분기한다. `export.py`의 PSD 쓰기 경로와 `verify.py`는 건드리지 않는다 — 이 브랜치가 산 성능과 픽셀 동일성이 전부 거기 있다. 공유하는 것은 `entry_pixels` 하나뿐이다.

**Tech Stack:** Python 3.12 · numpy · Pillow · psd-tools(읽기) · pytoshop(PSD 쓰기) · pytest — React 19 · TypeScript · Vitest · Tauri 2

## Global Constraints

- 설계 문서는 `docs/superpowers/specs/2026-08-06-jpg-png-export-design.md`. 충돌하면 설계 문서가 우선이다.
- **`engine/psd_engine/export.py`의 `export_psd`/`export_psd_split`/`_output_version` 본문과 `engine/psd_engine/verify.py`는 수정하지 않는다.** 예외는 Task 1(`output_extension`에 인자 추가)과 Task 4(`entry_pixels` 개명 + 경로 헬퍼 호출)뿐이며, 둘 다 명시된 줄만 건드린다.
- `OutputFormat`의 값은 정확히 `"psd" | "png" | "jpg"`. `"psd"`는 "원본 따름"이라는 뜻이고 `.psd`/`.psb`를 원본에서 물려받는다.
- 프리셋의 `outputFormat`은 **선택적 필드**다. 없으면 `"psd"`. 사용자의 기존 `presets.json`에 이 필드가 없으므로 필수로 만들면 저장된 프리셋이 전부 죽는다.
- JPG는 항상 `quality=95, subsampling=0`.
- 엔진 테스트: `cd engine && uv run pytest`. 프런트: `npm test`. 타입: `npx tsc --noEmit`.
- 기존 테스트 수는 engine 213 / JS 374에서 **줄어들면 안 된다.**
- 커밋 메시지는 저장소 관례를 따른다 — 영어, 소문자 conventional prefix, 본문에 *왜*를 적는다.

**기존 테스트 자산 (실제 이름 — 새로 짓지 말 것):**

| 이름 | 위치 | 정체 |
|---|---|---|
| `fixture_psd` | `engine/tests/conftest.py:84` | 기본 PSD 픽스처 |
| `wide_psb`, `off_canvas_psd` | `conftest.py:223, 247` | 특수 픽스처 |
| `session` | `test_export.py:14` | `SessionStore`로 연 세션 — **로컬 픽스처** |
| `_plan(session, included, operations)` | `test_export.py:32` | 엔트리 생성 헬퍼 |
| `_ids(session, *names)` | `test_export.py:37` | 이름 → 레이어 id |
| `PRESET` | `test_batch.py:7` | 모듈 상수 dict, 픽스처 아님 |
| `EngineProc` | `test_rpc.py:10` | 엔진 서브프로세스, `.call(method, **params)` |

`fixture_psd`의 레이어 id는 `3, 4, 5`가 픽셀 레이어이고 이름은 `hidden line`/`line`/`lines`다
(`test_export.py:42-57` 참고). 엔트리 둘 이상이 필요하면 `_plan(session, [3, 4, 5], [])`.

---

### Task 1: 엔진의 확장자 규칙에 포맷 축 추가

**Files:**
- Modify: `engine/psd_engine/export.py:106-116` (`output_extension`)
- Test: `engine/tests/test_export.py:319-339`

**Interfaces:**
- Produces: `output_extension(src_path, fmt="psd") -> str` — `".png"`, `".jpg"`, `".psb"`, `".psd"` 중 하나.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`engine/tests/test_export.py`의 기존 파라미터 표 아래에 더한다:

```python
@pytest.mark.parametrize("src,fmt,expected", [
    ("a.psd", "png", ".png"),
    ("a.psb", "png", ".png"),
    ("a.PSD", "jpg", ".jpg"),
    ("a.tiff", "jpg", ".jpg"),
    ("no_extension", "png", ".png"),
    ("a.psd", "psd", ".psd"),
    ("a.psb", "psd", ".psb"),
    ("a.PSB", "psd", ".psb"),
])
def test_output_extension_takes_an_explicit_format(src, fmt, expected):
    assert output_extension(src, fmt) == expected


def test_output_extension_defaults_to_following_the_source():
    # 인자를 안 주면 지금까지의 동작 그대로여야 한다. 기존 호출부가 전부 이 경로다.
    assert output_extension("a.psb") == ".psb"
    assert output_extension("a.psd") == ".psd"
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd engine && uv run pytest tests/test_export.py -k output_extension -v`
Expected: FAIL — `TypeError: output_extension() takes 1 positional argument but 2 were given`

- [ ] **Step 3: 최소 구현**

`engine/psd_engine/export.py`의 `output_extension`을 바꾼다. 독스트링의 "프런트엔드와 글자 그대로 같아야 한다"는 문장은 **유지한다** — 그게 이 함수의 존재 이유다.

```python
def output_extension(src_path, fmt="psd"):
    """
    산출물 확장자. `fmt`가 "png"/"jpg"면 그 확장자가 곧 답이고, "psd"는 "원본
    따름"이라는 뜻이라 원본에서 .psd/.psb를 물려받는다.

    프런트엔드 `src/lib/exportFlow.ts`의 `outputExtension`과 글자 그대로 같은
    규칙이어야 한다. 그쪽이 계산한 경로는 덮어쓰기 사전 검사와 UI에 쓰이고 실제로
    파일이 나가는 경로는 이쪽이라, 둘이 갈라지면 검사한 적 없는 경로에 파일을
    쓰게 된다.

    `Path.suffix`는 대소문자를 보존하므로 명시적으로 낮춘다 — `FOO.PSB`는 `FOO….psb`다.
    """
    if fmt == "png":
        return ".png"
    if fmt == "jpg":
        return ".jpg"
    return ".psb" if Path(src_path).suffix.lower() == ".psb" else ".psd"
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd engine && uv run pytest tests/test_export.py -v`
Expected: PASS — 기존 확장자 테스트도 전부 그대로 통과해야 한다(기본 인자 덕분).

- [ ] **Step 5: 커밋**

```bash
git add engine/psd_engine/export.py engine/tests/test_export.py
git commit -m "feat: let output_extension take an explicit format

The rule stays 'follow the source' when no format is given, so every
existing caller keeps its behaviour. png/jpg simply answer themselves."
```

---

### Task 2: 프런트엔드의 확장자 규칙에 포맷 축 추가

**Files:**
- Modify: `src/lib/exportFlow.ts:9-31`
- Modify: `src/lib/batch.ts:31-43`
- Modify: `src/lib/types.ts` (`OutputFormat` 타입 추가)
- Test: `src/lib/exportFlow.test.ts`, `src/lib/batch.test.ts`

**Interfaces:**
- Consumes: 없음 (Task 1과 독립이지만 **같은 규칙**을 구현한다)
- Produces:
  - `type OutputFormat = "psd" | "png" | "jpg"` (`src/lib/types.ts`)
  - `outputExtension(srcPath: string, fmt?: OutputFormat) -> "psd" | "psb" | "png" | "jpg"`
  - `defaultExportPath(srcPath: string, suffix: string, fmt?: OutputFormat) -> string`
  - `planBatchOutputs(paths: string[], outputDir: string | null, suffix: string, fmt?: OutputFormat) -> PlannedBatchOutput[]`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/lib/exportFlow.test.ts`에 더한다:

```ts
it("takes an explicit format over the source extension", () => {
  expect(outputExtension("a.psd", "png")).toBe("png");
  expect(outputExtension("a.psb", "png")).toBe("png");
  expect(outputExtension("a.PSD", "jpg")).toBe("jpg");
  expect(outputExtension("no_extension", "jpg")).toBe("jpg");
});

it("follows the source when no format is given", () => {
  expect(outputExtension("a.psb")).toBe("psb");
  expect(outputExtension("a.psd")).toBe("psd");
  expect(outputExtension("a.psd", "psd")).toBe("psd");
  expect(outputExtension("a.psb", "psd")).toBe("psb");
});

it("builds a default path with the chosen format", () => {
  expect(defaultExportPath("/x/y/a.psb", "_LINE", "png")).toBe("/x/y/a_LINE.png");
  expect(defaultExportPath("C:\\x\\a.psd", "_LINE", "jpg")).toBe("C:\\x\\a_LINE.jpg");
});
```

`src/lib/batch.test.ts`에 더한다:

```ts
it("plans batch outputs with the chosen format", () => {
  expect(planBatchOutputs(["/x/a.psb"], null, "_LINE", "png")).toEqual([
    { path: "/x/a.psb", outputPath: "/x/a_LINE.png" },
  ]);
  expect(planBatchOutputs(["/x/a.psd"], "/out", "_LINE", "jpg")).toEqual([
    { path: "/x/a.psd", outputPath: "/out/a_LINE.jpg" },
  ]);
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npm test -- exportFlow batch`
Expected: FAIL — `expected 'psd' to be 'png'`

- [ ] **Step 3: 최소 구현**

`src/lib/types.ts`에 더한다:

```ts
/** 내보내기 출력 포맷. "psd"는 "원본 따름"이라 .psd/.psb를 원본에서 물려받는다. */
export type OutputFormat = "psd" | "png" | "jpg";
```

`src/lib/exportFlow.ts`:

```ts
import type { OutputFormat, TreeNode } from "./types";

/**
 * Output extension for a source path. An explicit "png"/"jpg" answers
 * itself; "psd" means "follow the source" and preserves ".psd"/".psb"
 * (case-insensitively, normalized to lowercase), falling back to ".psd"
 * for an unrelated or absent extension.
 *
 * engine/psd_engine/export.py의 output_extension과 글자 그대로 같아야 한다.
 */
export function outputExtension(
  srcPath: string,
  fmt: OutputFormat = "psd"
): "psd" | "psb" | "png" | "jpg" {
  if (fmt === "png") return "png";
  if (fmt === "jpg") return "jpg";
  const lastSlash = Math.max(srcPath.lastIndexOf("/"), srcPath.lastIndexOf("\\"));
  const fileName = lastSlash === -1 ? srcPath : srcPath.slice(lastSlash + 1);
  const dotIdx = fileName.lastIndexOf(".");
  if (dotIdx <= 0) return "psd";
  const ext = fileName.slice(dotIdx + 1).toLowerCase();
  return ext === "psb" ? "psb" : "psd";
}
```

`defaultExportPath`의 시그니처와 마지막 줄만 바꾼다:

```ts
export function defaultExportPath(
  srcPath: string,
  suffix: string,
  fmt: OutputFormat = "psd"
): string {
  const lastSlash = Math.max(srcPath.lastIndexOf("/"), srcPath.lastIndexOf("\\"));
  const dir = lastSlash === -1 ? "" : srcPath.slice(0, lastSlash + 1);
  const fileName = lastSlash === -1 ? srcPath : srcPath.slice(lastSlash + 1);
  const dotIdx = fileName.lastIndexOf(".");
  const stem = dotIdx <= 0 ? fileName : fileName.slice(0, dotIdx);
  return `${dir}${stem}${suffix}.${outputExtension(srcPath, fmt)}`;
}
```

`src/lib/batch.ts`:

```ts
import { defaultExportPath, outputExtension } from "./exportFlow";
import type { OutputFormat } from "./types";

export function planBatchOutputs(
  paths: string[],
  outputDir: string | null,
  suffix: string,
  fmt: OutputFormat = "psd"
): PlannedBatchOutput[] {
  return paths.map((path) => {
    const outputPath =
      outputDir === null
        ? defaultExportPath(path, suffix, fmt)
        : joinDir(outputDir, `${stemOf(baseName(path))}${suffix}.${outputExtension(path, fmt)}`);
    return { path, outputPath };
  });
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `npm test -- exportFlow batch && npx tsc --noEmit`
Expected: PASS, 타입 오류 없음

- [ ] **Step 5: 커밋**

```bash
git add src/lib/exportFlow.ts src/lib/batch.ts src/lib/types.ts \
        src/lib/exportFlow.test.ts src/lib/batch.test.ts
git commit -m "feat: let the frontend extension rule take a format

Mirrors engine/psd_engine/export.py output_extension exactly. The default
argument keeps every existing caller on the follow-the-source rule."
```

---

### Task 3: 경로 헬퍼 — 윈도우 긴 경로와 쓰기 가능성 검사

**Files:**
- Create: `engine/psd_engine/paths.py`
- Test: `engine/tests/test_paths.py`

**Interfaces:**
- Produces:
  - `long_path(path) -> str` — 윈도우에서 `\\?\` 접두사를 붙인 절대경로, 그 외 플랫폼은 `str(path)`
  - `ensure_writable_path(path) -> None` — 못 쓰는 경로면 `ValueError`
  - `MAX_COMPONENT = 255`, `WINDOWS_MAX_EXTENDED_PATH = 32767`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`engine/tests/test_paths.py`를 새로 만든다:

```python
import os

import pytest

from psd_engine.paths import (MAX_COMPONENT, ensure_writable_path, long_path)


def test_long_path_is_a_no_op_off_windows():
    if os.name == "nt":
        pytest.skip("윈도우에서는 접두사가 붙는 것이 정상")
    assert long_path("/tmp/a.psd") == "/tmp/a.psd"


@pytest.mark.skipif(os.name != "nt", reason="윈도우 전용 접두사")
def test_long_path_prefixes_an_absolute_windows_path():
    assert long_path("C:\\x\\a.psd") == "\\\\?\\C:\\x\\a.psd"


@pytest.mark.skipif(os.name != "nt", reason="윈도우 전용 접두사")
def test_long_path_does_not_double_prefix():
    once = long_path("C:\\x\\a.psd")
    assert long_path(once) == once


def test_ensure_writable_path_accepts_an_ordinary_path(tmp_path):
    ensure_writable_path(tmp_path / "배경 라인_LINE.psd")


def test_ensure_writable_path_rejects_an_overlong_filename(tmp_path):
    # 긴 한글 레이어 이름이 stem에 덧붙는 경우가 실제로 여기에 먼저 닿는다.
    name = "가" * (MAX_COMPONENT + 1) + ".png"
    with pytest.raises(ValueError) as e:
        ensure_writable_path(tmp_path / name)
    assert str(MAX_COMPONENT) in str(e.value)
    assert "파일 이름" in str(e.value)
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd engine && uv run pytest tests/test_paths.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'psd_engine.paths'`

- [ ] **Step 3: 최소 구현**

`engine/psd_engine/paths.py`를 새로 만든다:

```python
"""출력 경로의 길이 한계. 윈도우의 MAX_PATH를 걷어내고, 남는 한계는 미리 막는다."""
import os

#: 파일 이름 한 조각의 한계. 윈도우·macOS·리눅스 공통이고, `\\?\` 접두사로도
#: 풀리지 않는다. 긴 한글 레이어 이름이 stem에 덧붙는 분할 내보내기가 실제로
#: 먼저 닿는 한계가 이것이다.
MAX_COMPONENT = 255

#: `\\?\` 접두사를 붙인 뒤의 윈도우 전체 경로 한계.
WINDOWS_MAX_EXTENDED_PATH = 32767


def long_path(path):
    """
    윈도우의 260자 MAX_PATH를 걷어낸 경로. 파일을 실제로 여는 자리에서만 쓴다.

    `\\\\?\\`는 경로 파싱을 통째로 건너뛰므로 절대경로여야 하고 구분자가 전부
    역슬래시여야 한다 — `/`나 `..`가 남아 있으면 실패한다. `os.path.abspath`가
    윈도우에서 둘 다 해준다.

    **반환값·진행 이벤트·에러 메시지에 담기는 경로에는 쓰지 않는다.** 그 문자열은
    UI에 그대로 보이고 프런트의 덮어쓰기 검사와도 대조되므로, 접두사가 새어
    나가면 사용자에게 `\\\\?\\C:\\...`가 보이고 두 경로가 갈라진다.
    """
    text = str(path)
    if os.name != "nt":
        return text
    if text.startswith("\\\\?\\"):
        return text
    full = os.path.abspath(text)
    if full.startswith("\\\\"):          # UNC: \\server\share → \\?\UNC\server\share
        return "\\\\?\\UNC\\" + full[2:]
    return "\\\\?\\" + full


def ensure_writable_path(path):
    """
    쓰기 전에 경로가 파일 시스템 한계를 넘지 않는지 본다. 넘으면 무엇을 줄여야
    하는지 담은 ValueError를 낸다.

    `long_path`가 윈도우의 260자를 걷어내므로 여기서 볼 것은 그것이 아니라,
    접두사로도 풀리지 않는 두 가지다.
    """
    text = str(path)
    name = os.path.basename(text)
    if len(name) > MAX_COMPONENT:
        raise ValueError(
            f"파일 이름이 너무 깁니다 ({len(name)}자, 한계 {MAX_COMPONENT}자): {name}\n"
            "출력 파일명 접미사를 줄이거나, 레이어마다 파일 따로 내보내기를 끄십시오."
        )
    if os.name == "nt":
        full = os.path.abspath(text)
        if len(full) > WINDOWS_MAX_EXTENDED_PATH:
            raise ValueError(
                f"경로가 너무 깁니다 ({len(full)}자, 한계 "
                f"{WINDOWS_MAX_EXTENDED_PATH}자): {text}\n"
                "더 짧은 출력 폴더를 고르십시오."
            )
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd engine && uv run pytest tests/test_paths.py -v`
Expected: PASS (윈도우 전용 두 건은 macOS에서 skip)

- [ ] **Step 5: 커밋**

```bash
git add engine/psd_engine/paths.py engine/tests/test_paths.py
git commit -m "feat: lift the windows MAX_PATH and guard what it cannot lift

The \\\\?\\ prefix removes the 260-char limit but not the 255-char limit on
a single filename, and that shorter one is what a long Korean layer name
appended by split export actually reaches first. The prefix is applied only
where a file is opened, never in a path that reaches the UI."
```

---

### Task 4: 기존 PSD 경로에 헬퍼를 물린다

**Files:**
- Modify: `engine/psd_engine/export.py:38` (`_entry_pixels` → `entry_pixels`), `:62-63`, `:99`, `:148-151`
- Modify: `engine/psd_engine/batch.py:27` 뒤
- Test: `engine/tests/test_export.py`

**Interfaces:**
- Consumes: `long_path`, `ensure_writable_path` (Task 3)
- Produces: `entry_pixels(session, entry, line_rgb=None) -> (rgba, left, top)` — Task 5가 쓴다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`engine/tests/test_export.py`에 더한다:

```python
def test_export_refuses_an_overlong_filename(session, tmp_path):
    entries = _plan(session, [3, 4, 5], [])
    out = tmp_path / ("가" * 300 + ".psd")
    with pytest.raises(ValueError, match="파일 이름이 너무 깁니다"):
        export_psd(session, entries, out)
    assert not out.exists()


def test_split_export_checks_every_name_before_writing_any(session, tmp_path):
    # 세 엔트리 중 하나만 이름이 길어도 한 장도 나가면 안 된다.
    entries = _plan(session, [3, 4, 5], [])
    entries[1]["finalName"] = "나" * 300
    out = tmp_path / "X_LINE.psd"
    with pytest.raises(ValueError, match="파일 이름이 너무 깁니다"):
        export_psd_split(session, entries, out)
    assert list(tmp_path.iterdir()) == []
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd engine && uv run pytest tests/test_export.py -k overlong -v`
Expected: FAIL — `ValueError`가 아니라 `OSError: File name too long`이 나거나, 분할에서는 첫 파일이 이미 쓰인 뒤 실패한다.

- [ ] **Step 3: 최소 구현**

`engine/psd_engine/export.py` 상단 import에 더한다:

```python
from .paths import ensure_writable_path, long_path
```

`_entry_pixels`를 `entry_pixels`로 개명한다(정의 `:38`과 호출 `:73`, 두 곳뿐이다).

`export_psd`의 존재 검사(`:62-63`)를 바꾼다:

```python
    output_path = str(output_path)
    ensure_writable_path(output_path)
    if os.path.exists(long_path(output_path)) and not overwrite:
        raise FileExistsError(f"output already exists: {output_path}")
```

쓰기(`:99`)를 바꾼다:

```python
    with open(long_path(output_path), "wb") as f:
```

`export_psd_split`의 사전 검사(`:148-151`)를 바꾼다 — **길이 검사를 존재 검사보다 먼저** 돌린다:

```python
    targets = [(e, split_output_path(output_path, e["finalName"])) for e in entries]
    for _, p in targets:
        ensure_writable_path(p)
    if not overwrite:
        existing = [p for _, p in targets if os.path.exists(long_path(p))]
        if existing:
            raise FileExistsError("output already exists: " + ", ".join(existing))
```

`engine/psd_engine/batch.py`의 `out_path` 계산(`:27`) 바로 뒤에 더한다:

```python
        from .paths import ensure_writable_path
        ensure_writable_path(out_path)
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd engine && uv run pytest -q`
Expected: PASS — 213건 이상, 줄어들면 안 된다.

- [ ] **Step 5: 커밋**

```bash
git add engine/psd_engine/export.py engine/psd_engine/batch.py engine/tests/test_export.py
git commit -m "feat: check path length before writing, and open through \\\\?\\

Split export already checked every target for existence before writing any
file, so the length check belongs in the same pass — otherwise a name that
is too long stops the run halfway with files already on disk.

_entry_pixels becomes entry_pixels; raster export needs it and it has only
ever had two callers, both in this file."
```

---

### Task 5: `raster.py` — 평탄화와 저장 (검은 이미지 함정)

**Files:**
- Create: `engine/psd_engine/raster.py`
- Test: `engine/tests/test_raster.py`

**Interfaces:**
- Consumes: `entry_pixels` (Task 4), `ensure_writable_path`/`long_path` (Task 3), `parse_line_color` (`render.py`)
- Produces:
  - `flatten_entries(session, entries, line_rgb, progress=None) -> np.ndarray` (문서 크기 RGBA uint8)
  - `export_raster(session, entries, output_path, fmt, overwrite=False, progress=None, line_color=None) -> {"outputPath": str, "layerCount": int}`
  - `JPEG_MAX_DIMENSION = 65535`, `JPEG_QUALITY = 95`

- [ ] **Step 0: 공용 픽스처를 conftest로 옮긴다**

`session` 픽스처와 `_plan`/`_ids` 헬퍼는 지금 `test_export.py:14-39`에 로컬로 있다.
`test_raster.py`도 같은 것을 쓰므로 셋을 `engine/tests/conftest.py`로 옮기고
`test_export.py`에서는 정의를 지운다(`_plan`/`_ids`는 밑줄로 시작해도 conftest에 두면
import 없이 쓸 수 없으므로, conftest에 두되 `test_export.py`/`test_raster.py` 양쪽에서
`from .conftest import _plan, _ids`가 아니라 **픽스처로 바꾼다**):

```python
# engine/tests/conftest.py 에 더한다
@pytest.fixture
def session(fixture_psd):
    from psd_engine.session import SessionStore
    store = SessionStore()
    return store.get(store.open(fixture_psd))


@pytest.fixture
def plan(session):
    """included id 목록과 operations로 엔트리를 만든다."""
    from psd_engine.ops import build_export_plan, finalize_names

    def make(included, operations=()):
        entries = build_export_plan(included, list(operations))
        return finalize_names(entries, session["nodes_by_id"], "pathPrefix")

    return make
```

`test_export.py`의 기존 `session` 픽스처 정의(`:14-17`)를 지우고, `_plan`/`_ids`는 그대로
둔다 — 그 파일 안에서만 쓰는 헬퍼이고 conftest의 `plan` 픽스처와 공존해도 무해하다.

Run: `cd engine && uv run pytest -q`
Expected: 213건 그대로 통과 (픽스처 위치만 바뀌었다)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`engine/tests/test_raster.py`를 새로 만든다. **첫 번째가 이 작업의 핵심 회귀 테스트다.**

```python
import numpy as np
import pytest
from PIL import Image

from psd_engine.raster import export_raster


def test_jpg_with_line_color_is_not_a_solid_block(session, plan, tmp_path):
    """
    apply_line_color는 알파 0인 픽셀의 RGB까지 라인 색으로 채운다(의도적).
    그 배열의 알파를 그냥 버리면 전면이 단색인 이미지가 나온다 — 기본 라인 색이
    #000000이므로 새까만 사각형이다. 흰 캔버스에 합성한 뒤 RGB로 바꿔야 한다.
    """
    entries = plan([3, 4, 5])
    out = tmp_path / "a.jpg"
    export_raster(session, entries, out, "jpg", line_color="#000000")
    arr = np.array(Image.open(out).convert("RGB"))
    assert len(np.unique(arr.reshape(-1, 3), axis=0)) > 1, "단색 이미지가 나왔다"
    # 라인이 없는 자리는 흰 배경이어야 한다.
    assert arr.max() > 200


def test_png_keeps_a_transparent_background(session, plan, tmp_path):
    entries = plan([3, 4, 5])
    out = tmp_path / "a.png"
    export_raster(session, entries, out, "png", line_color="#000000")
    img = Image.open(out)
    assert img.mode == "RGBA"
    alpha = np.array(img)[..., 3]
    assert alpha.min() == 0, "투명한 자리가 없다"


def test_jpg_is_opaque(session, plan, tmp_path):
    out = tmp_path / "a.jpg"
    export_raster(session, plan([3, 4, 5]), out, "jpg")
    assert Image.open(out).mode == "RGB"


def test_raster_canvas_is_the_document_size(session, plan, tmp_path):
    out = tmp_path / "a.png"
    export_raster(session, plan([3, 4, 5]), out, "png")
    assert Image.open(out).size == (session["psd"].width, session["psd"].height)


def test_raster_refuses_to_overwrite(session, plan, tmp_path):
    out = tmp_path / "a.png"
    out.write_bytes(b"")
    with pytest.raises(FileExistsError):
        export_raster(session, plan([3, 4, 5]), out, "png")


def test_raster_rejects_a_bad_line_color_before_writing(session, plan, tmp_path):
    out = tmp_path / "a.png"
    with pytest.raises(ValueError):
        export_raster(session, plan([3, 4, 5]), out, "png", line_color="빨강")
    assert not out.exists()


def test_raster_rejects_an_empty_plan(session, tmp_path):
    with pytest.raises(ValueError, match="no entries"):
        export_raster(session, [], tmp_path / "a.png", "png")
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd engine && uv run pytest tests/test_raster.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'psd_engine.raster'`

- [ ] **Step 3: 최소 구현**

`engine/psd_engine/raster.py`를 새로 만든다:

```python
"""export plan → 평탄화된 PNG/JPG. 원본은 절대 수정하지 않는다."""
import os

import numpy as np
from PIL import Image

from .export import entry_pixels
from .paths import ensure_writable_path, long_path
from .render import parse_line_color

#: JPEG의 축당 한계. PNG는 사실상 한계가 없고, PSD/PSB의 30,000은 이 경로와 무관하다.
JPEG_MAX_DIMENSION = 65535

#: 라인아트는 경계가 선명해 JPEG 링이 잘 보인다. 95는 사실상 무손실로 보이면서
#: 품질 옵션 UI를 늘리지 않는다.
JPEG_QUALITY = 95


def flatten_entries(session, entries, line_rgb, progress=None):
    """
    엔트리를 문서 크기의 투명 RGBA 캔버스에 아래에서 위로 합성한다.

    `export_psd`의 프리뷰 캔버스와 같은 합성이지만 그쪽을 헬퍼로 뽑아 쓰지는
    않는다 — `export_psd`는 픽셀 추출과 pytoshop 레이어 생성과 캔버스를 한 번의
    루프에서 처리하고, 그걸 갈라놓으면 픽셀 추출이 두 번 돈다.
    """
    psd = session["psd"]
    canvas = Image.new("RGBA", (psd.width, psd.height), (0, 0, 0, 0))
    total = len(entries) + 1
    for i, entry in enumerate(entries):
        rgba, left, top = entry_pixels(session, entry, line_rgb)
        canvas.alpha_composite(Image.fromarray(rgba), dest=(left, top))
        if progress:
            progress("compose", i + 1, total)
    return canvas


def _check_dimensions(fmt, width, height, output_path):
    if fmt == "jpg" and (width > JPEG_MAX_DIMENSION or height > JPEG_MAX_DIMENSION):
        raise ValueError(
            f"{output_path}: document is {width}x{height}, over the JPEG limit of "
            f"{JPEG_MAX_DIMENSION} px per axis — write it as .png"
        )


def export_raster(session, entries, output_path, fmt, overwrite=False,
                  progress=None, line_color=None):
    """
    엔트리를 평탄화해 한 장의 PNG/JPG로 쓴다.

    PNG는 RGBA 그대로다 — 배경은 투명하고 라인의 안티에일리어싱이 알파에 남는다.
    JPG는 알파가 없으므로 **흰 캔버스에 합성한 뒤** RGB로 바꾼다.

    RGBA에 convert("RGB")를 바로 걸면 안 된다. apply_line_color가 알파 0인
    픽셀의 RGB까지 라인 색으로 채워두므로(리샘플 번짐 방지), 알파를 그냥 버리면
    전면이 라인 색인 단색 이미지가 나온다.
    """
    if not entries:
        raise ValueError("no entries to export")
    # 파일을 만들기 시작하기 전에 형식을 확인한다 — 절반 쓰다 실패하지 않도록.
    line_rgb = parse_line_color(line_color)
    output_path = str(output_path)
    ensure_writable_path(output_path)
    if os.path.exists(long_path(output_path)) and not overwrite:
        raise FileExistsError(f"output already exists: {output_path}")

    psd = session["psd"]
    _check_dimensions(fmt, psd.width, psd.height, output_path)

    canvas = flatten_entries(session, entries, line_rgb, progress)
    total = len(entries) + 1
    if progress:
        progress("write", total, total)

    if fmt == "jpg":
        backdrop = Image.new("RGBA", canvas.size, (255, 255, 255, 255))
        backdrop.alpha_composite(canvas)
        # subsampling=0(4:4:4). 기본 4:2:0은 색 성분을 절반으로 줄여 선 경계에
        # 색 번짐을 만든다.
        backdrop.convert("RGB").save(
            long_path(output_path), format="JPEG",
            quality=JPEG_QUALITY, subsampling=0,
        )
    else:
        canvas.save(long_path(output_path), format="PNG")

    return {"outputPath": output_path, "layerCount": len(entries)}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd engine && uv run pytest tests/test_raster.py -v`
Expected: PASS — 특히 `test_jpg_with_line_color_is_not_a_solid_block`

`np.unique`가 1을 돌려주면 흰 배경 합성을 빠뜨린 것이다.

- [ ] **Step 5: 커밋**

```bash
git add engine/psd_engine/raster.py engine/tests/test_raster.py engine/tests/conftest.py
git commit -m "feat: write a flattened png or jpg

PNG keeps RGBA so the line's anti-aliasing stays in alpha and the
background stays transparent. JPG has no alpha, so it composites onto a
white canvas *before* converting.

That order is the whole point. apply_line_color fills the RGB of every
pixel including the fully transparent ones, on purpose, so resampling
cannot bleed the original colour into the edges. Dropping that array's
alpha with a plain convert('RGB') yields one flat colour across the whole
frame — black at the default line setting. There is a test for exactly
that, and it is the one to keep."
```

---

### Task 6: 래스터 분할 내보내기

**Files:**
- Modify: `engine/psd_engine/raster.py`
- Test: `engine/tests/test_raster.py`

**Interfaces:**
- Consumes: `export_raster` (Task 5), `split_output_path` (`export.py:123`)
- Produces: `export_raster_split(session, entries, output_path, fmt, overwrite=False, progress=None, line_color=None) -> {"outputs": [...], "layerCount": int}`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```python
from psd_engine.raster import export_raster_split


def test_raster_split_writes_one_file_per_entry(session, plan, tmp_path):
    entries = plan([3, 4, 5])
    result = export_raster_split(session, entries, tmp_path / "X_LINE.png", "png")
    assert len(result["outputs"]) == len(entries)
    for out in result["outputs"]:
        assert Image.open(out["outputPath"]).size == (
            session["psd"].width, session["psd"].height)


def test_raster_split_checks_every_target_before_writing_any(session, plan, tmp_path):
    from pathlib import Path

    from psd_engine.export import split_output_path

    entries = plan([3, 4, 5])
    base = str(tmp_path / "X_LINE.png")
    Path(split_output_path(base, entries[1]["finalName"])).write_bytes(b"")
    with pytest.raises(FileExistsError):
        export_raster_split(session, entries, base, "png")
    # 첫 엔트리의 파일이 나가 있으면 안 된다.
    assert not Path(split_output_path(base, entries[0]["finalName"])).exists()
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd engine && uv run pytest tests/test_raster.py -k split -v`
Expected: FAIL — `ImportError: cannot import name 'export_raster_split'`

- [ ] **Step 3: 최소 구현**

`engine/psd_engine/raster.py`에 더한다:

```python
from .export import entry_pixels, split_output_path


def export_raster_split(session, entries, output_path, fmt, overwrite=False,
                        progress=None, line_color=None):
    """
    엔트리마다 이미지 하나로 내보낸다. 캔버스 크기는 매 파일 원본 그대로다 —
    나중에 다시 합칠 때 좌표가 맞아야 하기 때문이다.

    충돌·길이 검사는 한 장이라도 쓰기 전에 전부 끝낸다. 절반쯤 쓰다 멈추면
    어디까지 나갔는지 알 수 없는 상태가 남는다.
    """
    if not entries:
        raise ValueError("no entries to export")

    targets = [(e, split_output_path(str(output_path), e["finalName"])) for e in entries]
    for _, p in targets:
        ensure_writable_path(p)
    if not overwrite:
        existing = [p for _, p in targets if os.path.exists(long_path(p))]
        if existing:
            raise FileExistsError("output already exists: " + ", ".join(existing))

    outputs = []
    total = len(targets)
    for i, (entry, path) in enumerate(targets):
        outputs.append(export_raster(session, [entry], path, fmt, overwrite=True,
                                     progress=None, line_color=line_color))
        if progress:
            progress("write", i + 1, total)
    return {"outputs": outputs, "layerCount": len(entries)}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd engine && uv run pytest tests/test_raster.py -v`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add engine/psd_engine/raster.py engine/tests/test_raster.py
git commit -m "feat: export one raster file per layer

Same shape as export_psd_split: every target is checked for length and for
collision before a single file is written, because a half-written run
leaves no way to tell how far it got."
```

---

### Task 7: 래스터 검증

**Files:**
- Create: `engine/psd_engine/verify_raster.py`
- Test: `engine/tests/test_verify_raster.py`

**Interfaces:**
- Consumes: `flatten_entries` (Task 5)
- Produces: `verify_raster(session, entries, output_path, fmt, line_color=None) -> dict` — `verify_export`와 **같은 모양**

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```python
import numpy as np
import pytest
from PIL import Image

from psd_engine.raster import export_raster
from psd_engine.verify_raster import verify_raster


def test_png_verification_compares_pixels_exactly(session, plan, tmp_path):
    entries = plan([3, 4, 5])
    out = tmp_path / "a.png"
    export_raster(session, entries, out, "png")
    v = verify_raster(session, entries, out, "png")
    assert v["ok"] is True
    assert v["canvasOk"] is True
    assert v["layers"][0]["pixelChecked"] is True
    assert v["layers"][0]["pixelOk"] is True


def test_png_verification_catches_a_corrupted_output(session, plan, tmp_path):
    entries = plan([3, 4, 5])
    out = tmp_path / "a.png"
    export_raster(session, entries, out, "png")
    arr = np.array(Image.open(out))
    arr[0, 0] = [255, 0, 0, 255]
    Image.fromarray(arr).save(out)
    v = verify_raster(session, entries, out, "png")
    assert v["ok"] is False
    assert v["layers"][0]["pixelOk"] is False


def test_jpg_verification_does_not_claim_a_pixel_check(session, plan, tmp_path):
    entries = plan([3, 4, 5])
    out = tmp_path / "a.jpg"
    export_raster(session, entries, out, "jpg")
    v = verify_raster(session, entries, out, "jpg")
    assert v["ok"] is True
    assert v["layers"][0]["pixelChecked"] is False
    assert v["layers"][0]["pixelOk"] is None


def test_verification_reports_a_canvas_mismatch(session, plan, tmp_path):
    entries = plan([3, 4, 5])
    out = tmp_path / "a.png"
    Image.new("RGBA", (7, 9)).save(out)
    v = verify_raster(session, entries, out, "png")
    assert v["canvasOk"] is False
    assert v["ok"] is False


def test_verification_shape_matches_verify_export(session, plan, tmp_path):
    entries = plan([3, 4, 5])
    out = tmp_path / "a.png"
    export_raster(session, entries, out, "png")
    v = verify_raster(session, entries, out, "png")
    assert set(v) == {"ok", "canvasOk", "layerCountOk", "expectedLayers",
                      "actualLayers", "layers"}
    assert set(v["layers"][0]) == {"name", "nameOk", "pixelChecked", "pixelOk"}
    # 평탄화 1장이므로 레이어 수 이야기는 나오지 않아야 한다.
    assert v["layerCountOk"] is True
    assert v["expectedLayers"] == 1 and v["actualLayers"] == 1
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd engine && uv run pytest tests/test_verify_raster.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'psd_engine.verify_raster'`

- [ ] **Step 3: 최소 구현**

`engine/psd_engine/verify_raster.py`를 새로 만든다:

```python
"""내보낸 PNG/JPG 검증. 포맷이 줄 수 있는 보장만 주장한다."""
import os

import numpy as np
from PIL import Image

from .paths import long_path
from .raster import flatten_entries
from .render import parse_line_color


def verify_raster(session, entries, output_path, fmt, line_color=None):
    """
    `verify_export`와 같은 모양의 dict를 돌려준다 — 프런트의
    describeVerification이 그대로 읽어야 하기 때문이다.

    PNG는 무손실이라 PSD와 같은 강도의 픽셀 완전 일치 검증이 성립한다.
    JPG는 손실 압축이라 원리적으로 불가능하므로 pixelChecked를 False로 두고
    통과한 척하지 않는다.

    평탄화된 한 장이므로 레이어 수 개념이 없다. layerCountOk를 참으로 두면
    소비자(verifyReport.ts, ExportDialog.tsx)가 거짓일 때만 렌더하므로 결과에
    레이어 수 이야기가 아예 나오지 않는다 — 그것이 맞는 표시다.
    """
    line_rgb = parse_line_color(line_color)
    psd = session["psd"]
    name = os.path.basename(str(output_path))

    img = Image.open(long_path(str(output_path)))
    canvas_ok = img.size == (psd.width, psd.height)

    check = {"name": name, "nameOk": True, "pixelChecked": False, "pixelOk": None}
    if fmt == "png" and canvas_ok:
        expected = np.array(flatten_entries(session, entries, line_rgb))
        actual = np.array(img.convert("RGBA"))
        check["pixelChecked"] = True
        check["pixelOk"] = bool(
            expected.shape == actual.shape and np.array_equal(expected, actual)
        )

    ok = canvas_ok and check["pixelOk"] is not False
    return {
        "ok": bool(ok),
        "canvasOk": bool(canvas_ok),
        "layerCountOk": True,
        "expectedLayers": 1,
        "actualLayers": 1,
        "layers": [check],
    }
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd engine && uv run pytest tests/test_verify_raster.py -v`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add engine/psd_engine/verify_raster.py engine/tests/test_verify_raster.py
git commit -m "verify a raster export for what its format can guarantee

PNG is lossless, so it earns the same exact-array comparison PSD gets. JPG
cannot earn it and says so — pixelChecked false rather than passing on a
weaker check that reads like the real thing.

The dict shape is verify_export's, so the frontend needs no rework.
layerCountOk is true because a flattened image has no layer count, and both
consumers only render that field when it is false."
```

---

### Task 8: RPC가 포맷으로 분기한다

**Files:**
- Modify: `engine/psd_engine/rpc.py:154-197`
- Test: `engine/tests/test_rpc.py`

**Interfaces:**
- Consumes: `export_raster`, `export_raster_split` (Task 5·6), `verify_raster` (Task 7)
- Produces: `export_psd` RPC가 `outputFormat` 파라미터를 받는다(기본 `"psd"`).

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`engine/tests/test_rpc.py`에 더한다:

`test_rpc.py`의 기존 전 과정 테스트(`:41`)가 `EngineProc`을 어떻게 세우고 `open_psd` 응답에서
id를 뽑는지 그대로 따라 쓴다. 그 테스트를 먼저 읽고, 아래를 그 형태에 맞춘다:

```python
def test_export_png_over_rpc(fixture_psd, tmp_path):
    """실제 서브프로세스로 열기 → PNG 내보내기 → 검증까지."""
    eng = EngineProc()
    try:
        doc = eng.call("open_psd", path=str(fixture_psd))["result"]
        sid = doc["sessionId"]
        ids = [n["id"] for n in doc["nodes"] if n["kind"] == "pixel"]
        out = tmp_path / "out.png"
        resp = eng.call(
            "export_psd", sessionId=sid, includedIds=ids, operations=[],
            naming="pathPrefix", outputPath=str(out), outputFormat="png",
        )
        assert "result" in resp, resp.get("error")
        assert resp["result"]["verification"]["ok"] is True
        assert out.is_file()
    finally:
        eng.close()
```

`EngineProc`의 종료 메서드 이름은 `test_rpc.py:10-40`에서 확인해 맞춘다.

- [ ] **Step 2: 실패를 확인한다**

Run: `cd engine && uv run pytest tests/test_rpc.py -k png -v`
Expected: FAIL — `export_psd() got an unexpected keyword argument 'outputFormat'`

- [ ] **Step 3: 최소 구현**

`engine/psd_engine/rpc.py`의 import에 더한다:

```python
from .raster import export_raster as _export_raster
from .raster import export_raster_split as _export_raster_split
from .verify_raster import verify_raster
```

`export_psd`의 시그니처에 `outputFormat="psd"`를 더하고, `progress` 정의 **뒤**에 래스터 분기를 넣는다. PSD 분기는 그대로 둔다:

```python
    def export_psd(self, sessionId, includedIds, operations, naming, outputPath,
                   embedPreview=True, overwrite=False, verify=True, lineColor=None,
                   splitLayers=False, outputFormat="psd"):
        ...  # 세션·엔트리·progress 정의는 그대로

        if outputFormat in ("png", "jpg"):
            if splitLayers:
                result = _export_raster_split(s, entries, outputPath, outputFormat,
                                              overwrite=overwrite, progress=progress,
                                              line_color=lineColor)
                if verify:
                    for out in result["outputs"]:
                        out["verification"] = verify_raster(
                            s, entries, out["outputPath"], outputFormat,
                            line_color=lineColor)
                    result["verification"] = {
                        "ok": all(o["verification"]["ok"] for o in result["outputs"]),
                        "canvasOk": all(o["verification"]["canvasOk"] for o in result["outputs"]),
                        "layerCountOk": True,
                        "expectedLayers": len(result["outputs"]),
                        "actualLayers": len(result["outputs"]),
                        "layers": [l for o in result["outputs"] for l in o["verification"]["layers"]],
                    }
                result["outputPath"] = os.path.dirname(result["outputs"][0]["outputPath"])
                return result
            result = _export_raster(s, entries, outputPath, outputFormat,
                                    overwrite=overwrite, progress=progress,
                                    line_color=lineColor)
            if verify:
                result["verification"] = verify_raster(s, entries, outputPath,
                                                       outputFormat, line_color=lineColor)
            return result

        if splitLayers:
            ...  # 기존 PSD 경로 그대로
```

**분할 래스터 검증에서 `verify_raster`에 넘기는 엔트리는 `entries` 전체가 아니라 그 파일에 들어간 하나여야 한다.** 위 코드의 `entries`를 `zip(entries, result["outputs"])`로 짝지어 `[entry]`를 넘기도록 고친다:

```python
                    for entry, out in zip(entries, result["outputs"]):
                        out["verification"] = verify_raster(
                            s, [entry], out["outputPath"], outputFormat,
                            line_color=lineColor)
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd engine && uv run pytest -q`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add engine/psd_engine/rpc.py engine/tests/test_rpc.py
git commit -m "feat: dispatch export on the requested output format

outputFormat defaults to 'psd', so every existing caller lands on the
untouched PSD path. Split raster verification pairs each file with the one
entry that went into it, the same way the PSD path does."
```

---

### Task 9: 배치가 포맷으로 분기한다

**Files:**
- Modify: `engine/psd_engine/batch.py:5, 27, 33-48`
- Test: `engine/tests/test_batch.py`

**Interfaces:**
- Consumes: Task 1·5·6·7
- Produces: 배치가 `preset["outputFormat"]`(없으면 `"psd"`)을 따른다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```python
def test_batch_writes_png_when_the_preset_says_so(fixture_psd, tmp_path):
    r = run_batch([str(fixture_psd)], {**PRESET, "outputFormat": "png"},
                  output_dir=str(tmp_path))
    assert r["results"][0]["ok"] is True
    assert r["results"][0]["outputPath"].endswith(".png")


def test_batch_defaults_to_psd_when_the_preset_has_no_format(fixture_psd, tmp_path):
    # 사용자의 기존 presets.json에는 이 필드가 없다. PRESET에도 없어야 한다.
    assert "outputFormat" not in PRESET
    r = run_batch([str(fixture_psd)], PRESET, output_dir=str(tmp_path))
    assert r["results"][0]["outputPath"].endswith(".psd")
```

`PRESET`은 `test_batch.py:7`의 모듈 상수다. **`PRESET` 자체에 `outputFormat`을 더하지 않는다** —
두 번째 테스트가 그 부재를 검사한다.

- [ ] **Step 2: 실패를 확인한다**

Run: `cd engine && uv run pytest tests/test_batch.py -k png -v`
Expected: FAIL — 산출물이 `.psd`로 나온다

- [ ] **Step 3: 최소 구현**

`engine/psd_engine/batch.py`의 import를 바꾼다:

```python
from .export import export_psd, export_psd_split, output_extension
from .paths import ensure_writable_path
from .raster import export_raster, export_raster_split
from .verify import verify_export
from .verify_raster import verify_raster
```

`out_path` 계산과 분기를 바꾼다:

```python
        fmt = preset.get("outputFormat", "psd")
        src = Path(path)
        out_dir = Path(output_dir) if output_dir else src.parent
        out_path = out_dir / f"{src.stem}{preset['outputSuffix']}{output_extension(src, fmt)}"
        ensure_writable_path(out_path)

        def cb(stage, current, total):
            if progress:
                progress(str(path), stage, current, total)

        line_color = preset.get("lineColor")
        split = preset.get("splitLayers")

        if fmt in ("png", "jpg"):
            if split:
                result = export_raster_split(s, entries, out_path, fmt,
                                             overwrite=overwrite, progress=cb,
                                             line_color=line_color)
                for entry, out in zip(entries, result["outputs"]):
                    out["verification"] = verify_raster(s, [entry], out["outputPath"],
                                                        fmt, line_color=line_color)
                verification = {"ok": all(o["verification"]["ok"] for o in result["outputs"])}
                result["outputPath"] = str(out_dir)
            else:
                result = export_raster(s, entries, out_path, fmt, overwrite=overwrite,
                                       progress=cb, line_color=line_color)
                verification = verify_raster(s, entries, out_path, fmt,
                                             line_color=line_color)
        elif split:
            result = export_psd_split(s, entries, out_path,
                                      embed_preview=preset.get("embedPreview", True),
                                      overwrite=overwrite, progress=cb,
                                      line_color=line_color)
            for entry, out in zip(entries, result["outputs"]):
                out["verification"] = verify_export(s, [entry], out["outputPath"],
                                                    line_color=line_color)
            verification = {"ok": all(o["verification"]["ok"] for o in result["outputs"])}
            result["outputPath"] = str(out_dir)
        else:
            result = export_psd(s, entries, out_path,
                                embed_preview=preset.get("embedPreview", True),
                                overwrite=overwrite, progress=cb, line_color=line_color)
            verification = verify_export(s, entries, out_path, line_color=line_color)
```

네 갈래를 그대로 편다. `checker = verify_raster if raster else verify_export` 식으로 함수를
변수에 담는 것은 호출 인자가 어차피 갈라지므로(`fmt`가 있고 없고) 짧아지지도 않고 읽기만
어려워진다. PSD 두 갈래는 지금 코드와 글자 그대로 같아야 한다 — 이 태스크는 앞에 래스터
갈래를 더하는 것이지 기존 동작을 건드리는 것이 아니다.

- [ ] **Step 4: 통과를 확인한다**

Run: `cd engine && uv run pytest -q`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add engine/psd_engine/batch.py engine/tests/test_batch.py
git commit -m "feat: let a batch run write png or jpg

The preset carries the format, because batch_run is handed the whole preset
while single export gets flattened scalars. A preset without the field
means psd, which is what every saved presets.json on disk looks like."
```

---

### Task 10: 프리셋 스키마와 검증

**Files:**
- Modify: `src/lib/types.ts:57-92` (`Preset`)
- Modify: `src/lib/presets.ts:10-25, 58-147`
- Test: `src/lib/presets.test.ts`

**Interfaces:**
- Consumes: `OutputFormat` (Task 2)
- Produces: `Preset.outputFormat: OutputFormat` (파싱 뒤에는 항상 존재), `OUTPUT_FORMATS` 집합

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```ts
it("reads a preset without outputFormat as psd", () => {
  const { outputFormat: _, ...legacy } = { ...DEFAULT_PRESET, outputFormat: "png" as const };
  expect(validatePresetList([legacy])[0].outputFormat).toBe("psd");
});

it("keeps an explicit outputFormat", () => {
  expect(validatePresetList([{ ...DEFAULT_PRESET, outputFormat: "jpg" }])[0].outputFormat).toBe("jpg");
});

it("rejects an unknown outputFormat", () => {
  expect(() => validatePresetList([{ ...DEFAULT_PRESET, outputFormat: "webp" }])).toThrow(/outputFormat/);
});
```

`validatePresetList`가 export되어 있지 않으면 `presets.test.ts`가 쓰는 기존 진입점(`loadPresets`의 파싱 경로 또는 이미 export된 함수)에 맞춰 쓴다.

- [ ] **Step 2: 실패를 확인한다**

Run: `npm test -- presets`
Expected: FAIL — `expected undefined to be 'psd'`

- [ ] **Step 3: 최소 구현**

`src/lib/types.ts`의 `Preset`에 더한다(`splitLayers` 뒤):

```ts
  /**
   * 출력 포맷. "psd"는 "원본 따름"이라 .psd/.psb를 원본에서 물려받는다.
   * "png"는 투명 배경 RGBA, "jpg"는 흰 배경에 구운 불투명 이미지다.
   * 둘 다 평탄화되며, splitLayers를 켜면 레이어당 이미지 한 장이 된다.
   */
  outputFormat: OutputFormat;
```

`src/lib/presets.ts`:

```ts
import type { OutputFormat, Preset } from "./types";

const OUTPUT_FORMATS = new Set<string>(["psd", "png", "jpg"]);
```

`DEFAULT_PRESET`에 `outputFormat: "psd",`를 더한다(`splitLayers` 뒤).

`validatePreset`의 `lineColor` 검사 뒤에 더한다:

```ts
  // outputFormat도 나중에 추가된 항목이라 그 이전에 저장된 presets.json에는
  // 아예 없다. 없는 것은 "원본 따름"(psd)으로 읽는다 — 구버전 파일은 잘못된
  // 것이 아니기 때문이다. 반대로 들어있는데 모르는 값이면 통과시키지 않는다.
  if (v.outputFormat !== undefined && !OUTPUT_FORMATS.has(v.outputFormat as string)) {
    throw new Error(`${prefix}.outputFormat: "psd", "png", "jpg" 중 하나가 아닙니다.`);
  }
```

반환 객체에 더한다:

```ts
    outputFormat: (v.outputFormat as OutputFormat | undefined) ?? "psd",
```

- [ ] **Step 4: 통과를 확인한다**

Run: `npm test -- presets && npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/lib/types.ts src/lib/presets.ts src/lib/presets.test.ts
git commit -m "feat: carry an output format on the preset

Optional on the way in, always present on the way out. The user's existing
presets.json has no such field, and rejecting its absence would kill every
saved preset they have."
```

---

### Task 11: 내보내기 대화상자의 포맷 선택

**Files:**
- Modify: `src/lib/engine.ts:168-192` (`exportPsd`)
- Modify: `src/components/ExportDialog.tsx:60-68, 160-183, 277-280`
- Test: 없음 — `ExportDialog.tsx`에는 테스트 파일이 없다. 타입 검사와 수동 확인으로 받는다.

**Interfaces:**
- Consumes: `OutputFormat` (Task 2), `Preset.outputFormat` (Task 10), RPC `outputFormat` (Task 8)
- Produces: `exportPsd(..., outputFormat: OutputFormat = "psd")`

- [ ] **Step 1: 엔진 클라이언트에 인자를 더한다**

`src/lib/engine.ts`:

```ts
export async function exportPsd(
  sessionId: number,
  includedIds: number[],
  operations: Operation[],
  naming: "pathPrefix" | "original",
  outputPath: string,
  embedPreview: boolean = true,
  overwrite: boolean = false,
  verify: boolean = true,
  lineColor: string | null = null,
  splitLayers: boolean = false,
  outputFormat: OutputFormat = "psd"
): Promise<ExportResult> {
  return callEngine("export_psd", {
    sessionId, includedIds, operations, naming, outputPath,
    embedPreview, overwrite, verify, lineColor, splitLayers, outputFormat,
  }) as Promise<ExportResult>;
}
```

`OutputFormat`을 `./types`에서 import한다.

- [ ] **Step 2: 대화상자에 상태와 컨트롤을 더한다**

`src/components/ExportDialog.tsx`의 per-export 상태(`:60-68` 근처)에 더한다:

```tsx
const [outputFormat, setOutputFormat] = useState<OutputFormat>(preset.outputFormat);
```

`naming` 라디오 위에 선택 컨트롤을 넣는다:

```tsx
<label className="field">
  <span>출력 포맷</span>
  <select value={outputFormat} onChange={(e) => setOutputFormat(e.target.value as OutputFormat)}>
    <option value="psd">원본 따름 (.psd / .psb)</option>
    <option value="png">PNG — 투명 배경</option>
    <option value="jpg">JPG — 흰 배경</option>
  </select>
</label>
```

`embedPreview` 체크박스(`:277-280`)를 래스터에서 숨긴다:

```tsx
{outputFormat === "psd" && (
  <label className="check">
    <input type="checkbox" checked={embedPreview} onChange={...} />
    미리보기 이미지 포함하여 내보내기
  </label>
)}
```

- [ ] **Step 3: 저장 경로와 필터에 포맷을 물린다**

`:165`와 `:168`을 바꾼다:

```tsx
const suggested = defaultExportPath(srcPath, outputSuffix, outputFormat);
const ext = outputExtension(srcPath, outputFormat);
const outputPath = await save({
  defaultPath: suggested,
  filters: [{
    name: outputFormat === "psd" ? "Photoshop" : outputFormat.toUpperCase(),
    extensions: [ext],
  }],
});
```

`:176-183`의 호출 끝에 `outputFormat`을 더한다:

```tsx
exportPsd(sid, ops.includedIds, ops.ops, naming, outputPath, embedPreview,
          true, true, normalizeColor ? lineColor : null, splitLayers, outputFormat)
```

- [ ] **Step 4: 타입과 테스트를 확인한다**

Run: `npx tsc --noEmit && npm test`
Expected: 타입 오류 없음, JS 테스트 374건 이상 통과

- [ ] **Step 5: 커밋**

```bash
git add src/lib/engine.ts src/components/ExportDialog.tsx
git commit -m "feat: choose an output format in the export dialog

The save dialog's default path and file-type filter both follow the choice,
so the path the user confirms is the path the engine writes. embedPreview
hides for png/jpg — it writes a PSD's merged image and means nothing there."
```

---

### Task 12: 프리셋 편집기의 포맷 선택

**Files:**
- Modify: `src/components/PresetDialog.tsx:63-70, 119-123, 292-299`
- Test: 없음 — 타입 검사로 받는다.

**Interfaces:**
- Consumes: `Preset.outputFormat` (Task 10)

- [ ] **Step 1: 상태를 더한다**

```tsx
const [outputFormat, setOutputFormat] = useState<OutputFormat>(preset.outputFormat);
```

- [ ] **Step 2: 컨트롤을 더한다**

`naming` select(`:240-249`) 아래에 넣는다:

```tsx
<label className="field">
  <span>출력 포맷</span>
  <select value={outputFormat} onChange={(e) => setOutputFormat(e.target.value as OutputFormat)}>
    <option value="psd">원본 따름 (.psd / .psb)</option>
    <option value="png">PNG — 투명 배경</option>
    <option value="jpg">JPG — 흰 배경</option>
  </select>
  <small>배치 실행이 이 값을 씁니다. PNG/JPG는 평탄화된 한 장으로 나갑니다.</small>
</label>
```

`embedPreview` 체크박스를 `outputFormat === "psd"`일 때만 렌더한다.

- [ ] **Step 3: 저장 객체에 담는다**

`:119-123`의 `Preset` 조립에 `outputFormat,`을 더한다.

- [ ] **Step 4: 타입과 테스트를 확인한다**

Run: `npx tsc --noEmit && npm test`
Expected: 통과

- [ ] **Step 5: 커밋**

```bash
git add src/components/PresetDialog.tsx
git commit -m "feat: set the output format on a saved preset

Batch runs read the preset, so this is the only place a batch of a hundred
files can be told to come out as png."
```

---

### Task 13: 윈도우 러너에서 긴 경로를 실제로 검증한다

**Files:**
- Modify: `engine/packaging/smoke.py`

**Interfaces:**
- Consumes: Task 3·4의 `long_path`

- [ ] **Step 1: 스모크에 긴 경로 케이스를 더한다**

`smoke.py`의 기존 픽스처 생성 뒤에, 260자를 넘는 경로로 내보내는 항목을 더한다. 기존 `check(...)` 스타일을 그대로 따른다:

```python
    # 윈도우 MAX_PATH(260자)를 넘는 경로. `\\?\` 접두사가 없으면 여기서 죽는다.
    # 이 맥에서는 확인할 수 없고 Windows 러너에서만 진짜로 검증된다.
    deep = work
    while len(str(deep)) < 200:
        deep = deep / "긴폴더이름"
    deep.mkdir(parents=True, exist_ok=True)
    long_out = deep / ("내보내기_" + "가" * 40 + "_LINE.psd")
    response = engine.call("export_psd", sessionId=sid, includedIds=ids,
                           operations=[], naming="pathPrefix",
                           outputPath=str(long_out), overwrite=True)
    check(f"긴 경로로 내보내기 ({len(str(long_out))}자)",
          "result" in response, response.get("error"))
    check("긴 경로 산출 파일 존재", Path(long_out).is_file())
```

`sid`/`ids`는 그 파일이 이미 만들어둔 변수명을 따른다.

- [ ] **Step 2: 맥에서 스모크를 돌린다**

Run: `cd engine && uv run python packaging/smoke.py <동결된 실행 파일 경로>`

동결본이 없으면 먼저 `bash scripts/build-engine.sh`. macOS는 경로 한계가 1024라 이 케이스가 그냥 통과한다 — **여기서 통과했다고 윈도우가 통과한 것은 아니다.**

- [ ] **Step 3: 커밋**

```bash
git add engine/packaging/smoke.py
git commit -m "test: exercise a >260 char output path in the smoke test

The \\\\?\\ prefix cannot be verified on this Intel mac — macOS allows 1024
and the case simply passes. build-engine.ps1 runs this same smoke on the
Windows runner and throws on failure, so that is where the prefix is
actually proven."
```

- [ ] **Step 4: 전체를 돌리고 푸시 여부를 묻는다**

```bash
cd engine && uv run pytest -q
cd .. && npm test && npx tsc --noEmit
cd src-tauri && cargo test
```

Expected: engine 240건 안팎(213 + 신규), JS 380건 안팎, Rust 16건, 타입 오류 없음.

그다음 `gh workflow run windows-installer.yml --ref feat/line-layer-matching`으로 윈도우 러너의 스모크를 태워 긴 경로 케이스를 실제로 검증한다. **푸시는 사용자에게 먼저 묻는다.**

---

## Self-Review

**1. 스펙 커버리지**

| 설계 문서 절 | 구현 태스크 |
|---|---|
| 2. 포맷이라는 값 | Task 2(`OutputFormat`), 10(프리셋) |
| 3. 확장자 규칙 다섯 곳 | Task 1(엔진), 2(exportFlow·batch), 9(batch.py), 11(저장 대화상자 필터) |
| 4. `raster.py`, `entry_pixels` 승격 | Task 4, 5 |
| 5. 합성 규칙·검은 이미지 함정 | Task 5 |
| 6. 크기 가드 | Task 5(`_check_dimensions`) |
| 7. 검증 | Task 7, 8, 9 |
| 8. 레이어 분리 | Task 6, 8, 9 |
| 9. 윈도우 경로 길이 | Task 3, 4, 13 |
| 10. 프런트엔드 | Task 2, 10, 11, 12 |
| 11. 테스트 | 각 태스크에 분산, 핵심 회귀는 Task 5 |

빠진 절 없음.

**2. 플레이스홀더 스캔**

플레이스홀더 없음. 첫 초안은 픽스처 이름을 지어냈으나(`session_fx`, `base_preset`,
`engine_proc`) 실제 코드를 읽어 전부 교체했다 — 진짜 이름은 `session`, `PRESET`,
`EngineProc`이고 Global Constraints의 표에 위치와 함께 적어두었다. 새로 만드는 `plan`
픽스처만 Task 5 Step 0에서 정의하며, 그 정의도 계획 안에 코드로 들어 있다.

두 군데는 의도적으로 "기존 파일을 읽고 맞추라"고 남겼다 — `EngineProc`의 종료 메서드
이름(Task 8)과 `test_rpc.py`의 전 과정 테스트 형태다. 그 파일을 열면 즉시 확정되는 값이라
지어내는 것보다 정확하다.

**3. 타입 일관성**

- `output_extension(src_path, fmt="psd")` — Task 1 정의, Task 9 사용. 일치.
- `outputExtension(srcPath, fmt?)` — Task 2 정의, Task 11 사용. 일치.
- `entry_pixels` — Task 4 개명, Task 5 사용. 일치(`_entry_pixels` 아님).
- `export_raster(session, entries, output_path, fmt, ...)` — Task 5 정의, Task 6·8·9 사용. `fmt`가 네 번째 위치 인자로 일관.
- `verify_raster(session, entries, output_path, fmt, line_color=None)` — Task 7 정의, Task 8·9 사용. 일치.
- `flatten_entries(session, entries, line_rgb, progress=None)` — Task 5 정의, Task 7 사용. 일치.
- `OutputFormat` — Task 2가 `types.ts`에 정의, Task 10·11·12가 사용. 일치.
- `long_path`/`ensure_writable_path` — Task 3 정의, Task 4·5·6·7·9 사용. 일치.
