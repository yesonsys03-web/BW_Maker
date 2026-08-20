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


def test_worker_skips_overlay_warming_for_views_no_preset_will_check(tmp_path):
    # 프리셋이 라인을 못 잡는 뷰는 렌더·내보내기가 계획하지 않으므로(included
    # 사전 필터) 워커도 데우지 않는다 — COLOR PALETTE류 참조 뷰를 데우면 뷰당
    # 9~36초를 아무도 안 읽을 캐시에 쓴다. 매칭이 빈 프리셋이면 뷰 몫이 총량에서
    # 통째로 빠져 잎 수와 같아야 한다.
    from test_rpc import _two_view_psd
    p = _two_view_psd(tmp_path)
    blank = {**_PRESET,
             "include": {"type": "contains", "value": "없는이름",
                         "caseSensitive": False},
             "edgeLines": {"enabled": True}}
    events = _run([json.dumps({"path": str(p), "presets": [blank]}) + "\n"])
    plain = _run([json.dumps({"path": str(p)}) + "\n"])
    assert [e for e in events if e["event"] == "file"][0]["total"] == \
        [e for e in plain if e["event"] == "file"][0]["total"]


# include는 dict 형태({"type","value",...})여야 한다 — 이 파일의 _PRESET,
# test_matching.py, src/lib/presets.ts의 Preset["include"]와 같다. 브리프
# 원문의 "include": []는 실제 프리셋 스키마와 맞지 않아(list라 "type" 접근에서
# TypeError) 여기서 바로잡았다.
_PREPARE_PRESET = {"name": "T",
                    "include": {"type": "contains", "value": "line",
                                "caseSensitive": False},
                    "merge": "none"}


def test_prepare_returns_the_tree_and_the_preset_match(fixture_psd):
    events = _run([json.dumps(
        {"path": str(fixture_psd),
         "prepare": {"preset": _PREPARE_PRESET, "maxSize": 256}}
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
    events = _run([json.dumps(
        {"path": str(missing),
         "prepare": {"preset": _PREPARE_PRESET, "maxSize": 256}}
    ) + "\n"])

    done = [e for e in events if e["event"] == "file"]
    assert len(done) == 1 and done[0]["ok"] is False
    assert "message" in done[0]


def test_prepare_survives_a_malformed_job_and_continues(fixture_psd):
    # "preset"이 빠진 prepare 잡. main()이 msg["prepare"]["preset"]을 자기
    # try 밖에서 읽으면 여기서 KeyError가 나 for 루프(워커 전체)가 죽는다 —
    # export_file과 같은 모양(job을 통째로 받아 자기 try 안에서 읽는다)이어야
    # 이 잡도 그냥 실패 이벤트 하나로 끝나고 다음 줄을 계속 읽는다.
    events = _run([
        json.dumps({"path": str(fixture_psd), "prepare": {}}) + "\n",
        json.dumps(
            {"path": str(fixture_psd),
             "prepare": {"preset": _PREPARE_PRESET, "maxSize": 256}}
        ) + "\n",
    ])
    files = [e for e in events if e["event"] == "file"]
    assert len(files) == 2
    assert files[0]["ok"] is False and "message" in files[0]
    assert files[1]["ok"] is True and "result" in files[1]


def test_prepare_bakes_the_preview_the_main_engine_would_render(fixture_psd, tmp_path):
    """워커가 구운 그림을 메인 엔진의 렌더가 **디스크 히트로** 찾아야 한다.

    이 테스트가 이 트랙의 계약이다 — 키가 어긋나면 워커가 100장을 구워도
    클릭은 전부 다시 합성한다. rpc.py의 _preview_key_material 주석이 경고하는
    "세 곳이 같은 키로 접혀야 한다"를 기계로 잠근다.
    """
    import psd_engine.tilecache as tc
    from psd_engine.rpc import Engine, _preview_key_material
    from psd_engine.warmworker import _preset_preview_args

    preset = _PREPARE_PRESET   # Task 2가 모듈 상단에 둔 상수를 그대로 쓴다
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

    preset = _PREPARE_PRESET   # Task 2가 모듈 상단에 둔 상수를 그대로 쓴다
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


def test_worker_measures_stroke_features_and_emits_them(fixture_psd):
    """스윕이 잎 특징을 재서 사이드카에 쓰고 strokes 이벤트로 알린다 —
    "캐시완료 = 검출완료"(클릭 없이 배치에 검출 반영)의 엔진 쪽 절반이다."""
    events = _run([json.dumps({"path": str(fixture_psd)}) + "\n"])
    strokes = [e for e in events if e["event"] == "strokes"]
    assert len(strokes) == 1 and strokes[0]["path"] == str(fixture_psd)
    feats = strokes[0]["features"]
    assert feats
    mtime = os.path.getmtime(fixture_psd)
    assert tilecache.load_strokes(str(fixture_psd), mtime) == feats


def test_worker_reuses_cached_features_without_remeasuring(fixture_psd, monkeypatch):
    """재스윕은 사이드카를 읽지 다시 재지 않는다 — 측정이 공짜인 것은 디코드와
    겹칠 때뿐이고, 타일이 이미 있으면 디코드도 측정도 없어야 한다."""
    _run([json.dumps({"path": str(fixture_psd)}) + "\n"])

    import psd_engine.warmworker as worker_mod

    def boom(*a, **k):
        raise AssertionError("재스윕이 특징을 다시 쟀다")

    monkeypatch.setattr(worker_mod, "measure_strokes_rgba", boom)
    monkeypatch.setattr(worker_mod, "measure_strokes", boom)
    events = _run([json.dumps({"path": str(fixture_psd)}) + "\n"])
    strokes = [e for e in events if e["event"] == "strokes"]
    assert len(strokes) == 1 and strokes[0]["features"]


def test_preset_preview_includes_detected_drawn_lines(tmp_path):
    """스윕 후 앱의 "갓 적용" 화면은 검출 지정이 실린 화면이다 — 그 그림으로
    구워야 클릭이 미리보기 캐시를 탄다. 매칭만으로 구우면 키가 어긋나 매 클릭이
    실시간 합성(직렬 엔진, 파일당 9~41초)으로 가고, 앱의 준비 큐가 전 파일을
    다시 굽느라 엔진이 몇 시간 갈린다(2026-08-20 실증). 색 통일은 여전히
    매칭만이다(프런트 lineColorIdsFor 미러 — 지정 잎은 원본 색)."""
    from conftest import make_image, write_psd
    from test_linedetect import make_hatch

    from psd_tools import PSDImage

    from psd_engine.linedetect import measure_strokes
    from psd_engine.tree import build_tree
    from psd_engine.warmworker import _preset_preview_args

    src = tmp_path / "plate.psd"
    write_psd(src, [make_hatch("rope details"),
                    make_image("line art", 200, 4, 4, 40, 32),
                    make_image("backdrop", 128, 0, 0, 60, 40)])
    built = build_tree(PSDImage.open(str(src)))
    ids = {l.name: lid for lid, l in built["layers_by_id"].items() if not l.is_group()}
    feats = {str(lid): measure_strokes(layer)
             for lid, layer in built["layers_by_id"].items() if not layer.is_group()}
    policy = {"survive2Max": 0.25, "coverageMax": 0.15, "minNativePx": 1,
              "excludeGroups": [], "excludeTokens": []}
    preset = {"include": {"type": "contains", "value": "line", "caseSensitive": False},
              "excludeGroupPrefixes": [], "matchGroups": True, "includeHidden": True,
              "merge": "none", "naming": "pathPrefix", "outputSuffix": "_L",
              "embedPreview": True, "lineColor": "#000000"}

    plain = _preset_preview_args(built["tree"], preset)
    assert ids["rope details"] not in plain["included"]  # 특징 없으면 기존 그대로

    args = _preset_preview_args(built["tree"], preset, feats=feats, drawn_lines=policy)
    assert ids["rope details"] in args["included"] and ids["line art"] in args["included"]
    assert ids["rope details"] in args["visible"]
    assert ids["line art"] in args["lineColorIds"]
    assert ids["rope details"] not in args["lineColorIds"]


def test_prepare_returns_sidecar_features(fixture_psd):
    """같은 폴더 재로드: 준비가 사이드카 특징을 결과에 실어 보내 앱이 지정·배지를
    복원하고, 준비가 구운 미리보기와 키가 맞는다."""
    mtime = os.path.getmtime(fixture_psd)
    feats = {"5": {"coverage": 0.02, "survive1": 0.0, "survive2": 0.0,
                   "nNative": 30000}}
    tilecache.store_strokes(str(fixture_psd), mtime, feats)
    events = _run([json.dumps({"path": str(fixture_psd),
                               "prepare": {"preset": _PREPARE_PRESET,
                                           "maxSize": 256}}) + "\n"])
    done = [e for e in events if e["event"] == "file"]
    assert done[0]["ok"] is True
    assert done[0]["result"]["strokeFeatures"] == feats
