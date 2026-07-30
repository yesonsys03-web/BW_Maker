"""pytoshop 호환 패치 2종.

1. pytoshop 휠에 cython packbits 모듈이 없어 RLE 저장이 NameError로 죽는다
   → psd-tools의 C 확장 RLE 인코더로 대체.
2. pytoshop이 유니코드 문자열 길이에 NUL 종료 문자를 포함해 레이어명 끝에
   \x00이 붙는다 → 길이에서 제외(바이트 배치는 동일하게 유지).
"""
import struct

import numpy as np

_applied = False


def apply_pytoshop_patches() -> None:
    global _applied
    if _applied:
        return

    import pytoshop.codecs as codecs
    import pytoshop.util as putil
    from psd_tools.compression import rle_impl

    class _PackbitsShim:
        @staticmethod
        def encode(row):
            return rle_impl.encode(np.ascontiguousarray(row).tobytes())

    codecs.packbits = _PackbitsShim

    def _encode_unicode_string(s):
        # 데이터 + 2바이트 패딩은 유지(블록 길이 계산 일관성), 문자 수에서 NUL 제외
        return struct.pack(">L", len(s)) + s.encode("utf_16_be") + b"\0\0"

    putil.encode_unicode_string = _encode_unicode_string
    _applied = True
