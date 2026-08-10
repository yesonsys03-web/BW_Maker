import { join } from "@tauri-apps/api/path";
import { exists, mkdir, readFile, readTextFile, writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { parseProject, serializeProject, type ProjectFile } from "./project";

const PROJECT_JSON = "project.json";
const PREVIEWS_DIR = "previews";
// previewFileName이 만드는 형식: 16자 16진소문자 + ".png"
// 원본 코드는 src/lib/project.ts의 previewFileName 참고
const PREVIEW_HASH_REGEX = /^[0-9a-f]{16}\.png$/;

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToDataUrl(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]);
  return `data:image/png;base64,${btoa(bin)}`;
}

/**
 * 프로젝트 폴더를 통째로 쓴다. `previews`는 previewFile 이름 → data URL.
 *
 * 폴더인 이유는 설계 2.2절에 있다 — 필요한 그림만 읽기 위해서다. 그림을 JSON에
 * base64로 실으면 33% 커지고 그 전부가 파싱 대상이 된다.
 *
 * 중요: 미리보기 이름은 반드시 해시여야 한다. 파일 이름에 기밀 정보(납품 PSD 경로)가
 * 남으면 안 되므로, 이 모듈에서 마지막으로 검사할 수 있는 곳이다. 호출부의 버그로
 * entry.path 같은 값이 넘어가면 이 검사가 적잖아 낸다.
 */
export async function saveProjectTo(
  dir: string,
  project: ProjectFile,
  previews: Map<string, string>
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const previewDir = await join(dir, PREVIEWS_DIR);
  await mkdir(previewDir, { recursive: true });
  await writeTextFile(await join(dir, PROJECT_JSON), serializeProject(project));

  // 미리보기 이름이 모두 해시 형식인지 검사
  const invalidNames: string[] = [];
  for (const name of previews.keys()) {
    if (!PREVIEW_HASH_REGEX.test(name)) {
      invalidNames.push(name);
    }
  }
  if (invalidNames.length > 0) {
    throw new Error(`previews: ${invalidNames.length}개 파일의 이름이 해시가 아닙니다(16자 16진소문자.png 형식이어야 함).`);
  }

  for (const [name, dataUrl] of previews) {
    await writeFile(await join(previewDir, name), dataUrlToBytes(dataUrl));
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
  const project = parseProject(await readTextFile(await join(dir, PROJECT_JSON)));
  const previewDir = await join(dir, PREVIEWS_DIR);
  const previews = new Map<string, string>();
  for (const entry of project.files) {
    if (!entry.previewFile) continue;
    const p = await join(previewDir, entry.previewFile);
    if (!(await exists(p))) continue;
    previews.set(entry.previewFile, bytesToDataUrl(await readFile(p)));
  }
  return { project, previews };
}
