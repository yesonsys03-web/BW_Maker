"""열린 PSD 세션 관리. LRU 최대 2개 (640MB급 파일 메모리 보호)."""
import itertools
from collections import OrderedDict

from psd_tools import PSDImage
from psd_tools.constants import ColorMode

from .tree import build_tree


class SessionStore:
    def __init__(self, max_sessions=2):
        self._sessions = OrderedDict()
        self._ids = itertools.count(1)
        self._max = max_sessions

    def open(self, path):
        psd = PSDImage.open(path)
        if psd.color_mode != ColorMode.RGB:
            raise ValueError(f"unsupported color mode: {psd.color_mode!r} (RGB only)")
        if psd.depth != 8:
            raise ValueError(f"unsupported bit depth: {psd.depth} (8-bit only)")
        built = build_tree(psd)
        sid = next(self._ids)
        self._sessions[sid] = {
            "psd": psd,
            "path": str(path),
            "tree": built["tree"],
            "nodes_by_id": built["nodes_by_id"],
            "layers_by_id": built["layers_by_id"],
        }
        while len(self._sessions) > self._max:
            self._sessions.popitem(last=False)
        return sid

    def get(self, sid):
        if sid not in self._sessions:
            raise KeyError(f"unknown or evicted session: {sid}")
        self._sessions.move_to_end(sid)
        return self._sessions[sid]

    def close(self, sid):
        self._sessions.pop(sid, None)
