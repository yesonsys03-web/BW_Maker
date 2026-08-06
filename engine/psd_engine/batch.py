"""여러 PSD에 프리셋 일괄 적용. 파일당 열고-처리-닫기, 실패해도 계속."""
import traceback
from pathlib import Path

from .export import export_psd, export_psd_split, output_extension
from .matching import match_preset, preset_operations
from .ops import build_export_plan, finalize_names
from .paths import ensure_writable_path
from .raster import export_raster, export_raster_split
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
        fmt = preset.get("outputFormat", "psd")
        src = Path(path)
        out_dir = Path(output_dir) if output_dir else src.parent
        out_path = out_dir / f"{src.stem}{preset['outputSuffix']}{output_extension(src, fmt)}"
        ensure_writable_path(out_path)

        def cb(stage, current, total):
            if progress:
                progress(str(path), stage, current, total)

        line_color = preset.get("lineColor")
        split = preset.get("splitLayers")

        if fmt in ("png", "jpg"):
            if split:
                result = export_raster_split(s, entries, out_path, fmt,
                                             overwrite=overwrite, progress=cb,
                                             line_color=line_color)
                for entry, out in zip(entries, result["outputs"]):
                    out["verification"] = verify_raster(s, [entry], out["outputPath"],
                                                        fmt, line_color=line_color)
                verification = {"ok": all(o["verification"]["ok"] for o in result["outputs"])}
                result["outputPath"] = str(out_dir)
            else:
                result = export_raster(s, entries, out_path, fmt, overwrite=overwrite,
                                       progress=cb, line_color=line_color)
                verification = verify_raster(s, entries, out_path, fmt,
                                             line_color=line_color)
        elif split:
            result = export_psd_split(s, entries, out_path,
                                      embed_preview=preset.get("embedPreview", True),
                                      overwrite=overwrite, progress=cb,
                                      line_color=line_color)
            for entry, out in zip(entries, result["outputs"]):
                out["verification"] = verify_export(s, [entry], out["outputPath"],
                                                    line_color=line_color)
            verification = {"ok": all(o["verification"]["ok"] for o in result["outputs"])}
            result["outputPath"] = str(out_dir)
        else:
            result = export_psd(s, entries, out_path,
                                embed_preview=preset.get("embedPreview", True),
                                overwrite=overwrite, progress=cb, line_color=line_color)
            verification = verify_export(s, entries, out_path, line_color=line_color)
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
