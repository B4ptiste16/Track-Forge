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
