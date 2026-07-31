use std::collections::{HashMap, VecDeque};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;

/// engine-dead 페이로드/버퍼에 보관하는 stderr 라인 수 상한. 패키지된 빌드는
/// 터미널이 없어 Python 레벨 크래시(임포트 실패, MemoryError 등)의 traceback을
/// 볼 방법이 없으므로, 죽었을 때 이걸 그대로 실어 보낸다.
const STDERR_TAIL_LINES: usize = 50;

pub struct EngineState {
    proc: Mutex<Option<EngineProc>>,
    pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    next_id: AtomicU64,
    /// 엔진 프로세스 세대 번호. spawn_engine 호출마다 증가한다. reader 스레드는
    /// 시작 시점의 값을 캡처해두고, EOF를 감지했을 때 이 값과 비교해 자신이
    /// 여전히 "현재" 프로세스를 담당하는지 판단한다 (restart_engine 레이스 가드).
    epoch: Arc<AtomicU64>,
    /// 현재 엔진 프로세스 stderr의 마지막 STDERR_TAIL_LINES줄.
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
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
            epoch: Arc::new(AtomicU64::new(0)),
            stderr_tail: Arc::new(Mutex::new(VecDeque::new())),
        }
    }
}

fn engine_command() -> Command {
    // dev: 저장소의 engine/ 프로젝트를 uv로 실행. (릴리스 사이드카는 Plan C)
    let engine_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../engine");
    let mut c = Command::new("uv");
    c.args(["run", "python", "-m", "psd_engine"])
        .current_dir(engine_dir)
        // 요청 JSON은 UTF-8 원문으로 나간다(serde_json은 non-ASCII를 escape하지
        // 않는다). 파이썬이 stdio를 로케일 인코딩으로 열면 한글 윈도우(cp949)에서
        // 한글 경로가 든 첫 요청에 엔진이 UnicodeDecodeError로 죽는다. 엔진도
        // 자기 쪽에서 UTF-8로 reconfigure하지만(psd_engine/rpc.py), 인터프리터가
        // 처음부터 UTF-8로 뜨는 편이 낫다.
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // 윈도우에서 GUI 앱이 자식 프로세스를 띄우면 그 자식이 콘솔 창을 갖는다.
    // 앱 자체는 windows_subsystem="windows"라 콘솔이 없으므로, 엔진을 띄울 때와
    // 재시작할 때마다 검은 창이 뜨는 것으로 보인다.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

pub fn spawn_engine(app: &AppHandle) -> Result<(), String> {
    let state: State<EngineState> = app.state();
    let mut child = engine_command().spawn().map_err(|e| e.to_string())?;
    let stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;

    state.stderr_tail.lock().unwrap().clear();

    // 이 reader가 담당하는 세대를 기록한다. restart_engine이 그 사이 epoch를 다시
    // 올렸다면(=이 reader는 이미 교체된 이전 세대) EOF 시점에 drain을 건너뛴다.
    let my_epoch = state.epoch.fetch_add(1, Ordering::SeqCst) + 1;
    let epoch = state.epoch.clone();
    let pending = state.pending.clone();
    let app_handle = app.clone();
    let stderr_tail = state.stderr_tail.clone();

    // stderr reader: 패키지된 빌드에는 터미널이 없어 Python 크래시의 traceback을
    // 볼 방법이 없으므로, 마지막 STDERR_TAIL_LINES줄을 보관해뒀다가 engine-dead
    // 이벤트에 실어 보낸다.
    {
        let stderr_tail = stderr_tail.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                let mut buf = stderr_tail.lock().unwrap();
                buf.push_back(line);
                while buf.len() > STDERR_TAIL_LINES {
                    buf.pop_front();
                }
            }
        });
    }

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
        // EOF: 이 reader가 담당하던 프로세스가 사망했다. 여전히 현재 세대라면 대기
        // 중 요청 전부 실패 처리 후 알림. restart_engine이 이미 새 세대를 spawn해둔
        // 상태(=이 reader는 stale)라면 새 프로세스의 pending을 건드리지 않는다.
        if should_drain_on_eof(epoch.load(Ordering::SeqCst), my_epoch) {
            fail_all_pending(&pending, "engine process died");
            let tail: Vec<String> = stderr_tail.lock().unwrap().iter().cloned().collect();
            let _ = app_handle.emit("engine-dead", json!({ "stderrTail": tail }));
        }
    });

    *state.proc.lock().unwrap() = Some(EngineProc { child, stdin });
    Ok(())
}

/// stdin을 먼저 닫아 엔진의 `for line in stdin` 루프가 EOF로 정상 종료되도록
/// 유도한다 — 그래야 Python 쪽 atexit(임시 렌더 디렉터리 정리)가 실행된다.
/// 곧바로 종료하지 않으면(데드락/행) SIGKILL로 fallback한다.
fn terminate_engine_proc(mut p: EngineProc) {
    drop(p.stdin);
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match p.child.try_wait() {
            Ok(Some(_)) => return, // 정상 종료
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = p.child.kill();
                    let _ = p.child.wait();
                    return;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => return,
        }
    }
}

/// 실행 중인 엔진 자식 프로세스를 종료한다. 앱 종료 시 호출.
pub fn kill_engine(app: &AppHandle) {
    let state: State<EngineState> = app.state();
    let taken = state.proc.lock().unwrap().take();
    if let Some(p) = taken {
        terminate_engine_proc(p);
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

/// Filesystem existence check for arbitrary paths, bypassing plugin-fs's
/// AppData-scoped capability. Batch export plans its output next to the
/// source file or under a user-chosen directory — both routinely outside
/// AppData — so plugin-fs's `exists` would reject them with PathForbidden.
#[tauri::command]
pub fn paths_exist(paths: Vec<String>) -> Vec<bool> {
    paths
        .iter()
        .map(|p| std::path::Path::new(p).exists())
        .collect()
}

#[tauri::command]
pub fn restart_engine(app: AppHandle, state: State<'_, EngineState>) -> Result<(), String> {
    if let Some(p) = state.proc.lock().unwrap().take() {
        terminate_engine_proc(p);
    }
    // 이전 엔진에 대해 대기 중이던 요청을 즉시 실패 처리한다. 이렇게 하지 않으면
    // 옛 reader 스레드의 EOF 감지(OS 타이밍 의존적) 또는 epoch 가드로 인한 drain
    // 스킵 때문에 해당 oneshot들이 응답을 영영 못 받고 방치될 수 있다.
    fail_all_pending(&state.pending, "engine restarted");
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

/// EOF를 감지한 reader 스레드가, 자신이 시작될 때 캡처해둔 세대(my_epoch)가
/// EngineState의 현재 세대(current_epoch)와 여전히 같은지 판단한다. 다르다면
/// restart_engine이 이미 새 프로세스를 spawn한 뒤라는 뜻이므로(이 reader는 stale)
/// false를 반환해 새 프로세스의 pending을 drain하지 않도록 막는다.
fn should_drain_on_eof(current_epoch: u64, my_epoch: u64) -> bool {
    current_epoch == my_epoch
}

/// pending에 남아있는 모든 요청을 주어진 메시지로 즉시 실패 처리하고 비운다.
fn fail_all_pending(pending: &Mutex<HashMap<u64, oneshot::Sender<Value>>>, message: &str) {
    let mut p = pending.lock().unwrap();
    for (_, tx) in p.drain() {
        let _ = tx.send(json!({"error": {"message": message, "traceback": ""}}));
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

    #[test]
    fn should_drain_on_eof_only_when_epoch_unchanged() {
        // 정상 종료: restart 없이 죽었으므로 epoch가 그대로 — drain해야 함.
        assert!(should_drain_on_eof(1, 1));
        // restart_engine이 먼저 epoch를 올려버린 stale reader — drain하면 안 됨.
        assert!(!should_drain_on_eof(2, 1));
    }

    #[test]
    fn restart_race_does_not_leak_or_misfire_pending() {
        // restart_engine 시나리오를 OS 타이밍 없이 시뮬레이션한다:
        // 1) 옛 세대(epoch=1)에 대한 요청 하나가 pending에 걸려 있고,
        // 2) restart_engine이 즉시 fail_all_pending으로 이를 실패시킨 뒤 epoch를 올리고,
        // 3) 새 세대(epoch=2)에 대한 요청이 pending에 새로 걸린 상태에서,
        // 4) 옛 reader의 EOF 핸들러가 뒤늦게 도착해도 새 pending을 건드리지 않아야 한다.
        let pending: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>> =
            Arc::new(Mutex::new(HashMap::new()));

        let (old_tx, mut old_rx) = oneshot::channel();
        pending.lock().unwrap().insert(1, old_tx);
        let old_epoch = 1u64;

        // restart_engine: 즉시 옛 pending 실패 처리 + epoch 증가.
        fail_all_pending(&pending, "engine restarted");
        let current_epoch = old_epoch + 1;

        assert!(pending.lock().unwrap().is_empty());
        let old_result = old_rx.try_recv().expect("old request should be resolved immediately");
        assert_eq!(old_result["error"]["message"], "engine restarted");

        // 새 세대의 요청이 도착.
        let (new_tx, mut new_rx) = oneshot::channel();
        pending.lock().unwrap().insert(2, new_tx);

        // 옛 reader의 EOF 핸들러가 뒤늦게 도착: epoch가 이미 바뀌었으므로 drain 스킵.
        assert!(!should_drain_on_eof(current_epoch, old_epoch));

        // 새 세대의 pending은 그대로 살아있어야 한다.
        assert_eq!(pending.lock().unwrap().len(), 1);
        assert!(new_rx.try_recv().is_err(), "new request must still be awaiting its own response");
    }

    #[test]
    fn paths_exist_reports_existing_and_missing_paths() {
        let tmp = std::env::temp_dir().join(format!("bw_maker_paths_exist_{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let existing = tmp.join("exists.txt");
        std::fs::write(&existing, b"x").unwrap();
        let missing = tmp.join("missing.txt");

        let result = paths_exist(vec![
            existing.to_string_lossy().to_string(),
            missing.to_string_lossy().to_string(),
        ]);

        assert_eq!(result, vec![true, false]);
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
