# BW Maker

애니메이션 배경(BG) 작업용 PSD에서 **규칙에 맞는 레이어만 뽑아 새 PSD로 내보내는** 데스크톱 앱입니다.
예를 들어 "이름에 `line`이 포함된 레이어"만 골라 라인 PSD를 만드는 식으로, 수백 장 규모의 컷을
사람이 포토샵에서 하나씩 여닫지 않고 처리하는 것이 목적입니다.

- 레이어 트리에서 매칭 결과를 눈으로 확인하고, 미리보기로 결과를 렌더해 봅니다.
- 규칙은 **프리셋**으로 저장해 재사용하고, 여러 파일에 **배치**로 한 번에 적용합니다.
- 내보낸 PSD는 다시 열어 레이어 수·이름을 **검증**한 결과까지 함께 보고합니다.

아티스트 PC에 Python이 없다고 가정하고, 처리 엔진을 앱에 동봉하는 것을 전제로 설계했습니다.

## 설치

[Releases](https://github.com/yesonsys03-web/BW_Maker/releases)에서 내려받아 설치합니다. Python이나
uv를 따로 깔 필요는 없습니다 — 엔진이 앱 안에 들어 있습니다.

- **윈도우:** `BW.Maker_<버전>_x64-setup.exe` (또는 `.msi`)
- **macOS:** `.dmg` (Apple Silicon)

### 서명이 없습니다

코드 서명 인증서를 아직 쓰지 않으므로 처음 실행할 때 OS가 막습니다. 악성이라는 뜻이 아니라
"개발자를 확인할 수 없다"는 뜻입니다.

- **윈도우 SmartScreen:** "Windows의 PC 보호" 창에서 **추가 정보 → 실행**.
- **macOS Gatekeeper:** 앱을 **우클릭 → 열기**로 한 번 실행합니다. 그래도 막히면 시스템 설정 →
  개인정보 보호 및 보안에서 "확인 없이 열기"를 누릅니다.

백신이 PyInstaller로 만든 실행 파일을 오탐하는 일이 있습니다. UPX 압축을 쓰지 않아 오탐 확률을
낮춰 두었지만, 사내 백신이 격리한다면 예외 등록이 필요할 수 있습니다.

## 구성

```
src/          React + TypeScript UI
src-tauri/    Rust 셸 — 창, 파일 다이얼로그, 엔진 프로세스 관리
engine/       Python 엔진 — PSD 파싱/합성/내보내기 (psd-tools, pytoshop)
docs/         설계 스펙 및 구현 계획
```

UI와 엔진은 **stdin/stdout 줄 단위 JSON-RPC**로만 통신합니다. 엔진은 UI 없이 단독으로 실행·테스트할
수 있고, Rust 셸은 그 프로세스를 띄우고 요청을 중계하는 역할만 합니다.

### 에러를 감추지 않는다

이 저장소의 방침입니다. 엔진에서 예외가 나면 삼키거나 조용히 넘어가지 않고, **traceback 전문을 그대로
UI에 노출**합니다. 엔진 프로세스가 죽으면 자동 재시작하지 않고 배너로 알린 뒤 재시작 버튼을 제공하며,
패키지된 빌드에는 터미널이 없으므로 엔진 stderr의 마지막 줄들을 이벤트에 실어 함께 보여줍니다.

배포 빌드가 동봉된 엔진을 못 찾았을 때도 마찬가지입니다. 개발용 `uv` 경로로 조용히 넘어가지 않고
(사용자 PC에 uv는 없습니다) 찾아본 경로를 전부 담은 알림을 띄운 뒤 종료합니다.

## 개발

필요한 것: Node.js, Rust 툴체인, [uv](https://docs.astral.sh/uv/) (Python 3.12+).

```bash
npm install
cd engine && uv sync && cd ..
npm run tauri dev
```

`npm run tauri dev`는 개발 중에는 엔진을 저장소의 `engine/` 프로젝트에서 `uv run`으로 띄웁니다.
배포 빌드는 동봉된 동결 엔진을 실행합니다 — 아래 "배포 빌드" 참조.

### 배포 빌드

엔진을 PyInstaller로 동결(onedir)해 `src-tauri/binaries/psd-engine-<타깃 트리플>/`에 두면 Tauri가
`bundle.resources`로 앱에 담습니다. 동결은 크로스 컴파일이 안 되므로 **내보낼 OS에서** 돌려야 합니다.

```bash
bash scripts/build-engine.sh          # macOS
pwsh -File scripts/build-engine.ps1   # 윈도우
npm run tauri build
```

`build-engine.*`는 동결 직후 `engine/packaging/smoke.py`로 동결본을 실제로 실행해 봅니다(한글 경로
PSD 열기 → 썸네일 → 한글 경로로 내보내기 + 검증 → 에러 응답 → 정상 종료). 여기서 실패하면 빌드가
멈춥니다. 모듈이 빠진 번들은 사용자 PC의 첫 요청에서야 정체를 드러내기 때문입니다.

릴리스 설치본은 GitHub Actions가 만듭니다(`.github/workflows/windows-installer.yml`,
`macos-installer.yml`). `v*` 태그를 push하면 그 태그의 릴리스 자산으로 올라가고, 수동 실행
(workflow_dispatch)은 초안 릴리스에 올립니다. 태그와 앱 버전은 `src-tauri/tauri.conf.json`의
`version` 하나에서 나옵니다.

### 테스트

```bash
npm test                        # UI (vitest)
cd engine && uv run pytest      # 엔진 (pytest)
cd src-tauri && cargo test      # Rust 셸
```

실파일 수동 E2E 절차는 `docs/E2E_CHECKLIST.md`에 있습니다.

## docs/ 에 대하여

`docs/` 안의 스펙과 계획 문서는 **작성 당시의 기록**입니다. 프로젝트는 원래 `PSD Line Export`라는
이름으로 시작했고 이후 BW Maker로 바뀌었기 때문에, 그 문서들에는 옛 이름과 당시 경로가 그대로
남아 있습니다. 사실 관계를 보존하려고 일부러 고치지 않았습니다.

문서에 나오는 샘플 PSD 파일명(`sample_bg_wide_v01.psd` 등)은 실제 작업 파일을 익명화한 것입니다.
직접 실행할 때는 동등한 규모의 본인 PSD로 바꿔 진행하면 됩니다.

## 라이선스

MIT — [LICENSE](LICENSE) 참조.
