"""동결 사이드카의 진입점.

PyInstaller는 패키지가 아니라 스크립트 하나를 얼린다. 개발 모드가 쓰는
`python -m psd_engine`(= psd_engine/__main__.py)와 같은 일을 하는 스크립트가
따로 필요해 여기 둔다. 엔진과 프로토콜은 그대로고 실행 방식만 다르다.
"""
from psd_engine.rpc import main

main()
