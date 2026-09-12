"""진입점 분기 — dev(`python -m psd_engine`)와 동결 사이드카가 같은 함수를 타는지.

v0.2.7 사고의 잠금이다. --warm-worker 분기가 __main__.py에만 있고 동결
진입점(packaging/engine_main.py)은 rpc.main 직행이어서, 빌드 앱의 전체 캐시
워커가 일반 RPC 엔진으로 떴다 — stdin만 기다리고 진행바는 0에서 멈췄다.
실행 수준의 진짜 검증은 packaging/smoke.py가 동결본을 워커로 띄워서 한다.
"""
import pathlib

import psd_engine.entry as entry


def test_warm_worker_flag_routes_to_the_worker(monkeypatch):
    calls = []
    monkeypatch.setattr("psd_engine.warmworker.main",
                        lambda max_size: calls.append(max_size))
    entry.main(["psd_engine", "--warm-worker", "--max-size", "640"])
    assert calls == [640]


def test_warm_worker_without_max_size_uses_the_app_default(monkeypatch):
    calls = []
    monkeypatch.setattr("psd_engine.warmworker.main",
                        lambda max_size: calls.append(max_size))
    entry.main(["psd_engine", "--warm-worker"])
    assert calls == [1500]


def test_default_routes_to_the_rpc_engine(monkeypatch):
    calls = []
    monkeypatch.setattr("psd_engine.rpc.main", lambda: calls.append("rpc"))
    entry.main(["psd_engine"])
    assert calls == ["rpc"]


def test_frozen_entry_script_uses_the_shared_dispatch():
    # 소스 수준 잠금: engine_main.py가 rpc.main 직행으로 되돌아가면 위 사고가
    # 그대로 재발한다. 문자열 검사가 조야하지만, 이 파일은 동결 전용이라
    # 여기서 임포트해 실행해볼 수 없다(모듈 최상단에서 main()을 부른다).
    src = (pathlib.Path(__file__).resolve().parent.parent
           / "packaging" / "engine_main.py").read_text(encoding="utf-8")
    assert "psd_engine.entry" in src
