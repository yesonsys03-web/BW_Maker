# 파일 준비 병렬화 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 폴더를 로드한 뒤 사용자가 기다리는 두 순차 패스("여는 중", "미리보기 준비 중")를 하나의 작업 프로세스 잡으로 합쳐, 파일 단위로 병렬 처리한다.

**Architecture:** 작업 프로세스(`--warm-worker`)에 세 번째 잡 `prepare`를 더한다. 한 파일을 한 번 열어 트리·프리셋 매칭·미리보기 PNG를 만들어 돌려준다. 프런트는 기존 큐 코어(`runWorkerQueue`)에 모드 하나(`runPrepareQueue`)를 얹어 당겨 가기·재배정·워치독을 물려받는다. 전체 캐시와 배치 내보내기 코드는 건드리지 않는다(예외: 전체 캐시 효과에 대기 가드 한 줄).

**Tech Stack:** Python 3.12 (psd-tools, numpy, Pillow) / TypeScript + React 19 / Tauri 2 (Rust) / pytest / vitest

**Spec:** `docs/superpowers/specs/2026-08-14-parallel-file-preparation-design.md`

## Global Constraints

- **키 계산 코드를 새로 만들지 않는다.** 미리보기 렌더 인자는 `warmworker._preset_preview_args` 하나에서만 나온다. `rpc.py:172`가 경고한 "세 곳"을 네 곳으로 늘리면 안 된다.
- **`runWorkerQueue`(큐 코어)를 수정하지 않는다.** `warmWorkers.ts:16`: *"잡 종류가 늘어도 여기서 갈라지면 안 된다."* 확장은 모드 추가로만.
- **Rust(`src-tauri/src/warm.rs`)를 수정하지 않는다.** `warm_worker_send`는 payload를 그대로 전달한다(`warm.rs:102`의 주석).
- **전체 캐시·배치 내보내기 코드는 건드리지 않는다.** 유일한 예외는 Task 7의 전체 캐시 효과 대기 가드 한 줄과 버튼 문구.
- **작업 프로세스 개수 설정을 새로 만들지 않는다.** 기존 `cacheWorkers`(파일 패널 드롭다운 1/2/4/6)를 그대로 쓴다.
- **`cacheWorkers <= 1`이면 현행 동작 그대로.** 전체 캐시가 이미 쓰는 규칙(`App.tsx:1462`)과 같게 맞춘다.
- **납품 파일명을 출력·기록하지 않는다.** 계측 스크립트는 파일을 번호로 부른다.
- 화면 용어: **작업 프로세스**(worker), **파일 준비**, **전체 캐시**, **배치 내보내기**, **드로잉 레이어**(pixel leaf).

**테스트 명령**
- 엔진: `cd engine && uv run pytest`
- 프런트: `npm test` (= `vitest run`), 단일 파일은 `npx vitest run <path>`
- 타입: `npx tsc --noEmit`

---

### Task 1: 기준선 실측

작업 프로세스가 없는 지금, 폴더 하나를 준비하는 데 실제로 몇 초가 걸리는지 잰다. 설계 1.1절에 *"아직 안 잰 것 — 이게 이 트랙의 기준선이다"*라고 적힌 그 숫자다. **이 값 없이 뒤 태스크의 효과를 주장할 수 없다.**

**Files:**
- Create: `scripts/prepare-baseline.py`

**Interfaces:**
- Produces: `scripts/prepare-baseline.py` — CLI. `python scripts/prepare-baseline.py <폴더> <프리셋.json>` → 파일별·합계 초를 stdout에 JSON으로.

- [ ] **Step 1: 스크립트를 쓴다**

배포 경로 그대로(`rpc.Engine`을 직접 호출) 잰다. 프런트를 흉내내지 않는다 — 순차 패스의 비용은 엔진 호출의 합이다.

```python
#!/usr/bin/env python
"""파일 준비의 순차 기준선 — 폴더 하나를 지금 방식으로 준비하는 데 걸리는 시간.

배포 경로 그대로 rpc.Engine을 직접 호출한다. 두 패스가 메인 엔진 하나에서
직렬로 도므로, 파일별 (open_psd + apply_preset + render_preview) 합이 곧
사용자가 기다리는 벽시계 시간이다.

파일은 **번호로만** 부른다 — 납품 파일명은 기록에 남기지 않는다.

    python scripts/prepare-baseline.py /path/to/folder presets/CHAR.json
"""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "engine"))

from psd_engine.rpc import Engine  # noqa: E402


def main(folder, preset_path):
    preset = json.loads(Path(preset_path).read_text(encoding="utf-8"))
    paths = sorted(p for p in Path(folder).iterdir()
                   if p.suffix.lower() in (".psd", ".psb"))
    engine = Engine()
    rows = []
    t_all = time.perf_counter()
    for i, path in enumerate(paths, 1):
        row = {"n": i}
        try:
            t = time.perf_counter()
            opened = engine.open_psd(str(path))
            row["open_s"] = round(time.perf_counter() - t, 3)

            t = time.perf_counter()
            applied = engine.apply_preset(opened["sessionId"], preset)
            row["preset_s"] = round(time.perf_counter() - t, 3)

            matched = sorted(applied["matchedLayerIds"])
            t = time.perf_counter()
            if matched:
                engine.render_preview(
                    opened["sessionId"], matched, 1500,
                    lineColor=preset.get("lineColor"),
                    lineColorIds=matched if preset.get("lineColor") else None,
                    edgeLines=preset.get("edgeLines"),
                    includedIds=matched)
            row["preview_s"] = round(time.perf_counter() - t, 3)
            row["matched"] = len(matched)
        except Exception as e:  # 한 파일의 실패로 기준선 전체를 잃지 않는다
            row["error"] = f"{type(e).__name__}: {e}"
        row["total_s"] = round(
            sum(row.get(k, 0) for k in ("open_s", "preset_s", "preview_s")), 3)
        rows.append(row)
        print(json.dumps(row, ensure_ascii=False), flush=True)

    print(json.dumps({
        "files": len(paths),
        "wall_s": round(time.perf_counter() - t_all, 1),
        "sum_open_s": round(sum(r.get("open_s", 0) for r in rows), 1),
        "sum_preset_s": round(sum(r.get("preset_s", 0) for r in rows), 1),
        "sum_preview_s": round(sum(r.get("preview_s", 0) for r in rows), 1),
        "failed": sum(1 for r in rows if "error" in r),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
```

- [ ] **Step 2: 실제 작업 폴더에서 돌린다**

Run: `cd engine && uv run python ../scripts/prepare-baseline.py <실제 폴더> <프리셋>`

**중요 — 캐시를 비우고 재실행해서 두 번 재라.** 디스크 캐시가 있으면 미리보기가 히트해서 콜드 비용이 안 잡힌다.
- 콜드: `PSD_ENGINE_TILE_CACHE=0` 를 붙여 캐시를 끄고 한 번
- 웜: 그대로 한 번

- [ ] **Step 3: 결과를 계획 문서에 적는다**

이 파일 맨 아래 "## 실측 기록" 절에 콜드/웜 `wall_s`와 파일 수를 적는다. Task 8이 같은 스크립트·같은 폴더로 비교한다.

- [ ] **Step 4: 커밋**

```bash
git add scripts/prepare-baseline.py docs/superpowers/plans/2026-08-14-parallel-file-preparation.md
git commit -m "chore: measure the sequential file-preparation baseline"
```

---

### Task 2: 엔진 — `prepare` 잡의 트리·매칭

작업 프로세스가 파일을 한 번 열어 트리와 프리셋 매칭 결과를 돌려준다. 미리보기는 아직 굽지 않는다(Task 3).

**Files:**
- Modify: `engine/psd_engine/warmworker.py` (새 함수 `prepare_file`, `main` 디스패치)
- Test: `engine/tests/test_warmworker.py`

**Interfaces:**
- Produces: `warmworker.prepare_file(path, preset, max_size, out) -> None` — `{"event":"file","path","ok":true,"result":{...}}` 한 줄을 `out`에 쓴다. 던지지 않는다(실패도 이벤트로 나간다).
- Produces: 워커 프로토콜 `{"path": str, "prepare": {"preset": dict, "maxSize": int}}`

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`engine/tests/test_warmworker.py` 끝에 붙인다. `fixture_psd`와 `_run`은 이 파일에 이미 있다.

```python
def test_prepare_returns_the_tree_and_the_preset_match(fixture_psd):
    preset = {"name": "T", "include": [], "exclude": [], "merge": "none"}
    events = _run([json.dumps(
        {"path": str(fixture_psd), "prepare": {"preset": preset, "maxSize": 256}}
    ) + "\n"])

    done = [e for e in events if e["event"] == "file"]
    assert len(done) == 1 and done[0]["ok"] is True
    r = done[0]["result"]
    # 메인 엔진 open_psd가 주던 것 — sessionId만 빠진다(워커는 세션을 못 만든다).
    assert r["mtime"] == os.path.getmtime(fixture_psd)
    assert r["width"] > 0 and r["height"] > 0
    assert r["colorMode"] == "RGB"
    assert isinstance(r["tree"], list) and len(r["tree"]) > 0
    # apply_preset이 주던 것.
    assert "matchedLayerIds" in r and "skippedLayers" in r and "operations" in r


def test_prepare_reports_a_failure_without_killing_the_worker(tmp_path):
    missing = tmp_path / "gone.psd"
    preset = {"name": "T", "include": [], "exclude": [], "merge": "none"}
    events = _run([json.dumps(
        {"path": str(missing), "prepare": {"preset": preset, "maxSize": 256}}
    ) + "\n"])

    done = [e for e in events if e["event"] == "file"]
    assert len(done) == 1 and done[0]["ok"] is False
    assert "message" in done[0]
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd engine && uv run pytest tests/test_warmworker.py -k prepare -v`
Expected: FAIL — `prepare` 잡이 없어 `warm_file` 경로로 빠지거나 KeyError.

- [ ] **Step 3: `prepare_file`을 구현한다**

`engine/psd_engine/warmworker.py`의 `export_file` 아래에 더한다.

```python
def prepare_file(path, preset, max_size, out):
    """
    파일 하나의 "준비" — 앱이 폴더를 로드하며 파일마다 하던 일 전부를 워커가
    한 번의 열기로 끝낸다. 지금까지는 메인 엔진이 "여는 중"(open_psd +
    apply_preset)과 "미리보기 준비 중"(render_preview)을 **따로** 돌았고,
    세션이 LRU 2칸이라 두 번째 패스에서 대개 파일을 다시 열었다.

    돌려주는 것은 메인 엔진의 open_psd + apply_preset 응답에서 **sessionId만
    뺀 것**이다. 세션은 메인 엔진 SessionStore의 것이라 워커가 만들 수 없다.
    프런트는 세션 없이도 트리를 들 수 있다 — 프로젝트 복원이 이미 그 상태를
    만든다(App.tsx의 restoreProject 주석).

    한 파일의 실패로 워커를 죽이지 않는다 — 워밍업·내보내기와 같은 규율이다.
    """
    import traceback
    from pathlib import Path as _Path

    from .matching import match_preset, preset_operations

    try:
        mtime = os.path.getmtime(path)
        psd = PSDImage.open(path)
        # 메인 엔진(session.open)과 같은 제한 — 거기서 못 여는 파일을 여기서
        # 준비해도 쓸 사람이 없다.
        if psd.color_mode != ColorMode.RGB:
            raise ValueError(f"unsupported color mode: {psd.color_mode!r} (RGB only)")
        built = build_tree(psd)
        tree = built["tree"]
        matched, skipped = match_preset(tree, preset)
        result = {
            "tree": tree,
            "mtime": mtime,
            "width": psd.width,
            "height": psd.height,
            "colorMode": psd.color_mode.name,
            "depth": psd.depth,
            "matchedLayerIds": matched,
            "skippedLayers": skipped,
            "operations": preset_operations(tree, matched, preset,
                                            source_stem=_Path(path).stem),
            "pngPath": None,
            "documentView": False,
        }
        _emit({"event": "file", "path": path, "ok": True, "result": result}, out)
    except Exception as e:  # noqa: BLE001 — 항목별 기록 정책(warm_file과 같다)
        _emit({"event": "file", "path": path, "ok": False,
               "message": f"{type(e).__name__}: {e}",
               "traceback": traceback.format_exc()}, out)
```

`main()`의 루프에서 `"export" in msg` 분기 **바로 아래**에 더한다:

```python
        if "prepare" in msg:
            # 실패 항목도 prepare_file이 만들어 보낸다 — 여기서 또 감싸지 않는다.
            prepare_file(path, msg["prepare"]["preset"],
                         msg["prepare"].get("maxSize", max_size), stdout)
            continue
```

- [ ] **Step 4: 통과를 확인한다**

Run: `cd engine && uv run pytest tests/test_warmworker.py -k prepare -v`
Expected: PASS (2개)

- [ ] **Step 5: 전체 엔진 테스트**

Run: `cd engine && uv run pytest`
Expected: 기존 전부 통과 + 신규 2개

- [ ] **Step 6: 커밋**

```bash
git add engine/psd_engine/warmworker.py engine/tests/test_warmworker.py
git commit -m "feat: add a prepare job that returns a file's tree and preset match"
```

---

### Task 3: 엔진 — `prepare` 잡의 미리보기 PNG

준비 잡이 "갓 적용한 화면"의 미리보기까지 굽고 PNG 경로를 돌려준다.

**Files:**
- Modify: `engine/psd_engine/warmworker.py` (`prepare_file` 확장 + PNG 링)
- Test: `engine/tests/test_warmworker.py`

**Interfaces:**
- Consumes: Task 2의 `prepare_file`
- Produces: `result["pngPath"]`(str 또는 None), `result["documentView"]`(bool)

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```python
def test_prepare_bakes_the_preview_the_main_engine_would_render(fixture_psd, tmp_path):
    """워커가 구운 그림을 메인 엔진의 렌더가 **디스크 히트로** 찾아야 한다.

    이 테스트가 이 트랙의 계약이다 — 키가 어긋나면 워커가 100장을 구워도
    클릭은 전부 다시 합성한다. rpc.py의 _preview_key_material 주석이 경고하는
    "세 곳이 같은 키로 접혀야 한다"를 기계로 잠근다.
    """
    import psd_engine.tilecache as tc
    from psd_engine.rpc import Engine, _preview_key_material
    from psd_engine.warmworker import _preset_preview_args

    preset = {"name": "T", "include": [], "exclude": [], "merge": "none"}
    events = _run([json.dumps(
        {"path": str(fixture_psd), "prepare": {"preset": preset, "maxSize": 256}}
    ) + "\n"])
    r = [e for e in events if e["event"] == "file"][0]["result"]

    args = _preset_preview_args(r["tree"], preset)
    if args is None:          # 이 픽스처에 구울 것이 없으면 계약을 못 잰다
        pytest.skip("fixture has nothing to bake")

    assert r["pngPath"] is not None and os.path.exists(r["pngPath"])

    # 메인 엔진이 같은 인자로 렌더하면 디스크 캐시에서 나와야 한다.
    engine = Engine()
    sid = engine.open_psd(str(fixture_psd))["sessionId"]
    session = engine.store.get(sid)
    key = tc.preview_key(_preview_key_material(
        args["visible"], 256, args["lineColor"], args["lineColorIds"],
        args["edgeLines"], args["included"]))
    assert tc.load_preview(session, key, str(tmp_path / "hit.png")) is not None


def test_prepare_flags_the_document_view_instead_of_baking(fixture_psd):
    """매칭이 '파일을 연 직후 보이는 전부'와 같으면 화면은 저장된 병합
    이미지로 간다(즉시) — 그 경우 구울 것이 없고 플래그만 준다."""
    from psd_engine.warmworker import _pixel_leaf_ids

    preset = {"name": "T", "include": [], "exclude": [], "merge": "none"}
    events = _run([json.dumps(
        {"path": str(fixture_psd), "prepare": {"preset": preset, "maxSize": 256}}
    ) + "\n"])
    r = [e for e in events if e["event"] == "file"][0]["result"]

    visible = _pixel_leaf_ids(r["tree"], set(r["matchedLayerIds"]))
    initial = _pixel_leaf_ids(r["tree"], initial=True)
    is_doc = bool(visible) and set(visible) == set(initial)
    assert r["documentView"] is is_doc
    if is_doc:
        assert r["pngPath"] is None
```

- [ ] **Step 2: 실패를 확인한다**

Run: `cd engine && uv run pytest tests/test_warmworker.py -k "bakes or document_view" -v`
Expected: FAIL — `pngPath`가 항상 None.

- [ ] **Step 3: 구현한다**

모듈 맨 위(임포트 아래)에 PNG 링을 더한다. 워커는 `warm_file`과 달리 PNG를 **지우면 안 된다** — 프런트가 그 경로를 읽는다. 무한히 쌓이지도 않게 메인 엔진의 `RENDER_DIR_GENERATIONS`와 같은 링을 둔다.

```python
#: 준비 잡이 만든 미리보기 PNG를 살려두는 개수. 프런트가 file 이벤트를 받은 뒤
#: 그 경로를 읽으므로(loadPngDataUrl) 워밍업처럼 곧바로 지울 수 없고, 그렇다고
#: 안 지우면 100장짜리 폴더마다 PNG가 쌓인다. 프런트는 항상 "방금 받은" 것을
#: 읽으므로 원리상 1이면 되지만, 이벤트 처리가 늦어지는 최악을 감안해 넉넉히
#: 둔다. 메인 엔진의 RENDER_DIR_GENERATIONS(rpc.py)와 같은 장치다.
PREPARE_PNG_GENERATIONS = 8

_prepare_dir = None
_prepare_ring = deque()


def _prepare_png_dir():
    """준비 PNG를 놓을 새 디렉터리. 오래된 세대는 지운다."""
    global _prepare_dir
    if _prepare_dir is None:
        _prepare_dir = tempfile.mkdtemp(prefix="psd_prepare_")
        atexit.register(shutil.rmtree, _prepare_dir, ignore_errors=True)
    d = Path(tempfile.mkdtemp(dir=_prepare_dir))
    _prepare_ring.append(d)
    while len(_prepare_ring) > PREPARE_PNG_GENERATIONS:
        shutil.rmtree(_prepare_ring.popleft(), ignore_errors=True)
    return d
```

임포트에 `atexit`, `from collections import deque`, `from pathlib import Path`를 더한다(`shutil`·`tempfile`은 이미 있다).

`prepare_file`의 `result = {...}` **뒤**, `_emit` **앞**에 더한다:

```python
        # 무슨 그림을 구울지는 _preset_preview_args 하나가 정한다 — 전체 캐시가
        # 쓰는 바로 그 함수다. 여기서 따로 계산하면 키를 만드는 곳이 네 번째로
        # 늘고, rpc.py의 _preview_key_material이 경고하는 "세 곳" 문제가
        # 여섯 쌍이 된다.
        args = _preset_preview_args(tree, preset)
        # documentView는 args가 None인 두 이유(매칭 0장 / 매칭이 초기 화면과
        # 같음) 중 어느 쪽인지를 프런트에 알린다. 같은 원시 함수를 쓰므로 새
        # 판단이 아니다.
        visible = _pixel_leaf_ids(tree, set(matched))
        initial = _pixel_leaf_ids(tree, initial=True)
        result["documentView"] = bool(visible) and set(visible) == set(initial)
        if args is not None:
            session = {"psd": psd, "path": str(path), "mtime": mtime,
                       "tree": tree, "layers_by_id": built["layers_by_id"]}
            result["pngPath"] = render_preview_cached(
                session, str(_prepare_png_dir()), args["visible"], max_size,
                line_color=args["lineColor"],
                line_color_ids=args["lineColorIds"],
                edge_lines=args["edgeLines"],
                included_ids=args["included"])
```

`prepare_file` 안의 임포트에 `from .rpc import render_preview_cached`를 더한다(`warm_file`이 같은 방식으로 함수 안에서 임포트한다 — 순환 임포트를 피한다).

- [ ] **Step 4: 통과를 확인한다**

Run: `cd engine && uv run pytest tests/test_warmworker.py -k "bakes or document_view" -v`
Expected: PASS

- [ ] **Step 5: 변이 확인 — 테스트가 진짜 잠그는지**

`args["included"]`를 `None`으로 바꿔 키를 일부러 어긋내고 테스트를 돌린다.
Expected: `test_prepare_bakes_the_preview_the_main_engine_would_render`가 FAIL.
확인 후 **되돌린다.** (이 프로젝트에서 "변이를 정확히 넣지 않으면 아무것도 증명 못 한다"는 교훈이 여러 번 나왔다.)

- [ ] **Step 6: 전체 엔진 테스트 후 커밋**

```bash
cd engine && uv run pytest
git add engine/psd_engine/warmworker.py engine/tests/test_warmworker.py
git commit -m "feat: bake the freshly-applied preview inside the prepare job"
```

---

### Task 4: 프런트 — `runPrepareQueue` 모드

**Files:**
- Modify: `src/lib/warmWorkers.ts` (모드 추가, 코어는 그대로)
- Test: `src/lib/warmWorkers.test.ts`

**Interfaces:**
- Consumes: 기존 `runWorkerQueue`, `WorkerSweepDeps`
- Produces:
  ```ts
  export interface PrepareProgress { filesDone: number; filesTotal: number }
  export interface PrepareOutcome {
    failed: Array<{ path: string; message: string }>;
    remaining: string[];
    stopped: boolean;
  }
  export interface PrepareDeps extends Omit<WorkerSweepDeps, "onProgress"> {
    onProgress?: (p: PrepareProgress) => void;
    onResult: (path: string, result: Record<string, unknown>) => void;
  }
  export function runPrepareQueue(deps: PrepareDeps): {
    finished: Promise<PrepareOutcome>;
    cancel: () => void;
  }
  ```

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/lib/warmWorkers.test.ts` 끝에 붙인다. 파일 맨 위 import에 `runPrepareQueue`와 `type PrepareDeps`를 더한다.

```ts
/** 준비 큐용 가짜 워커판. harness와 같은 모양이되 결과를 모은다. */
function prepareHarness(paths: string[], workerCount: number, ids = [0, 1]) {
  let lineCb: ((e: { generation: number; id: number; line: string }) => void) | undefined;
  let exitCb: ((e: { generation: number; id: number }) => void) | undefined;
  const sends: Array<{ id: number; path: string }> = [];
  const results: Array<{ path: string; result: Record<string, unknown> }> = [];
  const deps: PrepareDeps = {
    paths,
    workerCount,
    start: async () => ({ generation: 7, ids: ids.slice(0, workerCount) }),
    send: async (id, path) => void sends.push({ id, path }),
    stop: vi.fn(async () => {}),
    onLine: async (cb) => { lineCb = cb; return () => (lineCb = undefined); },
    onExit: async (cb) => { exitCb = cb; return () => (exitCb = undefined); },
    onResult: (path, result) => void results.push({ path, result }),
  };
  const emit = (id: number, ev: WorkerEvent, generation = 7) =>
    lineCb?.({ generation, id, line: JSON.stringify(ev) });
  const exit = (id: number, generation = 7) => exitCb?.({ generation, id });
  return { deps, sends, results, emit, exit };
}

test("prepare hands each result to the caller as soon as that file lands", async () => {
  const h = prepareHarness(["a", "b", "c"], 2);
  const run = runPrepareQueue(h.deps);
  await tick();
  expect(h.sends).toEqual([{ id: 0, path: "a" }, { id: 1, path: "b" }]);

  // 파일 하나가 끝나면 끝까지 기다리지 않고 그 자리에서 넘긴다 — 100장짜리
  // 폴더에서 다 끝나야 화면이 채워지면 아무것도 안 보이는 시간이 길어진다.
  h.emit(1, { event: "file", path: "b", ok: true, result: { path: "b", mtime: 2 } });
  await tick();
  expect(h.results).toEqual([{ path: "b", result: { path: "b", mtime: 2 } }]);
  // 그리고 빈 워커가 다음 파일을 당겨 간다.
  expect(h.sends[2]).toEqual({ id: 1, path: "c" });

  h.emit(0, { event: "file", path: "a", ok: true, result: { path: "a", mtime: 1 } });
  h.emit(1, { event: "file", path: "c", ok: true, result: { path: "c", mtime: 3 } });
  const out = await run.finished;
  expect(out.failed).toEqual([]);
  expect(out.stopped).toBe(false);
});

test("prepare records a failed file and keeps going", async () => {
  const h = prepareHarness(["a", "b"], 2);
  const run = runPrepareQueue(h.deps);
  await tick();

  h.emit(0, { event: "file", path: "a", ok: false, message: "boom" });
  h.emit(1, { event: "file", path: "b", ok: true, result: { path: "b" } });
  const out = await run.finished;
  expect(out.failed).toEqual([{ path: "a", message: "boom" }]);
  expect(h.results.map((r) => r.path)).toEqual(["b"]);
});

test("cancel is not a failure — the remaining files stay unclaimed", async () => {
  const h = prepareHarness(["a", "b", "c"], 1, [0]);
  const run = runPrepareQueue(h.deps);
  await tick();

  // 전체 캐시가 시작하면 작업 프로세스가 전부 죽는다. 그때 남은 파일을
  // "실패"로 적으면 가짜 오류 카드("미리보기를 미리 만들지 못한 파일 N개")가
  // 뜬다 — 취소는 실패가 아니다.
  run.cancel();
  const out = await run.finished;
  expect(out.stopped).toBe(true);
  expect(out.failed).toEqual([]);
  expect(out.remaining).toEqual(["b", "c"]);
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/lib/warmWorkers.test.ts`
Expected: FAIL — `runPrepareQueue`가 없음.

- [ ] **Step 3: 구현한다**

`src/lib/warmWorkers.ts` 끝에 더한다. **`runWorkerQueue`는 한 줄도 고치지 않는다.**

```ts
export interface PrepareProgress {
  filesDone: number;
  filesTotal: number;
}

export interface PrepareOutcome {
  failed: Array<{ path: string; message: string }>;
  /** 시작도 못 한 파일. 취소 후 현행 순차 경로가 이어받는다. */
  remaining: string[];
  /** 취소로 끝났는가. 전체 캐시·배치 내보내기가 작업 프로세스를 가져가면 true. */
  stopped: boolean;
}

export interface PrepareDeps extends Omit<WorkerSweepDeps, "onProgress"> {
  onProgress?: (p: PrepareProgress) => void;
  /** 파일 하나가 준비될 때마다. 끝까지 기다렸다 한 번에 넘기면 100장짜리
   * 폴더에서 화면이 오래 비어 있다 — 배치 내보내기의 onResult와 같은 약속. */
  onResult: (path: string, result: Record<string, unknown>) => void;
}

/**
 * 파일 준비 큐 — 폴더 로드 직후의 "여는 중"과 "미리보기 준비 중"을 작업
 * 프로세스가 파일 단위로 나눠 처리한다. 워커가 파일을 한 번 열어 트리·프리셋
 * 매칭·미리보기를 만들어 돌려준다(엔진 warmworker.prepare_file).
 *
 * 취소는 **즉시**다(drainOnCancel: false). 배치 내보내기와 달리 산출물이
 * 디스크 캐시와 PNG 한 장뿐이라 도중에 죽여도 반쪽 파일이 안 남는다 —
 * tilecache의 쓰기가 원자적이다. 남은 파일은 현행 순차 경로가 이어받는다.
 */
export function runPrepareQueue(deps: PrepareDeps) {
  const failed: Array<{ path: string; message: string }> = [];
  let done = 0;

  const core = runWorkerQueue(deps as WorkerSweepDeps, {
    drainOnCancel: false,
    onOther: () => {},
    onFile: (ev) => {
      const path = ev.path!;
      done += 1;
      if (ev.ok && ev.result !== undefined) {
        deps.onResult(path, ev.result as unknown as Record<string, unknown>);
      } else {
        failed.push({ path, message: ev.message ?? "unknown" });
      }
    },
    // 취소로 죽은 워커의 남은 파일은 여기 오지 않는다(코어가 cancelled면
    // onAbandoned를 안 부른다). 여기 오는 것은 배선 고장·전멸뿐이다.
    onAbandoned: (path, message) => {
      failed.push({ path, message });
    },
    report,
  });

  function report() {
    deps.onProgress?.({ filesDone: done + failed.length, filesTotal: deps.paths.length });
  }

  return {
    finished: core.finished.then((kind) => ({
      failed,
      remaining: core.remaining(),
      stopped: kind === "cancelled",
    })),
    cancel: core.cancel,
  };
}
```

- [ ] **Step 4: 통과를 확인한다**

Run: `npx vitest run src/lib/warmWorkers.test.ts`
Expected: PASS (기존 + 신규 3개)

- [ ] **Step 5: 커밋**

```bash
npx tsc --noEmit
git add src/lib/warmWorkers.ts src/lib/warmWorkers.test.ts
git commit -m "feat: add a prepare mode to the worker dispatcher"
```

---

### Task 5: 프런트 — 세션 없는 파일의 미리보기 키

`previewPlanFor`가 `sessionId`를 요구하는 가드를 푼다. 준비된 파일은 세션이 없을 수 있고, `previewRenderSpec` 자체는 세션을 쓰지 않는다(`App.tsx:763`이 이미 그렇게 적어 뒀고 프로젝트 저장이 그 방식으로 계산한다).

**Files:**
- Modify: `src/App.tsx:708-722` (`previewPlanFor`), `src/App.tsx:1158-1180` (호출부)
- Test: `src/App.test.tsx`

**Interfaces:**
- Produces: `previewPlanFor(file)`가 `file.sessionId === undefined`여도 plan을 돌려준다. 렌더가 필요한 호출부는 세션을 **그 자리에서** 연다.

- [ ] **Step 1: 실패하는 테스트를 쓴다**

`src/App.test.tsx`에 더한다. 이 파일의 기존 테스트 관례(엔진 모듈 mock)를 따른다.

`previewPlanFor`는 컴포넌트 안의 `useCallback`이라 직접 못 부른다. **관찰 가능한 결과로 잰다:** 세션 없는 파일이 미리보기 준비 큐의 대상에 드는가(`needsPrefetch(previewPlanFor(f)?.key ...)` — 키가 null이면 대상에서 빠진다).

기존 헬퍼(`addFiles`, `finishOpen`, `click`, `treeOf`, `PATHS`)를 그대로 쓴다. **새 헬퍼를 만들지 말 것.**

```tsx
test("a file with a tree but no session still gets a preview key", async () => {
  // 프로젝트 복원이 이미 만드는 상태(tree는 있고 sessionId는 없음)를 작업
  // 프로세스 준비도 만든다. 키를 못 만들면 구워둔 그림을 화면이 영영 못 찾고,
  // 준비 큐도 그 파일을 건너뛴다.
  render(<App />);
  await addFiles({ click });
  await finishOpen(0, 1);

  // 세션만 지운 파일을 만든다 — restoreProject가 세우는 모양과 같다.
  act(() => {
    dispatchTestAction({ type: "engineRestarted" });
  });

  // 세션이 없어도 준비 큐가 이 파일을 집는다(= 키가 나왔다).
  await waitFor(() => expect(engine.renderPreview).toHaveBeenCalled());
});
```

> **`dispatchTestAction`이 이 파일에 없으면** 이 테스트를 다르게 쓴다: `finishOpen`을 부르지 않은 채(= `status`가 "idle"이라 tree도 없음) 대신, **Task 6이 먼저 들어간 뒤** 준비 결과로 tree만 세우고 세션 없이 미리보기 키가 나오는지 잰다. 그 경우 Task 5와 Task 6의 순서를 바꿔 Task 6을 먼저 하고, 이 테스트는 Task 6의 테스트에 합친다. **어느 쪽이든 "세션 없는 파일이 키를 얻는가"를 실제로 재는 테스트가 하나 있어야 한다** — 그것이 이 태스크의 전부다.

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/App.test.tsx --no-file-parallelism -t "without a session"`
Expected: FAIL

> `--no-file-parallelism`은 이 파일이 부하에 약해서다. 판정은 항상 직렬로.

- [ ] **Step 3: 가드를 푼다**

`src/App.tsx:708`:

```tsx
  const previewPlanFor = useCallback((file: FileEntry) => {
    const ops = opsByPathRef.current[file.path];
    // sessionId는 **묻지 않는다.** previewRenderSpec은 세션을 쓰지 않고
    // (아래 프로젝트 저장이 오래전부터 그렇게 계산해 왔다), 준비된 파일은
    // 세션이 없을 수 있다 — 작업 프로세스가 트리를 만들고 세션은 메인 엔진이
    // 나중에 채운다. 프로젝트 복원이 이미 같은 상태를 만든다(restoreProject).
    //
    // 렌더가 필요한 호출부는 세션을 그 자리에서 연다(withEvictedSessionRetry).
    // "세션이 있는가"와 "그릴 계획이 있는가"는 다른 질문이고, 지금까지 한 값에
    // 얹혀 있었다.
    if (!file.tree || !ops) return null;
    return previewRenderSpec(
      { path: file.path, mtime: file.mtime },
      file.tree,
      ops.includedIds,
      ops.previewHiddenIds,
      ops.soloIds,
      presetRef.current?.lineColor ?? null,
      matchedIdsByPathRef.current[file.path],
      presetRef.current?.edgeLines ?? null,
      ops.edgeColourIds
    );
  }, []);
```

- [ ] **Step 4: 호출부가 세션을 스스로 열게 한다**

`src/App.tsx:1179` 부근, `let sid = file.sessionId!;`가 이제 안전하지 않다:

```tsx
        try {
          // 세션이 없으면(작업 프로세스가 준비한 파일, 프로젝트 복원 직후)
          // 여기서 연다 — 이 큐는 그림을 만들어야 하므로 세션이 필요하다.
          let sid = file.sessionId;
          if (sid === undefined) {
            const opened = await openFileEffect(dispatch, path, { activate: false });
            if (!opened) return;   // 실패는 openFileEffect가 이미 보고했다
            sid = opened.sessionId;
            refreshSession(path, opened);
          }
          const { pngPath } = await withEvictedSessionRetry(
```

`App.tsx:1135`의 `needsPrefetch` 필터는 그대로 둔다 — 이제 세션 없는 파일도 키가 나오므로 자연히 대상에 들어온다.

- [ ] **Step 5: 나머지 `sessionId` 가드를 훑는다**

아래 넷은 **그대로 둔다.** 각각 "세션이 진짜 필요한" 자리다. 확인만 하고 넘어간다:
- `App.tsx:1254`, `1258`, `1260`, `1272` — 타일 워밍업. `warm_preview_tiles`가 세션을 받는다.
- `App.tsx:1434` — 스윕 후 다음 파일 데우기. 같은 이유.
- `App.tsx:1662` — 세션이 필요한 조작.

- [ ] **Step 6: 통과를 확인한다**

Run: `npx vitest run src/App.test.tsx --no-file-parallelism`
Expected: PASS (기존 전부 + 신규)

- [ ] **Step 7: 커밋**

```bash
npx tsc --noEmit
git add src/App.tsx src/App.test.tsx
git commit -m "fix: let a file without a session still produce a preview key"
```

---

### Task 6: 프런트 — 파일 준비 큐 배선

**Files:**
- Modify: `src/lib/engine.ts:402-411` (`WarmWorkerJob`에 `prepare` 추가)
- Modify: `src/App.tsx` (준비 효과 추가, 기존 두 패스에 비켜서기 가드)
- Test: `src/App.test.tsx`

**Interfaces:**
- Consumes: Task 4의 `runPrepareQueue`, Task 2·3의 워커 프로토콜
- Produces: `preparingRef`(기존 두 패스가 읽는 비켜서기 신호), `preparing` state(Task 7이 읽음)

- [ ] **Step 1: 잡 타입을 넓힌다**

`src/lib/engine.ts:402`:

```ts
export interface WarmWorkerJob {
  path: string;
  presets?: Preset[];
  export?: {
    preset: Preset;
    outputDir: string | null;
    overwrite: boolean;
    manualLineIds?: number[];
  };
  /**
   * 파일 준비 — 폴더 로드 직후의 "여는 중"+"미리보기 준비 중"을 작업 프로세스가
   * 파일 단위로 나눠 한다. 워커가 파일을 한 번 열어 트리·프리셋 매칭·미리보기를
   * 만들어 돌려준다(엔진 warmworker.prepare_file).
   */
  prepare?: {
    preset: Preset;
    maxSize: number;
  };
}
```

- [ ] **Step 2: 실패하는 테스트를 쓴다**

`App.test.tsx:1687`의 전체 캐시 테스트를 본으로 삼는다 — 워커 셀렉트를 조작하고 `lineCb`로 워커 이벤트를 흘리는 방식이 그대로 필요하다.

```tsx
test("raising the worker count spreads file preparation across processes", async () => {
  let lineCb: ((e: { generation: number; id: number; line: string }) => void) | undefined;
  engine.onWarmWorkerLine.mockImplementation(async (cb: (e: { generation: number; id: number; line: string }) => void) => {
    lineCb = cb;
    return () => {};
  });
  engine.warmWorkersStart.mockResolvedValue({ generation: 9, ids: [0, 1] });

  render(<App />);
  await addFiles({ click });
  await finishOpen(0, 1); // 나머지 두 파일은 아직 idle이다

  const workers = screen.getByTitle(/전체 캐시를 몇 개의 작업 프로세스/) as HTMLSelectElement;
  workers.value = "2";
  workers.dispatchEvent(new Event("change", { bubbles: true }));

  // 남은 두 장이 **동시에** 나간다 — 한 장 끝나야 다음이 아니다.
  await waitFor(() => expect(engine.warmWorkersStart).toHaveBeenCalledWith(2, expect.any(Number)));
  await waitFor(() => expect(engine.warmWorkerSend.mock.calls.length).toBe(2));

  // 잡 모양이 prepare다 — presets(전체 캐시)도 export(배치 내보내기)도 아니다.
  const job = engine.warmWorkerSend.mock.calls[0][1] as { prepare?: unknown; presets?: unknown };
  expect(job.prepare).toBeDefined();
  expect(job.presets).toBeUndefined();

  // 준비 결과가 도착하면 그 파일이 세션 없이 "열림"이 된다.
  const call = engine.warmWorkerSend.mock.calls[0] as [number, { path: string }];
  lineCb!({
    generation: 9, id: call[0],
    line: JSON.stringify({
      event: "file", path: call[1].path, ok: true,
      result: {
        tree: treeOf([1, 2, 3]), mtime: 1, width: 10, height: 10,
        colorMode: "RGB", depth: 8,
        matchedLayerIds: [1], skippedLayers: [], operations: [],
        pngPath: null, documentView: false,
      },
    }),
  });
  await waitFor(() => expect(screen.queryAllByText("열림").length).toBeGreaterThanOrEqual(2));
});

test("one worker keeps the current sequential path", async () => {
  // 기본값 1에서는 아무것도 안 바뀐다 — 전체 캐시가 이미 쓰는 규칙과 같다.
  render(<App />);
  await addFiles({ click });
  await finishOpen(0, 1);
  expect(engine.warmWorkersStart).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: 실패를 확인한다**

Run: `npx vitest run src/App.test.tsx --no-file-parallelism -t "spreads file preparation"`
Expected: FAIL

- [ ] **Step 4: 준비 효과를 더한다**

`src/App.tsx`의 전체 캐시 효과(`1461` 부근) **앞**에 더한다.

```tsx
  /** 파일 준비가 작업 프로세스로 도는 중인지. 기존 두 패스가 이걸 보고 비켜선다. */
  const preparingRef = useRef(false);
  const [preparing, setPreparing] = useState(false);

  // 파일 준비 — 작업 프로세스 모드(개수 2 이상). 폴더 로드 직후의 "여는 중"과
  // "미리보기 준비 중"을 파일 단위로 나눠 병렬 처리한다. 두 패스가 하나로
  // 합쳐지는 것이 요점이다: 지금은 여는 중에 PSD를 한 번 열고, 미리보기
  // 준비에서 세션이 이미 밀려나 있어(LRU 2칸) 또 연다.
  //
  // 전체 캐시·배치 내보내기가 돌면 아예 출발하지 않는다. 작업 프로세스 스폰은
  // 이전 세대를 죽이므로(warm.rs의 kill_all), 여기서 시작하면 **몇 시간짜리
  // 전체 캐시가 조용히 죽고 배치 내보내기는 반쪽 PSD를 남긴다.** 그 둘이
  // 도는 동안은 현행 순차 경로가 파일을 준비한다 — 느리지만 옳다.
  useEffect(() => {
    if (cacheWorkers <= 1 || fullCacheOn || batchRunning) return;
    const targets = filesRef.current.filter((f) => f.status === "idle").map((f) => f.path);
    if (targets.length === 0) return;
    const preset = presetRef.current;
    if (!preset) return;

    preparingRef.current = true;
    setPreparing(true);
    const failures: Array<{ path: string; message: string }> = [];

    const handle = runPrepareQueue({
      paths: targets,
      workerCount: cacheWorkers,
      start: (count) => warmWorkersStart(count, PREVIEW_MAX_SIZE),
      send: (id, path) => warmWorkerSend(id, { path, prepare: { preset, maxSize: PREVIEW_MAX_SIZE } }),
      stop: warmWorkersStop,
      onLine: onWarmWorkerLine,
      onExit: onWarmWorkerExit,
      onProgress: (p) => setPrepareProgress({ done: p.filesDone, total: p.filesTotal }),
      onResult: (path, result) => void applyPreparedFile(path, result),
    });

    void handle.finished.then((out) => {
      setPrepareProgress(null);
      preparingRef.current = false;
      setPreparing(false);
      if (out.failed.length > 0) {
        pushError(`준비하지 못한 파일 ${out.failed.length}개`, {
          message: out.failed.map((f) => `${fileName(f.path)} — ${f.message}`).join("\n"),
          traceback: "",
        });
      }
      // 취소로 끝났으면(전체 캐시가 가져감) 남은 파일은 현행 순차 경로가
      // 이어받는다 — status가 "idle"로 남아 있으므로 로드 큐가 알아서 집는다.
    });
    return () => handle.cancel();
  }, [cacheWorkers, fullCacheOn, batchRunning, state.files, pushError, applyPreparedFile]);
```

- [ ] **Step 5: 결과를 상태에 반영하는 함수를 더한다**

`previewPlanFor` 아래에 더한다. **키는 프런트가 계산한다** — 워커가 만든 키를 믿지 않는다.

```tsx
  /**
   * 작업 프로세스가 준비한 파일 하나를 화면 상태에 반영한다.
   *
   * 캐시 키는 **여기서 계산한다.** 워커에게 받은 키를 쓰면 프런트와 워커 중
   * 어느 쪽이 옳은지 정할 수 없게 되고, 어긋난 순간 화면이 그림을 영영 못
   * 찾는다. previewRenderSpec으로 직접 만들면 화면이 나중에 찾을 키와 같은
   * 함수·같은 입력이므로 구조적으로 일치한다.
   *
   * 갓 준비한 파일은 눈·솔로·수동 지정이 없다 — 그래서 워커의
   * _preset_preview_args가 만든 그림과 여기 키가 같은 화면을 가리킨다.
   */
  const applyPreparedFile = useCallback(
    async (path: string, result: Record<string, unknown>) => {
      const r = result as unknown as {
        tree: TreeNode[]; mtime: number; width: number; height: number;
        colorMode: string; depth: number;
        matchedLayerIds: number[]; skippedLayers: SkippedLayer[];
        operations: Operation[]; pngPath: string | null; documentView: boolean;
      };
      // 세션 없이 "열림"으로 세운다. 세션은 화면이 그 파일을 실제로 쓸 때
      // 채워진다(Task 5의 previewPlanFor 호출부, withEvictedSessionRetry).
      dispatch({ type: "preparedFile", path, result: r });
      if (r.pngPath === null) return;

      const matched = [...r.matchedLayerIds].sort((a, b) => a - b);
      const spec = previewRenderSpec(
        { path, mtime: r.mtime },
        r.tree,
        matched,          // 갓 적용 상태의 includedIds = 매칭 결과
        [],               // 눈
        [],               // 솔로
        presetRef.current?.lineColor ?? null,
        matched,
        presetRef.current?.edgeLines ?? null,
        []                // 수동 색 지정
      );
      if (!spec.key) return;
      try {
        previewCacheRef.current.set(spec.key, await loadPngDataUrl(r.pngPath));
        prefetchedKeysRef.current.add(spec.key);
      } catch {
        // 그림을 못 읽어도 준비 자체는 성공이다 — 클릭하면 화면이 그린다.
      }
    },
    []
  );
```

- [ ] **Step 6: 리듀서에 `preparedFile`을 더한다**

`src/state/appStore.tsx`에 결과 타입과 액션을 더한다. `buildEntries`는 `src/lib/opsReducer.ts:74`에 있고 시그니처는 `buildEntries(includedIds: number[], ops: Operation[]): Entry[]`다 — `applyPresetResult`가 쓰는 것과 같다.

```ts
/** 작업 프로세스가 준비한 파일 하나(엔진 warmworker.prepare_file의 result).
 * open_psd 응답에서 **sessionId만 빠진 것** + apply_preset 응답 + 미리보기 경로. */
export interface PreparedFileResult {
  tree: TreeNode[];
  mtime: number;
  width: number;
  height: number;
  colorMode: string;
  depth: number;
  matchedLayerIds: number[];
  skippedLayers: SkippedLayer[];
  operations: Operation[];
  pngPath: string | null;
  documentView: boolean;
}
```

`AppAction`에:

```ts
  | { type: "preparedFile"; path: string; result: PreparedFileResult }
```

리듀서에 `openSuccess`와 같은 자리를 만든다. **`openSuccess`를 재사용하지 않는 이유:** `openSuccess`는 `result.sessionId`를 세우는데 준비 결과에는 그것이 없고, `restoredMtimeByPath` 판정도 함께 얹혀 있다. 별도 액션이 그 둘을 섞지 않는다.

```ts
    case "preparedFile": {
      const { path, result } = action;
      // 세션 없이 "열림". 프로젝트 복원(restoreProject)이 만드는 것과 같은
      // 모양이고, 세션은 화면이 그 파일을 쓸 때 로드 큐·렌더가 채운다.
      const files = state.files.map((f) =>
        f.path === path
          ? { ...f, status: "open" as const, tree: result.tree, mtime: result.mtime,
              width: result.width, height: result.height,
              colorMode: result.colorMode, depth: result.depth,
              presetApplied: true }
          : f
      );
      const includedIds = [...result.matchedLayerIds].sort((a, b) => a - b);
      return {
        ...state,
        files,
        matchedIdsByPath: { ...state.matchedIdsByPath, [path]: result.matchedLayerIds },
        opsByPath: {
          ...state.opsByPath,
          [path]: { ...EMPTY_OPS, includedIds, entries: buildEntries(includedIds, []) },
        },
      };
    }
```

- [ ] **Step 7: 진행바를 잇는다**

`FilePanel`은 이미 `loadProgress ?? prefetchProgress`를 **한 슬롯**에 그린다(`FilePanel.tsx:385`). 즉 막대를 새로 만들 필요가 없다 — 준비 진행을 `loadProgress` 자리에 라벨만 바꿔 넣으면 "여는 중"과 "미리보기 준비 중"이 자연히 하나가 된다.

`App.tsx`에 상태를 더한다(Task 6 Step 4의 효과가 `setPrepareProgress`를 부른다):

```tsx
  const [prepareProgress, setPrepareProgress] = useState<{ done: number; total: number } | null>(null);
```

`App.tsx:1789`의 prop을 바꾼다:

```tsx
        loadProgress={
          prepareProgress
            ? { ...prepareProgress, label: "파일 준비 중" }
            : loadProgress
              ? { ...loadProgress, label: "여는 중" }
              : null
        }
```

준비가 도는 동안 기존 두 패스는 비켜서 있으므로(다음 Step) 셋이 동시에 뜰 일은 없다. 순서를 준비 우선으로 두는 것은 안전망이다.

- [ ] **Step 8: 기존 두 패스가 비켜서게 한다**

`App.tsx:517`의 로드 큐 `cancelled`에 더한다:

```tsx
      cancelled: () => abandonedRef.current || loadCancelledRef.current || preparingRef.current,
```

`App.tsx:1212`의 준비 큐 `cancelled`에 더한다:

```tsx
      cancelled: () =>
        abandonedRef.current || prefetchCancelledRef.current || drainingRef.current ||
        batchRunningRef.current || preparingRef.current,
```

- [ ] **Step 9: 통과를 확인한다**

Run: `npx vitest run src/App.test.tsx --no-file-parallelism`
Expected: 신규 2개 PASS.

**기존 테스트 하나가 여기서 깨진다** — `with multiple workers the full cache covers files the app has not opened yet`(`App.test.tsx:1687`). 그 테스트는 워커를 2로 올린 **직후** 전체 캐시를 누르는데, 이제 2로 올리는 순간 준비 큐가 idle 파일 둘을 집어 작업 프로세스를 쥔다. Task 7의 대기 규칙이 들어가면 스윕이 안 나간다.

**고치는 방향은 Task 7에서 정한다.** 여기서는 실패를 확인만 하고 넘어간다 — Task 7이 그 테스트를 함께 고친다.

- [ ] **Step 10: 커밋**

```bash
npx tsc --noEmit
git add src/App.tsx src/state/appStore.tsx src/lib/engine.ts src/App.test.tsx
git commit -m "feat: prepare a folder's files across workers instead of one at a time"
```

> 이 커밋 시점에는 `App.test.tsx:1687`이 빨간불이다. Task 7이 같은 흐름의 마무리이므로 여기서 끊는 것이 맞다 — 다만 **Task 7을 건너뛰고 멈추면 안 된다.**

---

### Task 7: 전체 캐시 대기

파일 준비가 도는 중에 "전체 캐시"를 누르면 준비가 끝날 때까지 기다렸다 자동으로 이어서 시작한다.

**Files:**
- Modify: `src/App.tsx:1461-1470` (전체 캐시 효과에 가드 한 줄)
- Modify: `src/components/FilePanel.tsx:350-354` (버튼 문구)
- Test: `src/App.test.tsx`

**Interfaces:**
- Consumes: Task 6의 `preparing` state

- [ ] **Step 1: 실패하는 테스트를 쓴다**

```tsx
test("the full cache waits for file preparation, then takes over", async () => {
  let lineCb: ((e: { generation: number; id: number; line: string }) => void) | undefined;
  engine.onWarmWorkerLine.mockImplementation(async (cb: (e: { generation: number; id: number; line: string }) => void) => {
    lineCb = cb;
    return () => {};
  });
  engine.warmWorkersStart.mockResolvedValue({ generation: 5, ids: [0, 1] });

  render(<App />);
  await addFiles({ click });
  await finishOpen(0, 1);

  const workers = screen.getByTitle(/전체 캐시를 몇 개의 작업 프로세스/) as HTMLSelectElement;
  workers.value = "2";
  workers.dispatchEvent(new Event("change", { bubbles: true }));
  // 준비 큐가 남은 두 장을 집는다.
  await waitFor(() => expect(engine.warmWorkerSend.mock.calls.length).toBe(2));

  click(screen.getByRole("button", { name: "전체 캐시" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "파일 준비 후 시작" })).toBeTruthy());
  // 준비가 도는 동안 스윕은 출발하지 않는다 — 출발하면 준비하던 작업 프로세스가
  // 몰살당하고(warm.rs의 kill_all), 준비 큐는 남은 파일을 실패로 적는다.
  expect(engine.warmWorkerSend.mock.calls.every(
    (c) => (c[1] as { prepare?: unknown }).prepare !== undefined)).toBe(true);

  // 준비가 끝나면 효과가 다시 돌아 스윕이 알아서 이어진다.
  const prepared = {
    tree: treeOf([1, 2, 3]), mtime: 1, width: 10, height: 10,
    colorMode: "RGB", depth: 8, matchedLayerIds: [1], skippedLayers: [],
    operations: [], pngPath: null, documentView: false,
  };
  for (const call of engine.warmWorkerSend.mock.calls.slice(0, 2)) {
    const [id, job] = call as [number, { path: string }];
    lineCb!({ generation: 5, id,
      line: JSON.stringify({ event: "file", path: job.path, ok: true, result: prepared }) });
  }

  await waitFor(() =>
    expect(engine.warmWorkerSend.mock.calls.some(
      (c) => (c[1] as { presets?: unknown }).presets !== undefined)).toBe(true));
  // 가짜 오류 카드가 뜨면 안 된다 — 취소는 실패가 아니다.
  expect(screen.queryByText(/준비하지 못한 파일/)).toBeNull();
});
```

- [ ] **Step 2: 실패를 확인한다**

Run: `npx vitest run src/App.test.tsx --no-file-parallelism -t "waits for file preparation"`
Expected: FAIL — 스윕이 즉시 출발한다.

- [ ] **Step 3: 가드를 더한다**

`src/App.tsx:1470`의 `if (batchRunning) return;` **바로 아래**:

```tsx
    // 파일 준비가 작업 프로세스를 쥐고 있으면 기다린다. 여기서 스폰하면
    // (warmWorkersStart가 이전 세대를 죽인다) 준비하던 프로세스가 몰살당하고,
    // 준비 큐는 남은 파일을 실패로 적어 가짜 오류 카드를 낸다.
    //
    // 기다리는 것이 손해가 아니다: 준비가 구운 미리보기는 이 스윕이 쓸 디스크
    // 캐시와 같은 키로 들어가므로 스윕이 그 단계를 건너뛰고, 준비가 끝나면
    // 모든 파일의 트리를 알아 아래 총량 추정(estimated)도 정확해진다.
    // preparing이 deps에 있으므로 준비가 끝나면 효과가 다시 돌아 이어진다 —
    // 바로 위 batchRunning과 같은 장치다.
    if (preparing) return;
```

deps 배열에 `preparing`을 더한다:

```tsx
  }, [fullCacheOn, cacheWorkers, batchRunning, preparing, handleFullCacheToggle, pushError]);
```

- [ ] **Step 4: 버튼 문구**

`src/components/FilePanel.tsx`에 `preparing` prop을 더하고, 버튼 라벨에 반영한다:

```tsx
  {fullCacheRunning
    ? "캐시 중지"
    : fullCacheQueued
      ? "파일 준비 후 시작"
      : "전체 캐시"}
```

`fullCacheQueued`는 `fullCacheOn && preparing`이다. `App.tsx:1818` 부근에서 넘긴다.

- [ ] **Step 5: Task 6에서 깨진 기존 테스트를 고친다**

`App.test.tsx:1687` `with multiple workers the full cache covers files the app has not opened yet`. 워커를 2로 올린 직후 전체 캐시를 누르는데, 이제 그 순간 준비 큐가 idle 파일 둘을 쥐고 있어 스윕이 대기한다.

**테스트의 의도를 지키면서 고친다.** 그 테스트가 잠그는 것은 *"스윕 대상이 앱에서 안 연 파일까지 목록 전체"*이지 스폰 타이밍이 아니다. 그러니 **준비를 먼저 끝낸 뒤** 전체 캐시를 누르게 바꾼다 — 실사용 순서와도 같다.

`workers.value = "2"` 뒤, `click(... "전체 캐시")` 앞에 더한다:

```tsx
  // 워커를 올리면 준비 큐가 먼저 남은 파일을 집는다(파일 준비 병렬화).
  // 스윕은 준비가 끝난 뒤에 출발하므로, 여기서 준비를 끝내 준다.
  await waitFor(() => expect(engine.warmWorkerSend.mock.calls.length).toBe(2));
  const preparedResult = {
    tree: treeOf([1, 2, 3]), mtime: 1, width: 10, height: 10,
    colorMode: "RGB", depth: 8, matchedLayerIds: [1], skippedLayers: [],
    operations: [], pngPath: null, documentView: false,
  };
  for (const call of engine.warmWorkerSend.mock.calls.slice(0, 2)) {
    const [id, job] = call as [number, { path: string }];
    lineCb!({ generation: 3, id,
      line: JSON.stringify({ event: "file", path: job.path, ok: true, result: preparedResult }) });
  }
  await waitFor(() => expect(screen.queryAllByText("열림").length).toBe(3));
  engine.warmWorkerSend.mockClear();   // 아래 단언은 스윕이 보낸 것만 센다
```

`mockClear()` 뒤이므로 그 아래 `warmWorkerSend.mock.calls` 단언(인덱스 0·1·2와 `sent`)은 그대로 두면 스윕 것만 센다. `warmWorkersStart`가 **두 번** 불린 것도 정상이다(준비 한 번, 스윕 한 번) — `toHaveBeenCalledWith`는 그대로 통과한다.

- [ ] **Step 6: 통과를 확인한다**

Run: `npx vitest run src/App.test.tsx --no-file-parallelism`
Expected: 전부 PASS — 신규 1개 + Task 6의 신규 2개 + 고친 기존 1개 포함.

실패가 남으면 **직렬 단독 재실행**으로 플레이크인지부터 가른다. 이 파일은 부하에 약하다.

- [ ] **Step 7: 커밋**

```bash
npx tsc --noEmit && npm test -- --no-file-parallelism
git add src/App.tsx src/components/FilePanel.tsx src/App.test.tsx
git commit -m "feat: let the full cache wait for file preparation and take over"
```

---

### Task 8: 실측 재측정과 앱 확인

**Files:**
- Modify: `docs/superpowers/plans/2026-08-14-parallel-file-preparation.md` (실측 기록)

- [ ] **Step 1: 전체 테스트**

```bash
cd engine && uv run pytest
cd .. && npm test -- --no-file-parallelism
npx tsc --noEmit
```

Expected: 전부 통과. `App.test.tsx` 실패가 나오면 **직렬 단독 재실행**으로 플레이크인지부터 가른다 — 이 파일은 부하에 약하다.

- [ ] **Step 2: 사용자가 앱에서 확인한다**

`pnpm run tauri dev`. **엔진을 고쳤으므로 HMR로 안 온다 — 앱을 재시작해야 한다.**

확인 항목:
1. 작업 프로세스 2개 이상으로 폴더(100장급)를 로드했을 때 파일이 **여러 장씩** 준비되는가
2. 준비된 파일을 클릭하면 그림이 즉시 뜨는가 (RAM 캐시 히트)
3. 준비 중에 "전체 캐시"를 누르면 버튼이 "파일 준비 후 시작"이 되고, 준비가 끝난 뒤 스윕이 이어지는가
4. 가짜 오류 카드("준비하지 못한 파일 N개")가 안 뜨는가
5. 작업 프로세스 1개면 예전과 똑같이 도는가
6. 배치 내보내기 중에는 준비가 작업 프로세스를 안 쓰는가

- [ ] **Step 3: 기준선과 비교한다**

Task 1과 **같은 폴더·같은 프리셋**으로 앱에서 벽시계를 잰다(준비 진행바가 사라질 때까지). 작업 프로세스 1·2·4로 각각.

Task 1의 순차 합과 비교해 배율을 적는다. **배율이 1.5배 미만이면 멈추고 원인을 찾는다** — 작업 프로세스가 실제로 병렬로 돌지 않거나(스폰 실패, 큐가 한 번에 하나씩 먹임), 병목이 워커 밖(파일 I/O, NAS 대역폭)에 있다는 뜻이다.

- [ ] **Step 4: 실측을 기록하고 커밋**

이 문서 아래 "## 실측 기록"에 적는다.

```bash
git add docs/superpowers/plans/2026-08-14-parallel-file-preparation.md
git commit -m "docs: record the parallel file-preparation measurements"
```

- [ ] **Step 5: 사용자에게 물을 것**

기본 작업 프로세스 개수가 **1**이다(`App.tsx:95`). 즉 설정을 안 건드린 사용자는 이 개선을 못 받는다. 기본값을 2로 올릴지는 **사용자 결정**이다 — 메모리(16GB 기계에서 2개가 안전선)와 실측 배율을 함께 제시하고 묻는다. 임의로 바꾸지 말 것.

---

## 실측 기록

_Task 1과 Task 8이 채운다._

| 조건 | 파일 수 | 벽시계 | 배율 |
|---|---|---|---|
| 순차 (기준선, 콜드) | | | 1.0 |
| 순차 (기준선, 웜) | | | |
| 작업 프로세스 2 | | | |
| 작업 프로세스 4 | | | |
