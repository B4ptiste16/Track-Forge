const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');

const isDev = !app.isPackaged;
let manualCheck = false; // whether the current update check was user-initiated

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}
function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    return {};
  }
}
function saveSettings(s) {
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2));
}

function setupAutoUpdate(win) {
  // Don't message the renderer until the page has actually loaded — the updater
  // can emit before the first navigation finishes (disposed-frame errors).
  let rendererReady = false;
  win.webContents.on('did-finish-load', () => { rendererReady = true; });
  const send = (s) => { if (rendererReady && !win.isDestroyed()) win.webContents.send('update:status', s); };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => send({ state: 'checking' }));
  autoUpdater.on('update-available', (info) => send({ state: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => {
    send({ state: 'none' });
    if (manualCheck) dialog.showMessageBox(win, { type: 'info', message: `You're up to date (v${app.getVersion()}).`, buttons: ['OK'] });
    manualCheck = false;
  });
  autoUpdater.on('error', (e) => {
    send({ state: 'error', message: String(e) });
    if (manualCheck) dialog.showMessageBox(win, { type: 'error', message: 'Update check failed:\n' + String(e), buttons: ['OK'] });
    manualCheck = false;
  });
  autoUpdater.on('download-progress', (p) => send({ state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => {
    send({ state: 'downloaded', version: info.version });
    dialog
      .showMessageBox(win, {
        type: 'info',
        buttons: ['Restart & update', 'Later'],
        defaultId: 0,
        message: `Update v${info.version} is ready.`,
        detail: 'Restart now to install it?',
      })
      .then((r) => { if (r.response === 0) autoUpdater.quitAndInstall(); });
  });
}

function createWindow() {
  // Packaged builds get their icon from the exe; the png path only exists in dev
  // (build/ isn't bundled into the asar).
  const devIcon = path.join(__dirname, '..', 'build', 'icon.png');
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    backgroundColor: '#0f1014',
    ...(isDev && fs.existsSync(devIcon) ? { icon: devIcon } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  // Self-heal: if the renderer dies (GPU hiccup, corrupted cache…), reload it a
  // couple of times instead of leaving a dead black window.
  let crashReloads = 0;
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('renderer gone:', details.reason, details.exitCode);
    if (details.reason !== 'clean-exit' && crashReloads++ < 2) {
      setTimeout(() => { if (!win.isDestroyed()) win.webContents.reload(); }, 500);
    }
  });
  if (isDev) {
    win.loadURL('http://localhost:5173');
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
  setupAutoUpdate(win);
  if (!isDev) autoUpdater.checkForUpdates().catch(() => {}); // silent check on launch
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:set', (_e, s) => {
  saveSettings(s);
  return true;
});

ipcMain.handle('dialog:pickFolder', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:pickFile', async (e, filters) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: filters || [] });
  return r.canceled ? null : r.filePaths[0];
});

// Save-As style picker for the track folder: the user browses anywhere and
// types/keeps the folder name; we create `<dir>\<name>` and write into it.
ipcMain.handle('dialog:saveTrack', async (e, { defaultPath }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showSaveDialog(win, {
    title: 'Export track — choose where to save the track folder',
    defaultPath: defaultPath || undefined,
    buttonLabel: 'Export here',
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  });
  return r.canceled || !r.filePath ? null : r.filePath;
});

// Write the track files under baseDir/<slug>. Returns ok + the folder + fbx path.
ipcMain.handle('track:write', async (_e, { baseDir, slug, files }) => {
  const root = path.join(baseDir, slug);
  let fbxPath = null;
  try {
    for (const f of files) {
      const dest = path.join(root, f.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const data = f.encoding === 'base64' ? Buffer.from(f.data, 'base64') : f.data;
      fs.writeFileSync(dest, data);
      if (f.path.toLowerCase().endsWith('.fbx')) fbxPath = dest;
    }
    return { ok: true, root, fbxPath };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), root };
  }
});

ipcMain.handle('kseditor:open', async (_e, { ksPath, fbxPath }) => {
  if (!ksPath || !fs.existsSync(ksPath)) return { ok: false, error: 'Set a valid KsEditor.exe path first.' };
  if (!fbxPath || !fs.existsSync(fbxPath)) return { ok: false, error: 'Export the track first.' };
  try {
    // KsEditor needs to start in its own folder (it loads cfg/system relative
    // to the cwd) and does not accept a file argument — the user does
    // File → Import FBX, where our .fbx.ini pre-assigns all materials.
    spawn(ksPath, [], { cwd: path.dirname(ksPath), detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('shell:openPath', async (_e, p) => {
  if (p) await shell.openPath(p);
});

ipcMain.handle('dialog:message', async (e, { type, message }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  await dialog.showMessageBox(win, { type: type || 'info', message: String(message), buttons: ['OK'] });
});

// Multi-button question; resolves to the index of the clicked button.
ipcMain.handle('dialog:confirm', async (e, { message, detail, buttons }) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const list = buttons && buttons.length ? buttons : ['OK', 'Cancel'];
  const r = await dialog.showMessageBox(win, {
    type: 'question',
    message: String(message),
    detail: detail ? String(detail) : undefined,
    buttons: list,
    defaultId: 0,
    cancelId: list.length - 1,
    noLink: true,
  });
  return r.response;
});

// ============================================================================
// AI TRAINING (AC-RL integration) — the app is the cockpit for the RL driver.
// The python project lives in its own folder (OneDrive-synced); this section
// only ORCHESTRATES it: pick a track, launch AC on it, start/stop the training
// scripts, and stream their output + live telemetry back to the renderer.
// ============================================================================

const RL_DEFAULT_DIR = 'C:\\Users\\bapti\\OneDrive\\ac-rl';
const RL_DEFAULT_AC = 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\assettocorsa';
// The trainer and the app rendezvous through this local (non-synced) folder:
// live.json (telemetry out), stop.flag (graceful stop in), episodes.json.
const RL_LOCAL = path.join(process.env.LOCALAPPDATA || app.getPath('appData'), 'ac-rl');
const RL_STOP_FLAG = path.join(RL_LOCAL, 'stop.flag');
// Only these scripts may be launched from the app (never arbitrary commands).
const RL_SCRIPTS = new Set(['train.py', 'train_sim.py', 'drive.py', 'bank_model.py', 'pretrain.py', 'record_obs.py', 'save_and_reset.py']);

function rlDir() {
  return loadSettings().acRlDir || RL_DEFAULT_DIR;
}
function rlAcRoot() {
  return loadSettings().acRoot || RL_DEFAULT_AC;
}
function rlPython() {
  const p = path.join(process.env.LOCALAPPDATA || '', 'ac-rl', 'venv', 'Scripts', 'python.exe');
  return fs.existsSync(p) ? p : null;
}

let rlProc = null; // { child, script, startedAt }
const rlLogLines = []; // rolling buffer so the page can show history on mount
function rlLog(line) {
  for (const l of String(line).split(/\r?\n/)) {
    if (!l.trim()) continue;
    rlLogLines.push(l);
    if (rlLogLines.length > 400) rlLogLines.shift();
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('rl:log', l);
  }
}
function rlSendStatus() {
  const s = rlStatus();
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('rl:status', s);
}
function rlStatus() {
  return rlProc
    ? { running: true, script: rlProc.script, pid: rlProc.child.pid, startedAt: rlProc.startedAt }
    : { running: false };
}

ipcMain.handle('rl:status', () => rlStatus());
ipcMain.handle('rl:logHistory', () => rlLogLines.slice());

// Scan AC's content/tracks for tracks the bot can train on (= they have an AI
// line). Returns display name from ui_track.json when available.
ipcMain.handle('rl:listTracks', () => {
  const root = path.join(rlAcRoot(), 'content', 'tracks');
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    return { ok: false, error: `AC tracks folder not found:\n${root}\n(${err.message})`, tracks: [] };
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    const hasAi = fs.existsSync(path.join(dir, 'ai', 'fast_lane.ai'));
    let name = e.name;
    try {
      const ui = JSON.parse(fs.readFileSync(path.join(dir, 'ui', 'ui_track.json'), 'utf8'));
      if (ui.name) name = ui.name;
    } catch { /* keep folder name */ }
    out.push({ id: e.name, name, hasAi });
  }
  out.sort((a, b) => Number(b.hasAi) - Number(a.hasAi) || a.name.localeCompare(b.name));
  return { ok: true, tracks: out };
});

// Start one of the ac-rl python scripts. One process at a time.
ipcMain.handle('rl:start', (_e, { script, args }) => {
  if (rlProc) return { ok: false, error: `${rlProc.script} is already running — stop it first.` };
  if (!RL_SCRIPTS.has(script)) return { ok: false, error: `Unknown script: ${script}` };
  const py = rlPython();
  if (!py) return { ok: false, error: 'Python venv not found.\nRun once in a terminal:  cd ' + rlDir() + '  &&  python setup.py' };
  const dir = rlDir();
  if (!fs.existsSync(path.join(dir, script))) return { ok: false, error: `${script} not found in ${dir}` };
  try { fs.rmSync(RL_STOP_FLAG, { force: true }); } catch { /* ignore */ }
  const child = spawn(py, [script, ...(args || []).map(String)], {
    cwd: dir,
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  rlProc = { child, script, startedAt: Date.now() };
  rlLog(`--- ${script} ${(args || []).join(' ')} started (pid ${child.pid}) ---`);
  child.stdout.on('data', (d) => rlLog(d));
  child.stderr.on('data', (d) => rlLog(d));
  child.on('exit', (code) => {
    rlLog(`--- ${script} exited (code ${code}) ---`);
    rlProc = null;
    rlSendStatus();
  });
  rlSendStatus();
  return { ok: true, pid: child.pid };
});

// Graceful stop: write the stop flag; train.py/drive.py notice it within a
// step, save, and exit on their own. Escalate to a hard kill only if the
// process is still alive well after any save should have finished.
ipcMain.handle('rl:stop', () => {
  if (!rlProc) return { ok: true, note: 'nothing running' };
  const { child, script } = rlProc;
  try {
    fs.mkdirSync(RL_LOCAL, { recursive: true });
    fs.writeFileSync(RL_STOP_FLAG, 'stop');
  } catch { /* fall through to kill */ }
  rlLog(`--- stop requested (${script}) — letting it save and exit... ---`);
  setTimeout(() => {
    if (rlProc && rlProc.child === child) {
      rlLog('--- still running after 30s — force killing ---');
      try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']); } catch { /* ignore */ }
    }
  }, 30_000);
  return { ok: true };
});

// Live training feed: telemetry the trainer writes ~10x/s + checkpoint info.
let rlModelCache = { mtimeMs: 0, info: null };
ipcMain.handle('rl:live', async () => {
  const out = { live: null, model: null, banked: [] };
  try {
    out.live = JSON.parse(fs.readFileSync(path.join(RL_LOCAL, 'live.json'), 'utf8'));
  } catch { /* trainer not running yet */ }
  const modelPath = path.join(rlDir(), 'models', 'ac_sac.zip');
  try {
    const st = fs.statSync(modelPath);
    if (st.mtimeMs !== rlModelCache.mtimeMs) {
      const JSZip = require('jszip');
      const zip = await JSZip.loadAsync(fs.readFileSync(modelPath));
      const data = JSON.parse(await zip.file('data').async('string'));
      rlModelCache = {
        mtimeMs: st.mtimeMs,
        info: { steps: data.num_timesteps || 0, savedAt: st.mtimeMs },
      };
    }
    out.model = rlModelCache.info;
  } catch { /* no checkpoint yet */ }
  try {
    out.banked = fs.readdirSync(path.join(rlDir(), 'models', 'banked')).filter((f) => f.endsWith('.zip'));
  } catch { /* none banked */ }
  return out;
});

// Launch AC in a practice session on the chosen track. Vanilla AC has no
// track CLI — it reads Documents\Assetto Corsa\cfg\race.ini at startup. We
// take the user's last (known-good) race.ini, swap only the track, and start
// acs.exe. Requires AC to have been launched normally at least once.
ipcMain.handle('rl:launchAC', (_e, { track }) => {
  const iniPath = path.join(app.getPath('documents'), 'Assetto Corsa', 'cfg', 'race.ini');
  if (!fs.existsSync(iniPath)) {
    return { ok: false, error: 'race.ini not found — start AC normally once (any track), then this button can re-launch it on any chosen track.' };
  }
  const acsPath = path.join(rlAcRoot(), 'acs.exe');
  if (!fs.existsSync(acsPath)) return { ok: false, error: `acs.exe not found in ${rlAcRoot()}` };
  try {
    let ini = fs.readFileSync(iniPath, 'utf8');
    const swap = (key, value) => {
      const re = new RegExp(`^${key}=.*$`, 'm');
      ini = re.test(ini) ? ini.replace(re, `${key}=${value}`) : ini;
    };
    swap('TRACK', track);
    swap('CONFIG_TRACK', '');
    fs.writeFileSync(iniPath, ini);
    spawn(acsPath, [], { cwd: rlAcRoot(), detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

ipcMain.handle('update:check', async (e) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (isDev) {
    win.webContents.send('update:status', { state: 'dev' });
    await dialog.showMessageBox(win, { type: 'info', message: 'Auto-update only runs in the installed app.', buttons: ['OK'] });
    return;
  }
  manualCheck = true;
  autoUpdater.checkForUpdates().catch((err) => {
    win.webContents.send('update:status', { state: 'error', message: String(err) });
  });
});
ipcMain.handle('app:getVersion', () => app.getVersion());
