"""export plan → 새 PSD 파일 생성 (pytoshop). 원본은 절대 수정하지 않는다."""
import os
import re
from pathlib import Path

import numpy as np
from PIL import Image

from .patches import apply_pytoshop_patches
from .paths import ensure_writable_path, long_path
from .render import (PSD_MAX_DIMENSION, apply_line_color, extract_rgba, merge_rgba,
                     parse_line_color)


def _output_version(output_path, width, height):
    """
    pytoshop에 넘길 파일 버전. 확장자가 형식을 정하고, 문서 크기가 그것을 강제한다.

    확장자를 따르는 이유는 산출물 경로가 원본 확장자를 물려받기 때문이다. 경로는
    `.psb`인데 안쪽을 version 1로 쓰면 포토샵이 열지 못하므로, 둘은 항상 같이
    간다.

    30,000을 넘는 문서에 `.psd` 경로가 오면 여기서 막는다. 그대로 넘기면 pytoshop이
    "width must be in range 1-30000"으로 죽는데(파일을 만들기 전이라 망가진 산출물이
    남지는 않는다), 그 메시지만으로는 어느 파일을 무엇으로 저장해야 하는지 알 수 없다.
    """
    from pytoshop import enums

    if os.path.splitext(output_path)[1].lower() == ".psb":
        return enums.Version.psb
    if width > PSD_MAX_DIMENSION or height > PSD_MAX_DIMENSION:
        raise ValueError(
            f"{output_path}: document is {width}x{height}, over the PSD limit of "
            f"{PSD_MAX_DIMENSION} px per axis — write it as .psb"
        )
    return enums.Version.version_1


def entry_pixels(session, entry, line_rgb=None):
    if len(entry["sourceIds"]) == 1:
        layer = session["layers_by_id"][entry["sourceIds"][0]]
        rgba, left, top = extract_rgba(layer), layer.left, layer.top
    else:
        layers = [session["layers_by_id"][sid] for sid in entry["sourceIds"]]
        rgba, left, top = merge_rgba(session["psd"], layers)
    # 병합 뒤에 덮는다. 소스가 서로 다른 색이어도 결과 알파는 같으므로 레이어마다
    # 먼저 덮고 병합한 것과 같은 그림이 되고, 병합 경로가 한 갈래로 유지된다.
    return apply_line_color(rgba, line_rgb), left, top


def export_psd(session, entries, output_path, embed_preview=True,
               overwrite=False, progress=None, line_color=None):
    if not entries:
        raise ValueError("no entries to export")
    # 파일을 만들기 시작하기 전에 형식을 확인한다 — 절반 쓰다 실패하지 않도록.
    line_rgb = parse_line_color(line_color)
    apply_pytoshop_patches()
    from pytoshop import enums
    from pytoshop.image_data import ImageData
    from pytoshop.user import nested_layers

    output_path = str(output_path)
    ensure_writable_path(output_path)
    if os.path.exists(long_path(output_path)) and not overwrite:
        raise FileExistsError(f"output already exists: {output_path}")

    psd = session["psd"]
    W, H = psd.width, psd.height
    version = _output_version(output_path, W, H)
    total = len(entries) + 2
    images_bottom_to_top = []
    canvas = Image.new("RGBA", (W, H), (255, 255, 255, 255)) if embed_preview else None

    for i, entry in enumerate(entries):
        rgba, left, top = entry_pixels(session, entry, line_rgb)
        channels = {c: np.ascontiguousarray(rgba[..., c]) for c in range(3)}
        channels[-1] = np.ascontiguousarray(rgba[..., 3])
        images_bottom_to_top.append(nested_layers.Image(
            name=entry["finalName"], channels=channels, top=top, left=left,
            opacity=255, visible=True, blend_mode=enums.BlendMode.normal,
        ))
        if canvas is not None:
            canvas.alpha_composite(Image.fromarray(rgba), dest=(left, top))
        if progress:
            progress("compose", i + 1, total)

    out = nested_layers.nested_layers_to_psd(
        list(reversed(images_bottom_to_top)),   # index 0 = 최상단
        color_mode=enums.ColorMode.rgb,
        version=version,
        size=(W, H),
    )
    if canvas is not None:
        comp = np.array(canvas.convert("RGB"))
        out.image_data = ImageData(
            channels=np.ascontiguousarray(comp.transpose(2, 0, 1)),
            compression=enums.Compression.rle,
        )
    if progress:
        progress("write", total - 1, total)
    with open(long_path(output_path), "wb") as f:
        out.write(f)
    if progress:
        progress("done", total, total)
    return {"outputPath": output_path, "layerCount": len(entries)}


def output_extension(src_path, fmt="psd"):
    """
    산출물 확장자. `fmt`가 "png"/"jpg"면 그 확장자가 곧 답이고, "psd"는 "원본
    따름"이라는 뜻이라 원본에서 .psd/.psb를 물려받는다.

    프런트엔드 `src/lib/exportFlow.ts`의 `outputExtension`과 글자 그대로 같은
    규칙이어야 한다. 그쪽이 계산한 경로는 덮어쓰기 사전 검사와 UI에 쓰이고 실제로
    파일이 나가는 경로는 이쪽이라, 둘이 갈라지면 검사한 적 없는 경로에 파일을
    쓰게 된다.

    `Path.suffix`는 대소문자를 보존하므로 명시적으로 낮춘다 — `FOO.PSB`는 `FOO….psb`다.
    """
    if fmt == "png":
        return ".png"
    if fmt == "jpg":
        return ".jpg"
    return ".psb" if Path(src_path).suffix.lower() == ".psb" else ".psd"


#: 파일명에 쓸 수 없는 문자. 레이어 이름이 그대로 파일명이 되므로 정리한다.
_UNSAFE_IN_FILENAME = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def split_output_path(output_path, layer_name):
    """
    레이어별 내보내기의 파일 경로. 사용자가 고른 경로가 `.../X_LINE.psd`면
    `.../X_LINE_BG.psd`처럼 레이어 이름을 덧붙인다.
    """
    base = Path(output_path)
    safe = _UNSAFE_IN_FILENAME.sub("_", str(layer_name)).strip() or "layer"
    return str(base.with_name(f"{base.stem}_{safe}{base.suffix or '.psd'}"))


def export_psd_split(session, entries, output_path, embed_preview=True,
                     overwrite=False, progress=None, line_color=None):
    """
    엔트리마다 파일 하나로 내보낸다.

    캔버스 크기는 매 파일 원본 그대로다 — 나중에 합성할 때 좌표가 그대로
    맞아야 하기 때문에 레이어 bbox로 자르지 않는다.

    충돌 검사는 한 장이라도 쓰기 전에 전부 끝낸다. 절반쯤 쓰다 FileExistsError로
    멈추면 어디까지 나갔는지 알 수 없는 상태가 남는다.
    """
    if not entries:
        raise ValueError("no entries to export")

    targets = [(e, split_output_path(output_path, e["finalName"])) for e in entries]
    for _, p in targets:
        ensure_writable_path(p)
    if not overwrite:
        existing = [p for _, p in targets if os.path.exists(long_path(p))]
        if existing:
            raise FileExistsError("output already exists: " + ", ".join(existing))

    outputs = []
    total = len(targets)
    for i, (entry, path) in enumerate(targets):
        result = export_psd(session, [entry], path, embed_preview=embed_preview,
                            overwrite=True, progress=None, line_color=line_color)
        outputs.append(result)
        if progress:
            progress("write", i + 1, total)
    return {"outputs": outputs, "layerCount": len(entries)}
