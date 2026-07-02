import type { ReactNode } from 'react';
import type { KerbType } from '../types';

// Placeholder preview art per kerb profile (inline SVG — no external files).
// Red/white striped for painted kerbs, yellow domes for raised "sausage" kerbs.
export function KerbSwatch({
  type,
  kerbColor,
  kerbHiColor,
}: {
  type: KerbType;
  kerbColor: string;
  kerbHiColor: string;
}) {
  const W = 64;
  const H = 40;
  const road = 32; // road surface line
  const white = '#e9e9e9';

  // Vertical red/white stripes across [x0,x1] with a per-stripe top height.
  const stripes = (x0: number, x1: number, count: number, h: (i: number) => number): ReactNode => {
    const w = (x1 - x0) / count;
    const out: ReactNode[] = [];
    for (let i = 0; i < count; i++) {
      const top = road - h(i);
      out.push(
        <rect key={i} x={x0 + i * w} y={top} width={w + 0.4} height={road - top} fill={i % 2 ? white : kerbColor} />,
      );
    }
    return out;
  };

  // A rounded yellow "sausage" dome across [x0,x1].
  const dome = (x0: number, x1: number, height: number): ReactNode => {
    const mid = (x0 + x1) / 2;
    return (
      <path
        d={`M${x0} ${road} Q${mid} ${road - height} ${x1} ${road} Z`}
        fill={kerbHiColor}
        stroke={kerbHiColor}
      />
    );
  };

  let content: ReactNode = null;
  if (type === 'flat') content = stripes(6, 58, 9, () => 5);
  else if (type === 'serrated') content = stripes(6, 58, 9, (i) => (i % 2 ? 12 : 3));
  else if (type === 'ripple') content = stripes(6, 58, 12, (i) => 4 + 4 * Math.abs(Math.sin(i * 0.9)));
  else if (type === 'sausage') content = dome(8, 56, 15);
  else if (type === 'tall') content = dome(10, 54, 24);
  else if (type === 'combo')
    content = (
      <>
        {stripes(6, 36, 5, () => 6)}
        {dome(36, 58, 20)}
      </>
    );

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
      <rect x={0} y={road} width={W} height={H - road} fill="#2a2a2e" />
      {content}
      {type === 'none' && <line x1={6} y1={road} x2={58} y2={road} stroke="#666" strokeDasharray="3 3" />}
    </svg>
  );
}
