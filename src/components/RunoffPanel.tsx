import type { TrackProject, RunoffType, SectionSide, WallGap } from '../types';
import type { BuiltTrack } from '../geometry';

interface Props {
  project: TrackProject;
  built: BuiltTrack;
  onChange: (p: TrackProject) => void;
}

const TYPES: RunoffType[] = ['grass', 'gravel', 'concrete', 'wall'];

export function RunoffPanel({ project, built, onChange }: Props) {
  const def = project.runoffDefault;
  const total = Math.max(1, Math.round(built.totalLength));
  const gaps = project.wallGaps ?? [];
  const addGap = () => onChange({ ...project, wallGaps: [...gaps, { from: 0, to: Math.min(40, total) }] });
  const setGap = (i: number, patch: Partial<WallGap>) =>
    onChange({ ...project, wallGaps: gaps.map((g, idx) => (idx === i ? { ...g, ...patch } : g)) });
  const removeGap = (i: number) => onChange({ ...project, wallGaps: gaps.filter((_, idx) => idx !== i) });

  // Section labels: S1, T1, S2, T2 … in lap order.
  let sNum = 0, tNum = 0;
  const labels = project.segments.map((seg) => (seg.kind === 'straight' ? `S${++sNum}` : `T${++tNum}`));

  const setDefault = (patch: Partial<SectionSide>) =>
    onChange({ ...project, runoffDefault: { ...def, ...patch } });

  const applyAll = () =>
    onChange({ ...project, runoff: project.segments.map(() => ({ left: { ...def }, right: { ...def } })) });

  const setSide = (i: number, side: 'left' | 'right', patch: Partial<SectionSide>) => {
    const runoff = project.runoff.map((r, idx) =>
      idx === i ? { ...r, [side]: { ...r[side], ...patch } } : r,
    );
    onChange({ ...project, runoff });
  };

  const setEscape = (cornerIndex: number, val: boolean) =>
    onChange({
      ...project,
      corners: project.corners.map((c) => (c.cornerIndex === cornerIndex ? { ...c, escape: val } : c)),
    });

  const sideControls = (i: number, side: 'left' | 'right', s: SectionSide) => (
    <div className="runoff-side">
      <span className="runoff-side-label">{side === 'left' ? 'L' : 'R'}</span>
      <select value={s.type} onChange={(e) => setSide(i, side, { type: e.target.value as RunoffType })}>
        {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
      <input type="number" min={0} max={120} step={1} value={s.dist} title="width / wall distance (m)"
        onChange={(e) => setSide(i, side, { dist: Number(e.target.value) })} />
      <label title="barrier at outer edge">
        <input type="checkbox" checked={s.wall} onChange={(e) => setSide(i, side, { wall: e.target.checked })} />
        wall
      </label>
    </div>
  );

  return (
    <div className="panel">
      <h3>Runoff &amp; barriers</h3>
      <p className="muted">
        Each side: <b>type</b> · <b>distance (m)</b> · <b>wall</b>. The number is the runoff
        width — or, for type <b>wall</b>, the distance from the track edge to the barrier
        (0 = wall touching the track).
      </p>
      <label className="checkbox">
        <input type="checkbox" checked={project.autoClipRunoff}
          onChange={(e) => onChange({ ...project, autoClipRunoff: e.target.checked })} />
        Auto-clip so runoff never overlaps the track
      </label>

      <div className="runoff-default">
        <span className="muted">Default:</span>
        <select value={def.type} onChange={(e) => setDefault({ type: e.target.value as RunoffType })}>
          {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input type="number" min={0} max={120} step={1} value={def.dist}
          onChange={(e) => setDefault({ dist: Number(e.target.value) })} />
        <label><input type="checkbox" checked={def.wall} onChange={(e) => setDefault({ wall: e.target.checked })} />wall</label>
        <button className="small" onClick={applyAll}>apply to all</button>
      </div>

      <div className="runoff-list">
        {project.segments.map((_, i) => (
          <div key={i} className="runoff-row">
            <div className="runoff-row-title">{labels[i]}</div>
            {project.runoff[i] && sideControls(i, 'left', project.runoff[i].left)}
            {project.runoff[i] && sideControls(i, 'right', project.runoff[i].right)}
          </div>
        ))}
      </div>

      <h3>Wall gaps (remove a stretch of barrier)</h3>
      <button className="small" onClick={addGap}>+ gap</button>
      {gaps.length === 0 && <p className="muted">No gaps. Add one to remove the barrier over a distance range.</p>}
      {gaps.map((g, i) => (
        <div key={i} className="gap-row">
          <label>from {Math.round(g.from)} m
            <input type="range" min={0} max={total} step={1} value={g.from} onChange={(e) => setGap(i, { from: Number(e.target.value) })} />
          </label>
          <label>to {Math.round(g.to)} m
            <input type="range" min={0} max={total} step={1} value={g.to} onChange={(e) => setGap(i, { to: Number(e.target.value) })} />
          </label>
          <button className="danger small" onClick={() => removeGap(i)}>✕</button>
        </div>
      ))}

      {project.corners.length > 0 && (
        <>
          <h3>Escape roads</h3>
          <p className="muted">Paved (concrete) escape on the outside of a corner, no wall.</p>
          {project.corners.map((c) => (
            <label key={c.cornerIndex} className="checkbox">
              <input type="checkbox" checked={!!c.escape} onChange={(e) => setEscape(c.cornerIndex, e.target.checked)} />
              T{c.cornerIndex + 1} escape road
            </label>
          ))}
        </>
      )}
    </div>
  );
}
