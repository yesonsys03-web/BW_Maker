# psd_engine을 PyInstaller --onedir로 동결해 Tauri가 동봉할 자리에 스테이징한다.
# scripts/build-engine.sh의 윈도우 대응본 — 동결은 크로스 컴파일이 안 되므로
# 윈도우 산출물은 반드시 윈도우에서 만들어야 한다(CI는 windows-latest 러너).
#
# build-engine.sh와 달라지는 지점:
#   - venv 인터프리터가 <venv>\Scripts\python.exe (bin/ 아님)
#   - pyinstaller 실행 파일 대신 `python -m PyInstaller` (Scripts/ PATH 의존 제거)
#   - 진입 바이너리가 psd_engine.exe, 트리플은 x86_64-pc-windows-msvc
# hiddenimports 같은 실제 동결 사양은 engine/packaging/psd_engine.spec 하나를
# 양쪽이 공유한다 — 갈라지면 한쪽 OS에서만 모듈이 빠진다.
#
# 사전 조건: uv, uv가 쓸 수 있는 Python 3.12.
# 사용법 (어디서 실행해도 된다): pwsh -File scripts/build-engine.ps1
$ErrorActionPreference = "Stop"

# 저장소 루트 = scripts\..
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $Root
if (-not (Test-Path "engine/pyproject.toml")) {
    throw "repo root detection failed (cwd: $Root)"
}

$PyVersion  = "3.12"
$BuildVenv  = "target/engine-build-venv"
$VenvPython = Join-Path $BuildVenv "Scripts/python.exe"
$Dist       = "target/engine-dist"
$Work       = "target/engine-build"

Write-Host "Preparing Python $PyVersion build venv (engine deps + pyinstaller)..."
uv venv --clear --python $PyVersion $BuildVenv
uv pip install --python $VenvPython ./engine "pyinstaller>=6.21"

# 임포트 게이트 — build-engine.sh와 같은 이유(uv 캐시가 .dist-info만 남기는 일이
# 있다). 여기서 멈추지 않으면 모듈이 빠진 번들이 "성공"으로 나가 사용자 PC의 첫
# 요청에서 죽는다.
& $VenvPython -c "import psd_tools, pytoshop, numpy, PIL"
if ($LASTEXITCODE -ne 0) {
    Write-Host "build venv import gate failed -- reinstalling without cache and re-verifying..."
    uv pip install --python $VenvPython --reinstall --no-cache ./engine
    & $VenvPython -c "import psd_tools, pytoshop, numpy, PIL"
    if ($LASTEXITCODE -ne 0) { throw "engine deps not importable in build venv" }
}
Write-Host "build venv import gate OK (psd_tools, pytoshop, numpy, PIL)"

Write-Host "Freezing psd_engine (PyInstaller --onedir, console)..."
# --onedir/--console/--noupx/--name은 spec 안에 있다(스펙이 주어지면 PyInstaller가
# 그런 makespec 옵션을 거부한다).
& $VenvPython -m PyInstaller --noconfirm --clean `
    --distpath $Dist --workpath $Work `
    engine/packaging/psd_engine.spec
if ($LASTEXITCODE -ne 0) { throw "PyInstaller freeze failed" }

$OutDir = Join-Path $Dist "psd_engine"
$OutBin = Join-Path $OutDir "psd_engine.exe"
if (-not (Test-Path $OutBin)) {
    throw "expected binary at $OutBin"
}

# 런타임에 Rust 쪽(locate_bundled_engine)이 같은 이름으로 찾는다.
$Triple  = "x86_64-pc-windows-msvc"
$DestDir = "src-tauri/binaries/psd-engine-$Triple"
if (Test-Path $DestDir) { Remove-Item -Recurse -Force $DestDir }
New-Item -ItemType Directory -Force -Path (Split-Path $DestDir) | Out-Null
Copy-Item -Recurse $OutDir $DestDir
$SizeMB = [math]::Round((Get-ChildItem -Recurse $DestDir | Measure-Object Length -Sum).Sum / 1MB, 1)
Write-Host "-> $DestDir"
Write-Host "  bundle size: ${SizeMB} MB"
Write-Host "  entry binary: $DestDir/psd_engine.exe"

# 동결본이 실제로 말을 하는지 스테이징된 자리에서 확인한다 — build-engine.sh와
# 같은 이유이며, 한글 경로 요청이 실제로 죽는지 마는지는 cp949 로케일이 걸리는
# 이 쪽에서 봐야 의미가 있다. tauri build보다 앞이라 실패하면 번들이 안 나온다.
Write-Host "Smoke-testing the frozen sidecar..."
& $VenvPython engine/packaging/smoke.py "$DestDir/psd_engine.exe"
if ($LASTEXITCODE -ne 0) { throw "frozen sidecar smoke test failed" }
