import { invoke } from "@tauri-apps/api/core";
import { join } from "@tauri-apps/api/path";
import { loadPngDataUrl, pathsExist } from "./engine";
import { parseProject, serializeProject, type ProjectFile } from "./project";

const PROJECT_JSON = "project.json";
const PREVIEWS_DIR = "previews";
// previewFileName이 만드는 형식: 16자 16진소문자 + ".png"
// 원본 코드는 src/lib/project.ts의 previewFileName 참고
const PREVIEW_HASH_REGEX = /^[0-9a-f]{16}\.png$/;

/**
 * 디스크 접근은 전부 Rust 커맨드(`src-tauri/src/project_fs.rs`)를 거친다.
 * plugin-fs가 아닌 이유는 그 파일 맨 위에 있다 — 요약하면 이 앱의 fs capability는
 * AppData 안으로 묶여 있는데 프로젝트 폴더는 사용자가 고르는 곳이라 항상 그 밖이고,
 * 저장 다이얼로그가 열어주는 스코프는 고른 경로 **하나뿐**이라 `project.json`과
 * `previews/*.png`를 덮지 못한다. presets.ts가 plugin-fs를 쓰는 것은 거기가
 * appDataDir 안이기 때문이다 — 같은 규칙이 아니다.
 */
async function makeDir(path: string): Promise<void> {
  await invoke("project_make_dir", { path });
}

/** data URL(`data:image/png;base64,...`)에서 base64 본문만 떼어낸다. */
function dataUrlToBase64(dataUrl: string): string {
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

/**
 * 프로젝트 폴더를 통째로 쓴다. `previews`는 previewFile 이름 → data URL.
 *
 * 폴더인 이유는 설계 2.2절에 있다 — 필요한 그림만 읽기 위해서다. 그림을 JSON에
 * base64로 실으면 33% 커지고 그 전부가 파싱 대상이 된다.
 *
 * 중요: 미리보기 이름은 반드시 해시여야 한다. 파일 이름에 기밀 정보(납품 PSD 경로)가
 * 남으면 안 되므로, 이 모듈에서 마지막으로 검사할 수 있는 곳이다. 호출부의 버그로
 * entry.path 같은 값이 넘어가면 이 검사가 잡아낸다.
 */
export async function saveProjectTo(
  dir: string,
  project: ProjectFile,
  previews: Map<string, string>
): Promise<void> {
  // 미리보기 이름이 모두 해시 형식인지 검사. **첫 쓰기보다 먼저** 돈다 —
  // 뒤에 두면 거절된 저장이 project.json만 갈아치운 반쪽짜리 .bwproj를 남긴다.
  // 그 JSON은 이 폴더의 유일본이라, 거절해놓고 폴더를 망가뜨리는 셈이 된다.
  const invalidNames: string[] = [];
  for (const name of previews.keys()) {
    if (!PREVIEW_HASH_REGEX.test(name)) {
      invalidNames.push(name);
    }
  }
  if (invalidNames.length > 0) {
    throw new Error(`previews: ${invalidNames.length}개 파일의 이름이 해시가 아닙니다(16자 16진소문자.png 형식이어야 함).`);
  }

  await makeDir(dir);
  const previewDir = await join(dir, PREVIEWS_DIR);
  // 이 줄이 없으면 첫 저장이 "그런 디렉터리 없음"으로 죽는다. previews/를 미리
  // 만드는 것을 확인하는 단언이 projectFs.test.ts에 있다.
  await makeDir(previewDir);
  await invoke("project_write_text", {
    path: await join(dir, PROJECT_JSON),
    contents: serializeProject(project),
  });

  for (const [name, dataUrl] of previews) {
    await invoke("project_write_b64", {
      path: await join(previewDir, name),
      b64: dataUrlToBase64(dataUrl),
    });
  }
}

/**
 * 프로젝트 폴더를 읽는다. project.json이 깨져 있으면 던진다(호출부가
 * ErrorPanel로 보낸다) — 조용히 빈 프로젝트로 여는 것은 작업을 잃는 것과 같다.
 *
 * 반면 **PNG 하나가 없는 것은 던지지 않는다.** 그림은 다시 만들 수 있고 손으로
 * 한 판단은 못 만든다. 그림 없는 파일은 화면이 눌렀을 때 새로 그린다.
 */
export async function loadProjectFrom(
  dir: string
): Promise<{ project: ProjectFile; previews: Map<string, string> }> {
  const json = (await invoke("project_read_text", {
    path: await join(dir, PROJECT_JSON),
  })) as string;
  const project = parseProject(json);
  const previewDir = await join(dir, PREVIEWS_DIR);
  const previews = new Map<string, string>();
  for (const entry of project.files) {
    if (!entry.previewFile) continue;
    const p = await join(previewDir, entry.previewFile);
    // 존재 확인과 PNG 읽기는 이미 있는 커맨드를 그대로 쓴다(중복 구현 금지).
    // loadPngDataUrl이 `data:image/png;base64,`까지 붙여서 주므로 예전의
    // bytesToDataUrl은 필요 없어졌다.
    const [found] = await pathsExist([p]);
    if (!found) continue;
    previews.set(entry.previewFile, await loadPngDataUrl(p));
  }
  return { project, previews };
}
