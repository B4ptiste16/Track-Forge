import type { Segment } from '../types';
import { newSegId } from '../state/project';

interface Props {
  segments: Segment[];
  onChange: (segs: Segment[]) => void;
}

export function SegmentList({ segments, onChange }: Props) {
  const add = (seg: Segment) => onChange([...segments, seg]);
  const addStraight = () => add({ id: newSegId(), kind: 'straight', length: 100 });
  const addCorner = (dir: 'left' | 'right') =>
    add({ id: newSegId(), kind: 'corner', radius: 40, angle: 90, dir });
  // A quick S-bend chicane: two opposite tight corners.
  const addChicane = () =>
    onChange([
      ...segments,
      { id: newSegId(), kind: 'corner', radius: 18, angle: 45, dir: 'right' },
      { id: newSegId(), kind: 'corner', radius: 18, angle: 45, dir: 'left' },
    ]);

  const update = (i: number, patch: Partial<Segment>) => {
    const next = segments.map((s, idx) => (idx === i ? ({ ...s, ...patch } as Segment) : s));
    onChange(next);
  };
  const remove = (i: number) => onChange(segments.filter((_, idx) => idx !== i));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= segments.length) return;
    const next = [...segments];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  let cornerN = 0;

  return (
    <div className="panel">
      <h3>Segments</h3>
      <div className="palette">
        <button onClick={addStraight}>+ Straight</button>
        <button onClick={() => addCorner('left')}>+ Corner ◀ L</button>
        <button onClick={() => addCorner('right')}>+ Corner ▶ R</button>
        <button onClick={addChicane}>+ Chicane</button>
      </div>

      <div className="seg-list">
        {segments.length === 0 && <p className="muted">No segments yet. Add one above.</p>}
        {segments.map((s, i) => {
          const label =
            s.kind === 'corner' ? `T${++cornerN} ${s.dir === 'left' ? '◀' : '▶'}` : 'Straight';
          return (
            <div key={s.id} className="seg-row">
              <span className="seg-label">{label}</span>
              {s.kind === 'straight' ? (
                <label>
                  len
                  <input
                    type="number"
                    value={s.length}
                    min={1}
                    step={5}
                    onChange={(e) => update(i, { length: Number(e.target.value) })}
                  />
                  m
                </label>
              ) : (
                <>
                  <label>
                    r
                    <input
                      type="number"
                      value={s.radius}
                      min={1}
                      step={5}
                      onChange={(e) => update(i, { radius: Number(e.target.value) })}
                    />
                    m
                  </label>
                  <label>
                    ∠
                    <input
                      type="number"
                      value={s.angle}
                      min={1}
                      max={359}
                      step={5}
                      onChange={(e) => update(i, { angle: Number(e.target.value) })}
                    />
                    °
                  </label>
                </>
              )}
              <span className="seg-actions">
                <button onClick={() => move(i, -1)} title="Move up">↑</button>
                <button onClick={() => move(i, 1)} title="Move down">↓</button>
                <button onClick={() => remove(i)} title="Delete" className="danger">✕</button>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
