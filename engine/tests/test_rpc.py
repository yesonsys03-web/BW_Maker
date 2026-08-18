import io
import json
import os
import subprocess
import sys

from psd_engine import rpc, viewpool


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
        events = []
        while True:
            line = self.p.stdout.readline()
            msg = json.loads(line)
            if msg.get("event"):
                events.append(msg)
                continue                      # progress 이벤트는 수집하되 계속
            # For normal responses, id should match. For parsing errors, id is None.
            if msg["id"] is not None:
                assert msg["id"] == self._id
            msg["_events"] = events
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
        resp = eng.call("export_psd", sessionId=sid,
                        includedIds=[3, 4, 5], operations=[], naming="pathPrefix",
                        outputPath=out_path)
        r = resp["result"]
        assert r["layerCount"] == 3
        assert r["verification"]["ok"] is True
        # Verify progress events were emitted during export
        assert len(resp["_events"]) > 0, "export_psd should emit progress events"
        assert all(e.get("event") == "progress" for e in resp["_events"])
        assert all("stage" in e for e in resp["_events"])

        r = eng.call("close_session", sessionId=sid)
        assert r["result"] == {}
    finally:
        eng.close()


def test_export_png_over_rpc(fixture_psd, tmp_path):
    """실제 서브프로세스로 열기 → PNG 내보내기 → 검증까지."""
    eng = EngineProc()
    try:
        doc = eng.call("open_psd", path=str(fixture_psd))["result"]
        sid = doc["sessionId"]
        # 픽셀 레이어 id — test_rpc_full_flow(:41)와 같은 fixture_psd에서
        # 확인된 세 픽셀 레이어(hidden line, line, lines)의 id다.
        out = tmp_path / "out.png"
        resp = eng.call(
            "export_psd", sessionId=sid, includedIds=[3, 4, 5], operations=[],
            naming="pathPrefix", outputPath=str(out), outputFormat="png",
        )
        assert "result" in resp, resp.get("error")
        assert resp["result"]["verification"]["ok"] is True
        assert out.is_file()
    finally:
        eng.close()


def test_export_png_split_over_rpc(fixture_psd, tmp_path):
    """분할 PNG 내보내기: 파일마다 그 파일에 들어간 엔트리 하나로 검증돼야 한다.

    entries 전체를 넘기면 각 파일이 세 레이어를 합친 것과 비교돼 ok가 거짓이
    된다 — 그 회귀를 잡는 테스트다.
    """
    eng = EngineProc()
    try:
        doc = eng.call("open_psd", path=str(fixture_psd))["result"]
        sid = doc["sessionId"]
        out = tmp_path / "out.png"
        resp = eng.call(
            "export_psd", sessionId=sid, includedIds=[3, 4, 5], operations=[],
            naming="pathPrefix", outputPath=str(out), outputFormat="png",
            splitLayers=True,
        )
        assert "result" in resp, resp.get("error")
        r = resp["result"]

        assert len(r["outputs"]) == 3
        for o in r["outputs"]:
            assert os.path.isfile(o["outputPath"])
            assert o["verification"]["ok"] is True

        assert r["verification"]["ok"] is True
        assert os.path.isdir(r["outputPath"])
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
        assert "unknown method" in r["error"]["message"]
    finally:
        eng.close()


def test_rpc_invalid_json_doesnt_crash_engine(fixture_psd):
    eng = EngineProc()
    try:
        # Send invalid JSON
        eng.p.stdin.write("not json\n")
        eng.p.stdin.flush()
        # Read error response (will have id: null since JSON parsing failed)
        line = eng.p.stdout.readline()
        msg = json.loads(line)
        assert msg["id"] is None
        assert "error" in msg
        # Engine should still work after bad JSON
        r = eng.call("open_psd", path=str(fixture_psd))["result"]
        assert r["sessionId"]
        eng.call("close_session", sessionId=r["sessionId"])
    finally:
        eng.close()


def test_rpc_non_dict_json_doesnt_crash_engine(fixture_psd):
    eng = EngineProc()
    try:
        # Valid JSON, but not an object (e.g. a bare array)
        eng.p.stdin.write("[1,2,3]\n")
        eng.p.stdin.flush()
        line = eng.p.stdout.readline()
        msg = json.loads(line)
        assert msg["id"] is None
        assert "error" in msg
        # Engine should still work after a non-dict JSON line
        r = eng.call("open_psd", path=str(fixture_psd))["result"]
        sid = r["sessionId"]
        assert sid
        r2 = eng.call("close_session", sessionId=sid)
        assert r2["result"] == {}
    finally:
        eng.close()


def test_render_preview_no_path_collision_across_calls(fixture_psd):
    # render_preview must not overwrite its previous output on re-render
    # (webview cache would otherwise serve stale images).
    engine = rpc.Engine(out=io.StringIO())
    r = engine.open_psd(str(fixture_psd))
    sid = r["sessionId"]

    r1 = engine.render_preview(sid, visibleLayerIds=[2, 5], maxSize=32)
    r2 = engine.render_preview(sid, visibleLayerIds=[2, 5], maxSize=32)

    assert r1["pngPath"] != r2["pngPath"]
    assert os.path.exists(r2["pngPath"])


def test_superseded_preview_survives_the_next_render(fixture_psd):
    # 프런트는 render_preview 응답을 받은 뒤 pngPath를 별도의 IPC 왕복으로
    # 읽는다(read_file_b64). 그 사이 다음 render_preview가 시작돼도 방금
    # 돌려준 PNG는 아직 읽을 수 있어야 한다 — 즉시 삭제하면 실사용에서
    # "preview.png: No such file or directory"로 미리보기가 깨진다.
    engine = rpc.Engine(out=io.StringIO())
    r = engine.open_psd(str(fixture_psd))
    sid = r["sessionId"]

    r1 = engine.render_preview(sid, visibleLayerIds=[2, 5], maxSize=32)
    engine.render_preview(sid, visibleLayerIds=[2, 5], maxSize=32)

    assert os.path.exists(r1["pngPath"])


def test_render_dirs_do_not_accumulate_across_kinds(fixture_psd):
    # Repeated render_preview/render_thumbnails calls (e.g. a 400ms-debounced
    # preview over an afternoon) must not leave behind one temp dir per call.
    # kill_engine SIGKILLs the process on app exit, skipping atexit cleanup,
    # so this has to be enforced per-call rather than relying on atexit alone.
    engine = rpc.Engine(out=io.StringIO())
    r = engine.open_psd(str(fixture_psd))
    sid = r["sessionId"]

    calls = rpc.RENDER_DIR_GENERATIONS + 5
    for _ in range(calls):
        engine.render_preview(sid, visibleLayerIds=[2, 5], maxSize=32)
    for _ in range(calls):
        engine.render_thumbnails(sid, layerIds=[2, 5], maxSize=32)

    # 종류(preview/thumbnails)당 살아남는 디렉터리는 최근 세대 수만큼으로
    # 묶인다 — 호출당 하나씩 쌓이지 않는다.
    assert len(list(engine.tmp.iterdir())) == 2 * rpc.RENDER_DIR_GENERATIONS


def test_psd_mtimes_reports_what_is_there_and_skips_what_is_not(fixture_psd, tmp_path):
    """
    프로젝트를 열 때 "이 PSD가 저장 이후에 바뀌었나"를 판정할 근거를 준다.

    **`handle`을 거쳐서 부른다(EngineProc.call).** Engine 인스턴스의 메서드를
    직접 부르면 `_ALLOWED_METHODS` 허용목록을 건너뛰므로, 이름을 목록에 넣는 것을
    잊어도 초록불이 뜬다 — 그때 앱에서는 "unknown method"로 전부 거절된다.
    허용목록에서 `psd_mtimes`를 빼면 이 테스트가 빨간불이어야 한다.
    """
    eng = EngineProc()
    try:
        missing = str(tmp_path / "없는파일.psd")
        r = eng.call("psd_mtimes", paths=[str(fixture_psd), missing])
        assert "error" not in r, r.get("error")
        out = r["result"]
        assert str(fixture_psd) in out
        # 없는 파일은 키 자체가 없다 — 0으로 채우면 "안 바뀜"으로 오판된다.
        assert missing not in out
        assert len(out) == 1
        # 초 단위 정수로 준다(저장된 float mtime과의 비교 단위는 프런트가 맞춘다).
        assert out[str(fixture_psd)] == int(os.path.getmtime(fixture_psd))
    finally:
        eng.close()


def test_rpc_unknown_method_error(fixture_psd):
    eng = EngineProc()
    try:
        r = eng.call("open_psd", path=str(fixture_psd))["result"]
        sid = r["sessionId"]
        # Try to access non-method attribute (like "store")
        r = eng.call("store")
        assert "error" in r
        assert "unknown method" in r["error"]["message"]
        # Engine should still work after invalid method
        r2 = eng.call("close_session", sessionId=sid)
        assert r2["result"] == {}
    finally:
        eng.close()


def test_engine_survives_non_ascii_requests_under_a_legacy_locale(tmp_path):
    """
    한글 윈도우(cp949) 재현. 프런트는 요청 JSON을 UTF-8 원문으로 보내는데, 예전에는
    파이썬이 stdin을 로케일 인코딩으로 읽어 한글 경로가 든 첫 요청에서
    UnicodeDecodeError로 프로세스가 통째로 죽었다(요청 하나 실패가 아니라 엔진 사망).
    PYTHONIOENCODING으로 그 로케일을 흉내내 회귀를 잡는다.
    """
    target = tmp_path / "한글 경로.psd"      # 존재하지 않는 파일 — 응답만 확인한다
    # ensure_ascii=False가 핵심이다. 프런트의 serde_json은 non-ASCII를 escape하지
    # 않고 UTF-8 원문을 그대로 파이프에 쓴다 — escape된 요청을 보내면 순수 ASCII라
    # 로케일과 무관하게 통과해 버려서 이 테스트가 아무것도 잡지 못한다.
    request = json.dumps({"id": 1, "method": "open_psd", "params": {"path": str(target)}},
                         ensure_ascii=False)
    proc = subprocess.run(
        [sys.executable, "-m", "psd_engine"],
        input=(request + "\n").encode("utf-8"),
        capture_output=True,
        cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
        env={**os.environ, "PYTHONIOENCODING": "cp949", "PYTHONUTF8": "0"},
    )
    assert proc.returncode == 0, proc.stderr.decode("utf-8", "replace")
    msg = json.loads(proc.stdout.decode("utf-8").splitlines()[0])
    # 파일이 없다는 정상 에러 응답이어야 하고, 경로의 한글이 그대로 살아 있어야 한다.
    assert msg["id"] == 1
    assert "한글 경로.psd" in msg["error"]["message"]


# 메서드를 만들고 허용 목록에 넣는 것을 잊으면, 앱은 그 기능을 부르는 순간
# "unknown method"로 실패한다 — 코드에는 멀쩡히 있으니 눈으로는 안 보인다.
# 실제로 pin_session이 그렇게 빠졌다. 두 목록을 맞물려 둔다.
def test_every_engine_method_is_dispatchable():
    from psd_engine.rpc import Engine

    public = {
        name for name in vars(Engine)
        if not name.startswith("_") and callable(getattr(Engine, name))
    }
    # handle은 디스패처 자신이라 RPC로 부를 수 없다.
    assert public - {"handle"} == Engine._ALLOWED_METHODS


def test_allowed_methods_all_exist():
    from psd_engine.rpc import Engine

    missing = [n for n in Engine._ALLOWED_METHODS if not hasattr(Engine, n)]
    assert missing == []


from pytoshop.user import nested_layers

from conftest import make_rgb_image, write_psd


def _two_view_psd(tmp_path):
    """FRONT/BACK 각각 색 경계가 있고 라인이 없는 뷰 하나씩."""
    colours_front = nested_layers.Group(name="COLORS", layers=[
        make_rgb_image("dark", (40, 20, 20), 0, 0, 16, 12),
        make_rgb_image("base", (200, 30, 60), 0, 0, 32, 24),
    ])
    line_front = make_rgb_image("LINES", (0, 0, 0), 0, 0, 4, 24)
    colours_back = nested_layers.Group(name="COLORS", layers=[
        make_rgb_image("dark", (10, 60, 90), 0, 0, 16, 12),
        make_rgb_image("base", (250, 250, 20), 0, 0, 32, 24),
    ])
    line_back = make_rgb_image("LINES", (0, 0, 0), 0, 0, 4, 24)
    p = tmp_path / "two_views.psd"
    write_psd(p, [
        nested_layers.Group(name="FRONT", layers=[line_front, colours_front]),
        nested_layers.Group(name="BACK", layers=[line_back, colours_back]),
    ])
    return p


def test_render_preview_does_not_plan_overlays_for_a_view_whose_lines_are_not_visible(tmp_path, monkeypatch):
    # plan_overlays 한 번이 뷰당 0.9~11.6초다(설계 9절). 다섯 뷰 모델에서 하나만
    # 켜도 나머지를 합성해 버리고 버리면 그 낭비를 요청마다 치르고, 요청은
    # stdin 큐에서 순차 처리되므로 뒤에 온 다른 요청까지 물고 늘어진다. 뷰
    # 둘짜리 문서에서 하나의 라인만 visibleLayerIds에 넣으면, plan_overlays에는
    # 그 뷰 하나만 넘어가야 한다(시간을 재는 대신 넘어간 뷰 자체를 본다).
    p = _two_view_psd(tmp_path)
    engine = rpc.Engine(out=io.StringIO())
    r = engine.open_psd(str(p))
    sid = r["sessionId"]
    s = engine.store.get(sid)
    front_line_id = next(
        lid for lid, l in s["layers_by_id"].items()
        if l.name == "LINES" and l.parent.name == "FRONT"
    )

    captured = []
    real_plan_overlays = rpc.plan_overlays

    def spy(session, views, opts):
        captured.append(views)
        return real_plan_overlays(session, views, opts)

    monkeypatch.setattr(rpc, "plan_overlays", spy)

    engine.render_preview(sid, visibleLayerIds=[front_line_id],
                          edgeLines={"enabled": True})

    assert len(captured) == 1
    view_names = {v["name"] for v in captured[0]}
    assert view_names == {"FRONT"}, \
        f"보이지 않는 뷰까지 plan_overlays에 넘어갔다: {view_names}"


def test_render_preview_manual_path_treats_a_checked_line_as_covering_regardless_of_the_eye(fixture_psd, monkeypatch):
    # character.manual_views의 included_ids는 "내보내기에 이미 포함된 라인"을
    # 뜻한다. export_psd는 진짜 includedIds를 준다. render_preview는 그 목록을
    # 받지 않으므로, visibleLayerIds(체크 ∩ 눈)를 그대로 넘기면 체크는 됐지만
    # 눈으로만 숨긴 라인이 "포함 안 됨"으로 보인다 — 이 앱 다른 곳에서는 눈이
    # 무엇이 그려지는지만 바꾸는데 여기서만 계산 자체가 눈에 따라 달라지는
    # 예외였다. render_preview가 manual_views에 넘기는 included_ids가
    # visibleLayerIds보다 넓어야(체크됐지만 숨은 것도 포함) 한다.
    captured = {}
    real_manual_views = rpc.manual_views

    def spy(session, colour_ids, included_ids):
        captured["included_ids"] = set(included_ids)
        return real_manual_views(session, colour_ids, included_ids)

    monkeypatch.setattr(rpc, "manual_views", spy)

    engine = rpc.Engine(out=io.StringIO())
    r = engine.open_psd(str(fixture_psd))
    sid = r["sessionId"]
    s = engine.store.get(sid)
    all_ids = set(s["layers_by_id"].keys())
    # render_preview는 visibleLayerIds를 픽셀 레이어로 그리려 하므로(render.py의
    # _preview_tile) 그룹 id를 넣으면 이 테스트와 무관한 이유로 터진다 — 잎을 쓴다.
    some_id = next(lid for lid, l in s["layers_by_id"].items() if not l.is_group())

    engine.render_preview(
        sid, visibleLayerIds=[some_id],
        edgeLines={"enabled": True, "manualColourIds": [some_id]},
    )

    assert "included_ids" in captured
    assert captured["included_ids"] == all_ids, (
        "render_preview가 visibleLayerIds만 included_ids로 넘겼다 — 체크는 됐지만 "
        "눈으로 숨긴 라인이 포함 안 된 것으로 보여, 그 라인이 이미 덮는 자리에도 "
        "획을 겹쳐 그리게 된다"
    )


def test_render_preview_given_the_export_inclusion_list_agrees_with_export_on_which_lines_it_subtracts(
    tmp_path, monkeypatch
):
    # 위 테스트는 includedIds를 안 주는 옛 호출이 여전히 전체 세션 근사로
    # 동작하는지를 지킨다. 이 테스트는 새 인자 자체가 실제로 쓰이는지를 지킨다
    # — includedIds가 오면 render_preview는 그것을 그대로 manual_views에
    # 넘겨야 하고, 그 결과(체크된 라인은 빼고 체크 해제한 라인은 안 빼는 것)가
    # export_psd가 만드는 것과 같아야 한다(설계 배경 참고). 체크 해제한 라인을
    # 빼지 않으면 미리보기가 export보다 획이 많아지고, 실수로 계속 빼면
    # 미리보기가 export보다 획이 적어진다 — 둘 다 이 기능이 고치려는 그 차이다.
    p = _two_view_psd(tmp_path)
    engine = rpc.Engine(out=io.StringIO())
    r = engine.open_psd(str(p))
    sid = r["sessionId"]
    s = engine.store.get(sid)
    front_line_id = next(
        lid for lid, l in s["layers_by_id"].items()
        if l.name == "LINES" and l.parent.name == "FRONT"
    )
    front_colour_id = next(
        lid for lid, l in s["layers_by_id"].items()
        if l.name == "dark" and l.parent.name == "COLORS" and l.parent.parent.name == "FRONT"
    )

    captured = []
    real_manual_views = rpc.manual_views

    def spy(session, colour_ids, included_ids):
        views = real_manual_views(session, colour_ids, included_ids)
        captured.append(views)
        return views

    monkeypatch.setattr(rpc, "manual_views", spy)

    # 체크됨: export_psd라면 이 라인이 이미 있는 것으로 보고 빼야 한다.
    engine.render_preview(
        sid, visibleLayerIds=[front_line_id],
        edgeLines={"enabled": True, "manualColourIds": [front_colour_id]},
        includedIds=[front_line_id],
    )
    front_view = next(v for v in captured[-1] if v["name"] == "FRONT")
    assert front_view["lineIds"] == [front_line_id], (
        "체크된 라인을 빼지 않았다 — 미리보기가 export보다 획이 많아진다"
    )

    # 체크 해제됨: export_psd라면 이 라인은 산출물에 없으므로 빼면 안 된다.
    engine.render_preview(
        sid, visibleLayerIds=[front_line_id],
        edgeLines={"enabled": True, "manualColourIds": [front_colour_id]},
        includedIds=[],
    )
    front_view = next(v for v in captured[-1] if v["name"] == "FRONT")
    assert front_view["lineIds"] == [], (
        "체크 해제한 라인을 그대로 뺐다 — 그 라인은 실제로는 export에 없으므로 "
        "미리보기가 export보다 획이 적어진다"
    )


def _spy_on_plan_overlays(monkeypatch):
    """rpc.plan_overlays 호출을 가로채 넘어온 views를 기록한다. 실제 계산은 그대로 돈다.

    **부모가 순차로 굽는다고 못박는다.** 뷰가 둘 이상 미스면 출고 기본값은 그것을
    자식 작업 프로세스로 나눠 굽고(viewpool), 그러면 부모의 plan_overlays는 아예
    안 불린다 — 이 자로 재는 것은 캐시 판정이지 어디서 계산했느냐가 아니므로,
    세는 쪽을 부모로 고정한다. 나누는 경로는 test_viewpool.py가 따로 잰다.
    """
    monkeypatch.setenv(viewpool.WORKERS_ENV, "1")
    calls = []
    real_plan_overlays = rpc.plan_overlays

    def spy(session, views, opts):
        calls.append((views, opts))
        return real_plan_overlays(session, views, opts)

    monkeypatch.setattr(rpc, "plan_overlays", spy)
    return calls


def test_render_preview_reuses_the_overlay_cache_for_a_repeat_render_with_the_same_inputs(
    tmp_path, monkeypatch
):
    # 컨트롤러 실측: 기능이 꺼지면 미리보기 0.20초, plan_overlays 한 번이
    # 20.71초 — 켜져 있으면 매 렌더가 20.81초가 된다. 오버레이 내용은 뭐가
    # 보이는지와 무관하므로, 같은 뷰·같은 설정으로 다시 렌더하면 두 번째는
    # 계산 없이 캐시를 그대로 써야 한다.
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

    engine.render_preview(sid, visibleLayerIds=[front_line_id], edgeLines={"enabled": True})
    engine.render_preview(sid, visibleLayerIds=[front_line_id], edgeLines={"enabled": True})

    assert len(calls) == 1, f"두 번째 렌더가 캐시를 쓰지 않고 다시 계산했다: {len(calls)}번 호출됨"


def test_overlay_cache_survives_a_fresh_session_via_disk(tmp_path, monkeypatch):
    # 오버레이(뷰당 실측 9~17초)는 세션 RAM 캐시에만 있어서, 세션이 밀려날
    # 때마다(LRU 2칸이라 파일만 옮겨도) 같은 계산을 다시 했다 — 타일 캐시를
    # 깔고 난 뒤 토글 "로딩"의 정체가 전부 이것이었다. 새 세션(새 엔진)이
    # 계산 없이 디스크에서 같은 오버레이를 받아야 한다.
    p = _two_view_psd(tmp_path)
    engine = rpc.Engine(out=io.StringIO())
    sid = engine.open_psd(str(p))["sessionId"]
    s = engine.store.get(sid)
    front_line_id = next(
        lid for lid, l in s["layers_by_id"].items()
        if l.name == "LINES" and l.parent.name == "FRONT"
    )
    calls = _spy_on_plan_overlays(monkeypatch)
    first = engine.render_preview(sid, visibleLayerIds=[front_line_id],
                                  edgeLines={"enabled": True})
    assert len(calls) == 1

    engine2 = rpc.Engine(out=io.StringIO())
    sid2 = engine2.open_psd(str(p))["sessionId"]
    second = engine2.render_preview(sid2, visibleLayerIds=[front_line_id],
                                    edgeLines={"enabled": True})
    assert len(calls) == 1, "새 세션이 디스크 캐시를 안 쓰고 오버레이를 다시 계산했다"
    # 그림도 같아야 한다 — 캐시를 썼다는 것과 같은 그림이라는 것은 별개 주장이다.
    import numpy as np
    from PIL import Image
    a = np.array(Image.open(first["pngPath"]))
    b = np.array(Image.open(second["pngPath"]))
    assert np.array_equal(a, b)


def test_render_preview_recomputes_the_overlay_when_a_pixel_affecting_setting_changes(
    tmp_path, monkeypatch
):
    # width 같은 설정은 그려지는 획 자체를 바꾼다. 캐시 키가 뷰만 보고 설정을
    # 무시하면, 설정을 바꿔도 예전 오버레이가 그대로 나오는 조용한 오류가
    # 생긴다 — 두 번째 렌더는 반드시 새로 계산해야 한다.
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
                          edgeLines={"enabled": True, "width": 3})
    engine.render_preview(sid, visibleLayerIds=[front_line_id],
                          edgeLines={"enabled": True, "width": 7})

    assert len(calls) == 2, f"설정이 바뀌었는데도 캐시를 재사용했다: {len(calls)}번만 호출됨"


def test_render_preview_recomputes_when_the_colour_mode_changes(tmp_path, monkeypatch):
    # colourMode는 색 그림을 만드는 방법을 바꾸므로 그려지는 획도 바뀔 수 있다
    # (클리핑을 지키는지가 갈린다). 캐시 키에서 빠져 있으면, 두 방법을 비교하려고
    # 모드만 바꿔 다시 렌더한 사람이 **이전 모드의 오버레이를 그대로 보고**
    # "차이 없음"이라는 틀린 판정을 내린다 — 비교하려고 만든 옵션이 비교를 막는다.
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
                          edgeLines={"enabled": True, "colourMode": "composite"})
    engine.render_preview(sid, visibleLayerIds=[front_line_id],
                          edgeLines={"enabled": True, "colourMode": "paste"})

    assert len(calls) == 2, (
        f"모드가 바뀌었는데도 캐시를 재사용했다: {len(calls)}번만 호출됨")


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


def test_render_preview_toggling_visibility_does_not_recompute_a_view_already_cached(
    tmp_path, monkeypatch
):
    # 눈 토글은 어떤 오버레이를 "그릴지"만 바꾼다 — 오버레이 자체의 계산과는
    # 무관하다(뷰포트 필터는 별개로 남는다: 안 보이는 뷰는 애초에 캐시 조회에도
    # 들어가지 않는다). 뷰 하나를 껐다 다시 켜도, 이미 계산해 둔 것이면 다시
    # 계산하면 안 된다.
    p = _two_view_psd(tmp_path)
    engine = rpc.Engine(out=io.StringIO())
    r = engine.open_psd(str(p))
    sid = r["sessionId"]
    s = engine.store.get(sid)
    front_line_id = next(
        lid for lid, l in s["layers_by_id"].items()
        if l.name == "LINES" and l.parent.name == "FRONT"
    )
    back_line_id = next(
        lid for lid, l in s["layers_by_id"].items()
        if l.name == "LINES" and l.parent.name == "BACK"
    )

    calls = _spy_on_plan_overlays(monkeypatch)

    # 둘 다 보임 — FRONT, BACK 둘 다 처음 계산된다.
    engine.render_preview(sid, visibleLayerIds=[front_line_id, back_line_id],
                          edgeLines={"enabled": True})
    assert len(calls) == 2

    # FRONT를 끈다 — BACK만 남고, BACK은 이미 캐시돼 있으므로 재계산이 없다.
    engine.render_preview(sid, visibleLayerIds=[back_line_id],
                          edgeLines={"enabled": True})
    assert len(calls) == 2, "숨겨졌다 남은 뷰(BACK)를 다시 계산했다"

    # FRONT를 다시 켠다 — FRONT도 이미 캐시돼 있으므로 재계산이 없어야 한다.
    engine.render_preview(sid, visibleLayerIds=[front_line_id, back_line_id],
                          edgeLines={"enabled": True})
    assert len(calls) == 2, "껐다 켠 뷰(FRONT)를 다시 계산했다 — 캐시가 눈 상태에 묶여 있다"


def test_the_overlay_cache_evicts_the_oldest_entry_instead_of_growing_without_bound(
    tmp_path, monkeypatch
):
    # 오버레이 한 장이 3.1 Mpx 뷰에서 12MB를 넘을 수 있다(컨트롤러 실측) —
    # 세션당 무한정 쌓이면 예전 레이어별 썸네일 캐시가 냈던 OOM을 그대로
    # 반복한다. 설정을 상한 이상으로 바꿔가며 렌더하면 캐시 크기(RAM)는 상한을
    # 넘지 않아야 한다.
    #
    # 예전에는 "밀려난 항목은 다시 계산돼야 한다"도 함께 잠갔는데, 디스크
    # 캐시(tilecache.store_overlays)가 그 전제를 일부러 뒤집었다: RAM에서
    # 밀려나도 계산은 다시 하지 않고 디스크에서 돌아온다. 그래서 지금은
    # 반대로 잠근다 — 밀려난 설정을 다시 요청해도 plan_overlays가 불리지
    # 않아야 한다(불리면 디스크 층이 죽은 것이다).
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

    widths = list(range(1, rpc.OVERLAY_CACHE_PER_SESSION + 6))
    for w in widths:
        engine.render_preview(sid, visibleLayerIds=[front_line_id],
                              edgeLines={"enabled": True, "width": w})

    assert len(s["_overlay_cache"]) <= rpc.OVERLAY_CACHE_PER_SESSION, (
        f"캐시가 상한 없이 자랐다: {len(s['_overlay_cache'])}개"
    )

    calls_before = len(calls)
    # 가장 먼저 넣은 설정(widths[0])은 RAM 상한에 밀려 빠졌지만, 디스크에
    # 남아 있으므로 다시 요청해도 계산 없이 돌아와야 한다.
    engine.render_preview(sid, visibleLayerIds=[front_line_id],
                          edgeLines={"enabled": True, "width": widths[0]})
    assert len(calls) == calls_before, "RAM에서 밀려난 설정이 디스크 캐시 대신 재계산됐다"


def test_a_render_whose_views_exceed_the_cache_cap_does_not_thrash(tmp_path, monkeypatch):
    # 납품 캐릭터 폴더 실측(2026-08-11): 뷰 15개짜리 판에서 상한 8의 하드 캡
    # LRU가 순차 삽입 때문에 매 렌더 100% 미스였다 — 타일이 전부 핫이어도
    # 토글마다 뷰 15개를 전부 재계산해 134초가 걸렸다. 이번 렌더가 쓰는 뷰는
    # 축출하지 않아야 한다(그동안 상한은 넘어도 된다 — SessionStore._evict가
    # 고정 세션에 내리는 판단과 같다).
    #
    # 상한을 1로 낮추면 픽스처의 뷰 2개가 같은 상황을 만든다: 옛 구현은 FRONT를
    # 넣고 BACK을 넣을 때 FRONT를 밀어내, 같은 입력의 두 번째 렌더가 처음부터
    # 다시 계산한다.
    monkeypatch.setattr(rpc, "OVERLAY_CACHE_PER_SESSION", 1)
    p = _two_view_psd(tmp_path)
    engine = rpc.Engine(out=io.StringIO())
    r = engine.open_psd(str(p))
    sid = r["sessionId"]
    s = engine.store.get(sid)
    front_line_id = next(
        lid for lid, l in s["layers_by_id"].items()
        if l.name == "LINES" and l.parent.name == "FRONT"
    )
    back_line_id = next(
        lid for lid, l in s["layers_by_id"].items()
        if l.name == "LINES" and l.parent.name == "BACK"
    )

    calls = _spy_on_plan_overlays(monkeypatch)

    both = [front_line_id, back_line_id]
    engine.render_preview(sid, visibleLayerIds=both, edgeLines={"enabled": True})
    assert len(calls) == 2, "첫 렌더는 두 뷰를 한 번씩 계산해야 한다"

    engine.render_preview(sid, visibleLayerIds=both, edgeLines={"enabled": True})
    assert len(calls) == 2, (
        "같은 입력의 두 번째 렌더가 다시 계산했다 — 이번 렌더의 뷰가 상한에 밀려나는 스래싱이다"
    )


def _open_leaves(engine, fixture_psd):
    r = engine.open_psd(str(fixture_psd))
    sid = r["sessionId"]
    s = engine.store.get(sid)
    leaf_ids = [lid for lid, l in s["layers_by_id"].items() if not l.is_group()]
    return sid, leaf_ids


def test_warm_preview_tiles_makes_the_first_toggle_hot(fixture_psd, monkeypatch):
    # 실측(2026-08-11, 납품 BG 판): 토글 지연은 새로 켠 잎의 콜드 디코드가
    # 전부다(0.7~4.7초; 핫이면 0.04~0.1초). 워밍업이 지나간 잎은 다음
    # render_preview가 디코드 없이 캐시만 합성해야 한다.
    from psd_engine import render as render_mod

    engine = rpc.Engine(out=io.StringIO())
    sid, leaf_ids = _open_leaves(engine, fixture_psd)

    res = engine.warm_preview_tiles(sid, layerIds=leaf_ids)
    assert res["remaining"] == [] and res["skipped"] == []
    assert sorted(res["warmed"]) == sorted(leaf_ids)

    calls = []
    real = render_mod.extract_rgba
    monkeypatch.setattr(render_mod, "extract_rgba",
                        lambda layer: calls.append(layer) or real(layer))
    engine.render_preview(sid, visibleLayerIds=leaf_ids)
    assert calls == [], f"워밍업이 지나갔는데 렌더가 {len(calls)}장을 다시 디코드했다"


def test_warm_preview_tiles_makes_progress_even_with_no_budget(fixture_psd):
    # 예산이 0이어도 호출당 최소 한 장은 데워야 remaining 반복 호출이 끝난다 —
    # 아니면 프런트의 워밍업 루프가 같은 목록으로 영원히 돈다.
    engine = rpc.Engine(out=io.StringIO())
    sid, leaf_ids = _open_leaves(engine, fixture_psd)

    pending = list(leaf_ids)
    rounds = 0
    while pending:
        res = engine.warm_preview_tiles(sid, layerIds=pending, budgetMs=0)
        assert len(res["warmed"]) >= 1, "예산 0 호출이 아무것도 데우지 않았다"
        pending = res["remaining"]
        rounds += 1
        assert rounds <= len(leaf_ids), "반복 호출이 수렴하지 않는다"


def test_warm_preview_tiles_skips_a_leaf_predicted_too_slow(fixture_psd, monkeypatch):
    # stdin이 직렬이라 워밍업 요청이 도는 동안 사용자 렌더가 뒤에서 기다린다.
    # 예산 확인은 잎 사이에서만 가능하므로, 잎 하나의 예상 시간이 상한을 넘으면
    # 시작하지 않고 skipped로 알려야 한다. 상한을 0으로 낮추면 픽셀이 있는 모든
    # 잎이 "너무 느림"이 된다.
    from psd_engine import render as render_mod

    monkeypatch.setattr(render_mod, "WARM_MAX_PREDICTED_S", 0.0)
    engine = rpc.Engine(out=io.StringIO())
    sid, leaf_ids = _open_leaves(engine, fixture_psd)

    res = engine.warm_preview_tiles(sid, layerIds=leaf_ids)
    assert res["warmed"] == [], "상한 0인데도 디코드를 시작했다"
    assert res["remaining"] == []
    assert sorted(res["skipped"]) == sorted(leaf_ids)


# ---- 미리보기 PNG 디스크 캐시 ----

def test_render_preview_serves_the_same_request_from_disk(fixture_psd, tmp_path, monkeypatch):
    # 같은 인자의 두 번째 호출은 합성 없이 디스크에서 온다 — 워커가 미리 구운
    # 그림을 클릭이 그대로 받는 것과 같은 경로다. 합성 함수를 지뢰로 바꿔 잠근다.
    monkeypatch.setenv("PSD_ENGINE_TILE_CACHE_DIR", str(tmp_path / "cache"))
    from pathlib import Path

    engine = rpc.Engine(out=io.StringIO())
    sid = engine.open_psd(str(fixture_psd))["sessionId"]
    first = engine.render_preview(sid, visibleLayerIds=[2, 5], maxSize=256)["pngPath"]
    first_bytes = Path(first).read_bytes()

    def boom(*a, **k):
        raise AssertionError("같은 요청인데 합성이 다시 돌았다 — 캐시 키가 어긋난 것")

    monkeypatch.setattr(rpc, "render_preview", boom)
    second = engine.render_preview(sid, visibleLayerIds=[2, 5], maxSize=256)["pngPath"]
    assert Path(second).read_bytes() == first_bytes
    # 렌더 링이 지워도 되는 새 디렉터리의 사본으로 나온다 — 캐시 원본이 아니다.
    assert second != first


def test_render_preview_recomposes_when_any_input_changes(fixture_psd, tmp_path, monkeypatch):
    monkeypatch.setenv("PSD_ENGINE_TILE_CACHE_DIR", str(tmp_path / "cache"))
    engine = rpc.Engine(out=io.StringIO())
    sid = engine.open_psd(str(fixture_psd))["sessionId"]
    engine.render_preview(sid, visibleLayerIds=[2, 5], maxSize=256)

    calls = []
    real = rpc.render_preview

    def spy(*a, **k):
        calls.append(1)
        return real(*a, **k)

    monkeypatch.setattr(rpc, "render_preview", spy)
    # 눈 하나를 끈 화면(다른 visible)은 다른 그림 — 캐시를 지나쳐 다시 합성한다.
    engine.render_preview(sid, visibleLayerIds=[5], maxSize=256)
    # 색 통일을 켠 것도 다른 그림이다.
    engine.render_preview(sid, visibleLayerIds=[2, 5], maxSize=256,
                          lineColor="#112233", lineColorIds=[5])
    assert len(calls) == 2


def test_export_plans_overlays_only_for_views_with_included_lines(tmp_path, monkeypatch):
    # 두 뷰짜리 문서에서 한 뷰의 라인만 포함하면 **계획도 그 뷰 하나만** 돈다 —
    # find_views가 잎 표식을 받으면서 생기는 참조 뷰(COLOR PALETTE류, 라인이
    # 프리셋 제외라 체크될 일 없음)의 계획(뷰당 0.9~11.6초)을 내보내기가 치르면
    # 안 된다. attach_overlays의 건너뛰기는 안전망으로 남고, 이 필터는 그 판단을
    # 계획 앞으로 당긴 것이다(render_preview의 visible 필터와 같은 층).
    p = _two_view_psd(tmp_path)
    engine = rpc.Engine(out=io.StringIO())
    sid = engine.open_psd(str(p))["sessionId"]
    s = engine.store.get(sid)
    front_line = next(lid for lid, l in s["layers_by_id"].items()
                      if l.name == "LINES" and l.parent.name == "FRONT")

    planned = []
    real = rpc.plan_overlays

    def spy(session, views, opts):
        planned.extend(v["name"] for v in views)
        return real(session, views, opts)

    monkeypatch.setattr(rpc, "plan_overlays", spy)
    engine.export_psd(sid, includedIds=[front_line], operations=[],
                      naming="pathPrefix",
                      outputPath=str(tmp_path / "산출_LINE.psd"),
                      edgeLines={"enabled": True})
    assert planned == ["FRONT"], f"계획된 뷰: {planned}"


def test_warm_tiles_pooled_children_bake_while_disk_only_sweeps(
        fixture_psd, monkeypatch):
    # "나머지 레이어 준비 중"의 병렬화 경로 전체를 배포되는 rpc 층으로 돈다:
    # 풀 시작(기다리지 않음) → 프런트처럼 디스크 전용 폴링 → 전부 RAM까지.
    # 부모는 이 동안 **한 장도 디코드하면 안 된다** — 디코드는 자식들 몫이다.
    import time

    from psd_engine import render as render_mod, viewpool

    monkeypatch.setenv(viewpool.WORKERS_ENV, "2")
    engine = rpc.Engine(out=io.StringIO())
    sid, leaf_ids = _open_leaves(engine, fixture_psd)

    def boom(layer):
        raise AssertionError(f"디스크 전용 폴링 중에 부모가 디코드했다: {layer.name}")

    monkeypatch.setattr(render_mod, "extract_rgba", boom)
    res = engine.warm_tiles_pooled(sid, layerIds=leaf_ids)
    assert res["workers"] == 2, f"자식 {res['workers']}개 — 나누지 않았다면 공허하다"

    pending = list(leaf_ids)
    warmed = []
    deadline = time.time() + 60
    while pending and time.time() < deadline:
        out = engine.warm_preview_tiles(sid, layerIds=pending, diskOnly=True)
        warmed += out["warmed"]
        pending = out["remaining"]
        assert "poolAlive" in out, "디스크 전용 응답에 풀 생사가 없다"
        if pending and not out["poolAlive"]:
            break                      # 자식이 다 끝났는데 남았다 = 실패 몫
        if pending:
            time.sleep(0.1)
    assert pending == [], f"자식이 안 구운 드로잉 레이어: {pending}"
    assert sorted(warmed) == sorted(leaf_ids)


def test_warm_tiles_pooled_says_one_when_it_cannot_split(fixture_psd, monkeypatch):
    # 1이면 프런트는 지금까지의 디코드 경로를 그대로 쓴다 — 못 나누는 상황
    # (메모리 부족·캐시 꺼짐·드로잉 레이어 1장)이 조용히 느려질 뿐 깨지지 않는다.
    from psd_engine import viewpool

    monkeypatch.setenv(viewpool.WORKERS_ENV, "1")
    engine = rpc.Engine(out=io.StringIO())
    sid, leaf_ids = _open_leaves(engine, fixture_psd)
    assert engine.warm_tiles_pooled(sid, layerIds=leaf_ids)["workers"] == 1
