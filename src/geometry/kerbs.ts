import type { KerbType, CornerConfig } from '../types';
import type { CenterlineSample, MeshData, SegmentSpan } from './types';
import { perpLeft, leftEdge, rightEdge } from './frames';
import { addQuadUp } from './meshbuilder';

export const KERB_WIDTH = 1.0; // representative kerb width (m); real width varies per profile
const KERB_LIFT = 0.01; // tiny lift so kerbs don't z-fight the road

export interface KerbSample {
  left: KerbType;
  right: KerbType;
}

// For every centerline sample, decide which kerb profile (if any) sits where.
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
    // entry kerb on the OUTSIDE (braking zone), apex on the INSIDE (mid-corner),
    // exit on the OUTSIDE (traction zone). No kerb on the outside through the corner.
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
      if (d >= a - BRAKE && d < a) mark(i, outside, entry);
      if (d >= a + len * 0.2 && d <= a + len * 0.8) mark(i, inside, apex);
      if (d > b && d <= b + TRACTION) mark(i, outside, exit);
    }
  }

  return info;
}

function triangleWave(x: number): number {
  const f = x - Math.floor(x);
  return 1 - Math.abs(2 * f - 1); // 0 -> 1 -> 0
}

// Cross-section of a kerb profile: total width, how many columns to sample it,
// the fraction across where the raised yellow ("hi") part begins, and the height
// at cross-fraction t (0 = road edge) and arc distance d.
interface KerbShape {
  width: number;
  cols: number;
  hiFrom: number; // >1 = all red, <=0 = all yellow, else red|yellow split fraction
  height: (t: number, d: number) => number;
}

function kerbShape(profile: KerbType): KerbShape | null {
  switch (profile) {
    case 'flat':
      return { width: 1.0, cols: 2, hiFrom: 2, height: (t) => (t <= 0 ? 0 : 0.03) };
    case 'serrated':
      return { width: 1.0, cols: 2, hiFrom: 2, height: (t, d) => (t <= 0 ? 0 : 0.05 * triangleWave(d / 0.7)) };
    case 'ripple':
      return { width: 1.1, cols: 4, hiFrom: 2, height: (t, d) => (t <= 0 ? 0 : 0.04 * (0.55 + 0.45 * Math.sin(d * 2.0))) };
    case 'sausage':
      return { width: 0.9, cols: 6, hiFrom: 0, height: (t) => 0.07 * Math.sin(Math.PI * t) };
    case 'tall':
      return { width: 1.2, cols: 6, hiFrom: 0, height: (t) => 0.11 * Math.sin(Math.PI * t) };
    case 'combo':
      return {
        width: 1.7,
        cols: 10,
        hiFrom: 0.6,
        height: (t) => {
          if (t <= 0) return 0;
          if (t < 0.6) return 0.03; // flat red section
          return 0.03 + 0.06 * Math.sin((Math.PI * (t - 0.6)) / 0.4); // yellow sausage on the outer part
        },
      };
    default:
      return null;
  }
}

// Build the kerbs as two coloured meshes: 1KERB (red/white base) and 1KERBHI
// (raised yellow sausage part). Both map to the KERB surface in AC (they rumble).
export function buildKerbs(
  samples: CenterlineSample[],
  info: KerbSample[],
  width: number,
): { base: MeshData; hi: MeshData } {
  const base: MeshData = { name: '1KERB', vertices: [], faces: [] };
  const hi: MeshData = { name: '1KERBHI', vertices: [], faces: [] };

  for (const side of ['left', 'right'] as const) {
    let i = 0;
    while (i < samples.length) {
      const profile = info[i][side];
      if (profile === 'none') { i++; continue; }
      let j = i + 1;
      while (j < samples.length && info[j][side] === profile) j++;
      if (j - i >= 2) emitStrip(base, hi, samples.slice(i, j), side, profile, width);
      i = j;
    }
  }
  return { base, hi };
}

function emitStrip(
  base: MeshData,
  hi: MeshData,
  run: CenterlineSample[],
  side: 'left' | 'right',
  profile: KerbType,
  width: number,
): void {
  const shape = kerbShape(profile);
  if (!shape) return;
  const { cols } = shape;
  const boundary = shape.hiFrom > 1 ? cols + 1 : shape.hiFrom <= 0 ? 0 : Math.ceil(shape.hiFrom * cols);
  const baseEnd = Math.min(boundary, cols);
  if (baseEnd >= 1) emitSub(base, run, side, shape, 0, baseEnd, width);
  if (boundary <= cols - 1) emitSub(hi, run, side, shape, boundary, cols, width);
}

// Emit a strip of the kerb over columns [cFrom, cTo] into `mesh`.
function emitSub(
  mesh: MeshData,
  run: CenterlineSample[],
  side: 'left' | 'right',
  shape: KerbShape,
  cFrom: number,
  cTo: number,
  width: number,
): void {
  const start = mesh.vertices.length;
  const rowSize = cTo - cFrom + 1;
  const sign = side === 'left' ? 1 : -1;
  run.forEach((s) => {
    const [lx, ly] = perpLeft(s.heading);
    const inner = side === 'left' ? leftEdge(s, width) : rightEdge(s, width);
    for (let c = cFrom; c <= cTo; c++) {
      const t = c / shape.cols;
      const off = t * shape.width * sign;
      mesh.vertices.push([
        inner[0] + lx * off,
        inner[1] + ly * off,
        s.pos[2] + KERB_LIFT + shape.height(t, s.dist),
      ]);
    }
  });
  for (let r = 0; r < run.length - 1; r++) {
    for (let c = 0; c < rowSize - 1; c++) {
      const a = start + r * rowSize + c;
      const b = start + r * rowSize + c + 1;
      const d = start + (r + 1) * rowSize + c + 1;
      const e = start + (r + 1) * rowSize + c;
      addQuadUp(mesh.vertices, mesh.faces, a, b, d, e);
    }
  }
}

