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

# 依赖预检：在导入时给出友好提示
try:
    from basic_pitch.inference import predict
    from basic_pitch import ICASSP_2022_MODEL_PATH
except ImportError as e:
    print(f"ERROR: basic_pitch import failed: {e}", file=sys.stderr)
    print("Please install: pip install basic-pitch onnxruntime", file=sys.stderr)
    sys.exit(1)

try:
    import onnxruntime as ort
except ImportError as e:
    print(f"ERROR: onnxruntime import failed: {e}", file=sys.stderr)
    print("Please install: pip install onnxruntime", file=sys.stderr)
    sys.exit(1)

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


def resolve_keymap_path():
    """自动解析 keymap.json 路径."""
    # 开发环境
    dev = os.path.join(os.path.dirname(__file__), '..', 'keymap.json')
    if os.path.isfile(dev):
        return dev
    # 打包后 resources/
    res = os.path.join(os.path.dirname(__file__), 'keymap.json')
    if os.path.isfile(res):
        return res
    return None


def load_keymap(path=None):
    """加载 keymap 配置."""
    if path is None:
        path = resolve_keymap_path()
    if path and os.path.isfile(path):
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    # 硬编码 fallback（与 keymap.json 默认值一致）
    return {
        "baseKeys": {
            "1": {"midiNote": 60, "keyboard": "Z", "noteName": "C4", "display": "1"},
            "2": {"midiNote": 62, "keyboard": "X", "noteName": "D4", "display": "2"},
            "3": {"midiNote": 64, "keyboard": "C", "noteName": "E4", "display": "3"},
            "4": {"midiNote": 65, "keyboard": "V", "noteName": "F4", "display": "4"},
            "5": {"midiNote": 67, "keyboard": "B", "noteName": "G4", "display": "5"},
            "6": {"midiNote": 69, "keyboard": "N", "noteName": "A4", "display": "6"},
            "7": {"midiNote": 71, "keyboard": "M", "noteName": "B4", "display": "7"},
            "i": {"midiNote": 72, "keyboard": ",", "noteName": "C5", "display": "i"}
        },
        "range": {"minMidi": 48, "maxMidi": 84, "comfortLow": 55, "comfortHigh": 76},
        "naturalPitchClasses": [0, 2, 4, 5, 7, 9, 11]
    }


def midi_to_note_name(m):
    return NOTES_PER_OCTAVE[m % 12] + str(m // 12 - 1)


def midi_to_harmonica(midi, keymap):
    """MIDI -> 口琴简谱编号 + 八度. 使用 keymap 进行最近键位映射（可八度等效）."""
    rng = keymap.get('range', {})
    h_min = rng.get('minMidi', HARMONICA_MIN)
    h_max = rng.get('maxMidi', HARMONICA_MAX)
    if midi < h_min or midi > h_max:
        return None

    base_keys = keymap.get('baseKeys', {})
    natural_pcs = set(keymap.get('naturalPitchClasses', list(NATURAL_PCS)))

    pc = midi % 12
    is_sharp = pc not in natural_pcs
    base_midi = midi - 1 if is_sharp else midi
    base_pc = base_midi % 12

    # 在 baseKeys 中找 pitch class 匹配的键（不要求同八度）
    digit = None
    for k, v in sorted(base_keys.items(), key=lambda x: x[1].get('midiNote', 0)):
        if v.get('midiNote', 0) % 12 == base_pc:
            digit = k
            break

    if digit is None:
        # 兜底：如果 baseKeys 音高假设本身有偏差，
        # 找 pitch class 最近的自然音键
        best_dist = 999
        for k, v in sorted(base_keys.items(), key=lambda x: x[1].get('midiNote', 0)):
            key_pc = v.get('midiNote', 0) % 12
            dist = min(abs(key_pc - base_pc), 12 - abs(key_pc - base_pc))
            if dist < best_dist:
                best_dist = dist
                digit = k
        if digit is None:
            return None

    # 八度划分：以 baseKey "1" 的 midiNote 为全局参考点
    ref_midi = base_keys.get('1', {}).get('midiNote', 60)
    if midi >= ref_midi + 12:
        octave_key = 'treble'
    elif midi <= ref_midi - 1:
        octave_key = 'bass'
    else:
        octave_key = 'middle'

    # 特殊兼容：midi 84 且 pitch class 为 C 时沿用 'i' 标记
    if midi == 84 and base_pc == 0:
        digit = 'i'

    # 生成记号（使用 keymap 的 notationPrefix/Suffix）
    mod_info = keymap.get('octaveModifiers', {}).get(octave_key, {})
    prefix = mod_info.get('notationPrefix', '')
    suffix = mod_info.get('notationSuffix', '')
    notation = f"{prefix}{digit}{suffix}"

    return {
        'num': digit,
        'octave': octave_key,
        'notation': notation,
        'mappingError': 0
    }


def run_basic_pitch(wav_path, model_path, onset_threshold=0.55, frame_threshold=0.30,
                    minimum_note_length=50, minimum_frequency=130.0, maximum_frequency=1046.5,
                    melodia_trick=True, verbose=False):
    """调 basic-pitch ONNX, 返回 polyphonic notes (含 velocity)."""
    # basic_pitch.predict already imported at module top
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
    """主旋律提取 (不限音域) + 口琴自适应. 返回 (melody, diagnostics)."""
    diagnostics = {
        'rawDetected': len(notes),
        'afterOnsetSelect': 0,
        'afterSpikeFilter': 0,
        'afterSmooth': 0,
        'afterOutlier': 0,
        'afterOctaveShift': 0,
        'afterRangeFilter': 0,
    }
    if not notes:
        return [], diagnostics

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
    diagnostics['afterOnsetSelect'] = len(melody)
    if len(melody) < 3:
        return melody, diagnostics

    # Step 2: 短时毛刺过滤 (<80ms 且前后都不同)
    filtered = []
    for i, n in enumerate(melody):
        prev_m = melody[i-1]['midi'] if i > 0 else -1
        next_m = melody[i+1]['midi'] if i < len(melody) - 1 else -1
        if n['dur'] < 0.08 and prev_m != n['midi'] and next_m != n['midi']:
            continue
        filtered.append(n)
    melody = filtered
    diagnostics['afterSpikeFilter'] = len(melody)
    if len(melody) < 3:
        return melody, diagnostics

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
    diagnostics['afterSmooth'] = len(melody)
    if len(melody) < 3:
        return melody, diagnostics

    # Step 4: 清理极端 outlier
    medis = sorted(n['midi'] for n in melody)
    median_m = medis[len(medis) // 2]
    before = len(melody)
    melody = [n for n in melody if abs(n['midi'] - median_m) <= 10]
    removed = before - len(melody)
    if removed > 0:
        print(f'[outlier] median={median_m} removed {removed}/{before}')
    diagnostics['afterOutlier'] = len(melody)
    if len(melody) < 3:
        return melody, diagnostics

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
    diagnostics['afterOctaveShift'] = len(melody)

    # Step 6: 半音 round down
    for n in melody:
        pc = n['midi'] % 12
        if pc not in NATURAL_PCS:
            n['midi'] -= 1

    # Step 7: 过滤口琴范围外
    melody = [n for n in melody if HARMONICA_MIN <= n['midi'] <= HARMONICA_MAX]
    diagnostics['afterRangeFilter'] = len(melody)

    return melody, diagnostics


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


def to_json_notes(melody, keymap):
    """转换为应用 JSON 格式."""
    out = []
    dropped = 0
    for n in melody:
        h = midi_to_harmonica(n['midi'], keymap)
        if not h:
            dropped += 1
            continue
        out.append({
            'time': round(n['start'], 4),
            'duration': round(n['dur'], 4),
            'type': 'note',
            'midi': n['midi'],
            'num': h['num'],
            'octave': h['octave'],
            'notation': h['notation'],
            'mappingError': h['mappingError'],
        })
    return out, dropped


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


def transcribe_once(args, keymap, retry_label=''):
    """执行一次完整的 transcribe 流程."""
    if retry_label:
        print(f'\n[transcribe] {retry_label}')

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
        return None

    melody, diagnostics = extract_melody(notes, comfort_low=args.comfort_low, comfort_high=args.comfort_high)
    print(f'[transcribe] melody notes: {len(melody)}')

    melody = merge_consecutive_same(melody, gap_tol=0.20)
    print(f'[transcribe] after merge: {len(melody)}')

    bpm = compute_bpm(melody)
    json_notes, dropped = to_json_notes(melody, keymap)
    print(f'[transcribe] final notes: {len(json_notes)}, dropped={dropped}, bpm={bpm}')

    # 打印诊断链路
    print(f'[diagnostics] raw={diagnostics["rawDetected"]} '
          f'-> onset={diagnostics["afterOnsetSelect"]} '
          f'-> spike={diagnostics["afterSpikeFilter"]} '
          f'-> smooth={diagnostics["afterSmooth"]} '
          f'-> outlier={diagnostics["afterOutlier"]} '
          f'-> octave={diagnostics["afterOctaveShift"]} '
          f'-> range={diagnostics["afterRangeFilter"]} '
          f'-> json={len(json_notes)}')

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
        },
        '_diagnostics': {
            **diagnostics,
            'afterMerge': len(melody),
            'afterKeymap': len(json_notes),
            'droppedByKeymap': dropped,
            'retry': retry_label != ''
        }
    }

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

    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('input', help='WAV/MP3 输入')
    ap.add_argument('output', help='JSON 输出路径')
    ap.add_argument('--model', default=None, help='ONNX 模型路径')
    ap.add_argument('--keymap', default=None, help='keymap.json 路径')
    ap.add_argument('--onset-threshold', type=float, default=0.55)
    ap.add_argument('--frame-threshold', type=float, default=0.30)
    ap.add_argument('--minimum-note-length', type=int, default=50)
    ap.add_argument('--minimum-frequency', type=float, default=130.0)
    ap.add_argument('--maximum-frequency', type=float, default=1046.5)
    ap.add_argument('--comfort-low', type=int, default=COMFORT_LOW)
    ap.add_argument('--comfort-high', type=int, default=COMFORT_HIGH)
    args = ap.parse_args()

    keymap = load_keymap(args.keymap)

    # 第一次尝试
    result = transcribe_once(args, keymap)

    # 如果 0 音符，自动放宽阈值重试一次
    if result is None or not result['notes']:
        print('\n[transcribe] 首次结果为 0，尝试放宽阈值重试...')
        args.onset_threshold = max(0.30, args.onset_threshold - 0.15)
        args.frame_threshold = max(0.15, args.frame_threshold - 0.10)
        args.minimum_note_length = max(20, args.minimum_note_length - 20)
        result = transcribe_once(args, keymap, retry_label='放宽阈值重试')

    if result is None or not result['notes']:
        print('[transcribe] ERROR: 重试后仍为 0 音符')
        sys.exit(1)

    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f'[transcribe] done -> {args.output}')


if __name__ == '__main__':
    main()
