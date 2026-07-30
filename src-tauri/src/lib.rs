// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod engine;

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
        .setup(|app| {
            engine::spawn_engine(&app.handle().clone())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            engine::engine_request,
            engine::read_file_b64,
            engine::restart_engine,
            engine::paths_exist
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                engine::kill_engine(window.app_handle());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                engine::kill_engine(app_handle);
            }
        });
}
