"""
내보내기 결과의 픽셀 기준선을 뜨고, 나중에 그것과 대조한다.

내보내기 경로(특히 merge_rgba)를 고칠 때 "결과물이 정말 그대로인가"를 말이 아니라
바이트로 답하기 위한 도구다. 기준선은 엔트리마다 실제로 PSD에 기록되는 RGBA 배열의
sha256과 배치 좌표를 담는다.

**왜 파일 전체가 아니라 엔트리 픽셀인가.** 엔트리 목록(순서 포함)과 각 엔트리의
픽셀·좌표·이름이 같으면 nested_layers_to_psd에 들어가는 입력이 같고, 그것을 쓰는
코드는 건드리지 않으므로 나오는 PSD도 같다. 32MB짜리 산출물을 49장 쌓아두지 않고도
같은 것을 증명할 수 있다. 쓰기 경로까지 통째로 확인하고 싶으면 --write 를 준다.

엔진의 match_preset / preset_operations / build_export_plan / finalize_names /
_entry_pixels 를 그대로 부른다. 여기서 규칙이나 픽셀 계산을 다시 구현하면 이 대조는
앱의 동작과 갈라져 아무것도 증명하지 못한다.

기준선 뜨기 (이어붙이므로 중단해도 --resume 으로 이어서 할 수 있다):

    python scripts/export-baseline.py <폴더|파일...> --out baseline.jsonl

대조하기 (기준선과 다른 엔트리를 전부 찍는다):

    python scripts/export-baseline.py <폴더|파일...> --compare baseline.jsonl
"""
import argparse
import gc
import glob
import hashlib
import json
import os
import sys
import time
import traceback

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "engine"))

import numpy as np  # noqa: E402

from psd_engine.export import _entry_pixels, export_psd  # noqa: E402
from psd_engine.matching import match_preset, preset_operations  # noqa: E402
from psd_engine.ops import build_export_plan, finalize_names  # noqa: E402
from psd_engine.render import parse_line_color  # noqa: E402
from psd_engine.session import SessionStore  # noqa: E402

#: 앱이 실제로 쓰는 프리셋 파일. 기본 프리셋(merge="none")으로 재면 merge 경로를
#: 아예 타지 않아 이 도구가 지켜보려는 것을 하나도 지나가지 않는다.
DEFAULT_PRESETS_JSON = os.path.expanduser(
    "~/Library/Application Support/com.yeson.bwmaker/presets.json"
)


def _versions():
    """psd-tools를 올리면 픽셀이 달라질 수 있다. 기준선에 박아 두고 대조 때 확인한다."""
    import psd_tools
    import pytoshop
    return {
        "psd_tools": psd_tools.__version__,
        "pytoshop": getattr(pytoshop, "__version__", "1.2.1"),
        "numpy": np.__version__,
    }


def _preset_fingerprint(preset):
    """프리셋이 다르면 엔트리 구성 자체가 달라진다 — 다른 기준선과 섞이면 안 된다."""
    return hashlib.sha256(
        json.dumps(preset, sort_keys=True, ensure_ascii=False).encode()
    ).hexdigest()[:16]


def _load_preset(args):
    if args.preset_json:
        return json.loads(args.preset_json)
    with open(args.presets_file, encoding="utf-8") as f:
        presets = json.load(f)
    if args.preset_name:
        for p in presets:
            if p["name"] == args.preset_name:
                return p
        sys.exit(f"프리셋을 찾지 못했다: {args.preset_name!r} "
                 f"(있는 것: {[p['name'] for p in presets]})")
    return presets[0]


def _collect_files(targets):
    files = []
    for t in targets:
        if os.path.isdir(t):
            for ext in ("psd", "psb"):
                files.extend(glob.glob(os.path.join(t, f"*.{ext}")))
        else:
            files.append(t)
    return sorted(set(files))


def measure(path, preset, write_to=None):
    """파일 하나의 엔트리별 픽셀 지문. 실패하면 예외를 그대로 올린다(호출자가 기록)."""
    t0 = time.perf_counter()
    store = SessionStore(max_sessions=1)
    sid = store.open(path)
    try:
        s = store.get(sid)
        psd = s["psd"]
        t_open = time.perf_counter() - t0

        t = time.perf_counter()
        matched, skipped = match_preset(s["tree"], preset)
        if not matched:
            # 배치와 같은 판정 — 라인이 없는 판은 실패가 아니라 "내보낼 것 없음"이다.
            return {
                "path": path, "ok": True, "empty": True,
                "matched": 0, "entries": [],
                "canvas": [psd.width, psd.height],
                "timings": {"open": round(t_open, 2)},
            }
        operations = preset_operations(s["tree"], matched, preset,
                                       source_stem=os.path.splitext(os.path.basename(path))[0])
        entries = finalize_names(build_export_plan(matched, operations),
                                 s["nodes_by_id"], preset["naming"])
        t_plan = time.perf_counter() - t

        line_rgb = parse_line_color(preset.get("lineColor"))
        t = time.perf_counter()
        out_entries = []
        for e in entries:
            rgba, left, top = _entry_pixels(s, e, line_rgb)
            arr = np.ascontiguousarray(rgba)
            out_entries.append({
                "name": e["finalName"],
                "sources": len(e["sourceIds"]),
                "left": int(left), "top": int(top),
                "w": int(arr.shape[1]), "h": int(arr.shape[0]),
                "sha256": hashlib.sha256(arr.tobytes()).hexdigest(),
            })
            del rgba, arr
        t_pixels = time.perf_counter() - t

        result = {
            "path": path,
            "ok": True,
            "empty": False,
            "size": os.path.getsize(path),
            "mtime": os.path.getmtime(path),
            "canvas": [psd.width, psd.height],
            "matched": len(matched),
            "skipped": len(skipped),
            "entries": out_entries,
            "timings": {"open": round(t_open, 2), "plan": round(t_plan, 2),
                        "pixels": round(t_pixels, 2)},
        }

        if write_to is not None:
            os.makedirs(write_to, exist_ok=True)
            stem = os.path.splitext(os.path.basename(path))[0]
            out_path = os.path.join(write_to, f"{stem}{preset['outputSuffix']}.psd")
            t = time.perf_counter()
            export_psd(s, entries, out_path,
                       embed_preview=preset.get("embedPreview", True),
                       overwrite=True, line_color=preset.get("lineColor"))
            result["timings"]["write"] = round(time.perf_counter() - t, 2)
            with open(out_path, "rb") as f:
                result["fileSha256"] = hashlib.sha256(f.read()).hexdigest()
            result["fileSize"] = os.path.getsize(out_path)

        result["timings"]["total"] = round(time.perf_counter() - t0, 2)
        return result
    finally:
        store.close(sid)
        gc.collect()


def _key(rec):
    return rec["path"]


def _load_jsonl(path):
    records = {}
    header = None
    if not os.path.exists(path):
        return header, records
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            if obj.get("_header"):
                header = obj
            else:
                records[_key(obj)] = obj
    return header, records


def _diff_file(base, now):
    """기준선 한 건과 지금 한 건의 차이. 사람이 읽을 문자열 목록으로."""
    diffs = []
    if base.get("empty") != now.get("empty"):
        diffs.append(f"내보낼 것 없음 여부가 달라졌다: {base.get('empty')} -> {now.get('empty')}")
        return diffs
    if base.get("mtime") != now.get("mtime") or base.get("size") != now.get("size"):
        diffs.append("원본 파일이 그 사이에 바뀌었다 — 이 대조는 의미가 없다 "
                     f"(mtime {base.get('mtime')} -> {now.get('mtime')})")
        return diffs
    b, n = base["entries"], now["entries"]
    if len(b) != len(n):
        diffs.append(f"엔트리 수: {len(b)} -> {len(n)}")
    for i, (eb, en) in enumerate(zip(b, n)):
        for field in ("name", "sources", "left", "top", "w", "h", "sha256"):
            if eb[field] != en[field]:
                diffs.append(
                    f"엔트리 {i} {eb['name']!r} ({eb['sources']}장 병합): "
                    f"{field} {eb[field]} -> {en[field]}"
                )
    if "fileSha256" in base and "fileSha256" in now and base["fileSha256"] != now["fileSha256"]:
        diffs.append(f"산출 PSD 파일 해시가 다르다 ({base['fileSize']} -> {now['fileSize']} 바이트)")
    return diffs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("targets", nargs="+", help="폴더 또는 PSD 경로들")
    ap.add_argument("--out", help="기준선을 쓸 jsonl 경로")
    ap.add_argument("--compare", help="이 기준선과 대조한다")
    ap.add_argument("--resume", action="store_true",
                    help="--out 에 이미 있는 파일은 건너뛰고 이어붙인다")
    ap.add_argument("--force", action="store_true",
                    help="이미 있는 --out 을 새로 덮어쓴다")
    ap.add_argument("--limit", type=int, help="앞에서 N개만")
    ap.add_argument("--write", metavar="DIR",
                    help="PSD도 실제로 써서 파일 해시까지 남긴다(느리고 디스크를 쓴다)")
    ap.add_argument("--presets-file", default=DEFAULT_PRESETS_JSON)
    ap.add_argument("--preset-name", help="presets.json 안의 이름(기본: 첫 번째)")
    ap.add_argument("--preset-json", help="프리셋을 JSON 문자열로 직접")
    args = ap.parse_args()

    if not args.out and not args.compare:
        sys.exit("--out 또는 --compare 중 하나는 있어야 한다")

    preset = _load_preset(args)
    fp = _preset_fingerprint(preset)
    versions = _versions()
    print(f"프리셋: {preset.get('name')!r} merge={preset.get('merge')}"
          f"/{preset.get('mergeRule')} lineColor={preset.get('lineColor')} "
          f"naming={preset.get('naming')} [{fp}]", file=sys.stderr)
    print(f"버전: {versions}", file=sys.stderr)

    files = _collect_files(args.targets)
    if not files:
        sys.exit(f"PSD를 찾지 못했다: {args.targets}")

    base_header, base_records = (None, {})
    if args.compare:
        base_header, base_records = _load_jsonl(args.compare)
        if base_header is None:
            sys.exit(f"기준선에 헤더가 없다: {args.compare}")
        if base_header["presetFingerprint"] != fp:
            sys.exit("기준선과 프리셋이 다르다 — 이대로 대조하면 엔트리 구성부터 달라져 "
                     "아무것도 증명하지 못한다.\n"
                     f"  기준선: {base_header['preset'].get('name')!r} "
                     f"merge={base_header['preset'].get('merge')} [{base_header['presetFingerprint']}]\n"
                     f"  지금:   {preset.get('name')!r} merge={preset.get('merge')} [{fp}]")
        if base_header["versions"] != versions:
            print(f"  경고: 라이브러리 버전이 기준선과 다르다 {base_header['versions']} -> {versions}",
                  file=sys.stderr)
        overlap = [f for f in files if f in base_records]
        if not overlap:
            sys.exit(f"대조할 것이 없다 — 지정한 {len(files)}개 중 기준선에 있는 파일이 하나도 없다.\n"
                     f"  기준선에 있는 예: {list(base_records)[:2]}")
        if len(overlap) < len(files):
            print(f"  기준선에 없는 {len(files)-len(overlap)}개는 대조에서 뺀다", file=sys.stderr)
        files = overlap

    done = {}
    if args.out and args.resume:
        _, done = _load_jsonl(args.out)
        if done:
            print(f"이어서: 이미 {len(done)}개가 기준선에 있다", file=sys.stderr)

    if args.limit:
        files = files[:args.limit]

    out_f = None
    if args.out:
        exists = os.path.exists(args.out)
        # 기준선을 뜨는 데 몇 시간이 걸린다. --resume 도 --force 도 없이 같은 경로를
        # 다시 부르는 것은 거의 항상 실수이므로, 조용히 지우지 않고 멈춘다.
        if exists and not args.resume and not args.force:
            sys.exit(f"이미 있다: {args.out}\n"
                     f"  이어서 뜨려면 --resume, 정말 새로 뜨려면 --force")
        is_new = not exists or not args.resume
        out_f = open(args.out, "w" if is_new else "a", encoding="utf-8")
        if is_new:
            out_f.write(json.dumps({
                "_header": True, "preset": preset, "presetFingerprint": fp,
                "versions": versions, "createdAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
            }, ensure_ascii=False) + "\n")
            out_f.flush()

    n_same = n_diff = n_err = n_skip = 0
    started = time.perf_counter()
    for i, path in enumerate(files, 1):
        if path in done:
            n_skip += 1
            continue
        name = os.path.basename(path)
        print(f"[{i}/{len(files)}] {name} ...", end="", flush=True, file=sys.stderr)
        t = time.perf_counter()
        try:
            rec = measure(path, preset, write_to=args.write)
        except Exception as e:  # noqa: BLE001 — 항목별로 기록하고 계속(배치와 같은 정책)
            rec = {"path": path, "ok": False,
                   "error": {"message": str(e), "traceback": traceback.format_exc()}}
            n_err += 1
            print(f" 실패 {time.perf_counter()-t:.1f}s — {e}", file=sys.stderr)
        else:
            print(f" {rec['timings']['total']:.1f}s "
                  f"({rec.get('matched', 0)}장 -> {len(rec['entries'])}엔트리)",
                  file=sys.stderr)

        if out_f:
            out_f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            out_f.flush()

        if args.compare and rec.get("ok"):
            base = base_records.get(path)
            if base is None:
                print("    기준선에 없는 파일 — 건너뜀", file=sys.stderr)
                continue
            diffs = _diff_file(base, rec)
            if diffs:
                n_diff += 1
                print(f"    다름 ({len(diffs)}건):", file=sys.stderr)
                for d in diffs[:10]:
                    print(f"      - {d}", file=sys.stderr)
                if len(diffs) > 10:
                    print(f"      ... 외 {len(diffs)-10}건", file=sys.stderr)
            else:
                n_same += 1
                b_t = base["timings"]["total"]
                n_t = rec["timings"]["total"]
                print(f"    동일 (기준선 {b_t:.1f}s -> {n_t:.1f}s, "
                      f"{b_t/max(n_t, 0.01):.1f}배)", file=sys.stderr)

    if out_f:
        out_f.close()
        print(f"\n기준선: {args.out}", file=sys.stderr)
    elapsed = time.perf_counter() - started
    if args.compare:
        print(f"\n대조 결과: 동일 {n_same} / 다름 {n_diff} / 실패 {n_err} "
              f"({elapsed:.0f}s)", file=sys.stderr)
        sys.exit(1 if (n_diff or n_err) else 0)
    print(f"\n{len(files)-n_skip}개 기록, 실패 {n_err}, 건너뜀 {n_skip} ({elapsed:.0f}s)",
          file=sys.stderr)


if __name__ == "__main__":
    main()
