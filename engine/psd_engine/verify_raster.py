"""내보낸 PNG/JPG 검증. 포맷이 줄 수 있는 보장만 주장한다."""
import os

import numpy as np
from PIL import Image

from .paths import long_path
from .raster import flatten_entries


def verify_raster(session, entries, output_path, fmt):
    """
    `verify_export`와 같은 모양의 dict를 돌려준다 — 프런트의
    describeVerification이 그대로 읽어야 하기 때문이다.

    PNG는 무손실이라 PSD와 같은 강도의 픽셀 완전 일치 검증이 성립한다.
    JPG는 손실 압축이라 원리적으로 불가능하므로 pixelChecked를 False로 두고
    통과한 척하지 않는다.

    평탄화된 한 장이므로 레이어 수 개념이 없다. layerCountOk를 참으로 두면
    소비자(verifyReport.ts, ExportDialog.tsx)가 거짓일 때만 렌더하므로 결과에
    레이어 수 이야기가 아예 나오지 않는다 — 그것이 맞는 표시다.
    """
    psd = session["psd"]
    name = os.path.basename(str(output_path))

    img = Image.open(long_path(str(output_path)))
    canvas_ok = img.size == (psd.width, psd.height)

    check = {"name": name, "nameOk": True, "pixelChecked": False, "pixelOk": None}
    if fmt == "png" and canvas_ok:
        expected = np.array(flatten_entries(session, entries))
        actual = np.array(img.convert("RGBA"))
        check["pixelChecked"] = True
        check["pixelOk"] = bool(
            expected.shape == actual.shape and np.array_equal(expected, actual)
        )

    ok = canvas_ok and check["pixelOk"] is not False
    return {
        "ok": bool(ok),
        "canvasOk": bool(canvas_ok),
        "layerCountOk": True,
        "expectedLayers": 1,
        "actualLayers": 1,
        "layers": [check],
    }
