import sys

if "--warm-worker" in sys.argv:
    # 전체 캐시 워커 모드(psd_engine/warmworker.py). 메인 엔진과 같은 동결
    # 바이너리·같은 venv를 그대로 쓰려고 별도 실행 파일 대신 플래그로 가른다.
    from .warmworker import main as warm_main

    max_size = 1500
    if "--max-size" in sys.argv:
        max_size = int(sys.argv[sys.argv.index("--max-size") + 1])
    warm_main(max_size=max_size)
else:
    from .rpc import main

    main()
