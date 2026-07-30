"""픽셀 추출/병합/썸네일/미리보기. 합성은 psd-tools(블렌드모드 존중)."""
import numpy as np
from PIL import Image


def extract_rgba(layer):
    if layer.mask is not None and not layer.mask.disabled:
        img = layer.composite(viewport=layer.bbox)
    else:
        img = layer.topil()
    if img is None:
        raise ValueError(f"layer {layer.name!r} has no pixels")
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
    psd = session["psd"]
    result = {}
    for lid in layer_ids:
        layer = session["layers_by_id"][lid]
        if layer.is_group():
            # For groups: include group + ancestors (hidden group override),
            # but respect visible flag on descendants
            ancestors_and_self = set()
            cur = layer
            while cur is not psd:
                ancestors_and_self.add(id(cur))
                cur = cur.parent
            # Collect visible descendants
            descendant_ids = {id(desc) for desc in layer.descendants() if desc.visible}
            img = layer.composite(
                force=True,
                color=1.0,
                alpha=0.0,
                layer_filter=lambda l: id(l) in ancestors_and_self or id(l) in descendant_ids,
            )
            if img is None or img.width <= 0 or img.height <= 0:
                # Group has no visible pixel content (e.g. all descendants are
                # themselves empty/hidden) — not a thumbnail target.
                continue
        else:
            # Artist created the layer but never painted it (empty bbox);
            # extract_rgba()/PIL would raise on a 0x0 image. Not a thumbnail
            # target — omit it rather than failing the whole batch. Note:
            # layer.width/height here is the leaf's own record-based bbox,
            # unaffected by its (or an ancestor's) visible flag — unlike a
            # group's bbox, which is computed from visible descendants.
            if layer.width <= 0 or layer.height <= 0:
                continue
            img = Image.fromarray(extract_rgba(layer))
        img = img.convert("RGBA")
        img.thumbnail((max_size, max_size))
        result[str(lid)] = _save_png(img, out_dir, f"thumb_{lid}")
    return result


def render_preview(session, visible_layer_ids, max_size, out_dir):
    psd = session["psd"]
    layers = [session["layers_by_id"][lid] for lid in visible_layer_ids]
    wanted = _wanted_ids(psd, layers)
    # viewport is always the full document canvas (never a layer's bbox), so
    # this is immune to the empty-bbox-layer hazard render_thumbnails has:
    # an empty/all-empty visible set just yields fewer painted pixels, not a
    # 0x0 image.
    img = psd.composite(
        viewport=(0, 0, psd.width, psd.height),
        force=True,
        color=1.0,
        alpha=0.0,
        layer_filter=lambda l: id(l) in wanted,
    ).convert("RGBA")
    img.thumbnail((max_size, max_size))
    return _save_png(img, out_dir, "preview")
