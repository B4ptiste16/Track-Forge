import type { KerbType, CornerConfig } from '../types';
import type { CenterlineSample, MeshData, SegmentSpan, Vec3 } from './types';
import { perpLeft, leftEdge, rightEdge } from './frames';
import { addQuadUp } from './meshbuilder';

export const KERB_WIDTH = 1.0; // m
const KERB_LIFT = 0.02; // small lift so kerbs read clearly and don't z-fight the road

export interface KerbSample {
  left: KerbType;
  right: KerbType;
}

// For every centerline sample, decide which kerb profile (if any) sits on the
// inside edge. Corner thirds map to entry / apex / exit.
export function computeKerbInfo(
  samples: CenterlineSample[],
  spans: SegmentSpan[],
  corners: CornerConfig[],
  defaultKerb: KerbType,
): KerbSample[] {
  const info: KerbSample[] = samples.map(() => ({ left: 'none', right: 'none' }));

  const BRAKE = 25; // braking-zone kerb length before the corner (outside)
  const TRACTION = 30; // traction-zone kerb length after the corner (outside)

  for (const span of spans) {
    if (span.kind !== 'corner') continue;
    const cfg = corners.find((c) => c.cornerIndex === span.cornerIndex);
    const entry = cfg ? cfg.entry : defaultKerb;
    const apex = cfg ? cfg.apex : defaultKerb;
    const exit = cfg ? cfg.exit : defaultKerb;
    // Real-track kerb usage: NO kerb on the outside *through* the corner — only
    // the apex kerb on the INSIDE during the corner, an entry kerb on the OUTSIDE
    // in the braking zone (the straight before), and an exit kerb on the OUTSIDE
    // in the traction zone (the straight after).
    const inside: 'left' | 'right' = span.dir === 'left' ? 'left' : 'right';
    const outside: 'left' | 'right' = span.dir === 'left' ? 'right' : 'left';

    const a = span.startDist;
    const b = span.endDist;
    const len = b - a;

    const mark = (i: number, side: 'left' | 'right', profile: KerbType) => {
      if (profile !== 'none') info[i][side] = profile;
    };
    for (let i = 0; i < samples.length; i++) {
      const d = samples[i].dist;
      // entry: outside, braking zone on the approach straight only
      if (d >= a - BRAKE && d < a) mark(i, outside, entry);
      // apex: inside, middle of the corner
      if (d >= a + len * 0.2 && d <= a + len * 0.8) mark(i, inside, apex);
      // exit: outside, traction zone on the exit straight only
      if (d > b && d <= b + TRACTION) mark(i, outside, exit);
    }
  }

  return info;
}

function triangleWave(x: number): number {
  const f = x - Math.floor(x);
  return 1 - Math.abs(2 * f - 1); // 0 -> 1 -> 0
}

// Height of the kerb surface at fractional cross-width t (0=inner/flush, 1=outer)
// and arc distance d. Inner edge stays flush (height 0) for every profile.
function kerbHeight(profile: KerbType, t: number, d: number): number {
  switch (profile) {
    case 'flat':
      return 0; // flush — painted onto the surface (rumble via the KERB surface)
    case 'sausage':
      return 0.12 * Math.sin(Math.PI * t);
    case 'serrated':
      return t <= 0 ? 0 : 0.08 * triangleWave(d / 0.8);
    default:
      return 0;
  }
}

function colsFor(profile: KerbType): number {
  return profile === 'sausage' ? 4 : 2;
}

// Build the kerb mesh (1KERB) from per-sample kerb info. Kerbs hug the inside
// road edge and extend KERB_WIDTH outward — beside the road, never over it.
export function buildKerbs(
  samples: CenterlineSample[],
  info: KerbSample[],
  width: number,
): MeshData {
  const vertices: Vec3[] = [];
  const faces: [number, number, number][] = [];

  for (const side of ['left', 'right'] as const) {
    let i = 0;
    while (i < samples.length) {
      const profile = info[i][side];
      if (profile === 'none') {
        i++;
        continue;
      }
      // Extend a run of identical profile on this side.
      let j = i + 1;
      while (j < samples.length && info[j][side] === profile) j++;
      if (j - i >= 2) {
        emitStrip(vertices, faces, samples.slice(i, j), side, profile, width);
      }
      i = j;
    }
  }

  return { name: '1KERB', vertices, faces };
}

function emitStrip(
  vertices: Vec3[],
  faces: [number, number, number][],
  run: CenterlineSample[],
  side: 'left' | 'right',
  profile: KerbType,
  width: number,
): void {
  const ncols = colsFor(profile);
  const base = vertices.length;
  const rowSize = ncols + 1;

  run.forEach((s) => {
    const [lx, ly] = perpLeft(s.heading);
    const sign = side === 'left' ? 1 : -1; // outward direction
    const inner = side === 'left' ? leftEdge(s, width) : rightEdge(s, width);
    for (let c = 0; c <= ncols; c++) {
      const t = c / ncols;
      const off = t * KERB_WIDTH * sign;
      vertices.push([
        inner[0] + lx * off,
        inner[1] + ly * off,
        s.pos[2] + KERB_LIFT + kerbHeight(profile, t, s.dist),
      ]);
    }
  });

  for (let r = 0; r < run.length - 1; r++) {
    for (let c = 0; c < ncols; c++) {
      const a = base + r * rowSize + c;
      const b = base + r * rowSize + c + 1;
      const d = base + (r + 1) * rowSize + c + 1;
      const e = base + (r + 1) * rowSize + c;
      addQuadUp(vertices, faces, a, b, d, e);
    }
  }
}
