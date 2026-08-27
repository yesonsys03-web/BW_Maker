import os
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


def test_batch_image_line_bypasses_no_match_failure(fixture_psd, tmp_path, monkeypatch):
    calls = []

    def export_image_line(session, output_path, output_format, image_line, line_color=None, overwrite=False):
        calls.append((session["path"], str(output_path), output_format, image_line, line_color, overwrite))
        return {
            "outputPath": str(output_path),
            "layerCount": 1,
            "maskHash": "mask-1",
            "verification": {
                "ok": True, "canvasOk": True, "layerCountOk": True,
                "expectedLayers": 1, "actualLayers": 1, "layers": [],
            },
        }

    monkeypatch.setattr("psd_engine.imageline.export_image_line", export_image_line)
    preset = {
        **PRESET,
        "include": {"type": "contains", "value": "zzz", "caseSensitive": False},
        "outputFormat": "png",
        "imageLine": {
            "enabled": True, "version": 1, "darkThreshold": 96,
            "boundaryThreshold": 32, "minLength": 8, "width": 3,
        },
        "lineColor": "#000000",
    }

    r = run_batch([str(fixture_psd)], preset, output_dir=str(tmp_path))

    assert r["results"][0]["ok"] is True, r["results"][0].get("error")
    assert r["results"][0]["outputPath"].endswith(".png")
    assert r["results"][0]["layerCount"] == 1
    assert calls == [(
        str(fixture_psd), str(tmp_path / "fixture_LINE.png"), "png",
        preset["imageLine"], "#000000", False,
    )]


def test_batch_image_line_accepts_one_layer_psd(fixture_psd, tmp_path):
    preset = {
        **PRESET,
        "outputFormat": "psd",
        "imageLine": {
            "enabled": True, "version": 1, "darkThreshold": 96,
            "boundaryThreshold": 32, "minLength": 8, "width": 3,
        },
    }

    r = run_batch([str(fixture_psd)], preset, output_dir=str(tmp_path))

    assert r["results"][0]["ok"] is True, r["results"][0].get("error")
    assert r["results"][0]["outputPath"].endswith(".psd")
    assert len(list(PSDImage.open(r["results"][0]["outputPath"]))) == 1


def test_batch_image_line_rejects_jpg_before_matching(fixture_psd, tmp_path, monkeypatch):
    def export_image_line(*args, **kwargs):
        raise AssertionError("unused")

    monkeypatch.setattr("psd_engine.imageline.export_image_line", export_image_line)
    preset = {
        **PRESET,
        "outputFormat": "jpg",
        "include": {"type": "contains", "value": "zzz", "caseSensitive": False},
        "imageLine": {
            "enabled": True, "version": 1, "darkThreshold": 96,
            "boundaryThreshold": 32, "minLength": 8, "width": 3,
        },
    }

    r = run_batch([str(fixture_psd)], preset, output_dir=str(tmp_path))

    assert r["results"][0]["ok"] is False
    assert "not jpg" in r["results"][0]["error"]["message"]


def test_batch_writes_png_when_the_preset_says_so(fixture_psd, tmp_path):
    r = run_batch([str(fixture_psd)], {**PRESET, "outputFormat": "png"},
                  output_dir=str(tmp_path))
    assert r["results"][0]["ok"] is True
    assert r["results"][0]["outputPath"].endswith(".png")


def test_batch_defaults_to_psd_when_the_preset_has_no_format(fixture_psd, tmp_path):
    # 사용자의 기존 presets.json에는 이 필드가 없다. PRESET에도 없어야 한다.
    assert "outputFormat" not in PRESET
    r = run_batch([str(fixture_psd)], PRESET, output_dir=str(tmp_path))
    assert r["results"][0]["outputPath"].endswith(".psd")


def _split_dirs(tmp_path):
    whole = tmp_path / "whole"
    split = tmp_path / "split"
    whole.mkdir()
    split.mkdir()
    return whole, split


def test_batch_psd_split_verification_has_the_same_keys_as_non_split(fixture_psd, tmp_path):
    """
    rpc.py builds the full verification dict (ok/canvasOk/layerCountOk/
    expectedLayers/actualLayers/layers) for the split path. batch.py used to
    build only {"ok": ...} for the same situation — verifyReport.ts calls
    v.layers.filter(...) unconditionally, so expanding a failed split-batch
    row in the UI threw a TypeError.
    """
    whole, split = _split_dirs(tmp_path)
    non_split = run_batch([str(fixture_psd)], PRESET, output_dir=str(whole))
    split_result = run_batch([str(fixture_psd)], {**PRESET, "splitLayers": True},
                             output_dir=str(split))

    assert set(split_result["results"][0]["verification"].keys()) == \
        set(non_split["results"][0]["verification"].keys())


def test_batch_raster_split_verification_has_the_same_keys_as_non_split(fixture_psd, tmp_path):
    # 같은 asymmetry가 이 브랜치가 넓힌 raster(png/jpg) split 경로에도 있었다.
    whole, split = _split_dirs(tmp_path)
    non_split = run_batch([str(fixture_psd)], {**PRESET, "outputFormat": "png"},
                          output_dir=str(whole))
    split_result = run_batch([str(fixture_psd)],
                             {**PRESET, "outputFormat": "png", "splitLayers": True},
                             output_dir=str(split))

    assert set(split_result["results"][0]["verification"].keys()) == \
        set(non_split["results"][0]["verification"].keys())


def _id_of(path, name):
    """이름으로 레이어 id를 찾는다. 배치가 여는 것과 같은 트리에서 뽑아야 한다."""
    from psd_engine.session import SessionStore
    store = SessionStore(max_sessions=1)
    sid = store.open(str(path))
    try:
        nodes = store.get(sid)["nodes_by_id"]
        return next(i for i, n in nodes.items() if n["name"] == name)
    finally:
        store.close(sid)


# 이름 규칙이 닿지 않는 판이 있다(선화가 제외 그룹 안의 BORDER인 판). 아티스트가
# 화면에서 "라인으로 지정"해 고쳐도, 배치는 프리셋만 갖고 처음부터 다시 매칭하므로
# 그 지정이 닿지 않아 no layers matched로 실패했다. 2026-08-10 신고.
def test_batch_takes_the_manual_line_designation(fixture_psd, tmp_path):
    preset = dict(PRESET, include={"type": "contains", "value": "zzz",
                                   "caseSensitive": False})
    fill_id = _id_of(fixture_psd, "fill")

    r = run_batch([str(fixture_psd)], preset, output_dir=str(tmp_path),
                  manual_line_ids={str(fixture_psd): [fill_id]})

    # 규칙은 하나도 못 잡았지만 지정한 한 장으로 나간다.
    assert r["results"][0]["ok"] is True, r["results"][0].get("error")
    assert r["results"][0]["layerCount"] == 1


def test_batch_manual_line_adds_to_what_the_rules_found(fixture_psd, tmp_path):
    fill_id = _id_of(fixture_psd, "fill")
    without = run_batch([str(fixture_psd)], PRESET, output_dir=str(tmp_path))
    n = without["results"][0]["layerCount"]

    out2 = tmp_path / "with"
    out2.mkdir()
    with_manual = run_batch([str(fixture_psd)], PRESET, output_dir=str(out2),
                            manual_line_ids={str(fixture_psd): [fill_id]})

    # 규칙 결과를 지우지 않고 보탠다.
    assert with_manual["results"][0]["layerCount"] == n + 1


# 조용히 버리면 아티스트가 고쳐둔 것이 말없이 사라진 채 파일이 나간다 — 그 산출물은
# "라인이 빠진 정상 파일"로 보여 알아채기 어렵다. 지정한 뒤 포토샵에서 저장하면
# 레이어 id가 달라지므로 이 경로는 실제로 밟힌다.
def test_batch_refuses_a_manual_line_id_this_file_does_not_have(fixture_psd, tmp_path):
    r = run_batch([str(fixture_psd)], PRESET, output_dir=str(tmp_path),
                  manual_line_ids={str(fixture_psd): [999999]})
    assert r["results"][0]["ok"] is False
    assert "이 파일에 없습니다" in r["results"][0]["error"]["message"]


def test_batch_refuses_a_manual_line_id_that_is_not_a_pixel_layer(fixture_psd, tmp_path):
    group_id = _id_of(fixture_psd, "*ART")
    r = run_batch([str(fixture_psd)], PRESET, output_dir=str(tmp_path),
                  manual_line_ids={str(fixture_psd): [group_id]})
    assert r["results"][0]["ok"] is False
    assert "pixel 레이어가 아닙니다" in r["results"][0]["error"]["message"]


def test_batch_designates_drawn_lines_from_the_sweep_sidecar(tmp_path, monkeypatch):
    """스윕이 재둔 특징이 있으면 배치는 자기 프리셋으로 검출 판단까지 하고
    내보낸다 — 클릭 없이 ROPE DETAILS류가 배치 산출물에 들어가는 자리다.
    정책 값(문턱·어휘)은 프런트가 보낸다. 특징이 없으면 지금까지처럼 돈다."""
    monkeypatch.setenv("PSD_ENGINE_TILE_CACHE_DIR", str(tmp_path / "tc"))
    from conftest import make_image, write_psd
    from test_linedetect import make_hatch

    from psd_engine import tilecache
    from psd_engine.linedetect import measure_strokes
    from psd_engine.tree import build_tree

    src = tmp_path / "plate.psd"
    write_psd(src, [make_hatch("rope details"),
                    make_image("line art", 200, 4, 4, 40, 32)])
    out_dir = tmp_path / "out"
    out_dir.mkdir()
    policy = {"survive2Max": 0.25, "coverageMax": 0.15, "minNativePx": 1,
              "excludeGroups": ["refs"], "excludeTokens": ["glow"]}

    # 사이드카가 없으면(미스윕 폴더) 기존과 같다 — line 한 장만.
    r = run_batch([str(src)], PRESET, output_dir=str(out_dir),
                  drawn_lines=policy)
    assert r["results"][0]["ok"] is True
    assert r["results"][0]["layerCount"] == 1

    built = build_tree(PSDImage.open(str(src)))
    feats = {str(lid): measure_strokes(layer)
             for lid, layer in built["layers_by_id"].items()
             if not layer.is_group()}
    tilecache.store_strokes(str(src), os.path.getmtime(src), feats)

    r = run_batch([str(src)], PRESET, output_dir=str(out_dir),
                  drawn_lines=policy, overwrite=True)
    assert r["results"][0]["ok"] is True
    assert r["results"][0]["layerCount"] == 2


def test_batch_leaves_out_a_drawn_line_the_artist_rejected(tmp_path, monkeypatch):
    """검출이 지정한 잎을 아티스트가 화면에서 뺐으면 배치도 빼야 한다.

    지금은 뺄 방법이 없다 — 배치 페이로드에 "아니오"를 실을 칸이 아예 없어서
    엔진이 사이드카에서 후보를 다시 검출해 무조건 합집합한다. 그래서 화면
    내보내기는 거절을 지키는데 배치만 안 지키고, 같은 파일이 경로에 따라 다른
    산출물을 낸다. 아티스트가 뺀 것이 말없이 납품 파일에 들어가는 자리다.
    """
    monkeypatch.setenv("PSD_ENGINE_TILE_CACHE_DIR", str(tmp_path / "tc"))
    from conftest import make_image, write_psd
    from test_linedetect import make_hatch

    from psd_engine import tilecache
    from psd_engine.linedetect import measure_strokes
    from psd_engine.tree import build_tree

    src = tmp_path / "plate.psd"
    write_psd(src, [make_hatch("rope details"),
                    make_image("line art", 200, 4, 4, 40, 32)])
    out_dir = tmp_path / "out"
    out_dir.mkdir()
    policy = {"survive2Max": 0.25, "coverageMax": 0.15, "minNativePx": 1,
              "excludeGroups": ["refs"], "excludeTokens": ["glow"]}

    built = build_tree(PSDImage.open(str(src)))
    feats = {str(lid): measure_strokes(layer)
             for lid, layer in built["layers_by_id"].items()
             if not layer.is_group()}
    tilecache.store_strokes(str(src), os.path.getmtime(src), feats)

    rope_id = _id_of(src, "rope details")

    # 거절 없이는 검출이 얹혀 두 장(기존 동작, 위 사이드카 테스트가 고정한다).
    r = run_batch([str(src)], PRESET, output_dir=str(out_dir),
                  drawn_lines=policy)
    assert r["results"][0]["layerCount"] == 2

    # 아티스트가 그 잎을 뺐다 → 이름 규칙이 잡은 한 장만 나가야 한다.
    r = run_batch([str(src)], PRESET, output_dir=str(out_dir),
                  drawn_lines=policy, overwrite=True,
                  rejected_ids={str(src): [rope_id]})
    assert r["results"][0]["ok"] is True, r["results"][0].get("error")
    assert r["results"][0]["layerCount"] == 1
