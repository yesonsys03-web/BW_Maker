"""미리보기 타일 디스크 캐시 — 세션이 죽어도 디코드 비용을 기억한다.

워밍업 타일은 세션(LRU 2칸)과 한 몸이라 세션이 밀려나면 같이 죽는다. 그래서
"지금 파일 + 다음 파일"까지만 즉시이고, 목록 점프·재시작 후에는 콜드 잎 하나에
0.7~50초(실측 2026-08-11)를 다시 낸다. 타일 자체는 작다 — 큰 것은 PSD이지
타일이 아니므로, 타일을 세션 밖(디스크)으로 빼면 그 비용이 "폴더당 평생 한 번"이
된다. 디스크 읽기는 수십 ms라 토글 체감으로는 핫 캐시와 같은 급이다.

**프로젝트 저장(.bwproj)에 묶지 않는다.** 크기(폴더당 수 GB vs 프로젝트 수 MB),
성격(파생 데이터 vs 사용자 작업), 타이밍(저장은 순간, 데우기는 수 시간), 그리고
프로젝트 없이 쓰는 날도 혜택이 있어야 해서다. 자동·무버튼 캐시로 간다(2026-08-12
합의). 저장 위치는 앱의 플랫폼 캐시 폴더 — Tauri app_cache_dir와 같은 규칙으로
엔진이 직접 계산하므로 Rust 쪽 변경이 없고, 테스트·오프라인 스크립트에서도 돈다.

키는 (경로 해시, mtime, layerId, scale). 경로를 **해시**로 쓰는 것은 납품 파일명
비노출을 겸한다 — 캐시 폴더를 열어봐도 어떤 파일의 타일인지 드러나지 않는다.
mtime이 키에 들어 있어 포토샵 재저장이면 자동으로 새 디렉터리가 되고, 옛 mtime
디렉터리는 새 디렉터리를 만들 때 청소한다.

캐시는 부가 장치다 — 디스크가 꽉 찼든 권한이 없든 렌더는 디코드로 돌아가면
그만이므로, 이 모듈의 실패는 미스로 강등하고 밖으로 던지지 않는다(rpc.py의
"흡수 금지"는 RPC 응답 얘기다; 여기서 던지면 캐시 없이는 멀쩡했을 렌더가 죽는다).
"""
import hashlib
import os
import sys
import tempfile
from pathlib import Path

from PIL import Image
from PIL.PngImagePlugin import PngInfo

#: 끄는 손잡이(PSD_ENGINE_TILE_CACHE=0). FAST_MERGE와 같은 이유다 — 캐시가
#: 이상한 그림을 낸다는 의심이 들 때 코드를 되돌리지 않고 앱만 되돌린다.
ENABLED = os.environ.get("PSD_ENGINE_TILE_CACHE", "1") != "0"

#: 캐시 전체 용량 상한(바이트). 넘으면 파일 디렉터리 단위로 오래 안 쓴 것부터
#: 버린다. 타일은 파일당 ~50~100MB(PNG로는 더 작다)이므로 기본 20GB면 폴더
#: 수백 장을 담고도 남는다.
CACHE_BYTES = int(os.environ.get("PSD_ENGINE_TILE_CACHE_BYTES",
                                 str(20 * 1024 ** 3)))


def cache_root():
    """
    캐시 뿌리 디렉터리. PSD_ENGINE_TILE_CACHE_DIR가 있으면 그것(테스트·계측용),
    없으면 Tauri app_cache_dir와 같은 플랫폼 규칙으로 identifier 밑에 둔다 —
    앱이 언젠가 "캐시 비우기"를 만들면 OS가 아는 그 자리에 있어야 한다.
    """
    env = os.environ.get("PSD_ENGINE_TILE_CACHE_DIR")
    if env:
        return Path(env)
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Caches"
    elif os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA",
                                   str(Path.home() / "AppData" / "Local")))
    else:
        base = Path(os.environ.get("XDG_CACHE_HOME",
                                   str(Path.home() / ".cache")))
    return base / "com.yeson.bwmaker" / "preview_tiles"


def _path_hash(path):
    return hashlib.sha1(os.path.abspath(path).encode("utf-8")).hexdigest()[:16]


def _file_dir(path, mtime):
    """
    한 (파일, 판) 조합의 디렉터리 이름. mtime은 세션이 저장해 둔 float 그대로를
    마이크로초로 잘라 쓴다 — 여기서 디스크를 다시 stat하면 세션과 캐시가 서로
    다른 판을 말하는 틈이 생긴다(session.py의 open이 mtime을 다시 재지 않는
    것과 같은 이유).
    """
    return cache_root() / f"{_path_hash(path)}-{int(round(mtime * 1e6))}"


def _tile_path(path, mtime, layer_id, scale):
    # scale은 RAM 캐시 키(round(scale, 6), render._preview_tile)와 같은 정밀도로
    # 문자열화한다 — 두 캐시가 같은 것을 "같은 타일"이라고 불러야 한다.
    return _file_dir(path, mtime) / f"t{layer_id}_s{round(scale, 6):.6f}.png"


def _session_key(session):
    """세션에서 (path, mtime). 없으면 None — 테스트 등 경로 없는 세션은 캐시 없이 돈다."""
    path, mtime = session.get("path"), session.get("mtime")
    if path is None or mtime is None:
        return None
    return path, mtime


def has(session, layer_id, scale):
    """디스크에 이 타일이 있는가. 워밍업이 비용 예측 대신 쓴다(stat 한 번)."""
    key = _session_key(session)
    if not ENABLED or key is None:
        return False
    return _tile_path(key[0], key[1], layer_id, scale).is_file()


def load(session, layer_id, scale):
    """
    디스크에서 (img, x0, y0)를 읽는다. 미스·손상·꺼짐이면 None — 호출자는
    디코드로 간다. 손상 파일은 지운다(다음에도 똑같이 실패할 것을 반복 안 하게).
    """
    key = _session_key(session)
    if not ENABLED or key is None:
        return None
    f = _tile_path(key[0], key[1], layer_id, scale)
    try:
        img = Image.open(f)
        img.load()
        x0, y0 = int(img.text["x0"]), int(img.text["y0"])
        entry = (img.convert("RGBA"), x0, y0)
    except FileNotFoundError:
        return None
    except Exception:
        # 손상 파일만 지우려는 except다 — utime 같은 부수 작업을 이 안에 넣으면
        # 그 실패가 멀쩡한 타일을 지운다. 그래서 아래 utime은 따로 감싼다.
        try:
            f.unlink()
        except OSError:
            pass
        return None
    # 디렉터리 mtime을 만져 "최근에 쓴 폴더"로 만든다 — 용량 상한 축출이
    # 이 시각으로 오래된 것을 고른다. 실패해도 타일은 이미 손에 있다.
    try:
        os.utime(f.parent)
    except OSError:
        pass
    return entry


def store(session, layer_id, scale, entry):
    """
    디코드 부산물을 디스크에 떨군다. entry는 render._preview_tile의 (img, x0, y0).

    임시 파일에 쓰고 os.replace로 원자적으로 놓는다 — 디코드 도중 앱이 SIGKILL로
    죽어도(엔진 종료가 그렇다, src-tauri/src/engine.rs) 반쪽짜리 PNG가 다음
    세션에서 "손상"으로 읽히는 일이 없다. x0/y0는 PNG tEXt에 싣는다 — 파일명에
    실으면 읽기가 glob이 되고, 사이드카로 두면 원자성이 깨진다.
    """
    key = _session_key(session)
    if not ENABLED or key is None or entry is None:
        return
    img, x0, y0 = entry
    d = _file_dir(key[0], key[1])
    try:
        fresh = not d.is_dir()
        d.mkdir(parents=True, exist_ok=True)
        info = PngInfo()
        info.add_text("x0", str(x0))
        info.add_text("y0", str(y0))
        fd, tmp = tempfile.mkstemp(dir=d, suffix=".tmp")
        try:
            with os.fdopen(fd, "wb") as fh:
                img.save(fh, format="PNG", pnginfo=info)
            os.replace(tmp, _tile_path(key[0], key[1], layer_id, scale))
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise
        if fresh:
            # 청소는 새 판이 처음 생길 때만 — 쓰기마다 전체 스캔을 돌 이유가
            # 없고, 용량이 자라는 것은 새 디렉터리가 생길 때뿐이다.
            _prune(keep=d)
    except OSError:
        pass


def _dir_size(d):
    total = 0
    for root, _dirs, files in os.walk(d):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
    return total


def _rmtree_quiet(d):
    import shutil
    shutil.rmtree(d, ignore_errors=True)


def _prune(keep):
    """
    새 디렉터리 keep이 생긴 직후의 청소 둘.

    1. 같은 파일의 옛 판 — keep과 경로 해시가 같고 mtime이 다른 디렉터리는
       전부 지운다. 포토샵 재저장 한 번마다 폴더가 한 벌씩 늘어나는 것을 막는다.
    2. 용량 상한 — 전체가 CACHE_BYTES를 넘으면 디렉터리 mtime이 오래된 것부터
       버린다(load가 읽을 때마다 utime으로 갱신하므로 이것이 LRU다). keep은
       지킨다 — 방금 만든 판을 자기 청소가 도로 지우면 캐시가 영원히 안 찬다.
    """
    root = cache_root()
    prefix = keep.name.split("-")[0] + "-"
    try:
        dirs = [e for e in os.scandir(root) if e.is_dir()]
    except OSError:
        return
    for e in dirs:
        if e.name.startswith(prefix) and e.name != keep.name:
            _rmtree_quiet(e.path)
    survivors = [e for e in dirs
                 if e.name == keep.name or not e.name.startswith(prefix)]
    sized = []
    total = 0
    for e in survivors:
        try:
            mtime = e.stat().st_mtime
        except OSError:
            continue
        size = _dir_size(e.path)
        total += size
        sized.append((mtime, e.path, size, e.name))
    sized.sort()
    for _mtime, p, size, name in sized:
        if total <= CACHE_BYTES:
            break
        if name == keep.name:
            continue
        _rmtree_quiet(p)
        total -= size
