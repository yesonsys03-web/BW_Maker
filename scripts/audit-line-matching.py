"""
폴더 하나의 PSD 전부에 프리셋을 적용해, 무엇이 뽑히고 무엇이 왜 빠졌는지 센다.

판별 규칙을 바꿀 때 실제 납품 파일에서 결과가 어떻게 달라지는지 보는 도구다.
엔진의 match_preset을 그대로 부른다 — 여기서 규칙을 다시 구현하면 이 숫자가
앱의 동작과 갈라져 아무 의미가 없어진다.

    python scripts/audit-line-matching.py <폴더> [--verbose]
"""
import argparse
import collections
import glob
import os
import sys
import traceback

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "engine"))

from psd_tools import PSDImage  # noqa: E402

from psd_engine.matching import match_preset  # noqa: E402
from psd_engine.tree import build_tree  # noqa: E402

PRESET = {
    "include": {"type": "contains", "value": "line", "caseSensitive": False},
    "excludeGroupPrefixes": ["-"],
    "matchGroups": True,
    "includeHidden": True,
    "merge": "none",
    "naming": "pathPrefix",
    "outputSuffix": "_LINE",
    "embedPreview": True,
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("folder")
    ap.add_argument("--verbose", action="store_true", help="빠진 레이어 경로를 전부 찍는다")
    args = ap.parse_args()

    files = sorted(glob.glob(os.path.join(args.folder, "*.psd")))
    if not files:
        sys.exit(f"PSD를 찾지 못했다: {args.folder}")

    total_matched = 0
    by_reason = collections.Counter()
    examples = collections.defaultdict(list)

    for i, path in enumerate(files, 1):
        print(f"[{i}/{len(files)}] {os.path.basename(path)}", file=sys.stderr)
        try:
            tree = build_tree(PSDImage.open(path))["tree"]
        except Exception:
            traceback.print_exc(file=sys.stderr)
            continue
        matched, skipped = match_preset(tree, PRESET)
        total_matched += len(matched)
        for s in skipped:
            by_reason[s["reason"]] += 1
            examples[s["reason"]].append(f"{os.path.basename(path)}: {s['path']}")

    print(f"\n파일 {len(files)}개")
    print(f"포함: {total_matched}장")
    print("빠진 이유:")
    for reason, count in by_reason.most_common():
        print(f"  {reason:<18} {count}")
        shown = examples[reason] if args.verbose else examples[reason][:3]
        for line in shown:
            print(f"      {line}")
        if not args.verbose and len(examples[reason]) > 3:
            print(f"      … 외 {len(examples[reason]) - 3}장")


if __name__ == "__main__":
    main()
