"""export plan → 새 PSD 파일 생성 (pytoshop). 원본은 절대 수정하지 않는다."""
import os

import numpy as np
from PIL import Image

from .patches import apply_pytoshop_patches
from .render import extract_rgba, merge_rgba


def _entry_pixels(session, entry):
    if len(entry["sourceIds"]) == 1:
        layer = session["layers_by_id"][entry["sourceIds"][0]]
        return extract_rgba(layer), layer.left, layer.top
    layers = [session["layers_by_id"][sid] for sid in entry["sourceIds"]]
    return merge_rgba(session["psd"], layers)


def export_psd(session, entries, output_path, embed_preview=True,
               overwrite=False, progress=None):
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
        rgba, left, top = _entry_pixels(session, entry)
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
