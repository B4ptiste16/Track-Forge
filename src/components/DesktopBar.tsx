import { useEffect, useState } from 'react';
import type { TrackProject } from '../types';
import { desktop } from '../desktop';
import { buildFileMap } from '../export/files';
import { buildTrackZip, serializeForDesktop } from '../export/zip';
import { slugify } from '../state/project';

interface Settings {
  acTracksPath?: string;
  lastRoot?: string;
  lastZipDir?: string; // where the last track package was saved
  texturePackDir?: string; // folder of real textures that override the generated ones
}

function dataUrlBytes(url: string): Uint8Array {
  const bin = atob(url.slice(url.indexOf(',') + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Texture bytes the KN5 must embed beyond the generated surfaces: the prop
// pack's own files, and any texture-pack overrides (which replace a generated
// texture of the same name). Both live beside the app, not in the renderer.
async function extraTextures(): Promise<Record<string, Uint8Array>> {
  if (!desktop) return {};
  const out: Record<string, Uint8Array> = {};
  const props = await desktop.getPropTextures();
  for (const [name, b] of Object.entries(props.textures ?? {})) out[name] = new Uint8Array(b);
  const pack = await desktop.getTexturePack();
  for (const [name, url] of Object.entries(pack.textures ?? {})) out[name] = dataUrlBytes(url);
  return out;
}

const missingNote = (missing: string[]) =>
  missing.length ? `\n\nNote: ${missing.length} texture(s) could not be found and were left out: ${missing.join(', ')}` : '';

// Desktop-only actions. Both produce a track AC can load as it stands - the
// KN5 is written here, so there is no KsEditor step.
export function DesktopBar({ project }: { project: TrackProject }) {
  const [s, setS] = useState<Settings>({});
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
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
      else if (u.state === 'error') setStatus(`Update failed: ${u.message ?? 'unknown error'}`);
    });
  }, []);

  const save = (next: Settings) => {
    setS(next);
    desktop?.setSettings(next as Record<string, string>);
  };

  const shorten = (p?: string) => (p ? (p.length > 40 ? '…' + p.slice(-38) : p) : 'not set');

  // One zip, ready to drop on Content Manager (or extract into the AC folder).
  const exportZip = async () => {
    if (!desktop || busy) return;
    setBusy(true);
    try {
      setStatus('Building track…');
      const { bytes, slug, missingTextures } = await buildTrackZip(project, { extraTextures: await extraTextures() });
      const defaultPath = s.lastZipDir ? `${s.lastZipDir}\\${slug}.zip` : `${slug}.zip`;
      const res = await desktop.saveZip(defaultPath, bytes);
      if (res.canceled) { setStatus('Export cancelled.'); return; }
      if (!res.ok || !res.path) {
        setStatus('Export failed — see dialog.');
        await desktop.showMessage('error', `Could not save the track:\n${res.path ?? ''}\n\n${res.error ?? ''}`);
        return;
      }
      const cut = Math.max(res.path.lastIndexOf('\\'), res.path.lastIndexOf('/'));
      save({ ...s, lastZipDir: res.path.slice(0, cut) });
      setStatus(`✓ Exported ${slug}.zip`);
      await desktop.showMessage('info',
        `Track exported:\n${res.path}\n\n` +
        'Drag the zip onto Content Manager to install it, or extract it into your Assetto Corsa folder. ' +
        'The KN5 model is already inside — there is nothing to compile.' + missingNote(missingTextures));
      await desktop.showItem(res.path);
    } catch (err) {
      setStatus('Export failed.');
      await desktop.showMessage('error', 'Export failed:\n' + String(err));
    } finally {
      setBusy(false);
    }
  };

  // Write the track folder straight to disk - into content/tracks, it is
  // drivable immediately. Also carries the FBX source, for editing.
  const exportFolder = async () => {
    if (!desktop || busy) return;
    setBusy(true);
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
      const { files, missingTextures } = buildFileMap(project, slug, { extraTextures: await extraTextures() });
      const res = await desktop.writeTrack(baseDir, slug, serializeForDesktop(files));
      if (!res.ok) {
        setStatus('Export failed — see dialog.');
        await desktop.showMessage('error', `Could not write to:\n${res.root}\n\n${res.error}\n\nThat location may need admin rights (e.g. Steam in Program Files). Try exporting to Documents/Desktop, then copy the folder into assettocorsa\\content\\tracks.`);
        return;
      }
      save({ ...s, acTracksPath: baseDir, lastRoot: res.root });
      setStatus(`✓ Exported to ${res.root}`);
      await desktop.showMessage('info',
        `Track exported to:\n${res.root}\n\n` +
        `Includes ${slug}.kn5 — if this is your assettocorsa\\content\\tracks folder, the track is ready to drive.` +
        missingNote(missingTextures));
      await desktop.openPath(res.root);
    } catch (err) {
      setStatus('Export failed.');
      await desktop.showMessage('error', 'Export failed:\n' + String(err));
    } finally {
      setBusy(false);
    }
  };

  const changePath = async (key: 'acTracksPath' | 'texturePackDir') => {
    if (!desktop) return;
    const picked = await desktop.pickFolder();
    if (picked) save({ ...s, [key]: picked });
  };

  return (
    <span className="desktop-bar">
      <button className="primary" onClick={exportZip} disabled={busy}
        title="Save a .zip with the KN5 and everything AC needs — drag it onto Content Manager">
        {busy ? 'Exporting…' : 'Export track'}
      </button>
      <button onClick={exportFolder} disabled={busy} title="Write the track folder to disk (e.g. straight into AC content/tracks)">Export folder</button>
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
            <b>Texture pack (optional)</b>
            <div className="muted">{s.texturePackDir ? shorten(s.texturePackDir) : 'using built-in generated textures'}</div>
            <div className="muted" style={{ fontSize: 11, lineHeight: 1.45, marginTop: 4 }}>
              Drop real textures in a folder — any file named after a surface replaces the generated
              one on export: <code>road</code>, <code>grass</code>, <code>sand</code> (gravel), <code>kerb</code>,
              {' '}<code>concrete</code>, <code>tarmac</code>, <code>dirt</code>, <code>wall</code>, <code>tree</code>.
              Must be <b>.png</b> and ideally seamless/tileable (1–2k).
            </div>
            <button className="small" onClick={() => changePath('texturePackDir')}>choose…</button>
            {s.texturePackDir && (
              <button className="small" onClick={() => save({ ...s, texturePackDir: undefined })}>use built-in</button>
            )}
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
