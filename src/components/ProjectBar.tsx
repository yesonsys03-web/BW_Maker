/**
 * 지금 도는 프로젝트 작업. 불리언 하나로 두면 라벨이 거짓말을 한다 — 열기가
 * 도는 동안 저장 버튼이 "저장 중..."이라고 말하게 된다. 어느 쪽인지까지 받아야
 * 화면이 사실만 말한다.
 */
export type ProjectBusy = "save" | "open" | null;

interface ProjectBarProps {
  /** 열려 있는 프로젝트 폴더 경로. 없으면 아직 저장한 적 없다. */
  projectDir: string | null;
  onOpen: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  /**
   * 열기나 저장이 도는 중. 저장은 두 번 눌러 같은 폴더에 겹쳐 쓰는 것을 막고,
   * 열기는 복원 둘이 경합하는 것을 막는다 — 열기는 파일마다 IPC를 두 번씩
   * 순차로 돌기 때문에 표시가 없으면 끝난 줄 알고 다시 누르게 된다.
   */
  busy: ProjectBusy;
}

function folderName(dir: string): string {
  const parts = dir.split(/[\\/]/);
  return parts[parts.length - 1] || dir;
}

/**
 * 프로젝트 열기·저장. 저장은 수동이고, 저장하지 않으면 앱은 프로젝트가 없던
 * 때와 똑같이 동작한다 — 아티스트가 그렇게 정했다(설계 6절).
 *
 * 이름은 폴더명만 보인다. 전체 경로는 title에만 둔다 — 납품 폴더 경로가 화면에
 * 늘 떠 있을 이유가 없고, 툴바 폭도 그만큼 없다.
 */
export function ProjectBar({ projectDir, onOpen, onSave, onSaveAs, busy }: ProjectBarProps) {
  return (
    <div className="project-bar">
      <span className="project-bar-name" title={projectDir ?? undefined}>
        {projectDir ? folderName(projectDir) : "저장 안 된 작업"}
      </span>
      {/* 버튼 이름에 "프로젝트"를 붙여 둔다. 바로 윗줄 PresetBar에도 "저장"과
          "다른 이름으로 저장..."이 있어서, 짧게 쓰면 화면에 같은 이름의 버튼이
          둘씩 뜬다 — 프리셋을 덮어쓸 생각으로 프로젝트를 저장하게 된다. */}
      <button type="button" onClick={onOpen} disabled={busy !== null}>
        프로젝트 열기...
      </button>
      {/* 라벨은 **저장이 돌 때만** 바뀐다. 열기 중에도 "저장 중..."이 뜨면 화면이
          하지 않은 일을 했다고 말하는 셈이다. */}
      <button type="button" onClick={onSave} disabled={busy !== null}>
        {busy === "save" ? "저장 중..." : "프로젝트 저장"}
      </button>
      <button type="button" onClick={onSaveAs} disabled={busy !== null}>
        프로젝트 다른 이름으로 저장...
      </button>
    </div>
  );
}
