// ================================================================
// 三角洲口琴转谱工具 v2.0 - renderer.js
// ================================================================

// ===== 音符数字映射 =====
const NATURAL = { 0: 1, 2: 2, 4: 3, 5: 4, 7: 5, 9: 6, 11: 7 };
const KEY_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

// ===== 键位映射配置（运行时加载） =====
let KEYMAP = null;
let APP_CONFIG = null;

async function loadConfigs() {
  try { KEYMAP = await window.api.getKeymap(); } catch(e) { console.error('keymap load failed', e); }
  try { APP_CONFIG = await window.api.getConfig(); } catch(e) { APP_CONFIG = { opacity: 1.0, alwaysOnTop: false, showOctave: true }; }
}

// ===== MIDI -> 游戏键位转换 =====
function midiToGameKey(midi, keymap) {
  const km = keymap || KEYMAP;
  if (!km) return null;
  const range = km.range || { minMidi: 48, maxMidi: 84 };
  if (midi < range.minMidi || midi > range.maxMidi) return null;

  const baseKeys = km.baseKeys || {};
  const octaves = km.octaveModifiers || {};
  const sharp = km.sharpModifier || { midiOffset: 1 };
  const naturalPCS = km.naturalPitchClasses || [0, 2, 4, 5, 7, 9, 11];

  // 检查是否升半音
  let isSharp = false;
  let baseMidi = midi;
  const pc = midi % 12;
  if (!naturalPCS.includes(pc)) {
    isSharp = true;
    baseMidi = midi - 1;
  }
  const basePc = baseMidi % 12;

  // 找 pitch class 匹配的键（不要求同八度，与 transcribe.py 一致）
  let digit = null;
  let keyboard = '';
  const sortedKeys = Object.entries(baseKeys).sort((a, b) => (a[1].midiNote || 0) - (b[1].midiNote || 0));
  for (const [k, v] of sortedKeys) {
    if ((v.midiNote || 0) % 12 === basePc) {
      digit = k;
      keyboard = v.keyboard || '';
      break;
    }
  }

  // 兜底：如果 baseKeys 音高假设偏差，找最近自然音键
  if (digit === null) {
    let bestDist = 999;
    for (const [k, v] of sortedKeys) {
      const keyPc = (v.midiNote || 0) % 12;
      const dist = Math.min(Math.abs(keyPc - basePc), 12 - Math.abs(keyPc - basePc));
      if (dist < bestDist) {
        bestDist = dist;
        digit = k;
        keyboard = v.keyboard || '';
      }
    }
  }

  if (digit === null) return null;

  // 八度划分：以 baseKey "1" 的 midiNote 为全局参考点（与 transcribe.py 一致）
  const refMidi = (baseKeys['1']?.midiNote || 60);
  let octave = 'middle';
  let octaveMidi = midi;
  if (midi >= refMidi + 12) {
    octave = 'treble';
    octaveMidi -= 12;
  } else if (midi <= refMidi - 1) {
    octave = 'bass';
    octaveMidi += 12;
  }

  // 生成 notation
  const octCfg = octaves[octave] || { notationPrefix: '', notationSuffix: '' };
  const sharpCfg = km.sharpModifier || { notationPrefix: '#' };
  let notation = octCfg.notationPrefix + (isSharp ? sharpCfg.notationPrefix : '') + digit + octCfg.notationSuffix;

  // 鼠标操作提示
  const octBtn = octCfg.button;
  const sharpBtn = isSharp ? (sharp.button || 'mouse-middle') : null;
  let mouseAction = '';
  if (sharpBtn && octBtn) mouseAction = `按住${btnName(octBtn)} + ${btnName(sharpBtn)}，按 ${keyboard}`;
  else if (sharpBtn) mouseAction = `按住${btnName(sharpBtn)}，按 ${keyboard}`;
  else if (octBtn) mouseAction = `按住${btnName(octBtn)}，按 ${keyboard}`;
  else mouseAction = `按 ${keyboard}`;

  return { digit, octave, sharp: isSharp, notation, keyboard, mouseAction };
}

function btnName(btn) {
  const map = { 'mouse-left': '鼠标左键', 'mouse-middle': '鼠标中键', 'mouse-right': '鼠标右键' };
  return map[btn] || btn;
}

// ===== 音域检测 =====
function checkRange(notes, keymap) {
  const km = keymap || KEYMAP;
  if (!km || !notes.length) return { inRange: true, strategy: 'none', semitones: 0 };
  const range = km.range || { minMidi: 48, maxMidi: 84 };
  const mids = notes.filter(n => n.type === 'note').map(n => n.midi);
  if (!mids.length) return { inRange: true };
  const min = Math.min(...mids);
  const max = Math.max(...mids);

  if (min >= range.minMidi && max <= range.maxMidi) {
    return { inRange: true, strategy: 'none', semitones: 0, originalRange: { min, max } };
  }

  const suggestions = [];
  if (max - 12 <= range.maxMidi && min - 12 >= range.minMidi) {
    suggestions.push({ strategy: 'down_octave', semitones: -12, label: '降八度' });
  }
  if (min + 12 >= range.minMidi && max + 12 <= range.maxMidi) {
    suggestions.push({ strategy: 'up_octave', semitones: 12, label: '升八度' });
  }

  let bestShift = 0, bestCoverage = 0;
  for (let shift = -12; shift <= 12; shift++) {
    const inRange = mids.filter(m => {
      const shifted = m + shift;
      return shifted >= range.minMidi && shifted <= range.maxMidi;
    }).length;
    const coverage = inRange / mids.length;
    if (coverage > bestCoverage) {
      bestCoverage = coverage;
      bestShift = shift;
    }
  }
  if (bestCoverage > 0) {
    suggestions.push({
      strategy: 'semitone_shift',
      semitones: bestShift,
      coverage: bestCoverage,
      label: `移调 ${bestShift > 0 ? '+' : ''}${bestShift} 半音（覆盖率 ${(bestCoverage*100).toFixed(0)}%）`
    });
  }

  return {
    inRange: false,
    originalRange: { min, max },
    gameRange: { min: range.minMidi, max: range.maxMidi },
    suggestions
  };
}

// ===== 应用状态 =====
const state = {
  filePath: null, fileName: null, score: null,
  loadedScore: null, playing: false, playTime: 0,
  fallDots: [], showOctave: true,
  transpose: { semitones: 0, strategy: 'none' }
};

// ===== 进度监听 =====
window.api.onAnalyzeProgress((pct) => {
  const btn = document.getElementById('btnAnalyze');
  if (btn) btn.textContent = `\u23F3 ${pct}%`;
});

// ===== DOMContentLoaded =====
document.addEventListener('DOMContentLoaded', async () => {
  await loadConfigs();
  const $ = id => document.getElementById(id);

  // --- Tab 切换 ---
  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.page').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      $('page-' + t.dataset.tab).classList.add('active');
      if (t.dataset.tab === 'practice') refreshScoreList();
      if (t.dataset.tab === 'settings') renderSettings();
    });
  });

  // --- 扒谱页 ---
  const btnImport = $('btnImport'), btnAnalyze = $('btnAnalyze'), btnSave = $('btnSave');
  const btnExport = $('btnExport');
  const fileLabel = $('fileLabel'), statusBar = $('statusBar');
  const scoreMeta = $('scoreMeta'), mKey = $('mKey'), mBpm = $('mBpm'), mNotes = $('mNotes');
  const scoreScroll = $('scoreScroll'), emptyHint = $('emptyHint');
  const transposeCard = $('transposeCard');

  btnImport.addEventListener('click', async () => {
    const p = await window.api.openFileDialog();
    if (!p) return;
    state.filePath = p;
    state.fileName = p.split(/[\\/]/).pop();
    fileLabel.textContent = state.fileName;
    btnAnalyze.disabled = false;
    statusBar.textContent = '\u2705 已选择, 点击开始扒谱';
  });

  btnAnalyze.addEventListener('click', async () => {
    if (!state.filePath) return;
    btnAnalyze.disabled = true; btnAnalyze.textContent = '\u23F3 2%';
    transposeCard.style.display = 'none';
    try {
      const sc = await window.api.transcribeFile(state.filePath);

      // 口琴适配
      const harmonicNotes = [];
      for (const n of sc.notes) {
        if (n.type !== 'note') { harmonicNotes.push(n); continue; }
        const gk = midiToGameKey(n.midi, KEYMAP);
        if (gk) {
          harmonicNotes.push({
            time: n.time, duration: n.duration, type: 'note',
            midi: n.midi, num: gk.digit, octave: gk.octave,
            sharp: gk.sharp, notation: gk.notation, keyboard: gk.keyboard,
            mouseAction: gk.mouseAction
          });
        }
      }

      // 计算 BPM
      const nts = harmonicNotes.filter(n => n.type === 'note').map(n => n.time);
      let bpm = 120;
      if (nts.length > 3) {
        const ivs = [];
        for (let k = 2; k < nts.length; k++) ivs.push(nts[k] - nts[k - 1]);
        ivs.sort((a, b) => a - b);
        const med = ivs[Math.floor(ivs.length / 2)];
        if (med > 0.05 && med < 2.0) bpm = Math.round(60 / med);
      }

      state.score = { key: 'C', bpm, notes: harmonicNotes };
      state.transpose = { semitones: 0, strategy: 'none' };

      // 音域检测
      const rangeCheck = checkRange(harmonicNotes, KEYMAP);
      if (!rangeCheck.inRange) {
        renderTransposeCard(rangeCheck);
      }

      mKey.textContent = '1=C'; mBpm.textContent = bpm; mNotes.textContent = harmonicNotes.length;
      scoreMeta.style.display = 'flex'; emptyHint.style.display = 'none'; scoreScroll.style.display = 'block';
      renderScore(state.score); btnSave.disabled = false;
      if (btnExport) btnExport.disabled = false;
      btnAnalyze.disabled = false; btnAnalyze.textContent = '\u{1F504} 重新扒谱';

      // 诊断链路显示
      const diag = sc._diagnostics;
      let diagMsg = '';
      if (diag) {
        diagMsg = ` | 链路: ${diag.rawDetected}→${diag.afterOnsetSelect}→${diag.afterRangeFilter}→${diag.afterKeymap}`;
        if (diag.retry) diagMsg += ' (已自动放宽阈值重试)';
      }
      statusBar.textContent = `\u2705 完成! ${harmonicNotes.length} 音符, BPM≈${bpm}${diagMsg}`;
    } catch (e) {
      console.error('[扒谱失败]', e);
      btnAnalyze.disabled = false; btnAnalyze.textContent = '\u{1F50D} 开始扒谱';
      statusBar.textContent = '\u274C ' + (e.message || '未知错误');
    }
  });

  btnSave.addEventListener('click', async () => {
    if (!state.score) return;
    const saveObj = { fileName: state.fileName, ...state.score };
    const saved = await window.api.saveScore(saveObj);
    if (saved) { btnSave.textContent = '\u2705 已保存'; setTimeout(() => btnSave.textContent = '\u{1F4BE} 保存简谱', 1500); }
    else btnSave.textContent = '\u274C 保存失败';
  });

  if (btnExport) {
    btnExport.addEventListener('click', async () => {
      if (!state.score) return;
      const text = exportToText(state.score);
      const path = await window.api.exportScoreText(text);
      if (path) { btnExport.textContent = '\u2705 已导出'; setTimeout(() => btnExport.textContent = '\u{1F4DD} 导出谱子', 1500); }
      else btnExport.textContent = '\u274C 导出失败';
    });
  }

  function renderScore(sc) {
    const el = $('scoreLine');
    if (!el) return;
    el.innerHTML = '';
    sc.notes.forEach((note, idx) => {
      const c = document.createElement('div');
      c.className = 'note-cell';
      c.dataset.idx = idx;
      if (note.type === 'rest') {
        c.classList.add('rest');
        const span = document.createElement('span');
        span.className = 'nn'; span.textContent = '\u2014';
        c.appendChild(span);
      } else {
        let numStr = String(note.num);
        if (note.octave === 'treble' && note.num === 1) numStr = 'i';
        if (note.octave === 'bass') c.classList.add('low');
        if (note.octave === 'treble') c.classList.add('high');
        if (note.sharp) c.classList.add('sharp');

        const nn = document.createElement('span');
        nn.className = 'nn'; nn.textContent = numStr;
        c.appendChild(nn);

        if (state.showOctave) {
          const od = document.createElement('span');
          od.className = 'od';
          if (note.octave === 'bass') {
            od.classList.add('low');
            const d = document.createElement('span'); d.className = 'd'; od.appendChild(d);
          } else if (note.octave === 'treble') {
            od.classList.add('high'); od.textContent = '\u00B7';
          } else if (note.octave === 'middle') {
            od.classList.add('mid'); od.textContent = '\u2014';
          }
          c.appendChild(od);
        }

        if (note.sharp) {
          const acc = document.createElement('span');
          acc.className = 'na'; acc.textContent = '#';
          c.insertBefore(acc, nn);
        }
      }
      el.appendChild(c);
    });
  }

  function renderTransposeCard(check) {
    if (!transposeCard) return;
    const sugg = check.suggestions || [];
    let html = `<div class="tc-title">\u26A0\uFE0F 原曲音域超出可吹范围</div>`;
    html += `<div class="tc-range">原曲: MIDI ${check.originalRange.min}~${check.originalRange.max} | 口琴: MIDI ${check.gameRange.min}~${check.gameRange.max}</div>`;
    html += `<div class="tc-suggestions">`;
    sugg.forEach((s, i) => {
      html += `<label><input type="radio" name="transpose" value="${s.semitones}" data-strategy="${s.strategy}" ${i===0?'checked':''}> ${s.label}</label>`;
    });
    html += `</div>`;
    html += `<button class="btn-primary" id="btnApplyTranspose">应用移调</button>`;
    transposeCard.innerHTML = html;
    transposeCard.style.display = 'block';

    $('btnApplyTranspose').addEventListener('click', () => {
      const selected = transposeCard.querySelector('input[name="transpose"]:checked');
      if (!selected) return;
      const semitones = parseInt(selected.value);
      const strategy = selected.dataset.strategy;
      applyTranspose(semitones, strategy);
      transposeCard.style.display = 'none';
    });
  }

  function applyTranspose(semitones, strategy) {
    if (!state.score) return;
    state.transpose = { semitones, strategy };
    const newNotes = state.score.notes.map(n => {
      if (n.type !== 'note') return n;
      const newMidi = n.midi + semitones;
      const gk = midiToGameKey(newMidi, KEYMAP);
      if (!gk) return null;
      return {
        ...n, midi: newMidi,
        num: gk.digit, octave: gk.octave,
        sharp: gk.sharp, notation: gk.notation,
        keyboard: gk.keyboard, mouseAction: gk.mouseAction
      };
    }).filter(Boolean);
    state.score.notes = newNotes;
    renderScore(state.score);
    statusBar.textContent = `\u2705 已应用移调 ${semitones > 0 ? '+' : ''}${semitones} 半音`;
  }

  function exportToText(sc) {
    const lines = [];
    lines.push(`# 三角洲口琴谱`);
    lines.push(`# 来源: ${sc.fileName || '未知'}`);
    lines.push(`# BPM: ${sc.bpm || 120}`);
    lines.push(`# 键位映射版本: ${KEYMAP?.version || 'unknown'}`);
    lines.push('');
    const noteStrs = sc.notes.map(n => {
      if (n.type === 'rest') return '-';
      return n.notation || String(n.num);
    });
    // 每行 16 个音符
    for (let i = 0; i < noteStrs.length; i += 16) {
      lines.push(noteStrs.slice(i, i + 16).join(' '));
    }
    lines.push('');
    lines.push('# 操作说明: 数字=中音, (数字)=低音, 【数字】=高音');
    lines.push('# 低音: 按住鼠标左键 + 按键 | 中音: 按住鼠标中键 + 按键 | 高音: 按住鼠标右键 + 按键');
    return lines.join('\n');
  }

  // --- 练习页 ---
  const scoreSelect = $('scoreSelect'), btnLoadScore = $('btnLoadScore'), btnDelScore = $('btnDelScore');
  const practiceArea = $('practiceArea'), practiceEmpty = $('practiceEmpty'), fallStage = $('fallStage');
  const btnPlay = $('btnPlay'), pFill = $('pFill'), pTime = $('pTime'), pSpeed = $('pSpeed');
  const practiceControls = $('practiceControls');
  const btnShowOctave = $('btnShowOctave');
  const progressBar = document.querySelector('.progress');
  const mouseHint = $('mouseHint');

  // 8 轨道
  const TOTAL_TRACKS = 8;

  let scoreDuration = 10;

  async function refreshScoreList() {
    const list = await window.api.listScores();
    const cur = scoreSelect.value;
    scoreSelect.innerHTML = '<option value="">\u2014 选择简谱 \u2014</option>' +
      list.map(s => `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name)}</option>`).join('');
    if (cur) scoreSelect.value = cur;
  }

  btnLoadScore.addEventListener('click', async () => {
    const name = scoreSelect.value; if (!name) return;
    const sc = await window.api.loadScore(name); if (!sc) return;
    state.loadedScore = sc;
    state.playing = false;
    practiceEmpty.style.display = 'none';
    practiceControls.style.display = 'flex';
    initFallStage(sc);
    btnPlay.textContent = '\u25B6';
  });

  btnDelScore.addEventListener('click', async () => {
    const name = scoreSelect.value; if (!name) return;
    if (!confirm('\u786E\u5B9A\u5220\u9664 ' + name + '?')) return;
    await window.api.deleteScore(name);
    refreshScoreList();
  });

  $('btnOpenFolder').addEventListener('click', async () => {
    const p = await window.api.openScoresFolder();
    console.log('\u6253\u5F00\u6587\u4EF6\u5939:', p);
  });

  btnPlay.addEventListener('click', () => {
    if (!state.loadedScore) return;
    state.playing = !state.playing;
    btnPlay.textContent = state.playing ? '\u23F8' : '\u25B6';
    if (state.playing) {
      state.playStart = performance.now() - state.playTime * 1000;
      tick();
    } else {
      if (state.rafId) cancelAnimationFrame(state.rafId);
    }
  });

  // 空格键播放/暂停
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
      e.preventDefault();
      btnPlay.click();
    }
  });

  // ===== 键盘输入反馈 + 判定 =====
  const KEY_TO_NOTE = {
    'KeyZ': '1', 'KeyX': '2', 'KeyC': '3', 'KeyV': '4',
    'KeyB': '5', 'KeyN': '6', 'KeyM': '7', 'Comma': 'i'
  };
  const NOTE_FREQ = { '1': 261.63, '2': 293.66, '3': 329.63, '4': 349.23, '5': 392.00, '6': 440.00, '7': 493.88, 'i': 523.25 };

  let sfxCtx = null;
  function playSfx(type, noteLabel) {
    try {
      if (!sfxCtx) sfxCtx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = sfxCtx.createOscillator();
      const gain = sfxCtx.createGain();
      if (type === 'hit') {
        osc.type = 'triangle';
        osc.frequency.value = NOTE_FREQ[noteLabel] || 440;
        gain.gain.setValueAtTime(0.25, sfxCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, sfxCtx.currentTime + 0.22);
        osc.connect(gain).connect(sfxCtx.destination);
        osc.start(); osc.stop(sfxCtx.currentTime + 0.22);
      } else {
        osc.type = 'square';
        osc.frequency.value = 180;
        gain.gain.setValueAtTime(0.15, sfxCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, sfxCtx.currentTime + 0.18);
        osc.connect(gain).connect(sfxCtx.destination);
        osc.start(); osc.stop(sfxCtx.currentTime + 0.18);
      }
    } catch(e) {}
  }

  function findNearestFallingDot(noteLabel) {
    const FALL_MS = 2200;
    const tNow = state.playTime * 1000;
    let match = null, bestDist = Infinity;
    state.fallDots.forEach(dot => {
      const tDotMs = dot.time * 1000;
      const tAppear = tDotMs - FALL_MS;
      const progress = (tNow - tAppear) / FALL_MS;
      if (progress >= 0.82 && progress <= 1.25) {
        const dist = Math.abs(progress - 1);
        if (dist < bestDist) { bestDist = dist; match = dot; }
      }
    });
    return match;
  }

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    const noteLabel = KEY_TO_NOTE[e.code];
    if (!noteLabel) return;
    e.preventDefault();

    const kh = document.querySelector(`.kh-key[data-note="${noteLabel}"]`);
    if (kh) { kh.classList.add('hit'); setTimeout(() => kh.classList.remove('hit'), 180); }

    if (!state.loadedScore) { playSfx('hit', noteLabel); return; }

    const dot = findNearestFallingDot(noteLabel);
    if (dot) {
      if (dot.label === noteLabel) {
        dot.triggered = true;
        dot.el.style.transition = 'opacity .15s, transform .15s';
        dot.el.style.opacity = '0';
        dot.el.style.transform += ' scale(0.5)';
        setTimeout(() => dot.el.style.display = 'none', 150);
        playSfx('hit', noteLabel);
      } else {
        playSfx('miss', noteLabel);
      }
    } else {
      playSfx('hit', noteLabel);
    }
  });

  // ===== 下落动画 =====
  function initFallStage(sc) {
    fallStage.innerHTML = '<div class="hit-line"></div>';
    state.fallDots = [];
    state.playTime = 0;

    const lastNote = sc.notes.filter(n => n.type === 'note').slice(-1)[0];
    scoreDuration = Math.max(10, (lastNote ? lastNote.time + lastNote.duration : 10) + 2);

    for (let t = 0; t < TOTAL_TRACKS; t++) {
      const lane = document.createElement('div');
      lane.className = 'fall-lane';
      lane.style.left = `${(t + 0.5) / TOTAL_TRACKS * 100}%`;
      fallStage.appendChild(lane);
    }
    const hitLine = document.createElement('div');
    hitLine.className = 'hit-line';
    fallStage.appendChild(hitLine);

    // 从 keymap 构建轨道映射
    const baseKeys = KEYMAP?.baseKeys || {};
    const noteToTrack = {};
    const noteToKey = {};
    let trackIdx = 0;
    for (const [k, v] of Object.entries(baseKeys)) {
      noteToTrack[k] = trackIdx;
      noteToKey[k] = v.keyboard || k;
      trackIdx++;
    }

    sc.notes.forEach((note, idx) => {
      if (note.type === 'rest') return;
      let label = String(note.num);
      if (note.octave === 'high' && note.num === 1) label = 'i';
      const key = noteToKey[label]; if (!key) return;
      const tIdx = noteToTrack[label]; if (tIdx === undefined) return;

      const el = document.createElement('div');
      el.className = 'fall-dot';
      if (note.octave === 'low') el.classList.add('low');
      else if (note.octave === 'high') el.classList.add('high');
      if (note.sharp) el.classList.add('sharp');

      const lbl = document.createElement('span');
      lbl.className = 'dot-label'; lbl.textContent = label;
      el.appendChild(lbl);

      if (note.sharp) {
        const sh = document.createElement('span');
        sh.className = 'dot-sharp'; sh.textContent = '#';
        el.appendChild(sh);
      }

      const kbd = document.createElement('span');
      kbd.className = 'dot-key'; kbd.textContent = key;
      el.appendChild(kbd);

      fallStage.appendChild(el);

      state.fallDots.push({
        time: note.time, duration: note.duration,
        num: note.num, octave: note.octave, label, key, trackIdx: tIdx,
        sharp: note.sharp, el, triggered: false
      });
    });

    state.fallDots.sort((a, b) => a.time - b.time);
    updateProgressUI();
  }

  function tick() {
    if (!state.playing) return;
    const speed = parseFloat(pSpeed.value || '1');
    state.playTime = (performance.now() - state.playStart) / 1000 * speed;

    const stageH = fallStage.clientHeight || 500;
    const HIT_Y = stageH - 70;
    const FALL_MS = 2200;

    // 更新鼠标操作提示
    let currentHint = '';

    state.fallDots.forEach(dot => {
      const tDotMs = dot.time * 1000;
      const tAppear = tDotMs - FALL_MS;
      const tNow = state.playTime * 1000;

      if (tNow < tAppear) { dot.el.style.display = 'none'; return; }
      if (dot.triggered) { dot.el.style.display = 'none'; return; }
      dot.el.style.display = '';

      const progress = (tNow - tAppear) / FALL_MS;
      const y = progress * HIT_Y;
      const xPct = (dot.trackIdx + 0.5) / TOTAL_TRACKS * 100;
      dot.el.style.left = xPct + '%';
      dot.el.style.transform = `translate(-50%, ${y}px)`;

      if (progress >= 0.92 && progress <= 1.08 && !dot.triggered) {
        dot.triggered = true;
        dot.el.classList.add('near-hit');
        const kh = document.querySelector(`.kh-key[data-note="${dot.label}"]`);
        if (kh) { kh.classList.add('hit'); setTimeout(() => kh.classList.remove('hit'), 250); }
        // 更新操作提示
        const sc = state.loadedScore;
        if (sc && sc.notes) {
          const note = sc.notes.find(n => n.num === dot.num && Math.abs(n.time - dot.time) < 0.01);
          if (note && note.mouseAction) currentHint = note.mouseAction;
        }
      }
    });

    if (mouseHint) {
      mouseHint.textContent = currentHint || '';
      mouseHint.style.display = currentHint ? 'block' : 'none';
    }

    updateProgressUI();
    state.rafId = requestAnimationFrame(tick);
  }

  function updateProgressUI() {
    const pct = Math.min(100, (state.playTime / scoreDuration) * 100);
    pFill.style.width = pct + '%';
    pTime.textContent = fmtTime(state.playTime) + ' / ' + fmtTime(scoreDuration);
  }

  // 时间轴拖拽
  let draggingProgress = false;
  function seekTo(ratio) {
    if (!state.loadedScore) return;
    ratio = Math.max(0, Math.min(1, ratio));
    state.playTime = ratio * scoreDuration;
    state.fallDots.forEach(d => { d.triggered = false; d.el.classList.remove('near-hit'); d.el.style.display = 'none'; });
    if (state.playing) {
      state.playStart = performance.now() - state.playTime * 1000 / parseFloat(pSpeed.value || '1');
    }
    updateProgressUI();
  }
  progressBar.addEventListener('mousedown', (e) => {
    draggingProgress = true;
    const rect = progressBar.getBoundingClientRect();
    seekTo((e.clientX - rect.left) / rect.width);
  });
  window.addEventListener('mousemove', (e) => {
    if (!draggingProgress) return;
    const rect = progressBar.getBoundingClientRect();
    seekTo((e.clientX - rect.left) / rect.width);
  });
  window.addEventListener('mouseup', () => { draggingProgress = false; });

  function fmtTime(t) {
    if (!isFinite(t)) return '00:00';
    return `${String(Math.floor(t / 60)).padStart(2,'0')}:${String(Math.floor(t % 60)).padStart(2,'0')}`;
  }

  // --- 设置页 ---
  function renderSettings() {
    const spBody = $('spBody');
    if (!spBody || !KEYMAP) return;
    const bk = KEYMAP.baseKeys || {};
    let html = '<div class="sp-section"><h4>\u952E\u4F4D\u6620\u5C04 (MIDI note)</h4>';
    for (const [k, v] of Object.entries(bk)) {
      html += `<div class="sp-row"><label>${k} (${v.keyboard || ''})</label><input type="number" class="keymap-input" data-key="${k}" value="${v.midiNote}" min="0" max="127"></div>`;
    }
    html += '</div>';
    html += '<div class="sp-section"><h4>\u97F3\u57DF\u8303\u56F4</h4>';
    const r = KEYMAP.range || {};
    html += `<div class="sp-row"><label>\u6700\u4F4E\u97F3</label><input type="number" id="rangeMin" value="${r.minMidi || 48}" min="0" max="127"></div>`;
    html += `<div class="sp-row"><label>\u6700\u9AD8\u97F3</label><input type="number" id="rangeMax" value="${r.maxMidi || 84}" min="0" max="127"></div>`;
    html += '</div>';
    html += '<div class="sp-btns"><button class="btn-primary" id="btnSaveKeymap">\u4FDD\u5B58\u8BBE\u7F6E</button><button class="btn-toggle" id="btnResetKeymap">\u6062\u590D\u9ED8\u8BA4</button></div>';
    html += '<div class="sp-note">\u26A0\uFE0F \u9ED8\u8BA4\u952E\u4F4D\u6620\u5C04\u57FA\u4E8E\u793E\u533A\u8C03\u7814\u5047\u8BBE\uFF0C\u5F85\u6E38\u620F\u5185\u5B9E\u6D4B\u540E\u4FEE\u6B63</div>';
    spBody.innerHTML = html;

    $('btnSaveKeymap').addEventListener('click', async () => {
      const newMap = JSON.parse(JSON.stringify(KEYMAP));
      document.querySelectorAll('.keymap-input').forEach(inp => {
        const k = inp.dataset.key;
        if (newMap.baseKeys[k]) newMap.baseKeys[k].midiNote = parseInt(inp.value);
      });
      newMap.range.minMidi = parseInt($('rangeMin').value);
      newMap.range.maxMidi = parseInt($('rangeMax').value);
      const ok = await window.api.setKeymap(newMap);
      if (ok) { KEYMAP = newMap; alert('\u5DF2\u4FDD\u5B58\u952E\u4F4D\u8BBE\u7F6E'); }
    });

    $('btnResetKeymap').addEventListener('click', async () => {
      if (!confirm('\u786E\u5B9A\u6062\u590D\u9ED8\u8BA4\u952E\u4F4D\u6620\u5C04?')) return;
      await window.api.setKeymap({});
      await loadConfigs();
      renderSettings();
    });
  }

  // --- 窗口控制 ---
  $('btnMinimize').addEventListener('click', () => window.api.minimizeWindow());
  $('btnClose').addEventListener('click', () => window.api.closeWindow());
  $('spClose').addEventListener('click', () => $('settingsPanel').style.display = 'none');
  $('btnSettings').addEventListener('click', () => {
    const sp = $('settingsPanel');
    sp.style.display = sp.style.display === 'none' ? 'block' : 'none';
    renderSettings();
  });
  $('btnAlwaysOnTop').addEventListener('click', async (e) => {
    const on = e.target.textContent !== '\u5F00\u542F';
    await window.api.setAlwaysOnTop(on);
    e.target.textContent = on ? '\u5F00\u542F' : '\u5173\u95ED'; e.target.classList.toggle('on', on);
  });
  $('opacitySlider').addEventListener('input', async (e) => {
    $('opacityVal').textContent = e.target.value + '%';
    await window.api.setOpacity(parseInt(e.target.value) / 100);
  });

  console.log('[init] harmonica-app v2.0 OK');
});

// ===== 安全工具 =====
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
