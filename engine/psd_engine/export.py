"""export plan → 새 PSD 파일 생성 (pytoshop). 원본은 절대 수정하지 않는다."""
import os

import numpy as np
from PIL import Image

from .patches import apply_pytoshop_patches
from .render import apply_line_color, extract_rgba, merge_rgba, parse_line_color


def _entry_pixels(session, entry, line_rgb=None):
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
    if os.path.exists(output_path) and not overwrite:
        raise FileExistsError(f"output already exists: {output_path}")

    psd = session["psd"]
    W, H = psd.width, psd.height
    total = len(entries) + 2
    images_bottom_to_top = []
    canvas = Image.new("RGBA", (W, H), (255, 255, 255, 255)) if embed_preview else None

    for i, entry in enumerate(entries):
        rgba, left, top = _entry_pixels(session, entry, line_rgb)
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
    with open(output_path, "wb") as f:
        out.write(f)
    if progress:
        progress("done", total, total)
    return {"outputPath": output_path, "layerCount": len(entries)}
