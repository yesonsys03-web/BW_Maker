#!/usr/bin/env python
"""파일 준비의 순차 기준선 — 폴더 하나를 지금 방식으로 준비하는 데 걸리는 시간.

배포 경로 그대로 rpc.Engine을 직접 호출한다. 두 패스가 메인 엔진 하나에서
직렬로 도므로, 파일별 (open_psd + apply_preset + render_preview) 합이 곧
사용자가 기다리는 벽시계 시간이다.

파일은 **번호로만** 부른다 — 납품 파일명은 기록에 남기지 않는다.

    python scripts/prepare-baseline.py /path/to/folder presets/CHAR.json
"""
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "engine"))

from psd_engine.rpc import Engine  # noqa: E402


def main(folder, preset_path):
    preset = json.loads(Path(preset_path).read_text(encoding="utf-8"))
    paths = sorted(p for p in Path(folder).iterdir()
                   if p.suffix.lower() in (".psd", ".psb"))
    engine = Engine()
    rows = []
    t_all = time.perf_counter()
    for i, path in enumerate(paths, 1):
        row = {"n": i}
        try:
            t = time.perf_counter()
            opened = engine.open_psd(str(path))
            row["open_s"] = round(time.perf_counter() - t, 3)

            t = time.perf_counter()
            applied = engine.apply_preset(opened["sessionId"], preset)
            row["preset_s"] = round(time.perf_counter() - t, 3)

            matched = sorted(applied["matchedLayerIds"])
            t = time.perf_counter()
            if matched:
                engine.render_preview(
                    opened["sessionId"], matched, 1500,
                    lineColor=preset.get("lineColor"),
                    lineColorIds=matched if preset.get("lineColor") else None,
                    edgeLines=preset.get("edgeLines"),
                    includedIds=matched)
            row["preview_s"] = round(time.perf_counter() - t, 3)
            row["matched"] = len(matched)
        except Exception as e:  # 한 파일의 실패로 기준선 전체를 잃지 않는다
            row["error"] = f"{type(e).__name__}: {e}"
        row["total_s"] = round(
            sum(row.get(k, 0) for k in ("open_s", "preset_s", "preview_s")), 3)
        rows.append(row)
        print(json.dumps(row, ensure_ascii=False), flush=True)

    print(json.dumps({
        "files": len(paths),
        "wall_s": round(time.perf_counter() - t_all, 1),
        "sum_open_s": round(sum(r.get("open_s", 0) for r in rows), 1),
        "sum_preset_s": round(sum(r.get("preset_s", 0) for r in rows), 1),
        "sum_preview_s": round(sum(r.get("preview_s", 0) for r in rows), 1),
        "failed": sum(1 for r in rows if "error" in r),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
