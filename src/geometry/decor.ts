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

// TREE ATLAS. Trees used to get their variety — and their brown trunks — from
// vertex colours, but a KN5 vertex carries position, normal, UV and tangent and
// nothing else, so the FBX never wrote them and the game never saw them. Every
// tree in game was the same green, trunk included. Variety therefore has to
// live in the UVs: one texture holding bark and three foliage tones, and each
// tree's faces pointed at the region they should show. The texture generator
// reads this same table, so the two cannot drift apart.
//                    u0    v0    u1    v1      (V runs up)
export const TREE_ATLAS = {
  bark: [0, 0.5, 0.5, 1] as const,
  leafA: [0.5, 0.5, 1, 1] as const, // fresh, light
  leafB: [0, 0, 0.5, 0.5] as const, // mid
  leafC: [0.5, 0, 1, 0.5] as const, // dark, conifer-like
};
type Region = readonly [number, number, number, number];

// Start-light panel: real width/height, and the aspect the texture draws for.
export const LIGHTS_W = 5.4;
export const LIGHTS_H = 0.9;
export const LIGHTS_ASPECT = LIGHTS_W / LIGHTS_H;

// Send the UVs added since `from` into an atlas region. With `normalise` they
// are first scaled to their own bounding box (for planar caps); otherwise they
// are taken as already being in 0..1. Inset slightly so mip-mapping never
// samples the neighbouring region.
function toRegion(m: MeshData, from: number, r: Region, normalise = false, flipU = false): void {
  const uvs = m.uvs!;
  let u0 = 0, u1 = 1, v0 = 0, v1 = 1;
  if (normalise) {
    u0 = Infinity; u1 = -Infinity; v0 = Infinity; v1 = -Infinity;
    for (let i = from; i < uvs.length; i++) {
      u0 = Math.min(u0, uvs[i][0]); u1 = Math.max(u1, uvs[i][0]);
      v0 = Math.min(v0, uvs[i][1]); v1 = Math.max(v1, uvs[i][1]);
    }
  }
  const du = u1 - u0 || 1, dv = v1 - v0 || 1;
  const pu = (r[2] - r[0]) * 0.02, pv = (r[3] - r[1]) * 0.02;
  const ru0 = r[0] + pu, ru1 = r[2] - pu, rv0 = r[1] + pv, rv1 = r[3] - pv;
  for (let i = from; i < uvs.length; i++) {
    let nu = (uvs[i][0] - u0) / du;
    const nv = (uvs[i][1] - v0) / dv;
    if (flipU) nu = 1 - nu;
    uvs[i] = [ru0 + nu * (ru1 - ru0), rv0 + nv * (rv1 - rv0)];
  }
}

// Push a vertical quad (posts a->b, z0..z1) coloured `col`, facing `dir`.
// `uspan` maps the texture across it horizontally (default planar-ish).
function paintQuad(
  m: MeshData, a: Vec3, b: Vec3, z0: number, z1: number, col: Vec3, dir: Vec3,
  uspan?: [number, number], vspan?: [number, number],
): void {
  const base = m.vertices.length;
  m.vertices.push([a[0], a[1], z0], [a[0], a[1], z1], [b[0], b[1], z0], [b[0], b[1], z1]);
  for (let k = 0; k < 4; k++) m.colors!.push(col);
  // The default U, (x+y)/4, is fine for paintBox's axis-aligned sides but is
  // CONSTANT along any edge running in the (1,-1) direction, smearing a single
  // column of texels down the whole face. Arbitrary-direction faces should pass
  // uspan (and vspan, to anchor the texture to world height).
  const u0 = uspan ? uspan[0] : (a[0] + a[1]) / 4;
  const u1 = uspan ? uspan[1] : (b[0] + b[1]) / 4;
  const v0 = vspan ? vspan[0] : 0;
  const v1 = vspan ? vspan[1] : uspan ? 1 : (z1 - z0) / 4;
  m.uvs!.push([u0, v0], [u0, v1], [u1, v0], [u1, v1]);
  addQuadToward(m.vertices, m.faces, base, base + 1, base + 3, base + 2, dir);
}

// A braking board: a solid white prism with the distance printed on the faces
// the driver sees. This used to be a flat panel on a post — a road sign, not a
// marker board — and worse, its UVs picked the distance out of the texture along
// U while the texture stacked the numbers along V, so every board sampled a
// vertical slice across all three and came out as meaningless black blocks.
// Here the faces toward and away from traffic take that distance's band of the
// texture, and the sides/top take a plain white column of it.
function numberBlock(m: MeshData, legs: MeshData, cx: number, cy: number, zGround: number,
  heading: number, band: number): void {
  const HW = 0.75;   // half width across the track
  const HD = 0.22;   // half depth along it
  const H = 1.15;    // height
  // A real brake board is mounted on legs with its face held clear of the
  // ground. Sitting the box straight on the dirt was the single thing that
  // made these read as crates rather than signage.
  const LIFT = 0.62;
  const z0 = zGround + LIFT;
  const WHITE: Vec3 = [1, 1, 1];
  const fx = Math.cos(heading), fy = Math.sin(heading);   // along travel
  const lx = -fy, ly = fx;                                // across travel
  // V runs from the BOTTOM of the texture up (the bollard proves this: its dark
  // foot is drawn at the bottom of its image and appears at the bottom in game).
  // The bands are drawn top-down on the canvas, so a band's place in V is
  // measured from the other end — get this backwards and the numerals print
  // upside down, which is exactly what happened.
  const vTop = 1 - band / 3;          // top of this band, in V
  const vBot = 1 - (band + 1) / 3;    // bottom of it
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
    // vertex order is bottom, top, bottom, top — so the board's bottom takes the
    // bottom of the band and its top the top, leaving the numeral upright.
    m.uvs!.push([u[0], vBot], [u[0], vTop], [u[1], vBot], [u[1], vTop]);
    addQuadToward(m.vertices, m.faces, base, base + 1, base + 3, base + 2, outward);
  };
  // The two faces a driver reads. Corner order matters: U has to increase from
  // the viewer's LEFT to their RIGHT or the numeral comes out mirrored. The
  // driver approaches against +travel, so their right is -lateral — which means
  // this face runs from +lateral to -lateral, and the rear face the other way.
  face(p10, p00, NUM, [-fx, -fy, 0]);
  face(p01, p11, NUM, [fx, fy, 0]);
  face(p10, p11, PLAIN, [lx, ly, 0]);
  face(p01, p00, PLAIN, [-lx, -ly, 0]);
  // top cap
  const base = m.vertices.length;
  for (const q of [p00, p10, p11, p01]) {
    m.vertices.push([q[0], q[1], z0 + H]);
    m.colors!.push(WHITE);
    m.uvs!.push([PLAIN[0], vTop]);
  }
  addQuadUp(m.vertices, m.faces, base, base + 1, base + 2, base + 3);
  // the two legs it stands on
  const LEG: Vec3 = [0.38, 0.40, 0.44];
  for (const a of [-0.62, 0.62]) {
    paintBox(legs, cx + lx * HW * a, cy + ly * HW * a, zGround, z0 + 0.05, 0.055, LEG);
  }
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
  const BROWN: Vec3 = [0.3, 0.2, 0.11]; // kept for the preview's flat fallback only
  const GREEN: Vec3 = [0.3, 0.46, 0.2];
  // Trunk: four faces wrapping the bark region once, so the bark runs round it.
  const tw = h * 0.035;
  const tc: [number, number][] = [[x - tw, y - tw], [x + tw, y - tw], [x + tw, y + tw], [x - tw, y + tw]];
  for (let k = 0; k < 4; k++) {
    const a = tc[k], b = tc[(k + 1) % 4];
    const out: Vec3 = [(a[0] + b[0]) / 2 - x, (a[1] + b[1]) / 2 - y, 0];
    const from = m.uvs!.length;
    paintQuad(m, [a[0], a[1], 0], [b[0], b[1], 0], z, z + trunkH, BROWN, out, [k / 4, (k + 1) / 4]);
    toRegion(m, from, TREE_ATLAS.bark);
  }
  // One foliage tone per tree, and a random mirror, so a treeline varies even
  // though every tree shares a single material.
  const pick = rng();
  const leaf = pick < 0.35 ? TREE_ATLAS.leafA : pick < 0.75 ? TREE_ATLAS.leafB : TREE_ATLAS.leafC;
  const flip = rng() < 0.5;
  // canopy: 3 stacked hexagonal rings, each narrower than the one below
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
    // EVERY face takes the whole region. Wrapping one region round the ring
    // instead put ~256 px across a ~19 m circumference against ~256 px up a
    // 2.5 m tier - the leaf clumps were smeared ~7x wide and the canopy read as
    // horizontal stripes. Alternate faces are mirrored, so each face's edge
    // meets its neighbour's identical edge and the ring has no seams; n is
    // even, so the last face meets the first the same way.
    for (let k = 0; k < n; k++) {
      const a = pts[k], b = pts[(k + 1) % n];
      const out: Vec3 = [(a[0] + b[0]) / 2 - x, (a[1] + b[1]) / 2 - y, 0];
      const from = m.uvs!.length;
      paintQuad(m, [a[0], a[1], 0], [b[0], b[1], 0], z0, z1, GREEN, out, [0, 1]);
      toRegion(m, from, leaf, false, flip !== (k % 2 === 1));
    }
    if (t === tiers - 1) { // cap the top so it isn't hollow when seen from above
      const from = m.uvs!.length;
      const base = m.vertices.length;
      m.vertices.push([x, y, z1 + h * 0.06]);
      m.colors!.push(GREEN);
      m.uvs!.push([x, y]);
      for (let k = 0; k < n; k++) {
        const a = pts[k], b = pts[(k + 1) % n];
        const bi = m.vertices.length;
        m.vertices.push([a[0], a[1], z1], [b[0], b[1], z1]);
        m.colors!.push(GREEN, GREEN);
        m.uvs!.push([a[0], a[1]], [b[0], b[1]]);
        m.faces.push([base, bi, bi + 1]);
      }
      toRegion(m, from, leaf, true);
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


// How far a tree must stay from the edge of ANY part of the track.
const TREE_CLEARANCE = 4;

// Nearest centreline sample to a world point: its distance and its height.
function nearestSample(samples: CenterlineSample[], x: number, y: number): { dist: number; z: number } {
  let best = Infinity, z = 0;
  for (const s of samples) {
    const dx = s.pos[0] - x, dy = s.pos[1] - y;
    const d = dx * dx + dy * dy;
    if (d < best) { best = d; z = s.pos[2]; }
  }
  return { dist: Math.sqrt(best), z };
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
      // "Beyond the barrier" is only measured against THIS piece of track. Where
      // the circuit loops back on itself — parallel straights, a hairpin throat —
      // 6 to 28 m outside one side lands on the other, and trees grew out of the
      // racing surface. Check the whole centreline, and take the ground height
      // from wherever the tree actually stands rather than from the sample it
      // was measured off, which can be tens of metres away and at another level.
      const near = nearestSample(samples, x, y);
      if (near.dist < width / 2 + TREE_CLEARANCE) continue;
      paintTree(m, x, y, near.z, 6 + rng() * 9, rng);
    }
  }
}

// Stepped bleacher following the samples on one side of the road. Seats
// (coloured treads) go into `seat`; risers/back wall (grey) into `frame`.
function buildStand(
  seat: MeshData,
  frame: MeshData,
  roof: MeshData,
  steel: MeshData,
  rail: MeshData,
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
  // U runs on distance ALONG THE STAND AT THE FACE'S OWN OFFSET. Not lap
  // distance - a stand straddling start/finish would see that jump from the
  // full lap back to 0 - and not the centreline either: a stand wrapped round
  // the outside of a tight corner 25-38 m out has an arc ~4x the centreline's,
  // and measuring along the centreline stretched its texture 4x along.
  const alongCache = new Map<number, Map<number, number>>();
  const alongAt = (off: number): Map<number, number> => {
    let m = alongCache.get(off);
    if (m) return m;
    m = new Map([[idx[0], 0]]);
    for (let n = 1; n < idx.length; n++) {
      const a = at(idx[n - 1], off), b = at(idx[n], off);
      m.set(idx[n], m.get(idx[n - 1])! + Math.hypot(b[0] - a[0], b[1] - a[1]));
    }
    alongCache.set(off, m);
    return m;
  };
  const U = (i: number, per: number, off: number) => alongAt(off).get(i)! / per;
  // The seats are the exception. Their colour blocks must stay radial from
  // row to row, so every row shares ONE arc - the middle row's. That is exact
  // in the middle and within ~20% at the front and back rows, where measuring
  // along the centreline was out by ~4x.
  const seatOff = off0 + (STEPS * DEPTH) / 2;

  for (let n = 0; n < idx.length - 1; n++) {
    const i = idx[n], j = idx[n + 1];
    const col = colAt(i);
    const ui = U(i, BAND, seatOff);
    const uj = U(j, BAND, seatOff);
    const [lx, ly] = perpLeft(samples[i].heading);
    const inward: Vec3 = [-lx * sign, -ly * sign, 0]; // toward the track
    for (let k = 0; k < STEPS; k++) {
      const oIn = off0 + k * DEPTH;
      const oOut = off0 + (k + 1) * DEPTH;
      const zLo = samples[i].pos[2] + k * RISE;
      const zHi = zLo + RISE;
      // riser (vertical, faces the track) — cast concrete
      paintQuad(frame, at(i, oIn), at(j, oIn), zLo, zHi, [0.42, 0.44, 0.48], inward,
        [U(i, 4, oIn), U(j, 4, oIn)], [zLo / 4, zHi / 4]);
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
    const zb0 = samples[i].pos[2], zb1 = zb0 + STEPS * RISE;
    paintQuad(frame, at(i, oBack), at(j, oBack), zb0, zb1,
      [0.55, 0.57, 0.62], [lx * sign, ly * sign, 0], [U(i, 4, oBack), U(j, 4, oBack)], [zb0 / 4, zb1 / 4]);
  }

  // --- ROOF, COLUMNS, RAILING ----------------------------------------------
  // Without these a grandstand is a flight of steps. The roof is what gives it
  // a silhouette against the sky, and the silhouette is the whole reason a
  // stand reads as a building from the cockpit.
  const zBase = samples[idx[0]].pos[2];
  const oFront = off0;
  const oRear = off0 + STEPS * DEPTH;
  const zSeatTop = zBase + STEPS * RISE;
  const zRoof = zSeatTop + 3.0;
  const ROOF: Vec3 = [0.26, 0.28, 0.32];
  const COL: Vec3 = [0.50, 0.52, 0.56];
  const RAIL: Vec3 = [0.64, 0.66, 0.70];
  const OVERHANG = 1.4;

  const slab = (m: MeshData, i: number, j: number, oA: number, oB: number, z: number, col: Vec3) => {
    const b = m.vertices.length;
    const q1 = at(i, oA), q2 = at(i, oB), q3 = at(j, oA), q4 = at(j, oB);
    m.vertices.push([q1[0], q1[1], z], [q2[0], q2[1], z], [q3[0], q3[1], z], [q4[0], q4[1], z]);
    for (let k = 0; k < 4; k++) m.colors!.push(col);
    // planar, one tile per 6 m — the same mapping building roofs use, so the
    // roofing membrane reads at the same scale on both
    for (const q of [q1, q2, q3, q4]) m.uvs!.push([q[0] / 6, q[1] / 6]);
    addQuadUp(m.vertices, m.faces, b, b + 1, b + 3, b + 2);
  };

  for (let n = 0; n < idx.length - 1; n++) {
    const i = idx[n], j = idx[n + 1];
    const [lx, ly] = perpLeft(samples[i].heading);
    const inward: Vec3 = [-lx * sign, -ly * sign, 0];
    const outward: Vec3 = [lx * sign, ly * sign, 0];
    // The deck was frame steel. It is a roof, so it gets roofing - and its
    // own material, because the darker tone it was given here was a vertex
    // colour, and those never reach the game.
    slab(roof, i, j, oFront - OVERHANG, oRear + 0.6, zRoof, ROOF);
    // fascia: the roof's own edge, so it takes the roofing at the roof's scale
    paintQuad(roof, at(i, oFront - OVERHANG), at(j, oFront - OVERHANG),
      zRoof - 0.6, zRoof, ROOF, inward, [U(i, 6, oFront - OVERHANG), U(j, 6, oFront - OVERHANG)],
      [(zRoof - 0.6) / 6, zRoof / 6]);
    paintQuad(frame, at(i, oRear), at(j, oRear), zSeatTop, zRoof, [0.5, 0.52, 0.57], outward,
      [U(i, 4, oRear), U(j, 4, oRear)], [zSeatTop / 4, zRoof / 4]);
    // front parapet: one texture tile per 2 m along, and the FULL texture up
    // its 1.1 m. It does not repeat vertically, so it can have a top and a foot.
    paintQuad(rail, at(i, oFront), at(j, oFront), zBase, zBase + 1.1, RAIL, inward,
      [U(i, 2, oFront), U(j, 2, oFront)], [0, 1]);
  }

  // Columns: at the back of every bay, and a slimmer front row carrying the
  // roof's leading edge.
  const spanLen = samples[idx[idx.length - 1]].dist - samples[idx[0]].dist;
  const bays = Math.max(2, Math.round(spanLen / 9));
  for (let k = 0; k <= bays; k++) {
    const t = k / bays;
    const i = idx[Math.min(idx.length - 1, Math.round(t * (idx.length - 1)))];
    const pBack = at(i, oRear + 0.3);
    paintBox(steel, pBack[0], pBack[1], zBase, zRoof, 0.22, COL);
    if (k % 2 === 0) {
      const pFront = at(i, oFront - OVERHANG + 0.3);
      paintBox(steel, pFront[0], pFront[1], zBase, zRoof - 0.6, 0.13, COL);
    }
  }

  // End walls, so the stand is closed rather than a sliced-open staircase.
  for (const endIdx of [idx[0], idx[idx.length - 1]]) {
    const [lx, ly] = perpLeft(samples[endIdx].heading);
    const dir: Vec3 = endIdx === idx[0]
      ? [-Math.cos(samples[endIdx].heading), -Math.sin(samples[endIdx].heading), 0]
      : [Math.cos(samples[endIdx].heading), Math.sin(samples[endIdx].heading), 0];
    void lx; void ly;
    paintQuad(frame, at(endIdx, oFront), at(endIdx, oRear), zBase, zSeatTop, [0.47, 0.49, 0.54], dir,
      [oFront / 4, oRear / 4], [zBase / 4, zSeatTop / 4]);
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
  const standRoof = mesh('DECOR_STANDROOF');
  // The grandstand structure carried EIGHT different greys as vertex colours,
  // all of which collapse to one tone in game. Split by what each part is
  // made of instead, so each gets its own material and texture.
  const steel = mesh('DECOR_STEEL'); // columns, brake-board legs
  const rail = mesh('DECOR_RAIL');   // grandstand front parapet
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
          buildStand(stand, frame, standRoof, steel, rail, samples, sub, side, off, seats);
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
        buildStand(stand, frame, standRoof, steel, rail, samples, idx, outside, off, seats);
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
      // The two faces used to sit on the SAME plane facing opposite ways - and
      // with culling off in the FBX they drew in one place and z-fought, just
      // as the gantry beam did. Pushed apart to give the banner depth.
      const D = 0.24;
      const sh = (p: Vec3, d: number): Vec3 => [p[0] + fwd[0] * d, p[1] + fwd[1] * d, 0];
      paintQuad(arch, sh(a, D / 2), sh(b, D / 2), zTop - BANNER, zTop, TRICOLORE[b3], fwd, [t0, t1b]);
      paintQuad(arch, sh(a, -D / 2), sh(b, -D / 2), zTop - BANNER, zTop, TRICOLORE[2 - b3],
        [-fwd[0], -fwd[1], 0], [1 - t0, 1 - t1b]);
      // top and underside, so it reads as a solid banner from any angle
      for (const [z, up] of [[zTop, 1], [zTop - BANNER, -1]] as [number, number][]) {
        const q = [sh(a, -D / 2), sh(a, D / 2), sh(b, -D / 2), sh(b, D / 2)];
        const base = arch.vertices.length;
        for (const v of q) arch.vertices.push([v[0], v[1], z]);
        for (let k = 0; k < 4; k++) arch.colors!.push(TRICOLORE[b3]);
        arch.uvs!.push([t0, 0.02], [t0, 0.98], [t1b, 0.02], [t1b, 0.98]);
        addQuadToward(arch.vertices, arch.faces, base, base + 1, base + 3, base + 2, [0, 0, up]);
      }
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
      numberBlock(marker, steel, b[0], b[1], b[2], s.heading, band);
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
    const H = 6.5, BEAM = 0.8; // a gantry is a structure, not a sign rail
    const STEEL: Vec3 = [0.72, 0.74, 0.78];
    paintBox(gantry, pl[0], pl[1], pl[2], pl[2] + H, 0.28, STEEL);
    paintBox(gantry, pr[0], pr[1], pr[2], pr[2] + H, 0.28, STEEL);
    const zTop = Math.max(pl[2], pr[2]) + H;
    const fwd: Vec3 = [Math.cos(s.heading), Math.sin(s.heading), 0];
    // OVERHEAD BEAM — a box section. It used to be two quads on the SAME plane
    // facing opposite ways: a paper-thin plate, and because the FBX turns
    // culling off, both faces drew in the same place and z-fought each other.
    // Front, back, top and underside, BEAM_D deep along the direction of travel.
    const BEAM_D = 0.7;
    const span = Math.hypot(pr[0] - pl[0], pr[1] - pl[1]);
    const off = (p: Vec3, d: number): [number, number] => [p[0] + fwd[0] * d, p[1] + fwd[1] * d];
    const zLo = zTop - BEAM;
    const face = (a: [number, number], b: [number, number], c: [number, number], d: [number, number],
      za: number, zb: number, zc: number, zd: number, vLen: number, dir: Vec3) => {
      const base = gantry.vertices.length;
      gantry.vertices.push([a[0], a[1], za], [b[0], b[1], zb], [c[0], c[1], zc], [d[0], d[1], zd]);
      for (let k = 0; k < 4; k++) gantry.colors!.push(STEEL);
      // tile every 4 m along the beam rather than stretching one tile across it
      gantry.uvs!.push([0, 0], [0, vLen / 4], [span / 4, 0], [span / 4, vLen / 4]);
      addQuadToward(gantry.vertices, gantry.faces, base, base + 1, base + 3, base + 2, dir);
    };
    const lf = off(pl, -BEAM_D / 2), rf = off(pr, -BEAM_D / 2); // front (grid side)
    const lb = off(pl, BEAM_D / 2), rb = off(pr, BEAM_D / 2);   // back
    face(lf, lf, rf, rf, zLo, zTop, zLo, zTop, BEAM, [-fwd[0], -fwd[1], 0]);
    face(lb, lb, rb, rb, zLo, zTop, zLo, zTop, BEAM, fwd);
    face(lf, lb, rf, rb, zTop, zTop, zTop, zTop, BEAM_D, [0, 0, 1]);
    face(lf, lb, rf, rb, zLo, zLo, zLo, zLo, BEAM_D, [0, 0, -1]);
    // light panel hanging under the beam, flush with its front face, facing
    // the grid (normal = -travel)
    // The panel used to span the whole beam - ~16 m wide by 0.9 m tall, with a
    // square texture stretched over it, so every round lamp was drawn ~18x wider
    // than tall. It is now a light panel's width, centred, and the texture is
    // drawn for exactly this aspect (LIGHTS_ASPECT).
    const lz1 = zLo, lz0 = lz1 - LIGHTS_H;
    const ax = (rf[0] - lf[0]) / span, ay = (rf[1] - lf[1]) / span;
    const mx = (lf[0] + rf[0]) / 2, my = (lf[1] + rf[1]) / 2;
    const L0: Vec3 = [mx - ax * LIGHTS_W / 2, my - ay * LIGHTS_W / 2, 0];
    const L1: Vec3 = [mx + ax * LIGHTS_W / 2, my + ay * LIGHTS_W / 2, 0];
    paintQuad(lights, L0, L1, lz0, lz1, [0.05, 0.05, 0.06], [-fwd[0], -fwd[1], 0], [0, 1]);
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

  const meshes = [pole, flag, stand, frame, standRoof, steel, rail, arch, marker, gantry, lights, tree, mastPole, mastLamp]
    .filter((m) => m.faces.length > 0);
  return { meshes, masts };
}
