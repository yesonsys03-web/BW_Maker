#!/usr/bin/env bash
set -euo pipefail

# 동결 사이드카 안의 모든 Mach-O가 요구하는 최소 macOS(LC_BUILD_VERSION minos /
# LC_VERSION_MIN_MACOSX)를 읽어, 상한을 넘는 파일이 하나라도 있으면 실패한다.
#
# 왜 있나: v0.4.5는 macOS 15 러너가 고른 numpy 휠(macosx_14_0)과 onnxruntime
# 1.23.2(13.4)를 그대로 동봉해, 몬터레이(12)에서 dyld가 "built for macOS 14.0
# which is newer than running OS"로 로드를 거절했고 엔진이 시동 임포트에서 죽었다.
# 그 상태로도 빌드·smoke는 통과했다 — 빌드 기계가 그보다 새 OS였기 때문이다.
# 이 검사는 빌드 기계의 OS와 무관하게 산물 자체를 판정한다.
#
# 사용법: bash scripts/check-sidecar-minos.sh <sidecar-dir> <max-minos>   예) … 12.0

dir="${1:?usage: check-sidecar-minos.sh <sidecar-dir> <max-minos>}"
max="${2:?usage: check-sidecar-minos.sh <sidecar-dir> <max-minos>}"
[[ -d "$dir" ]] || { echo "ERROR: not a directory: $dir" >&2; exit 2; }

minos_of() {
    otool -l "$1" 2>/dev/null | awk '
        /LC_BUILD_VERSION/ {b=1}      b && /minos/   {print $2; exit}
        /LC_VERSION_MIN_MACOSX/ {v=1} v && /version/ {print $2; exit}'
}

# major.minor 숫자 비교: $1 > $2 이면 0
ver_gt() {
    awk -v a="$1" -v b="$2" 'BEGIN {
        split(a, x, "."); split(b, y, ".")
        if (x[1]+0 > y[1]+0 || (x[1]+0 == y[1]+0 && x[2]+0 > y[2]+0)) exit 0
        exit 1 }'
}

bad=0
total=0
declare -a offenders=()
while IFS= read -r -d '' f; do
    v="$(minos_of "$f")"
    [[ -n "$v" ]] || continue
    total=$((total + 1))
    if ver_gt "$v" "$max"; then
        bad=$((bad + 1))
        offenders+=("$v  ${f#"$dir"/}")
    fi
done < <(find "$dir" -type f \( -name '*.so' -o -name '*.dylib' -o -name 'Python' -o -name 'psd_engine' \) -print0)

if (( total == 0 )); then
    echo "ERROR: no Mach-O files found under $dir" >&2
    exit 2
fi

if (( bad > 0 )); then
    echo "ERROR: ${bad}/${total} Mach-O files require macOS newer than ${max}:" >&2
    printf '  %s\n' "${offenders[@]}" | sort >&2
    echo "  (dyld on an older Mac refuses these: 'built for macOS X which is newer than running OS')" >&2
    exit 1
fi
echo "sidecar minos OK: ${total} Mach-O files, all ≤ macOS ${max}"
