#!/usr/bin/env bash
set -euo pipefail

# psd_engine을 PyInstaller --onedir로 동결해, Tauri가 동봉할 자리에 스테이징한다.
# (배포 패키징 Plan C — docs/superpowers/plans/2026-07-31-psd-packaging.md)
#
# 개발 모드는 계속 `uv run python -m psd_engine`을 쓴다. 이 스크립트는 저장소도
# uv도 Python도 없는 PC에서 돌릴 릴리스 빌드용이다. PyInstaller는 크로스
# 컴파일이 안 되므로 각 OS에서 네이티브로 돌려야 한다 — 윈도우 대응본은
# scripts/build-engine.ps1이고, 둘은 같은 spec 파일을 공유한다.
#
# onefile이 아니라 onedir인 이유: onefile은 실행할 때마다 임시 디렉터리로 압축을
# 풀어(numpy/PIL이 들어가면 수 초) 기동이 느리고 백신 오탐도 늘어난다. 이 앱은
# 창이 뜨자마자 엔진을 spawn하므로 그 지연이 그대로 체감된다.
#
# 사용법 (어디서 실행해도 된다): bash scripts/build-engine.sh

# 저장소 루트 = scripts/..
cd "$(dirname "$0")/.."
[[ -f engine/pyproject.toml ]] || {
    echo "ERROR: repo root detection failed (cwd: $(pwd))" >&2
    exit 1
}

PY_VERSION="3.12"
BUILD_VENV="target/engine-build-venv"
VENV_PY="${BUILD_VENV}/bin/python"
DIST="target/engine-dist"
WORK="target/engine-build"

echo "Preparing Python ${PY_VERSION} build venv (engine deps + pyinstaller)…"
uv venv --clear --python "${PY_VERSION}" "${BUILD_VENV}"
uv pip install --python "${VENV_PY}" ./engine "pyinstaller>=6.21"

# 임포트 게이트. uv 캐시가 패키지를 실체화하지 못하고 .dist-info만 남기는 일이
# 있다(yeson_meet이 cv2/pymupdf에서 실측). 그 상태로 동결하면 PyInstaller가
# 모듈을 못 모아 번들이 조용히 비고, 사용자 PC에서 첫 요청에 죽는다 — 빌드가
# 성공한 것처럼 보이는 게 최악이라 여기서 멈춘다.
if ! "${VENV_PY}" -c 'import psd_tools, pytoshop, numpy, PIL'; then
    echo "build venv import gate failed — 캐시 없이 재설치 후 재검증…" >&2
    uv pip install --python "${VENV_PY}" --reinstall --no-cache ./engine
    "${VENV_PY}" -c 'import psd_tools, pytoshop, numpy, PIL'
fi
echo "build venv import gate OK (psd_tools, pytoshop, numpy, PIL)"

echo "Freezing psd_engine (PyInstaller --onedir, console)…"
# --onedir/--console/--noupx/--name은 spec 파일 안에 있다(스펙이 주어지면
# PyInstaller가 그런 makespec 옵션을 거부한다).
"${BUILD_VENV}/bin/pyinstaller" --noconfirm --clean \
    --distpath "${DIST}" --workpath "${WORK}" \
    engine/packaging/psd_engine.spec

OUT_DIR="${DIST}/psd_engine"
OUT_BIN="${OUT_DIR}/psd_engine"
[[ -x "${OUT_BIN}" ]] || {
    echo "ERROR: expected binary at ${OUT_BIN}" >&2
    exit 1
}

# 호스트 아키텍처 → Tauri 타깃 트리플. 스테이징 디렉터리 이름에 들어가고,
# 런타임에 Rust 쪽(locate_bundled_engine)이 같은 이름으로 찾는다.
case "$(uname -m)" in
    arm64)  TRIPLE="aarch64-apple-darwin" ;;
    x86_64) TRIPLE="x86_64-apple-darwin" ;;
    *)
        echo "ERROR: unsupported host arch: $(uname -m)" >&2
        exit 1
        ;;
esac

DEST_DIR="src-tauri/binaries/psd-engine-${TRIPLE}"
rm -rf "${DEST_DIR}"
mkdir -p "$(dirname "${DEST_DIR}")"
cp -R "${OUT_DIR}" "${DEST_DIR}"
echo "→ ${DEST_DIR}"
echo "  bundle size: $(du -sh "${DEST_DIR}" | cut -f1)"
echo "  entry binary: ${DEST_DIR}/psd_engine"
