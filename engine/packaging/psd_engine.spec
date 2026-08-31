# -*- mode: python ; coding: utf-8 -*-
"""psd_engine 사이드카의 PyInstaller 동결 사양.

윈도우·macOS 두 빌드 스크립트(scripts/build-engine.sh, scripts/build-engine.ps1)가
이 파일 하나를 함께 쓴다. hiddenimports가 두 곳으로 갈라지면 한쪽 OS에서만 모듈이
빠지고, 그런 실패는 사용자 PC의 첫 요청에서야 드러난다.

여기 박혀 있는 두 가지 정책:

- ``console=True`` — `--windowed`/`--noconsole`로 얼리면 윈도우에서 `sys.stdout`이
  None이 되어 엔진이 JSON-RPC 응답 자체를 못 쓴다. 검은 콘솔 창은 부모 쪽
  CREATE_NO_WINDOW(src-tauri/src/engine.rs, 6d9476b)로 이미 막혀 있다.
- ``upx=False`` — UPX 압축은 백신 오탐을 늘린다. 당분간 서명 없이 배포할 계획이라
  (계획서 Task 6) 오탐 표면을 키우지 않는다.
"""
import os

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

HERE = os.path.abspath(SPECPATH)  # noqa: F821 — PyInstaller가 spec 네임스페이스에 주입

# psd-tools와 pytoshop은 함수 안에서 늦게 임포트하는 자리가 많다: export.py의
# `from pytoshop import enums` / `from pytoshop.user import nested_layers`,
# patches.py가 런타임에 갈아끼우는 pytoshop.codecs·pytoshop.layers와
# psd_tools.compression.rle_impl. 정적 분석이 대체로 따라가긴 하지만 두 패키지
# 모두 작아서 통째로 넣는 편이 싸고 확실하다. numpy·PIL은 PyInstaller 기본 훅이
# 처리하므로 여기서 건드리지 않는다.
# psd_engine 자신도 통째로 넣는다. 진입점(engine_main.py → psd_engine.entry)이
# 실행 모드를 함수 안 임포트로 가르므로(--warm-worker → warmworker, 그 외 → rpc),
# 정적 분석이 놓치면 그 모드만 사용자 PC에서 죽는다 — 같은 "싸고 확실하다" 판단이다.
hiddenimports = (collect_submodules("psd_engine")
                 + collect_submodules("psd_tools") + collect_submodules("pytoshop")
                 + collect_submodules("onnxruntime"))
datas = (collect_data_files("psd_engine") + collect_data_files("psd_tools")
         + collect_data_files("pytoshop"))

a = Analysis(
    [os.path.join(HERE, "engine_main.py")],
    pathex=[],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # PIL.ImageTk가 끌고 오는 tkinter는 이 엔진이 쓰지 않는다(UI는 전부 Tauri 쪽).
    excludes=["tkinter", "pytest"],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,  # onedir: 나머지는 COLLECT가 _internal/로 모은다
    name="psd_engine",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="psd_engine",
)
