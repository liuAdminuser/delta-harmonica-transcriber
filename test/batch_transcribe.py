#!/usr/bin/env python3
"""批量执行 transcribe.py，带进度保存，可续跑."""
import os, sys, subprocess, json, time

TEST_DIR = os.path.join(os.path.dirname(__file__), 'test_audio')
PROGRESS_FILE = os.path.join(TEST_DIR, 'progress.json')
TRANSCRIBE_PY = os.path.join(os.path.dirname(__file__), '..', 'transcribe.py')

SONGS = [
    "雪绒花", "茉莉花", "小星星", "生日快乐", "欢乐颂",
    "送别", "月亮代表我的心", "天空之城", "卡农", "我的祖国"
]

def load_progress():
    if os.path.isfile(PROGRESS_FILE):
        with open(PROGRESS_FILE, 'r') as f:
            return set(json.load(f))
    return set()

def save_progress(done):
    with open(PROGRESS_FILE, 'w') as f:
        json.dump(list(done), f)

def run_one(song):
    wav = os.path.join(TEST_DIR, f"{song}.wav")
    out = os.path.join(TEST_DIR, f"{song}_result.json")
    if not os.path.isfile(wav):
        print(f"SKIP {song}: WAV missing")
        return False
    cmd = [sys.executable, TRANSCRIBE_PY, wav, out,
           '--onset-threshold', '0.5',
           '--frame-threshold', '0.25',
           '--minimum-note-length', '40']
    print(f"RUN {' '.join(cmd)}")
    t0 = time.time()
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        elapsed = time.time() - t0
        if proc.returncode == 0:
            print(f"OK {song} in {elapsed:.1f}s")
            return True
        else:
            print(f"FAIL {song}: rc={proc.returncode}\n{proc.stderr[-500:]}")
            return False
    except subprocess.TimeoutExpired:
        print(f"TIMEOUT {song}")
        return False
    except Exception as e:
        print(f"ERROR {song}: {e}")
        return False

def main():
    done = load_progress()
    print(f"Progress: {len(done)}/{len(SONGS)} done")
    start_time = time.time()
    for song in SONGS:
        if song in done:
            print(f"SKIP {song}: already done")
            continue
        if time.time() - start_time > 480:  # 8min 安全边界
            print("Time budget approaching, stopping for resume.")
            break
        ok = run_one(song)
        if ok:
            done.add(song)
            save_progress(done)
    print(f"Done: {len(done)}/{len(SONGS)}")

if __name__ == '__main__':
    main()
