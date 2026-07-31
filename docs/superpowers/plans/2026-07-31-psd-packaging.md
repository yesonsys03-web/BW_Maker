# BW Maker — 배포 패키징 (Plan C) Implementation Plan

**Goal:** 저장소도 `uv`도 없는 PC에 설치해서 실행되는 윈도우·macOS 설치본을, **GitHub Actions에서** 만든다. Python 엔진을 PyInstaller onedir로 동봉하고, Rust 쉘이 개발 모드와 배포 모드에서 각각 올바른 엔진을 띄우게 한다.

**현재 무엇이 막고 있나:** `src-tauri/src/engine.rs`의 `engine_command()`가 두 가지를 요구한다.

- 실행 디렉터리 `env!("CARGO_MANIFEST_DIR")/../engine` — 컴파일 시점에 박히는 **빌드 기계의 절대 경로**. 설치된 PC에는 없다.
- PATH의 `uv` — 일반 사용자 PC에는 없다.

그래서 지금 `tauri build` 산출물은 윈도우·macOS 모두 엔진이 뜨지 않는다. 윈도우 전용 문제가 아니다.

**Spec:** `docs/superpowers/specs/2026-07-30-psd-layer-tool-design.md` 10절(패키징), 11절(리스크)

**선례:** `~/coding/yeson_dev/yeson_meet` — FastAPI 서버를 PyInstaller onedir로 동결해 Tauri에 동봉하고 GitHub Actions로 윈도우·macOS 설치본을 낸다. 아래 설계는 그 구조를 따른다. 참고 파일: `.github/workflows/server-desktop-windows.yml`, `apps/server_desktop/scripts/build-server.ps1`, `apps/server_desktop/src-tauri/src/server_process.rs`(`locate_bundled_server`).

## 설계 판단 1 — externalBin이 아니라 resources

스펙 10절은 "PyInstaller **onedir** + Tauri `externalBin`"으로 적혀 있는데, 이 둘은 같이 못 쓴다. `externalBin`은 **파일 하나**를 타깃 트리플 접미사로 찾아 실행 파일 옆에 복사하는 기능이라, `exe + _internal/` 디렉터리를 내놓는 onedir는 담기지 않는다.

yeson_meet도 같은 결론에 도달해 있다 — onedir를 `src-tauri/binaries/yeson-server-<triple>/`에 두고 `bundle.resources`의 `binaries/yeson-server-*/**/*` 글롭으로 동봉한다. **같은 방식을 쓴다.**

onefile은 매 실행마다 임시 디렉터리로 압축을 풀어(numpy/PIL 포함 시 수 초) 기동이 느리고 백신 오탐도 늘어난다. 이 앱은 시작 직후 엔진을 spawn하므로 그 지연이 그대로 체감된다.

## 설계 판단 2 — 트리거는 태그, "워크플로 body 수정"은 따라하지 않는다

yeson_meet은 `workflow_dispatch` + "워크플로 파일 자신의 경로 변경 push"로 트리거한다. 그건 앱 2개 × OS 2개 = 워크플로 4개에 릴리스 노트가 각각 박혀 있고 업데이터 매니페스트를 병합해야 하는 사정 때문이고, 실제로 `apps/**` 경로 필터 때문에 **릴리스된 자산을 덮어써 매니페스트가 깨진 사고**(v1.2.2)를 겪은 뒤의 대응이다.

BW Maker는 앱 1개 + 업데이터 없음이라 그 복잡도가 없다. `workflow_dispatch` + `push: tags: ['v*']`로 간다. 대신 yeson_meet에서 **일반화되는 부분은 그대로 가져온다**:

- 릴리스 태그/이름의 단일 출처 = `src-tauri/tauri.conf.json`의 `.version` (워크플로가 `jq`로 읽음)
- 산출물은 Actions 아티팩트가 아니라 **릴리스 자산**으로 발행 — 무료 아티팩트 저장소는 0.5GB인데 엔진 동봉 설치본은 150~250MB다
- 동결은 **각 OS 러너에서 네이티브로** — PyInstaller는 크로스 컴파일이 안 된다

## Global Constraints

- 엔진 프로토콜(줄 단위 JSON-RPC)과 `psd_engine` 패키지 구조는 변경하지 않는다. 패키징은 실행 방식만 바꾼다.
- **에러 fallback·흡수 금지** (프로젝트 정책). 배포 빌드에서 사이드카를 못 찾으면 `uv`로 몰래 넘어가지 말고 경로를 담은 에러를 올린다 — 기존 `engine-dead` 경로로 표시된다. yeson_meet의 `locate_bundled_server`도 같은 처리다("bundled yeson-server binary not found").
- 사이드카는 **콘솔 앱으로** 빌드한다(`--windowed`/`--noconsole` 금지). 윈도우 windowed 빌드는 `sys.stdout`이 `None`이 되어 엔진이 응답 자체를 못 한다. 창은 이미 부모 쪽 `CREATE_NO_WINDOW`(`engine.rs`, `6d9476b`)로 막혀 있다.
- 검증 명령: 엔진 `cd engine && uv run --group dev pytest tests -q`, 프런트 `npm run test`, Rust `cd src-tauri && cargo check`.

---

### Task 1: PyInstaller 사이드카 동결 스크립트

**Files:**
- Create: `engine/packaging/engine_main.py` — 진입점. `from psd_engine.rpc import main; main()`
- Create: `scripts/build-engine.sh` (macOS) / `scripts/build-engine.ps1` (Windows) — yeson_meet의 `build-server.sh`/`.ps1` 쌍과 같은 역할
- Modify: `.gitignore` — `src-tauri/binaries/`, `target/engine-*`

**스크립트가 하는 일** (yeson_meet 구조 그대로)
1. `uv venv --clear --python 3.12 target/engine-build-venv`
2. `uv pip install ./engine "pyinstaller>=6.21"`
3. **임포트 게이트** — `python -c "import psd_tools, pytoshop, numpy, PIL"`. yeson_meet은 uv 캐시가 패키지를 실체화하지 못하고 `.dist-info`만 남기는 문제를 겪어 `cv2`/`pymupdf`에 이 게이트를 넣었다. 실패 시 `--reinstall --no-cache`로 재설치 후 재검증, 그래도 안 되면 빌드 중단.
4. `pyinstaller --noconfirm --clean --onedir --console --noupx` (`--noupx`는 백신 오탐 감소)
5. 산출물을 `src-tauri/binaries/psd-engine-<target-triple>/`로 스테이징. 트리플: `x86_64-pc-windows-msvc`, `aarch64-apple-darwin`.

**포인트**
- `hiddenimports`: `pytoshop.enums`, `pytoshop.user.nested_layers`, psd-tools의 지연 임포트. numpy·PIL은 PyInstaller 훅이 처리.
- `patches.py`의 pytoshop 패치는 런타임 적용이라 spec에서 할 일 없음 — 프리즈 후 적용 여부는 Task 4 스모크로 확인.

- [ ] **Step 1:** macOS에서 `build-engine.sh`로 동결 성공
- [ ] **Step 2:** 동결된 실행 파일에 요청 한 줄을 파이프로 넣어 응답 확인

### Task 2: Rust — 개발/배포 사이드카 해석

**Files:**
- Modify: `src-tauri/src/engine.rs` (`engine_command`)
- Modify: `src-tauri/tauri.conf.json` (`bundle.resources`)

`bundle.resources`에 `"binaries/psd-engine-*/**/*"` 추가. 해석 함수는 yeson_meet의 `locate_bundled_server`를 그대로 본뜬다 — `std::env::current_exe()`에서 출발해 후보 루트를 훑고, 없으면 **에러**:

```rust
/// 스테이징된 onedir 사이드카를 찾는다. Tauri가 resources를 앱 옆에 풀어놓는
/// 배포 레이아웃과, 개발용 `binaries/` 스테이징 디렉터리를 모두 커버한다.
fn locate_bundled_engine() -> Option<PathBuf> {
    let dir = format!("psd-engine-{}", target_triple());
    let bin = format!("psd_engine{}", std::env::consts::EXE_SUFFIX);
    let exe = std::env::current_exe().ok()?;
    let mut roots = vec![exe.parent()?.to_path_buf(), exe.parent()?.join("binaries")];
    // macOS .app: Contents/MacOS/<exe> → 리소스는 Contents/Resources
    if let Some(contents) = exe.parent()?.parent() {
        roots.push(contents.join("Resources"));
        roots.push(contents.join("Resources").join("binaries"));
    }
    roots.into_iter().map(|r| r.join(&dir).join(&bin)).find(|p| p.exists())
}
```

`engine_command()`는 릴리스에서 이 경로를, 개발(`debug_assertions`)에서 현행 `uv run`을 쓴다. `PYTHONUTF8`/`PYTHONIOENCODING` 주입과 `CREATE_NO_WINDOW`는 양쪽 공통으로 유지한다. 다만 **프리즈된 인터프리터는 환경 변수를 무시할 수 있어**, 실제 방어선은 `rpc.py`의 `_as_utf8` reconfigure다 — Task 4에서 반드시 확인.

- [ ] **Step 1:** 구현 + `cargo check`
- [ ] **Step 2:** macOS에서 `npm run tauri build` → 설치본 실행 → PSD 열기까지

### Task 3: GitHub Actions — 윈도우 설치본

**Files:**
- Create: `.github/workflows/windows-installer.yml` (현재 저장소에 워크플로 없음)

`runs-on: windows-latest`, `timeout-minutes: 45`, `permissions: contents: write`.

```
on:
  workflow_dispatch:
  push:
    tags: ['v*']
```

단계: checkout → Node 22 + npm → `dtolnay/rust-toolchain@stable` → `actions/setup-python@v5` (3.12) → `astral-sh/setup-uv@v5` (`enable-cache: true`) → `npm ci` → **`pwsh -File scripts/build-engine.ps1`** → `npm run tauri build -- --bundles nsis msi` → 버전 읽기(`jq -r .version src-tauri/tauri.conf.json`) → `softprops/action-gh-release@v2`로 `v${VERSION}` 릴리스에 `.exe`/`.msi` 첨부 (`fail_on_unmatched_files: true`).

동결이 실패하면 빌드가 실패한다 — 그 자체가 신호다(yeson_meet의 P0 게이트와 같은 성격).

- [ ] **Step 1:** 워크플로 작성 → `workflow_dispatch`로 수동 1회 실행
- [ ] **Step 2:** 실패 지점(대개 hiddenimports 누락)을 Task 1 spec에 반영해 반복
- [ ] **Step 3:** 릴리스 자산으로 `.exe`/`.msi`가 올라오는 것 확인

### Task 4: 동결 사이드카 스모크 테스트 (CI에서)

수동 확인에 의존하면 다음 릴리스에서 다시 깨진다. **`tauri build` 전에** CI에서 돌린다.

**Files:**
- Create: `engine/packaging/smoke.py` — 동결된 실행 파일에 stdin으로 요청을 넣고 응답 검증

**확인 항목**
- [ ] 정상 요청 → `{"id":1,"result":...}` 응답
- [ ] **한글 경로 요청 → 프로세스가 죽지 않고 에러 응답** — `ensure_ascii=False`로 UTF-8 원문을 보내야 의미가 있다(`6d9476b`의 회귀 테스트가 처음 무력했던 이유). 그 테스트는 CPython만 덮으므로 프리즈 빌드는 여기서 확인한다.
- [ ] 존재하지 않는 파일 → traceback 포함 에러 응답
- [ ] stdin 닫힘 → 정상 종료(임시 렌더 디렉터리 atexit 정리)

### Task 5: macOS 설치본

**Files:**
- Create: `.github/workflows/macos-installer.yml` (`runs-on: macos-latest`, `--bundles app dmg`)

윈도우가 통과한 뒤 같은 구조로 복제한다. macOS만의 추가 사항: `bundle.resources`로 넣은 사이드카는 **중첩 Mach-O 바이너리를 개별 서명**해야 notarize를 통과한다(`--deep`는 폐기). `_internal/`의 `.so`/`.dylib`까지 포함되므로 스크립트로 처리. 우선 arm64 단독으로 시작한다.

- [ ] **Step 1:** 워크플로 복제 + dmg 산출
- [ ] **Step 2:** 서명·notarize (인증서 준비 후)

### Task 6: 서명·배포 안내

- [ ] **윈도우:** Authenticode 인증서가 없으면 **미서명으로 배포**하고 SmartScreen "추가 정보 → 실행" 안내를 문서화한다 — yeson_meet도 같은 선택을 했다(`docs/INSTALL.md`). 스펙 11절의 "PyInstaller 오탐(백신)" 리스크가 여기 걸리며 `--noupx`가 완화책이다.
- [ ] **Step 2:** `README.md`에 설치·실행 안내 추가

---

## 합격 조건

1. CI가 만든 윈도우 설치본을, **저장소·uv·Python이 없는 윈도우 PC**에 설치해 실행하고 **한글 경로 PSD**로 라인 추출·내보내기까지 된다. (빌드는 CI가 하지만, 이 최종 확인만은 실물 윈도우 PC나 VM이 필요하다.)
2. 콘솔 창이 뜨지 않는다.
3. 같은 것이 macOS에서도 된다.
4. 동결 사이드카 스모크가 CI에 있어 다음 변경 때 회귀를 잡는다.

## 범위 밖

- 자동 업데이트(Tauri updater) — yeson_meet에는 있지만 BW Maker는 아직 불필요
- Intel macOS / 유니버설 바이너리
- 엔진 기능 변경
