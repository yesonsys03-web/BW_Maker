use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;

pub struct EngineState {
    proc: Mutex<Option<EngineProc>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    next_id: AtomicU64,
}

struct EngineProc {
    child: Child,
    stdin: ChildStdin,
}

impl Default for EngineState {
    fn default() -> Self {
        Self {
            proc: Mutex::new(None),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: AtomicU64::new(1),
        }
    }
}

fn engine_command() -> Command {
    // dev: 저장소의 engine/ 프로젝트를 uv로 실행. (릴리스 사이드카는 Plan C)
    let engine_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../engine");
    let mut c = Command::new("uv");
    c.args(["run", "python", "-m", "psd_engine"])
        .current_dir(engine_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped());
    c
}

pub fn spawn_engine(app: &AppHandle) -> Result<(), String> {
    let state: State<EngineState> = app.state();
    let mut child = engine_command().spawn().map_err(|e| e.to_string())?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;

    let pending = state.pending.clone();
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            match route_line(&line) {
                Routed::Response(id, v) => {
                    if let Some(tx) = pending.lock().unwrap().remove(&id) {
                        let _ = tx.send(v);
                    }
                }
                Routed::Event(v) => {
                    let _ = app_handle.emit("engine-event", v);
                }
                Routed::Skip => {}
            }
        }
        // EOF: 프로세스 사망. 대기 중 요청 전부 실패 처리 후 알림.
        let mut p = pending.lock().unwrap();
        for (_, tx) in p.drain() {
            let _ = tx.send(json!({"error": {"message": "engine process died", "traceback": ""}}));
        }
        let _ = app_handle.emit("engine-dead", ());
    });

    *state.proc.lock().unwrap() = Some(EngineProc { child, stdin });
    Ok(())
}

/// 실행 중인 엔진 자식 프로세스를 종료한다. 앱 종료 시 호출.
pub fn kill_engine(app: &AppHandle) {
    let state: State<EngineState> = app.state();
    let taken = state.proc.lock().unwrap().take();
    if let Some(mut p) = taken {
        let _ = p.child.kill();
        let _ = p.child.wait();
    }
}

#[tauri::command]
pub async fn engine_request(
    state: State<'_, EngineState>,
    method: String,
    params: Value,
) -> Result<Value, Value> {
    let id = state.next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = oneshot::channel();
    state.pending.lock().unwrap().insert(id, tx);

    {
        let mut guard = state.proc.lock().unwrap();
        let proc = guard
            .as_mut()
            .ok_or_else(|| json!({"message": "engine not running", "traceback": ""}))?;
        let line = json!({"id": id, "method": method, "params": params}).to_string();
        writeln!(proc.stdin, "{line}").and_then(|_| proc.stdin.flush()).map_err(|e| {
            json!({"message": format!("engine write failed: {e}"), "traceback": ""})
        })?;
    }

    let resp = rx
        .await
        .map_err(|_| json!({"message": "engine died before responding", "traceback": ""}))?;
    if let Some(err) = resp.get("error") {
        return Err(err.clone());
    }
    Ok(resp.get("result").cloned().unwrap_or(Value::Null))
}

#[tauri::command]
pub fn read_file_b64(path: String) -> Result<String, String> {
    use base64::Engine as _;
    std::fs::read(&path)
        .map(|b| base64::engine::general_purpose::STANDARD.encode(b))
        .map_err(|e| format!("{path}: {e}"))
}

#[tauri::command]
pub fn restart_engine(app: AppHandle, state: State<'_, EngineState>) -> Result<(), String> {
    if let Some(mut p) = state.proc.lock().unwrap().take() {
        let _ = p.child.kill();
        let _ = p.child.wait();
    }
    spawn_engine(&app)
}

pub enum Routed {
    Response(u64, Value),
    Event(Value),
    Skip,
}

pub fn route_line(line: &str) -> Routed {
    if line.trim().is_empty() {
        return Routed::Skip;
    }
    let Ok(v) = serde_json::from_str::<Value>(line) else { return Routed::Skip };
    match v.get("id").and_then(Value::as_u64) {
        Some(id) => Routed::Response(id, v),
        None => Routed::Event(v),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn routes_response_event_skip() {
        assert!(matches!(route_line(r#"{"id":3,"result":{}}"#), Routed::Response(3, _)));
        assert!(matches!(route_line(r#"{"event":"progress","stage":"compose"}"#), Routed::Event(_)));
        assert!(matches!(route_line(r#"{"id":null,"error":{"message":"x"}}"#), Routed::Event(_)));
        assert!(matches!(route_line(""), Routed::Skip));
        assert!(matches!(route_line("not json"), Routed::Skip));
    }
}
