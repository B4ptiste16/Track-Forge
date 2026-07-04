import { useEffect, useState } from 'react';
import type { TrackProject } from '../types';
import { desktop } from '../desktop';
import { buildFileMap } from '../export/files';
import { serializeForDesktop } from '../export/zip';
import { slugify } from '../state/project';

interface Settings {
  acTracksPath?: string;
  ksEditorPath?: string;
  lastFbx?: string;
  lastRoot?: string;
}

// Desktop-only actions: write the track folder straight to disk (e.g. into AC's
// content/tracks) and launch KsEditor on the FBX. Rendered only in the app build.
export function DesktopBar({ project }: { project: TrackProject }) {
  const [s, setS] = useState<Settings>({});
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState('');

  useEffect(() => {
    desktop?.getSettings().then((v) => setS(v as Settings));
    desktop?.getVersion().then(setVersion);
    desktop?.onUpdateStatus((u) => {
      if (u.state === 'checking') setStatus('Checking for updates…');
      else if (u.state === 'available') setStatus(`Update v${u.version} found — downloading…`);
      else if (u.state === 'downloading') setStatus(`Downloading update… ${u.percent ?? 0}%`);
      else if (u.state === 'downloaded') setStatus('Update ready — restart to install.');
      else if (u.state === 'none') setStatus('Up to date.');
      else if (u.state === 'error') setStatus('Update check failed.');
    });
  }, []);

  const save = (next: Settings) => {
    setS(next);
    desktop?.setSettings(next as Record<string, string>);
  };

  const shorten = (p?: string) => (p ? (p.length > 40 ? '…' + p.slice(-38) : p) : 'not set');

  const exportFolder = async () => {
    if (!desktop) return;
    try {
      // Real Save-As: browse anywhere, type/keep the track-folder name.
      const defaultName = slugify(project.meta.name);
      const defaultPath = s.acTracksPath ? `${s.acTracksPath}\\${defaultName}` : defaultName;
      const picked = await desktop.pickSavePath(defaultPath);
      if (!picked) { setStatus('Export cancelled.'); return; }
      const cut = Math.max(picked.lastIndexOf('\\'), picked.lastIndexOf('/'));
      const baseDir = cut > 0 ? picked.slice(0, cut) : picked;
      const slug = slugify(picked.slice(cut + 1)) || defaultName;

      setStatus('Writing files…');
      const { files } = buildFileMap(project, slug);
      const res = await desktop.writeTrack(baseDir, slug, serializeForDesktop(files));
      if (!res.ok) {
        setStatus('Export failed — see dialog.');
        await desktop.showMessage('error', `Could not write to:\n${res.root}\n\n${res.error}\n\nThat location may need admin rights (e.g. Steam in Program Files). Try exporting to Documents/Desktop, then copy the folder into assettocorsa\\content\\tracks.`);
        return;
      }
      save({ ...s, acTracksPath: baseDir, lastFbx: res.fbxPath ?? undefined, lastRoot: res.root });
      setStatus(`✓ Exported to ${res.root}`);
      await desktop.showMessage('info', `Track exported to:\n${res.root}\n\n${files.length} files — FBX (+ .fbx.ini auto-textures), textures, surfaces, ui, ai/fast_lane.ai.\n\nThe folder is now open in Explorer.`);
      await desktop.openPath(res.root);
    } catch (err) {
      setStatus('Export failed.');
      await desktop.showMessage('error', 'Export failed:\n' + String(err));
    }
  };

  const openKs = async () => {
    if (!desktop) return;
    try {
      let ks = s.ksEditorPath;
      if (!ks) {
        setStatus('Select KsEditor.exe (usually assettocorsa\\sdk\\editor)…');
        ks = (await desktop.pickFile([{ name: 'KsEditor', extensions: ['exe'] }])) ?? undefined;
        if (!ks) { setStatus('Cancelled (KsEditor.exe not selected).'); return; }
        save({ ...s, ksEditorPath: ks });
      }
      if (!s.lastFbx) {
        setStatus('Export first.');
        await desktop.showMessage('warning', 'Export the track to a folder first, then Open in KsEditor.');
        return;
      }
      const r = await desktop.openInKsEditor(ks, s.lastFbx);
      if (r.ok) {
        setStatus('✓ KsEditor launched — File → Import FBX → Export KN5 (textures auto-assign).');
        if (s.lastRoot) await desktop.openPath(s.lastRoot); // show the folder with the fbx
      } else {
        setStatus('KsEditor failed.');
        await desktop.showMessage('error', 'Could not launch KsEditor:\n' + (r.error || 'failed'));
      }
    } catch (err) {
      setStatus('Open failed.');
      await desktop.showMessage('error', 'Open in KsEditor failed:\n' + String(err));
    }
  };

  const changePath = async (key: 'acTracksPath' | 'ksEditorPath') => {
    if (!desktop) return;
    const picked =
      key === 'ksEditorPath'
        ? await desktop.pickFile([{ name: 'KsEditor', extensions: ['exe'] }])
        : await desktop.pickFolder();
    if (picked) save({ ...s, [key]: picked });
  };

  return (
    <span className="desktop-bar">
      <button onClick={exportFolder} title="Write the track folder to disk (AC content/tracks)">Export folder</button>
      <button onClick={openKs} title="Open the exported FBX in KsEditor">Open in KsEditor</button>
      <button onClick={() => setOpen((o) => !o)} title="Desktop settings">⚙</button>
      {status && <span className="muted desktop-status">{status}</span>}
      {open && (
        <div className="desktop-settings">
          <div>
            <b>AC tracks folder</b>
            <div className="muted">{shorten(s.acTracksPath)}</div>
            <button className="small" onClick={() => changePath('acTracksPath')}>choose…</button>
          </div>
          <div>
            <b>KsEditor.exe</b>
            <div className="muted">{shorten(s.ksEditorPath)}</div>
            <button className="small" onClick={() => changePath('ksEditorPath')}>choose…</button>
          </div>
          {s.lastRoot && (
            <button className="small" onClick={() => desktop?.openPath(s.lastRoot!)}>open last export folder</button>
          )}
          <div>
            <b>Updates</b>
            <div className="muted">Version {version || '…'}</div>
            <button className="small" onClick={() => desktop?.checkForUpdates()}>Check for updates</button>
          </div>
        </div>
      )}
    </span>
  );
}
