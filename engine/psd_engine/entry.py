"""프로세스 진입점 분기 — 개발(`python -m psd_engine`)과 동결 사이드카
(packaging/engine_main.py)가 **반드시 이 함수 하나를 함께** 타야 한다.

v0.2.7 사고가 이 파일이 있는 이유다. `--warm-worker` 분기가 __main__.py에만
있고 동결 진입점은 `rpc.main()`으로 직행이어서, 빌드 앱의 전체 캐시 워커가
플래그를 무시당한 채 **일반 RPC 엔진으로** 떴다 — 여섯 프로세스가 stdin만
기다리고, 진행바는 0/6869에서 영원히 멈췄다. dev는 `-m psd_engine`이라 멀쩡해서
릴리스 전 확인으로는 안 잡혔고, smoke도 당시엔 RPC만 물어봐서 통과했다.
실행 방식이 갈리는 곳은 여기 하나뿐이어야 하고, 동결본의 워커 모드는
packaging/smoke.py가 실제로 띄워서 확인한다.
"""
import sys


def main(argv=None):
    argv = sys.argv if argv is None else argv
    if "--view-worker" in argv:
        # 판 하나의 뷰를 나눠 굽는 자식(viewpool.py). 메인 엔진이 자기 자신을
        # 이 플래그로 띄운다 — 위와 같은 이유로 분기는 여기 하나뿐이어야 한다.
        from .viewpool import child_main

        sys.exit(child_main())
    if "--warm-worker" in argv:
        # 전체 캐시 워커 모드(warmworker.py). 메인 엔진과 같은 동결 바이너리·
        # 같은 venv를 그대로 쓰려고 별도 실행 파일 대신 플래그로 가른다.
        from .warmworker import main as warm_main

        max_size = 1500
        if "--max-size" in argv:
            max_size = int(argv[argv.index("--max-size") + 1])
        warm_main(max_size=max_size)
    else:
        from .rpc import main as rpc_main

        rpc_main()
