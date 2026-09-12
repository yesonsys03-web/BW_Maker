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


def test_ensure_writable_path_accepts_a_short_filename_under_a_deep_tree(tmp_path):
    # 전체 경로 길이가 255를 넘어도 파일 이름 자체가 짧으면 통과해야 한다.
    # 이 테스트는 basename만 재는 올바른 구현과 str(path) 전체를 재는 잘못된
    # 구현을 가른다 — 앞의 테스트만으로는 둘을 구별할 수 없다.
    nested = tmp_path
    for _ in range(10):
        nested = nested / ("d" * 50)
    path = nested / "out.png"
    assert len(str(path)) > MAX_COMPONENT
    ensure_writable_path(path)
