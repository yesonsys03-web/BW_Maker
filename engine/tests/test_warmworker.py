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
