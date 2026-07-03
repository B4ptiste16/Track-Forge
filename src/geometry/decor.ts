import type { TrackProject } from '../types';
import type { CenterlineSample, SegmentSpan, MeshData, Vec3 } from './types';
import { perpLeft, offsetPoint } from './frames';
import { addQuadUp, addQuadToward } from './meshbuilder';
import { hex01 } from './kerbs';
import type { ResolvedSample } from './runoff';

// France-theme decorations: a giant tricolore at turn 1, grandstands on the
// main straight + turn 1 outside, and a tricolor arch over start/finish.
// All DECOR_* meshes are visual-only in AC (no surface prefix = no collision).
// Vertex colours drive the in-app preview; UVs + the exported textures drive
// the in-game look (DECOR_FLAG/ARCH/STAND textures are tricolor bands along U).

const BLEU = hex01('#0055A4');
const BLANC = hex01('#f2f2f2');
const ROUGE = hex01('#EF4135');
const TRICOLORE: Vec3[] = [BLEU, BLANC, ROUGE];

function mesh(name: string): MeshData {
  return { name, vertices: [], faces: [], colors: [], uvs: [] };
}

// Push a vertical quad (posts a->b, z0..z1) coloured `col`, facing `dir`.
// `uspan` maps the texture across it horizontally (default planar-ish).
function paintQuad(
  m: MeshData, a: Vec3, b: Vec3, z0: number, z1: number, col: Vec3, dir: Vec3,
  uspan?: [number, number],
): void {
  const base = m.vertices.length;
  m.vertices.push([a[0], a[1], z0], [a[0], a[1], z1], [b[0], b[1], z0], [b[0], b[1], z1]);
  for (let k = 0; k < 4; k++) m.colors!.push(col);
  const u0 = uspan ? uspan[0] : (a[0] + a[1]) / 4;
  const u1 = uspan ? uspan[1] : (b[0] + b[1]) / 4;
  const v1 = uspan ? 1 : (z1 - z0) / 4;
  m.uvs!.push([u0, 0], [u0, v1], [u1, 0], [u1, v1]);
  addQuadToward(m.vertices, m.faces, base, base + 1, base + 3, base + 2, dir);
}

// Axis-aligned box (poles, pillars): 4 sides + top, single colour, planar UVs.
function paintBox(m: MeshData, cx: number, cy: number, z0: number, z1: number, half: number, col: Vec3): void {
  const c: [number, number][] = [
    [cx - half, cy - half], [cx + half, cy - half], [cx + half, cy + half], [cx - half, cy + half],
  ];
  for (let i = 0; i < 4; i++) {
    const a = c[i], b = c[(i + 1) % 4];
    const out: Vec3 = [(a[0] + b[0]) / 2 - cx, (a[1] + b[1]) / 2 - cy, 0];
    paintQuad(m, [a[0], a[1], 0], [b[0], b[1], 0], z0, z1, col, out);
  }
  const base = m.vertices.length;
  for (const [x, y] of c) {
    m.vertices.push([x, y, z1]);
    m.colors!.push(col);
    m.uvs!.push([x / 4, y / 4]);
  }
  addQuadUp(m.vertices, m.faces, base, base + 1, base + 2, base + 3);
}

// Stepped bleacher following the samples on one side of the road. Seats
// (coloured treads) go into `seat`; risers/back wall (grey) into `frame`.
function buildStand(
  seat: MeshData,
  frame: MeshData,
  samples: CenterlineSample[],
  idx: number[],
  side: 'left' | 'right',
  off0: number,
): void {
  const STEPS = 7;
  const DEPTH = 1.6; // per step (m)
  const RISE = 0.9; // per step (m)
  const BAND = 18; // metres per full tricolore cycle along the stand
  const sign = side === 'left' ? 1 : -1;
  const at = (i: number, off: number): Vec3 => offsetPoint(samples[i], off * sign);
  const colAt = (i: number): Vec3 => TRICOLORE[Math.floor(samples[i].dist / 6) % 3];

  for (let n = 0; n < idx.length - 1; n++) {
    const i = idx[n], j = idx[n + 1];
    const col = colAt(i);
    const ui = samples[i].dist / BAND;
    const uj = samples[j].dist / BAND;
    const [lx, ly] = perpLeft(samples[i].heading);
    const inward: Vec3 = [-lx * sign, -ly * sign, 0]; // toward the track
    for (let k = 0; k < STEPS; k++) {
      const oIn = off0 + k * DEPTH;
      const oOut = off0 + (k + 1) * DEPTH;
      const zLo = samples[i].pos[2] + k * RISE;
      const zHi = zLo + RISE;
      // riser (vertical, faces the track) — grey frame
      paintQuad(frame, at(i, oIn), at(j, oIn), zLo, zHi, [0.42, 0.44, 0.48], inward);
      // tread (seats) — coloured band, texture runs along the stand
      const b = seat.vertices.length;
      const pIn1 = at(i, oIn), pIn2 = at(j, oIn), pOut1 = at(i, oOut), pOut2 = at(j, oOut);
      seat.vertices.push(
        [pIn1[0], pIn1[1], zHi], [pOut1[0], pOut1[1], zHi],
        [pIn2[0], pIn2[1], zHi], [pOut2[0], pOut2[1], zHi],
      );
      for (let k2 = 0; k2 < 4; k2++) seat.colors!.push(col);
      seat.uvs!.push([ui, k / STEPS], [ui, (k + 1) / STEPS], [uj, k / STEPS], [uj, (k + 1) / STEPS]);
      addQuadUp(seat.vertices, seat.faces, b, b + 1, b + 3, b + 2);
    }
    // back wall — grey frame
    const oBack = off0 + STEPS * DEPTH;
    paintQuad(frame, at(i, oBack), at(j, oBack), samples[i].pos[2], samples[i].pos[2] + STEPS * RISE,
      [0.55, 0.57, 0.62], [lx * sign, ly * sign, 0]);
  }
}

export function buildDecor(
  project: TrackProject,
  samples: CenterlineSample[],
  spans: SegmentSpan[],
  width: number,
  resolved: ResolvedSample[],
): MeshData[] {
  if (project.meta.theme !== 'france' || samples.length < 2) return [];
  const pole = mesh('DECOR_POLE');
  const flag = mesh('DECOR_FLAG');
  const stand = mesh('DECOR_STAND');
  const frame = mesh('DECOR_FRAME');
  const arch = mesh('DECOR_ARCH');

  const idxOfSpan = (span: SegmentSpan): number[] => {
    const idx: number[] = [];
    for (let i = 0; i < samples.length; i++) if (samples[i].segIndex === span.segIndex) idx.push(i);
    return idx;
  };
  const clearOff = (i: number, side: 'left' | 'right') =>
    width / 2 + Math.max(8, resolved[i][side].width) + 3;

  // --- Giant tricolore at turn 1 (outside, mid-corner) --------------------
  const t1 = spans.find((s) => s.kind === 'corner');
  if (t1) {
    const idx = idxOfSpan(t1);
    if (idx.length >= 2) {
      const mid = idx[Math.floor(idx.length / 2)];
      const outside: 'left' | 'right' = t1.dir === 'left' ? 'right' : 'left';
      const sign = outside === 'left' ? 1 : -1;
      const off = clearOff(mid, outside) + 4;
      const s = samples[mid];
      const base = offsetPoint(s, off * sign);
      const POLE_H = 16;
      paintBox(pole, base[0], base[1], base[2], base[2] + POLE_H, 0.22, [0.62, 0.64, 0.68]);
      // flag flies along the local travel direction; 10.5m x 7m, 3 vertical bands
      const dirx = Math.cos(s.heading), diry = Math.sin(s.heading);
      const FLAG_W = 10.5, FLAG_H = 7, zTop = base[2] + POLE_H, zBot = zTop - FLAG_H;
      const inward: Vec3 = [-Math.sin(s.heading) * -sign, Math.cos(s.heading) * -sign, 0];
      for (let b3 = 0; b3 < 3; b3++) {
        const a: Vec3 = [base[0] + dirx * (FLAG_W / 3) * b3, base[1] + diry * (FLAG_W / 3) * b3, 0];
        const b: Vec3 = [base[0] + dirx * (FLAG_W / 3) * (b3 + 1), base[1] + diry * (FLAG_W / 3) * (b3 + 1), 0];
        paintQuad(flag, a, b, zBot, zTop, TRICOLORE[b3], inward, [b3 / 3, (b3 + 1) / 3]);
      }
    }
  }

  // --- Grandstands: longest straight + outside of turn 1 ------------------
  const straights = spans.filter((s) => s.kind === 'straight')
    .sort((a, b) => (b.endDist - b.startDist) - (a.endDist - a.startDist));
  if (straights.length) {
    const main = straights[0];
    const idx = idxOfSpan(main);
    if (idx.length >= 4) {
      // centre a <=100m stand on the straight, opposite the pit lane
      const side: 'left' | 'right' =
        project.pit.enabled ? (project.pit.side === 'left' ? 'right' : 'left') : 'right';
      const len = main.endDist - main.startDist;
      const keep = Math.min(100, len * 0.7);
      const d0 = main.startDist + (len - keep) / 2;
      const d1 = d0 + keep;
      const sub = idx.filter((i) => samples[i].dist >= d0 && samples[i].dist <= d1);
      if (sub.length >= 2) {
        const mid = sub[Math.floor(sub.length / 2)];
        buildStand(stand, frame, samples, sub, side, clearOff(mid, side));
      }
    }
  }
  if (t1) {
    const idx = idxOfSpan(t1);
    if (idx.length >= 4) {
      const outside: 'left' | 'right' = t1.dir === 'left' ? 'right' : 'left';
      const mid = idx[Math.floor(idx.length / 2)];
      buildStand(stand, frame, samples, idx, outside, clearOff(mid, outside) + 9);
    }
  }

  // --- Tricolor arch over start/finish -------------------------------------
  let sf = 0;
  let bd = Infinity;
  for (let i = 0; i < samples.length; i++) {
    const d = Math.abs(samples[i].dist - project.startFinishDist);
    if (d < bd) { bd = d; sf = i; }
  }
  const s = samples[sf];
  const pl = offsetPoint(s, width / 2 + 2.2);
  const pr = offsetPoint(s, -(width / 2 + 2.2));
  const H = 7, BANNER = 1.6;
  paintBox(pole, pl[0], pl[1], pl[2], pl[2] + H, 0.35, [0.85, 0.86, 0.88]);
  paintBox(pole, pr[0], pr[1], pr[2], pr[2] + H, 0.35, [0.85, 0.86, 0.88]);
  const zTop = Math.max(pl[2], pr[2]) + H;
  const fwd: Vec3 = [Math.cos(s.heading), Math.sin(s.heading), 0];
  for (let b3 = 0; b3 < 3; b3++) {
    const t0 = b3 / 3, t1b = (b3 + 1) / 3;
    const a: Vec3 = [pl[0] + (pr[0] - pl[0]) * t0, pl[1] + (pr[1] - pl[1]) * t0, 0];
    const b: Vec3 = [pl[0] + (pr[0] - pl[0]) * t1b, pl[1] + (pr[1] - pl[1]) * t1b, 0];
    paintQuad(arch, a, b, zTop - BANNER, zTop, TRICOLORE[b3], fwd, [t0, t1b]);
    paintQuad(arch, a, b, zTop - BANNER, zTop, TRICOLORE[2 - b3], [-fwd[0], -fwd[1], 0], [1 - t0, 1 - t1b]);
  }

  return [pole, flag, stand, frame, arch].filter((m) => m.faces.length > 0);
}
