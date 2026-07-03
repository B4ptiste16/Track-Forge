import { useState } from 'react';
import type { TrackProject, Theme, Direction, KerbType, ElevationPoint } from '../types';
import type { BuiltTrack } from '../geometry';

interface Props {
  project: TrackProject;
  built: BuiltTrack;
  onChange: (p: TrackProject) => void;
}

const KERBS: KerbType[] = ['none', 'flat', 'serrated', 'ripple', 'sausage', 'tall', 'combo'];

export function InputsPanel({ project, built, onChange }: Props) {
  const total = Math.max(1, Math.round(built.totalLength));
  const [elevDist, setElevDist] = useState(0);
  const [elevHeight, setElevHeight] = useState(0);

  const meta = (patch: Partial<TrackProject['meta']>) =>
    onChange({ ...project, meta: { ...project.meta, ...patch } });
  const road = (patch: Partial<TrackProject['road']>) =>
    onChange({ ...project, road: { ...project.road, ...patch } });
  const grid = (patch: Partial<TrackProject['grid']>) =>
    onChange({ ...project, grid: { ...project.grid, ...patch } });
  const pit = (patch: Partial<TrackProject['pit']>) =>
    onChange({ ...project, pit: { ...project.pit, ...patch } });
  const walls = (patch: Partial<TrackProject['walls']>) =>
    onChange({ ...project, walls: { ...project.walls, ...patch } });
  const bridge = (patch: Partial<TrackProject['bridge']>) =>
    onChange({ ...project, bridge: { ...project.bridge, ...patch } });

  const setElevationPoint = () => {
    const pts = project.elevation.filter((p) => Math.abs(p.dist - elevDist) > 1);
    pts.push({ dist: elevDist, height: elevHeight });
    pts.sort((a, b) => a.dist - b.dist);
    onChange({ ...project, elevation: pts });
  };
  const removeElev = (p: ElevationPoint) =>
    onChange({ ...project, elevation: project.elevation.filter((q) => q !== p) });

  return (
    <div className="panel">
      <h3>Track</h3>
      <div className="field">
        <label>Name<input value={project.meta.name} onChange={(e) => meta({ name: e.target.value })} /></label>
        <label>Author<input value={project.meta.author} onChange={(e) => meta({ author: e.target.value })} /></label>
        <label>Country<input value={project.meta.country} onChange={(e) => meta({ country: e.target.value })} /></label>
        <label>Theme
          <select value={project.meta.theme} onChange={(e) => meta({ theme: e.target.value as Theme })}>
            <option value="tarmac_day">Tarmac — day</option>
            <option value="tarmac_dusk">Tarmac — dusk</option>
            <option value="desert">Desert</option>
            <option value="france">France 🇫🇷</option>
          </select>
        </label>
        {project.meta.theme === 'france' && (
          <p className="muted">Bleu-blanc-rouge kerbs, a giant tricolore at turn&nbsp;1, grandstands on the main straight &amp; turn&nbsp;1, and a tricolor start/finish arch.</p>
        )}
        <label>Direction
          <select value={project.meta.direction} onChange={(e) => meta({ direction: e.target.value as Direction })}>
            <option value="cw">Clockwise</option>
            <option value="ccw">Counter-clockwise</option>
          </select>
        </label>
      </div>

      <h3>Road</h3>
      <div className="field">
        <label>Width
          <input type="number" min={4} max={30} step={0.5} value={project.road.width}
            onChange={(e) => road({ width: Number(e.target.value) })} /> m
        </label>
        <label>Default kerb
          <select value={project.road.defaultKerb} onChange={(e) => road({ defaultKerb: e.target.value as KerbType })}>
            {KERBS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </label>
      </div>

      <h3>Elevation</h3>
      <div className="field">
        <label>Position: {elevDist} m
          <input type="range" min={0} max={total} step={1} value={elevDist}
            onChange={(e) => setElevDist(Number(e.target.value))} />
        </label>
        <label>Height
          <input type="number" step={0.5} value={elevHeight}
            onChange={(e) => setElevHeight(Number(e.target.value))} /> m
        </label>
        <button onClick={setElevationPoint}>Set height here</button>
        <ul className="mini-list">
          {project.elevation.length === 0 && <li className="muted">Flat (no points)</li>}
          {project.elevation.map((p) => (
            <li key={p.dist}>
              {Math.round(p.dist)} m → {p.height} m
              <button className="danger small" onClick={() => removeElev(p)}>✕</button>
            </li>
          ))}
        </ul>
      </div>

      <h3>Start / Finish</h3>
      <div className="field">
        <label>Position: {Math.round(project.startFinishDist)} m
          <input type="range" min={0} max={total} step={1} value={project.startFinishDist}
            onChange={(e) => onChange({ ...project, startFinishDist: Number(e.target.value) })} />
        </label>
      </div>

      <h3>Grid</h3>
      <div className="field">
        <label>Pit boxes
          <input type="number" min={1} max={40} value={project.grid.pits}
            onChange={(e) => grid({ pits: Math.max(1, Number(e.target.value)) })} />
        </label>
        <label>Grid slots
          <input type="number" min={1} max={40} value={project.grid.starts}
            onChange={(e) => grid({ starts: Math.max(1, Number(e.target.value)) })} />
        </label>
      </div>

      <h3>Pit lane</h3>
      <div className="field">
        <label className="checkbox">
          <input type="checkbox" checked={project.pit.enabled} onChange={(e) => pit({ enabled: e.target.checked })} />
          Generate pit lane (1PIT)
        </label>
        {project.pit.enabled && (
          <>
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
            <label>Entry: {Math.round(project.pit.entry)} m
              <input type="range" min={0} max={total} step={1} value={project.pit.entry}
                onChange={(e) => pit({ entry: Number(e.target.value) })} />
            </label>
            <label>Exit: {Math.round(project.pit.exit)} m
              <input type="range" min={0} max={total} step={1} value={project.pit.exit}
                onChange={(e) => pit({ exit: Number(e.target.value) })} />
            </label>
            <label>Speed-limit start: {Math.round(project.pit.limitFrom)} m
              <input type="range" min={0} max={total} step={1} value={project.pit.limitFrom}
                onChange={(e) => pit({ limitFrom: Number(e.target.value) })} />
            </label>
            <label>Speed-limit end: {Math.round(project.pit.limitTo)} m
              <input type="range" min={0} max={total} step={1} value={project.pit.limitTo}
                onChange={(e) => pit({ limitTo: Number(e.target.value) })} />
            </label>
            <p className="muted">Entry/exit set the pit-lane geometry. The speed-limit zone is saved with the project; AC enforces it via the pit AI spline (pit_lane.ai), which the exporter will generate in a later step.</p>
          </>
        )}
      </div>

      <h3>Walls</h3>
      <div className="field">
        <label className="checkbox">
          <input type="checkbox" checked={project.walls.enabled} onChange={(e) => walls({ enabled: e.target.checked })} />
          Generate barriers (1WALL)
        </label>
        {project.walls.enabled && (
          <>
            <label>Height
              <input type="number" min={0.5} max={10} step={0.5} value={project.walls.height}
                onChange={(e) => walls({ height: Number(e.target.value) })} /> m
            </label>
            <label>Style
              <select value={project.walls.style} onChange={(e) => walls({ style: e.target.value as 'solid' | 'blocks' })}>
                <option value="solid">Solid wall</option>
                <option value="blocks">Tyre / poly blocks</option>
              </select>
            </label>
          </>
        )}
      </div>

      <h3>Bridges / overpasses</h3>
      <div className="field">
        <label className="checkbox">
          <input type="checkbox" checked={project.bridge.auto} onChange={(e) => bridge({ auto: e.target.checked })} />
          Auto-bridge self-crossings
        </label>
        <p className="muted">
          {built.overlaps.length === 0
            ? 'No self-crossings detected.'
            : `${built.overlaps.length} crossing(s) → raised into overpass(es).`}
        </p>
        {project.bridge.auto && (
          <>
            <label>Incline: {(project.bridge.incline * 100).toFixed(0)}%
              <input type="range" min={2} max={15} step={1} value={Math.round(project.bridge.incline * 100)}
                onChange={(e) => bridge({ incline: Number(e.target.value) / 100 })} />
            </label>
            <label>Clearance
              <input type="number" min={3} max={12} step={0.5} value={project.bridge.clearance}
                onChange={(e) => bridge({ clearance: Number(e.target.value) })} /> m
            </label>
          </>
        )}
      </div>
    </div>
  );
}
