import type { TrackProject, Theme } from '../types';
import type { CenterlineSample, SegmentSpan, LightMast, MeshData, Vec3 } from './types';
import { perpLeft, offsetPoint, leftEdge, rightEdge } from './frames';
import { addQuadUp, addQuadToward } from './meshbuilder';
import { hex01 } from './kerbs';
import type { ResolvedSample } from './runoff';

// Decorations: grandstands on the main straight + turn 1 outside (every
// theme), plus — France only — a giant tricolore at turn 1 and a tricolor
// arch over start/finish. All DECOR_* meshes are visual-only in AC (no surface
// prefix = no collision). Vertex colours drive the in-app preview; UVs + the
// exported textures drive the in-game look.

const BLEU = hex01('#0055A4');
const BLANC = hex01('#f2f2f2');
const ROUGE = hex01('#EF4135');
const TRICOLORE: Vec3[] = [BLEU, BLANC, ROUGE];

// Grandstand seat colour blocks per theme (France = the tricolore).
export const SEAT_PATTERNS: Record<Theme, string[]> = {
  tarmac_day: ['#2f5fa8', '#c9cdd4', '#b03a3a'],
  tarmac_dusk: ['#24477e', '#8f939c', '#8c2f2f'],
  desert: ['#a8552f', '#d8cfc0', '#4a6a8a'],
  france: ['#0055A4', '#f2f2f2', '#EF4135'],
};

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

// A braking board: a solid white prism with the distance printed on the faces
// the driver sees. This used to be a flat panel on a post — a road sign, not a
// marker board — and worse, its UVs picked the distance out of the texture along
// U while the texture stacked the numbers along V, so every board sampled a
// vertical slice across all three and came out as meaningless black blocks.
// Here the faces toward and away from traffic take that distance's band of the
// texture, and the sides/top take a plain white column of it.
function numberBlock(m: MeshData, cx: number, cy: number, z0: number, heading: number, band: number): void {
  const HW = 0.75;   // half width across the track
  const HD = 0.22;   // half depth along it
  const H = 1.15;    // height
  const WHITE: Vec3 = [1, 1, 1];
  const fx = Math.cos(heading), fy = Math.sin(heading);   // along travel
  const lx = -fy, ly = fx;                                // across travel
  const v0 = band / 3, v1 = (band + 1) / 3;
  const NUM: [number, number] = [0.12, 1.0];  // where the numeral is drawn
  const PLAIN: [number, number] = [0.0, 0.08]; // blank white, for the sides

  // corners of the footprint
  const c = (a: number, b: number): [number, number] =>
    [cx + lx * HW * a + fx * HD * b, cy + ly * HW * a + fy * HD * b];
  const p00 = c(-1, -1), p10 = c(1, -1), p11 = c(1, 1), p01 = c(-1, 1);

  const face = (a: [number, number], bb: [number, number], u: [number, number], outward: Vec3) => {
    const base = m.vertices.length;
    m.vertices.push([a[0], a[1], z0], [a[0], a[1], z0 + H], [bb[0], bb[1], z0], [bb[0], bb[1], z0 + H]);
    for (let k = 0; k < 4; k++) m.colors!.push(WHITE);
    // v runs DOWN the texture band so the numeral is upright on the board
    m.uvs!.push([u[0], v1], [u[0], v0], [u[1], v1], [u[1], v0]);
    addQuadToward(m.vertices, m.faces, base, base + 1, base + 3, base + 2, outward);
  };
  // the two faces a driver reads, then the blank sides
  face(p00, p10, NUM, [-fx, -fy, 0]);
  face(p11, p01, NUM, [fx, fy, 0]);
  face(p10, p11, PLAIN, [lx, ly, 0]);
  face(p01, p00, PLAIN, [-lx, -ly, 0]);
  // top cap
  const base = m.vertices.length;
  for (const q of [p00, p10, p11, p01]) {
    m.vertices.push([q[0], q[1], z0 + H]);
    m.colors!.push(WHITE);
    m.uvs!.push([PLAIN[0], v0]);
  }
  addQuadUp(m.vertices, m.faces, base, base + 1, base + 2, base + 3);
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

// One tree: a trunk box + a canopy of stacked tapering rings (solid geometry,
// NOT an alpha billboard — a billboard needs its material set to alpha-blend by
// hand in ksEditor, and shows up as an opaque green rectangle if you forget).
// ~30 triangles, so a full treeline stays cheap.
function paintTree(m: MeshData, x: number, y: number, z: number, h: number, rng: () => number): void {
  const trunkH = h * 0.34;
  const brown: Vec3 = [0.28 + rng() * 0.08, 0.19 + rng() * 0.05, 0.11];
  paintBox(m, x, y, z, z + trunkH, h * 0.035, brown);
  // canopy: 3 stacked hexagonal rings, each narrower than the one below
  const g = 0.16 + rng() * 0.16; // per-tree green variation
  const green: Vec3 = [0.13 + g * 0.35, 0.30 + g, 0.12 + g * 0.25];
  const dark: Vec3 = [green[0] * 0.72, green[1] * 0.72, green[2] * 0.72];
  const tiers = 3;
  for (let t = 0; t < tiers; t++) {
    const z0 = z + trunkH + (h - trunkH) * (t / tiers) * 0.9;
    const z1 = z + trunkH + (h - trunkH) * ((t + 1) / tiers);
    const rad = h * (0.30 - t * 0.075) * (0.85 + rng() * 0.3);
    const n = 6;
    const pts: [number, number][] = [];
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + rng() * 0.2;
      pts.push([x + Math.cos(a) * rad, y + Math.sin(a) * rad]);
    }
    for (let k = 0; k < n; k++) {
      const a = pts[k], b = pts[(k + 1) % n];
      const out: Vec3 = [(a[0] + b[0]) / 2 - x, (a[1] + b[1]) / 2 - y, 0];
      paintQuad(m, [a[0], a[1], 0], [b[0], b[1], 0], z0, z1, t === 0 ? dark : green, out);
    }
    if (t === tiers - 1) { // cap the top so it isn't hollow when seen from above
      const base = m.vertices.length;
      m.vertices.push([x, y, z1 + h * 0.06]);
      m.colors!.push(green);
      m.uvs!.push([x / 4, y / 4]);
      for (let k = 0; k < n; k++) {
        const a = pts[k], b = pts[(k + 1) % n];
        const bi = m.vertices.length;
        m.vertices.push([a[0], a[1], z1], [b[0], b[1], z1]);
        m.colors!.push(green, green);
        m.uvs!.push([a[0] / 4, a[1] / 4], [b[0] / 4, b[1] / 4]);
        m.faces.push([base, bi, bi + 1]);
      }
    }
  }
}

// Floodlight masts around the circuit: a tapered pole plus a lamp-head bar of
// individual lamp faces. The lamp faces use a bright near-white colour so they
// read as lit fixtures; the actual illumination comes from the CSP lights we
// write for each mast (vanilla AC cannot light a track dynamically).
function buildLightMasts(
  pole: MeshData, lamp: MeshData, samples: CenterlineSample[], width: number,
  resolved: ResolvedSample[], spacing: number,
): LightMast[] {
  const out: LightMast[] = [];
  if (samples.length < 4 || spacing <= 0) return out;
  const grey: Vec3 = [0.58, 0.60, 0.64];
  const lit: Vec3 = [1.0, 0.97, 0.88];
  let seed = 4242;
  const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let next = 0;
  for (let i = 0; i < samples.length - 1; i++) {
    const s = samples[i];
    if (s.dist < next) continue;
    next = s.dist + spacing;
    // alternate sides so the track is lit from both hands down the lap
    const side: 'left' | 'right' = out.length % 2 === 0 ? 'left' : 'right';
    const r = resolved[i][side];
    const clear = Math.max(r.width, r.wallDist ?? r.width) + 4;
    const [lx, ly] = perpLeft(s.heading);
    const sign = side === 'left' ? 1 : -1;
    const edge = side === 'left' ? leftEdge(s, width) : rightEdge(s, width);
    const bx = edge[0] + lx * clear * sign;
    const by = edge[1] + ly * clear * sign;
    const z0 = s.pos[2];
    const h = 15 + rng() * 3;
    // pole: two stacked boxes so it tapers
    paintBox(pole, bx, by, z0, z0 + h * 0.6, 0.28, grey);
    paintBox(pole, bx, by, z0 + h * 0.6, z0 + h, 0.18, grey);
    // lamp head: a short bar of lamp faces, cantilevered toward the track
    const inx = -lx * sign, iny = -ly * sign; // unit vector toward the track
    const hx = bx + inx * 1.6, hy = by + iny * 1.6;
    paintBox(lamp, hx, hy, z0 + h, z0 + h + 0.9, 1.15, lit);
    out.push({
      head: [hx, hy, z0 + h + 0.45],
      aim: [s.pos[0], s.pos[1], z0], // centre of the track beside the mast
      pit: false,
    });
  }
  return out;
}

// Treeline outside the barriers, both sides, density 0..1 from the preset.
// Placed beyond the run-off/wall so trees never intrude on the racing surface
// or the escape roads; spacing and size jitter keep it from looking planted.
function buildTrees(
  m: MeshData, samples: CenterlineSample[], width: number, resolved: ResolvedSample[], density: number,
  standZones: { side: 'left' | 'right'; from: number; to: number }[] = [],
): void {
  if (density <= 0 || samples.length < 4) return;
  let seed = 20260725;
  const rng = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const spacing = 26 - 16 * Math.min(1, density); // dense -> closer together
  for (const side of ['left', 'right'] as const) {
    let next = rng() * spacing;
    for (let i = 0; i < samples.length - 1; i++) {
      const s = samples[i];
      if (s.dist < next) continue;
      next = s.dist + spacing * (0.6 + rng() * 0.9);
      // A grandstand already occupies this stretch on this side — skip it, with
      // a margin so a tree isn't pressed up against the structure either.
      if (standZones.some((z) => z.side === side && s.dist > z.from - 12 && s.dist < z.to + 12)) continue;
      const r = resolved[i][side];
      const clear = Math.max(r.width, r.wallDist ?? r.width) + 6 + rng() * 22; // beyond the barrier
      const [lx, ly] = perpLeft(s.heading);
      const sign = side === 'left' ? 1 : -1;
      const edge = side === 'left' ? leftEdge(s, width) : rightEdge(s, width);
      const x = edge[0] + lx * clear * sign;
      const y = edge[1] + ly * clear * sign;
      paintTree(m, x, y, s.pos[2], 6 + rng() * 9, rng);
    }
  }
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
  seats: Vec3[],
): void {
  const STEPS = 7;
  const DEPTH = 1.6; // per step (m)
  const RISE = 0.9; // per step (m)
  const BAND = 18; // metres per full seat-colour cycle along the stand
  const sign = side === 'left' ? 1 : -1;
  const at = (i: number, off: number): Vec3 => offsetPoint(samples[i], off * sign);
  const colAt = (i: number): Vec3 => seats[Math.floor(samples[i].dist / 6) % seats.length];

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
): { meshes: MeshData[]; masts: LightMast[] } {
  if (samples.length < 2) return { meshes: [], masts: [] };
  const isFrance = project.meta.theme === 'france';
  const seats = (SEAT_PATTERNS[project.meta.theme] ?? SEAT_PATTERNS.tarmac_day).map(hex01);
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

  // --- Giant tricolore at turn 1 (outside, mid-corner; France only) --------
  const t1 = spans.find((s) => s.kind === 'corner');
  if (t1 && isFrance) {
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

  // A stand candidate must not sit where ANOTHER part of the lap passes
  // (e.g. after closing the loop, the return leg can run right through the
  // spot). Footprint ~ off0..off0+13 m from its own samples; reject if any
  // FAR-away (by lap distance) sample comes within that band + road width.
  const standAreaClear = (sub: number[], side: 'left' | 'right', off0: number): boolean => {
    const sign = side === 'left' ? 1 : -1;
    for (let n = 0; n < sub.length; n += 3) {
      const s0 = samples[sub[n]];
      const [lx, ly] = perpLeft(s0.heading);
      const mx = s0.pos[0] + lx * (off0 + 6) * sign;
      const my = s0.pos[1] + ly * (off0 + 6) * sign;
      for (let i = 0; i < samples.length; i += 2) {
        const other = samples[i];
        let dd = Math.abs(other.dist - s0.dist);
        dd = Math.min(dd, Math.abs(dd - samples[samples.length - 1].dist));
        if (dd < 60) continue; // its own neighbourhood
        const dx = other.pos[0] - mx, dy = other.pos[1] - my;
        if (dx * dx + dy * dy < (7 + width / 2) * (7 + width / 2)) return false;
      }
    }
    return true;
  };

  // Where a grandstand ends up, so the treeline can leave room for it — a tree
  // growing through the seating is the sort of thing you only notice in-game.
  const standZones: { side: 'left' | 'right'; from: number; to: number }[] = [];

  // --- Grandstands: longest straight + outside of turn 1 ------------------
  const straights = spans.filter((s) => s.kind === 'straight')
    .sort((a, b) => (b.endDist - b.startDist) - (a.endDist - a.startDist));
  if (straights.length && (project.decor?.grandstands ?? true)) {
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
        const off = clearOff(mid, side);
        if (standAreaClear(sub, side, off)) {
          buildStand(stand, frame, samples, sub, side, off, seats);
          standZones.push({ side, from: samples[sub[0]].dist, to: samples[sub[sub.length - 1]].dist });
        }
      }
    }
  }
  if (t1 && (project.decor?.grandstands ?? true)) {
    const idx = idxOfSpan(t1);
    if (idx.length >= 4) {
      const outside: 'left' | 'right' = t1.dir === 'left' ? 'right' : 'left';
      const mid = idx[Math.floor(idx.length / 2)];
      const off = clearOff(mid, outside) + 9;
      if (standAreaClear(idx, outside, off)) {
        buildStand(stand, frame, samples, idx, outside, off, seats);
        standZones.push({ side: outside, from: samples[idx[0]].dist, to: samples[idx[idx.length - 1]].dist });
      }
    }
  }

  // --- Tricolor arch over start/finish (France only) -----------------------
  if (isFrance) {
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
  }

  // --- Brake marker boards: 100/50/25 m before every corner, outside edge ---
  const marker = mesh('DECOR_MARKER');
  const nearestSample = (d: number): number => {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < samples.length; i++) {
      const dd = Math.abs(samples[i].dist - d);
      if (dd < bd) { bd = dd; bi = i; }
    }
    return bi;
  };
  for (const span of spans) {
    if (span.kind !== 'corner') continue;
    // Braking boards stand on the SAME side as the corner's entry kerb — the
    // outside of the turn, which is the side the driver is looking at on the way
    // in. Two metres past the track edge: close enough to read at speed, far
    // enough that running wide doesn't hit them.
    const outside: 'left' | 'right' = span.dir === 'left' ? 'right' : 'left';
    const sign = outside === 'left' ? 1 : -1;
    for (const back of [100, 50, 25]) {
      const d = span.startDist - back;
      if (d < 3) continue;
      const i = nearestSample(d);
      const s = samples[i];
      const b = offsetPoint(s, (width / 2 + 2.0) * sign);
      const band = back === 100 ? 0 : back === 50 ? 1 : 2;
      numberBlock(marker, b[0], b[1], b[2], s.heading, band);
    }
  }

  // --- Start/finish gantry with a start-light bar over the S/F line ---------
  const gantry = mesh('DECOR_GANTRY');
  const lights = mesh('DECOR_LIGHTS');
  {
    const sf = nearestSample(project.startFinishDist);
    const s = samples[sf];
    const pl = offsetPoint(s, width / 2 + 1.5);
    const pr = offsetPoint(s, -(width / 2 + 1.5));
    const H = 6.5, BEAM = 0.5;
    const STEEL: Vec3 = [0.72, 0.74, 0.78];
    paintBox(gantry, pl[0], pl[1], pl[2], pl[2] + H, 0.28, STEEL);
    paintBox(gantry, pr[0], pr[1], pr[2], pr[2] + H, 0.28, STEEL);
    const zTop = Math.max(pl[2], pr[2]) + H;
    const fwd: Vec3 = [Math.cos(s.heading), Math.sin(s.heading), 0];
    // overhead beam across the track
    paintQuad(gantry, [pl[0], pl[1], 0], [pr[0], pr[1], 0], zTop - BEAM, zTop, STEEL, fwd, [0, 1]);
    paintQuad(gantry, [pr[0], pr[1], 0], [pl[0], pl[1], 0], zTop - BEAM, zTop, STEEL, [-fwd[0], -fwd[1], 0], [0, 1]);
    // light panel hanging under the beam, facing the grid (normal = -travel)
    const lz1 = zTop - BEAM, lz0 = lz1 - 0.9;
    paintQuad(lights, [pl[0], pl[1], 0], [pr[0], pr[1], 0], lz0, lz1, [0.05, 0.05, 0.06], [-fwd[0], -fwd[1], 0], [0, 1]);
  }

  // Treeline outside the barriers (density from the circuit preset).
  const tree = mesh('DECOR_TREE');
  buildTrees(tree, samples, width, resolved, project.decor?.trees ?? 0, standZones);

  // Floodlight masts, so the circuit can be raced after dark. The geometry is
  // the visible fixture; the light itself is written to CSP's ext_config.ini.
  const mastPole = mesh('DECOR_MAST');
  const mastLamp = mesh('DECOR_LAMP');
  const masts = (project.decor?.lightSpacing ?? 0) > 0
    ? buildLightMasts(mastPole, mastLamp, samples, width, resolved, project.decor!.lightSpacing!)
    : [];

  const meshes = [pole, flag, stand, frame, arch, marker, gantry, lights, tree, mastPole, mastLamp]
    .filter((m) => m.faces.length > 0);
  return { meshes, masts };
}
