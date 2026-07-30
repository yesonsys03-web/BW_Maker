"""pytoshop 호환 패치 3종.

1. pytoshop 휠에 cython packbits 모듈이 없어 RLE 저장이 NameError로 죽는다
   → psd-tools의 C 확장 RLE 인코더로 대체.
2. pytoshop이 유니코드 문자열 길이에 NUL 종료 문자를 포함해 레이어명 끝에
   \x00이 붙는다 → 길이에서 제외(바이트 배치는 동일하게 유지).
3. pytoshop이 마스크 데이터가 없는 레이어에도 비어있지 않은 마스크 블록을 기록하는
   버그 → 마스크 없는 레이어의 경우 마스크 섹션 길이를 0으로 기록.
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
