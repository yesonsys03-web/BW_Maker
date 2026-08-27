"""Full-document rendered-image line extraction for the color_to_line preset."""
import hashlib
import json
import os
import sys
import time
import warnings
from collections import OrderedDict, deque

import numpy as np
from PIL import Image, ImageFilter

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


def _remove_short_components(mask, min_length):
    if min_length <= 1:
        return mask
    h, w = mask.shape
    labels = np.zeros((h, w), dtype=np.int32)
    keep_labels = [False]
    next_label = 0
    for y0, x0 in zip(*np.nonzero(mask)):
        if labels[y0, x0]:
            continue
        next_label += 1
        q = deque([(int(y0), int(x0))])
        labels[y0, x0] = next_label
        area = 0
        min_y = max_y = int(y0)
        min_x = max_x = int(x0)
        while q:
            y, x = q.pop()
            area += 1
            min_y = min(min_y, y); max_y = max(max_y, y)
            min_x = min(min_x, x); max_x = max(max_x, x)
            for ny in range(max(0, y - 1), min(h, y + 2)):
                for nx in range(max(0, x - 1), min(w, x + 2)):
                    if mask[ny, nx] and not labels[ny, nx]:
                        labels[ny, nx] = next_label
                        q.append((ny, nx))
        keep_labels.append(
            max(max_y - min_y + 1, max_x - min_x + 1, area) >= min_length)
    return np.asarray(keep_labels, dtype=bool)[labels]


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
    rgba = _document_rgba(session)
    composite_done = time.perf_counter()
    algorithm_rss_start = _max_rss_bytes()
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
    boundary_done = time.perf_counter()
    mask = _remove_short_components(dark_lines, opts["minLength"])
    mask_u8 = np.array(
        Image.fromarray(mask.astype(np.uint8) * 255, "L").filter(
            ImageFilter.GaussianBlur(0.75)
        )
    )
    mask_u8[mask_u8 >= 240] = 255
    mask_u8[~alpha] = 0
    mask_u8 = np.ascontiguousarray(mask_u8)
    finished = time.perf_counter()
    algorithm_rss_end = _max_rss_bytes()
    result = (mask_u8, hashlib.sha256(mask_u8.tobytes()).hexdigest())
    profile = {
        "compositeSeconds": composite_done - started,
        "darkExtractionSeconds": dark_done - composite_done,
        "boundaryExtractionSeconds": boundary_done - dark_done,
        "suppressionUnionSeconds": finished - boundary_done,
        "totalSeconds": finished - started,
        "peakTrackedArrayBytes": int(boundary_peak),
        "algorithmPeakRssDeltaBytes": (
            max(0, algorithm_rss_end - algorithm_rss_start)
            if algorithm_rss_start is not None and algorithm_rss_end is not None
            else None
        ),
    }
    if cache_key is not None:
        _MASK_CACHE[cache_key] = result
        _PROFILE_CACHE[cache_key] = profile
        _MASK_CACHE.move_to_end(cache_key)
        while len(_MASK_CACHE) > _MASK_CACHE_LIMIT:
            evicted, _ = _MASK_CACHE.popitem(last=False)
            _PROFILE_CACHE.pop(evicted, None)
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
    if output_format == "png":
        Image.fromarray(rgba, "RGBA").save(long_path(output_path))
    else:
        _write_line_psd(session, rgba, output_path)
    verification = verify_image_line_export(
        output_path, output_format, mask, expected_name="color_to_line")
    return {
        "outputPath": output_path,
        "layerCount": verification["actualLayers"],
        "maskHash": mask_hash,
        "verification": verification,
        "profile": image_line_profile(session, image_line),
    }


def verify_image_line_export(output_path, output_format, expected_mask,
                             expected_name="color_to_line"):
    """Read back an image-line export and verify its observable contract."""
    output_format = str(output_format).lower()
    expected_height, expected_width = expected_mask.shape
    actual_layers = 1
    actual_name = expected_name
    if output_format == "png":
        image = Image.open(long_path(str(output_path))).convert("RGBA")
        actual_alpha = np.array(image, dtype=np.uint8)[..., 3]
        actual_width, actual_height = image.size
    elif output_format == "psd":
        from psd_tools import PSDImage

        document = PSDImage.open(long_path(str(output_path)))
        layers = list(document)
        actual_layers = len(layers)
        actual_width, actual_height = document.width, document.height
        if actual_layers == 1:
            actual_name = layers[0].name
            actual_alpha = np.array(
                layers[0].topil().convert("RGBA"), dtype=np.uint8)[..., 3]
        else:
            actual_name = ""
            actual_alpha = np.zeros((0, 0), dtype=np.uint8)
    else:
        raise ValueError(f"unsupported imageLine output format: {output_format}")

    canvas_ok = (
        actual_width == expected_width and actual_height == expected_height
        and actual_alpha.shape == expected_mask.shape
    )
    pixel_ok = bool(canvas_ok and np.array_equal(actual_alpha, expected_mask))
    layer_count_ok = actual_layers == 1
    name_ok = actual_name == expected_name
    return {
        "ok": bool(canvas_ok and layer_count_ok and name_ok and pixel_ok),
        "canvasOk": bool(canvas_ok),
        "layerCountOk": bool(layer_count_ok),
        "expectedLayers": 1,
        "actualLayers": int(actual_layers),
        "layers": [{
            "name": actual_name,
            "nameOk": bool(name_ok),
            "pixelChecked": True,
            "pixelOk": pixel_ok,
        }],
    }


def _write_line_psd(session, rgba, output_path):
    apply_pytoshop_patches()
    from pytoshop import enums
    from pytoshop.user import nested_layers

    channels = {c: np.ascontiguousarray(rgba[..., c]) for c in range(3)}
    channels[-1] = np.ascontiguousarray(rgba[..., 3])
    psd = session["psd"]
    out = nested_layers.nested_layers_to_psd(
        [nested_layers.Image(
            name="color_to_line", channels=channels, top=0, left=0,
            opacity=255, visible=True, blend_mode=enums.BlendMode.normal,
        )],
        color_mode=enums.ColorMode.rgb,
        version=_output_version(output_path, psd.width, psd.height),
        size=(psd.width, psd.height),
    )
    with open(long_path(output_path), "wb") as f:
        out.write(f)
