// The track library — what you land on when you open Track Forge.
// A circuit the size of Monza is not a one-sitting job, so the app has to
// remember your tracks and keep working on them, instead of starting at an
// empty page and asking you to re-upload a .json every time.
import { useEffect, useState } from 'react';
import { desktop } from '../desktop';
import type { SavedTrack } from '../desktop';

export function TrackLibrary({
  onOpen, onNew, onHome,
}: {
  onOpen: (id: string) => void;
  onNew: () => void;
  onHome: () => void;
}) {
  const [tracks, setTracks] = useState<SavedTrack[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = () => {
    desktop?.tracksList().then((t) => { setTracks(t); setLoaded(true); });
  };
  useEffect(refresh, []);

  const del = async (t: SavedTrack) => {
    const ok = await desktop!.confirm(
      `Delete "${t.name}"?`,
      'This removes it from your library. Tracks you already exported to Assetto Corsa are not affected.',
      ['Delete', 'Cancel'],
    );
    if (ok !== 0) return;
    await desktop!.trackDelete(t.id);
    refresh();
  };

  const ago = (ms: number) => {
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} h ago`;
    return `${Math.round(h / 24)} d ago`;
  };

  return (
    <div className="app">
      <header className="toolbar">
        <button onClick={onHome} title="Back to home">⌂</button>
        <div className="brand">🏁 My tracks</div>
        <div className="spacer" />
        {desktop && <button className="small" onClick={() => desktop!.tracksReveal()}>open folder</button>}
        <button className="primary" onClick={onNew}>+ New track</button>
      </header>

      <div className="lib-body">
        {!loaded && <div className="muted">Loading…</div>}
        {loaded && tracks.length === 0 && (
          <div className="lib-empty">
            <h3>No tracks yet</h3>
            <p className="muted">
              Start a new circuit — it saves itself as you work, and shows up here next time you
              open the app. You can also build one from a written instruction sheet.
            </p>
            <button className="primary" onClick={onNew}>+ New track</button>
          </div>
        )}
        <div className="lib-grid">
          {tracks.map((t) => (
            <div key={t.id} className="lib-card" onDoubleClick={() => onOpen(t.id)}>
              <div className="lib-name" title={t.name}>{t.name}</div>
              <div className="muted lib-meta">
                {t.segments} segment{t.segments === 1 ? '' : 's'}
                {t.length > 0 && ` · ${(t.length / 1000).toFixed(2)} km`}
              </div>
              <div className="muted lib-meta">saved {ago(t.savedAt)}</div>
              <div className="lib-actions">
                <button className="primary small" onClick={() => onOpen(t.id)}>Open</button>
                <button className="small danger" onClick={() => del(t)}>delete</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
