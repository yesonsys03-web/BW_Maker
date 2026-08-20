"""여러 PSD에 프리셋 일괄 적용. 파일당 열고-처리-닫기, 실패해도 계속."""
import traceback
from pathlib import Path

from .character import find_views, manual_views
from .edges import EDGE_DEFAULTS, attach_overlays, plan_overlays
from . import tilecache
from .export import export_psd, export_psd_split, output_extension
from .linedetect import judge_drawn_lines, select_drawn_line_candidates
from .matching import match_preset, preset_operations
from .ops import build_export_plan, finalize_names
from .paths import ensure_writable_path
from .raster import export_raster, export_raster_split
from .render import assign_line_color
from .session import SessionStore
from .verify import verify_export
from .verify_raster import verify_raster


def _add_manual_lines(session, matched, manual_line_ids):
    """
    화면에서 손으로 "라인으로 지정"한 레이어를 규칙 결과에 보탠다.

    이름 규칙이 닿지 않는 판이 있다 — 선화가 `TEMPLATE` 안의 `BORDER`인 판처럼
    어떤 include 어휘로도 잡을 수 없는 경우다. 아티스트는 화면에서 그것을
    지정해 고칠 수 있는데, 배치는 프리셋만 받아 파일마다 처음부터 다시 매칭하므로
    그 지정이 닿지 않았고 그 판은 `no layers matched`로 실패했다.

    모르는 id나 pixel이 아닌 id는 **조용히 버리지 않고 막는다.** 조용히 버리면
    아티스트가 고쳐둔 것이 말없이 사라진 채로 파일이 나간다 — 그때 산출물은
    "라인이 빠진 정상 파일"처럼 보여서 알아채기 어렵다. 모르는 id가 나오는
    경로는 실제로 있다: 지정한 뒤 포토샵에서 파일을 저장하면 레이어 id가
    달라진다.
    """
    if not manual_line_ids:
        return matched
    nodes = session["nodes_by_id"]
    for lid in manual_line_ids:
        node = nodes.get(lid)
        if node is None:
            raise ValueError(
                f"수동으로 지정한 라인 레이어 {lid}가 이 파일에 없습니다. "
                "파일이 바뀌었다면 지정을 다시 해주세요."
            )
        if node["kind"] != "pixel":
            raise ValueError(
                f"수동으로 지정한 라인 레이어 {node['name']!r}가 pixel 레이어가 "
                f"아닙니다(kind={node['kind']})."
            )
    return sorted(set(matched) | set(manual_line_ids))


def _process_one(store, path, preset, output_dir, overwrite, progress,
                 manual_line_ids=(), drawn_lines=None, rejected_ids=()):
    # warmworker.export_file이 이 함수를 그대로 부른다 — 워커로 나눠 돌린 배치가
    # 순차 배치와 같은 산출물을 내는 근거가 "같은 함수"라는 사실 하나이므로,
    # 시그니처나 결과 모양을 바꾸면 그쪽도 같이 볼 것.
    sid = store.open(path)
    try:
        s = store.get(sid)
        matched, skipped = match_preset(s["tree"], preset)
        # 규칙이 잡은 것 + 손으로 지정한 것. 아래는 전부 이 합집합을 쓴다 —
        # 병합 연산도, 색 통일 대상도, 색 경계선의 "이미 있는 라인" 판정도
        # 같은 목록이어야 대화형 경로와 결과가 갈리지 않는다.
        included = _add_manual_lines(s, matched, manual_line_ids)
        if drawn_lines:
            # 스윕이 재둔 굵기 특징이 있으면 "선으로 그려진" 잎의 판단까지
            # 얹는다 — 배치가 자기 드롭다운의 프리셋으로 판단하는 자리다
            # (측정은 프리셋 무관, 판단은 이 프리셋). 특징이 없으면(스윕 안 한
            # 폴더) 지금까지처럼 이름 매칭 + 수동 지정만으로 돈다.
            feats = tilecache.load_strokes(str(path), s["mtime"])
            if feats:
                cands = select_drawn_line_candidates(
                    s["tree"], matched, preset,
                    drawn_lines.get("excludeGroups") or [],
                    drawn_lines.get("excludeTokens") or [])
                detected = judge_drawn_lines(feats, cands, drawn_lines)
                if detected:
                    included = sorted(set(included) | set(detected))
        if rejected_ids:
            # 아티스트가 화면에서 뺀 잎. 검출은 프리셋과 무관하게 늘 돌고 사이드카에
            # 재둔 특징으로 파일마다 다시 판단하므로, 이 자리가 없으면 화면에서 뺀
            # 것이 배치에서 그대로 되살아난다 — 같은 파일인데 화면 내보내기는 거절을
            # 지키고 배치만 안 지키는 갈라짐이 거기서 난다.
            #
            # 없는 id는 조용히 넘어간다. 빼려던 것이 이 파일에 없다는 뜻이고 원하는
            # 결과(산출물에 없음)가 이미 성립하기 때문이다 — 모르는 id를 막아서는
            # _add_manual_lines와 방향이 반대인 이유다. 그쪽은 못 찾으면 아티스트가
            # 넣으려던 것이 조용히 빠지지만, 이쪽은 못 찾아도 잃는 것이 없다.
            drop = set(rejected_ids)
            included = [i for i in included if i not in drop]
        if not included:
            raise ValueError(f"no layers matched in {path}")
        operations = preset_operations(s["tree"], included, preset,
                                       source_stem=Path(path).stem)
        entries = finalize_names(
            build_export_plan(included, operations),
            s["nodes_by_id"], preset["naming"],
        )
        # 배치는 규칙에 걸린 것만 내보내므로 색 통일 대상도 그것들 전부다. 그래도
        # matched를 명시해 넘긴다 — 대화형 경로(rpc.export_psd)와 같은 규칙을
        # 같은 함수로 태우기 위해서다. 색 형식 오류는 파일을 만들기 전 여기서 난다.
        assign_line_color(entries, preset.get("lineColor"), included)
        edge = preset.get("edgeLines") or {}
        if edge.get("enabled"):
            # 배치는 프리셋만 받고 아티스트가 파일마다 레이어를 짚을 수 없다 —
            # manual_views(s, [], included)는 colour_ids가 비어 있으므로 항상 []를
            # 돌려주고(character.manual_views 참고), 그래서 여기서는 자동 검출만
            # 돈다. find_views(s)만 부르지 않고 굳이 이 모양으로 맞춘 것은
            # rpc.export_psd/render_preview와 같은 합집합 코드 경로를 타게 해서,
            # 대화형 경로와 배치 경로가 갈라질 여지를 없애려는 것이다.
            views = find_views(s) + manual_views(s, [], included)
            # 포함된 라인이 있는 뷰만 계획한다 — rpc.export_psd의 같은 필터와
            # 같은 이유(버릴 계획을 안 한다). attach가 안전망으로 남는다.
            included_set = set(included)
            views = [v for v in views if set(v["lineIds"]) & included_set]
            attach_overlays(entries, plan_overlays(
                s, views, {**EDGE_DEFAULTS, **edge}))
        else:
            attach_overlays(entries, [])
        fmt = preset.get("outputFormat", "psd")
        src = Path(path)
        out_dir = Path(output_dir) if output_dir else src.parent
        out_path = out_dir / f"{src.stem}{preset['outputSuffix']}{output_extension(src, fmt)}"
        ensure_writable_path(out_path)

        def cb(stage, current, total):
            if progress:
                progress(str(path), stage, current, total)

        split = preset.get("splitLayers")

        if fmt in ("png", "jpg"):
            if split:
                result = export_raster_split(s, entries, out_path, fmt,
                                             overwrite=overwrite, progress=cb)
                for entry, out in zip(entries, result["outputs"]):
                    out["verification"] = verify_raster(s, [entry], out["outputPath"],
                                                        fmt)
                # rpc.py의 raster split 검증과 같은 모양(ok/canvasOk/layerCountOk/
                # expectedLayers/actualLayers/layers)으로 맞춘다 — verifyReport.ts가
                # v.layers를 읽으므로, ok 하나뿐인 dict는 실패 행을 펼치는 순간 죽는다.
                verification = {
                    "ok": all(o["verification"]["ok"] for o in result["outputs"]),
                    "canvasOk": all(o["verification"]["canvasOk"] for o in result["outputs"]),
                    "layerCountOk": True,
                    "expectedLayers": len(result["outputs"]),
                    "actualLayers": len(result["outputs"]),
                    "layers": [l for o in result["outputs"] for l in o["verification"]["layers"]],
                }
                result["outputPath"] = str(out_dir)
            else:
                result = export_raster(s, entries, out_path, fmt, overwrite=overwrite,
                                       progress=cb)
                verification = verify_raster(s, entries, out_path, fmt)
        elif split:
            result = export_psd_split(s, entries, out_path,
                                      embed_preview=preset.get("embedPreview", True),
                                      overwrite=overwrite, progress=cb)
            for entry, out in zip(entries, result["outputs"]):
                out["verification"] = verify_export(s, [entry], out["outputPath"])
            # rpc.py의 psd split 검증과 같은 모양으로 맞춘다 — 위 raster split과
            # 같은 이유(verifyReport.ts가 v.layers를 읽는다).
            verification = {
                "ok": all(o["verification"]["ok"] for o in result["outputs"]),
                "canvasOk": all(o["verification"]["canvasOk"] for o in result["outputs"]),
                "layerCountOk": all(o["verification"]["layerCountOk"] for o in result["outputs"]),
                "expectedLayers": len(entries),
                "actualLayers": sum(o["verification"]["actualLayers"] for o in result["outputs"]),
                "layers": [l for o in result["outputs"] for l in o["verification"]["layers"]],
            }
            result["outputPath"] = str(out_dir)
        else:
            result = export_psd(s, entries, out_path,
                                embed_preview=preset.get("embedPreview", True),
                                overwrite=overwrite, progress=cb)
            verification = verify_export(s, entries, out_path)
        return {
            "path": str(path), "ok": verification["ok"],
            "outputPath": result["outputPath"],
            "layerCount": result["layerCount"],
            "verification": verification,
            # 규칙에 걸렸지만 그릴 수 없어 뺀 레이어들. 실패가 아니므로 배치를
            # 멈추지 않지만, 결과에 남겨야 나중에 "왜 이건 안 들어갔지"를 답할 수 있다.
            "skippedLayers": skipped,
        }
    finally:
        store.close(sid)


def run_batch(paths, preset, output_dir=None, overwrite=False, progress=None,
              manual_line_ids=None, drawn_lines=None, rejected_ids=None):
    """
    manual_line_ids는 {경로: [레이어 id]}. 화면에서 손으로 지정한 라인이고,
    열어둔 파일에만 있다 — 그 외의 파일은 지금까지처럼 프리셋 규칙만으로 돈다.

    rejected_ids도 같은 모양이고 반대 방향이다: 아티스트가 화면에서 뺀 잎이라
    검출이 되살리지 못하게 막는다. 이것 역시 열어둔 파일에만 있다.
    """
    store = SessionStore(max_sessions=1)
    manual = manual_line_ids or {}
    rejected = rejected_ids or {}
    results = []
    for path in paths:
        try:
            results.append(
                _process_one(store, path, preset, output_dir, overwrite, progress,
                             manual_line_ids=manual.get(str(path)) or (),
                             drawn_lines=drawn_lines,
                             rejected_ids=rejected.get(str(path)) or ()))
        except Exception as e:  # noqa: BLE001 — 항목별로 기록하고 계속(정책)
            results.append({
                "path": str(path), "ok": False,
                "error": {"message": str(e), "traceback": traceback.format_exc()},
            })
    return {"results": results}
