# jpg/png 출력 포맷 — 설계 문서

날짜: 2026-08-06
상태: 설계 승인됨 (구현 계획 작성 전)

## 1. 문제

지금 내보내기는 원본 포맷을 따라간다 — `.psd`는 `.psd`로, `.psb`는 `.psb`로. 결과를 눈으로
확인하거나 남에게 보내려면 매번 포토샵을 열어 다른 이름으로 저장해야 한다.

원하는 것은 **평탄화된 한 장의 이미지**다. PNG는 배경이 투명하고 라인의 안티에일리어싱이
알파에 살아 있어야 하며, JPG는 흰 배경에 구워진 불투명 이미지여야 한다.

## 2. 포맷이라는 값

```
OutputFormat = "psd" | "png" | "jpg"
```

`"psd"`는 **"원본 따름"**이다. 지금 동작 그대로 `.psd`→`.psd`, `.psb`→`.psb`. 화면에 보이는
선택지는 *원본 따름 / PNG / JPG* 셋이고, 기본값 `"psd"`가 기존 동작을 한 치도 바꾸지 않는다.

`.psb`를 네 번째 선택지로 올리지 않는다. 원본이 `.psd`인데 `.psb`로 내보낼 이유가 없고,
`.psb`가 필요한 경우(30,000px 초과)는 이미 자동으로 판정된다.

## 3. 확장자 규칙 — 다섯 곳이 한 규칙을 공유한다

```
output_extension(src_path, fmt):
    fmt == "png" → ".png"
    fmt == "jpg" → ".jpg"
    else         → ".psb" if src is .psb else ".psd"      # 기존 규칙 그대로
```

이 규칙이 사는 곳은 다섯 군데다.

| 위치 | 역할 |
|---|---|
| `src/lib/exportFlow.ts` `outputExtension` | 단일 내보내기 기본 경로 |
| `src/lib/batch.ts` `planBatchOutputs` | 배치 경로 + **충돌 사전 검사** |
| `src/components/ExportDialog.tsx` | 네이티브 저장 대화상자 필터 |
| `engine/psd_engine/export.py` `output_extension` | 실제로 파일이 나가는 경로 |
| `engine/psd_engine/batch.py` | 배치 실제 경로 |

`export.py`의 기존 주석이 이유를 이미 적어놨다 — 프런트가 계산한 경로는 덮어쓰기 사전 검사와
UI에 쓰이고 실제 파일은 엔진이 쓰므로, **둘이 갈라지면 검사한 적 없는 경로에 파일을 쓰게 된다.**

`test_output_extension_matches_the_frontend_rule`의 파라미터 표에 포맷 축을 추가한다. 두 규칙이
갈라지는 순간 테스트가 깨져야 한다.

## 4. `raster.py` — 새 모듈, PSD 경로는 무수정

래스터 쓰기는 `engine/psd_engine/raster.py`에 새로 담고, `rpc.export_psd`가 포맷으로 분기한다.
기존 PSD 경로와 `verify.py`는 **한 줄도 건드리지 않는다.**

이 저장소에서 가장 비싸게 얻은 것이 그 경로에 있다. 내보내기 35.7분 → 15.0분, 그 위의 8%,
그리고 `export-baseline.py`가 지키는 픽셀 동일성이 전부 `export.py`와 `verify.py`를 지난다.
포맷 하나 추가하자고 그 위험을 질 이유가 없다.

**공유는 `_entry_pixels` 하나뿐이다** — `entry_pixels`로 공개 승격해 양쪽이 쓴다. 참조가
`export.py` 안 두 곳뿐이고 테스트가 부르지 않으므로 개명은 안전하다.

평탄화 루프를 공용 헬퍼로 뽑는 것은 **일부러 하지 않는다.** `export_psd`는 픽셀 추출과 pytoshop
레이어 생성과 프리뷰 캔버스를 *한 번의 루프*에서 처리한다. 헬퍼로 빼면 픽셀 추출이 두 번 돌고,
그게 바로 방금 최적화한 그 지점이다. 중복되는 것은 `alpha_composite` 여섯 줄뿐이다.

```
export_raster(session, entries, output_path, fmt, overwrite, progress, line_color)
export_raster_split(session, entries, output_path, fmt, ...)   # 레이어당 파일 하나
verify_raster(session, entries, output_path, fmt, line_color)
```

## 5. 합성 규칙 — 여기가 이 작업의 함정이다

문서 크기의 **투명 RGBA 캔버스**에 엔트리를 순서대로 `alpha_composite`한다. 그다음:

- **PNG** → 그대로 RGBA로 저장. 투명 배경, 라인 알파 보존.
- **JPG** → **흰 불투명 캔버스에 합성한 뒤** `convert("RGB")`, `quality=95, subsampling=0`.

**RGBA에 `convert("RGB")`를 바로 걸면 안 된다.** `apply_line_color`는 알파 0인 픽셀까지 RGB를
라인 색으로 채운다(`render.py:113-115`, 의도적 — 리샘플링 때 가장자리 번짐을 막는다). 그 배열의
알파를 그냥 버리면 **전면이 라인 색 단색인 이미지**가 나온다. 기본 라인 색이 `#000000`이므로
결과물은 완전한 검은 사각형이다.

`subsampling=0`(4:4:4)은 라인아트에 필요하다. JPEG 기본 4:2:0은 색 성분을 절반으로 줄여 선
경계에 색 번짐을 만든다.

품질은 **95 고정**이다. 옵션 UI를 늘리지 않으면서 사실상 무손실로 보인다.

## 6. 크기 가드

| 포맷 | 한계 | 처리 |
|---|---|---|
| psd | 30,000 | 기존대로 — "`.psb`로 쓰라" 에러 |
| psb | 300,000 | 기존대로 |
| png | 사실상 없음 | 가드 없음 |
| **jpg** | **65,535** | 새 에러 — png 또는 psb를 안내 |

`_output_version`의 30,000 규칙은 psd/psb 전용이므로 래스터 경로가 타지 않는다.

## 7. 검증 — 반환 모양을 그대로 유지한다

`verify_raster`는 `verify_export`와 **똑같은 dict 모양**을 돌려준다. 그래야 프런트의
`describeVerification`과 `verifyReport` 계열을 손대지 않는다.

- **PNG** — 저장본을 다시 열어 기대 합성 배열과 `np.array_equal`. **완전 일치 검증이 성립한다.**
  무손실 포맷이므로 PSD와 같은 강도의 보장을 준다.
- **JPG** — 파일이 열리고 캔버스 크기가 맞는지까지. `pixelChecked: false`로 **정직하게** 표시한다.
  손실 압축이라 픽셀 일치는 원리적으로 불가능하고, 통과한 척하는 것이 최악이다.

평탄화 1장이므로 `expectedLayers`/`actualLayers`는 1, `layerCountOk`는 참, `layers`는 파일명
한 줄이다. `nameOk`도 이름 개념이 없으므로 항상 참.

이 값들이 안전한 이유는 소비자가 **거짓일 때만** 렌더하기 때문이다 — `verifyReport.ts:29`와
`ExportDialog.tsx:347` 둘 다 `!layerCountOk`일 때만 "레이어 수 불일치"를 띄운다. 참으로 두면
래스터 결과에 레이어 수 이야기가 아예 나오지 않는다. 그것이 맞는 표시다.

레이어 분리 모드는 파일당 한 번씩 검증하며, 기존 split과 같은 집계 구조를 쓴다.

## 8. 레이어 분리와의 관계

기존 "레이어마다 파일 따로 내보내기" 체크박스는 **래스터에서도 그대로 동작한다.**
해제하면 평탄화 1장, 체크하면 레이어당 이미지 한 장. 낱통 추출에 그대로 쓸 수 있다.

`split_output_path`는 이미 확장자를 넘겨받은 경로에서 물려받으므로(`base.suffix or '.psd'`)
포맷이 바뀌어도 그대로 맞는다.

## 9. 윈도우 경로 길이

윈도우 고전 한계는 전체 경로 **260자**다. 넘기려면 `\\?\` 접두사를 쓰거나, Windows 10 1607+의
레지스트리 `LongPathsEnabled` **와** 실행 파일 매니페스트의 `longPathAware`가 **둘 다** 필요하다.
PyInstaller로 동결한 exe에는 그 매니페스트가 기본으로 없다.

길어지는 곳은 둘이다 — `split_output_path`가 레이어 이름을 덧붙일 때(한글 이름이 길면 급격히),
그리고 배치의 출력 폴더 + 원본 stem + 접미사.

**두 겹으로 처리한다.**

1. **한계 해제** — `long_path(path)` 헬퍼를 두고, **파일을 실제로 여는 자리에서만** 부른다:
   `export_psd`의 `open(output_path, "wb")`, 래스터의 `img.save(...)`, 그리고 존재 검사인
   `os.path.exists`. `os.path.abspath`로 정규화하고 구분자를 역슬래시로 통일한 뒤 `\\?\`를
   붙인다 — `\\?\`는 경로 파싱을 건너뛰므로 `/`나 `..`가 남아 있으면 실패한다.
   윈도우가 아니면 인자를 그대로 돌려준다.

   **반환값·진행 이벤트·에러 메시지에 담기는 경로에는 접두사를 넣지 않는다.** `outputPath`는
   UI에 그대로 표시되고 프런트의 덮어쓰기 검사와도 대조되는 문자열이다. 접두사가 새어 나가면
   사용자에게 `\\?\C:\...`가 보이고 프런트 경로와 갈라진다.
2. **가드** — `\\?\`가 260을 걷어내므로 가드가 볼 값은 260이 **아니다.** 접두사를 붙여도 남는
   한계는 둘이다:

   - **파일명 한 조각 255자** — 접두사로 풀리지 않는다. 윈도우·macOS·리눅스 공통이고,
     긴 한글 레이어 이름이 `split_output_path`에서 stem에 덧붙을 때 **실제로 먼저 닿는 한계가
     이것이다.** 그래서 이 검사는 모든 플랫폼에서 돈다.
   - **전체 경로 32,767자** — `\\?\` 이후의 윈도우 한계. 윈도우에서만 본다.

   `ensure_writable_path(path)`를 두고 출력 경로가 확정되는 세 지점(단일/분할/배치)에서
   **쓰기 전에** 부른다. 한계·실제 길이·구체적 해결책(출력 폴더를 짧게 / 접미사를 짧게 /
   분할 끄기)을 담은 에러를 낸다.

분할 모드는 이미 `export_psd_split`이 *한 장도 쓰기 전에* 모든 대상의 존재를 검사한다. 길이
검사도 정확히 그 자리에 붙어야 절반 쓰다 멈추는 상태가 안 생긴다.

**검증 경로**: 이 맥에는 윈도우가 없어 `\\?\`를 로컬에서 확인할 수 없다. `smoke.py`는 Windows
Actions 러너에서 실제로 도므로(`build-engine.ps1`이 부르고 실패 시 throw), 거기에 260자를 넘는
긴 경로 케이스를 추가한다. 그러면 CI가 진짜로 검증한다.

## 10. 프런트엔드

| 파일 | 변경 |
|---|---|
| `src/lib/types.ts` | `Preset.outputFormat?: OutputFormat` — **선택적** |
| `src/lib/presets.ts` | 기본값 `"psd"`, 누락 시 `"psd"`, 모르는 값은 거부 |
| `src/lib/exportFlow.ts` | `outputExtension(srcPath, fmt)` |
| `src/lib/batch.ts` | `planBatchOutputs(paths, outputDir, suffix, fmt)` |
| `src/lib/engine.ts` | `exportPsd`에 `outputFormat` 추가 |
| `src/components/ExportDialog.tsx` | 포맷 선택 + 저장 대화상자 필터를 선택 확장자로 |
| `src/components/PresetDialog.tsx` | 포맷 선택 — **배치가 이걸 쓴다** |

`outputFormat`을 선택적으로 두는 이유는 하위호환이다. 사용자의 기존 `presets.json`에는 이 필드가
없고, `validatePreset`이 누락을 거부하면 저장된 프리셋이 전부 죽는다.

**`embedPreview`는 래스터에서 숨긴다.** PSD의 merged-image 전용 기능이라 png/jpg에서는 의미가
없다. 엔진도 무시한다.

배치와 단일 내보내기는 배관이 다르다 — 배치는 프리셋 객체를 통째로 넘기고(`batch_run`), 단일은
스칼라를 나열해 넘긴다(`export_psd`). 양쪽 다 고쳐야 한다.

## 11. 테스트

가장 중요한 것은 **회귀 테스트 하나**다.

> 라인 색을 켜고 JPG로 내보냈을 때 단색 이미지가 아닐 것.

이것이 이 작업에서 제일 빠지기 쉬운 함정이고, 놓치면 사용자는 새까만 파일을 받는다.
`apply_line_color`가 적용된 엔트리를 JPG로 내보낸 뒤, 결과에 **서로 다른 픽셀 값이 둘 이상**
존재하는지 본다.

그 외:

- PNG 알파 보존 — 배경이 투명(알파 0)이고 라인 가장자리에 중간 알파가 남는지
- JPG 불투명 — 알파 채널이 없고 배경이 흰색인지
- 크기 가드 — jpg 65,535 초과 거부, psd 30,000 규칙이 래스터에 안 걸리는지
- 분할 — 레이어당 파일 하나, 캔버스 크기 보존, 쓰기 전 전량 검사
- 확장자 표 확장 — 프런트 규칙과의 대조 유지
- 프리셋 하위호환 — `outputFormat` 없는 프리셋이 `"psd"`로 읽히는지
- 경로 길이 — 가드가 260자 초과를 잡는지, `smoke.py`의 윈도우 긴 경로 케이스

프런트: `exportFlow.test.ts`, `batch.test.ts`, `presets.test.ts`.

## 12. 범위 밖

- **`.psb`를 명시적 선택지로 올리는 것** — 원본 따름으로 충분하다.
- **JPG 품질 슬라이더** — 95 고정. 필요해지면 그때 프리셋에 더한다.
- **ICC 프로파일 임베드** — `_quantize_like_psd_tools`가 이미 문서 프로파일을 적용해 픽셀을
  만든다. 파일에 프로파일을 심는 것은 별개 주제이고, 지금 요구에 없다.
- **WebP·TIFF** — 요청에 없다.
- **`_UNSAFE_IN_FILENAME`의 끝점(`.`) 처리** — 레이어 이름이 `.`로 끝나면 윈도우가 조용히
  떼어내 검사한 경로와 쓴 경로가 갈릴 수 있다. 기존 결함이고 이 변경이 만들지 않았다.
  **범위 밖으로 확정한다** — 고치면 기존 산출물의 파일명이 바뀌므로 그 자체로 판단이 필요한
  변경이고, 이번 작업에 묻어가서는 안 된다.
