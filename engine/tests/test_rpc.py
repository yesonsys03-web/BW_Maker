import io
import json
import os
import subprocess
import sys

from psd_engine import rpc


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
