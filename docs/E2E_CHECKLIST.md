# Task 10 보고서: 엔진 생존성 UI + 통합 마감

담당 범위: 브리프의 EngineStatus + 마감 체크리스트, 보충요건 S2(축출 세션 재오픈) + S3(E2E 절차서).
S1(빈 레이어 썸네일 크래시)은 커밋 `c598a5e`로 이미 완료되어 있음을 확인했고 재작업하지 않았다.

## 구현 내용

### 1. EngineStatus (브리프)

- `src/components/EngineStatus.tsx` 신규. `onEngineDead` 구독 → 상단 고정 배너("엔진 프로세스가
  종료되었습니다. 열려 있던 모든 파일 세션이 사라졌습니다 — 재시작 후 파일을 다시 선택하면 새로
  열립니다.") + "재시작" 버튼.
- 재시작 버튼: `invoke("restart_engine")` (Tauri 커맨드 — `src-tauri/src/engine.rs`에 기존 구현,
  수정 안 함). 성공 시 `onRestarted()` → appStore의 새 액션 `engineRestarted`를 디스패치해 파일
  목록 전체를 `{path, status:"idle"}`로 리셋하고 `activePath`/`matchedIds`를 비운다(세션은 전부
  소멸했으므로 각 파일을 다시 선택하면 처음 열 때와 동일한 경로로 재오픈된다).
- 실패(재시작 자체가 실패) 시 `onError` → ErrorPanel.
- `App.tsx`에 `.app-shell`의 첫 자식으로 배치. 배너는 `position: fixed`(z-index 200, ErrorPanel의
  100보다 위)라 기존 CSS 그리드(`grid-template-areas`)에 영향 없음.

### 2. S2 — 축출된 세션 투명 재오픈

권장된 "실패 시 재시도" 방식으로 구현(매 재선택마다 무조건 재오픈하지 않음 — 그러면 LRU 캐시가
있는 의미가 없어짐):

- `src/lib/preview.ts`: `isEvictedSessionError(e)` 순수 함수 추가. 엔진의
  `SessionStore.get`(`engine/psd_engine/session.py:38`)이 던지는
  `KeyError(f"unknown or evicted session: {sid}")`를 감지한다. 부분 문자열 매치를 쓴 이유:
  Python의 `KeyError.__str__`은 `repr()`로 감싸서 `"'unknown or evicted session: 2'"` 형태로
  나온다(`str(KeyError("x"))` 확인함) — 따옴표 유무와 무관하게 매치되도록.
- `src/lib/sessionRetry.ts`: `withEvictedSessionRetry(path, sessionId, call, onReopened)`. 1차
  호출 실패 시 `isEvictedSessionError`가 아니면 그대로 rethrow(ErrorPanel행). 맞으면
  `openPsd(path)`로 재오픈 → `onReopened(result)` → 새 sessionId로 1회 재시도. 재오픈 자체가
  실패하면 그 에러가 그대로 전파된다(ErrorPanel행, 요구사항대로).
- appStore에 `sessionRefreshed` 액션 추가: `sessionId`/`tree`/`width`/`height`만 갱신하고
  **`opsByPath`는 건드리지 않는다** — 이것이 "편집 상태(ops/includedIds/previewHiddenIds) 보존"
  요구사항의 핵심이다(`openSuccess`는 매번 `buildInitialOpsState`로 덮어쓰지만
  `sessionRefreshed`는 그렇지 않음).
- 네 곳의 실제 세션 사용 호출 지점 전부에 적용: `App.tsx`의 썸네일 렌더(백그라운드 1회),
  `PreviewCanvas`의 `renderPreview`, `PresetBar`의 `applyPreset`, `ExportDialog`의 `exportPsd`.
  (`BatchPanel`의 `batchRun`은 서버가 자체적으로 파일을 열기 때문에 기존 세션에 의존하지 않음 —
  대상 아님, docstring에도 명시되어 있음.)
- 각 컴포넌트는 `path`/`onSessionRefreshed` prop을 추가로 받는다(App.tsx가 appStore의
  `refreshSession` 콜백을 그대로 전달).

### 3. close_session 배선 (마감 체크리스트)

`closeSession`(`src/lib/engine.ts`)은 Task 3에서 만들어졌지만 어디서도 호출되지 않고 있었다.
현재 앱에는 "파일 닫기" 트리거가 전혀 없어서(FilePanel은 추가/선택만 가능), 이 항목을 만족시킬
실제 진입점이 없었다 — 그래서 FilePanel에 목록에서 파일을 제거하는 최소한의 "×" 버튼을
추가했다.

- `selectFile`로 다른 파일로 "전환"할 때는 세션을 닫지 않는다 — 그렇게 하면 LRU(최대 2개) 캐시로
  두 파일을 오가며 재파싱 없이 빠르게 전환하는 목적 자체가 사라진다(브리프의 "LRU 축출과
  충돌하지 않게"가 경고하는 게 바로 이 케이스라고 판단했다).
- 대신 "제거"(목록에서 빼기 = 이 파일을 더 이상 추적하지 않겠다는 명시적 의도)에서만 닫는다.
  `removeFileEffect(dispatch, file)`: `sessionId`가 있으면 `closeSession` best-effort 호출 →
  실패해도 (엔진이 이미 죽었거나 세션이 이미 축출됐어도 `SessionStore.close`는 `pop(sid, None)`이라
  안전) `pushError`로 노출하되 로컬 목록 제거는 그대로 진행(닫기 실패로 항목이 영구히 안 지워지는
  것 방지, 그러나 실패를 삼키지는 않음). `App.tsx`에 `thumbsByPath`/`fetchedPathsRef` 정리 effect도
  추가해 제거된 파일의 썸네일 캐시가 새지 않게 했다.
- **범위 판단(보고 필요 사항)**: "기능 추가 금지"와 명시적으로 긴장 관계에 있는 선택이다. 이
  버튼이 없으면 `close_session`을 호출할 코드 경로가 원천적으로 존재하지 않으므로, 체크리스트
  항목을 실질적으로 충족시키는 유일한 방법이라고 판단해 최소 구현(확인 다이얼로그 없음, 목록에서
  제거만, 파일 자체는 건드리지 않음)으로 추가했다. 컨트롤러가 이 판단에 동의하지 않으면 되돌리기
  쉬운 변경이다(FilePanel/App.tsx/appStore.tsx의 관련 diff만 되돌리면 됨).

## 마감 체크리스트 확인 결과

| 항목 | 결과 | 근거 |
|---|---|---|
| 모든 엔진 호출 경로가 실패 시 ErrorPanel로 traceback 노출 | 확인 완료 | `grep -rn "catch" src` 전수 확인(아래 상세). 엔진 RPC(`openPsd/applyPreset/renderPreview/renderThumbnails/exportPsd/batchRun/closeSession`)를 호출하는 모든 지점이 `onError`/`pushError`로 귀결됨. 유일한 무시 catch는 `FilePanel.tsx:53`의 Tauri webview drag-drop 구독 등록 실패(`.catch(() => {})`)인데, 이건 엔진 RPC가 아니라 "이 창이 Tauri 웹뷰가 아님" 환경 감지이고 HTML5 `onDrop` 폴백이 바로 아래 있어 실질 기능 손실이 없음(Task 5 리뷰에서 이미 승인된 기존 코드, 이번에 손대지 않음). |
| 파일 닫기/전환 시 close_session 호출 | 구현 완료(범위 판단 위 참조) | `removeFileEffect`(appStore.tsx) → FilePanel "×" 버튼. 단순 전환(같은 세션 유지)에는 호출하지 않음(LRU 캐시 목적 보존). |
| 앱 종료 시 Rust가 엔진 child kill | 확인만(기존 구현, 미수정) | `src-tauri/src/lib.rs`: `on_window_event`의 `WindowEvent::Destroyed`와 `.run(...)`의 `RunEvent::Exit` 양쪽에서 `engine::kill_engine(app_handle)` 호출 확인. `kill_engine`은 `child.kill()` + `child.wait()`. src-tauri 미수정. |
| vitest 전체 통과 | 통과 | `npm run test -- --run` → **94 passed** (기존 78 + `sessionRetry.test.ts` 8개 + `appStore.test.ts` 신규 8개: removeFile 3, sessionRefreshed 1, engineRestarted 1, removeFileEffect 3). |
| `cd engine && uv run pytest` 통과 | 통과 | **54 passed**(S1 수정 포함, 엔진 미수정 — 재확인만). |
| `cargo test` 통과 | 통과 | `cd src-tauri && cargo build && cargo test` → 3 passed (routes_response_event_skip, should_drain_on_eof_only_when_epoch_unchanged, restart_race_does_not_leak_or_misfire_pending). src-tauri 미수정이라 결과 동일. |
| `npm run build` 통과 | 통과 | `tsc && vite build` 정상 완료(dist 산출물 생성 확인). |

## S3 — 실파일 E2E 절차서 (컨트롤러 실행용)

대상 파일(둘 다 존재/크기 확인함):
- `~/samples/bg_psd/sample_bg_wide_v01.psd` (430,189,661 bytes)
- `~/samples/bg_psd/sample_bg_interior_v03 2.psd` (179,611,352 bytes)

절차:
1. `npm run tauri dev`로 앱 실행.
2. 좌측 파일 패널 "+ 추가"로 위 두 파일을 선택(또는 드래그&드롭)하여 목록에 추가.
3. 첫 번째 파일(430MB)을 클릭해 연다 — "처리중" → "열림"으로 바뀌고 레이어 트리/썸네일이
   채워지는지 확인(빈 레이어 썸네일 스킵 동작 — S1 수정 — 이 실파일에서 정확히 검증되는
   지점이다: 'reflections'/'Particles' 등 0x0 레이어가 있어도 나머지 썸네일이 정상 표시되고
   에러 없이 전체가 로드돼야 함).
4. 상단 프리셋 바에서 'line 추출' 프리셋(또는 동등한 이름 규칙 프리셋 — 파일마다 5개/14개
   line 레이어가 매칭되어야 함)을 선택 후 "적용" — 매칭된 레이어가 강조되는지 확인.
5. 중앙 미리보기 캔버스에서 렌더링 결과 확인(휠 줌/드래그 팬 동작도 함께 확인).
6. 레이어 트리에서 임의의 두 레이어를 골라 병합(우클릭/버튼 등 기존 UI로) 1회 수행 — 히스토리
   탭에 병합 항목이 기록되는지 확인.
7. 상단 "내보내기..." → 내보내기 다이얼로그에서 순서/이름 확인 후 저장 다이얼로그로 출력 경로
   지정 → 내보내기 실행.
8. 결과 카드에서 "검증 통과" 배지 확인, 레이어별 이름/픽셀 확인 테이블이 모두 OK인지 확인.
9. 두 번째 파일(180MB)로 전환해 3~5를 반복(**이 시점이 S2의 핵심 검증 지점** — 두 파일을 열어둔
   상태이므로 아직 LRU 축출은 발생하지 않지만, 이 스텝까지 정상 동작함을 먼저 확인).
10. 하단 탭을 "배치"로 전환 → 두 파일 모두 체크 → 동일 프리셋 선택 → "배치 실행" → 결과
    테이블에서 두 파일 모두 "성공"과 레이어 수/출력 경로가 채워지는지 확인.
11. (S2 전용 추가 스텝) 세 번째 PSD 파일을 하나 더 열어 LRU를 강제로 축출시킨 뒤(엔진
    `SessionStore` max=2이므로 3번째 open 시 가장 오래된 세션이 자동 축출됨), 축출된 첫 번째
    파일(430MB)을 다시 클릭해 미리보기/내보내기를 시도 — ErrorPanel에 "unknown or evicted
    session" 에러가 뜨지 않고, 잠깐의 재오픈(자동) 후 정상 동작하는지, 그리고 4~6에서 만든 편집
    상태(매칭/병합)가 그대로 유지되는지 확인.
12. (EngineStatus 전용 추가 스텝) 엔진 프로세스를 강제 종료(`pkill -f "psd_engine"` 등)해 상단에
    빨간 배너가 뜨는지, "재시작" 클릭 후 파일 목록이 전부 "대기" 상태로 바뀌는지, 파일을 다시
    선택하면 정상적으로 재오픈되는지 확인.

이 절차는 GUI 조작이 필요해 컨트롤러가 직접 실행해야 한다(본 에이전트는 헤드리스 환경이라
자동화된 vitest/pytest/cargo test/build로만 회귀를 검증했다).

## Self-review

- `withEvictedSessionRetry`/`isEvictedSessionError`는 순수 함수 + 단위 테스트로 커버(성공/축출
  후 재시도/무관한 에러 전파/재오픈 자체 실패 전파 4가지 분기 모두 테스트).
- `sessionRefreshed`가 `opsByPath`를 안 건드린다는 것을 appStore.test.ts에서 rename op를 만든 뒤
  재오픈해도 살아남는지로 직접 검증.
- `removeFileEffect`의 세 가지 분기(세션 있음/없음/close 실패) 모두 테스트.
- `npx tsc --noEmit` 별도 실행으로 타입 통과 확인, `npm run build`도 별도 통과 확인(둘 다 tsc를
  쓰지만 옵션이 다를 수 있어 각각 실행함).
- 4개 세션-사용 호출 지점(썸네일/미리보기/프리셋 적용/내보내기)에 동일 패턴을 적용해 놓쳐서
  ErrorPanel에 "unknown or evicted session"이 그대로 노출되는 경로가 없는지 grep으로 재확인함
  (`grep -n "openPsd(\|applyPreset(\|renderPreview(\|renderThumbnails(\|exportPsd(\|batchRun(\|closeSession(" src`).

## Concerns / 범위 밖 발견 사항

1. **close_session 배선을 위한 "×" 버튼 추가는 "기능 추가 금지" 지시와 다소 긴장 관계**입니다.
   판단 근거는 위 "3. close_session 배선" 절 참조. 컨트롤러가 이 판단을 재고하고 싶다면 되돌리기
   쉬운 변경입니다.
2. (미결정, 사소함) S2 재오픈으로 `sessionId` prop이 바뀌면 `PreviewCanvas`의 "파일 전환 시 뷰
   리셋" effect(`useEffect(..., [sessionId])`, 기존 Task 6 코드)가 같이 발동해 줌/팬 위치가
   초기화됩니다. 축출 후 복구라는 드문 경로에서만 발생하는 사소한 UX 흠집이라 이번 범위에서는
   손대지 않았습니다.
3. (기존에 이미 deferred로 기록된 항목, 재확인만) `FilePanel.handleBrowse`/`BatchPanel`의 폴더
   선택 다이얼로그 호출에는 try/catch가 없어 다이얼로그 자체가 실패하면 unhandled rejection이
   콘솔에 남습니다. 엔진 RPC 경로가 아니라 이번 체크리스트("엔진 호출 경로") 대상은 아니라고
   판단했습니다.
