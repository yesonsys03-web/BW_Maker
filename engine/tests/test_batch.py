import shutil

from psd_tools import PSDImage

from psd_engine.batch import run_batch

PRESET = {
    "include": {"type": "contains", "value": "line", "caseSensitive": False},
    "excludeGroupPrefixes": ["-"], "matchGroups": True,
    "includeHidden": True, "merge": "none",
    "naming": "pathPrefix", "outputSuffix": "_LINE", "embedPreview": True,
}


def test_batch_continues_after_failure(fixture_psd, tmp_path):
    good2 = tmp_path / "good2.psd"
    shutil.copy(fixture_psd, good2)
    corrupt = tmp_path / "corrupt.psd"
    corrupt.write_bytes(b"garbage")
    out_dir = tmp_path / "out"
    out_dir.mkdir()

    r = run_batch([str(fixture_psd), str(corrupt), str(good2)], PRESET,
                  output_dir=str(out_dir))
    results = r["results"]
    assert [x["ok"] for x in results] == [True, False, True]
    assert results[0]["outputPath"] == str(out_dir / "fixture_LINE.psd")
    assert results[0]["layerCount"] == 3
    assert "traceback" in results[1]["error"]
    assert (out_dir / "good2_LINE.psd").exists()


def test_batch_default_output_next_to_source(fixture_psd):
    r = run_batch([str(fixture_psd)], PRESET)
    out = r["results"][0]["outputPath"]
    assert out == str(fixture_psd.parent / "fixture_LINE.psd")


def test_batch_output_follows_a_psb_source(fixture_psd, tmp_path):
    """
    .psb 원본은 .psb로 나간다. 배치가 쓰는 경로는 프런트엔드가 미리 검사한 경로와
    같아야 하고, 확장자와 안쪽 파일 버전도 함께 가야 한다.
    """
    src = tmp_path / "shot.psb"
    shutil.copy(fixture_psd, src)
    out_dir = tmp_path / "out"
    out_dir.mkdir()

    r = run_batch([str(src)], PRESET, output_dir=str(out_dir))

    assert r["results"][0]["ok"] is True
    assert r["results"][0]["outputPath"] == str(out_dir / "shot_LINE.psb")
    assert PSDImage.open(out_dir / "shot_LINE.psb").version == 2


def test_batch_output_lowercases_an_uppercase_psb_source(fixture_psd, tmp_path):
    # FOO.PSB -> FOO_LINE.psb. Path.suffix는 대소문자를 보존하므로 명시적으로 낮춘다.
    src = tmp_path / "SHOT.PSB"
    shutil.copy(fixture_psd, src)
    out_dir = tmp_path / "out"
    out_dir.mkdir()

    r = run_batch([str(src)], PRESET, output_dir=str(out_dir))

    assert r["results"][0]["outputPath"] == str(out_dir / "SHOT_LINE.psb")


def test_batch_output_falls_back_to_psd_for_an_unrelated_extension(fixture_psd, tmp_path):
    src = tmp_path / "shot.tiff"
    shutil.copy(fixture_psd, src)
    out_dir = tmp_path / "out"
    out_dir.mkdir()

    r = run_batch([str(src)], PRESET, output_dir=str(out_dir))

    assert r["results"][0]["outputPath"] == str(out_dir / "shot_LINE.psd")


def test_batch_no_match_is_failure(fixture_psd, tmp_path):
    preset = dict(PRESET, include={"type": "contains", "value": "zzz",
                                   "caseSensitive": False})
    r = run_batch([str(fixture_psd)], preset, output_dir=str(tmp_path))
    assert r["results"][0]["ok"] is False
    assert "no layers matched" in r["results"][0]["error"]["message"]
