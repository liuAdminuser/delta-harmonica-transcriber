const { app, BrowserWindow, ipcMain, globalShortcut, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
let ffmpegPath = require('ffmpeg-static');
if (ffmpegPath && ffmpegPath.includes('app.asar')) {
  ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
}
const { spawn } = require('child_process');

const USER_SCORES = path.join(app.getPath('userData'), 'scores');
const USER_CONFIG = path.join(app.getPath('userData'), 'config');
if (!fs.existsSync(USER_SCORES)) fs.mkdirSync(USER_SCORES, { recursive: true });
if (!fs.existsSync(USER_CONFIG)) fs.mkdirSync(USER_CONFIG, { recursive: true });

function log(msg) {
  const line = new Date().toISOString().slice(11, 23) + ' ' + msg + '\n';
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'debug.log'), line); } catch(e) {}
  console.log('[MAIN]', msg);
}
try { fs.writeFileSync(path.join(app.getPath('userData'), 'debug.log'), '===== harmonica-app v2.0 =====\n'); } catch(e) {}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900, height: 720,
    minWidth: 640, minHeight: 500,
    frame: false, resizable: true, alwaysOnTop: false,
    title: '三角洲口琴转谱工具',
    backgroundColor: '#1e1e2a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });
  mainWindow.loadFile('index.html');

  mainWindow.webContents.on('render-process-gone', (e, d) => log('CRASH! reason=' + d.reason));
  mainWindow.webContents.on('console-message', (e, level, msg) => log('[r] ' + msg));
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
  log('ready, ffmpeg=' + ffmpegPath);
  createWindow();
  globalShortcut.register('CommandOrControl+Alt+H', () => {
    if (!mainWindow) return;
    mainWindow.isVisible() ? mainWindow.hide() : mainWindow.show();
  });
  globalShortcut.register('CommandOrControl+Alt+Q', () => app.quit());
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ===== 安全工具函数 =====
function isValidFileName(name) {
  if (!name || typeof name !== 'string') return false;
  // 禁止路径穿越、空字符、特殊字符
  if (/[\x00\x01-\x1f\\/:*?"<>|]/.test(name)) return false;
  if (name.includes('..')) return false;
  if (name.startsWith('.') && name !== '.') return false;
  const safe = name.replace(/[^a-zA-Z0-9_.\-\u4e00-\u9fa5]/g, '_');
  return safe.length > 0 && safe.length < 200;
}

function sanitizeFileName(name) {
  if (!name) return 'untitled';
  let base = name.replace(/\\/g, '/').split('/').pop() || 'untitled';
  base = base.replace(/\.[^.]+$/, '');
  base = base.replace(/[\x00\x01-\x1f\\/:*?"<>|]/g, '_');
  base = base.replace(/\.{2,}/g, '_');
  if (base.length > 100) base = base.slice(0, 100);
  return base || 'untitled';
}

function safeJoin(base, fileName) {
  const target = path.join(base, fileName);
  const resolved = path.resolve(target);
  const baseResolved = path.resolve(base);
  if (!resolved.startsWith(baseResolved + path.sep) && resolved !== baseResolved) {
    throw new Error('Path traversal blocked: ' + fileName);
  }
  return resolved;
}

function safeJsonParse(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); }
  catch (e) { throw new Error('Read failed: ' + e.message); }
  try { return JSON.parse(raw); }
  catch (e) { throw new Error('JSON parse failed: ' + e.message); }
}

// ===== 配置管理 =====
const DEFAULT_KEYMAP_PATH = resolveResource('keymap.json');
const USER_KEYMAP_PATH = path.join(USER_CONFIG, 'keymap.json');

function loadKeymap() {
  let defaults = {};
  try {
    defaults = JSON.parse(fs.readFileSync(DEFAULT_KEYMAP_PATH, 'utf8'));
  } catch (e) { log('default keymap missing: ' + e.message); }

  let user = {};
  try {
    user = JSON.parse(fs.readFileSync(USER_KEYMAP_PATH, 'utf8'));
  } catch (e) { /* no user config yet */ }

  // 浅合并: user 覆盖 defaults
  const merged = { ...defaults, ...user };
  if (user.baseKeys) merged.baseKeys = { ...defaults.baseKeys, ...user.baseKeys };
  if (user.octaveModifiers) merged.octaveModifiers = { ...defaults.octaveModifiers, ...user.octaveModifiers };
  return merged;
}

function saveKeymap(config) {
  try {
    fs.writeFileSync(USER_KEYMAP_PATH, JSON.stringify(config, null, 2), 'utf8');
    return true;
  } catch (e) {
    log('save keymap error: ' + e.message);
    return false;
  }
}

// ===== IPC =====
ipcMain.handle('open-file-dialog', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: '媒体', extensions: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'mp4', 'webm'] }]
  });
  return !r.canceled && r.filePaths[0] ? r.filePaths[0] : null;
});

// Python 路径解析（多级探测）
function resolvePython() {
  const envPath = process.env.PYTHON_EXE;
  if (envPath && fs.existsSync(envPath)) return envPath;
  // 尝试 which/where
  const candidates = process.platform === 'win32'
    ? ['python.exe', 'python3.exe']
    : ['python3', 'python'];
  for (const c of candidates) {
    try {
      const { execFileSync } = require('child_process');
      const found = execFileSync(process.platform === 'win32' ? 'where' : 'which', [c], { encoding: 'utf8' }).trim().split('\n')[0];
      if (found && fs.existsSync(found)) return found;
    } catch (e) {}
  }
  // fallback
  return process.platform === 'win32' ? 'python.exe' : 'python3';
}

// 兼容开发与打包后环境：extraResources 会放在 process.resourcesPath/resources/
function resolveResource(fileName) {
  if (app.isPackaged) {
    const prodPath = path.join(process.resourcesPath, 'resources', fileName);
    if (fs.existsSync(prodPath)) return prodPath;
  }
  const devPath = path.join(__dirname, fileName);
  if (fs.existsSync(devPath)) return devPath;
  const prodPath = path.join(process.resourcesPath, 'resources', fileName);
  if (fs.existsSync(prodPath)) return prodPath;
  return devPath; // fallback
}

const TRANSCRIBE_PY = resolveResource('transcribe.py');
const KEYMAP_PATH = resolveResource('keymap.json');
const MODEL_PATH = resolveResource('nmp.onnx');

ipcMain.handle('transcribe-file', async (_, filePath) => {
  log('transcribe: ' + filePath);
  mainWindow?.webContents.send('analyze-progress', 5);

  const tmpDir = os.tmpdir();
  const ts = Date.now();
  const wavPath = path.join(tmpDir, 'harmonica_' + ts + '.wav');
  const jsonPath = path.join(tmpDir, 'harmonica_' + ts + '.json');

  // 1. ffmpeg -> WAV（带超时）
  await new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, [
      '-y', '-i', filePath,
      '-ar', '22050', '-ac', '1',
      wavPath
    ], { windowsHide: true });
    let stderr = '';
    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('ffmpeg timeout (>60s)'));
    }, 60000);
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', err => { clearTimeout(timeout); reject(err); });
    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) reject(new Error('ffmpeg exit ' + code + ': ' + stderr.split('\n').slice(-2).join(',')));
      else resolve();
    });
  });
  mainWindow?.webContents.send('analyze-progress', 20);
  log('ffmpeg OK -> ' + wavPath);

  // 2. 跑 transcribe.py（带超时）
  const pythonExe = resolvePython();
  await new Promise((resolve, reject) => {
    const args = [TRANSCRIBE_PY, wavPath, jsonPath, '--model', MODEL_PATH];
    log('spawn: ' + pythonExe + ' ' + args.join(' '));
    const proc = spawn(pythonExe, args, { windowsHide: true });
    let out = '', err = '';
    const timeout = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('transcription timeout (>300s)'));
    }, 300000);
    proc.stdout.on('data', d => { out += d.toString(); });
    proc.stderr.on('data', d => { err += d.toString(); });
    proc.on('error', err => { clearTimeout(timeout); reject(err); });
    proc.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        log('python stderr: ' + err.split('\n').slice(-5).join('\n'));
        reject(new Error('python exit ' + code));
      } else resolve();
    });
  });
  mainWindow?.webContents.send('analyze-progress', 90);
  log('python OK -> ' + jsonPath);

  // 3. 安全读取 JSON
  let result;
  try {
    result = safeJsonParse(jsonPath);
  } catch (e) {
    cleanup([wavPath, jsonPath]);
    throw new Error('解析识别结果失败: ' + e.message);
  }

  // 4. 清理临时文件
  cleanup([wavPath, jsonPath]);

  mainWindow?.webContents.send('analyze-progress', 100);
  log('done, notes=' + (result.notes?.length || 0) + ' bpm=' + result.bpm);

  return {
    fileName: path.basename(filePath),
    key: result.key || 'C',
    bpm: result.bpm || 120,
    notes: result.notes || [],
    _meta: result._meta || { engine: 'basic-pitch ONNX' },
    _diagnostics: result._diagnostics || null
  };
});

function cleanup(paths) {
  for (const p of paths) {
    try { fs.unlinkSync(p); } catch (e) {}
  }
}

// 保存简谱到本地（安全文件名）
ipcMain.handle('save-score', (_, scoreData) => {
  try {
    const safeName = sanitizeFileName(scoreData.fileName || 'untitled') + '.json';
    const savePath = safeJoin(USER_SCORES, safeName);
    fs.writeFileSync(savePath, JSON.stringify(scoreData, null, 2), 'utf8');
    log('saved: ' + savePath);
    return savePath;
  } catch (e) {
    log('save error: ' + e.message);
    return null;
  }
});

// 列出本地简谱
ipcMain.handle('list-scores', () => {
  try {
    return fs.readdirSync(USER_SCORES)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        const stat = fs.statSync(path.join(USER_SCORES, f));
        return { name: f, mtime: stat.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
  } catch (e) { return []; }
});

// 加载简谱（安全检查）
ipcMain.handle('load-score', (_, fileName) => {
  try {
    if (!isValidFileName(fileName)) {
      log('load-score blocked invalid name: ' + fileName);
      return null;
    }
    const p = safeJoin(USER_SCORES, fileName);
    return safeJsonParse(p);
  } catch (e) {
    log('load-score error: ' + e.message);
    return null;
  }
});

// 删除简谱（安全检查）
ipcMain.handle('delete-score', (_, fileName) => {
  try {
    if (!isValidFileName(fileName)) {
      log('delete-score blocked invalid name: ' + fileName);
      return false;
    }
    const p = safeJoin(USER_SCORES, fileName);
    fs.unlinkSync(p);
    return true;
  } catch (e) {
    log('delete-score error: ' + e.message);
    return false;
  }
});

ipcMain.handle('open-scores-folder', () => {
  const { shell } = require('electron');
  shell.openPath(USER_SCORES);
  return USER_SCORES;
});

// ===== 配置管理 IPC =====
ipcMain.handle('get-keymap', () => loadKeymap());
ipcMain.handle('set-keymap', (_, config) => saveKeymap(config));
ipcMain.handle('get-config', () => {
  const cfgPath = path.join(USER_CONFIG, 'app.json');
  try { return JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
  catch (e) { return { opacity: 1.0, alwaysOnTop: false, showOctave: true }; }
});
ipcMain.handle('set-config', (_, cfg) => {
  try {
    fs.writeFileSync(path.join(USER_CONFIG, 'app.json'), JSON.stringify(cfg, null, 2), 'utf8');
    return true;
  } catch (e) { return false; }
});

// 导出谱子为文本
ipcMain.handle('export-score-text', async (_, content) => {
  try {
    const r = await dialog.showSaveDialog(mainWindow, {
      defaultPath: '谱子.txt',
      filters: [{ name: '文本谱', extensions: ['txt'] }]
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, content, 'utf8');
    return r.filePath;
  } catch (e) {
    log('export error: ' + e.message);
    return null;
  }
});

// 窗口控制
ipcMain.handle('set-opacity', (_, v) => { if (mainWindow) mainWindow.setOpacity(Math.max(0.1, Math.min(1, v))); });
ipcMain.handle('set-always-on-top', (_, f) => { if (mainWindow) mainWindow.setAlwaysOnTop(f); });
ipcMain.handle('minimize-window', () => mainWindow && mainWindow.minimize());
ipcMain.handle('close-window', () => mainWindow && mainWindow.close());
