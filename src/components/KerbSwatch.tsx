import type { ReactNode } from 'react';
import type { KerbType } from '../types';

// Placeholder preview art for each kerb profile, drawn as inline SVG so the
// build never depends on external image files. Real textures can replace these.
export function KerbSwatch({ type, kerbColor }: { type: KerbType; kerbColor: string }) {
  const w = 64;
  const h = 28;
  const base = 22; // baseline (road surface) y

  let shape: ReactNode = null;
  if (type === 'flat') {
    shape = <rect x={6} y={base - 5} width={52} height={5} fill={kerbColor} />;
  } else if (type === 'sausage') {
    shape = <path d={`M6 ${base} Q32 ${base - 18} 58 ${base}`} fill={kerbColor} stroke={kerbColor} />;
  } else if (type === 'serrated') {
    const teeth = [];
    for (let i = 0; i < 6; i++) {
      const x = 8 + i * 8;
      teeth.push(`M${x} ${base} L${x + 4} ${base - 8} L${x + 8} ${base} Z`);
    }
    shape = <path d={teeth.join(' ')} fill={kerbColor} />;
  }

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }}>
      <rect x={0} y={base} width={w} height={h - base} fill="#2a2a2e" />
      {shape}
      {type === 'none' && (
        <line x1={6} y1={base} x2={58} y2={base} stroke="#666" strokeDasharray="3 3" />
      )}
    </svg>
  );
}
