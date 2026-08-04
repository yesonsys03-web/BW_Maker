"""내보낸 PSD 검증: 구조 + (비병합 레이어) 픽셀 완전 일치."""
import numpy as np
from psd_tools import PSDImage

from .render import apply_line_color, extract_rgba, parse_line_color


def verify_export(session, entries, output_path, line_color=None):
    """
    내보낸 PSD가 원본과 맞는지 본다.

    line_color를 함께 받는 것이 중요하다. 색 통일을 켜면 export가 모든 레이어의
    RGB를 그 색으로 덮어 쓰므로(알파는 그대로), 원본의 원래 색과 대조하면 색이
    검정이 아니던 레이어가 전부 어긋난다 — 실제로 배치가 파일마다 "실패"를 냈고
    나온 PSD는 멀쩡했다. 기대값에 같은 변환을 걸어야 같은 것을 비교하게 된다.
    """
    out = PSDImage.open(output_path)
    line_rgb = parse_line_color(line_color)
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
            if line_rgb is not None:
                src_arr = apply_line_color(src_arr, line_rgb)
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
