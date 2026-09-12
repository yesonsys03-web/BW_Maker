//! `.bwproj` 프로젝트 폴더에 대한 파일 I/O.
//!
//! **plugin-fs를 쓰지 않는 이유.** 이 앱의 fs capability는
//! `capabilities/default.json`에서 `fs:default` + `fs:allow-appdata-write-recursive`
//! 둘뿐이다. 즉 AppData 밖의 경로는 전부 `PathForbidden`으로 거절된다. 프로젝트
//! 폴더는 사용자가 저장 대화상자에서 고르는 곳이므로 **항상 AppData 밖**이다.
//! plugin-fs로 쓰면 실제 앱에서 100% 실패한다.
//!
//! **다이얼로그가 스코프를 넓혀주지 않느냐 — 넓혀주긴 하지만 모자란다.**
//! tauri-plugin-dialog의 `save`는 사용자가 고른 **그 경로 하나만** `allow_file`로
//! 열어준다. 그래서 `dir/project.json`도, `dir/previews/*.png`도 여전히 금지다.
//! `open({directory: true})`는 `allow_directory(path, recursive)`라 `recursive`를
//! 주지 않으면 직계 자식까지만 열린다 — 손자인 `previews/xxx.png`가 또 금지다.
//! 다이얼로그 스코프에 기대는 설계는 호출부가 옵션 하나를 빠뜨리는 순간 조용히
//! 깨지므로, 애초에 기대지 않는다.
//!
//! **그래서 capability를 넓히는 대신 Rust로 우회한다.** 저장소가 같은 이유로
//! 이미 세 번 내린 결정과 같다(`engine::paths_exist`, `files::collect_psd_files`).
//!
//! **이름이 `project_*`인 이유.** 이 커맨드들은 capability 스코프 밖의 임의 경로에
//! 쓴다. 용도를 이름에 박아 두어야 "파일 쓰는 커맨드가 있네" 하고 아무 데나
//! 재사용되지 않는다. 새 용도가 생기면 그 용도의 이름으로 새로 만들 것.
//!
//! 읽기 전용 동작은 여기에 **중복해서 만들지 않는다**: PNG 읽기는
//! `engine::read_file_b64`, 존재 확인은 `engine::paths_exist`가 이미 한다.

/// 중간 경로까지 만든다(`create_dir_all`). 이미 있으면 성공으로 본다.
#[tauri::command]
pub fn project_make_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| format!("{path}: {e}"))
}

/// UTF-8 텍스트 파일을 통째로 읽는다. `project.json`을 읽는 데 쓴다.
#[tauri::command]
pub fn project_read_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))
}

/// UTF-8 텍스트 파일을 통째로 쓴다(있으면 덮어쓴다).
#[tauri::command]
pub fn project_write_text(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("{path}: {e}"))
}

/// base64를 디코드해 바이너리 파일로 쓴다. 미리보기 PNG를 쓰는 데 쓴다.
///
/// 디코드 실패는 그대로 에러로 올린다 — 조용히 빈 파일이나 잘린 파일을 남기면
/// 다음 열기에서 깨진 PNG로 나타나고, 그때는 원인을 찾을 단서가 없다.
#[tauri::command]
pub fn project_write_b64(path: String, b64: String) -> Result<(), String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| format!("{path}: base64 decode failed: {e}"))?;
    std::fs::write(&path, bytes).map_err(|e| format!("{path}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 테스트마다 겹치지 않는 임시 폴더. `paths_exist` 테스트와 같은 방식이다.
    fn tmp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir()
            .join(format!("bw_maker_project_fs_{}_{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn make_dir_creates_missing_parents_and_text_round_trips() {
        let root = tmp_dir("round_trip");
        // 프로젝트 폴더와 previews/를 한 번에 만드는 상황: 중간 단계가 없어도
        // 만들어져야 첫 저장이 "그런 디렉터리 없음"으로 죽지 않는다.
        let nested = root.join("a").join("b").join("c");
        project_make_dir(nested.to_string_lossy().to_string()).unwrap();
        assert!(nested.is_dir());

        let file = nested.join("project.json");
        let path = file.to_string_lossy().to_string();
        project_write_text(path.clone(), "{\"version\": 1}".to_string()).unwrap();

        assert_eq!(project_read_text(path).unwrap(), "{\"version\": 1}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn make_dir_on_an_existing_dir_succeeds() {
        let root = tmp_dir("existing");
        // 두 번째 저장은 이미 있는 폴더에 쓴다. 여기서 에러가 나면 저장이 한 번만
        // 되는 기능이 된다.
        project_make_dir(root.to_string_lossy().to_string()).unwrap();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn write_b64_writes_exactly_the_decoded_bytes() {
        use base64::Engine as _;
        let root = tmp_dir("write_b64");
        // PNG 시그니처 + 임의 바이트. 0x00과 0xFF가 섞여 있어야 텍스트 경로로
        // 새는 구현(UTF-8 변환 등)이 드러난다.
        let bytes: Vec<u8> = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x7f];
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);

        let file = root.join("0011223344556677.png");
        project_write_b64(file.to_string_lossy().to_string(), b64).unwrap();

        assert_eq!(std::fs::read(&file).unwrap(), bytes);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn write_b64_rejects_bad_base64_without_creating_the_file() {
        let root = tmp_dir("bad_b64");
        let file = root.join("bad.png");

        let err = project_write_b64(file.to_string_lossy().to_string(), "not!base64".to_string())
            .expect_err("invalid base64 must not be written");

        assert!(err.contains("base64 decode failed"), "unexpected error: {err}");
        // 조용히 빈 파일을 남기면 다음 열기에서 깨진 PNG가 된다.
        assert!(!file.exists(), "no file may be left behind");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn read_text_names_the_path_it_could_not_read() {
        let root = tmp_dir("missing_read");
        let missing = root.join("project.json");

        let err = project_read_text(missing.to_string_lossy().to_string())
            .expect_err("missing file must be an error");

        assert!(err.contains("project.json"), "unexpected error: {err}");
        let _ = std::fs::remove_dir_all(&root);
    }
}
