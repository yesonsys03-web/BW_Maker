//! 전체 캐시 워커 프로세스 관리.
//!
//! 워커는 메인 엔진과 같은 바이너리를 `--warm-worker` 플래그로 띄운 것이다
//! (engine/psd_engine/warmworker.py). 여기서는 띄우고, 파일 경로를 stdin으로
//! 먹이고, stdout의 진행 JSON을 이벤트로 프런트에 넘기고, 끝나면 거둔다.
//! 어떤 파일을 어느 워커에 주는지(디스패치)는 프런트가 정한다 — 남은 파일
//! 목록과 순서는 화면 상태이고, Rust가 그것을 복제해 들고 있으면 두 곳이
//! 어긋난다.
//!
//! 종료는 kill이다. 워커는 드로잉 레이어 하나를 수십 초씩 디코드할 수 있어
//! stdin EOF만으로는 바로 멈추지 않는데, 캐시 쓰기가 원자적(tilecache.store의
//! 임시파일+rename)이라 도중에 죽여도 반쪽 파일이 남지 않는다 — 중지가 즉시
//! 먹는 것이 깨끗한 종료보다 중요하다.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin};
use std::sync::Mutex;

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};

struct WorkerProc {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
pub struct WarmState {
    workers: Mutex<HashMap<u32, WorkerProc>>,
    /// 세대 번호. start마다 올라간다 — 이전 세대 reader 스레드가 EOF에서 내는
    /// exit 이벤트를 프런트가 새 세대의 죽음으로 오해하지 않게 이벤트에 싣는다.
    generation: Mutex<u32>,
}

fn kill_all(state: &WarmState) {
    let mut workers = state.workers.lock().unwrap();
    for (_, mut p) in workers.drain() {
        // stdin을 먼저 닫으면 파일 사이에서 놀던 워커는 EOF로 곱게 끝나고,
        // 디코드 중인 워커만 kill로 끊긴다.
        drop(p.stdin);
        let _ = p.child.kill();
        let _ = p.child.wait();
    }
}

/// 워커 N개를 띄운다. 이미 떠 있던 세대는 먼저 거둔다(중복 실행 방지).
/// stdout 한 줄마다 `warm-worker-line` 이벤트({generation, id, line})가 나가고,
/// 프로세스가 끝나면 `warm-worker-exit`({generation, id})가 나간다. 반환의
/// generation으로 프런트가 이전 세대의 잔류 이벤트(중지 직후 도착하는 exit 등)를
/// 걸러낸다.
#[tauri::command]
pub fn warm_workers_start(
    app: AppHandle,
    state: State<'_, WarmState>,
    count: u32,
    max_size: u32,
) -> Result<serde_json::Value, String> {
    kill_all(&state);
    let generation = {
        let mut g = state.generation.lock().unwrap();
        *g += 1;
        *g
    };

    let mut ids = Vec::new();
    let mut workers = state.workers.lock().unwrap();
    for id in 0..count.max(1) {
        let mut cmd = crate::engine::engine_command()?;
        cmd.arg("--warm-worker").arg("--max-size").arg(max_size.to_string());
        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;
        let stderr = child.stderr.take().ok_or("no stderr")?;

        // stderr는 읽어서 버린다 — 파이프가 차면 워커가 write에서 멈춘다.
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for _ in reader.lines() {}
        });

        let app_handle = app.clone();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                let _ = app_handle.emit(
                    "warm-worker-line",
                    json!({ "generation": generation, "id": id, "line": line }),
                );
            }
            let _ = app_handle
                .emit("warm-worker-exit", json!({ "generation": generation, "id": id }));
        });

        workers.insert(id, WorkerProc { child, stdin });
        ids.push(id);
    }
    Ok(json!({ "generation": generation, "ids": ids }))
}

/// 워커 하나에 파일 하나를 먹인다. edge_lines(경계선 설정)는 그대로 전달만
/// 한다 — 뜻은 엔진(warmworker.py)이 안다. 워커가 이미 죽었으면 에러 —
/// 프런트는 그 파일을 다른 워커에 다시 준다.
#[tauri::command]
pub fn warm_worker_send(
    state: State<'_, WarmState>,
    id: u32,
    path: String,
    edge_lines: Option<serde_json::Value>,
) -> Result<(), String> {
    let mut workers = state.workers.lock().unwrap();
    let proc = workers.get_mut(&id).ok_or("no such worker")?;
    let line = json!({ "path": path, "edgeLines": edge_lines }).to_string();
    writeln!(proc.stdin, "{line}")
        .and_then(|_| proc.stdin.flush())
        .map_err(|e| format!("worker write failed: {e}"))
}

#[tauri::command]
pub fn warm_workers_stop(state: State<'_, WarmState>) {
    kill_all(&state);
}

/// 앱 종료 시 워커를 거둔다 — 엔진과 같은 이유(kill_engine 참고): 부모 없이
/// CPU를 계속 파는 프로세스를 남기지 않는다. 워커 자체의 고아 감시가 이중
/// 방어선으로 있지만, 폴링 간격만큼 늦는다.
pub fn kill_warm_workers(app: &AppHandle) {
    let state: State<WarmState> = app.state();
    kill_all(&state);
}
