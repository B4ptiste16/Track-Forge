import type { TrackProject, StripCfg, StripTexture, TracksideZone, WallGap } from '../types';
import type { BuiltTrack } from '../geometry';
import { newZoneId } from '../state/project';

interface Props {
  project: TrackProject;
  built: BuiltTrack;
  onChange: (p: TrackProject) => void;
}

const TEXTURES: { v: StripTexture; label: string }[] = [
  { v: 'grass', label: 'grass' },
  { v: 'gravel', label: 'gravel' },
  { v: 'gravel_spaced', label: 'gravel (0.5m grass gap)' },
  { v: 'concrete', label: 'concrete' },
];

export function TracksidePanel({ project, built, onChange }: Props) {
  const ts = project.trackside;
  const total = Math.max(1, Math.round(built.totalLength));

  const setDefault = (side: 'left' | 'right', patch: Partial<StripCfg>) =>
    onChange({ ...project, trackside: { ...ts, [side]: { ...ts[side], ...patch } } });

  const setZone = (id: string, patch: Partial<TracksideZone>) =>
    onChange({
      ...project,
      trackside: { ...ts, zones: ts.zones.map((z) => (z.id === id ? { ...z, ...patch } : z)) },
    });
  const addZone = () =>
    onChange({
      ...project,
      trackside: {
        ...ts,
        zones: [
          ...ts.zones,
          { id: newZoneId(), side: 'right', from: 0, to: Math.min(80, total), ...ts.right },
        ],
      },
    });
  const removeZone = (id: string) =>
    onChange({ ...project, trackside: { ...ts, zones: ts.zones.filter((z) => z.id !== id) } });

  const gaps = project.wallGaps ?? [];
  const setGap = (i: number, patch: Partial<WallGap>) =>
    onChange({ ...project, wallGaps: gaps.map((g, idx) => (idx === i ? { ...g, ...patch } : g)) });

  const stripControls = (cfg: StripCfg, set: (patch: Partial<StripCfg>) => void) => (
    <div className="strip-controls">
      <select value={cfg.texture} onChange={(e) => set({ texture: e.target.value as StripTexture })}>
        {TEXTURES.map((t) => <option key={t.v} value={t.v}>{t.label}</option>)}
      </select>
      <label>width
        <input type="number" min={1} max={120} step={1} value={cfg.width}
          onChange={(e) => set({ width: Number(e.target.value) })} />
      </label>
      <label className="checkbox">
        <input type="checkbox" checked={cfg.wall} onChange={(e) => set({ wall: e.target.checked })} />
        wall
      </label>
      {cfg.wall && (
        <label>at
          <input type="number" min={0} max={200} step={1} value={cfg.wallDist ?? cfg.width}
            title="wall distance from the track edge (m)"
            onChange={(e) => set({ wallDist: Number(e.target.value) })} />
          m
        </label>
      )}
    </div>
  );

  return (
    <div className="panel">
      <h3>Trackside strips</h3>
      <p className="muted">
        One continuous strip along each side of the whole lap. Add <b>zones</b> to override a
        stretch (wider, other texture, wall further out). Tip: use <b>Select strip</b> in the 2D
        editor to pick a stretch by clicking two points on the track.
      </p>
      <div className="strip-default">
        <b>Left side</b>
        {stripControls(ts.left, (p) => setDefault('left', p))}
      </div>
      <div className="strip-default">
        <b>Right side</b>
        {stripControls(ts.right, (p) => setDefault('right', p))}
      </div>

      <h3>Zones <button className="small" onClick={addZone}>+ zone</button></h3>
      {ts.zones.length === 0 && <p className="muted">No zones — the default strips run everywhere.</p>}
      {ts.zones.map((z, i) => (
        <div key={z.id} className="zone-card">
          <div className="zone-head">
            <b>Zone {i + 1}</b>
            <select value={z.side} onChange={(e) => setZone(z.id, { side: e.target.value as TracksideZone['side'] })}>
              <option value="left">left</option>
              <option value="right">right</option>
              <option value="both">both sides</option>
            </select>
            <button className="danger small" onClick={() => removeZone(z.id)}>✕</button>
          </div>
          <label>from {Math.round(z.from)} m
            <input type="range" min={0} max={total} step={1} value={z.from}
              onChange={(e) => setZone(z.id, { from: Number(e.target.value) })} />
          </label>
          <label>to {Math.round(z.to)} m
            <input type="range" min={0} max={total} step={1} value={z.to}
              onChange={(e) => setZone(z.id, { to: Number(e.target.value) })} />
          </label>
          {stripControls(z, (p) => setZone(z.id, p))}
        </div>
      ))}

      <h3>Options</h3>
      <label className="checkbox">
        <input type="checkbox" checked={project.autoClipRunoff}
          onChange={(e) => onChange({ ...project, autoClipRunoff: e.target.checked })} />
        Auto-clip strips so they never overlap the track
      </label>

      <h3>Wall gaps <button className="small" onClick={() => onChange({ ...project, wallGaps: [...gaps, { from: 0, to: Math.min(40, total) }] })}>+ gap</button></h3>
      {gaps.length === 0 && <p className="muted">Remove the barrier over a distance range.</p>}
      {gaps.map((g, i) => (
        <div key={i} className="gap-row">
          <label>from {Math.round(g.from)} m
            <input type="range" min={0} max={total} step={1} value={g.from} onChange={(e) => setGap(i, { from: Number(e.target.value) })} />
          </label>
          <label>to {Math.round(g.to)} m
            <input type="range" min={0} max={total} step={1} value={g.to} onChange={(e) => setGap(i, { to: Number(e.target.value) })} />
          </label>
          <button className="danger small" onClick={() => onChange({ ...project, wallGaps: gaps.filter((_, idx) => idx !== i) })}>✕</button>
        </div>
      ))}
    </div>
  );
}
