// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod engine;
mod files;
mod project_fs;
mod warm;

use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

/// 도움말 창을 띄운다(이미 있으면 앞으로 가져온다).
///
/// 매뉴얼은 프런트 번들에 함께 실리는 정적 파일(`public/help/index.html` →
/// `help/index.html`)이라 오프라인에서도 열린다. 별도 창으로 띄우는 것은 작업
/// 화면을 가리지 않고 나란히 두고 보기 위해서다.
fn open_help(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("help") {
        let _ = w.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, "help", WebviewUrl::App("help/index.html".into()))
        .title("BW Maker 사용법")
        .inner_size(1100.0, 860.0)
        .build();
}

/// 상단 메뉴. 기본 메뉴를 그대로 두고 **도움말만** 얹는다 — 편집/창 메뉴의
/// 복사·붙여넣기·최소화가 macOS에서 기본 메뉴에 딸려 오므로, 직접 만들면
/// 그것들을 전부 다시 세워야 한다.
fn build_menu(app: &tauri::AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::default(app)?;
    let help = Submenu::with_items(
        app,
        "도움말",
        true,
        &[
            &MenuItem::with_id(app, "help-manual", "BW Maker 사용법", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::about(app, Some("BW Maker 정보"), Some(AboutMetadata::default()))?,
        ],
    )?;
    menu.append(&help)?;
    Ok(menu)
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(engine::EngineState::default())
        .manage(warm::WarmState::default())
        .invoke_handler(tauri::generate_handler![
            greet,
            engine::engine_request,
            engine::read_file_b64,
            engine::restart_engine,
            engine::paths_exist,
            files::collect_psd_files,
            project_fs::project_make_dir,
            project_fs::project_read_text,
            project_fs::project_write_text,
            project_fs::project_write_b64,
            warm::warm_workers_start,
            warm::warm_worker_send,
            warm::warm_workers_stop
        ])
        .setup(|app| {
            // 메뉴는 setup에서 세운다 — 실패해도 앱은 살아야 하므로 로그만 남기고
            // 계속한다(엔진과 달리 메뉴가 없어도 작업은 된다).
            match build_menu(app.handle()) {
                Ok(menu) => {
                    if let Err(e) = app.set_menu(menu) {
                        eprintln!("menu install failed: {e}");
                    }
                }
                Err(e) => eprintln!("menu build failed: {e}"),
            }
            Ok(())
        })
        .on_menu_event(|app, event| {
            if event.id() == "help-manual" {
                open_help(app);
            }
        })
        .on_window_event(|window, event| {
            // **메인 창일 때만** 엔진을 정리한다. 이 핸들러는 모든 창에 걸리므로,
            // 라벨을 안 보면 도움말 창을 닫는 것만으로 엔진과 작업 프로세스가
            // 통째로 죽는다 — 작업 중인 파일이 그 자리서 멈춘다.
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::Destroyed = event {
                engine::kill_engine(window.app_handle());
                warm::kill_warm_workers(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| match event {
            // 엔진은 setup이 아니라 여기서 띄운다. setup에서 실패를 알릴 방법이
            // 없기 때문이다: 에러를 그대로 올리면 Tauri가 앱을 세우지 못하고
            // 패닉으로 끝나는데, 릴리스 윈도우 빌드는 콘솔이 없어(main.rs의
            // windows_subsystem="windows") 그 메시지가 어디에도 안 남는다 —
            // 사용자에게는 "아이콘을 눌러도 아무 일도 없는 앱"이 된다. Ready는
            // 창과 이벤트 루프가 모두 선 뒤라, 실패해도 앱을 살려둔 채 창에 딸린
            // 시트로 이유를 보여주고 사용자가 확인한 다음 끝낼 수 있다.
            tauri::RunEvent::Ready => {
                if let Err(e) = engine::spawn_engine(app_handle) {
                    // 동봉된 사이드카를 못 찾았을 때 찾아본 경로가 그대로 담긴
                    // 에러(engine.rs의 locate_bundled_engine)를 보여준다 —
                    // 설치본에서 무엇이 빠졌는지 알 단서가 이것뿐이다.
                    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
                    eprintln!("engine spawn failed: {e}");
                    let mut dialog = app_handle
                        .dialog()
                        .message(&e)
                        .title("BW Maker — 엔진을 시작할 수 없습니다")
                        .kind(MessageDialogKind::Error);
                    // 부모 창을 붙여 창에 딸린 시트로 띄운다.
                    if let Some(window) = app_handle.get_webview_window("main") {
                        dialog = dialog.parent(&window);
                    }
                    // 엔진 없이 할 수 있는 일이 없으므로 확인 후 종료한다.
                    dialog.show(|_| std::process::exit(1));
                }
            }
            tauri::RunEvent::Exit => {
                engine::kill_engine(app_handle);
                warm::kill_warm_workers(app_handle);
            }
            _ => {}
        });
}
