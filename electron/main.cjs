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
  if (!isDev) {
    autoUpdater.checkForUpdates().catch(() => {}); // silent check on launch
    // Fully automatic updates: keep checking while the app runs, so a pushed
    // release reaches the user without them doing anything (download is
    // automatic; install happens on the restart prompt or on app quit).
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 30 * 60 * 1000);
  }
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
const RL_SCRIPTS = new Set(['train.py', 'train_sim.py', 'drive.py', 'bank_model.py', 'pretrain.py', 'record_obs.py', 'save_and_reset.py', 'suggest_setup.py', 'bot_to_ai.py']);

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

// Up to TWO processes at once — one LIVE (needs AC + the virtual gamepad:
// train.py / drive.py) and one SIM (train_sim.py, no AC). That's how two
// tracks train at the same time: live AC on one, sim focus on the other.
// Per-track model folders (ac-rl models/tracks/<track>/) make this safe —
// they never write to the same files.
const RL_LIVE_SCRIPTS = new Set(['train.py', 'drive.py', 'bot_to_ai.py']);
const rlProcs = new Map(); // pid -> { child, script, args, startedAt }
const rlLogLines = []; // rolling buffer so the page can show history on mount
function rlLog(line, tag = '') {
  for (const l of String(line).split(/\r?\n/)) {
    if (!l.trim()) continue;
    const out = tag ? `${tag} ${l}` : l;
    rlLogLines.push(out);
    if (rlLogLines.length > 400) rlLogLines.shift();
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('rl:log', out);
  }
}
// When live + sim run together, prefix their output so the log stays readable.
function rlTag(script) {
  if (rlProcs.size < 2) return '';
  return script === 'train_sim.py' ? '[sim]' : '[AC]';
}
function rlSendStatus() {
  const s = rlStatus();
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('rl:status', s);
}
function rlStatus() {
  return {
    running: [...rlProcs.values()].map((p) => ({
      pid: p.child.pid, script: p.script, args: p.args, startedAt: p.startedAt,
    })),
  };
}
// Per-script stop flags so stopping the sim doesn't stop live training (and
// vice versa). The bare stop.flag remains "stop everything" for the python side.
function rlStopFlagFor(script) {
  return path.join(RL_LOCAL, `stop.${script}.flag`);
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
  // An AI line may sit in the track folder OR in a LAYOUT subfolder (multi-
  // layout Kunos tracks + most mods) — check both so those tracks aren't
  // wrongly greyed out. Any AC track (Kunos or mod) is trainable, not just
  // ones built in this app.
  const hasAiLine = (dir) => {
    if (fs.existsSync(path.join(dir, 'ai', 'fast_lane.ai'))) return true;
    try {
      for (const sub of fs.readdirSync(dir, { withFileTypes: true })) {
        if (sub.isDirectory() && fs.existsSync(path.join(dir, sub.name, 'ai', 'fast_lane.ai'))) return true;
      }
    } catch { /* unreadable */ }
    return false;
  };
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(root, e.name);
    const hasAi = hasAiLine(dir);
    let name = e.name;
    for (const uiPath of [path.join(dir, 'ui', 'ui_track.json'), path.join(dir, 'ui')]) {
      try {
        // multi-layout tracks keep ui_track.json under ui/<layout>/
        const f = uiPath.endsWith('.json') ? uiPath : (() => {
          const layout = fs.readdirSync(uiPath, { withFileTypes: true }).find((x) => x.isDirectory());
          return layout ? path.join(uiPath, layout.name, 'ui_track.json') : null;
        })();
        if (f) { const ui = JSON.parse(fs.readFileSync(f, 'utf8')); if (ui.name) { name = ui.name; break; } }
      } catch { /* keep folder name */ }
    }
    out.push({ id: e.name, name, hasAi });
  }
  out.sort((a, b) => Number(b.hasAi) - Number(a.hasAi) || a.name.localeCompare(b.name));
  return { ok: true, tracks: out };
});

// Start one of the ac-rl python scripts. Concurrency rules: one LIVE script
// (train.py/drive.py — they share AC and the virtual gamepad), one sim
// training, and utility one-shots (bank/save_and_reset) only while idle
// (they move the model files the others might be writing).
ipcMain.handle('rl:start', (_e, { script, args }) => {
  if (!RL_SCRIPTS.has(script)) return { ok: false, error: `Unknown script: ${script}` };
  const running = [...rlProcs.values()];
  if (RL_LIVE_SCRIPTS.has(script) && running.some((p) => RL_LIVE_SCRIPTS.has(p.script))) {
    return { ok: false, error: 'A live AC script is already running — stop it first (only one can use AC and the controller).' };
  }
  if (script === 'train_sim.py' && running.some((p) => p.script === 'train_sim.py')) {
    return { ok: false, error: 'Sim training is already running — stop it first.' };
  }
  if (!RL_LIVE_SCRIPTS.has(script) && script !== 'train_sim.py' && running.length > 0) {
    return { ok: false, error: `${script} moves model files around — stop the running scripts first.` };
  }
  const py = rlPython();
  if (!py) return { ok: false, error: 'Python venv not found.\nRun once in a terminal:  cd ' + rlDir() + '  &&  python setup.py' };
  const dir = rlDir();
  if (!fs.existsSync(path.join(dir, script))) return { ok: false, error: `${script} not found in ${dir}` };
  try {
    fs.rmSync(rlStopFlagFor(script), { force: true });
    if (running.length === 0) fs.rmSync(RL_STOP_FLAG, { force: true }); // stale "stop everything"
  } catch { /* ignore */ }
  const child = spawn(py, [script, ...(args || []).map(String)], {
    cwd: dir,
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  rlProcs.set(child.pid, { child, script, args: (args || []).map(String), startedAt: Date.now() });
  rlLog(`--- ${script} ${(args || []).join(' ')} started (pid ${child.pid}) ---`);
  child.stdout.on('data', (d) => rlLog(d, rlTag(script)));
  child.stderr.on('data', (d) => rlLog(d, rlTag(script)));
  child.on('exit', (code) => {
    rlLog(`--- ${script} exited (code ${code}) ---`);
    rlProcs.delete(child.pid);
    rlSendStatus();
  });
  rlSendStatus();
  return { ok: true, pid: child.pid };
});

// Graceful stop of ONE process (by pid) or everything (no pid): write the
// per-script stop flag; the script notices within a step, saves, and exits on
// its own. Escalate to a hard kill only if it's still alive well after any
// save should have finished.
ipcMain.handle('rl:stop', (_e, { pid } = {}) => {
  const targets = pid ? [rlProcs.get(pid)].filter(Boolean) : [...rlProcs.values()];
  if (targets.length === 0) return { ok: true, note: 'nothing running' };
  for (const t of targets) {
    try {
      fs.mkdirSync(RL_LOCAL, { recursive: true });
      fs.writeFileSync(rlStopFlagFor(t.script), 'stop');
    } catch { /* fall through to kill */ }
    rlLog(`--- stop requested (${t.script}, pid ${t.child.pid}) — letting it save and exit... ---`);
    const child = t.child;
    setTimeout(() => {
      if (rlProcs.has(child.pid)) {
        rlLog(`--- ${t.script} still running after 30s — force killing ---`);
        try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']); } catch { /* ignore */ }
      }
    }, 30_000);
  }
  return { ok: true };
});

// Live training feed: telemetry the trainer writes ~10x/s + the SELECTED
// track's checkpoint info (per-track bots: models/tracks/<track>/).
const rlModelCache = new Map(); // track -> { mtimeMs, info }
ipcMain.handle('rl:live', async (_e, { track } = {}) => {
  const out = { live: null, model: null, banked: [] };
  try {
    out.live = JSON.parse(fs.readFileSync(path.join(RL_LOCAL, 'live.json'), 'utf8'));
  } catch { /* trainer not running yet */ }
  if (track) {
    // Bots are per TRACK+CAR: models/tracks/<track>/<car>/ac_sac.zip (legacy
    // bots sit directly in the track dir until the trainer migrates them).
    // Show the most recently trained car's bot for the selected track.
    const tdir = path.join(rlDir(), 'models', 'tracks', track);
    let botDir = tdir, car = '', modelPath = path.join(tdir, 'ac_sac.zip');
    try {
      let bestT = fs.existsSync(modelPath) ? fs.statSync(modelPath).mtimeMs : -1;
      for (const e of fs.readdirSync(tdir, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name === 'banked') continue;
        const mp = path.join(tdir, e.name, 'ac_sac.zip');
        if (fs.existsSync(mp) && fs.statSync(mp).mtimeMs > bestT) {
          bestT = fs.statSync(mp).mtimeMs;
          botDir = path.join(tdir, e.name);
          car = e.name;
          modelPath = mp;
        }
      }
    } catch { /* track has no bots yet */ }
    try {
      const st = fs.statSync(modelPath);
      const cacheKey = `${track}/${car}`;
      const cached = rlModelCache.get(cacheKey);
      if (!cached || st.mtimeMs !== cached.mtimeMs) {
        const JSZip = require('jszip');
        const zip = await JSZip.loadAsync(fs.readFileSync(modelPath));
        const data = JSON.parse(await zip.file('data').async('string'));
        rlModelCache.set(cacheKey, {
          mtimeMs: st.mtimeMs,
          info: { steps: data.num_timesteps || 0, savedAt: st.mtimeMs, car },
        });
      }
      out.model = rlModelCache.get(cacheKey).info;
    } catch { /* no bot for this track yet */ }
    try {
      out.banked = fs.readdirSync(path.join(botDir, 'banked')).filter((f) => f.endsWith('.zip'));
    } catch { /* none banked */ }
    // Saved (archived) bots for THIS track: archive/saved_<track>_<label>_<ts>/
    try {
      const arch = path.join(rlDir(), 'archive');
      const prefix = `saved_${track}_`;
      out.saved = fs.readdirSync(arch, { withFileTypes: true })
        .filter((e) => e.isDirectory() && e.name.startsWith(prefix)
          && fs.existsSync(path.join(arch, e.name, 'ac_sac.zip')))
        .map((e) => {
          const m = e.name.match(/^saved_.*_(\d{8})_(\d{6})$/);
          const label = e.name.slice(prefix.length).replace(/_\d{8}_\d{6}$/, '');
          const date = m ? `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)} ${m[2].slice(0, 2)}:${m[2].slice(2, 4)}` : '';
          return { folder: e.name, label, date };
        })
        .sort((a, b) => b.folder.localeCompare(a.folder));
    } catch { out.saved = []; }
  }
  return out;
});

// Suggested car setup for a track: read the setup-advice telemetry the trainer
// accumulated for the most-recently-trained car and turn it into directional
// tips (brake bias, balance, tyres). Mirrors ac_rl/setup_advisor.advise().
ipcMain.handle('rl:suggestSetup', (_e, { track }) => {
  if (!track) return { ok: false, error: 'no track' };
  const tdir = path.join(rlDir(), 'models', 'tracks', track);
  let file = null, car = '';
  try {
    let bestT = -1;
    for (const e of fs.readdirSync(tdir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === 'banked') continue;
      const f = path.join(tdir, e.name, 'setup_telemetry.json');
      if (fs.existsSync(f) && fs.statSync(f).mtimeMs > bestT) {
        bestT = fs.statSync(f).mtimeMs; file = f; car = e.name;
      }
    }
  } catch { /* no bots */ }
  if (!file) return { ok: true, car: '', tips: ['No telemetry yet — train or drive this track first.'], brakeBias: null };
  let s;
  try { s = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return { ok: true, car, tips: ['Telemetry unreadable yet — keep training.'], brakeBias: null }; }
  const tips = [];
  let brakeBias = null;
  const bn = s.brake_n || 0;
  if (bn >= 20) {
    const fr = s.brake_front / bn, rr = s.brake_rear / bn;
    const delta = Math.max(-6, Math.min(6, (fr - rr) * 6));
    brakeBias = Math.round((58 - delta) * 10) / 10;
    if (delta > 1) tips.push(`Fronts lock under braking → move brake bias REARWARD to ~${brakeBias.toFixed(0)}% front.`);
    else if (delta < -1) tips.push(`Rears lock/step out under braking → move brake bias FORWARD to ~${brakeBias.toFixed(0)}% front.`);
    else tips.push(`Braking is balanced → brake bias ~${brakeBias.toFixed(0)}% front is about right.`);
  }
  const cn = s.corner_n || 0;
  if (cn >= 20) {
    const us = (s.understeer_n || 0) / cn, ov = (s.oversteer_n || 0) / cn;
    if (us > 0.35 && us > ov + 0.1) tips.push('Mid-corner UNDERSTEER → soften front anti-roll bar / lower front tyre pressures ~1 psi, or add front wing.');
    else if (ov > 0.35 && ov > us + 0.1) tips.push('Mid-corner OVERSTEER → soften rear anti-roll bar / lower rear tyre pressures ~1 psi, or add rear wing / more diff preload.');
    else tips.push('Cornering balance is fairly neutral.');
    if ((s.slide_peak || 0) > 3) tips.push('Lots of tyre sliding → a gentler setup (more downforce / softer springs) would be faster and more consistent.');
  }
  if (!tips.length) tips.push('Not enough clean laps yet — keep training, then check again.');
  return { ok: true, car, tips, brakeBias, steps: s.steps || 0 };
});

// Bring a saved bot back as the track's live bot. The current bot (if any) is
// itself archived first, so restoring never destroys anything.
ipcMain.handle('rl:restoreSaved', (_e, { track, folder }) => {
  if (rlProcs.size > 0) return { ok: false, error: 'Stop the running scripts first — restoring moves model files.' };
  if (!track || !folder || folder.includes('/') || folder.includes('\\') || folder.includes('..')
    || !folder.startsWith(`saved_${track}_`)) {
    return { ok: false, error: 'Invalid saved-bot name.' };
  }
  const src = path.join(rlDir(), 'archive', folder);
  const tdir = path.join(rlDir(), 'models', 'tracks', track);
  if (!fs.existsSync(path.join(src, 'ac_sac.zip'))) return { ok: false, error: `${folder} has no ac_sac.zip.` };
  try {
    fs.mkdirSync(tdir, { recursive: true });
    // archive whatever is live right now before overwriting it
    if (fs.existsSync(path.join(tdir, 'ac_sac.zip'))) {
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15).replace(/^(\d{8})(\d{6}).*/, '$1_$2');
      const dest = path.join(rlDir(), 'archive', `saved_${track}_replaced_${stamp}`);
      fs.mkdirSync(dest, { recursive: true });
      fs.renameSync(path.join(tdir, 'ac_sac.zip'), path.join(dest, 'ac_sac.zip'));
      if (fs.existsSync(path.join(tdir, 'ac_sac_buffer.pkl'))) {
        fs.renameSync(path.join(tdir, 'ac_sac_buffer.pkl'), path.join(dest, 'ac_sac_buffer.pkl'));
      }
    }
    fs.copyFileSync(path.join(src, 'ac_sac.zip'), path.join(tdir, 'ac_sac.zip'));
    if (fs.existsSync(path.join(src, 'ac_sac_buffer.pkl'))) {
      fs.copyFileSync(path.join(src, 'ac_sac_buffer.pkl'), path.join(tdir, 'ac_sac_buffer.pkl'));
    }
    rlModelCache.delete(track);
    rlLog(`--- restored saved bot '${folder}' as the live bot for ${track} ---`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// Parse an INI into ordered blocks so we can edit specific sections (AC's
// race.ini reuses key names like TYPE/MODEL across sections, so a global
// regex isn't safe). blocks[0] is the pre-header preamble (header '').
function parseIniBlocks(ini) {
  const blocks = [];
  let cur = { header: '', lines: [] };
  for (const raw of ini.split(/\r?\n/)) {
    const m = raw.match(/^\[(.+)\]\s*$/);
    if (m) { blocks.push(cur); cur = { header: m[1], lines: [raw] }; }
    else cur.lines.push(raw);
  }
  blocks.push(cur);
  return blocks;
}
function iniSetKey(block, key, value) {
  const re = new RegExp(`^${key}=.*$`);
  for (let i = 0; i < block.lines.length; i++) {
    if (re.test(block.lines[i])) { block.lines[i] = `${key}=${value}`; return; }
  }
  block.lines.splice(1, 0, `${key}=${value}`); // insert right after the [HEADER] line
}

// Turn a (typically solo/practice) race.ini into an N-car RACE on `track`:
// bump CARS, make SESSION_0 a race, and clone the player's car into AI
// opponents. Vanilla AC assigns AI to every car except CAR_0 (the player).
function buildRaceIni(ini, { track, opponents, aiLevel }) {
  let blocks = parseIniBlocks(ini);
  let model = 'tatuusfa1';
  const race = blocks.find((b) => b.header === 'RACE');
  if (race) {
    const ml = race.lines.find((l) => /^MODEL=/.test(l));
    if (ml) { const v = ml.slice(6).trim(); if (v && v !== '-') model = v; }
    iniSetKey(race, 'TRACK', track);
    iniSetKey(race, 'CONFIG_TRACK', '');
    iniSetKey(race, 'CARS', String(opponents + 1));
    iniSetKey(race, 'AI_LEVEL', String(aiLevel));
  }
  const sess = blocks.find((b) => b.header === 'SESSION_0');
  if (sess) {
    iniSetKey(sess, 'NAME', 'Race');
    iniSetKey(sess, 'TYPE', '3');            // 1=practice 2=qualify 3=race
    iniSetKey(sess, 'DURATION_MINUTES', '0'); // lap-limited (RACE_LAPS)
    // Cars must grid up on the track's START spawn set. HOTLAP_START (or a
    // missing SPAWN_SET) piles every car at the origin, where they drop from
    // the sky — CM uses START for real sessions.
    iniSetKey(sess, 'SPAWN_SET', 'START');
  }
  // Rebuild the opponent list from scratch (drop any stale CAR_1.. blocks).
  blocks = blocks.filter((b) => !/^CAR_[1-9]\d*$/.test(b.header));
  const opp = [];
  for (let i = 1; i <= opponents; i++) {
    opp.push({ header: `CAR_${i}`, lines: [
      `[CAR_${i}]`, 'SETUP=', 'SKIN=scheme_0', `MODEL=${model}`, 'MODEL_CONFIG=',
      'BALLAST=0', 'RESTRICTOR=0', `DRIVER_NAME=AI ${i}`,
      `AI_LEVEL=${Math.max(85, aiLevel - (i % 4))}`,
    ] });
  }
  const at = blocks.findIndex((b) => b.header === 'CAR_0');
  if (at >= 0) blocks.splice(at + 1, 0, ...opp); else blocks.push(...opp);
  return blocks.map((b) => b.lines.join('\n')).join('\n');
}

// Launch AC on the chosen track. Vanilla AC has no track CLI — it reads
// Documents\Assetto Corsa\cfg\race.ini at startup. We take the user's last
// (known-good) race.ini, edit it, and start acs.exe. With { race:true } we
// turn it into an N-car race with AI so the bot has rivals to learn from;
// otherwise we just swap the track (practice). Requires AC to have been
// launched normally at least once. The original race.ini is backed up once.
ipcMain.handle('rl:launchAC', (_e, { track, race, opponents = 7, aiLevel = 95 } = {}) => {
  if ([...rlProcs.values()].some((p) => RL_LIVE_SCRIPTS.has(p.script))) {
    return { ok: false, error: 'A live script is using AC right now — stop it before launching AC on another track.' };
  }
  const iniPath = path.join(app.getPath('documents'), 'Assetto Corsa', 'cfg', 'race.ini');
  if (!fs.existsSync(iniPath)) {
    return { ok: false, error: 'race.ini not found — start AC normally once (any track), then this button can re-launch it on any chosen track.' };
  }
  const acsPath = path.join(rlAcRoot(), 'acs.exe');
  if (!fs.existsSync(acsPath)) return { ok: false, error: `acs.exe not found in ${rlAcRoot()}` };
  try {
    let ini = fs.readFileSync(iniPath, 'utf8');
    const bak = iniPath + '.baptou.bak'; // preserve the user's original once
    if (!fs.existsSync(bak)) fs.writeFileSync(bak, ini);
    if (race) {
      ini = buildRaceIni(ini, { track, opponents, aiLevel });
    } else {
      const swap = (key, value) => {
        const re = new RegExp(`^${key}=.*$`, 'm');
        ini = re.test(ini) ? ini.replace(re, `${key}=${value}`) : ini;
      };
      swap('TRACK', track);
      swap('CONFIG_TRACK', '');
    }
    fs.writeFileSync(iniPath, ini);
    spawn(acsPath, [], { cwd: rlAcRoot(), detached: true, stdio: 'ignore' }).unref();
    return { ok: true, cars: race ? opponents + 1 : 1 };
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
