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
const INSIDE_SURFACES = ['grass', 'gravel', 'concrete'] as const;

export function KerbConfig({ project, customize, onCustomizeChange, onChange }: Props) {
  const pal = THEME_PALETTES[project.meta.theme];

  const setPart = (cornerIndex: number, part: Part, value: KerbType) => {
    const corners = project.corners.map((c) =>
      c.cornerIndex === cornerIndex ? ({ ...c, [part]: value } as CornerConfig) : c,
    );
    onChange({ ...project, corners });
  };

  const setCorner = (cornerIndex: number, patch: Partial<CornerConfig>) => {
    const corners = project.corners.map((c) =>
      c.cornerIndex === cornerIndex ? { ...c, ...patch } : c,
    );
    onChange({ ...project, corners });
  };

  // Numeric field that shows a placeholder default and stores undefined when cleared.
  const num = (
    c: CornerConfig,
    key: 'kerbWidth' | 'entryLen' | 'apexLen' | 'exitLen',
    label: string,
    placeholder: string,
    max: number,
  ) => (
    <label className="kerb-num" title={`${label} — leave empty for the default (${placeholder})`}>
      <span className="kerb-part-label">{label}</span>
      <input
        type="number" min={0} max={max} step={0.5}
        value={c[key] ?? ''}
        placeholder={placeholder}
        onChange={(e) =>
          setCorner(c.cornerIndex, { [key]: e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)) })
        }
      />
    </label>
  );

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
            <div className="kerb-nums">
              {num(c, 'kerbWidth', 'width m', 'auto', 5)}
              {num(c, 'entryLen', 'entry m', '25', 200)}
              {num(c, 'apexLen', 'apex m', '60%', 400)}
              {num(c, 'exitLen', 'exit m', '30', 200)}
              <label className="kerb-num" title="Surface filling the inside of this corner">
                <span className="kerb-part-label">inside</span>
                <select
                  value={c.insideSurface ?? 'grass'}
                  onChange={(e) => setCorner(c.cornerIndex, { insideSurface: e.target.value as CornerConfig['insideSurface'] })}
                >
                  {INSIDE_SURFACES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
            </div>
          </div>
        ))}
    </div>
  );
}
