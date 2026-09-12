"""동결 사이드카의 진입점.

PyInstaller는 패키지가 아니라 스크립트 하나를 얼린다. 개발 모드가 쓰는
`python -m psd_engine`(= psd_engine/__main__.py)와 같은 일을 하는 스크립트가
따로 필요해 여기 둔다. 엔진과 프로토콜은 그대로고 실행 방식만 다르다.

**분기(--warm-worker 등)를 여기 다시 적지 않는다.** v0.2.7에서 이 파일이
`rpc.main()` 직행이라 동결본이 워커 플래그를 무시했고, 빌드 앱의 전체 캐시가
통째로 멈췄다(psd_engine/entry.py 참고). 실행 분기는 entry.main 한 곳뿐이다.
"""
from psd_engine.entry import main

main()
