import type { KerbType, CornerConfig, Theme } from '../types';
import type { CenterlineSample, MeshData, SegmentSpan, Vec3 } from './types';
import { perpLeft, leftEdge, rightEdge } from './frames';
import { addQuadUp, addQuadToward } from './meshbuilder';

export const KERB_WIDTH = 1.0; // representative kerb width (m); real width varies per profile
const KERB_LIFT = 0.01; // tiny lift so kerbs don't z-fight the road

export const DEFAULT_ENTRY_LEN = 25; // braking-zone kerb length before the corner (outside)
export const DEFAULT_EXIT_LEN = 30; // traction-zone kerb length after the corner (outside)
const STRIPE_LEN = 2.5; // m per painted stripe along the kerb

// Painted stripe cycle per theme (used for the preview vertex colours AND the
// exported kerb texture). France = the bleu-blanc-rouge tricolore.
export const KERB_PATTERNS: Record<Theme, string[]> = {
  tarmac_day: ['#c43a3a', '#e8e8e8'],
  tarmac_dusk: ['#d05a2a', '#e8e8e8'],
  desert: ['#c0392b', '#e8e8e8'],
  france: ['#0055A4', '#f2f2f2', '#EF4135'],
};

export function hex01(hex: string): Vec3 {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

// THE KERB END SHAPE, shared by the kerb geometry and by everything laid
// against it, so the two can never disagree. A kerb starts as a point on the
// track edge and reaches full width as far along as it is wide: a 45-degree,
// two-equal-sides right triangle. It used to taper over a fixed 5 m whatever
// the width - a 1.2 m kerb crept out at 13 degrees, a long thin sliver.
export function kerbTaper(d: number, d0: number, d1: number, full: number): number {
  const L = Math.max(0.05, full);
  return Math.max(0, Math.min(1, (d - d0) / L, (d1 - d) / L));
}

export interface KerbSample {
  left: KerbType;
  right: KerbType;
  leftW: number; // per-corner width override (m); 0 = profile default
  rightW: number;
  // The width the kerb ACTUALLY occupies here, taper included. The kerb narrows
  // to a point over its last few metres; anything laid alongside it has to
  // follow that, or it reserves full width against a kerb that isn't there yet
  // and leaves a wedge of bare ground between the two — a triangle in a square.
  leftEff: number;
  rightEff: number;
}

// For every centerline sample, decide which kerb profile (if any) sits where.
export function computeKerbInfo(
  samples: CenterlineSample[],
  spans: SegmentSpan[],
  corners: CornerConfig[],
  defaultKerb: KerbType,
): KerbSample[] {
  const info: KerbSample[] = samples.map(() => ({ left: 'none', right: 'none', leftW: 0, rightW: 0, leftEff: 0, rightEff: 0 }));

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
    // DEFAULT kerb lengths scale with the corner instead of being a flat 25/30 m
    // for everything. A hairpin and a 200 m sweeper are not kerbed the same: the
    // entry kerb belongs where the car turns in and the exit kerb where it gets
    // back on the power, and both of those scale with how long the corner is.
    // Anything the sheet or the panels set explicitly still wins.
    // These were roughly half this long and read as stubby against the corner —
    // a real entry kerb starts well before turn-in and the exit kerb runs a long
    // way down the following straight while the car is still unwinding lock.
    const autoEntry = Math.max(25, Math.min(120, len * 0.9));
    const autoExit = Math.max(30, Math.min(150, len * 1.2));
    const entryLen = Math.max(0, cfg?.entryLen ?? autoEntry);
    const exitLen = Math.max(0, cfg?.exitLen ?? autoExit);
    // apex length is 100% free: centered mid-corner, it may extend well beyond
    // the corner onto the neighbouring straights (still on the inside).
    const apexLen = Math.max(0, cfg?.apexLen ?? len * 0.95);
    const apexFrom = a + len / 2 - apexLen / 2;
    const apexTo = a + len / 2 + apexLen / 2;
    // per-part widths (legacy kerbWidth as fallback)
    const wEntry = Math.max(0, cfg?.entryW ?? cfg?.kerbWidth ?? 0);
    const wApex = Math.max(0, cfg?.apexW ?? cfg?.kerbWidth ?? 0);
    const wExit = Math.max(0, cfg?.exitW ?? cfg?.kerbWidth ?? 0);

    const mark = (i: number, side: 'left' | 'right', profile: KerbType, w: number) => {
      if (profile === 'none') return;
      info[i][side] = profile;
      if (side === 'left') info[i].leftW = w;
      else info[i].rightW = w;
    };
    for (let i = 0; i < samples.length; i++) {
      const d = samples[i].dist;
      if (d >= a - entryLen && d < a) mark(i, outside, entry, wEntry);
      if (d >= apexFrom && d <= apexTo) mark(i, inside, apex, wApex);
      if (d > b && d <= b + exitLen) mark(i, outside, exit, wExit);
    }
  }

  // Effective (tapered) width per sample. The runs here are grouped exactly as
  // buildKerbs groups them — same profile AND same width override — so the taper
  // lines up with the geometry rather than approximating it.
  for (const side of ['left', 'right'] as const) {
    let i = 0;
    while (i < samples.length) {
      const profile = info[i][side];
      if (profile === 'none') { i++; continue; }
      const w = side === 'left' ? info[i].leftW : info[i].rightW;
      let j = i + 1;
      while (
        j < samples.length &&
        info[j][side] === profile &&
        (side === 'left' ? info[j].leftW : info[j].rightW) === w
      ) j++;
      const shape = kerbShape(profile);
      if (shape && j - i >= 2) {
        const d0 = samples[i].dist, d1 = samples[j - 1].dist;
        const full = w > 0 ? w : shape.width;
        for (let k = i; k < j; k++) {
          const d = samples[k].dist;
          const taper = kerbTaper(d, d0, d1, full);
          if (side === 'left') info[k].leftEff = full * taper;
          else info[k].rightEff = full * taper;
        }
      }
      i = j;
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
    case 'painted': // flush painted stripes on the tarmac - no physical step
      return { width: 1.2, cols: 2, hiFrom: 2, height: () => 0.004 };
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

// Build the kerbs as two coloured meshes: 1KERB (striped base) and 1KERBHI
// (raised yellow sausage part). Both map to the KERB surface in AC (they rumble).
// The base mesh gets per-vertex stripe colours from the theme pattern.
export function buildKerbs(
  samples: CenterlineSample[],
  info: KerbSample[],
  width: number,
  pattern: string[] = KERB_PATTERNS.tarmac_day,
): { base: MeshData; hi: MeshData } {
  const base: MeshData = { name: '1KERB', vertices: [], faces: [], colors: [], uvs: [] };
  const hi: MeshData = { name: '1KERBHI', vertices: [], faces: [] };
  const stripe = pattern.map(hex01);

  for (const side of ['left', 'right'] as const) {
    let i = 0;
    while (i < samples.length) {
      const profile = info[i][side];
      if (profile === 'none') { i++; continue; }
      const w = side === 'left' ? info[i].leftW : info[i].rightW;
      let j = i + 1;
      while (
        j < samples.length &&
        info[j][side] === profile &&
        (side === 'left' ? info[j].leftW : info[j].rightW) === w
      ) j++;
      if (j - i >= 2) emitStrip(base, hi, samples.slice(i, j), side, profile, w, width, stripe);
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
  widthOverride: number,
  width: number,
  stripe: Vec3[],
): void {
  const shape = kerbShape(profile);
  if (!shape) return;
  const scale = widthOverride > 0 ? widthOverride / shape.width : 1;
  const { cols } = shape;
  const boundary = shape.hiFrom > 1 ? cols + 1 : shape.hiFrom <= 0 ? 0 : Math.ceil(shape.hiFrom * cols);
  const baseEnd = Math.min(boundary, cols);
  if (baseEnd >= 1) emitSub(base, run, side, shape, 0, baseEnd, width, scale, stripe);
  if (boundary <= cols - 1) emitSub(hi, run, side, shape, boundary, cols, width, scale, null);
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
  scale: number,
  stripe: Vec3[] | null,
): void {
  const start = mesh.vertices.length;
  const rowSize = cTo - cFrom + 1;
  const sign = side === 'left' ? 1 : -1;
  const d0 = run[0].dist;
  const d1 = run[run.length - 1].dist;
  const roadZ: number[] = [];
  run.forEach((s) => {
    roadZ.push(s.pos[2]);
    const [lx, ly] = perpLeft(s.heading);
    const inner = side === 'left' ? leftEdge(s, width) : rightEdge(s, width);
    const color = stripe ? stripe[Math.floor(s.dist / STRIPE_LEN) % stripe.length] : null;
    // one full texture cycle (all stripes) per pattern repeat along the kerb
    const u = stripe ? s.dist / (STRIPE_LEN * stripe.length) : 0;
    // pointy ends: 0 width at the very start/end, full width one kerb-width in
    const taper = kerbTaper(s.dist, d0, d1, shape.width * scale);
    for (let c = cFrom; c <= cTo; c++) {
      const t = c / shape.cols;
      const off = t * shape.width * scale * sign * taper;
      mesh.vertices.push([
        inner[0] + lx * off,
        inner[1] + ly * off,
        s.pos[2] + KERB_LIFT + shape.height(t, s.dist) * taper,
      ]);
      if (color && mesh.colors) mesh.colors.push(color);
      if (stripe && mesh.uvs) mesh.uvs.push([u, t]);
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

  // SKIRT the open edges. Without this the kerb is a bare ribbon FLOATING
  // KERB_LIFT above the tarmac with nothing closing its sides, so you see
  // straight underneath it. It shows up worst at the start of a run, where the
  // ribbon tapers to a point: a black wedge between the road and a grass verge
  // that stands 6 cm proud beside it. Drop a vertical face from each outside
  // edge down INTO the road surface. Only the true outside edges get one - the
  // seam between the base and the raised (hi) sub-mesh is interior, and a skirt
  // there would be a wall down the middle of the kerb.
  const BURY = 0.05; // below the road, so the skirt can never float in turn
  const vAt = (r: number, c: number) => start + r * rowSize + (c - cFrom);
  const edgeSkirt = (col: number, outSign: number) => {
    for (let r = 0; r < run.length - 1; r++) {
      const i0 = vAt(r, col), i1 = vAt(r + 1, col);
      const t0 = mesh.vertices[i0], t1 = mesh.vertices[i1];
      const b = mesh.vertices.length;
      mesh.vertices.push([t0[0], t0[1], roadZ[r] - BURY], [t1[0], t1[1], roadZ[r + 1] - BURY]);
      // keep the parallel per-vertex arrays in step or the mesh desyncs
      if (mesh.colors && mesh.colors.length) mesh.colors.push(mesh.colors[i0], mesh.colors[i1]);
      if (mesh.uvs && mesh.uvs.length) mesh.uvs.push(mesh.uvs[i0], mesh.uvs[i1]);
      const [lx, ly] = perpLeft(run[r].heading);
      const outward: Vec3 = [lx * sign * outSign, ly * sign * outSign, 0];
      addQuadToward(mesh.vertices, mesh.faces, i0, b, b + 1, i1, outward);
    }
  };
  if (cFrom === 0) edgeSkirt(cFrom, -1);        // track-facing edge
  if (cTo === shape.cols) edgeSkirt(cTo, 1);    // verge-facing edge
}

// The distances at which a kerb's outline turns a corner: full width reached
// at the start, and left at the end. The centreline is sampled every ~3 m but a
// 45-degree taper on a 1.2 m kerb is only 1.2 m long, so without a sample at
// these corners the outline would be interpolated straight across them - and
// the grass edge, interpolated across the same samples, would agree with that
// wrong outline rather than with the kerb. The build inserts a sample at each,
// so the kerb, the grass and the run-off all share the true corner.
export function kerbTaperBreaks(
  samples: CenterlineSample[],
  spans: SegmentSpan[],
  corners: CornerConfig[],
  defaultKerb: KerbType,
): number[] {
  const info = computeKerbInfo(samples, spans, corners, defaultKerb);
  const out: number[] = [];
  for (const side of ['left', 'right'] as const) {
    let i = 0;
    while (i < samples.length) {
      const profile = info[i][side];
      if (profile === 'none') { i++; continue; }
      const w = side === 'left' ? info[i].leftW : info[i].rightW;
      let j = i + 1;
      while (
        j < samples.length &&
        info[j][side] === profile &&
        (side === 'left' ? info[j].leftW : info[j].rightW) === w
      ) j++;
      const shape = kerbShape(profile);
      if (shape && j - i >= 2) {
        const d0 = samples[i].dist, d1 = samples[j - 1].dist;
        const L = Math.max(0.05, w > 0 ? w : shape.width);
        if (d1 - d0 > 2 * L) out.push(d0 + L, d1 - L);
        else out.push((d0 + d1) / 2);          // too short for two: one apex
      }
      i = j;
    }
  }
  return out;
}
