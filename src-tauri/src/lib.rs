// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod engine;
mod files;

use tauri::Manager;

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
        .invoke_handler(tauri::generate_handler![
            greet,
            engine::engine_request,
            engine::read_file_b64,
            engine::restart_engine,
            engine::paths_exist,
            files::collect_psd_files
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                engine::kill_engine(window.app_handle());
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
            tauri::RunEvent::Exit => engine::kill_engine(app_handle),
            _ => {}
        });
}
