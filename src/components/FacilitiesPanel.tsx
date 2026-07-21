import type { TrackProject, Building } from '../types';
import type { BuiltTrack } from '../geometry';

interface Props {
  project: TrackProject;
  built: BuiltTrack;
  onChange: (p: TrackProject) => void;
}

let bCounter = 0;
export function newBuildingId(): string {
  return `bldg_${Date.now().toString(36)}_${bCounter++}`;
}

export function FacilitiesPanel({ project, built, onChange }: Props) {
  const total = Math.max(1, Math.round(built.totalLength));
  const pit = (patch: Partial<TrackProject['pit']>) =>
    onChange({ ...project, pit: { ...project.pit, ...patch } });

  const setB = (id: string, patch: Partial<Building>) =>
    onChange({ ...project, buildings: project.buildings.map((b) => (b.id === id ? { ...b, ...patch } : b)) });
  const addB = () => {
    // drop the new building near the start of the track, off to the side
    const s = built.centerline[0];
    const b: Building = {
      id: newBuildingId(),
      x: Math.round((s?.pos[0] ?? 0) + 30), y: Math.round((s?.pos[1] ?? 0) - 30),
      w: 20, d: 12, h: 6, rot: 0,
    };
    onChange({ ...project, buildings: [...project.buildings, b] });
  };
  const removeB = (id: string) =>
    onChange({ ...project, buildings: project.buildings.filter((b) => b.id !== id) });

  const num = (b: Building, key: keyof Building, label: string, min: number, max: number, step = 1) => (
    <label className="bldg-num">{label}
      <input type="number" min={min} max={max} step={step} value={b[key] as number}
        onChange={(e) => setB(b.id, { [key]: Number(e.target.value) } as Partial<Building>)} />
    </label>
  );

  return (
    <div className="panel">
      <h3>Pit lane</h3>
      <label className="checkbox">
        <input type="checkbox" checked={project.pit.enabled} onChange={(e) => pit({ enabled: e.target.checked })} />
        Generate pit lane (1PIT)
      </label>
      {project.pit.enabled && (
        <>
          <div className="field-row">
            <label>Side
              <select value={project.pit.side} onChange={(e) => pit({ side: e.target.value as 'left' | 'right' })}>
                <option value="left">Left</option>
                <option value="right">Right</option>
              </select>
            </label>
            <label>Width
              <input type="number" min={3} max={20} step={0.5} value={project.pit.width}
                onChange={(e) => pit({ width: Number(e.target.value) })} /> m
            </label>
          </div>
          <label>Entry: {Math.round(project.pit.entry)} m
            <input type="range" min={0} max={total} step={1} value={project.pit.entry}
              onChange={(e) => pit({ entry: Number(e.target.value) })} />
          </label>
          <label>Exit: {Math.round(project.pit.exit)} m
            <input type="range" min={0} max={total} step={1} value={project.pit.exit}
              onChange={(e) => pit({ exit: Number(e.target.value) })} />
            <span className="muted" style={{ fontSize: 11 }}>
              exit BEFORE entry = pit lane crosses the start/finish line
            </span>
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={project.pit.paddock ?? true} onChange={(e) => pit({ paddock: e.target.checked })} />
            Paddock beside the lane (track-day pit boxes on it)
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={project.pit.structures ?? true} onChange={(e) => pit({ structures: e.target.checked })} />
            Pit structures — wall vs track, garages, painted box lines
          </label>
        </>
      )}

      <h3>Buildings <button className="small" onClick={addB}>+ building</button></h3>
      <p className="muted">
        Decorative boxes (visual only in AC). Tip: use <b>Place building</b> in the 2D editor
        to drop one exactly where you click, then fine-tune it here.
      </p>
      {project.buildings.length === 0 && <p className="muted">None yet.</p>}
      {project.buildings.map((b, i) => (
        <div key={b.id} className="zone-card">
          <div className="zone-head">
            <b>Building {i + 1}</b>
            <button className="danger small" onClick={() => removeB(b.id)}>✕</button>
          </div>
          <div className="bldg-grid">
            {num(b, 'x', 'x', -5000, 5000)}
            {num(b, 'y', 'y', -5000, 5000)}
            <label className="bldg-num">style
              <select value={b.kind ?? 'offices'}
                onChange={(e) => setB(b.id, { kind: e.target.value as Building['kind'] })}>
                <option value="offices">offices</option>
                <option value="glass">glass tower</option>
                <option value="brick">brick</option>
                <option value="hangar">metal hangar</option>
              </select>
            </label>
            {num(b, 'rot', 'rot°', -180, 180, 5)}
            {num(b, 'w', 'len', 2, 200)}
            {num(b, 'd', 'depth', 2, 100)}
            {num(b, 'h', 'height', 2, 60)}
          </div>
        </div>
      ))}
    </div>
  );
}
