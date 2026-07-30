"""픽셀 추출/병합/썸네일/미리보기. 합성은 psd-tools(블렌드모드 존중)."""
import numpy as np
from PIL import Image


def extract_rgba(layer):
    if layer.mask is not None and not layer.mask.disabled:
        img = layer.composite(viewport=layer.bbox)
    else:
        img = layer.topil()
    return np.array(img.convert("RGBA"))


def _wanted_ids(psd, layers):
    wanted = set()
    for layer in layers:
        cur = layer
        while cur is not psd:
            wanted.add(id(cur))
            cur = cur.parent
    return wanted


def merge_rgba(psd, layers):
    boxes = [l.bbox for l in layers if l.bbox != (0, 0, 0, 0)]
    if not boxes:
        raise ValueError("merge: all source layers are empty")
    left = min(b[0] for b in boxes)
    top = min(b[1] for b in boxes)
    right = max(b[2] for b in boxes)
    bottom = max(b[3] for b in boxes)
    wanted = _wanted_ids(psd, layers)
    img = psd.composite(
        viewport=(left, top, right, bottom),
        force=True,
        color=1.0,
        alpha=0.0,
        layer_filter=lambda l: id(l) in wanted,
    )
    return np.array(img.convert("RGBA")), left, top


def _save_png(img, out_dir, stem):
    path = str(out_dir / f"{stem}.png") if hasattr(out_dir, "__truediv__") \
        else f"{out_dir}/{stem}.png"
    img.save(path)
    return path


def render_thumbnails(session, layer_ids, max_size, out_dir):
    result = {}
    for lid in layer_ids:
        layer = session["layers_by_id"][lid]
        img = layer.composite() if layer.is_group() else Image.fromarray(extract_rgba(layer))
        img = img.convert("RGBA")
        img.thumbnail((max_size, max_size))
        result[str(lid)] = _save_png(img, out_dir, f"thumb_{lid}")
    return result


def render_preview(session, visible_layer_ids, max_size, out_dir):
    psd = session["psd"]
    layers = [session["layers_by_id"][lid] for lid in visible_layer_ids]
    wanted = _wanted_ids(psd, layers)
    img = psd.composite(
        viewport=(0, 0, psd.width, psd.height),
        force=True,
        color=1.0,
        alpha=0.0,
        layer_filter=lambda l: id(l) in wanted,
    ).convert("RGBA")
    img.thumbnail((max_size, max_size))
    return _save_png(img, out_dir, "preview")
