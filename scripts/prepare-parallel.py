#!/usr/bin/env python
"""파일 준비의 병렬 기준선 — 폴더 하나를 N개의 워밍업 워커로 준비하는 데 걸리는
시간.

prepare-baseline.py는 배포 경로(rpc.Engine)를 메인 엔진 하나로 순차 돌린
벽시계 시간이었다(100장 콜드 1,679초, 그중 98.3%가 미리보기 합성). 이 스크립트는
그 짝이다 — 프런트가 실제로 쓰는 경로, 즉 N개의 `--warm-worker` 프로세스에
파일을 하나씩 먹이고 끝나는 대로 다음을 주는 당겨받기(runWorkerQueue,
src/lib/warmWorkers.ts)로 같은 폴더를 돌린 벽시계 시간을 잰다. 스톱워치로 앱
화면을 재는 대신 같은 종류의 도구로 비교해야 사과 대 사과 비교가 된다.

워커 프로토콜은 engine/psd_engine/warmworker.py의 모듈 docstring과
entry.py(--warm-worker 분기)가 정한 그대로다:
  spawn : 같은 인터프리터로 `-m psd_engine --warm-worker --max-size 1500`
  기동  : 워커가 {"event":"ready"}를 stdout에 한 줄 낸다
  잡    : {"path": "<psd>", "prepare": {"preset": {...}, "maxSize": 1500}} 한 줄
  응답  : {"event":"file","path",...,"ok":true,"result":{...}}
          {"event":"file","path",...,"ok":false,"message":...}
  종료  : stdin을 닫는다

디스패치 규율은 runWorkerQueue와 정확히 같아야 한다 — 그래야 재는 것이 같은
알고리즘이다. 워커마다 파일 하나로 시작하고, 워커가 파일 하나를 끝낼 때마다
**그 워커에** 큐의 다음 파일을 준다. 미리 나눠주지 않는다 — 판당 비용이
median 5.0초, mean 16.5초, max 259초로 들쭉날쭉해서, 미리 나누면 다른 알고리즘을
재는 셈이다. 워커가 죽으면 하던 파일을 큐 앞에 되돌리고 남은 워커로 계속한다.
전부 죽으면 남은 파일은 실패로 접는다.

벽시계는 첫 워커를 띄우기 직전부터 마지막 파일이 끝난 직후까지다 — 사용자가
실제로 기다리는 구간이다. 워커 종료(stdin 닫기·거두기)는 시계 밖에서 한다.

파일은 **번호로만** 부른다 — 납품 파일명은 기록에도, 에러 메시지에도 남기지
않는다. 워커가 실어 보내는 실패 메시지는 예외 문자열이라 경로가 섞여 있을 수
있으므로(예: FileNotFoundError가 경로를 담는다), 그대로는 절대 찍지 않고
예외 타입 이름만 남긴다.

    python scripts/prepare-parallel.py /path/to/folder presets/CHAR.json 4
"""
import json
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path

MAX_SIZE = 1500


def _drain_stderr(proc):
    """stderr 파이프가 차면 워커가 write에서 멈춘다(src-tauri/src/warm.rs와 같은
    이유) — 읽어서 버리기만 한다. 절대 찍지 않는다: 트레이스백에 경로가 섞여
    있을 수 있다."""
    try:
        for _ in proc.stderr:
            pass
    except Exception:
        pass


def _reader_thread(worker_id, proc, events):
    """워커 stdout을 한 줄씩 읽어 (worker_id, line) 을 공유 큐에 놓는다. 워커가
    여럿이라 파이프 하나를 블로킹으로 읽으면 다른 워커가 막히므로, 워커마다
    이 스레드가 하나씩 있고 shared queue로 합류한다. 스트림이 끝나면(워커가
    죽거나 stdin을 닫아 스스로 끝나면) (worker_id, None)을 놓아 알린다."""
    try:
        for line in proc.stdout:
            events.put((worker_id, line))
    except Exception:
        pass
    finally:
        events.put((worker_id, None))


def _spawn_worker(worker_id, events):
    proc = subprocess.Popen(
        [sys.executable, "-m", "psd_engine", "--warm-worker",
         "--max-size", str(MAX_SIZE)],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", bufsize=1,
    )
    threading.Thread(target=_drain_stderr, args=(proc,), daemon=True).start()
    threading.Thread(target=_reader_thread, args=(worker_id, proc, events),
                      daemon=True).start()
    return proc


def main(folder, preset_path, n_workers):
    preset = json.loads(Path(preset_path).read_text(encoding="utf-8"))
    paths = sorted(p for p in Path(folder).iterdir()
                   if p.suffix.lower() in (".psd", ".psb"))
    n_files = len(paths)
    index_of = {str(p): i for i, p in enumerate(paths, 1)}
    n_workers = max(1, int(n_workers))

    events = queue.Queue()
    procs = {wid: _spawn_worker(wid, events) for wid in range(n_workers)}
    alive = set(procs)
    inflight = {}          # worker_id -> (path, start_perf)
    per_worker = [0] * n_workers
    remaining = list(paths)  # FIFO queue, consumed from the front
    failed = 0
    completed = 0

    def feed(wid):
        if not remaining:
            return False
        path = remaining.pop(0)
        job = {"path": str(path),
               "prepare": {"preset": preset, "maxSize": MAX_SIZE}}
        try:
            procs[wid].stdin.write(json.dumps(job) + "\n")
            procs[wid].stdin.flush()
        except (BrokenPipeError, OSError):
            # 워커가 이미 죽어 못 먹였다 — 되돌리고 exit 신호가 뒷정리하게 둔다.
            remaining.insert(0, path)
            return False
        inflight[wid] = (path, time.perf_counter())
        return True

    t_all = time.perf_counter()
    for wid in range(n_workers):
        feed(wid)

    while (remaining or inflight) and alive:
        wid, line = events.get()
        if line is None:
            # 워커가 죽었다(stdout EOF). 하던 파일이 있으면 큐 앞에 되돌리고,
            # 노는 살아있는 워커가 있으면 바로 이어 먹인다.
            alive.discard(wid)
            orphan = inflight.pop(wid, None)
            try:
                procs[wid].wait(timeout=2)
            except Exception:
                pass
            if orphan is not None:
                remaining.insert(0, orphan[0])
            for other in list(alive):
                if other not in inflight and remaining:
                    feed(other)
            continue

        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue  # stdout에 섞인 잡음은 버린다(runWorkerQueue와 같은 규율)
        if ev.get("event") != "file":
            continue  # ready 등 다른 이벤트는 이 측정에서 필요 없다

        entry = inflight.pop(wid, None)
        if entry is None:
            continue  # 이 워커 몫이 아닌 줄 — 프로토콜상 없어야 하지만 방어적으로 무시
        path, t_start = entry
        elapsed = time.perf_counter() - t_start
        ok = bool(ev.get("ok"))
        row = {"n": index_of[str(path)], "worker": wid,
               "s": round(elapsed, 3), "ok": ok}
        if not ok:
            failed += 1
            # 실패 메시지는 예외 문자열이라 경로가 섞일 수 있다(예:
            # FileNotFoundError). 타입 이름만 남긴다 — 절대 원문을 찍지 않는다.
            message = ev.get("message") or ""
            row["error_type"] = message.split(":", 1)[0] if message else "unknown"
        per_worker[wid] += 1
        completed += 1
        print(json.dumps(row, ensure_ascii=False), flush=True)

        if wid in alive:
            feed(wid)

    wall_s = round(time.perf_counter() - t_all, 1)

    # 전부 죽어 못 돌린 파일이 남았으면 인덱스만으로 실패로 접는다.
    for path in remaining:
        failed += 1
        print(json.dumps({"n": index_of[str(path)], "worker": None,
                          "s": None, "ok": False,
                          "error_type": "no workers alive"},
                         ensure_ascii=False), flush=True)
    remaining.clear()

    # 시계 밖: stdin을 닫아 워커를 곱게 끝내고 거둔다.
    for wid, proc in procs.items():
        if proc.poll() is None:
            try:
                proc.stdin.close()
            except Exception:
                pass
    for wid, proc in procs.items():
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()

    print(json.dumps({
        "workers": n_workers,
        "files": n_files,
        "wall_s": wall_s,
        "failed": failed,
        "per_worker": per_worker,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
