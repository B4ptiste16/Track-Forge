import { useEffect, useState } from 'react';
import type { TrackProject } from '../types';
import { desktop } from '../desktop';
import { buildFileMap } from '../export/files';
import { serializeForDesktop } from '../export/zip';

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

  useEffect(() => {
    desktop?.getSettings().then((v) => setS(v as Settings));
  }, []);

  const save = (next: Settings) => {
    setS(next);
    desktop?.setSettings(next as Record<string, string>);
  };

  const shorten = (p?: string) => (p ? (p.length > 40 ? '…' + p.slice(-38) : p) : 'not set');

  const exportFolder = async () => {
    if (!desktop) return;
    let base = s.acTracksPath;
    if (!base) {
      base = (await desktop.pickFolder()) ?? undefined;
      if (!base) return;
    }
    const { slug, files } = buildFileMap(project);
    const { root, fbxPath } = await desktop.writeTrack(base, slug, serializeForDesktop(files));
    save({ ...s, acTracksPath: base, lastFbx: fbxPath ?? undefined, lastRoot: root });
    setStatus(`Wrote track to ${root}`);
  };

  const openKs = async () => {
    if (!desktop) return;
    let ks = s.ksEditorPath;
    if (!ks) {
      ks = (await desktop.pickFile([{ name: 'KsEditor', extensions: ['exe'] }])) ?? undefined;
      if (!ks) return;
      save({ ...s, ksEditorPath: ks });
    }
    if (!s.lastFbx) {
      setStatus('Export the track to a folder first.');
      return;
    }
    const r = await desktop.openInKsEditor(ks, s.lastFbx);
    setStatus(r.ok ? 'Opened FBX in KsEditor — assign shaders if needed, then Export KN5.' : r.error || 'Failed');
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
        </div>
      )}
    </span>
  );
}
