import type { TrackProject, KerbType, CornerConfig } from '../types';
import { THEME_PALETTES } from '../state/project';
import { KerbSwatch } from './KerbSwatch';

interface Props {
  project: TrackProject;
  customize: boolean;
  onCustomizeChange: (v: boolean) => void;
  onChange: (p: TrackProject) => void;
}

const KERBS: KerbType[] = ['none', 'flat', 'serrated', 'ripple', 'sausage', 'tall', 'combo'];
type Part = 'entry' | 'apex' | 'exit';

export function KerbConfig({ project, customize, onCustomizeChange, onChange }: Props) {
  const pal = THEME_PALETTES[project.meta.theme];

  const setPart = (cornerIndex: number, part: Part, value: KerbType) => {
    const corners = project.corners.map((c) =>
      c.cornerIndex === cornerIndex ? ({ ...c, [part]: value } as CornerConfig) : c,
    );
    onChange({ ...project, corners });
  };

  return (
    <div className="panel">
      <h3>Kerbs</h3>
      <label className="checkbox">
        <input type="checkbox" checked={customize} onChange={(e) => onCustomizeChange(e.target.checked)} />
        Customize kerbs per corner
      </label>

      {!customize && (
        <p className="muted">
          Every corner uses the default kerb (<b>{project.road.defaultKerb}</b>). Tick the box to set
          Entry / Apex / Exit per corner.
        </p>
      )}

      {customize && project.corners.length === 0 && (
        <p className="muted">No corners yet — add a corner segment.</p>
      )}

      {customize &&
        project.corners.map((c) => (
          <div key={c.cornerIndex} className="kerb-corner">
            <div className="kerb-corner-title">T{c.cornerIndex + 1}</div>
            <div className="kerb-parts">
              {(['entry', 'apex', 'exit'] as Part[]).map((part) => (
                <div key={part} className="kerb-part">
                  <span className="kerb-part-label">{part}</span>
                  <KerbSwatch type={c[part]} kerbColor={pal.kerb} kerbHiColor={pal.kerbHi} />
                  <select value={c[part]} onChange={(e) => setPart(c.cornerIndex, part, e.target.value as KerbType)}>
                    {KERBS.map((k) => <option key={k} value={k}>{k}</option>)}
                  </select>
                </div>
              ))}
            </div>
          </div>
        ))}
    </div>
  );
}
