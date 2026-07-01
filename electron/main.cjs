const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const isDev = !app.isPackaged;

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

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    backgroundColor: '#0f1014',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  if (isDev) {
    win.loadURL('http://localhost:5173');
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
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
    spawn(ksPath, [fbxPath], { detached: true, stdio: 'ignore' }).unref();
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
