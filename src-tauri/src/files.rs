use std::path::{Path, PathBuf};

use serde::Serialize;

/// 한 번의 스캔에서 담을 수 있는 지원 문서 상한. 아티스트가 홈 디렉터리나
/// 드라이브 루트를 잘못 고르면 재귀 순회가 창을 붙잡은 채 끝나지 않는다.
const MAX_FILES: usize = 5000;

/// 재귀 깊이 상한. 디렉터리로 걸린 심볼릭 링크는 따라가지 않으므로 순환은
/// 없지만, 병적으로 깊은 트리에 대한 최후의 방어선으로 둔다.
const MAX_DEPTH: usize = 32;

/// collect_psd_files의 결과. 찾은 파일뿐 아니라 "무엇을 못 담았는지"도 같이
/// 돌려준다 — 잘린 목록을 조용히 넘기면 화면에서는 그게 폴더의 전부로 읽힌다.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PsdScan {
    /// 사전순으로 정렬·중복 제거된 PSD/PSB/PNG/JPEG 절대 경로.
    pub files: Vec<String>,
    /// MAX_FILES 또는 MAX_DEPTH에 걸려 순회를 도중에 접었는지.
    pub truncated: bool,
    /// 열 수 없어(권한 등) 건너뛴 하위 폴더 수. 그런 폴더 하나 때문에 스캔
    /// 전체를 실패시키는 것보다 건너뛰고 몇 개였는지 알리는 편이 낫다.
    pub skipped_dirs: usize,
}

fn is_supported_art_file(path: &Path) -> bool {
    path.extension().is_some_and(|ext| {
        ["psd", "psb", "png", "jpg", "jpeg"]
            .iter()
            .any(|supported| ext.eq_ignore_ascii_case(supported))
    })
}

#[derive(Default)]
struct ScanState {
    files: Vec<PathBuf>,
    truncated: bool,
    skipped_dirs: usize,
}

impl ScanState {
    fn full(&self) -> bool {
        self.files.len() >= MAX_FILES
    }

    fn push(&mut self, path: PathBuf) {
        if self.full() {
            self.truncated = true;
            return;
        }
        self.files.push(path);
    }
}

/// 링크는 파일로 판명될 때만 담는다. 디렉터리로 걸린 링크를 따라가면 트리가
/// 아니라 그래프를 도는 셈이 되어 같은 파일을 몇 번이고 다시 만난다.
fn is_supported_symlink_target(path: &Path) -> bool {
    is_supported_art_file(path) && std::fs::metadata(path).is_ok_and(|m| m.is_file())
}

fn walk(dir: &Path, depth: usize, scan: &mut ScanState) {
    if scan.full() {
        scan.truncated = true;
        return;
    }
    if depth >= MAX_DEPTH {
        scan.truncated = true;
        return;
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => {
            scan.skipped_dirs += 1;
            return;
        }
    };

    // 하위 폴더는 모아뒀다가 나중에 내려간다: 고른 폴더 바로 아래 파일들이
    // 깊은 가지에 상한을 다 뺏기기 전에 먼저 목록에 들어가도록.
    let mut subdirs = Vec::new();
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if file_type.is_dir() {
            subdirs.push(path);
        } else if file_type.is_symlink() {
            if is_supported_symlink_target(&path) {
                scan.push(path);
            }
        } else if is_supported_art_file(&path) {
            scan.push(path);
        }
    }

    for subdir in subdirs {
        walk(&subdir, depth + 1, scan);
    }
}

/// 섞여 들어온 경로 목록을 지원 문서 목록으로 펼친다. 폴더는 하위까지
/// 재귀적으로 훑고, PSD/PSB/PNG/JPEG는 그대로 통과시키며, 나머지는 버린다. 폴더
/// 추가 버튼과 드래그&드롭이 같은 함수를 쓰므로 "폴더 하나", "파일 여러 개",
/// "폴더와 파일을 섞어 떨어뜨린 경우"가 모두 같은 규칙으로 처리된다.
///
/// plugin-fs의 read_dir이 아니라 Rust 커맨드인 이유는 paths_exist와 같다:
/// 작업 폴더는 AppData 밖에 있어 plugin-fs의 capability 스코프에 걸린다.
#[tauri::command]
pub fn collect_psd_files(paths: Vec<String>) -> Result<PsdScan, String> {
    let mut scan = ScanState::default();
    for raw in &paths {
        let path = PathBuf::from(raw);
        // 사용자가 직접 고르거나 떨어뜨린 경로이므로 여기서는 링크를 따라간다.
        let meta = std::fs::metadata(&path).map_err(|e| format!("{raw}: {e}"))?;
        if meta.is_dir() {
            walk(&path, 0, &mut scan);
        } else if is_supported_art_file(&path) {
            scan.push(path);
        }
    }

    scan.files.sort();
    scan.files.dedup();
    Ok(PsdScan {
        files: scan
            .files
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
        truncated: scan.truncated,
        skipped_dirs: scan.skipped_dirs,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            // 태그는 테스트마다 달라 같은 프로세스 안에서 겹치지 않는다.
            let path = std::env::temp_dir()
                .join(format!("bw_maker_files_{}_{tag}", std::process::id()));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).unwrap();
            TempDir(path)
        }

        fn touch(&self, rel: &str) -> PathBuf {
            let path = self.0.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, b"x").unwrap();
            path
        }

        fn str(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn names(scan: &PsdScan, root: &TempDir) -> Vec<String> {
        let prefix = format!("{}{}", root.str(), std::path::MAIN_SEPARATOR);
        scan.files
            .iter()
            .map(|f| f.strip_prefix(&prefix).unwrap_or(f).replace('\\', "/"))
            .collect()
    }

    #[test]
    fn collects_layered_and_flattened_art_recursively() {
        let dir = TempDir::new("recursive");
        dir.touch("a.psd");
        dir.touch("notes.txt");
        dir.touch("cuts/b.psd");
        dir.touch("cuts/deep/c.PSD");
        dir.touch("cuts/deep/thumb.png");

        let scan = collect_psd_files(vec![dir.str()]).unwrap();

        assert_eq!(names(&scan, &dir), vec![
            "a.psd", "cuts/b.psd", "cuts/deep/c.PSD", "cuts/deep/thumb.png",
        ]);
        assert!(!scan.truncated);
        assert_eq!(scan.skipped_dirs, 0);
    }

    /// .psb(Large Document Format)는 .psd와 같은 규칙으로 폴더 순회에 잡혀야
    /// 한다 — 대소문자 무관, 관계없는 확장자는 여전히 걸러진다.
    #[test]
    fn collects_psb_recursively_and_skips_other_files() {
        let dir = TempDir::new("recursive_psb");
        dir.touch("a.psb");
        dir.touch("notes.txt");
        dir.touch("cuts/b.psb");
        dir.touch("cuts/deep/c.PSB");
        dir.touch("cuts/deep/thumb.png");

        let scan = collect_psd_files(vec![dir.str()]).unwrap();

        assert_eq!(names(&scan, &dir), vec![
            "a.psb", "cuts/b.psb", "cuts/deep/c.PSB", "cuts/deep/thumb.png",
        ]);
        assert!(!scan.truncated);
        assert_eq!(scan.skipped_dirs, 0);
    }

    #[test]
    fn passes_through_psd_files_and_drops_non_psd_paths() {
        let dir = TempDir::new("passthrough");
        let psd = dir.touch("a.psd");
        let txt = dir.touch("b.txt");

        let scan = collect_psd_files(vec![
            psd.to_string_lossy().into_owned(),
            txt.to_string_lossy().into_owned(),
        ])
        .unwrap();

        assert_eq!(names(&scan, &dir), vec!["a.psd"]);
    }

    #[test]
    fn passes_through_psb_files_directly() {
        let dir = TempDir::new("passthrough_psb");
        let psb = dir.touch("a.psb");
        let txt = dir.touch("b.txt");

        let scan = collect_psd_files(vec![
            psb.to_string_lossy().into_owned(),
            txt.to_string_lossy().into_owned(),
        ])
        .unwrap();

        assert_eq!(names(&scan, &dir), vec!["a.psb"]);
    }

    #[test]
    fn passes_through_flattened_images_directly() {
        let dir = TempDir::new("passthrough_images");
        let png = dir.touch("a.PNG");
        let jpeg = dir.touch("b.jpeg");

        let scan = collect_psd_files(vec![
            png.to_string_lossy().into_owned(),
            jpeg.to_string_lossy().into_owned(),
        ])
        .unwrap();

        assert_eq!(names(&scan, &dir), vec!["a.PNG", "b.jpeg"]);
    }

    #[test]
    fn deduplicates_a_folder_and_a_file_inside_it() {
        let dir = TempDir::new("dedupe");
        let psd = dir.touch("a.psd");

        let scan = collect_psd_files(vec![dir.str(), psd.to_string_lossy().into_owned()]).unwrap();

        assert_eq!(names(&scan, &dir), vec!["a.psd"]);
    }

    #[test]
    fn errors_on_a_path_that_does_not_exist() {
        let dir = TempDir::new("missing");
        let missing = dir.0.join("nope.psd");

        let err = collect_psd_files(vec![missing.to_string_lossy().into_owned()]).unwrap_err();

        assert!(err.contains("nope.psd"), "{err}");
    }

    #[test]
    fn reports_truncation_past_the_file_cap() {
        let dir = TempDir::new("cap");
        for i in 0..(MAX_FILES + 5) {
            dir.touch(&format!("{i:05}.psd"));
        }

        let scan = collect_psd_files(vec![dir.str()]).unwrap();

        assert_eq!(scan.files.len(), MAX_FILES);
        assert!(scan.truncated);
    }

    #[test]
    fn reports_truncation_past_the_depth_cap() {
        let dir = TempDir::new("depth");
        let mut rel = String::new();
        for _ in 0..(MAX_DEPTH + 1) {
            rel.push_str("d/");
        }
        dir.touch(&format!("{rel}deep.psd"));
        dir.touch("shallow.psd");

        let scan = collect_psd_files(vec![dir.str()]).unwrap();

        assert_eq!(names(&scan, &dir), vec!["shallow.psd"]);
        assert!(scan.truncated);
    }

    /// UI가 읽는 필드 이름을 고정한다. serde의 camelCase 변환이 어긋나면
    /// TypeScript 쪽에서는 예외가 아니라 undefined로 조용히 나타나 — 잘린
    /// 스캔이 "정상"으로 보인다.
    #[test]
    fn serializes_with_the_field_names_the_ui_reads() {
        let scan = PsdScan {
            files: vec!["/a.psd".into()],
            truncated: true,
            skipped_dirs: 2,
        };

        let json = serde_json::to_value(&scan).unwrap();

        assert_eq!(
            json,
            serde_json::json!({"files": ["/a.psd"], "truncated": true, "skippedDirs": 2})
        );
    }

    #[cfg(unix)]
    #[test]
    fn follows_symlinked_files_but_not_symlinked_directories() {
        let dir = TempDir::new("symlink");
        let real = dir.touch("real/target.psd");
        std::os::unix::fs::symlink(&real, dir.0.join("link.psd")).unwrap();
        // 자기 자신을 가리키는 폴더 링크: 따라가면 끝나지 않는다.
        std::os::unix::fs::symlink(&dir.0, dir.0.join("loop")).unwrap();

        let scan = collect_psd_files(vec![dir.str()]).unwrap();

        assert_eq!(names(&scan, &dir), vec!["link.psd", "real/target.psd"]);
        assert!(!scan.truncated);
    }
}
