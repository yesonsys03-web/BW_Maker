"""동결된 psd_engine 사이드카를 실제로 돌려보는 스모크.

빌드 스크립트(scripts/build-engine.sh|.ps1)가 동결 직후 `tauri build` 전에
부른다. 여기서 막지 못하면 모듈이 빠졌거나 pytoshop 패치가 안 먹는 번들이 그대로
설치본에 실려 나가고, 그 사실은 사용자 PC의 첫 요청에서야 드러난다.

engine/tests가 이미 덮는 것을 다시 하지 않는다. 프리즈에서만 깨질 수 있는 것만 본다:

- 동결본이 JSON-RPC로 말을 하는가. 임포트가 빠졌으면 첫 요청에서 끝난다.
- 한글 경로가 살아 있는가. 요청은 반드시 ``ensure_ascii=False``로, 즉 Rust
  쪽(serde_json)이 보내는 것과 같은 UTF-8 원문으로 보낸다. escape된 요청은 순수
  ASCII라 어떤 로케일에서도 통과하므로, 그렇게 짠 테스트는 아무것도 검증하지
  못한다 — 6d9476b의 회귀 테스트가 처음 무력했던 이유가 그것이다.
- 런타임 pytoshop 패치(psd_engine/patches.py)가 동결본에서도 먹는가. 내보내기까지
  해봐야 안다: RLE 인코더는 psd-tools의 C 확장이고, 번들에서 빠지면 저장이 죽는다.
- 예외가 traceback과 함께 돌아오는가(에러 흡수 금지 정책).
- stdin이 닫히면 정상 종료하면서 임시 렌더 디렉터리를 치우는가.

사용법: <build venv python> engine/packaging/smoke.py <동결된 실행 파일>

픽스처 PSD를 만들어야 하므로 엔진 의존성이 깔린 인터프리터로 돌린다. 검사 대상은
어디까지나 인자로 받은 동결 실행 파일이다.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

import numpy as np
from psd_engine.patches import apply_pytoshop_patches
from pytoshop import enums
from pytoshop.user import nested_layers

#: 전체 스모크에 주는 시간. 넘기면 엔진을 죽이고 실패한다 — CI가 45분을 다
#: 태우고 타임아웃되는 것보다 여기서 끊는 편이 원인이 분명하다.
DEADLINE_SECONDS = 300


class FrozenEngine:
    """동결 실행 파일과 줄 단위 JSON-RPC로 대화한다.

    파이프를 텍스트 모드로 열지 않고 UTF-8로 직접 인코딩한다. 텍스트 모드는
    부모의 로케일 인코딩을 쓰므로, 한글 윈도우(cp949)에서는 요청을 쓰는 쪽이
    먼저 터져 정작 확인하려던 엔진 쪽 디코딩에 도달하지도 못한다.
    """

    def __init__(self, exe, tmp_dir):
        env = {**os.environ}
        # 엔진이 만드는 임시 렌더 디렉터리를 이 디렉터리에 가둔다. 종료 후
        # 비었는지 보면 atexit 정리가 동결본에서도 도는지 알 수 있다.
        env["TMPDIR"] = str(tmp_dir)   # POSIX
        env["TEMP"] = str(tmp_dir)     # Windows
        env["TMP"] = str(tmp_dir)
        self.proc = subprocess.Popen(
            [str(exe)], env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        self._id = 0

    def call(self, method, **params):
        self._id += 1
        request = json.dumps(
            {"id": self._id, "method": method, "params": params}, ensure_ascii=False
        )
        self.proc.stdin.write((request + "\n").encode("utf-8"))
        self.proc.stdin.flush()
        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise AssertionError(
                    f"{method}: 엔진이 응답 없이 죽었다 "
                    f"(exit={self.proc.poll()})\n{self._stderr()}"
                )
            message = json.loads(line.decode("utf-8"))
            if message.get("event"):
                continue  # progress 이벤트는 흘려보낸다
            return message

    def close(self):
        """stdin을 닫아 `for line in stdin` 루프를 EOF로 끝내고 종료를 기다린다."""
        self.proc.stdin.close()
        return self.proc.wait(timeout=30)

    def _stderr(self):
        return self.proc.stderr.read().decode("utf-8", "replace")


def write_fixture(path):
    """한글 이름의 레이어가 든 작은 PSD. 경로도 이름도 전부 한글이다."""
    def image(name, value, width, height):
        pixels = np.full((height, width), value, np.uint8)
        alpha = np.full((height, width), 255, np.uint8)
        return nested_layers.Image(
            name=name, channels={0: pixels, 1: pixels, 2: pixels, -1: alpha},
            top=0, left=0, opacity=255, visible=True,
            blend_mode=enums.BlendMode.normal,
        )

    apply_pytoshop_patches()
    art = nested_layers.Group(name="*ART", layers=[
        image("메인 라인", 30, 96, 64),
        image("배경 라인", 90, 128, 96),
    ])
    psd = nested_layers.nested_layers_to_psd(
        [art], color_mode=enums.ColorMode.rgb, size=(128, 160)
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "wb") as f:
        psd.write(f)
    return path


def pixel_ids(tree):
    found = []

    def walk(nodes):
        for node in nodes:
            if node["kind"] == "pixel":
                found.append(node["id"])
            walk(node.get("children", []))

    walk(tree)
    return found


def check(label, condition, detail=""):
    if not condition:
        raise AssertionError(f"{label} 실패\n{detail}")
    print(f"  ok  {label}")


def main():
    if len(sys.argv) != 2:
        raise SystemExit(f"usage: {sys.argv[0]} <frozen engine executable>")
    exe = Path(sys.argv[1]).resolve()
    if not exe.is_file():
        raise SystemExit(f"동결 실행 파일이 없다: {exe}")

    # 한글 경로가 든 출력을 그대로 찍을 수 있게 고정한다. 윈도우 러너의 콘솔
    # 코드페이지(cp1252)로는 아래 경로들을 찍는 것만으로도 죽는다.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    work = Path(tempfile.mkdtemp(prefix="psd_engine_smoke_"))
    engine_tmp = work / "engine-tmp"
    engine_tmp.mkdir()
    fixture = write_fixture(work / "한글 폴더" / "배경 라인.psd")
    print(f"smoke: {exe}")
    print(f"  fixture: {fixture}")

    engine = FrozenEngine(exe, engine_tmp)
    watchdog = threading.Timer(DEADLINE_SECONDS, engine.proc.kill)
    watchdog.start()
    try:
        response = engine.call("open_psd", path=str(fixture))
        check("한글 경로 PSD 열기", "result" in response, response.get("error"))
        opened = response["result"]
        check(
            "문서 정보",
            (opened["width"], opened["height"]) == (128, 160),
            f"width/height={opened['width']}x{opened['height']}",
        )
        session_id = opened["sessionId"]
        layer_ids = pixel_ids(opened["tree"])
        check("픽셀 레이어 두 장", len(layer_ids) == 2, f"ids={layer_ids}")

        # 썸네일: numpy/PIL 경로가 동결본에서 도는지.
        response = engine.call(
            "render_thumbnails", sessionId=session_id, layerIds=layer_ids[:1]
        )
        check("썸네일 렌더", "result" in response, response.get("error"))
        thumbs = response["result"]["thumbs"]
        check(
            "썸네일 PNG 생성",
            thumbs and all(Path(p).is_file() for p in thumbs.values()),
            f"thumbs={thumbs}",
        )

        # 내보내기: pytoshop 런타임 패치(RLE 인코더 shim, 유니코드 레이어명,
        # 빈 마스크 섹션)가 동결본에서도 먹는지는 실제로 써봐야 안다.
        out_path = work / "한글 폴더" / "내보내기 결과_LINE.psd"
        response = engine.call(
            "export_psd", sessionId=session_id, includedIds=layer_ids,
            operations=[], naming="pathPrefix", outputPath=str(out_path),
        )
        check("한글 경로로 내보내기", "result" in response, response.get("error"))
        exported = response["result"]
        check("산출 파일 존재", out_path.is_file(), str(out_path))
        check(
            "내보내기 검증 통과(pytoshop 패치 동작)",
            exported["verification"]["ok"] is True,
            json.dumps(exported["verification"], ensure_ascii=False)[:500],
        )

        # 윈도우 MAX_PATH(260자)를 넘는 경로. `\\?\` 접두사가 없으면 여기서 죽는다.
        # 이 맥에서는 확인할 수 없고 Windows 러너에서만 진짜로 검증된다.
        deep = work
        while len(str(deep)) < 210:
            deep = deep / "긴폴더이름"
        deep.mkdir(parents=True, exist_ok=True)
        long_out = deep / ("내보내기_" + "가" * 40 + "_LINE.psd")
        response = engine.call("export_psd", sessionId=session_id, includedIds=layer_ids,
                               operations=[], naming="pathPrefix",
                               outputPath=str(long_out), overwrite=True)
        check(f"긴 경로로 내보내기 ({len(str(long_out))}자, 윈도우에서만 유의미)",
              "result" in response, response.get("error"))
        check("긴 경로 산출 파일 존재", Path(long_out).is_file())

        # 예외는 흡수하지 않고 traceback과 함께 돌아와야 한다.
        response = engine.call("open_psd", path=str(work / "없는 한글 파일.psd"))
        check("없는 파일 → 에러 응답", "error" in response, json.dumps(response)[:300])
        check(
            "에러에 traceback 동반",
            "FileNotFoundError" in response["error"]["traceback"],
            response["error"]["traceback"][:500],
        )

        response = engine.call("존재하지_않는_메서드")
        check("모르는 메서드 → 에러 응답", "error" in response, json.dumps(response)[:300])

        # 전체 캐시 워커 모드. v0.2.7에서 동결 진입점(engine_main.py)이
        # --warm-worker 분기를 몰라 워커가 **일반 RPC 엔진으로** 떴고 — ready 한
        # 줄 없이 stdin만 기다렸다 — 빌드 앱의 전체 캐시가 0/6869에서 통째로
        # 멈췄다. dev는 `-m psd_engine`이라 멀쩡했으므로, 이 검사는 동결본을
        # 실제로 워커로 띄워야만 잡는다(psd_engine/entry.py 참고). 첫 줄의
        # ready 이벤트가 판정의 핵심이다: RPC 엔진은 기동 시 아무것도 내지 않는다.
        cache_dir = work / "타일캐시"
        worker_tmp = work / "worker-tmp"
        worker_tmp.mkdir()
        worker = subprocess.Popen(
            [str(exe), "--warm-worker", "--max-size", "256"],
            env={**os.environ, "PSD_ENGINE_TILE_CACHE_DIR": str(cache_dir),
                 "TMPDIR": str(worker_tmp), "TEMP": str(worker_tmp),
                 "TMP": str(worker_tmp)},
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        worker_watchdog = threading.Timer(60, worker.kill)
        worker_watchdog.start()
        try:
            first = worker.stdout.readline().decode("utf-8", "replace").strip()
            try:
                ready_ok = bool(first) and json.loads(first).get("event") == "ready"
            except ValueError:
                ready_ok = False
            check(
                "워커 모드 기동(ready 이벤트)", ready_ok,
                f"첫 줄={first!r} — 비어 있으면 동결 진입점이 --warm-worker를 "
                f"모르고 RPC 엔진으로 뜬 것이다(stderr: "
                f"{worker.stderr.peek()[:300] if worker.poll() is not None else '살아 있음'})",
            )
            request = json.dumps({"path": str(fixture)}, ensure_ascii=False)
            worker.stdin.write((request + "\n").encode("utf-8"))
            worker.stdin.flush()
            file_event = None
            while file_event is None:
                line = worker.stdout.readline()
                if not line:
                    raise AssertionError(
                        f"워커가 파일 이벤트 없이 죽었다 (exit={worker.poll()})")
                message = json.loads(line.decode("utf-8"))
                if message.get("event") == "file":
                    file_event = message
            check("워커가 파일 하나를 끝까지 데움", file_event.get("ok") is True,
                  json.dumps(file_event, ensure_ascii=False)[:300])
            check("워커가 타일을 디스크에 쌓음",
                  cache_dir.is_dir() and any(cache_dir.rglob("*.png")),
                  str(cache_dir))
            worker.stdin.close()
            check("워커 stdin 닫힘 → 정상 종료", worker.wait(timeout=30) == 0)
        finally:
            worker_watchdog.cancel()
            if worker.poll() is None:
                worker.kill()

        # 뷰 워커 모드(--view-worker). 위와 **같은 종류의 사고**를 막는 검사다 —
        # 동결 진입점이 이 플래그를 모르면 자식이 일반 RPC 엔진으로 뜨고, 그러면
        # 판을 나눠 굽는 대신 아무것도 안 굽는다. 화면은 멀쩡하고(부모가 미스로
        # 보고 순차로 굽는다) 속도만 조용히 원래대로 돌아가므로, 실제로 띄워
        # 확인하지 않으면 영영 안 드러난다.
        #
        # 판정: 뷰 워커는 stdout에 아무것도 안 낸다. RPC 엔진이었다면 이 JSON을
        # method 없는 요청으로 읽고 **에러 한 줄로 답한다** — 그 차이를 본다.
        view_job = json.dumps({"path": str(fixture), "opts": {},
                               "settingsKey": [], "views": []},
                              ensure_ascii=False)
        view_worker = subprocess.Popen(
            [str(exe), "--view-worker"],
            env={**os.environ, "PSD_ENGINE_TILE_CACHE_DIR": str(cache_dir),
                 "TMPDIR": str(worker_tmp), "TEMP": str(worker_tmp),
                 "TMP": str(worker_tmp)},
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        try:
            vw_out, vw_err = view_worker.communicate(
                view_job.encode("utf-8"), timeout=60)
        except subprocess.TimeoutExpired:
            view_worker.kill()
            vw_out, vw_err = b"", b"(시간 초과)"
        check(
            "뷰 워커 모드 기동(응답 없이 종료)",
            view_worker.returncode == 0 and not vw_out.strip(),
            f"exit={view_worker.returncode} stdout={vw_out[:200]!r} — stdout에 무언가 "
            f"있으면 동결 진입점이 --view-worker를 모르고 RPC 엔진으로 뜬 것이다 "
            f"(stderr: {vw_err[:300]!r})",
        )

        exit_code = engine.close()
        check("stdin 닫힘 → 정상 종료", exit_code == 0, f"exit={exit_code}")
        leftovers = [p.name for p in engine_tmp.iterdir()]
        check("임시 렌더 디렉터리 정리", not leftovers, f"남은 것: {leftovers}")
    finally:
        watchdog.cancel()
        if engine.proc.poll() is None:
            engine.proc.kill()
        shutil.rmtree(work, ignore_errors=True)

    print("smoke: 통과")


if __name__ == "__main__":
    main()
