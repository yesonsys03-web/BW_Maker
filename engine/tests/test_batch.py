import shutil

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


def test_batch_no_match_is_failure(fixture_psd, tmp_path):
    preset = dict(PRESET, include={"type": "contains", "value": "zzz",
                                   "caseSensitive": False})
    r = run_batch([str(fixture_psd)], preset, output_dir=str(tmp_path))
    assert r["results"][0]["ok"] is False
    assert "no layers matched" in r["results"][0]["error"]["message"]
