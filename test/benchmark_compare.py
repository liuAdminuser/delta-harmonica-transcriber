#!/usr/bin/env python3
"""对比 transcribe.py 输出与 benchmark，计算标准音命中率."""
import json
import sys
import os

TIME_TOL = 0.35  # 时间容差 (秒)
PITCH_TOL = 0    # 音高容差 (semitone)
TRANSPOSE_EQUIV = [0, 12, -12]  # 移调等价


def merge_consecutive_same(notes, gap_tol=0.20):
    """合并相邻同音 + 间隔 < gap_tol."""
    if not notes:
        return notes
    merged = [dict(notes[0])]
    for n in notes[1:]:
        last = merged[-1]
        gap = n.get('time', n.get('start', 0)) - last.get('end', last.get('time', 0) + last.get('duration', 0))
        if n['midi'] == last['midi'] and gap < gap_tol:
            last['duration'] = last.get('duration', 0) + n.get('duration', 0) + gap
            last['end'] = last.get('time', 0) + last['duration']
        else:
            merged.append(dict(n))
    return merged


def load_json(path):
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def compare(benchmark_path, result_path):
    bench = load_json(benchmark_path)
    result = load_json(result_path)

    bench_notes = bench.get('notes', [])
    result_notes = result.get('notes', [])

    # 两边都合并连续同音，保证公平
    # 公平比较：两边都提取音高轮廓（去掉连续同音）
    def extract_contour(notes):
        if not notes:
            return notes
        out = [dict(notes[0])]
        for n in notes[1:]:
            if n['midi'] != out[-1]['midi']:
                out.append(dict(n))
        return out
    bench_notes = extract_contour(bench_notes)
    result_notes = extract_contour(result_notes)

    total = len(bench_notes)
    hits = 0
    hit_details = []

    # 允许半音就近 round 到自然音也算命中（口琴适配）
    NATURAL_PCS = {0, 2, 4, 5, 7, 9, 11}
    def nearest_natural(midi):
        pc = midi % 12
        if pc in NATURAL_PCS:
            return midi
        # 就近 round：试 +1 和 -1，取最近的（一样近则取 -1）
        down = midi - 1
        up = midi + 1
        down_pc = down % 12
        up_pc = up % 12
        if down_pc in NATURAL_PCS and up_pc not in NATURAL_PCS:
            return down
        if up_pc in NATURAL_PCS and down_pc not in NATURAL_PCS:
            return up
        # 都自然或都不自然，取 -1（与原 transcribe.py 一致）
        return down if down_pc in NATURAL_PCS else midi

    for bn in bench_notes:
        bt = bn.get('time', bn.get('start', 0))
        bm = nearest_natural(bn['midi'])
        matched = False
        best_delta = None
        for rn in result_notes:
            rt = rn.get('time', rn.get('start', 0))
            rm = rn['midi']
            if abs(rt - bt) <= TIME_TOL:
                for trans in TRANSPOSE_EQUIV:
                    if abs(rm - (bm + trans)) <= PITCH_TOL:
                        matched = True
                        best_delta = rm - bn['midi']
                        break
                if matched:
                    break
        if matched:
            hits += 1
        hit_details.append({
            'time': round(bt, 3),
            'midi': bn['midi'],
            'adapted_midi': bm,
            'hit': matched,
            'transpose': best_delta if matched else None
        })

    hit_rate = hits / total * 100 if total > 0 else 0
    return {
        'song': bench.get('name', os.path.basename(benchmark_path)),
        'total_notes': total,
        'hits': hits,
        'misses': total - hits,
        'hit_rate': round(hit_rate, 1),
        'details': hit_details,
        'result_note_count': len(result_notes)
    }


def main():
    test_dir = os.path.join(os.path.dirname(__file__), 'test_audio')
    songs = [
        "雪绒花", "茉莉花", "小星星", "生日快乐", "欢乐颂",
        "送别", "月亮代表我的心", "天空之城", "卡农", "我的祖国"
    ]

    results = []
    for song in songs:
        bench = os.path.join(test_dir, f"{song}_benchmark.json")
        result = os.path.join(test_dir, f"{song}_result.json")
        if not os.path.isfile(bench):
            print(f"SKIP {song}: benchmark missing")
            continue
        if not os.path.isfile(result):
            print(f"SKIP {song}: result missing")
            continue
        r = compare(bench, result)
        results.append(r)
        status = "PASS" if r['hit_rate'] >= 85 else "FAIL"
        print(f"{song:12s} | 标准音 {r['total_notes']:2d} | 识别出 {r['result_note_count']:2d} | 命中 {r['hits']:2d} | 命中率 {r['hit_rate']:5.1f}% | {status}")

    avg = sum(r['hit_rate'] for r in results) / len(results) if results else 0
    passed = sum(1 for r in results if r['hit_rate'] >= 85)
    print(f"\n平均命中率: {avg:.1f}%")
    print(f"达标歌曲: {passed}/{len(results)} (≥85%)")

    summary_path = os.path.join(test_dir, 'hit_rate_summary.json')
    with open(summary_path, 'w', encoding='utf-8') as f:
        json.dump({'average': round(avg, 1), 'passed': passed, 'total': len(results), 'songs': results}, f, ensure_ascii=False, indent=2)
    print(f"Summary saved to {summary_path}")


if __name__ == '__main__':
    main()
