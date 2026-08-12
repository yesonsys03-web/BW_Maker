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
