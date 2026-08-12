"""전체 캐시 워커 — 경로를 받아 디스크 캐시를 채우고 진행을 알리는지."""
import io
import json
import os

import pytest

import psd_engine.render as render_mod
import psd_engine.tilecache as tilecache
from psd_engine.warmworker import main as worker_main


@pytest.fixture(autouse=True)
def cache_dir(tmp_path, monkeypatch):
    d = tmp_path / "tilecache"
    monkeypatch.setenv("PSD_ENGINE_TILE_CACHE_DIR", str(d))
    return d


def _run(lines):
    out = io.StringIO()
    worker_main(stdin=io.StringIO("".join(lines)), stdout=out, max_size=256)
    return [json.loads(l) for l in out.getvalue().splitlines()]


def test_worker_fills_the_disk_cache_and_reports_progress(fixture_psd):
    events = _run([json.dumps({"path": str(fixture_psd)}) + "\n"])

    assert events[0] == {"event": "ready"}
    done = [e for e in events if e["event"] == "file"]
    assert len(done) == 1 and done[0]["ok"] is True and done[0]["total"] > 0
    # 프런트가 "쓸었다"(path+mtime)를 기록할 수 있게 mtime을 실어 보낸다 —
    # 앱이 아직 안 연 파일은 프런트가 mtime을 모른다.
    assert done[0]["mtime"] == os.path.getmtime(fixture_psd)
    # 드로잉 레이어 한 장마다 진행을 알린다 — 마지막 진행이 총량과 같다.
    progress = [e for e in events if e["event"] == "progress"]
    assert len(progress) == done[0]["total"]
    assert progress[-1]["done"] == progress[-1]["total"] == done[0]["total"]

    # 디스크에 실제로 쌓였는지 — 워커가 만든 키를 메인 엔진이 그대로 읽는다.
    mtime = os.path.getmtime(fixture_psd)
    scale = 256 / 64  # 캔버스 64x48, max_size 256 → preview_scale은 1.0로 캡
    scale = min(scale, 1.0)
    session = {"path": str(fixture_psd), "mtime": mtime}
    assert tilecache.has(session, 5, scale)


def test_worker_survives_a_broken_file_and_continues(fixture_psd, tmp_path):
    missing = tmp_path / "없는파일.psd"
    events = _run([
        json.dumps({"path": str(missing)}) + "\n",
        json.dumps({"path": str(fixture_psd)}) + "\n",
    ])
    files = [e for e in events if e["event"] == "file"]
    assert files[0]["ok"] is False and "message" in files[0]
    assert files[1]["ok"] is True


def test_worker_decodes_without_the_warmup_skip(fixture_psd, monkeypatch):
    # 메인 엔진의 워밍업은 예상 10초 초과 드로잉 레이어를 건너뛴다. 워커는
    # 자기 프로세스라 그 제약이 없다 — 상한을 0으로 내려도 전부 치러야 한다.
    monkeypatch.setattr(render_mod, "WARM_MAX_PREDICTED_S", 0.0)
    events = _run([json.dumps({"path": str(fixture_psd)}) + "\n"])
    done = [e for e in events if e["event"] == "file"]
    assert done[0]["ok"] is True
    assert done[0]["total"] == len([e for e in events if e["event"] == "progress"])


def test_worker_prewarms_overlays_the_engine_then_reads(tmp_path, monkeypatch):
    # "전체 캐시 완료 = 어떤 파일이든 즉시"가 경계선까지 참이려면, 워커가 쌓은
    # 오버레이를 엔진 렌더가 계산 없이 읽어야 한다 — 키(뷰 구성+설정)가 두 경로에서
    # 비트까지 같아야 성립하는 주장이라, 통합으로 잠근다.
    import io as _io
    import psd_engine.rpc as rpc
    from test_rpc import _two_view_psd

    p = _two_view_psd(tmp_path)
    _run([json.dumps({"path": str(p), "edgeLines": {"enabled": True}}) + "\n"])

    calls = []
    real = rpc.plan_overlays
    def spy(session, views, opts):
        calls.append(views)
        return real(session, views, opts)
    monkeypatch.setattr(rpc, "plan_overlays", spy)

    engine = rpc.Engine(out=_io.StringIO())
    sid = engine.open_psd(str(p))["sessionId"]
    s = engine.store.get(sid)
    front_line_id = next(
        lid for lid, l in s["layers_by_id"].items()
        if l.name == "LINES" and l.parent.name == "FRONT")
    engine.render_preview(sid, visibleLayerIds=[front_line_id],
                          edgeLines={"enabled": True})
    assert calls == [], "워커가 쌓아 둔 오버레이를 엔진이 다시 계산했다 — 키가 어긋난 것"


def test_worker_counts_views_in_its_progress_total(tmp_path):
    # 오버레이(뷰당 9~36초)도 진행에 잡혀야 바가 멈춘 것처럼 보이지 않는다.
    from test_rpc import _two_view_psd
    p = _two_view_psd(tmp_path)
    events = _run([json.dumps({"path": str(p), "edgeLines": {"enabled": True}}) + "\n"])
    done = [e for e in events if e["event"] == "file"][0]
    progress = [e for e in events if e["event"] == "progress"]
    assert done["total"] == len(progress)
    plain = _run([json.dumps({"path": str(p)}) + "\n"])
    plain_done = [e for e in plain if e["event"] == "file"][0]
    assert done["total"] > plain_done["total"], "뷰 몫이 총량에 안 잡혔다"


# ---- 프리셋 미리보기 미리 굽기 ----

#: 프런트 BG 프리셋의 매칭 부분과 같은 모양(src/lib/presets.ts). 워커가 이걸
#: 받아 "갓 적용한 화면"의 미리보기를 굽는다.
_PRESET = {
    "name": "BG",
    "include": {"type": "contains", "value": "line", "caseSensitive": False},
    "matchGroups": True,
    "includeHidden": True,
    "excludeGroupPrefixes": ["-"],
    "lineColor": "#000000",
    "edgeLines": {"enabled": False},
}


def _front_render_args(opened, matched):
    """프런트가 프리셋을 갓 적용한 화면으로 render_preview에 보내는 인자를
    그대로 재현한다 — appStore.applyPresetResult(정렬)와
    preview.visibleIdsForPreview(문서 순서 픽셀 잎), previewCache.lineColorIdsFor,
    engine.renderPreview(payload의 manualColourIds: [])의 합이다."""
    included = sorted(matched)
    included_set = set(included)
    visible = []

    def walk(nodes):
        for n in nodes:
            if n["kind"] == "group":
                walk(n.get("children") or [])
            elif n["kind"] == "pixel" and n["id"] in included_set:
                visible.append(n["id"])

    walk(opened["tree"])
    matched_set = set(matched)
    return {
        "visibleLayerIds": visible,
        "includedIds": included,
        "lineColor": _PRESET["lineColor"],
        "lineColorIds": [i for i in visible if i in matched_set],
        "edgeLines": {**_PRESET["edgeLines"], "manualColourIds": []},
    }


def test_worker_prebakes_the_preset_preview_the_engine_then_reads(fixture_psd, monkeypatch):
    # 핵심 주장: 워커가 프리셋으로 구운 미리보기 PNG를, 화면이 같은 프리셋을 갓
    # 적용해 부르는 render_preview가 **합성 없이** 읽는다. 키 재료가 세 곳
    # (프런트 파생 → RPC 인자, 워커의 _preset_preview_args, rpc._preview_key_material)
    # 에서 같아야 성립하는 주장이라 통합으로 잠근다.
    import psd_engine.rpc as rpc

    _run([json.dumps({"path": str(fixture_psd), "presets": [_PRESET]}) + "\n"])

    engine = rpc.Engine(out=io.StringIO())
    opened = engine.open_psd(str(fixture_psd))
    matched = engine.apply_preset(opened["sessionId"], _PRESET)["matchedLayerIds"]
    args = _front_render_args(opened, matched)
    assert args["visibleLayerIds"], "매칭이 비면 이 테스트는 아무것도 검증하지 않는다"

    def boom(*a, **k):
        raise AssertionError("합성이 다시 돌았다 — 워커가 구운 그림을 못 찾은 것")

    monkeypatch.setattr(rpc, "render_preview", boom)
    r = engine.render_preview(opened["sessionId"], maxSize=256, **args)
    assert r["pngPath"]


def test_worker_counts_preset_previews_in_its_progress_total(fixture_psd):
    plain = _run([json.dumps({"path": str(fixture_psd)}) + "\n"])
    with_presets = _run([
        json.dumps({"path": str(fixture_psd), "presets": [_PRESET]}) + "\n"])
    plain_total = [e for e in plain if e["event"] == "file"][0]["total"]
    total = [e for e in with_presets if e["event"] == "file"][0]["total"]
    progress = [e for e in with_presets if e["event"] == "progress"]
    assert total == plain_total + 1  # 프리셋 하나 = 미리보기 한 장
    assert len(progress) == total


def test_worker_skips_presets_with_nothing_to_draw(fixture_psd):
    # 매칭 0장 프리셋은 화면도 합성하지 않으므로 구울 것이 없다 — 총량에 안 잡힌다.
    blank = {**_PRESET, "include": {"type": "contains", "value": "없는이름",
                                    "caseSensitive": False}}
    events = _run([json.dumps({"path": str(fixture_psd), "presets": [blank]}) + "\n"])
    plain = _run([json.dumps({"path": str(fixture_psd)}) + "\n"])
    assert [e for e in events if e["event"] == "file"][0]["total"] == \
        [e for e in plain if e["event"] == "file"][0]["total"]


def test_worker_prebakes_the_char_preset_preview_with_edge_lines(tmp_path, monkeypatch):
    # CHAR 프리셋(경계선 켜짐) 판. 히트면 오버레이 계획(plan_overlays, 뷰당
    # 9~36초)조차 돌지 않아야 한다 — 캐시 확인이 뷰 계산보다 먼저다.
    import psd_engine.rpc as rpc
    from test_rpc import _two_view_psd

    char = {**_PRESET, "name": "CHAR", "edgeLines": {"enabled": True}}
    p = _two_view_psd(tmp_path)
    _run([json.dumps({"path": str(p), "presets": [char]}) + "\n"])

    engine = rpc.Engine(out=io.StringIO())
    opened = engine.open_psd(str(p))
    matched = engine.apply_preset(opened["sessionId"], char)["matchedLayerIds"]
    included = sorted(matched)
    included_set, matched_set = set(included), set(matched)
    visible = []

    def walk(nodes):
        for n in nodes:
            if n["kind"] == "group":
                walk(n.get("children") or [])
            elif n["kind"] == "pixel" and n["id"] in included_set:
                visible.append(n["id"])

    walk(opened["tree"])
    assert len(visible) == 2  # FRONT/BACK의 LINES 둘

    def boom(*a, **k):
        raise AssertionError("캐시 히트여야 하는데 합성/오버레이 계산이 돌았다")

    monkeypatch.setattr(rpc, "render_preview", boom)
    monkeypatch.setattr(rpc, "plan_overlays", boom)
    r = engine.render_preview(
        opened["sessionId"], visibleLayerIds=visible, maxSize=256,
        lineColor=char["lineColor"],
        lineColorIds=[i for i in visible if i in matched_set],
        edgeLines={"enabled": True, "manualColourIds": []},
        includedIds=included)
    assert r["pngPath"]


# ---- 배치 내보내기 잡 ----

#: _PRESET에 내보내기 필드를 더한 것 — batch._process_one이 읽는 값들.
_EXPORT_PRESET = {**_PRESET, "naming": "original", "outputSuffix": "_LINE",
                  "outputFormat": "psd", "merge": "none", "embedPreview": True}


def test_worker_exports_a_file_like_the_serial_batch(fixture_psd, tmp_path):
    out_dir = tmp_path / "산출"
    out_dir.mkdir()
    events = _run([json.dumps({
        "path": str(fixture_psd),
        "export": {"preset": _EXPORT_PRESET, "outputDir": str(out_dir)},
    }) + "\n"])
    files = [e for e in events if e["event"] == "file"]
    assert files[0]["ok"] is True
    result = files[0]["result"]
    # run_batch의 항목과 같은 모양 — 프런트 보고서가 그대로 읽는다.
    assert result["verification"]["ok"] is True
    assert os.path.isfile(result["outputPath"])
    assert result["outputPath"].startswith(str(out_dir))
    # 진행이 배치의 단계 이벤트 모양으로 나온다 — BatchPanel이 문구로 보여준다.
    stages = [e for e in events if e["event"] == "progress"]
    assert stages and all("stage" in e and "current" in e for e in stages)


def test_worker_export_failure_carries_the_batch_error_entry(tmp_path):
    missing = tmp_path / "없는판.psd"
    events = _run([json.dumps({
        "path": str(missing), "export": {"preset": _EXPORT_PRESET},
    }) + "\n"])
    ev = [e for e in events if e["event"] == "file"][0]
    assert ev["ok"] is False
    # 실패도 run_batch 항목 모양(error.message/traceback) — 흡수 금지 정책 그대로.
    assert ev["result"]["ok"] is False
    assert ev["result"]["error"]["traceback"]
    # 워커는 살아서 다음 줄을 기다린다 — 이어지는 워밍업 잡이 정상 처리된다.


def test_worker_alternates_export_and_warm_jobs(fixture_psd, tmp_path):
    out_dir = tmp_path / "산출2"
    out_dir.mkdir()
    events = _run([
        json.dumps({"path": str(fixture_psd),
                    "export": {"preset": _EXPORT_PRESET,
                               "outputDir": str(out_dir)}}) + "\n",
        json.dumps({"path": str(fixture_psd)}) + "\n",
    ])
    files = [e for e in events if e["event"] == "file"]
    assert [f["ok"] for f in files] == [True, True]
    assert "result" in files[0] and "result" not in files[1]
