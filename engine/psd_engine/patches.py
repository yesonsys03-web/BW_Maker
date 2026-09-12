"""외부 라이브러리 런타임 패치.

pytoshop 호환 패치 3종:

1. pytoshop 휠에 cython packbits 모듈이 없어 RLE 저장이 NameError로 죽는다
   → psd-tools의 C 확장 RLE 인코더로 대체.
2. pytoshop이 유니코드 문자열 길이에 NUL 종료 문자를 포함해 레이어명 끝에
   \x00이 붙는다 → 길이에서 제외(바이트 배치는 동일하게 유지).
3. pytoshop이 마스크 데이터가 없는 레이어에도 비어있지 않은 마스크 블록을 기록하는
   버그 → 마스크 없는 레이어의 경우 마스크 섹션 길이를 0으로 기록.

psd-tools 디코드 패치 1종:

4. ZIP_WITH_PREDICTION 델타 복원이 픽셀마다 도는 순수 파이썬 루프
   (`compression._delta_decode`)다 — C 확장은 RLE에만 있다. 16비트 납품 판에서
   채널 하나(35 Mpx)가 7.5초였고, 판 하나 미리보기 150초의 87%가 이 루프였다.
   numpy cumsum으로 대체한다 → `apply_psd_tools_decode_patch`.
"""
import os
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

    # Patch 3: Empty mask section fix
    # pytoshop always writes a non-zero length mask section even for layers without
    # actual mask data. psd-tools then interprets this as has_mask()=True.
    # PSD format spec: length=0 means no mask. Replace LayerMask.write and total_length
    # to output zero-length for default (no-mask) layers.
    import pytoshop.layers as layers_mod
    import pytoshop.util as util_mod
    _original_layer_mask_write = layers_mod.LayerMask.write
    _original_layer_mask_total_length = layers_mod.LayerMask.total_length

    def _is_default_mask(self):
        """Check if this LayerMask has all default (no-mask) values."""
        return (
            self.top == 0 and self.left == 0 and self.bottom == 0 and self.right == 0
            and not self.default_color
            and not self.position_relative_to_layer
            and not self.layer_mask_disabled
            and not self.invert_layer_mask_when_blending
            and not self.user_mask_from_rendering_other_data
            and self.user_mask_density is None
            and self.user_mask_feather is None
            and self.vector_mask_density is None
            and self.vector_mask_feather is None
            and self.real_flags == 0
            and not self.real_user_mask_background
            and self.real_top == 0 and self.real_left == 0
            and self.real_bottom == 0 and self.real_right == 0
        )

    def _patched_layer_mask_write(self, fd, header):
        if _is_default_mask(self):
            # Write zero-length mask section (no mask)
            util_mod.write_value(fd, 'I', 0)
        else:
            # Call original write for layers with actual mask data
            _original_layer_mask_write(self, fd, header)

    def _patched_layer_mask_total_length(self, header):
        if _is_default_mask(self):
            # Just 4 bytes for the zero-length field
            return 4
        else:
            return _original_layer_mask_total_length(self, header)

    layers_mod.LayerMask.write = _patched_layer_mask_write
    layers_mod.LayerMask.total_length = _patched_layer_mask_total_length
    _applied = True


_decode_applied = False
_original_decode_prediction = None


def _fast_decode_prediction(data, w, h, depth):
    """psd-tools `decode_prediction`과 바이트 동일한 numpy 구현. 못 맡는 형태는 원본으로.

    원 구현의 점화식은 행마다 `arr[x+1] = (arr[x+1] + arr[x]) % 2**N` — 정확히
    mod 2^N 누적합이고, numpy의 uint8/uint16 cumsum이 같은 래핑 덧셈을 한다.

    **출력 바이트 순서가 함정이다.** `_delta_decode`는 마지막에 `byteswap()`으로
    16비트를 **빅엔디언**으로 되돌려 준다(8비트에는 무의미). 네이티브로 내보내면
    0x0000·0xFFFF 위주 채널(그라데이션·알파)에서는 우연히 같고 실그림 채널에서만
    갈린다 — 실제로 납품 판 대조에서 그렇게 한 번 속았다.

    depth 1/32와 길이가 안 맞는 데이터는 원 구현으로 보낸다. 속도가 아니라 오류
    경로까지 똑같이 두기 위해서다(짧은 데이터의 IndexError, 홀수 길이의 ValueError).
    """
    if depth == 8 and len(data) == w * h:
        arr = np.frombuffer(data, dtype=np.uint8)
        return np.cumsum(arr.reshape(h, w), axis=1, dtype=np.uint8).tobytes()
    if depth == 16 and len(data) == 2 * w * h:
        vals = np.frombuffer(data, dtype=">u2")
        out = np.cumsum(vals.reshape(h, w), axis=1, dtype=np.uint16)
        return out.astype(">u2").tobytes()
    orig = _original_decode_prediction
    if orig is None:
        # 아직 패치 전에 직접 불렸다 — 그때 모듈 속성이 곧 원본이다. 패치 후에는
        # _original_decode_prediction이 반드시 차 있으므로 재귀가 될 수 없다.
        from psd_tools.compression import decode_prediction as orig
    return orig(data, w, h, depth)


def apply_psd_tools_decode_patch() -> None:
    """ZIP_WITH_PREDICTION 델타 복원을 numpy로 바꾼다. 모든 픽셀 읽기가 지나간다.

    실측(2026-08-18, 판 20 = 11717x3000 16비트, 채널 전부 ZIP_WITH_PREDICTION):
    채널 하나 35 Mpx가 7.5초 → 0.12초(62배). 미리보기 색그림(_merge_rgba_fast)의
    96%가 이 디코드였다. 판의 채널 전부를 원 구현과 대조해 바이트 동일을 확인했다.

    `decompress`가 같은 모듈의 전역 이름으로 부르므로 모듈 속성 교체로 충분하다
    (site-packages 안 참조 지점은 그 한 곳뿐이다). RLE·ZIP(예측 없음) 채널은 이
    함수에 아예 안 들어온다.

    기준선 채집 등 A/B용 스위치: `PSD_ENGINE_FAST_DECODE=0`이면 안 건다.
    """
    global _decode_applied, _original_decode_prediction
    if _decode_applied:
        return
    if os.environ.get("PSD_ENGINE_FAST_DECODE", "1") == "0":
        return
    import psd_tools.compression as compression

    _original_decode_prediction = compression.decode_prediction
    compression.decode_prediction = _fast_decode_prediction
    _decode_applied = True
