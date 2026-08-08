"""부모(앱)가 사라지면 엔진도 사라져야 한다.

배치가 도는 동안 앱을 닫았더니 파이썬 엔진이 CPU 99%·RSS 8.9GB로 살아남아
산출물을 계속 썼다. Rust 쪽 정리는 stdin을 닫아 EOF를 유도하는데, 엔진이 긴
작업 안에 있으면 애초에 stdin을 읽지 않으므로 그 신호가 닿지 않는다. 그래서
메인 루프와 무관하게 도는 감시 스레드를 둔다.
"""
import os
import subprocess
import sys
import time

ROOT = os.path.join(os.path.dirname(__file__), "..")


def _alive(pid):
    """
    아직 돌고 있는가. `os.kill(pid, 0)`으로 보면 안 된다 — 끝났지만 아직 거두어지지
    않은 좀비에도 성공해서, 엔진이 제때 죽어도 살아있다고 읽힌다.
    """
    state = subprocess.run(["ps", "-o", "state=", "-p", str(pid)],
                           capture_output=True, text=True).stdout.strip()
    return bool(state) and not state.startswith("Z")


#: 앱과 엔진 사이에 끼는 중간 부모. dev의 `uv run`이 이 자리다.
#:
#: 파일로 빼는 것은 취향이 아니라 필요다 — 중첩된 `-c` 문자열로 쓰면 바깥
#: 따옴표를 거치며 개행 escape가 한 겹씩 풀려, 엔진이 뜬 것처럼 보이지만 실제로는
#: 다른 것이 떠서 테스트가 통과도 실패도 엉뚱하게 났다.
MIDDLE = """
import subprocess, sys, time
p = subprocess.Popen([sys.executable, "-m", "psd_engine"], stdin=0, cwd=sys.argv[1])
print(p.pid, flush=True)
time.sleep(300)
"""


def test_engine_exits_when_its_parent_disappears(tmp_path):
    """
    stdin을 **열어둔 채로** 부모를 없앤다.

    이게 요점이다. 파이프가 닫히면 엔진은 EOF로 곱게 끝나므로 감시 스레드가
    없어도 통과해버린다 — 실제로 문제가 된 경우는 EOF가 오지 않는 쪽이다.
    테스트가 쓰기 끝을 붙들고 있으면 중간 부모를 죽여도 EOF가 생기지 않으므로,
    엔진을 끝낼 수 있는 것은 감시 스레드뿐이다.

    손자로 띄우는 것도 실제와 같다: dev에서 `uv run`을 거치면 앱의 직계 자식은
    uv이고 엔진은 손자라, 앱이 자식을 죽여도 엔진에는 닿지 않았다.
    """
    middle_py = tmp_path / "middle.py"
    middle_py.write_text(MIDDLE)
    read_fd, write_fd = os.pipe()
    middle = subprocess.Popen(
        [sys.executable, str(middle_py), os.path.abspath(ROOT)],
        stdin=read_fd, stdout=subprocess.PIPE, text=True,
        env={**os.environ, "PSD_ENGINE_ORPHAN_POLL": "0.2"},
    )
    os.close(read_fd)
    engine_pid = int(middle.stdout.readline().strip())

    try:
        middle.kill()
        middle.wait()

        deadline = time.time() + 15
        while time.time() < deadline:
            if not _alive(engine_pid):
                return  # 엔진이 스스로 끝났다
            time.sleep(0.2)
        raise AssertionError("부모가 사라졌는데 엔진이 살아남았다")
    finally:
        os.close(write_fd)
        try:
            os.kill(engine_pid, 9)
        except OSError:
            pass
