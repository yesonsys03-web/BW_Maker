"""export plan → 평탄화된 PNG/JPG. 원본은 절대 수정하지 않는다."""
import os

from PIL import Image

from .export import entry_pixels, split_output_path
from .paths import ensure_writable_path, long_path

#: JPEG의 축당 한계. PNG는 사실상 한계가 없고, PSD/PSB의 30,000은 이 경로와 무관하다.
JPEG_MAX_DIMENSION = 65535

#: 라인아트는 경계가 선명해 JPEG 링이 잘 보인다. 95는 사실상 무손실로 보이면서
#: 품질 옵션 UI를 늘리지 않는다.
JPEG_QUALITY = 95


def flatten_entries(session, entries, progress=None):
    """
    엔트리를 문서 크기의 투명 RGBA 캔버스에 아래에서 위로 합성한다.

    `export_psd`의 프리뷰 캔버스와 같은 합성이지만 그쪽을 헬퍼로 뽑아 쓰지는
    않는다 — `export_psd`는 픽셀 추출과 pytoshop 레이어 생성과 캔버스를 한 번의
    루프에서 처리하고, 그걸 갈라놓으면 픽셀 추출이 두 번 돈다.
    """
    psd = session["psd"]
    canvas = Image.new("RGBA", (psd.width, psd.height), (0, 0, 0, 0))
    total = len(entries) + 1
    for i, entry in enumerate(entries):
        rgba, left, top = entry_pixels(session, entry)
        canvas.alpha_composite(Image.fromarray(rgba), dest=(left, top))
        if progress:
            progress("compose", i + 1, total)
    return canvas


def _check_dimensions(fmt, width, height, output_path):
    if fmt == "jpg" and (width > JPEG_MAX_DIMENSION or height > JPEG_MAX_DIMENSION):
        raise ValueError(
            f"{output_path}: document is {width}x{height}, over the JPEG limit of "
            f"{JPEG_MAX_DIMENSION} px per axis — write it as .png"
        )


def export_raster(session, entries, output_path, fmt, overwrite=False,
                  progress=None):
    """
    엔트리를 평탄화해 한 장의 PNG/JPG로 쓴다.

    PNG는 RGBA 그대로다 — 배경은 투명하고 라인의 안티에일리어싱이 알파에 남는다.
    JPG는 알파가 없으므로 **흰 캔버스에 합성한 뒤** RGB로 바꾼다.

    RGBA에 convert("RGB")를 바로 걸면 안 된다. apply_line_color가 알파 0인
    픽셀의 RGB까지 라인 색으로 채워두므로(리샘플 번짐 방지), 알파를 그냥 버리면
    전면이 라인 색인 단색 이미지가 나온다.
    """
    if not entries:
        raise ValueError("no entries to export")
    output_path = str(output_path)
    ensure_writable_path(output_path)
    if os.path.exists(long_path(output_path)) and not overwrite:
        raise FileExistsError(f"output already exists: {output_path}")

    psd = session["psd"]
    _check_dimensions(fmt, psd.width, psd.height, output_path)

    canvas = flatten_entries(session, entries, progress)
    total = len(entries) + 1
    if progress:
        progress("write", total, total)

    if fmt == "jpg":
        backdrop = Image.new("RGBA", canvas.size, (255, 255, 255, 255))
        backdrop.alpha_composite(canvas)
        # subsampling=0(4:4:4). 기본 4:2:0은 색 성분을 절반으로 줄여 선 경계에
        # 색 번짐을 만든다.
        backdrop.convert("RGB").save(
            long_path(output_path), format="JPEG",
            quality=JPEG_QUALITY, subsampling=0,
        )
    else:
        canvas.save(long_path(output_path), format="PNG")

    return {"outputPath": output_path, "layerCount": len(entries)}


def export_raster_split(session, entries, output_path, fmt, overwrite=False,
                        progress=None):
    """
    엔트리마다 이미지 하나로 내보낸다. 캔버스 크기는 매 파일 원본 그대로다 —
    나중에 다시 합칠 때 좌표가 맞아야 하기 때문이다.

    충돌·길이 검사는 한 장이라도 쓰기 전에 전부 끝낸다. 절반쯤 쓰다 멈추면
    어디까지 나갔는지 알 수 없는 상태가 남는다.
    """
    if not entries:
        raise ValueError("no entries to export")

    targets = [(e, split_output_path(str(output_path), e["finalName"])) for e in entries]
    for _, p in targets:
        ensure_writable_path(p)
    if not overwrite:
        existing = [p for _, p in targets if os.path.exists(long_path(p))]
        if existing:
            raise FileExistsError("output already exists: " + ", ".join(existing))

    outputs = []
    total = len(targets)
    for i, (entry, path) in enumerate(targets):
        outputs.append(export_raster(session, [entry], path, fmt, overwrite=True,
                                     progress=None))
        if progress:
            progress("write", i + 1, total)
    return {"outputs": outputs, "layerCount": len(entries)}
