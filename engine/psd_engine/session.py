"""열린 PSD 세션 관리. LRU 최대 2개 (640MB급 파일 메모리 보호)."""
import itertools
import os
from collections import OrderedDict

from psd_tools import PSDImage
from psd_tools.constants import ColorMode

from .tree import build_tree


class SessionStore:
    def __init__(self, max_sessions=2):
        self._sessions = OrderedDict()
        self._ids = itertools.count(1)
        self._max = max_sessions
        self._pinned_path = None

    def pin(self, path):
        """
        아티스트가 지금 보고 있는 파일을 축출 대상에서 뺀다.

        상한(_max)은 그대로이므로 메모리는 늘지 않는다. 대신 배경 작업(미리보기
        미리 만들기 등)이 파일을 차례로 여는 동안 화면이 쓰는 세션이 밀려나지
        않는다 — 밀려나면 썸네일·미리보기가 매번 PSD를 다시 읽어야 하고, 재오픈이
        서로를 밀어내다 결국 'unknown or evicted session'으로 실패한다.

        세션 id가 아니라 **경로**로 고정하는 것이 요점이다. id로 걸면 축출 복구가
        새 세션을 만드는 순간부터 다시 걸릴 때까지 무방비인데, 그 짧은 사이에
        배경 작업이 두 번만 열면 방금 되살린 세션이 또 사라진다. 경로는 재오픈에도
        변하지 않으므로 그 틈이 아예 없다.
        """
        self._pinned_path = path

    def _pinned_sid(self):
        """고정된 경로의 세션. open이 경로+mtime으로 중복을 막으므로 보통 하나뿐이고,
        아티스트가 저장해 mtime이 갈린 판이 남아 있으면 가장 최근 것을 지킨다."""
        if self._pinned_path is None:
            return None
        for sid in reversed(self._sessions):
            if self._sessions[sid]["path"] == self._pinned_path:
                return sid
        return None

    def _evict(self):
        while len(self._sessions) > self._max:
            keep = self._pinned_sid()
            victim = next((s for s in self._sessions if s != keep), None)
            # 남은 것이 고정된 세션뿐이면 더 버릴 것이 없다. 상한을 한 칸 넘긴
            # 채로 두는 편이, 보고 있는 파일을 빼앗는 것보다 낫다.
            if victim is None:
                break
            del self._sessions[victim]

    def open(self, path):
        path = str(path)
        mtime = os.path.getmtime(path)
        # 같은 파일이 이미 열려 있고 내용도 그대로면 그 세션을 다시 쓴다.
        #
        # 두 번 열면 700MB급 파일이 메모리에 두 벌 올라가는 데다, 상한이 2칸이라
        # 그 복제본이 원본을 밀어낸다 — 축출은 경로가 아니라 세션 단위로 고르고
        # pin은 가장 최근 것 하나만 지키므로, **고정해둔 파일조차 자기 복제본에게
        # 밀렸다.** 축출 복구 재시도가 둘 이상 겹칠 때 서로의 세션을 걷어차며
        # 'unknown or evicted session'을 만들어내던 것이 이것이다.
        #
        # mtime을 함께 보는 이유: 아티스트가 포토샵에서 저장했다면 같은 경로라도
        # 다른 파일이므로 다시 읽어야 한다.
        for sid, s in self._sessions.items():
            if s["path"] == path and s["mtime"] == mtime:
                self._sessions.move_to_end(sid)
                return sid
        psd = PSDImage.open(path)
        if psd.color_mode != ColorMode.RGB:
            raise ValueError(f"unsupported color mode: {psd.color_mode!r} (RGB only)")
        # 심도는 묻지 않는다. 8비트만 받던 시절이 있었는데, 실제 납품 폴더에 16비트가
        # 섞여 있었고(37개 중 2개) 열어보니 막을 이유가 없었다 — psd-tools의 topil이
        # 이미 8비트 RGBA로 내려서 돌려주므로 render.py도 export.py도 달라질 것이
        # 없다. 산출물은 원래부터 8비트다(export.py는 심도를 다루지 않는다).
        #
        # 색 모드는 계속 막는다. CMYK는 채널 구성 자체가 달라 그리는 쪽이 실패한다.
        built = build_tree(psd)
        sid = next(self._ids)
        self._sessions[sid] = {
            "psd": psd,
            "path": path,
            "mtime": mtime,
            "tree": built["tree"],
            "nodes_by_id": built["nodes_by_id"],
            "layers_by_id": built["layers_by_id"],
        }
        self._evict()
        return sid

    def get(self, sid):
        if sid not in self._sessions:
            raise KeyError(f"unknown or evicted session: {sid}")
        self._sessions.move_to_end(sid)
        return self._sessions[sid]

    def close(self, sid):
        self._sessions.pop(sid, None)
