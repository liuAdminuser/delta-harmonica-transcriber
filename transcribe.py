#!/usr/bin/env python3
"""
音频 -> 口琴简谱 JSON

Pipeline:
  ffmpeg (在调用侧用) -> WAV
  basic-pitch ONNX -> polyphonic MIDI (CSV)
  后处理: 主旋律提取 + 口琴自适应 -> JSON

用法:
  python transcribe.py input.wav output.json [--model path/to/nmp.onnx]
"""
import sys, os, json, time, argparse, warnings
warnings.filterwarnings('ignore')

# 口琴硬约束
HARMONICA_MIN = 48
HARMONICA_MAX = 84
COMFORT_LOW = 55
COMFORT_HIGH = 76
NATURAL_PCS = {0, 2, 4, 5, 7, 9, 11}
NOTES_PER_OCTAVE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']


def resolve_model_path(cli_path=None):
    """自动解析 ONNX 模型路径."""
    if cli_path and os.path.isfile(cli_path):
        return cli_path
    env_path = os.environ.get('BASIC_PITCH_MODEL')
    if env_path and os.path.isfile(env_path):
        return env_path
    # 从 basic_pitch 包内自动解析
    try:
        import basic_pitch
        pkg_dir = os.path.dirname(basic_pitch.__file__)
        model_path = os.path.join(pkg_dir, 'saved_models', 'icassp_2022', 'nmp.onnx')
        if os.path.isfile(model_path):
            return model_path
    except Exception:
        pass
    # 相对路径 fallback
    rel = os.path.join(os.path.dirname(__file__), 'resources', 'nmp.onnx')
    if os.path.isfile(rel):
        return rel
    raise FileNotFoundError('nmp.onnx not found. Set BASIC_PITCH_MODEL env or use --model flag.')


def midi_to_note_name(m):
    return NOTES_PER_OCTAVE[m % 12] + str(m // 12 - 1)


def midi_to_harmonica(midi):
    """MIDI -> 口琴简谱编号 + 八度. 半音已在上游 round 过."""
    if midi < HARMONICA_MIN or midi > HARMONICA_MAX:
        return None
    octave_num = midi // 12 - 1
    num_in_octave = midi % 12
    mapping = {0: 1, 2: 2, 4: 3, 5: 4, 7: 5, 9: 6, 11: 7}
    num = mapping.get(num_in_octave)
    if num is None:
        return None
    if midi == 84:
        return {'num': 'i', 'octave': 'high'}
    if octave_num <= 3:
        octave = 'low' if octave_num < 3 else 'mid'
    elif octave_num == 4:
        octave = 'mid'
    else:
        octave = 'high'
    return {'num': num, 'octave': octave}


def run_basic_pitch(wav_path, model_path, onset_threshold=0.55, frame_threshold=0.30,
                    minimum_note_length=50, minimum_frequency=130.0, maximum_frequency=1046.5,
                    melodia_trick=True, verbose=False):
    """调 basic-pitch ONNX, 返回 polyphonic notes (含 velocity)."""
    from basic_pitch.inference import predict

    t0 = time.time()
    _, midi_data, _ = predict(
        wav_path,
        model_or_model_path=model_path,
        onset_threshold=onset_threshold,
        frame_threshold=frame_threshold,
        minimum_note_length=minimum_note_length,
        minimum_frequency=minimum_frequency,
        maximum_frequency=maximum_frequency,
        melodia_trick=melodia_trick,
    )
    elapsed = time.time() - t0

    notes = []
    for inst in midi_data.instruments:
        for n in inst.notes:
            start, end, pitch, vel = float(n.start), float(n.end), int(n.pitch), int(n.velocity)
            if start < 0 or end <= start or pitch < 21 or pitch > 108:
                continue
            notes.append({'start': start, 'end': end, 'midi': pitch, 'dur': end - start, 'vel': vel})
    notes.sort(key=lambda n: n['start'])
    if verbose:
        print(f'[basic-pitch] {len(notes)} polyphonic notes in {elapsed:.2f}s')
    return notes


def extract_melody(notes, comfort_low=COMFORT_LOW, comfort_high=COMFORT_HIGH):
    """主旋律提取 (不限音域) + 口琴自适应."""
    if not notes:
        return []

    START_TOL = 0.15

    # Step 1: onset 分拍 + 评分选音
    beats = []
    for n in notes:
        placed = False
        for b in beats:
            if abs(n['start'] - b['t']) < START_TOL:
                b['notes'].append(n)
                placed = True
                break
        if not placed:
            beats.append({'t': n['start'], 'notes': [n]})

    melody = []
    for b in beats:
        narrow = [n for n in b['notes'] if 59 <= n['midi'] <= 72]
        if narrow:
            candidates = narrow
            zone_bonus = 100
            zone2_bonus = 50
            fallback_penalty = 1.0
        else:
            candidates = b['notes']
            zone_bonus = 0
            zone2_bonus = 0
            fallback_penalty = 0.6
        scored = []
        for n in candidates:
            score = (n['vel'] + min(n['dur'] * 300, 100)) * fallback_penalty
            if zone_bonus and 59 <= n['midi'] <= 72:
                score += zone_bonus
            elif zone2_bonus and 73 <= n['midi'] <= 76:
                score += zone2_bonus
            scored.append((n, score))
        best = max(scored, key=lambda x: x[1])[0]
        melody.append(best)

    melody.sort(key=lambda n: n['start'])
    if len(melody) < 3:
        return melody

    # Step 2: 短时毛刺过滤 (<80ms 且前后都不同)
    filtered = []
    for i, n in enumerate(melody):
        prev_m = melody[i-1]['midi'] if i > 0 else -1
        next_m = melody[i+1]['midi'] if i < len(melody) - 1 else -1
        if n['dur'] < 0.08 and prev_m != n['midi'] and next_m != n['midi']:
            continue
        filtered.append(n)
    melody = filtered
    if len(melody) < 3:
        return melody

    # Step 3: 大跳平滑
    BIG_JUMP = 7
    SMALL_JUMP = 4
    smoothed = []
    for i, n in enumerate(melody):
        if i == 0 or i == len(melody) - 1:
            smoothed.append(n)
            continue
        prev_m = melody[i-1]['midi']
        next_m = melody[i+1]['midi']
        cur_m = n['midi']
        big_up = abs(cur_m - prev_m) > BIG_JUMP
        big_down = abs(next_m - cur_m) > BIG_JUMP
        prev_next_close = abs(prev_m - next_m) <= SMALL_JUMP
        if (big_up or big_down) and prev_next_close:
            repl = int(round((prev_m + next_m) / 2))
            n = n.copy()
            n['midi'] = repl
        smoothed.append(n)
    melody = smoothed
    if len(melody) < 3:
        return melody

    # Step 4: 清理极端 outlier
    medis = sorted(n['midi'] for n in melody)
    median_m = medis[len(medis) // 2]
    before = len(melody)
    melody = [n for n in melody if abs(n['midi'] - median_m) <= 10]
    removed = before - len(melody)
    if removed > 0:
        print(f'[outlier] median={median_m} removed {removed}/{before}')
    if len(melody) < 3:
        return melody

    # Step 5: 八度自适应
    median_midi = medis[len(medis) // 2]
    shift = 0
    if median_midi < comfort_low:
        shift = 12
        print(f'[adapt] median={median_midi} < {comfort_low} -> +12')
    elif median_midi > comfort_high:
        shift = -12
        print(f'[adapt] median={median_midi} > {comfort_high} -> -12')
    else:
        print(f'[adapt] median={median_midi} in [{comfort_low},{comfort_high}] -> no shift')
    if shift != 0:
        for n in melody:
            n['midi'] += shift

    # Step 6: 半音 round down
    for n in melody:
        pc = n['midi'] % 12
        if pc not in NATURAL_PCS:
            n['midi'] -= 1

    # Step 7: 过滤口琴范围外
    melody = [n for n in melody if HARMONICA_MIN <= n['midi'] <= HARMONICA_MAX]

    return melody


def merge_consecutive_same(melody, gap_tol=0.20):
    """合并相邻同音 + 间隔 < gap_tol 的."""
    if not melody:
        return melody
    merged = [melody[0].copy()]
    for n in melody[1:]:
        last = merged[-1]
        if n['midi'] == last['midi'] and (n['start'] - last['end']) < gap_tol:
            last['end'] = max(last['end'], n['end'])
            last['dur'] = last['end'] - last['start']
        else:
            merged.append(n.copy())
    return merged


def to_json_notes(melody):
    """转换为应用 JSON 格式."""
    out = []
    for n in melody:
        h = midi_to_harmonica(n['midi'])
        if not h:
            continue
        out.append({
            'time': round(n['start'], 4),
            'duration': round(n['dur'], 4),
            'type': 'note',
            'midi': n['midi'],
            'num': h['num'],
            'octave': h['octave'],
        })
    return out


def compute_bpm(melody):
    if len(melody) < 4:
        return 120
    intervals = []
    for i in range(2, len(melody)):
        iv = melody[i]['start'] - melody[i - 1]['start']
        if 0.05 < iv < 2.0:
            intervals.append(iv)
    if not intervals:
        return 120
    intervals.sort()
    med = intervals[len(intervals) // 2]
    return round(60.0 / med)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('input', help='WAV/MP3 输入')
    ap.add_argument('output', help='JSON 输出路径')
    ap.add_argument('--model', default=None, help='ONNX 模型路径')
    ap.add_argument('--onset-threshold', type=float, default=0.55)
    ap.add_argument('--frame-threshold', type=float, default=0.30)
    ap.add_argument('--minimum-note-length', type=int, default=50)
    ap.add_argument('--minimum-frequency', type=float, default=130.0)
    ap.add_argument('--maximum-frequency', type=float, default=1046.5)
    ap.add_argument('--comfort-low', type=int, default=COMFORT_LOW)
    ap.add_argument('--comfort-high', type=int, default=COMFORT_HIGH)
    args = ap.parse_args()

    print(f'[transcribe] input={args.input}')
    t_total = time.time()

    model_path = resolve_model_path(args.model)
    print(f'[transcribe] model={model_path}')

    notes = run_basic_pitch(
        args.input, model_path,
        onset_threshold=args.onset_threshold,
        frame_threshold=args.frame_threshold,
        minimum_note_length=args.minimum_note_length,
        minimum_frequency=args.minimum_frequency,
        maximum_frequency=args.maximum_frequency,
        verbose=True
    )
    if not notes:
        print('[transcribe] ERROR: no notes detected')
        sys.exit(1)

    melody = extract_melody(notes, comfort_low=args.comfort_low, comfort_high=args.comfort_high)
    print(f'[transcribe] melody notes: {len(melody)}')

    melody = merge_consecutive_same(melody, gap_tol=0.20)
    print(f'[transcribe] after merge: {len(melody)}')

    bpm = compute_bpm(melody)
    json_notes = to_json_notes(melody)
    print(f'[transcribe] final notes: {len(json_notes)}, bpm={bpm}')

    result = {
        'key': 'C',
        'bpm': bpm,
        'notes': json_notes,
        '_meta': {
            'engine': 'basic-pitch ONNX',
            'model': model_path,
            'onsetThreshold': args.onset_threshold,
            'frameThreshold': args.frame_threshold,
            'minimumNoteLength': args.minimum_note_length,
            'processingTimeMs': round((time.time() - t_total) * 1000, 1)
        }
    }
    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    total = time.time() - t_total
    print(f'[transcribe] done in {total:.2f}s -> {args.output}')

    print('\n=== FIRST 15 MELODY NOTES ===')
    print('time    dur     midi    name     num oct')
    for n in json_notes[:15]:
        name = midi_to_note_name(n['midi'])
        print(f'{n["time"]:6.2f} {n["duration"]:6.3f} {n["midi"]:4d}   {name:6s}   {n["num"]:>2}  {n["octave"]}')

    from collections import Counter
    pcs = Counter(n['midi'] % 12 for n in json_notes)
    acc = sum(v for k, v in pcs.items() if k not in NATURAL_PCS)
    if json_notes:
        print(f'\n音阶纯度: {acc}/{len(json_notes)} 半音 ({acc/len(json_notes)*100:.1f}%)')


if __name__ == '__main__':
    main()
