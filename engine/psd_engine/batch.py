"""여러 PSD에 프리셋 일괄 적용. 파일당 열고-처리-닫기, 실패해도 계속."""
import traceback
from pathlib import Path

from .character import find_views, manual_views
from .edges import EDGE_DEFAULTS, attach_overlays, plan_overlays
from .export import export_psd, export_psd_split, output_extension
from .matching import match_preset, preset_operations
from .ops import build_export_plan, finalize_names
from .paths import ensure_writable_path
from .raster import export_raster, export_raster_split
from .render import assign_line_color
from .session import SessionStore
from .verify import verify_export
from .verify_raster import verify_raster


def _process_one(store, path, preset, output_dir, overwrite, progress):
    sid = store.open(path)
    try:
        s = store.get(sid)
        matched, skipped = match_preset(s["tree"], preset)
        if not matched:
            raise ValueError(f"no layers matched in {path}")
        operations = preset_operations(s["tree"], matched, preset,
                                       source_stem=Path(path).stem)
        entries = finalize_names(
            build_export_plan(matched, operations),
            s["nodes_by_id"], preset["naming"],
        )
        # 배치는 규칙에 걸린 것만 내보내므로 색 통일 대상도 그것들 전부다. 그래도
        # matched를 명시해 넘긴다 — 대화형 경로(rpc.export_psd)와 같은 규칙을
        # 같은 함수로 태우기 위해서다. 색 형식 오류는 파일을 만들기 전 여기서 난다.
        assign_line_color(entries, preset.get("lineColor"), matched)
        edge = preset.get("edgeLines") or {}
        if edge.get("enabled"):
            # 배치는 프리셋만 받고 아티스트가 파일마다 레이어를 짚을 수 없다 —
            # manual_views(s, [], matched)는 colour_ids가 비어 있으므로 항상 []를
            # 돌려주고(character.manual_views 참고), 그래서 여기서는 자동 검출만
            # 돈다. find_views(s)만 부르지 않고 굳이 이 모양으로 맞춘 것은
            # rpc.export_psd/render_preview와 같은 합집합 코드 경로를 타게 해서,
            # 대화형 경로와 배치 경로가 갈라질 여지를 없애려는 것이다.
            attach_overlays(entries, plan_overlays(
                s, find_views(s) + manual_views(s, [], matched),
                {**EDGE_DEFAULTS, **edge}))
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


def run_batch(paths, preset, output_dir=None, overwrite=False, progress=None):
    store = SessionStore(max_sessions=1)
    results = []
    for path in paths:
        try:
            results.append(
                _process_one(store, path, preset, output_dir, overwrite, progress))
        except Exception as e:  # noqa: BLE001 — 항목별로 기록하고 계속(정책)
            results.append({
                "path": str(path), "ok": False,
                "error": {"message": str(e), "traceback": traceback.format_exc()},
            })
    return {"results": results}
