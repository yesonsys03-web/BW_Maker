"""내보낸 PSD 검증: 구조 + (비병합 레이어) 픽셀 완전 일치."""
import numpy as np
from psd_tools import PSDImage

from .export import entry_pixels


def verify_export(session, entries, output_path):
    """
    내보낸 PSD가 원본과 맞는지 본다.

    기대값에 색 통일을 똑같이 거는 것이 중요하다. 색 통일을 켜면 export가 그
    레이어의 RGB를 덮어 쓰므로(알파는 그대로), 원본의 원래 색과 대조하면 색이
    다르던 레이어가 전부 어긋난다 — 실제로 배치가 파일마다 "실패"를 냈고 나온
    PSD는 멀쩡했다.

    그래서 색을 따로 받지 않고 **export가 쓴 것과 같은 `entry["lineRgb"]`를
    읽는다**(assign_line_color 참고). 예전에는 양쪽이 line_color를 각자 받았고,
    그것이 위 사고의 형태였다 — 이제는 인자를 빠뜨려 갈라질 자리가 없다.

    같은 이유로 기대 픽셀 자체를 여기서 다시 조립하지 않고 export.py의
    `entry_pixels`를 그대로 부른다. edgeOverlay(생성된 색 경계 획)가 export
    쪽에서만 합성되고 여기서는 몰랐던 적이 있다 — 원본 레이어 하나만 놓고
    대조하니 올바른 산출물인데도 bbox와 픽셀이 둘 다 어긋나 보여, 위 색 통일
    사고와 같은 모양으로 "실패"를 냈다. 다음에 entry에 무언가 새로 얹을
    사람은 여기가 아니라 entry_pixels에 더해야 한다 — 그래야 검증이 자동으로
    따라온다.
    """
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
            check["pixelChecked"] = True
            src_arr, left, top = entry_pixels(session, entry)
            out_arr = np.array(out_layer.topil().convert("RGBA"))
            # entry_pixels가 edgeOverlay를 합치며 원본 레이어 bbox 밖으로 캔버스를
            # 넓혔을 수 있으므로, 기대 bbox는 src.bbox가 아니라 entry_pixels가 돌려준
            # origin(left, top)과 배열 크기에서 다시 구한다.
            expected_bbox = (left, top, left + src_arr.shape[1], top + src_arr.shape[0])
            check["pixelOk"] = (
                out_layer.bbox == expected_bbox
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
