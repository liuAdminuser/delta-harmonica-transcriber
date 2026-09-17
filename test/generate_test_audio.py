#!/usr/bin/env python3
"""生成已知旋律的测试 WAV 文件，用于验证 transcribe.py 识别准确率."""
import numpy as np
import wave
import struct
import json
import os

SAMPLE_RATE = 22050

def midi_to_freq(midi):
    return 440.0 * (2.0 ** ((midi - 69) / 12.0))

def generate_note(freq, duration, sample_rate=SAMPLE_RATE, amplitude=0.5):
    t = np.linspace(0, duration, int(sample_rate * duration), False)
    # 纯 sine + 少量泛音，模拟口琴音色
    wave_data = amplitude * np.sin(2 * np.pi * freq * t)
    wave_data += 0.15 * np.sin(2 * np.pi * freq * 2 * t)
    wave_data += 0.08 * np.sin(2 * np.pi * freq * 3 * t)
    # ADSR 简单包络
    attack = int(0.02 * sample_rate)
    release = int(0.05 * sample_rate)
    envelope = np.ones_like(t)
    envelope[:attack] = np.linspace(0, 1, attack)
    envelope[-release:] = np.linspace(1, 0, release)
    return wave_data * envelope

def save_wav(data, path, sample_rate=SAMPLE_RATE):
    data = (data * 32767).astype(np.int16)
    with wave.open(path, 'w') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(data.tobytes())

# 10 首测试曲目的基准 MIDI 序列（已知旋律）
# 使用 C 大调自然音阶，确保与口琴适配
TEST_SONGS = {
    "雪绒花": {
        "notes": [60,64,67,64,67,69,67,64,60,62,64,60,64,62,60,59,60],
        "durations": [0.5]*17,
        "gaps": [0.1]*16 + [0.5]
    },
    "茉莉花": {
        "notes": [64,64,67,69,72,69,67,64,62,64,67,64,62,60],
        "durations": [0.5]*14,
        "gaps": [0.1]*13 + [0.5]
    },
    "小星星": {
        "notes": [60,60,67,67,69,69,67,65,65,64,64,62,62,60],
        "durations": [0.4]*14,
        "gaps": [0.05]*13 + [0.5]
    },
    "生日快乐": {
        "notes": [60,60,62,60,65,64,60,60,62,60,67,65,60,60,72,69,65,64,62],
        "durations": [0.35]*19,
        "gaps": [0.05]*18 + [0.5]
    },
    "欢乐颂": {
        "notes": [64,64,65,67,67,65,64,62,60,60,62,64,64,62,62],
        "durations": [0.5]*15,
        "gaps": [0.08]*14 + [0.5]
    },
    "送别": {
        "notes": [60,62,64,60,64,65,64,62,60,62,64,60,64,62,60,59,60],
        "durations": [0.6]*17,
        "gaps": [0.08]*16 + [0.5]
    },
    "月亮代表我的心": {
        "notes": [64,65,64,62,60,62,64,60,59,60,62,60,59,57,55,57],
        "durations": [0.6]*16,
        "gaps": [0.08]*15 + [0.5]
    },
    "天空之城": {
        "notes": [67,67,69,71,71,69,67,65,64,65,67,67,65,64,62,64],
        "durations": [0.5]*16,
        "gaps": [0.08]*15 + [0.5]
    },
    "卡农": {
        "notes": [60,62,64,65,67,65,64,62,60,59,60,62,64,65,64,62],
        "durations": [0.5]*16,
        "gaps": [0.08]*15 + [0.5]
    },
    "我的祖国": {
        "notes": [67,69,72,74,72,71,69,67,65,67,69,72,71,69,67,65,64],
        "durations": [0.55]*17,
        "gaps": [0.08]*16 + [0.5]
    }
}

def generate_song(name, spec, out_dir):
    notes = spec["notes"]
    durations = spec["durations"]
    gaps = spec["gaps"]

    audio = np.array([], dtype=np.float64)
    benchmark = []
    t = 0.0

    for i, midi in enumerate(notes):
        dur = durations[i] if i < len(durations) else 0.5
        freq = midi_to_freq(midi)
        note_audio = generate_note(freq, dur)
        audio = np.concatenate([audio, note_audio])
        benchmark.append({"time": round(t, 3), "midi": midi, "notation": midi_to_notation(midi)})
        gap = gaps[i] if i < len(gaps) else 0.1
        # 添加静音间隔
        if gap > 0:
            silence = np.zeros(int(SAMPLE_RATE * gap), dtype=np.float64)
            audio = np.concatenate([audio, silence])
        t += dur + gap

    wav_path = os.path.join(out_dir, f"{name}.wav")
    save_wav(audio, wav_path)

    benchmark_path = os.path.join(out_dir, f"{name}_benchmark.json")
    with open(benchmark_path, 'w', encoding='utf-8') as f:
        json.dump({"name": name, "notes": benchmark}, f, ensure_ascii=False, indent=2)

    return wav_path, benchmark_path

def midi_to_notation(midi):
    octave_num = midi // 12 - 1
    mapping = {0: '1', 2: '2', 4: '3', 5: '4', 7: '5', 9: '6', 11: '7'}
    num = mapping.get(midi % 12, '?')
    if midi == 84: return '【i】'
    if octave_num <= 3: return f'({num})'
    elif octave_num == 4: return num
    else: return f'【{num}】'

def main():
    out_dir = os.path.join(os.path.dirname(__file__), 'test_audio')
    os.makedirs(out_dir, exist_ok=True)
    for name, spec in TEST_SONGS.items():
        wav_path, bench_path = generate_song(name, spec, out_dir)
        print(f"Generated: {wav_path} -> {bench_path}")
    print(f"\nAll test audio saved to: {out_dir}")

if __name__ == '__main__':
    main()
