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
