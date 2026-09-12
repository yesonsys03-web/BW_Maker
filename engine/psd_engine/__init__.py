"""패키지를 들여오는 모든 진입점(rpc, 작업 프로세스, 스크립트)에 디코드 패치를 건다.

여기서 거는 이유: 픽셀 읽기는 미리보기·경계선·내보내기·썸네일·폴더 준비가 전부
지나가고, 그 진입점들이 공유하는 것은 이 패키지 임포트뿐이다. 한 곳이라도 빠지면
그 경로만 조용히 60배 느려진다. psd_tools는 어차피 session이 임포트 시점에 읽으므로
여기서 더 얹는 비용은 없다.
"""
from .patches import apply_psd_tools_decode_patch

apply_psd_tools_decode_patch()
