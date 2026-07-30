"""내보낸 PSD 검증: 구조 + (비병합 레이어) 픽셀 완전 일치."""
import numpy as np
from psd_tools import PSDImage

from .render import extract_rgba


def verify_export(session, entries, output_path):
    out = PSDImage.open(output_path)
    psd = session["psd"]
    canvas_ok = (out.width, out.height) == (psd.width, psd.height)
    out_layers = list(out)
    layer_count_ok = len(out_layers) == len(entries)
    ok = canvas_ok and layer_count_ok

    layer_checks = []
    for entry, out_layer in zip(entries, out_layers):
        check = {
            "name": entry["finalName"],
            "nameOk": out_layer.name == entry["finalName"],
            "pixelChecked": False,
            "pixelOk": None,
        }
        if len(entry["sourceIds"]) == 1:
            src = session["layers_by_id"][entry["sourceIds"][0]]
            check["pixelChecked"] = True
            src_arr = extract_rgba(src)
            out_arr = np.array(out_layer.topil().convert("RGBA"))
            check["pixelOk"] = (
                out_layer.bbox == src.bbox
                and src_arr.shape == out_arr.shape
                and np.array_equal(src_arr, out_arr)
            )
        layer_checks.append(check)
        ok = ok and check["nameOk"] and check["pixelOk"] is not False

    return {
        "ok": bool(ok),
        "canvasOk": bool(canvas_ok),
        "layerCountOk": bool(layer_count_ok),
        "expectedLayers": len(entries),
        "actualLayers": len(out_layers),
        "layers": layer_checks,
    }
