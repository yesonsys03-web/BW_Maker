from psd_tools import PSDImage


def _walk(layers, out, depth=0):
    for l in layers:
        out.append((depth, l.name, "group" if l.is_group() else l.kind, l.visible))
        if l.is_group():
            _walk(l, out, depth + 1)


def test_fixture_structure(fixture_psd):
    psd = PSDImage.open(fixture_psd)
    assert (psd.width, psd.height) == (64, 48)
    got = []
    _walk(psd, got)
    assert got == [
        (0, "*ART", "group", True),
        (1, "BG", "group", True),
        (2, "fill", "pixel", True),
        (2, "hidden line", "pixel", False),
        (2, "line", "pixel", True),
        (1, "lines", "pixel", True),
        (0, "-REF", "group", True),
        (1, "line", "pixel", True),
    ]
