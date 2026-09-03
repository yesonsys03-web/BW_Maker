"""Full-document rendered-image line extraction for the color_to_line preset."""
import hashlib
import json
import os
import re
import sys
import time
import warnings
from collections import OrderedDict
from importlib.resources import files

import numpy as np
from PIL import Image, ImageChops, ImageFilter

from .edges import build_overlay
from .export import _output_version
from .paths import ensure_writable_path, long_path
from .patches import apply_pytoshop_patches
from .render import parse_line_color as _parse_line_color

try:
    import resource as _resource
except ImportError:  # Windows has no stdlib resource module.
    _resource = None

_DEFAULTS = {
    "enabled": True,
    "version": 1,
    "darkThreshold": 254,
    "boundaryThreshold": 32,
    "minLength": 8,
    "width": 1,
}
_MASK_CACHE = OrderedDict()
_PROFILE_CACHE = {}
_MASK_CACHE_LIMIT = 2
_FLATTENED_LINE_SESSIONS = None
# Measured from cloor_to_line_ori.psd's authored Line layers. Their ink is
# #3f3f3f and their antialiased core is normally 224-232 alpha, not 255.
# Keep this mapping linear: a gamma LUT skipped dozens of alpha levels and
# produced visibly stepped edges at 400% instead of Photoshop-like gradients.
_AUTHORED_ALPHA_LUT = np.array([
    round(232 * value / 255) for value in range(256)
], dtype=np.uint8)
def _max_rss_bytes():
    if _resource is None:
        return None
    value = _resource.getrusage(_resource.RUSAGE_SELF).ru_maxrss
    return int(value if sys.platform == "darwin" else value * 1024)


def normalize_options(image_line):
    opts = {**_DEFAULTS, **(image_line or {})}
    if not opts.get("enabled"):
        raise ValueError("imageLine.enabled must be true")
    if int(opts.get("version", 1)) != 1:
        raise ValueError(f"unsupported imageLine.version: {opts.get('version')!r}")
    return {
        "enabled": True,
        "version": 1,
        "darkThreshold": int(opts["darkThreshold"]),
        "boundaryThreshold": int(opts["boundaryThreshold"]),
        "minLength": max(0, int(opts["minLength"])),
        "width": max(1, int(opts["width"])),
    }


def parse_line_color(line_color):
    return _parse_line_color(line_color) or (0, 0, 0)


def _document_rgba(session):
    if session.get("flattened_image") and session.get("path"):
        with Image.open(session["path"]) as image:
            return np.array(image.convert("RGBA"), dtype=np.uint8)
    psd = session["psd"]
    # Photoshop's embedded composite is the already-rendered full document and
    # avoids decoding the entire layer stack. Generated test PSDs can contain
    # a placeholder solid-black composite, so only that degenerate case needs
    # the forced layer compositor.
    embedded = psd.composite(force=False)
    if embedded is not None:
        embedded_rgba = np.array(embedded.convert("RGBA"), dtype=np.uint8)
        if np.any(embedded_rgba != embedded_rgba[0, 0]):
            return embedded_rgba
    try:
        img = psd.composite(force=True, color=1.0, alpha=0.0)
    except ImportError as exc:
        message = str(exc).lower()
        if "scipy" not in message or "gradient" not in message:
            raise
        # Some Photoshop adjustment layers need optional scipy support in
        # psd-tools. The embedded composite is the authoritative rendered
        # document fallback and keeps those ordinary PSDs usable.
        warnings.warn(
            "psd-tools could not render gradient fills without scipy; "
            "using the PSD embedded composite for image-line extraction",
            RuntimeWarning,
            stacklevel=2,
        )
        img = embedded
        if img is None:
            raise
    return np.array(img.convert("RGBA"), dtype=np.uint8)


def _artwork_rgba(session):
    """Render production roots without sibling template/reference chrome."""
    psd = session["psd"]
    roots = _production_roots(psd)
    if not roots:
        return _document_rgba(session)
    visible_siblings = [
        layer for layer in psd
        if (
            layer not in roots
            and layer.is_visible()
            and layer.bbox != (0, 0, 0, 0)
        )
    ]
    if len(roots) == 1 and not visible_siblings:
        return _document_rgba(session)

    canvas = Image.new("RGBA", (psd.width, psd.height))
    rendered_any = False
    for root in roots:
        try:
            rendered = _render_production_root(root)
        except (ImportError, NotImplementedError):
            rendered = None
        if rendered is None:
            continue
        left, top, right, bottom = root.bbox
        clip_left = max(0, left)
        clip_top = max(0, top)
        clip_right = min(psd.width, right)
        clip_bottom = min(psd.height, bottom)
        if clip_right <= clip_left or clip_bottom <= clip_top:
            continue
        local = rendered.convert("RGBA").crop((
            clip_left - left,
            clip_top - top,
            clip_right - left,
            clip_bottom - top,
        ))
        canvas.alpha_composite(local, (clip_left, clip_top))
        rendered_any = True
    if not rendered_any:
        return _document_rgba(session)
    return np.array(canvas, dtype=np.uint8)


def _flattened_colour_plate_rgba(session):
    """Return a full-canvas top-level Color plate when it is the artwork."""
    if session.get("flattened_image"):
        return None
    psd = session["psd"]
    candidates = [
        layer for layer in psd
        if (
            not layer.is_group()
            and layer.is_visible()
            and _object_key(layer.name) in {"color", "colour"}
            and layer.bbox == (0, 0, psd.width, psd.height)
        )
    ]
    if len(candidates) != 1:
        return None
    image = candidates[0].topil()
    if image is None:
        return None
    rgba = np.array(image.convert("RGBA"), dtype=np.uint8)
    if float(np.mean(rgba[..., 3] >= 247)) < 0.95:
        return None
    return rgba


def _matching_sibling_psd_session(session):
    """Return a PSD sibling only when its rendered pixels match the PNG."""
    if not session.get("flattened_image") or not session.get("path"):
        return None
    source_path = os.fspath(session["path"])
    if os.path.splitext(source_path)[1].casefold() != ".png":
        return None
    stem = os.path.splitext(source_path)[0]
    psd_path = next((
        candidate
        for candidate in (
            stem + ".psd", stem + ".psb", stem + ".PSD", stem + ".PSB",
        )
        if os.path.isfile(candidate)
    ), None)
    if psd_path is None:
        return None

    from .session import open_document

    psd = open_document(psd_path)
    if (psd.width, psd.height) != (
        session["psd"].width,
        session["psd"].height,
    ):
        return None
    sibling = {
        "psd": psd,
        "path": psd_path,
        "mtime": os.path.getmtime(psd_path),
        "flattened_image": False,
    }
    rendered = Image.fromarray(_document_rgba(sibling), "RGBA")
    with Image.open(source_path) as source:
        difference = ImageChops.difference(source.convert("RGBA"), rendered)
        histogram = difference.histogram()
    pixels = psd.width * psd.height
    changed = sum(
        count
        for channel in range(4)
        for value, count in enumerate(
            histogram[channel * 256:(channel + 1) * 256]
        )
        if value > 3
    )
    absolute_difference = sum(
        value * count
        for channel in range(4)
        for value, count in enumerate(
            histogram[channel * 256:(channel + 1) * 256]
        )
    )
    if (
        changed / max(1, pixels * 4) > 0.001
        or absolute_difference / max(1, pixels * 4) > 0.1
    ):
        return None
    return sibling


def _flattened_signal_red(rgb):
    return (
        (rgb[..., 0] >= 160)
        & (
            rgb[..., 0].astype(np.int16)
            - rgb[..., 1].astype(np.int16)
            >= 80
        )
        & (
            rgb[..., 0].astype(np.int16)
            - rgb[..., 2].astype(np.int16)
            >= 80
        )
    )


def _flattened_annotation_zone(rgb):
    expanded = Image.fromarray(
        _flattened_signal_red(rgb).astype(np.uint8) * 255, "L")
    for _ in range(2):
        expanded = expanded.filter(ImageFilter.MaxFilter(11))
    return np.array(expanded) > 0


def _suppress_flattened_red_annotations(rgb):
    """Suppress sparse review marks, but never red-dominant authored artwork."""
    red_fraction = float(np.mean(_flattened_signal_red(rgb)))
    return 0.0 < red_fraction <= 0.05


def _flattened_line_session():
    global _FLATTENED_LINE_SESSIONS
    if _FLATTENED_LINE_SESSIONS is None:
        import onnxruntime as ort

        model_dir = files("psd_engine").joinpath("models")
        _FLATTENED_LINE_SESSIONS = (
            ort.InferenceSession(
                str(model_dir.joinpath("line_drawings.onnx")),
                providers=["CPUExecutionProvider"],
            ),
            ort.InferenceSession(
                str(model_dir.joinpath("line_relifer.onnx")),
                providers=["CPUExecutionProvider"],
            ),
        )
    return _FLATTENED_LINE_SESSIONS


def _run_flattened_line_models(rgb):
    tensor = rgb.astype(np.float32).transpose(2, 0, 1)[None, ...] / 255.0
    drawing_session, relifer_session = _flattened_line_session()
    output = drawing_session.run(
        None,
        {drawing_session.get_inputs()[0].name: tensor},
    )[0]
    refined_input = output.transpose(0, 2, 3, 1) * 2.0 - 1.0
    refined = relifer_session.run(
        None,
        {relifer_session.get_inputs()[0].name: refined_input},
    )[0][0, ..., 0]
    # The refiner emits [-1, 1], with white paper at 1. Amplify the extracted
    # ink to the authored animation line weight measured from reference PSBs.
    return np.clip(
        (1.0 - ((refined + 1.0) / 2.0)) * (255.0 * 3.0),
        0,
        255,
    ).astype(np.uint8)


def _binarize_flattened_alpha(alpha, threshold=64):
    """Remove diffuse model responses without simplifying confident detail."""
    return np.where(alpha >= threshold, 255, 0).astype(np.uint8)


def _flattened_model_alpha(rgba):
    rgb = rgba[..., :3]
    # Difference/reference renders are sometimes stored as sparse marks on a
    # fully opaque black canvas. Feeding that canvas to the drawing model
    # turns the background itself into one enormous line. Handle only the
    # unambiguous case (virtually the whole image is near-black); ordinary
    # night artwork must keep its authored polarity.
    if float(np.mean(np.max(rgb, axis=2) <= 8)) >= 0.9:
        alpha = np.max(rgb, axis=2).astype(np.uint16)
        alpha = np.minimum(alpha * 8, 255).astype(np.uint8)
        alpha[alpha < 6] = 0
        return np.ascontiguousarray(alpha)
    suppress_red = _suppress_flattened_red_annotations(rgb)
    signal_red = _flattened_signal_red(rgb) if suppress_red else None
    cleaned_rgb = rgb.copy()
    if suppress_red:
        median_rgb = np.array(
            Image.fromarray(rgb, "RGB").filter(ImageFilter.MedianFilter(7)),
            dtype=np.uint8,
        )
        cleaned_rgb[signal_red] = median_rgb[signal_red]
    height, width = rgb.shape[:2]
    scale = min(1.0, 1536 / max(width, height))
    model_width = max(8, round(width * scale / 8) * 8)
    model_height = max(8, round(height * scale / 8) * 8)
    resized = np.array(
        Image.fromarray(cleaned_rgb, "RGB").resize(
            (model_width, model_height), Image.Resampling.LANCZOS),
        dtype=np.uint8,
    )
    alpha = _run_flattened_line_models(resized)
    if (model_width, model_height) != (width, height):
        alpha = np.array(
            Image.fromarray(alpha, "L").resize(
                (width, height), Image.Resampling.LANCZOS),
            dtype=np.uint8,
        )

    alpha[alpha < 6] = 0
    if suppress_red:
        alpha[_flattened_annotation_zone(rgb)] = 0
    return np.ascontiguousarray(_binarize_flattened_alpha(alpha))


def _is_named_line_layer(name):
    words = re.findall(r"[^\W_]+", name.casefold())
    return any(word in {"line", "lines"} for word in words)


def _is_non_art_line_layer(name):
    """Return true for construction guides named as lines, not drawn ink."""
    words = set(re.findall(r"[^\W_]+", name.casefold()))
    return (
        bool(words & {"annotation", "guide", "note", "notes"})
        or
        {"height", "line"} <= words
        or {"horizon", "line"} <= words
        or {"perspective", "line"} <= words
    )


def _uses_explicit_turn_line_system(psd):
    for root in psd:
        if (
            not root.is_group()
            or not root.is_visible()
            or _object_key(root.name) not in {"turn", "turnaround"}
        ):
            continue
        for layer in root.descendants():
            if (
                layer.is_visible()
                and _is_named_line_layer(layer.name)
            ):
                return True
    return False


def _has_sparse_alpha(layer, psd):
    if psd.depth not in {8, 16}:
        return False
    channels = {
        int(info.id): index
        for index, info in enumerate(layer._record.channel_info)
    }
    if -1 not in channels or layer.width * layer.height < 1_000:
        return False
    dtype = np.uint8 if psd.depth == 8 else np.dtype(">u2")
    raw = layer._channels[channels[-1]].get_data(
        layer.width,
        layer.height,
        psd.depth,
        psd.version,
    )
    alpha = np.frombuffer(raw, dtype=dtype)
    occupied = float(np.mean(alpha > 0))
    channel_max = 255 if psd.depth == 8 else 65535
    opaque = float(np.mean(alpha >= channel_max - 1))
    return 0.002 <= occupied <= 0.25 and opaque <= 0.03


def _has_authored_line_alpha(layer):
    if layer.width * layer.height < 1_000:
        return False
    image = layer.topil()
    if image is None:
        return False
    rgba = np.array(image.convert("RGBA"), dtype=np.uint8)
    alpha = rgba[..., 3]
    solid = alpha >= 8
    occupied = float(np.mean(solid))
    if not 0.002 <= occupied <= 0.35:
        return False
    pixels = rgba[..., :3][solid]
    chroma = np.ptp(pixels, axis=1)
    dark_or_neutral = (np.max(pixels, axis=1) <= 96) | (chroma <= 16)
    if float(np.mean(dark_or_neutral)) < 0.8:
        return False
    interior = np.array(
        Image.fromarray(
            solid.astype(np.uint8) * 255,
            "L",
        ).filter(ImageFilter.MinFilter(7)),
        dtype=np.uint8,
    ) > 0
    interior_ratio = float(np.count_nonzero(interior)) / max(
        1, int(np.count_nonzero(solid)))
    return interior_ratio <= 0.4


def _paired_component_line_layers(psd):
    candidates = []
    for group in psd.descendants():
        if not group.is_group() or not group.is_visible():
            continue
        leaves = [
            layer for layer in group
            if (
                not layer.is_group()
                and layer.is_visible()
                and layer.bbox != (0, 0, 0, 0)
            )
        ]
        has_colour_sibling = any(
            any(word in layer.name.casefold() for word in ("color", "colour", "fill"))
            for layer in leaves
        )
        if not has_colour_sibling:
            continue
        group_key = _object_key(group.name)
        for layer in leaves:
            if (
                _object_key(layer.name) == group_key
                and _has_authored_line_alpha(layer)
            ):
                candidates.append(layer)
    return candidates


def _uses_clean_style(psd):
    return any(
        layer.is_group()
        and layer.is_visible()
        and layer.name.strip().casefold() == "clean"
        for layer in psd
    )


def _is_fl102_document(session):
    name = os.path.basename(os.fspath(session["path"])).casefold()
    return name == "fl102_bg.psd" or name.startswith("fl102_bg_")


def _sparse_black_line_layers(psd):
    """Find sparse black-ink layers whose names describe objects, not lines."""
    if psd.depth not in {8, 16}:
        return []

    dtype = np.uint8 if psd.depth == 8 else np.dtype(">u2")
    candidates = []
    for layer in psd.descendants():
        if (
            layer.is_group()
            or not layer.is_visible()
            or layer.bbox == (0, 0, 0, 0)
        ):
            continue
        area = layer.width * layer.height
        if area < 1_000:
            continue
        channels = {
            int(info.id): (info, index)
            for index, info in enumerate(layer._record.channel_info)
        }
        if not all(channel_id in channels for channel_id in (-1, 0, 1, 2)):
            continue
        rgb_lengths = [
            channels[channel_id][0].length
            for channel_id in (0, 1, 2)
        ]
        if len(set(rgb_lengths)) != 1:
            continue
        if channels[-1][0].length / area > 0.30:
            continue

        decoded = {}
        for channel_id in (-1, 0, 1, 2):
            index = channels[channel_id][1]
            raw = layer._channels[index].get_data(
                layer.width,
                layer.height,
                psd.depth,
                psd.version,
            )
            decoded[channel_id] = np.frombuffer(raw, dtype=dtype)
        occupied = decoded[-1] > 0
        occupancy = float(np.mean(occupied))
        if not 0.002 <= occupancy <= 0.25:
            continue
        channel_max = 255 if psd.depth == 8 else 65535
        if float(np.mean(decoded[-1] >= channel_max - 1)) > 0.03:
            continue
        if all(
            np.all(decoded[channel_id][occupied] == 0)
            for channel_id in (0, 1, 2)
        ):
            candidates.append(layer)
    return candidates


def _object_key(name):
    value = re.sub(r"[^a-z0-9]+", "", name.casefold())
    value = re.sub(r"\d+$", "", value)
    return value[:-1] if value.endswith("s") else value


_PRODUCTION_ROOT_KEYS = {
    "art", "artwork", "design", "drawing", "illustration",
    "prop", "turn", "turnaround",
}
_NON_ART_ROOT_KEYS = {
    "colorpalette", "colourpalette", "extraref", "fieldguide",
    "fillable", "height", "note", "template",
}
_NON_ART_CHILD_KEYS = {
    "colorpalette", "colourpalette", "extraref", "height",
    "label", "note", "template",
}


def _production_roots(psd):
    semantic = [
        layer for layer in psd
        if (
            layer.is_group()
            and layer.is_visible()
            and layer.bbox != (0, 0, 0, 0)
            and _object_key(layer.name) in _PRODUCTION_ROOT_KEYS
        )
    ]
    if semantic:
        return semantic
    if not any(
        layer.is_group()
        and layer.is_visible()
        and _object_key(layer.name) in _NON_ART_ROOT_KEYS
        for layer in psd
    ):
        return []
    # Some studio templates name production views after the object or angle
    # (SWORD 1, SIDE 3/4) instead of ART/PROP. Once known chrome is removed,
    # the remaining visible top-level groups are the only authored content.
    return [
        layer for layer in psd
        if (
            layer.is_group()
            and layer.is_visible()
            and layer.bbox != (0, 0, 0, 0)
            and _object_key(layer.name) not in _NON_ART_ROOT_KEYS
        )
    ]


def _inside_roots(layer, roots, psd):
    current = layer
    while current is not None and current is not psd:
        if any(current is root for root in roots):
            return True
        parent = current.parent
        if parent is not None and parent is not psd and parent.is_group():
            _, selected = _production_children(parent)
            if not any(current is child for child in selected):
                return False
        current = parent
    return False


def _production_children(parent):
    children = [
        child for child in parent
        if child.is_visible() and child.bbox != (0, 0, 0, 0)
    ]
    selected = [
        child for child in children
        if _object_key(child.name) not in _NON_ART_CHILD_KEYS
    ]
    if selected:
        largest_area = max(
            (child.width * child.height for child in selected),
            default=0,
        )
        selected = [
            child for child in selected
            if not (
                "copy" in set(re.findall(
                    r"[^\W_]+", child.name.casefold()))
                and child.width * child.height < largest_area * 0.02
            )
        ]
    has_line = any(_is_named_line_layer(child.name) for child in selected)
    has_colour = any(
        _is_colour_group_name(child.name)
        or _object_key(child.name) in {"fill", "fillable"}
        for child in selected
    )
    if has_line and has_colour:
        selected = [
            child for child in selected
            if (
                child.is_group()
                or _is_named_line_layer(child.name)
                or _is_colour_group_name(child.name)
                or _object_key(child.name) in {"fill", "fillable"}
            )
        ]
    return children, selected


def _production_root_needs_raw_render(root):
    children, selected = _production_children(root)
    if len(children) != len(selected):
        return True
    return any(
        child.is_group() and _production_root_needs_raw_render(child)
        for child in selected
    )


def _render_production_root(root):
    """Composite production only, with a raw fallback for optional effects."""
    _, selected = _production_children(root)
    if not _production_root_needs_raw_render(root):
        try:
            rendered = root.composite()
        except (ImportError, NotImplementedError):
            rendered = None
        if rendered is not None:
            return rendered

    left, top, right, bottom = root.bbox
    canvas = Image.new("RGBA", (right - left, bottom - top))

    def draw(nodes, parent_opacity):
        _, production = _production_children(nodes)
        for child in reversed(production):
            opacity = (
                parent_opacity * int(child.opacity) + 127
            ) // 255
            if child.is_group():
                draw(child, opacity)
                continue
            if child.clipping:
                continue
            try:
                rendered = child.topil()
            except (ImportError, NotImplementedError):
                rendered = None
            if rendered is None:
                continue
            rgba = np.array(rendered.convert("RGBA"), dtype=np.uint8)
            if opacity < 255:
                rgba[..., 3] = (
                    rgba[..., 3].astype(np.uint16) * opacity + 127
                ) // 255
                rendered = Image.fromarray(rgba, "RGBA")
            child_left, child_top, child_right, child_bottom = child.bbox
            clip_left = max(left, child_left)
            clip_top = max(top, child_top)
            clip_right = min(right, child_right)
            clip_bottom = min(bottom, child_bottom)
            if clip_right <= clip_left or clip_bottom <= clip_top:
                continue
            local = rendered.crop((
                clip_left - child_left,
                clip_top - child_top,
                clip_right - child_left,
                clip_bottom - child_top,
            ))
            canvas.alpha_composite(
                local,
                (clip_left - left, clip_top - top),
            )

    draw(selected, int(root.opacity))
    return canvas


def _is_colour_group_name(name):
    key = _object_key(name)
    return key.endswith("color") or key.endswith("colour")


def _fl102_semantic_ink_layers(psd):
    """Find dark ink named after its containing object group."""
    excluded = {
        "fill", "grad", "gradient", "hl", "light", "shade", "shad",
        "shadow", "s", "texture",
    }
    candidates = []
    for layer in psd.descendants():
        if (
            layer.is_group()
            or not layer.is_visible()
            or layer.bbox == (0, 0, 0, 0)
        ):
            continue
        name_key = _object_key(layer.name)
        parent_key = _object_key(layer.parent.name)
        if (
            not name_key
            or name_key in excluded
            or name_key != parent_key
            or not _has_sparse_alpha(layer, psd)
        ):
            continue
        image = layer.topil()
        if image is None:
            continue
        rgba = np.array(image.convert("RGBA"), dtype=np.uint8)
        occupied = rgba[..., 3] > 0
        if occupied.any() and float(np.mean(rgba[..., :3][occupied])) <= 140:
            candidates.append(layer)
    return candidates


def _style_silhouette_layers(psd, include_all=False):
    """Return line-less background shapes that need an authored silhouette."""
    clean_groups = [
        layer for layer in psd
        if (
            layer.is_group()
            and layer.is_visible()
            and layer.name.strip().casefold() == "clean"
        )
    ]
    roots = [psd] if include_all else clean_groups
    candidates = []
    for group in roots:
        for layer in group.descendants():
            if (
                layer.is_group()
                or not layer.is_visible()
                or layer.bbox == (0, 0, 0, 0)
            ):
                continue
            name = layer.name.strip().casefold()
            parent_name = layer.parent.name.strip().casefold()
            ancestor_names = set()
            ancestor = layer.parent
            while ancestor is not None and ancestor is not psd:
                ancestor_names.add(ancestor.name.strip().casefold())
                ancestor = getattr(ancestor, "parent", None)
            is_cloud_shape = (
                ("cloud" in parent_name or "coloud" in parent_name)
                and name in {"cloud", "clouds"}
            )
            is_far_building_shape = (
                parent_name == "far buildings" and name != "s"
            )
            is_sun_shape = parent_name == "sun" and name == "sun"
            is_wall_pattern = (
                (parent_name == "building" and name == "brick texture")
                or name in {"brick", "bricks"}
            )
            is_sign_detail = (
                parent_name == "group 3"
                and "building" in ancestor_names
                and layer.width < psd.width
                and layer.height < psd.height
            )
            if (
                is_cloud_shape
                or is_far_building_shape
                or is_sun_shape
                or is_wall_pattern
                or is_sign_detail
            ):
                candidates.append(layer)
    return candidates


def _unpaired_colour_shape_layers(psd, authored_line_ids):
    """Find painted shapes in groups that have no authored line layer.

    Some BG files use transparent colour shapes themselves as the drawing:
    clouds and distant buildings are common examples. Their alpha boundary is
    the missing line, while groups that already contain a Line layer must keep
    using that authored line instead of receiving a duplicate outline.
    """
    candidates = []

    def walk(group, ancestors_visible=True, covered_by_composite=False):
        group_visible = ancestors_visible and (
            group is psd or group.is_visible()
        )
        if not group_visible:
            return
        children = list(group)
        leaves = [
            layer for layer in children
            if (
                not layer.is_group()
                and layer.is_visible()
                and layer.bbox != (0, 0, 0, 0)
            )
        ]
        composite_leaves = [
            layer for layer in leaves
            if "png" in layer.name.casefold()
        ]
        has_authored_line = (
            group is not psd
            and _is_named_line_layer(group.name)
        ) or any(
            id(layer) in authored_line_ids
            or _is_named_line_layer(layer.name)
            for layer in leaves
        )
        if not has_authored_line and not covered_by_composite:
            for layer in composite_leaves or leaves:
                area = layer.width * layer.height
                if area < 1_000:
                    continue
                image = layer.topil()
                if image is None:
                    continue
                alpha = np.array(
                    image.convert("RGBA"), dtype=np.uint8)[..., 3]
                occupancy = float(np.mean(alpha >= 8))
                opaque = float(np.mean(alpha >= 247))
                bounded = (
                    layer.width < psd.width * 0.98
                    and layer.height < psd.height * 0.98
                )
                # Reject full-canvas/base paint and tiny texture such as stars.
                # Also reject sparse antialiased ink: painted silhouettes have
                # a predominantly opaque interior, while line art does not.
                if (
                    0.01 <= occupancy
                    and (occupancy <= 0.98 or bounded)
                    and opaque >= occupancy * 0.5
                ):
                    candidates.append(layer)
        for layer in children:
            if layer.is_group():
                walk(
                    layer,
                    group_visible,
                    covered_by_composite or bool(composite_leaves),
                )

    art_roots = [
        layer for layer in psd
        if (
            layer.is_group()
            and layer.is_visible()
            and _object_key(layer.name) in {
                "art", "artwork", "design", "prop",
            }
        )
    ]
    # Mixed BG documents explicitly separate ART from field guides. Documents
    # with an authored line system (such as character turnarounds) should not
    # synthesize contours from every colour/text layer.
    if not art_roots:
        return []
    for root in art_roots:
        walk(root)
    return candidates


def _prop_background_plates(psd):
    """Find dense prop backing plates that need coarse structural edges."""
    roots = [
        layer for layer in psd
        if (
            layer.is_group()
            and layer.is_visible()
            and _object_key(layer.name) == "prop"
        )
    ]
    candidates = []
    for root in roots:
        for layer in root.descendants():
            if (
                layer.is_group()
                or not layer.is_visible()
                or layer.bbox == (0, 0, 0, 0)
                or layer.width < psd.width * 0.98
                or not (psd.height * 0.50 <= layer.height < psd.height * 0.98)
            ):
                continue
            image = layer.topil()
            if image is None:
                continue
            alpha = np.array(
                image.convert("RGBA"), dtype=np.uint8)[..., 3]
            occupied = float(np.mean(alpha >= 8))
            opaque = float(np.mean(alpha >= 247))
            if occupied > 0.98 and opaque >= occupied * 0.9:
                candidates.append(layer)
    return candidates


def _reference_character_layers(psd):
    """Find large flattened character illustrations in reference groups."""
    document_area = psd.width * psd.height
    candidates = []
    for group in psd:
        if (
            not group.is_group()
            or not group.is_visible()
            or _object_key(group.name) != "extraref"
        ):
            continue
        for layer in group:
            if (
                layer.is_group()
                or not layer.is_visible()
                or layer.bbox == (0, 0, 0, 0)
                or layer.width * layer.height < document_area * 0.08
            ):
                continue
            image = layer.topil()
            if image is None:
                continue
            alpha = np.array(
                image.convert("RGBA"), dtype=np.uint8)[..., 3]
            occupancy = float(np.mean(alpha >= 8))
            if 0.10 <= occupancy <= 0.90:
                candidates.append(layer)
    return candidates


def _paired_reference_line_layers(psd):
    """Find unnamed grayscale line layers paired with a brighter fill."""
    roots = [
        layer for layer in psd
        if (
            layer.is_group()
            and layer.is_visible()
            and _object_key(layer.name) == "extraref"
        )
    ]
    candidates = []
    for root in roots:
        for group in root.descendants():
            if not group.is_group() or not group.is_visible():
                continue
            leaves = [
                layer for layer in group
                if (
                    not layer.is_group()
                    and layer.is_visible()
                    and layer.bbox != (0, 0, 0, 0)
                )
            ]
            if len(leaves) < 2:
                continue
            stats = []
            for layer in leaves:
                image = layer.topil()
                if image is None:
                    continue
                rgba = np.array(image.convert("RGBA"), dtype=np.uint8)
                occupied = rgba[..., 3] >= 8
                occupancy = float(np.mean(occupied))
                if not occupied.any():
                    continue
                pixels = rgba[..., :3][occupied].astype(np.int16)
                neutral = float(np.mean(
                    pixels.max(axis=1) - pixels.min(axis=1) <= 5))
                mean = float(np.mean(pixels))
                stats.append((layer, occupancy, neutral, mean))
            for layer, occupancy, neutral, mean in stats:
                if not (
                    0.005 <= occupancy <= 0.25
                    and neutral >= 0.90
                    and mean <= 180
                ):
                    continue
                if any(
                    other_occupancy >= occupancy * 1.5
                    and other_mean >= mean + 30
                    for (
                        other_layer,
                        other_occupancy,
                        other_neutral,
                        other_mean,
                    ) in stats
                    if other_layer is not layer
                ):
                    candidates.append(layer)
    return candidates


def _standalone_pose_line_layers(psd):
    """Find authored sketch ink paired with tone inside a primary pose group."""
    candidates = []
    roots = [
        layer for layer in psd
        if (
            layer.is_group()
            and layer.is_visible()
            and "pose" in set(re.findall(
                r"[^\W_]+", layer.name.casefold()))
            and not (
                set(re.findall(r"[^\W_]+", layer.name.casefold()))
                & {"extra", "ref", "refs"}
            )
        )
    ]
    for root in roots:
        groups = [root, *[
            layer for layer in root.descendants()
            if layer.is_group() and layer.is_visible()
        ]]
        for group in groups:
            leaves = [
                layer for layer in group
                if (
                    not layer.is_group()
                    and layer.is_visible()
                    and layer.bbox != (0, 0, 0, 0)
                )
            ]
            sketches = [
                layer for layer in leaves
                if "sketch" in set(re.findall(
                    r"[^\W_]+", layer.name.casefold()))
            ]
            if not sketches:
                continue
            for layer in sketches:
                image = layer.topil()
                if image is None:
                    continue
                alpha = np.array(
                    image.convert("RGBA"), dtype=np.uint8)[..., 3]
                occupancy = float(np.mean(alpha >= 8))
                if not 0.005 <= occupancy <= 0.25:
                    continue
                if any(
                    other is not layer
                    and other.width * other.height >= (
                        layer.width * layer.height * 0.25
                    )
                    for other in leaves
                ):
                    candidates.append(layer)
    return candidates


def _compositing_notice_layers(psd):
    """Keep the delivery note attached to a standalone authored pose."""
    candidates = []
    for group in psd:
        if (
            not group.is_group()
            or not group.is_visible()
            or _object_key(group.name) != "template"
        ):
            continue
        for layer in group:
            words = set(re.findall(r"[^\W_]+", layer.name.casefold()))
            if (
                not layer.is_group()
                and layer.is_visible()
                and {"invisible", "lines"} <= words
                and any(word.startswith("compo") for word in words)
                and layer.bbox != (0, 0, 0, 0)
            ):
                candidates.append(layer)
    return candidates


def _compose_authored_alpha(psd, layers):
    out = np.zeros((psd.height, psd.width), dtype=np.uint8)
    for layer in layers:
        image = layer.topil()
        if image is None:
            continue
        alpha = np.array(image.convert("RGBA"), dtype=np.uint8)[..., 3]
        _composite_layer_alpha(out, layer, alpha)
    return out


def _coloured_sketch_alpha(rgba):
    """Use authored coverage except where a coloured sketch paints white."""
    alpha = rgba[..., 3].copy()
    white_fill = np.min(rgba[..., :3], axis=2) >= 245
    alpha[white_fill] = 0
    return alpha


def _sketch_design_alpha(psd):
    """Preserve sparse coloured pencil layers from a primary DESIGN page."""
    roots = [
        layer for layer in psd
        if (
            layer.is_group()
            and layer.is_visible()
            and _object_key(layer.name) == "design"
        )
    ]
    if len(roots) != 1:
        return None
    page_groups = [
        layer for layer in roots[0].descendants()
        if (
            layer.is_group()
            and layer.is_visible()
            and _object_key(layer.name) == "page"
        )
    ]
    if not page_groups:
        return None
    selected = []
    found_paper = False
    for group in page_groups:
        for layer in group:
            if (
                layer.is_group()
                or not layer.is_visible()
                or layer.bbox == (0, 0, 0, 0)
            ):
                continue
            image = layer.topil()
            if image is None:
                continue
            rgba = np.array(image.convert("RGBA"), dtype=np.uint8)
            occupied = rgba[..., 3] >= 8
            occupancy = float(np.mean(occupied))
            if not occupied.any():
                continue
            pixels = rgba[..., :3][occupied]
            neutral = float(np.mean(
                pixels.max(axis=1) - pixels.min(axis=1) <= 5))
            mean = float(np.mean(pixels))
            if occupancy >= 0.50 and neutral >= 0.85 and mean >= 240:
                found_paper = True
                continue
            if (
                occupancy <= 0.35
                and not (neutral >= 0.85 and mean >= 235)
            ):
                selected.append((layer, neutral < 0.85))
    if not found_paper or not selected:
        return None
    out = np.zeros((psd.height, psd.width), dtype=np.uint8)
    for layer, coloured in selected:
        image = layer.topil()
        if image is None:
            continue
        rgba = np.array(image.convert("RGBA"), dtype=np.uint8)
        alpha = (
            _coloured_sketch_alpha(rgba)
            if coloured
            else rgba[..., 3]
        )
        _composite_layer_alpha(out, layer, alpha)
    return out, len(selected)


def _coloured_prop_alpha(psd):
    """Preserve coloured authored ink and outline fills in a PROPS object."""
    roots = [
        layer for layer in psd
        if (
            layer.is_group()
            and layer.is_visible()
            and _object_key(layer.name) == "prop"
        )
    ]
    if len(roots) != 1:
        return None
    objects = []
    for group in roots[0]:
        if not group.is_group() or not group.is_visible():
            continue
        child_groups = [
            child for child in group
            if child.is_group() and child.is_visible()
        ]
        if (
            any(_is_named_line_layer(child.name) for child in child_groups)
            and any(_is_colour_group_name(child.name) for child in child_groups)
        ):
            objects.append(group)
    if len(objects) != 1:
        return None
    visible_children = [
        child for child in roots[0]
        if child.is_visible() and child.bbox != (0, 0, 0, 0)
    ]
    if any(child is not objects[0] for child in visible_children):
        # A partial structural match must not silently drop sibling props.
        # The root-scoped general path below keeps all production objects.
        return None
    line_layers = []
    colour_layers = []
    coloured_line = False
    for layer in objects[0].descendants():
        if (
            layer.is_group()
            or not layer.is_visible()
            or layer.clipping
            or layer.bbox == (0, 0, 0, 0)
        ):
            continue
        in_line = _is_named_line_layer(layer.name)
        in_colour = False
        parent = layer.parent
        while parent is not None and parent is not psd:
            if parent.is_group():
                in_line = in_line or _is_named_line_layer(parent.name)
                in_colour = in_colour or _is_colour_group_name(parent.name)
            parent = parent.parent
        image = layer.topil()
        if image is None:
            continue
        rgba = np.array(image.convert("RGBA"), dtype=np.uint8)
        occupied = rgba[..., 3] >= 8
        if in_line:
            line_layers.append((layer, rgba[..., 3]))
            if occupied.any():
                pixels = rgba[..., :3][occupied]
                coloured_line = coloured_line or bool(np.mean(
                    pixels.max(axis=1) - pixels.min(axis=1) > 5) >= 0.50)
        elif in_colour:
            colour_layers.append((layer, rgba[..., 3]))
    if not coloured_line or not line_layers or not colour_layers:
        return None
    out = np.zeros((psd.height, psd.width), dtype=np.uint8)
    for layer, alpha in line_layers:
        _composite_layer_alpha(out, layer, alpha)
    for layer, alpha in colour_layers:
        _composite_layer_alpha(out, layer, _shape_outline_alpha(alpha))
    return out, len(line_layers) + len(colour_layers)


def _crowd_silhouette_alpha(psd):
    """Trace numbered MG/FG crowd silhouettes without layout/reference art."""
    roots = [
        layer for layer in psd
        if (
            layer.is_group()
            and layer.is_visible()
            and _object_key(layer.name) == "crowd"
        )
    ]
    if len(roots) != 1:
        return None
    depth_groups = [
        layer for layer in roots[0]
        if (
            layer.is_group()
            and layer.is_visible()
            and _object_key(layer.name) in {"mg", "fg"}
        )
    ]
    if not depth_groups:
        return None
    silhouettes = [
        layer
        for group in depth_groups
        for layer in group
        if (
            not layer.is_group()
            and layer.is_visible()
            and not layer.clipping
            and layer.bbox != (0, 0, 0, 0)
            and re.fullmatch(r"\d+", layer.name.strip())
        )
    ]
    if not silhouettes:
        return None

    out = np.zeros((psd.height, psd.width), dtype=np.uint8)
    occlusion = np.zeros((psd.height, psd.width), dtype=bool)
    # PSD children are stored back-to-front. Walk them in reverse so the
    # occlusion mask follows the same front-to-back order as the composite
    # preview (FG over MG, and higher-numbered stack entries underneath).
    for layer in reversed(silhouettes):
        image = layer.topil()
        if image is None:
            continue
        alpha = np.array(image.convert("RGBA"), dtype=np.uint8)[..., 3]
        outline = _shape_outline_alpha(alpha)
        left, top, _, _ = layer.bbox
        src_x = max(0, -left)
        src_y = max(0, -top)
        dst_x = max(0, left)
        dst_y = max(0, top)
        width = min(alpha.shape[1] - src_x, psd.width - dst_x)
        height = min(alpha.shape[0] - src_y, psd.height - dst_y)
        if width <= 0 or height <= 0:
            continue
        blocked = np.array(
            Image.fromarray(
                occlusion[
                    dst_y:dst_y + height,
                    dst_x:dst_x + width,
                ].astype(np.uint8) * 255,
                "L",
            ).filter(ImageFilter.MaxFilter(3)),
            dtype=np.uint8,
        ) > 0
        local_outline = outline[
            src_y:src_y + height,
            src_x:src_x + width,
        ].copy()
        local_outline[blocked] = 0
        local_alpha = np.zeros_like(alpha)
        local_alpha[
            src_y:src_y + height,
            src_x:src_x + width,
        ] = local_outline
        _composite_layer_alpha(out, layer, local_alpha)
        occlusion[
            dst_y:dst_y + height,
            dst_x:dst_x + width,
        ] |= (
            alpha[
                src_y:src_y + height,
                src_x:src_x + width,
            ] >= 8
        )

    background = np.zeros_like(out)
    background_count = 0
    layout_roots = [
        layer for layer in psd
        if (
            layer.is_group()
            and layer.is_visible()
            and _object_key(layer.name) == "layout"
        )
    ]
    if len(layout_roots) == 1:
        for layer in layout_roots[0].descendants():
            if (
                layer.is_group()
                or not layer.is_visible()
                or layer.clipping
                or layer.bbox == (0, 0, 0, 0)
                or not (
                    _is_named_line_layer(layer.name)
                    or _object_key(layer.name) in {"neon", "pupil"}
                )
            ):
                continue
            image = layer.topil()
            if image is None:
                continue
            alpha = np.array(image.convert("RGBA"), dtype=np.uint8)[..., 3]
            opacity = int(layer.opacity)
            parent = layer.parent
            while parent is not None and parent is not psd:
                opacity = (opacity * int(parent.opacity) + 127) // 255
                parent = parent.parent
            if opacity < 255:
                alpha = (
                    (
                        alpha.astype(np.uint16) * opacity
                        + 127
                    ) // 255
                ).astype(np.uint8)
            _composite_layer_alpha(background, layer, alpha)
            background_count += 1
    background[occlusion] = 0

    combined = (
        out.astype(np.uint16)
        + (
            background.astype(np.uint16)
            * (255 - out.astype(np.uint16))
            + 127
        ) // 255
    ).astype(np.uint8)

    foreground = np.zeros_like(out)
    foreground_coverage = np.zeros_like(out)
    foreground_count = 0
    for layer in psd:
        if (
            layer.is_group()
            or not layer.is_visible()
            or layer.clipping
            or layer.bbox == (0, 0, 0, 0)
            or _object_key(layer.name) != "fence"
        ):
            continue
        image = layer.topil()
        if image is None:
            continue
        alpha = np.array(image.convert("RGBA"), dtype=np.uint8)[..., 3]
        _composite_layer_alpha(
            foreground_coverage,
            layer,
            np.where(alpha >= 8, 255, 0).astype(np.uint8),
        )
        _composite_layer_alpha(
            foreground,
            layer,
            _shape_outline_alpha(alpha),
        )
        foreground_count += 1
    combined[foreground_coverage > 0] = 0
    combined = (
        foreground.astype(np.uint16)
        + (
            combined.astype(np.uint16)
            * (255 - foreground.astype(np.uint16))
            + 127
        ) // 255
    ).astype(np.uint8)
    return combined, len(silhouettes) + background_count + foreground_count


def _phone_interface_alpha(psd):
    """Extract authored phone views while ignoring rendered glow effects."""
    primary_roots = []
    secondary_roots = []
    for layer in psd:
        if not layer.is_group() or not layer.is_visible():
            continue
        child_keys = {
            _object_key(child.name)
            for child in layer
            if child.is_group() and child.is_visible()
        }
        has_base = any(key.endswith("base") for key in child_keys)
        has_contents = any(key.endswith("content") for key in child_keys)
        has_lines = any(key.endswith("line") for key in child_keys)
        if (
            "phone" in set(re.findall(r"[^\W_]+", layer.name.casefold()))
            and has_base
            and has_contents
            and has_lines
        ):
            primary_roots.append(layer)
        elif (
            has_base
            and has_contents
        ):
            secondary_roots.append(layer)
    if len(primary_roots) != 1:
        return None
    roots = [*primary_roots, *secondary_roots]
    out = np.zeros((psd.height, psd.width), dtype=np.uint8)
    count = 0
    for root in roots:
        for layer in root.descendants():
            if (
                layer.is_group()
                or not layer.is_visible()
                or layer.clipping
                or layer.bbox == (0, 0, 0, 0)
                or "glowing" in layer.name.casefold()
            ):
                continue
            image = layer.topil()
            if image is None:
                continue
            alpha = np.array(image.convert("RGBA"), dtype=np.uint8)[..., 3]
            in_line = _is_named_line_layer(layer.name)
            parent = layer.parent
            while parent is not None and parent is not psd:
                if parent.is_group():
                    in_line = in_line or _is_named_line_layer(parent.name)
                parent = parent.parent
            _composite_layer_alpha(
                out,
                layer,
                alpha if in_line else _shape_outline_alpha(alpha),
            )
            count += 1
    return (out, count) if count else None


def _isolated_style_alpha(psd):
    for mode, extractor in (
        ("crowdSilhouettes", _crowd_silhouette_alpha),
        ("sketchDesign", _sketch_design_alpha),
        ("colouredProp", _coloured_prop_alpha),
        ("phoneInterfaceNoGlow", _phone_interface_alpha),
    ):
        result = extractor(psd)
        if result is not None:
            mask, count = result
            return mask, count, mode
    return None


def _drawing_panel_boxes(psd):
    roots = [
        layer for layer in psd
        if (
            layer.is_group()
            and layer.is_visible()
            and _object_key(layer.name) == "drawing"
        )
    ]
    if len(roots) != 1:
        return []
    leaves = [
        layer for layer in roots[0]
        if (
            not layer.is_group()
            and layer.is_visible()
            and layer.bbox != (0, 0, 0, 0)
        )
    ]
    if len(leaves) < 2:
        return []
    for layer in leaves:
        image = layer.topil()
        if image is None:
            return []
        alpha = np.array(image.convert("RGBA"), dtype=np.uint8)[..., 3]
        if float(np.mean(alpha >= 247)) < 0.95:
            return []
    return [layer.bbox for layer in leaves]


def _fill_drawing_panel_strokes(mask, rgba, boxes):
    if not boxes:
        return mask
    support = _rank_filter(mask >= 16, 9, maximum=True)
    rgb = rgba[..., :3].astype(np.uint16)
    luminance = (
        rgb[..., 0] * 77 + rgb[..., 1] * 150 + rgb[..., 2] * 29
    ) >> 8
    zone = np.zeros(mask.shape, dtype=bool)
    for left, top, right, bottom in boxes:
        zone[
            max(0, top):min(mask.shape[0], bottom),
            max(0, left):min(mask.shape[1], right),
        ] = True
    out = mask.copy()
    out[(luminance <= 115) & support & zone] = 255
    return out


def _nested_art_line_layers(psd):
    """Find low-opacity coloured drawing strokes inside a nested ART group."""
    candidates = []

    def add_low_opacity_layers(nodes):
        for layer in nodes:
            if (
                layer.is_group()
                or not layer.is_visible()
                or layer.bbox == (0, 0, 0, 0)
                or layer.width * layer.height < 1_000
            ):
                continue
            image = layer.topil()
            if image is None:
                continue
            alpha = np.array(
                image.convert("RGBA"), dtype=np.uint8)[..., 3]
            occupied = float(np.mean(alpha >= 8))
            opaque = float(np.mean(alpha >= 247))
            if 0.002 <= occupied <= 0.35 and opaque <= 0.03:
                candidates.append(layer)

    for group in psd.descendants():
        if (
            not group.is_group()
            or not group.is_visible()
            or group.name.strip().casefold() != "art"
        ):
            continue
        add_low_opacity_layers(group.descendants())
        parent = group.parent
        for sibling in parent:
            sibling_name = sibling.name.strip().casefold()
            if (
                sibling.is_group()
                and sibling.is_visible()
                and sibling_name in {"text", "whiteboard"}
            ):
                add_low_opacity_layers(sibling.descendants())
            elif (
                not sibling.is_group()
                and sibling.is_visible()
                and sibling_name == "border"
            ):
                add_low_opacity_layers([sibling])
    return candidates


def _composite_layer_alpha(out, layer, alpha):
    left, top, _, _ = layer.bbox
    src_x = max(0, -left)
    src_y = max(0, -top)
    dst_x = max(0, left)
    dst_y = max(0, top)
    width = min(alpha.shape[1] - src_x, out.shape[1] - dst_x)
    height = min(alpha.shape[0] - src_y, out.shape[0] - dst_y)
    if width <= 0 or height <= 0:
        return
    source = alpha[
        src_y:src_y + height,
        src_x:src_x + width,
    ].astype(np.uint16)
    target = out[
        dst_y:dst_y + height,
        dst_x:dst_x + width,
    ].astype(np.uint16)
    out[
        dst_y:dst_y + height,
        dst_x:dst_x + width,
    ] = (
        source + ((target * (255 - source) + 127) // 255)
    ).astype(np.uint8)


def _remove_horizontal_guides(alpha, document_width):
    """Remove mechanically straight, canvas-spanning horizontal guide runs."""
    min_run = max(32, round(document_width * 0.60))
    if alpha.shape[1] < min_run:
        return alpha

    core = alpha >= 64
    guide_runs = []
    for y in range(core.shape[0]):
        xs = np.flatnonzero(core[y])
        if xs.size < min_run:
            continue
        boundaries = np.flatnonzero(np.diff(xs) > 1)
        starts = np.r_[0, boundaries + 1]
        stops = np.r_[boundaries + 1, xs.size]
        for start, stop in zip(starts, stops):
            if stop - start >= min_run:
                guide_runs.append((y, int(xs[start]), int(xs[stop - 1])))
    if not guide_runs:
        return alpha

    cleaned = alpha.copy()
    for y, x0, x1 in guide_runs:
        cleaned[
            max(0, y - 2):min(cleaned.shape[0], y + 3),
            max(0, x0 - 2):min(cleaned.shape[1], x1 + 3),
        ] = 0
    return cleaned


def _shape_outline_alpha(alpha):
    """Trace a painted alpha shape, including edges touching its layer bbox."""
    padded = np.pad(alpha, 2, mode="constant")
    solid = Image.fromarray(
        (padded >= 8).astype(np.uint8) * 255,
        "L",
    )
    outer = np.array(
        solid.filter(ImageFilter.MaxFilter(3)),
        dtype=np.int16,
    )
    inner = np.array(
        solid.filter(ImageFilter.MinFilter(3)),
        dtype=np.int16,
    )
    outline = np.array(
        Image.fromarray(
            np.clip(outer - inner, 0, 255).astype(np.uint8),
            "L",
        ).filter(ImageFilter.GaussianBlur(0.55)),
        dtype=np.uint8,
    )
    return outline[2:-2, 2:-2]


def _simplified_plate_edges(rgba):
    """Extract only large structural colour changes from a painted plate."""
    height, width = rgba.shape[:2]
    if max(width, height) >= 256:
        scale = min(1.0, 1536 / max(width, height))
        small_width = max(8, round(width * scale / 8) * 8)
        small_height = max(8, round(height * scale / 8) * 8)
        small = np.array(
            Image.fromarray(rgba, "RGBA").resize(
                (small_width, small_height),
                Image.Resampling.LANCZOS,
            ),
            dtype=np.uint8,
        )
        edges = _flattened_model_alpha(small)
        edges[edges < 48] = 0
        if (small_width, small_height) != (width, height):
            edges = np.array(
                Image.fromarray(edges, "L").resize(
                    (width, height),
                    Image.Resampling.LANCZOS,
                ),
                dtype=np.uint8,
            )
        return edges

    scale = min(1.0, 1536 / max(width, height))
    small_width = max(8, round(width * scale))
    small_height = max(8, round(height * scale))
    rgb = Image.fromarray(rgba[..., :3], "RGB").resize(
        (small_width, small_height),
        Image.Resampling.LANCZOS,
    ).filter(ImageFilter.GaussianBlur(5.0))
    alpha = Image.fromarray(rgba[..., 3], "L").resize(
        (small_width, small_height),
        Image.Resampling.LANCZOS,
    )
    small = np.empty((small_height, small_width, 4), dtype=np.uint8)
    small[..., :3] = np.array(rgb, dtype=np.uint8)
    small[..., 3] = np.array(alpha, dtype=np.uint8)
    edges = _missing_colour_edges(
        small,
        np.zeros((small_height, small_width), dtype=np.uint8),
        min_length=max(
            16,
            round(max(small_width, small_height) / 16),
        ),
    )
    if (small_width, small_height) != (width, height):
        edges = np.array(
            Image.fromarray(edges, "L").resize(
                (width, height),
                Image.Resampling.LANCZOS,
            ),
            dtype=np.uint8,
        )
    return edges


def _simplified_character_edges(rgba):
    """Recover authored-looking lines from a flattened colour character."""
    rgb = rgba[..., :3].astype(np.uint16)
    luminance = (
        rgb[..., 0] * 77
        + rgb[..., 1] * 150
        + rgb[..., 2] * 29
    ) >> 8
    spread = (
        rgba[..., :3].max(axis=2).astype(np.int16)
        - rgba[..., :3].min(axis=2).astype(np.int16)
    )
    authored_core = (
        (rgba[..., 3] >= 8)
        & (
            (luminance <= 75)
            | ((spread <= 5) & (luminance <= 170))
        )
    )
    closed = Image.fromarray(
        authored_core.astype(np.uint8) * 255,
        "L",
    ).filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.MinFilter(3))
    shell = _remove_solid_ink_interiors(
        np.array(closed, dtype=np.uint8),
    ) >= 128
    cleaned = _remove_short_components(
        shell,
        min_length=6,
        count_area=False,
    )
    edges = np.array(
        Image.fromarray(
            cleaned.astype(np.uint8) * 255,
            "L",
        ).filter(ImageFilter.GaussianBlur(0.55)),
        dtype=np.uint8,
    )
    edges[cleaned] = 255
    colour_edges = _missing_colour_edges(
        rgba,
        edges,
        min_length=8,
    )
    np.maximum(edges, colour_edges, out=edges)
    edges[rgba[..., 3] < 8] = 0
    return edges


def _thin_colour_edges(rgba, include_alpha=True, threshold=12):
    """Create fixed-width one-sided boundaries for flattened cel graphics."""
    rgb = np.array(
        Image.fromarray(rgba[..., :3], "RGB").filter(
            ImageFilter.MedianFilter(3)),
        dtype=np.int16,
    )
    alpha = rgba[..., 3] >= 8
    edge = np.zeros(alpha.shape, dtype=bool)
    horizontal = np.max(
        np.abs(rgb[:, 1:] - rgb[:, :-1]),
        axis=2,
    ) >= threshold
    vertical = np.max(
        np.abs(rgb[1:] - rgb[:-1]),
        axis=2,
    ) >= threshold
    if include_alpha:
        edge[:, :-1] |= horizontal
        edge[:-1, :] |= vertical
        edge[:, :-1] |= alpha[:, :-1] ^ alpha[:, 1:]
        edge[:-1, :] |= alpha[:-1, :] ^ alpha[1:, :]
    else:
        edge[:, :-1] |= horizontal & alpha[:, :-1] & alpha[:, 1:]
        edge[:-1, :] |= vertical & alpha[:-1, :] & alpha[1:, :]
    support = np.array(
        Image.fromarray(
            alpha.astype(np.uint8) * 255,
            "L",
        ).filter(ImageFilter.MaxFilter(3)),
        dtype=np.uint8,
    ) > 0
    edge &= support
    edge = _remove_short_components(
        edge,
        min_length=8,
        count_area=False,
    )
    core = np.array(
        Image.fromarray(
            edge.astype(np.uint8) * 255,
            "L",
        ).filter(ImageFilter.MaxFilter(3)),
        dtype=np.uint8,
    )
    antialiased = np.array(
        Image.fromarray(core, "L").filter(
            ImageFilter.GaussianBlur(0.85)
        ),
        dtype=np.uint8,
    )
    antialiased[core > 0] = 255
    return antialiased


def _remove_solid_ink_interiors(alpha):
    """Keep strokes and filled-shape boundaries, but remove colour interiors."""
    core = alpha >= 8
    eroded = _rank_filter(core, 15, maximum=False)
    shell = core & ~eroded
    out = np.array(
        Image.fromarray(
            shell.astype(np.uint8) * 255,
            "L",
        ).filter(ImageFilter.GaussianBlur(0.55)),
        dtype=np.uint8,
    )
    out[shell] = 255
    return out


def _remove_large_solid_interiors(
        alpha, filter_size=31, thin_outline=False):
    """Hollow broad fills while leaving normal authored stroke widths alone."""
    core = alpha >= 8
    # At production sizes a genuine line remains narrower than this even when
    # antialiased. Large pasted silhouettes and opaque "lines" layers do not.
    # Keeping a shell preserves their visible boundary instead of deleting the
    # object outright.
    deep_interior = _rank_filter(core, filter_size, maximum=False)
    if not np.any(deep_interior):
        return alpha
    out = alpha.copy()
    if thin_outline:
        # Erosion proves that a region is paint. Remove only pixels deeper than
        # the authored line width, near that proof. This leaves source line
        # alpha untouched and cannot thicken unrelated thin strokes.
        paint_support = _rank_filter(
            deep_interior,
            filter_size * 2 + 1,
            maximum=True,
        )
        paint_interior = (
            _rank_filter(core, 7, maximum=False)
            & paint_support
        )
        out[paint_interior] = 0
        # Only the newly cut inner edge needs antialiasing. Blurring the whole
        # layer would alter authored strokes, so blend the filtered alpha in a
        # one-pixel band around the removed paint and nowhere else.
        inner_edge_band = (
            _rank_filter(paint_interior, 3, maximum=True)
            & ~_rank_filter(paint_interior, 3, maximum=False)
        )
        smoothed = np.array(
            Image.fromarray(out, "L").filter(
                ImageFilter.GaussianBlur(0.85)
            ),
            dtype=np.uint8,
        )
        out[inner_edge_band] = smoothed[inner_edge_band]
    else:
        out[deep_interior] = 0
    return out


def _remove_mixed_line_fill_interiors(alpha):
    """Remove embedded fills without changing normal authored strokes."""
    core = alpha >= 8
    eroded = _rank_filter(core, 7, maximum=False)
    shell = core & ~eroded
    out = np.array(
        Image.fromarray(
            shell.astype(np.uint8) * 255,
            "L",
        ).filter(ImageFilter.GaussianBlur(0.45)),
        dtype=np.uint8,
    )
    out[shell] = 255
    return out


def _inside_mixed_line_container(layer):
    parent = layer.parent
    while parent is not None:
        if parent.is_group() and _is_named_line_layer(parent.name):
            return any(
                child.is_group()
                and _is_colour_group_name(child.name)
                for child in parent
            )
        parent = parent.parent
    return False


def _rendered_edge_support(rgba):
    """Return visible rendered boundaries, including antialiased support."""
    height, width = rgba.shape[:2]
    support = np.zeros((height, width), dtype=bool)
    tile_size = 512
    overlap = 10
    for y0 in range(0, height, tile_size):
        y1 = min(height, y0 + tile_size)
        ey0, ey1 = max(0, y0 - overlap), min(height, y1 + overlap)
        for x0 in range(0, width, tile_size):
            x1 = min(width, x0 + tile_size)
            ex0, ex1 = max(0, x0 - overlap), min(width, x1 + overlap)
            tile = rgba[ey0:ey1, ex0:ex1, :3]
            high = _rank_filter(tile, 3, maximum=True)
            low = _rank_filter(tile, 3, maximum=False)
            sharp = np.max(high - low, axis=2)
            expanded = sharp >= 6
            for _ in range(3):
                expanded = _rank_filter(expanded, 5, maximum=True)
            support[y0:y1, x0:x1] = expanded[
                y0 - ey0:y1 - ey0,
                x0 - ex0:x1 - ex0,
            ]
    return support


def _visible_colour_edge_support(rgba):
    """Return narrow boundaries that survive the final visible composite."""
    height, width = rgba.shape[:2]
    support = np.zeros((height, width), dtype=bool)
    tile_size = 512
    overlap = 4
    for y0 in range(0, height, tile_size):
        y1 = min(height, y0 + tile_size)
        ey0, ey1 = max(0, y0 - overlap), min(height, y1 + overlap)
        for x0 in range(0, width, tile_size):
            x1 = min(width, x0 + tile_size)
            ex0, ex1 = max(0, x0 - overlap), min(width, x1 + overlap)
            tile = rgba[ey0:ey1, ex0:ex1]
            high = _rank_filter(tile[..., :3], 3, maximum=True)
            low = _rank_filter(tile[..., :3], 3, maximum=False)
            sharp = np.max(high - low, axis=2)
            expanded = _rank_filter(sharp >= 2, 3, maximum=True)
            support[y0:y1, x0:x1] = expanded[
                y0 - ey0:y1 - ey0,
                x0 - ex0:x1 - ex0,
            ]
    return support


def _retain_visible_edge_runs(edges, visible_support, bridge=4):
    """Keep visible candidate runs and close short support dropouts."""
    candidate = edges >= 8
    keep = candidate & visible_support
    for _ in range(bridge):
        expanded = _rank_filter(keep, 3, maximum=True)
        keep |= candidate & expanded
    return np.where(keep, edges, 0).astype(np.uint8)


def _keep_visible_outline(outline, layer, edge_support):
    """Suppress authored colour boundaries hidden by layers above them."""
    if edge_support is None:
        return outline
    left, top, _, _ = layer.bbox
    src_x = max(0, -left)
    src_y = max(0, -top)
    dst_x = max(0, left)
    dst_y = max(0, top)
    width = min(
        outline.shape[1] - src_x,
        edge_support.shape[1] - dst_x,
    )
    height = min(
        outline.shape[0] - src_y,
        edge_support.shape[0] - dst_y,
    )
    visible = np.zeros(outline.shape, dtype=bool)
    if width > 0 and height > 0:
        visible[
            src_y:src_y + height,
            src_x:src_x + width,
        ] = edge_support[
            dst_y:dst_y + height,
            dst_x:dst_x + width,
        ]
    outline[~visible] = 0
    return outline


def _is_character_fill_line_layer(layer, psd):
    """Recognize character ink paired with fills without relying on filenames."""
    branch = layer
    parent = layer.parent
    while parent is not None and parent is not psd:
        if (
            parent.is_group()
            and _object_key(parent.name) in {"turn", "turnaround"}
        ):
            return True
        if (
            _is_named_line_layer(branch.name)
            and any(
                sibling is not branch
                and sibling.is_visible()
                and _is_colour_group_name(sibling.name)
                for sibling in parent
            )
        ):
            return True
        branch = parent
        parent = parent.parent
    return False


def _named_line_alpha(session):
    """Composite explicit visible Line layers, independent of their RGB ink."""
    psd = session["psd"]
    isolated = _isolated_style_alpha(psd)
    if isolated is not None:
        mask, count, mode = isolated
        return (
            np.ascontiguousarray(mask),
            count,
            0,
            0,
            0,
            0,
            mode,
        )
    candidates = []

    def walk(nodes, line_group=False, ancestors_visible=True):
        for layer in nodes:
            if production_roots and not _inside_roots(
                layer, production_roots, psd
            ):
                continue
            effectively_visible = ancestors_visible and layer.is_visible()
            if layer.is_group():
                if (
                    production_roots
                    and _object_key(layer.name) in _NON_ART_CHILD_KEYS
                ):
                    continue
                next_line_group = (
                    line_group or _is_named_line_layer(layer.name)
                )
                if _is_colour_group_name(layer.name):
                    next_line_group = False
                walk(
                    layer,
                    next_line_group,
                    effectively_visible,
                )
            elif (
                effectively_visible
                and not _is_non_art_line_layer(layer.name)
                and (
                    _is_named_line_layer(layer.name)
                    or (
                    line_group
                    and (
                        _has_sparse_alpha(layer, psd)
                        or _has_authored_line_alpha(layer)
                        or _is_character_fill_line_layer(layer, psd)
                    )
                    )
                )
                and layer.bbox != (0, 0, 0, 0)
            ):
                candidates.append(layer)

    production_roots = _production_roots(psd)
    walk(production_roots or psd)
    candidate_ids = {id(layer) for layer in candidates}
    for layer in _nested_art_line_layers(psd):
        if production_roots and not _inside_roots(
            layer, production_roots, psd
        ):
            continue
        if id(layer) not in candidate_ids:
            candidates.append(layer)
            candidate_ids.add(id(layer))
    for layer in _paired_component_line_layers(psd):
        if production_roots and not _inside_roots(
            layer, production_roots, psd
        ):
            continue
        if id(layer) not in candidate_ids:
            candidates.append(layer)
            candidate_ids.add(id(layer))
    standalone_pose_layers = _standalone_pose_line_layers(psd)
    for layer in standalone_pose_layers:
        if id(layer) not in candidate_ids:
            candidates.append(layer)
            candidate_ids.add(id(layer))
    if standalone_pose_layers:
        for layer in _compositing_notice_layers(psd):
            if id(layer) not in candidate_ids:
                candidates.append(layer)
                candidate_ids.add(id(layer))
    exclusive_production = any(
        _object_key(root.name) in {"drawing", "illustration", "prop"}
        for root in production_roots
    ) or (
        bool(production_roots)
        and all(
            _object_key(root.name) not in {
                "art", "artwork", "design", "turn", "turnaround",
            }
            for root in production_roots
        )
    )
    outline_only_ids = set()
    if not exclusive_production:
        for layer in _paired_reference_line_layers(psd):
            outline_only_ids.add(id(layer))
            if id(layer) not in candidate_ids:
                candidates.append(layer)
                candidate_ids.add(id(layer))
    if _uses_clean_style(psd) or _is_fl102_document(session):
        for layer in _sparse_black_line_layers(psd):
            if id(layer) not in candidate_ids:
                candidates.append(layer)
                candidate_ids.add(id(layer))
    if _is_fl102_document(session):
        for layer in _fl102_semantic_ink_layers(psd):
            if id(layer) not in candidate_ids:
                candidates.append(layer)
                candidate_ids.add(id(layer))
    # A clipped layer only recolours the opaque pixels of its base layer; it
    # cannot add visible coverage. Extracting its raw alpha separately exposes
    # alternate face, hair, and hand drawings that Photoshop correctly clips
    # out of the final preview. The unclipped base already carries the exact
    # authored line alpha and thickness.
    candidates = [
        layer for layer in candidates
        if not layer.clipping
    ]
    candidate_ids = {id(layer) for layer in candidates}
    outline_only_ids &= candidate_ids
    if standalone_pose_layers:
        candidates = [
            *standalone_pose_layers,
            *_compositing_notice_layers(psd),
        ]
        candidates = [
            layer for layer in candidates
            if not layer.clipping
        ]
        candidate_ids = {id(layer) for layer in candidates}
        outline_only_ids = set()
    silhouette_layers = _style_silhouette_layers(
        psd,
        include_all=_is_fl102_document(session),
    )
    if exclusive_production:
        silhouette_layers = [
            layer for layer in silhouette_layers
            if _inside_roots(layer, production_roots, psd)
        ]
    silhouette_ids = {id(layer) for layer in silhouette_layers}
    for layer in _unpaired_colour_shape_layers(psd, candidate_ids):
        if id(layer) not in silhouette_ids:
            silhouette_layers.append(layer)
            silhouette_ids.add(id(layer))
    graphic_layers = [
        layer for layer in psd.descendants()
        if (
            not layer.is_group()
            and layer.is_visible()
            and layer.bbox != (0, 0, 0, 0)
            and "png" in layer.name.casefold()
            and id(layer) in silhouette_ids
        )
    ]
    graphic_ids = {id(layer) for layer in graphic_layers}
    silhouette_layers = [
        layer for layer in silhouette_layers
        if id(layer) not in graphic_ids
    ]
    simplified_layers = _prop_background_plates(psd)
    if exclusive_production:
        simplified_layers = [
            layer for layer in simplified_layers
            if _inside_roots(layer, production_roots, psd)
        ]
    character_layers = (
        [] if exclusive_production else _reference_character_layers(psd)
    )
    if (
        not candidates
        and not silhouette_layers
        and not simplified_layers
        and not character_layers
        and not graphic_layers
    ):
        return None

    edge_support = None
    if silhouette_layers or simplified_layers:
        embedded = psd.composite(force=False)
        if embedded is not None:
            embedded_rgba = np.array(
                embedded.convert("RGBA"), dtype=np.uint8)
            if np.any(embedded_rgba != embedded_rgba[0, 0]):
                edge_support = _rendered_edge_support(embedded_rgba)

    # Decode only the selected layer bounds. A whole-document compositor made
    # a 1.1 GB PSB peak above 3 GB even though its 26 Line layers occupy a
    # small fraction of the canvas.
    out = np.zeros((psd.height, psd.width), dtype=np.uint8)
    seen_candidate_content = set()
    for layer in candidates:
        image = layer.topil()
        if image is None:
            continue
        alpha = np.array(image.convert("RGBA"), dtype=np.uint8)[..., 3]
        content_key = (
            tuple(layer.bbox),
            hashlib.sha256(alpha.tobytes()).digest(),
        )
        if content_key in seen_candidate_content:
            continue
        seen_candidate_content.add(content_key)
        if _is_character_fill_line_layer(layer, psd):
            alpha = _remove_large_solid_interiors(
                alpha,
                filter_size=11,
                thin_outline=True,
            )
        elif _inside_mixed_line_container(layer):
            alpha = _remove_mixed_line_fill_interiors(alpha)
        alpha = _remove_horizontal_guides(alpha, psd.width)
        if id(layer) in outline_only_ids:
            alpha = _remove_solid_ink_interiors(alpha)
        opacity = int(layer.opacity)
        parent = getattr(layer, "parent", None)
        while parent is not None and parent is not psd:
            opacity = (opacity * int(parent.opacity) + 127) // 255
            parent = getattr(parent, "parent", None)
        if opacity < 255:
            alpha = (
                (alpha.astype(np.uint16) * opacity + 127) // 255
            ).astype(np.uint8)

        _composite_layer_alpha(out, layer, alpha)

    for layer in silhouette_layers:
        image = layer.topil()
        if image is None:
            continue
        rgba = np.array(image.convert("RGBA"), dtype=np.uint8)
        alpha = rgba[..., 3]
        outline = _shape_outline_alpha(alpha)
        if float(np.mean(alpha >= 8)) > 0.98:
            internal_edges = _missing_colour_edges(
                rgba,
                outline,
                min_length=8,
            )
            np.maximum(outline, internal_edges, out=outline)
        _keep_visible_outline(outline, layer, edge_support)
        _composite_layer_alpha(out, layer, outline)

    background_visible = None
    if simplified_layers and silhouette_layers:
        occlusion = np.zeros((psd.height, psd.width), dtype=np.uint8)
        for layer in silhouette_layers:
            image = layer.topil()
            if image is None:
                continue
            alpha = np.array(
                image.convert("RGBA"), dtype=np.uint8)[..., 3]
            _composite_layer_alpha(occlusion, layer, alpha)
        background_visible = occlusion < 8

    for layer in simplified_layers:
        image = layer.topil()
        if image is None:
            continue
        rgba = np.array(image.convert("RGBA"), dtype=np.uint8)
        edges = _simplified_plate_edges(rgba)
        if background_visible is not None:
            _keep_visible_outline(edges, layer, background_visible)
        _composite_layer_alpha(out, layer, edges)

    cleaned = _remove_large_solid_interiors(out)
    removed = int(np.count_nonzero(out >= 8)) - int(
        np.count_nonzero(cleaned >= 8))
    if removed >= round(out.size * 0.08):
        # Some production PSDs contain pasted/opaque layers named "line".
        # Their alpha is a filled silhouette or white-backed plate, not ink.
        # The rendered composite is authoritative in that case and uses the
        # same model as its flattened PNG counterpart.
        out = _flattened_model_alpha(_artwork_rgba(session))
    else:
        out = cleaned

    for layer in character_layers:
        image = layer.topil()
        if image is None:
            continue
        rgba = np.array(image.convert("RGBA"), dtype=np.uint8)
        edges = _simplified_character_edges(rgba)
        _composite_layer_alpha(out, layer, edges)

    for layer in graphic_layers:
        image = layer.topil()
        if image is None:
            continue
        rgba = np.array(image.convert("RGBA"), dtype=np.uint8)
        edges = _thin_colour_edges(rgba)
        _composite_layer_alpha(out, layer, edges)

    if not np.any(out):
        return None
    return (
        np.ascontiguousarray(out),
        len(candidates),
        len(silhouette_layers),
        len(simplified_layers),
        len(character_layers),
        len(graphic_layers),
        "authoredPoseOnly" if standalone_pose_layers else None,
    )


def _remove_short_components(mask, min_length, count_area=True):
    if min_length <= 1:
        return mask
    h, w = mask.shape
    runs = []
    parent = []

    def find(label):
        root = label
        while parent[root] != root:
            root = parent[root]
        while parent[label] != label:
            next_label = parent[label]
            parent[label] = root
            label = next_label
        return root

    previous = []
    for y in range(h):
        row = np.asarray(mask[y], dtype=bool)
        padded = np.empty(w + 2, dtype=np.int8)
        padded[0] = padded[-1] = 0
        padded[1:-1] = row
        transitions = np.diff(padded)
        starts = np.flatnonzero(transitions == 1)
        ends = np.flatnonzero(transitions == -1) - 1
        current = []
        previous_start = 0
        for start, end in zip(starts.tolist(), ends.tolist()):
            label = len(runs)
            runs.append((y, start, end))
            parent.append(label)
            while (
                previous_start < len(previous)
                and runs[previous[previous_start]][2] < start - 1
            ):
                previous_start += 1
            overlap = previous_start
            while (
                overlap < len(previous)
                and runs[previous[overlap]][1] <= end + 1
            ):
                other_root = find(previous[overlap])
                root = find(label)
                if root != other_root:
                    parent[other_root] = root
                overlap += 1
            current.append(label)
        previous = current

    if not runs:
        return np.zeros_like(mask, dtype=bool)

    stats = {}
    for label, (y, start, end) in enumerate(runs):
        root = find(label)
        area, min_y, max_y, min_x, max_x = stats.get(
            root,
            (0, y, y, start, end),
        )
        stats[root] = (
            area + end - start + 1,
            min(min_y, y),
            max(max_y, y),
            min(min_x, start),
            max(max_x, end),
        )

    keep = {}
    for root, (area, min_y, max_y, min_x, max_x) in stats.items():
        extent = max(max_y - min_y + 1, max_x - min_x + 1)
        keep[root] = (
            max(extent, area) >= min_length
            if count_area
            else extent >= min_length
        )

    out = np.zeros_like(mask, dtype=bool)
    for label, (y, start, end) in enumerate(runs):
        if keep[find(label)]:
            out[y, start:end + 1] = True
    return out


def _rank_filter(array, size, maximum):
    """Apply an exact square rank filter without Pillow's quadratic kernel."""
    radius = size // 2
    if array.dtype == np.bool_:
        reduce = np.any if maximum else np.all
    else:
        reduce = np.max if maximum else np.min
    horizontal_pad = [(0, 0)] * array.ndim
    horizontal_pad[1] = (radius, radius)
    horizontal = reduce(
        np.lib.stride_tricks.sliding_window_view(
            np.pad(array, horizontal_pad, mode="edge"),
            size,
            axis=1,
        ),
        axis=-1,
    )
    vertical_pad = [(0, 0)] * array.ndim
    vertical_pad[0] = (radius, radius)
    return reduce(
        np.lib.stride_tricks.sliding_window_view(
            np.pad(horizontal, vertical_pad, mode="edge"),
            size,
            axis=0,
        ),
        axis=-1,
    )


def _missing_colour_edges(rgba, line_alpha, min_length):
    """Add abrupt colour-only silhouettes using the proven CHAR edge path."""
    height, width = line_alpha.shape
    out = np.zeros((height, width), dtype=np.uint8)
    tile_size = 512
    overlap = 32
    edge_options = {
        "enabled": True,
        "threshold": 12,
        "gap": 2,
        "width": 1,
        # A generated colour boundary is a silhouette, not a tiny decorative
        # dash. The dark-stroke path still preserves authored 8px details;
        # this stricter floor removes isolated paint/composite specks.
        "minLength": max(min_length, 16),
        "lineAlpha": 200,
        "colourMode": "composite",
        "edgeMode": "change",
        "widthScale": 1,
    }
    region_options = {**edge_options, "edgeMode": "region"}
    for y0 in range(0, height, tile_size):
        y1 = min(height, y0 + tile_size)
        ey0, ey1 = max(0, y0 - overlap), min(height, y1 + overlap)
        for x0 in range(0, width, tile_size):
            x1 = min(width, x0 + tile_size)
            ex0, ex1 = max(0, x0 - overlap), min(width, x1 + overlap)
            tile = rgba[ey0:ey1, ex0:ex1]
            overlay = build_overlay(
                tile,
                line_alpha[ey0:ey1, ex0:ex1],
                edge_options,
            )[..., 3]

            # Colour-change detection can follow broad illumination gradients.
            # A real painted silhouette changes abruptly within 3px; a radial
            # glow does not.
            high = _rank_filter(tile[..., :3], 3, maximum=True)
            low = _rank_filter(tile[..., :3], 3, maximum=False)
            sharp_range = np.max(
                high.astype(np.int16) - low.astype(np.int16),
                axis=2,
            )
            edge = np.where(
                sharp_range >= 12, overlay, 0).astype(np.uint8)
            change_core = edge >= 64
            region_overlay = build_overlay(
                tile,
                line_alpha[ey0:ey1, ex0:ex1],
                region_options,
            )[..., 3]
            region_core = (region_overlay >= 64) & (sharp_range >= 12)
            change_support = _rank_filter(
                change_core,
                21,
                maximum=True,
            )
            change_core |= region_core & change_support
            solid_core = _rank_filter(
                _rank_filter(change_core, 5, maximum=True),
                5,
                maximum=False,
            )
            protected_line = _rank_filter(
                line_alpha[ey0:ey1, ex0:ex1] >= 128,
                7,
                maximum=True,
            )
            solid_core &= ~protected_line
            edge = np.array(
                Image.fromarray(
                    solid_core.astype(np.uint8) * 255,
                    "L",
                ).filter(ImageFilter.GaussianBlur(0.85))
            )
            edge[solid_core] = 255
            edge[edge >= 240] = 255
            out[y0:y1, x0:x1] = edge[
                y0 - ey0:y1 - ey0,
                x0 - ex0:x1 - ex0,
            ]
    generated_core = _remove_short_components(
        out >= 64, max(min_length, 16), count_area=False)
    generated_support = np.array(
        Image.fromarray(
            generated_core.astype(np.uint8) * 255,
            "L",
        ).filter(ImageFilter.MaxFilter(5))
    ) > 0
    out[~generated_support] = 0
    return out


def _visible_content_zones(psd):
    """Return visible production roots; template/reference chrome stays out."""
    zones = []
    for layer in _production_roots(psd):
        boundary = next(
            (
                child for child in layer
                if (
                    not child.is_group()
                    and child.is_visible()
                    and child.name.strip().casefold() == "border"
                    and child.bbox != (0, 0, 0, 0)
                )
            ),
            layer,
        )
        left, top, right, bottom = boundary.bbox
        left = max(0, left)
        top = max(0, top)
        right = min(psd.width, right)
        bottom = min(psd.height, bottom)
        if right > left and bottom > top:
            zones.append((layer, (left, top, right, bottom)))
    return zones


def _composite_residual_alpha(session, line_alpha, min_length):
    """Fill line omissions by comparing output with visible composite edges."""
    zones = _visible_content_zones(session["psd"])
    if not zones:
        return np.zeros(line_alpha.shape, dtype=np.uint8), {
            "compositeEdgeCandidatePixels": 0,
            "compositeResidualPixels": 0,
            "compositeEdgeCoverageBefore": 1.0,
            "compositeEdgeCoverageAfter": 1.0,
        }

    existing_support = np.array(
        Image.fromarray(
            (line_alpha >= 32).astype(np.uint8) * 255,
            "L",
        ).filter(ImageFilter.MaxFilter(15)),
        dtype=np.uint8,
    ) > 0
    candidate_core = np.zeros(line_alpha.shape, dtype=bool)
    residual = np.zeros(line_alpha.shape, dtype=np.uint8)
    document_rgba = None
    for root, (left, top, right, bottom) in zones:
        leaf_count = sum(
            1 for layer in root.descendants() if not layer.is_group())
        if leaf_count <= 120:
            try:
                rendered = _render_production_root(root)
            except (ImportError, NotImplementedError):
                rendered = None
        else:
            rendered = None
        used_document_composite = rendered is None
        if rendered is not None:
            root_left, root_top, _, _ = root.bbox
            crop_left = left - root_left
            crop_top = top - root_top
            tile = np.array(
                rendered.convert("RGBA").crop((
                    crop_left,
                    crop_top,
                    crop_left + (right - left),
                    crop_top + (bottom - top),
                )),
                dtype=np.uint8,
            )
        else:
            if document_rgba is None:
                document_rgba = _document_rgba(session)
            tile = document_rgba[top:bottom, left:right]
        height, width = tile.shape[:2]
        scale = min(1.0, 2048 / max(width, height))
        if scale < 1.0:
            small_width = max(8, round(width * scale))
            small_height = max(8, round(height * scale))
            small = np.array(
                Image.fromarray(tile, "RGBA").resize(
                    (small_width, small_height),
                    Image.Resampling.LANCZOS,
                ),
                dtype=np.uint8,
            )
            small_edges = _missing_colour_edges(
                small,
                np.zeros((small_height, small_width), dtype=np.uint8),
                min_length=max(16, round(min_length * scale)),
            )
            edges = np.array(
                Image.fromarray(small_edges, "L").resize(
                    (width, height),
                    Image.Resampling.LANCZOS,
                ),
                dtype=np.uint8,
            )
        else:
            edges = _missing_colour_edges(
                tile,
                np.zeros(tile.shape[:2], dtype=np.uint8),
                min_length=max(16, min_length),
            )
        visible = np.array(
            Image.fromarray(
                (tile[..., 3] >= 8).astype(np.uint8) * 255,
                "L",
            ).filter(ImageFilter.MaxFilter(7)),
            dtype=np.uint8,
        ) > 0
        edges[~visible] = 0
        if used_document_composite:
            edges[_flattened_annotation_zone(tile[..., :3])] = 0
        core = edges >= 64
        candidate_core[top:bottom, left:right] |= core
        missing = ~existing_support[top:bottom, left:right]
        target = residual[top:bottom, left:right]
        np.maximum(target, np.where(missing, edges, 0), out=target)

    residual = _remove_horizontal_guides(
        residual,
        session["psd"].width,
    )
    residual_support = np.array(
        Image.fromarray(
            (residual >= 32).astype(np.uint8) * 255,
            "L",
        ).filter(ImageFilter.MaxFilter(15)),
        dtype=np.uint8,
    ) > 0
    candidate_count = int(np.count_nonzero(candidate_core))
    covered_before = int(np.count_nonzero(
        candidate_core & existing_support))
    covered_after = int(np.count_nonzero(
        candidate_core & (existing_support | residual_support)))
    return residual, {
        "compositeEdgeCandidatePixels": candidate_count,
        "compositeResidualPixels": int(np.count_nonzero(residual >= 32)),
        "compositeEdgeCoverageBefore": (
            covered_before / candidate_count if candidate_count else 1.0
        ),
        "compositeEdgeCoverageAfter": (
            covered_after / candidate_count if candidate_count else 1.0
        ),
    }


def _turn_colour_boundary_alpha(session, line_alpha):
    """Add clean internal fill boundaries without altering authored lines."""
    psd = session["psd"]
    out = np.zeros(line_alpha.shape, dtype=np.uint8)
    source_support = line_alpha >= 8
    visible_support = _visible_colour_edge_support(
        _document_rgba(session))
    seen = set()
    for root in psd:
        if (
            not root.is_group()
            or not root.is_visible()
            or _object_key(root.name) in {
                "template", "extraref", "colorpalette", "colourpalette",
            }
        ):
            continue

        sources = []
        for group in root.descendants():
            if (
                not group.is_group()
                or not group.is_visible()
                or group.bbox == (0, 0, 0, 0)
            ):
                continue
            parent = group.parent
            effectively_visible = True
            while parent is not None and parent is not psd:
                effectively_visible &= parent.is_visible()
                parent = parent.parent
            if not effectively_visible:
                continue
            if _is_colour_group_name(group.name):
                sources.append(group)
                continue
            direct_leaves = [
                layer for layer in group
                if (
                    not layer.is_group()
                    and layer.is_visible()
                    and layer.bbox != (0, 0, 0, 0)
                )
            ]
            direct_lines = [
                layer for layer in direct_leaves
                if _is_named_line_layer(layer.name)
            ]
            direct_fills = [
                layer for layer in direct_leaves
                if (
                    not _is_named_line_layer(layer.name)
                    and not _is_colour_group_name(layer.name)
                )
            ]
            if (
                len(direct_fills) >= 2
                and (
                    _is_named_line_layer(group.name)
                    or direct_lines
                )
            ):
                sources.append(group)

        for group in sources:
            rendered = group.composite()
            if rendered is None:
                continue
            rgba = np.array(rendered.convert("RGBA"), dtype=np.uint8)
            content_key = (
                tuple(group.bbox),
                hashlib.sha256(rgba.tobytes()).digest(),
            )
            if content_key in seen:
                continue
            seen.add(content_key)
            edges = _thin_colour_edges(
                rgba,
                include_alpha=False,
                threshold=8,
            )
            left, top, right, bottom = group.bbox
            clip_left = max(0, left)
            clip_top = max(0, top)
            clip_right = min(psd.width, right)
            clip_bottom = min(psd.height, bottom)
            if clip_right <= clip_left or clip_bottom <= clip_top:
                continue
            local_left = clip_left - left
            local_top = clip_top - top
            local_right = local_left + (clip_right - clip_left)
            local_bottom = local_top + (clip_bottom - clip_top)
            target = out[clip_top:clip_bottom, clip_left:clip_right]
            addition = edges[
                local_top:local_bottom,
                local_left:local_right,
            ].copy()
            local_source_support = source_support[
                clip_top:clip_bottom,
                clip_left:clip_right,
            ]
            addition[local_source_support] = 0
            source_near = np.array(
                Image.fromarray(
                    local_source_support.astype(np.uint8) * 255,
                    "L",
                ).filter(ImageFilter.MaxFilter(7)),
                dtype=np.uint8,
            ) > 0
            strict_visible_support = visible_support[
                clip_top:clip_bottom,
                clip_left:clip_right,
            ] & ~source_near
            addition = _retain_visible_edge_runs(
                addition,
                strict_visible_support,
            )
            np.maximum(target, addition, out=target)
    return out


def _cache_result(cache_key, result, profile):
    if cache_key is None:
        return
    _MASK_CACHE[cache_key] = result
    _PROFILE_CACHE[cache_key] = profile
    _MASK_CACHE.move_to_end(cache_key)
    while len(_MASK_CACHE) > _MASK_CACHE_LIMIT:
        evicted, _ = _MASK_CACHE.popitem(last=False)
        _PROFILE_CACHE.pop(evicted, None)


def _structured_model_alpha(session):
    """Run the flattened model on PSD artwork, composited over white."""
    artwork = _artwork_rgba(session)
    alpha = artwork[..., 3].astype(np.uint16)
    model_rgba = artwork.copy()
    model_rgba[..., :3] = (
        (
            artwork[..., :3].astype(np.uint16) * alpha[..., None]
            + 255 * (255 - alpha[..., None])
            + 127
        ) // 255
    ).astype(np.uint8)
    model_rgba[..., 3] = 255
    mask = _flattened_model_alpha(model_rgba)
    support = np.array(
        Image.fromarray(
            (artwork[..., 3] >= 8).astype(np.uint8) * 255,
            "L",
        ).filter(ImageFilter.MaxFilter(9)),
        dtype=np.uint8,
    ) > 0
    mask[~support] = 0
    return mask, artwork.nbytes + model_rgba.nbytes + support.nbytes


def extract_image_line(session, image_line):
    opts = normalize_options(image_line)
    cache_key = None
    if session.get("path") is not None and session.get("mtime") is not None:
        cache_key = (
            str(session["path"]),
            float(session["mtime"]),
            json.dumps(opts, sort_keys=True, separators=(",", ":")),
        )
        cached = _MASK_CACHE.get(cache_key)
        if cached is not None:
            _MASK_CACHE.move_to_end(cache_key)
            return cached

    started = time.perf_counter()
    algorithm_rss_start = _max_rss_bytes()
    structured_sibling = _matching_sibling_psd_session(session)

    named_lines = _named_line_alpha(session)
    if named_lines is not None:
        (
            mask_u8,
            named_line_count,
            silhouette_layer_count,
            simplified_background_count,
            flattened_character_count,
            flattened_graphic_count,
            exclusive_mode,
        ) = named_lines
        residual_started = time.perf_counter()
        if exclusive_mode is not None:
            residual = np.zeros_like(mask_u8)
            residual_profile = {
                "compositeEdgeCandidatePixels": 0,
                "compositeResidualPixels": 0,
                "compositeEdgeCoverageBefore": 1.0,
                "compositeEdgeCoverageAfter": 1.0,
                "compositeResidualMode": exclusive_mode,
            }
        elif _uses_explicit_turn_line_system(session["psd"]):
            residual = _turn_colour_boundary_alpha(session, mask_u8)
            residual_profile = {
                "compositeEdgeCandidatePixels": int(
                    np.count_nonzero(residual >= 32)),
                "compositeResidualPixels": int(
                    np.count_nonzero(residual >= 32)),
                "compositeEdgeCoverageBefore": 1.0,
                "compositeEdgeCoverageAfter": 1.0,
                "compositeResidualMode": "internalTurnColourBoundaries",
            }
        else:
            residual, residual_profile = _composite_residual_alpha(
                session,
                mask_u8,
                opts["minLength"],
            )
        np.maximum(mask_u8, residual, out=mask_u8)
        if exclusive_mode is None:
            artwork_rgba = _artwork_rgba(session)
            artwork_edges = _missing_colour_edges(
                artwork_rgba,
                mask_u8,
                opts["minLength"],
            )
            if _suppress_flattened_red_annotations(artwork_rgba[..., :3]):
                artwork_edges[
                    _flattened_annotation_zone(artwork_rgba[..., :3])
                ] = 0
            np.maximum(mask_u8, artwork_edges, out=mask_u8)
        mask_u8 = np.ascontiguousarray(mask_u8)
        finished = time.perf_counter()
        algorithm_rss_end = _max_rss_bytes()
        result = (
            mask_u8,
            hashlib.sha256(mask_u8.tobytes()).hexdigest(),
        )
        peak_tracked_array_bytes = mask_u8.nbytes + residual.nbytes
        if exclusive_mode is None:
            peak_tracked_array_bytes += (
                artwork_rgba.nbytes + artwork_edges.nbytes
            )
        profile = {
            "compositeSeconds": finished - started,
            "darkExtractionSeconds": 0.0,
            "boundaryExtractionSeconds": finished - residual_started,
            "suppressionUnionSeconds": 0.0,
            "totalSeconds": finished - started,
            "peakTrackedArrayBytes": int(peak_tracked_array_bytes),
            "algorithmPeakRssDeltaBytes": (
                max(0, algorithm_rss_end - algorithm_rss_start)
                if (
                    algorithm_rss_start is not None
                    and algorithm_rss_end is not None
                )
                else None
            ),
            "namedLineLayerCount": named_line_count,
            "silhouetteLayerCount": silhouette_layer_count,
            "simplifiedBackgroundLayerCount": simplified_background_count,
            "flattenedCharacterLayerCount": flattened_character_count,
            "flattenedGraphicLayerCount": flattened_graphic_count,
            **residual_profile,
        }
        _cache_result(cache_key, result, profile)
        return result

    drawing_panel_boxes = _drawing_panel_boxes(session["psd"])
    flattened_colour_plate = _flattened_colour_plate_rgba(session)
    structured_model = bool(drawing_panel_boxes) or any(
        _object_key(root.name) in {"drawing", "illustration"}
        for root in _production_roots(session["psd"])
    )
    rgba = (
        _document_rgba(session)
        if session.get("flattened_image")
        else (
            flattened_colour_plate
            if flattened_colour_plate is not None
            else _artwork_rgba(session)
        )
    )
    composite_done = time.perf_counter()
    if session.get("flattened_image") or structured_model:
        structure_bytes = 0
        if structured_sibling is not None:
            mask_u8, structure_bytes = _structured_model_alpha(
                structured_sibling)
        elif structured_model:
            mask_u8, structure_bytes = _structured_model_alpha(session)
        else:
            mask_u8 = _flattened_model_alpha(rgba)
        finished = time.perf_counter()
        algorithm_rss_end = _max_rss_bytes()
        result = (
            mask_u8,
            hashlib.sha256(mask_u8.tobytes()).hexdigest(),
        )
        profile = {
            "compositeSeconds": composite_done - started,
            "darkExtractionSeconds": 0.0,
            "boundaryExtractionSeconds": finished - composite_done,
            "suppressionUnionSeconds": 0.0,
            "totalSeconds": finished - started,
            "peakTrackedArrayBytes": int(
                rgba.nbytes + mask_u8.nbytes + structure_bytes),
            "algorithmPeakRssDeltaBytes": (
                max(0, algorithm_rss_end - algorithm_rss_start)
                if (
                    algorithm_rss_start is not None
                    and algorithm_rss_end is not None
                )
                else None
            ),
            "flattenedLineModel": "informative_drawings+line_relifer",
            "flattenedStructure": (
                "matchingSiblingPsd"
                if structured_sibling is not None
                else "sourcePsd" if structured_model else None
            ),
        }
        _cache_result(cache_key, result, profile)
        return result

    rgb = rgba[..., :3]
    alpha = rgba[..., 3] > 0
    lum = ((rgb[..., 0].astype(np.uint16) * 77 + rgb[..., 1].astype(np.uint16) * 150 + rgb[..., 2].astype(np.uint16) * 29) >> 8).astype(np.uint8)

    # A drawn line is darker than its immediate rendered neighbourhood,
    # regardless of the colour underneath it. Removing the local background
    # therefore removes colour while retaining the original stroke geometry.
    contrast = np.full(alpha.shape, 255, dtype=np.int16)
    for channel in range(3):
        local_background = np.array(
            Image.fromarray(rgb[..., channel], "L").filter(
                ImageFilter.MaxFilter(5)))
        channel_contrast = (
            local_background.astype(np.int16)
            - rgb[..., channel].astype(np.int16)
        )
        np.minimum(contrast, channel_contrast, out=contrast)
    dark_lines = (contrast >= 14) & alpha
    dark_done = time.perf_counter()
    boundary_peak = sum(array.nbytes for array in (
        rgba, alpha, lum, local_background, channel_contrast, contrast,
        dark_lines,
    ))
    mask = _remove_short_components(dark_lines, opts["minLength"])
    mask_u8 = np.array(
        Image.fromarray(mask.astype(np.uint8) * 255, "L").filter(
            ImageFilter.GaussianBlur(0.85)
        )
    )
    mask_u8[mask_u8 >= 240] = 255
    base_done = time.perf_counter()
    missing_edges = _missing_colour_edges(rgba, mask_u8, opts["minLength"])
    replacement_zone = np.array(
        Image.fromarray(
            (missing_edges >= 128).astype(np.uint8) * 255,
            "L",
        ).filter(ImageFilter.MaxFilter(7))
    ) > 0
    mask_u8[replacement_zone & (mask_u8 < 128)] = 0
    np.maximum(mask_u8, missing_edges, out=mask_u8)
    authored_mask = _AUTHORED_ALPHA_LUT[mask_u8]
    eroded_mask = np.array(
        Image.fromarray(
            authored_mask, "L").filter(ImageFilter.MinFilter(3)),
        dtype=np.uint8,
    )
    # The rendered-document mask has a harder, wider raster core than the
    # authored Line layers. A weighted one-pixel erosion lowers only the
    # outer core pixels while retaining antialiased support and interior.
    weighted_mask = (
        (
            authored_mask.astype(np.uint16) * 3
            + eroded_mask.astype(np.uint16) * 2
            + 2
        ) // 5
    ).astype(np.uint8)
    weighted_mask = _remove_large_solid_interiors(
        weighted_mask,
        thin_outline=True,
    )
    boundary_peak += (
        mask.nbytes + mask_u8.nbytes + authored_mask.nbytes
        + eroded_mask.nbytes + weighted_mask.nbytes + missing_edges.nbytes
        + replacement_zone.nbytes
    )
    mask_u8 = _fill_drawing_panel_strokes(
        weighted_mask,
        rgba,
        drawing_panel_boxes,
    )
    boundary_done = time.perf_counter()
    mask_u8[~alpha] = 0
    mask_u8 = np.ascontiguousarray(mask_u8)
    finished = time.perf_counter()
    algorithm_rss_end = _max_rss_bytes()
    result = (mask_u8, hashlib.sha256(mask_u8.tobytes()).hexdigest())
    profile = {
        "compositeSeconds": composite_done - started,
        "darkExtractionSeconds": dark_done - composite_done,
        "boundaryExtractionSeconds": boundary_done - base_done,
        "suppressionUnionSeconds": (
            base_done - dark_done + finished - boundary_done
        ),
        "totalSeconds": finished - started,
        "peakTrackedArrayBytes": int(boundary_peak),
        "algorithmPeakRssDeltaBytes": (
            max(0, algorithm_rss_end - algorithm_rss_start)
            if algorithm_rss_start is not None and algorithm_rss_end is not None
            else None
        ),
        "specialLineStyle": (
            "flattenedColourLayer"
            if flattened_colour_plate is not None
            else "filledDrawingPanels" if drawing_panel_boxes else None
        ),
    }
    _cache_result(cache_key, result, profile)
    return result


def image_line_profile(session, image_line):
    """Return the latest measured cold-extraction profile for this input."""
    opts = normalize_options(image_line)
    if session.get("path") is None or session.get("mtime") is None:
        return None
    key = (
        str(session["path"]),
        float(session["mtime"]),
        json.dumps(opts, sort_keys=True, separators=(",", ":")),
    )
    profile = _PROFILE_CACHE.get(key)
    return dict(profile) if profile is not None else None


def mask_to_rgba(mask, line_color):
    rgb = parse_line_color(line_color)
    out = np.zeros((mask.shape[0], mask.shape[1], 4), dtype=np.uint8)
    out[..., 0], out[..., 1], out[..., 2] = rgb
    # RGB stays at the selected line value; the source mask carries coverage.
    # Promoting 64..254 alpha to opaque destroys authored antialiasing and
    # turns diagonals into visible pixel stairs at production resolution.
    out[..., 3] = mask
    return out


def render_image_line_preview(session, out_dir, max_size, image_line, line_color=None):
    mask, mask_hash = extract_image_line(session, image_line)
    rgba = mask_to_rgba(mask, line_color)
    img = Image.fromarray(rgba, "RGBA")
    img.thumbnail((int(max_size), int(max_size)))
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(str(out_dir), "image_line.png")
    img.save(path)
    return path, mask_hash


def export_image_line(session, output_path, output_format, image_line, line_color=None, overwrite=False):
    output_format = (output_format or "png").lower()
    if output_format not in ("png", "psd"):
        raise ValueError("color_to_line outputFormat must be 'png' or 'psd'")
    output_path = str(output_path)
    ensure_writable_path(output_path)
    if os.path.exists(long_path(output_path)) and not overwrite:
        raise FileExistsError(f"output already exists: {output_path}")
    mask, mask_hash = extract_image_line(session, image_line)
    rgba = mask_to_rgba(mask, line_color)
    export_mask = rgba[..., 3]
    expected_pixels = rgba
    if output_format == "png":
        # Delivery PNGs match the studio line sample: antialiased line art on
        # an opaque white paper background. PSD keeps line and paper as two
        # editable layers below.
        image = Image.new("RGBA", (rgba.shape[1], rgba.shape[0]), "white")
        image.alpha_composite(Image.fromarray(rgba, "RGBA"))
        expected_pixels = np.array(image, dtype=np.uint8)
        image.save(long_path(output_path))
    else:
        _write_line_psd(session, rgba, output_path)
    verification = verify_image_line_export(
        output_path, output_format, export_mask, expected_pixels,
        expected_name="color_to_line")
    return {
        "outputPath": output_path,
        "layerCount": verification["actualLayers"],
        "maskHash": mask_hash,
        "verification": verification,
        "profile": image_line_profile(session, image_line),
    }


def verify_image_line_export(output_path, output_format, expected_mask,
                             expected_pixels,
                             expected_name="color_to_line"):
    """Read back an image-line export and verify its observable contract."""
    output_format = str(output_format).lower()
    expected_height, expected_width = expected_mask.shape
    actual_layers = 1
    actual_name = expected_name
    if output_format == "png":
        image = Image.open(long_path(str(output_path))).convert("RGBA")
        actual_pixels = np.array(image, dtype=np.uint8)
        actual_alpha = actual_pixels[..., 3]
        actual_width, actual_height = image.size
    elif output_format == "psd":
        from psd_tools import PSDImage

        document = PSDImage.open(long_path(str(output_path)))
        layers = list(document)
        actual_layers = len(layers)
        actual_width, actual_height = document.width, document.height
        if actual_layers == 2:
            actual_name = layers[0].name
            actual_alpha = np.array(
                layers[0].topil().convert("RGBA"), dtype=np.uint8)[..., 3]
            background_name = layers[1].name
            background_pixels = np.array(
                layers[1].topil().convert("RGBA"), dtype=np.uint8)
        else:
            actual_name = ""
            background_name = ""
            actual_alpha = np.zeros((0, 0), dtype=np.uint8)
            background_pixels = np.zeros((0, 0, 4), dtype=np.uint8)
    else:
        raise ValueError(f"unsupported imageLine output format: {output_format}")

    canvas_ok = (
        actual_width == expected_width and actual_height == expected_height
        and actual_alpha.shape == expected_mask.shape
    )
    pixel_ok = bool(
        canvas_ok and (
            np.array_equal(actual_pixels, expected_pixels)
            if output_format == "png"
            else np.array_equal(actual_alpha, expected_mask)
        )
    )
    expected_layers = 2 if output_format == "psd" else 1
    layer_count_ok = actual_layers == expected_layers
    name_ok = actual_name == expected_name
    background_ok = bool(
        output_format != "psd" or (
            background_name == "Background"
            and background_pixels.shape
            == (expected_height, expected_width, 4)
            and np.all(background_pixels == 255)
        )
    )
    return {
        "ok": bool(
            canvas_ok and layer_count_ok and name_ok
            and background_ok and pixel_ok
        ),
        "canvasOk": bool(canvas_ok),
        "layerCountOk": bool(layer_count_ok),
        "expectedLayers": expected_layers,
        "actualLayers": int(actual_layers),
        "layers": [
            {
                "name": actual_name,
                "nameOk": bool(name_ok),
                "pixelChecked": True,
                "pixelOk": pixel_ok,
            },
            *([{
                "name": background_name,
                "nameOk": background_name == "Background",
                "pixelChecked": True,
                "pixelOk": background_ok,
            }] if output_format == "psd" else []),
        ],
    }


def _write_line_psd(session, rgba, output_path):
    apply_pytoshop_patches()
    from pytoshop import enums
    from pytoshop.user import nested_layers

    channels = {c: np.ascontiguousarray(rgba[..., c]) for c in range(3)}
    channels[-1] = np.ascontiguousarray(rgba[..., 3])
    psd = session["psd"]
    white = np.full((psd.height, psd.width), 255, dtype=np.uint8)
    out = nested_layers.nested_layers_to_psd(
        [nested_layers.Image(
            name="Background",
            channels={0: white, 1: white, 2: white, -1: white},
            top=0, left=0, opacity=255, visible=True,
            blend_mode=enums.BlendMode.normal,
        ), nested_layers.Image(
            name="color_to_line", channels=channels, top=0, left=0,
            opacity=255, visible=True, blend_mode=enums.BlendMode.normal,
        )],
        color_mode=enums.ColorMode.rgb,
        version=_output_version(output_path, psd.width, psd.height),
        size=(psd.width, psd.height),
    )
    with open(long_path(output_path), "wb") as f:
        out.write(f)
