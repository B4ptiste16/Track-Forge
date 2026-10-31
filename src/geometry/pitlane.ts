import type { TrackProject } from '../types';
import type { CenterlineSample, MeshData, Vec3 } from './types';
import { perpLeft, leftEdge, rightEdge, frameAtDist } from './frames';
import { addQuadUp, addQuadToward } from './meshbuilder';

export interface PitSample {
  left: number; // pit lane width on the left at this sample (0 = none)
  right: number;
}

// Shared layout of the pit zone: where the lane tapers in/out and where the
// full-width box/paddock section sits. Used by the lane mesh, the paddock and
// the AC_PIT spawn placement so they always agree.
export interface PitZone {
  start: number;
  end: number;
  taper: number; // metres over which the lane width ramps 0 -> W (and W -> 0)
  boxA: number; // full-width zone begin (boxes + paddock)
  boxB: number; // full-width zone end
}

export function pitZone(project: TrackProject, total: number): PitZone {
  // Exit BEFORE entry = the pit lane CROSSES the start/finish line (entry near
  // the end of the lap, exit after the line). Zone coordinates are UNWRAPPED:
  // `end` may exceed `total` - map a sample distance with pitRel() before
  // comparing it against the zone.
  const e0 = Math.max(0, Math.min(total, project.pit.entry));
  const e1 = Math.max(0, Math.min(total, project.pit.exit));
  const wraps = e1 < e0;
  const start = e0;
  const end = wraps ? e1 + total : e1;
  const span = Math.max(1, end - start);
  const taper = Math.min(35, span / 3);
  return { start, end, taper, boxA: start + taper + 4, boxB: end - taper - 4 };
}

// Where the pit boxes are, as unwrapped zone distances (frameAtDist wraps).
// The ONE definition: the AC_PIT spawns, the painted boxes and the garages all
// read it, so a box is painted exactly where its car stops and the garage
// stands right behind it.
export function pitBoxDistances(project: TrackProject, total: number): number[] {
  const n = project.grid.pits;
  if (!project.pit.enabled || n <= 0) return [];
  const z = pitZone(project, total);
  const a = z.boxA + 4;
  const b = Math.max(a + 1, z.boxB - 4);
  const span = b - a;
  return Array.from({ length: n }, (_, i) => (n > 1 ? a + (span * i) / (n - 1) : a + span / 2));
}

// Unwrapped zone coordinate of a sample distance (0..total).
export function pitRel(d: number, z: PitZone, total: number): number {
  return z.end > total && d < z.start ? d + total : d;
}

// Which samples the pit lane covers, on which side, at what width. The width
// ramps up over `taper` m after entry and back down before exit, so the lane
// blends smoothly off/onto the track instead of starting as a hard rectangle.
export function computePitInfo(samples: CenterlineSample[], project: TrackProject): PitSample[] {
  const info: PitSample[] = samples.map(() => ({ left: 0, right: 0 }));
  if (!project.pit.enabled) return info;

  const total = samples.length ? samples[samples.length - 1].dist : 0;
  const z = pitZone(project, total);
  const side = project.pit.side;

  for (let i = 0; i < samples.length; i++) {
    const d = pitRel(samples[i].dist, z, total);
    if (d < z.start || d > z.end) continue;
    const ramp = Math.max(0, Math.min(1, (d - z.start) / z.taper, (z.end - d) / z.taper));
    info[i][side] = project.pit.width * ramp;
  }
  return info;
}

// Drivable pit lane (1PIT): a strip adjacent to the main road edge, sharing the
// edge (no overlap), extending outward by the (tapered) pit width. Normals up.
export function buildPitLane(
  samples: CenterlineSample[],
  info: PitSample[],
  width: number,
): MeshData {
  const vertices: Vec3[] = [];
  const faces: [number, number, number][] = [];

  for (const side of ['left', 'right'] as const) {
    let i = 0;
    while (i < samples.length) {
      if (info[i][side] <= 0) { i++; continue; }
      let j = i + 1;
      while (j < samples.length && info[j][side] > 0) j++;
      if (j - i >= 2) emitPitStrip(vertices, faces, samples, i, j, side, info, width);
      i = j;
    }
  }
  return { name: '1PIT', vertices, faces };
}

// Paved paddock beside the pit lane over the full-width zone — where the
// AC_PIT boxes live, so track-day/practice spawns feel like a real paddock.
// Same 1PIT surface (drivable, valid) as the lane it extends.
// Depth of the garage block, front wall to rear wall.
// Depth of the garage block, front wall to rear wall. Must match GARAGE_D in
// blender/build_pit_complex.py - the building is modelled at this depth.
export const GARAGE_DEPTH = 10;

export function buildPaddock(
  samples: CenterlineSample[],
  project: TrackProject,
  width: number,
  depth: number,
): MeshData {
  // A paddock is a service yard BEHIND the garages, not part of the pit lane.
  // It used to be emitted into 1PIT and laid immediately beside the lane, which
  // meant a wide apron of it counted as pit lane to AC (surfaces.ini marks 1PIT
  // IS_PITLANE=1) — the game saw the whole complex as lane. It is concrete now,
  // and it starts behind the garage block.
  const mesh: MeshData = { name: '1CONCRETE', vertices: [], faces: [] };
  if (!project.pit.enabled || !(project.pit.paddock ?? true) || samples.length < 2) return mesh;
  const total = samples[samples.length - 1].dist;
  const z = pitZone(project, total);
  if (z.boxB - z.boxA < 10) return mesh;

  const side = project.pit.side;
  const sign = side === 'left' ? 1 : -1;
  const rel = (i: number) => pitRel(samples[i].dist, z, total);
  const idx: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    if (rel(i) >= z.boxA && rel(i) <= z.boxB) idx.push(i);
  }
  idx.sort((a, b) => rel(a) - rel(b)); // wrap: tail-of-lap samples come first
  for (let n = 0; n < idx.length - 1; n++) {
    if (rel(idx[n + 1]) - rel(idx[n]) > 6) continue; // wrap seam - not adjacent
    const emit = (i: number): [Vec3, Vec3] => {
      const s = samples[i];
      const [lx, ly] = perpLeft(s.heading);
      const edge = side === 'left' ? leftEdge(s, width) : rightEdge(s, width);
      const o0 = (project.pit.width + GARAGE_DEPTH) * sign;
      const o1 = (project.pit.width + GARAGE_DEPTH + depth) * sign;
      return [
        [edge[0] + lx * o0, edge[1] + ly * o0, s.pos[2]],
        [edge[0] + lx * o1, edge[1] + ly * o1, s.pos[2]],
      ];
    };
    const [aIn, aOut] = emit(idx[n]);
    const [bIn, bOut] = emit(idx[n + 1]);
    const b = mesh.vertices.length;
    mesh.vertices.push(aIn, aOut, bIn, bOut);
    addQuadUp(mesh.vertices, mesh.faces, b, b + 1, b + 3, b + 2);
  }
  return mesh;
}

// Pit complex: (1) low pit wall separating track from pit lane over the
// full-width zone, (2) garage building along the far side of the paddock with
// dark garage doors, (3) painted pit-box lines on the lane. All follow the
// road samples, so they curve with the track.
export interface PitStructures {
  wall: MeshData; // merged into 1WALL (physical)
  lines: MeshData; // PIT_LINE painted markings (visual)
  sign: MeshData; // DECOR_PITSIGN speed-limit marker board (visual)
}

// The pit wall, the painted lines and the speed-limit board. The garages and
// the paddock are no longer built here: pitComplex.ts places Blender-modelled
// garage units, transporters and motorhomes, one set per pit box / team.
export function buildPitStructures(
  samples: CenterlineSample[],
  project: TrackProject,
  width: number,
  totalLength: number,
): PitStructures {
  const wall: MeshData = { name: '1WALL', vertices: [], faces: [], uvs: [] };
  const lines: MeshData = { name: 'PIT_LINE', vertices: [], faces: [] };
  const signMesh: MeshData = { name: 'DECOR_PITSIGN', vertices: [], faces: [], uvs: [] };
  const out = { wall, lines, sign: signMesh };
  if (!project.pit.enabled || !(project.pit.structures ?? true) || samples.length < 2) return out;

  const z = pitZone(project, totalLength);
  if (z.boxB - z.boxA < 12) return out;
  const side = project.pit.side;
  const sign = side === 'left' ? 1 : -1;
  const rel = (i: number) => pitRel(samples[i].dist, z, totalLength);
  const idx: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    if (rel(i) >= z.boxA && rel(i) <= z.boxB) idx.push(i);
  }
  idx.sort((a, b) => rel(a) - rel(b)); // wrap: keep zone order, not lap order
  if (idx.length < 2) return out;

  const at = (i: number, off: number): Vec3 => {
    const s = samples[i];
    const [lx, ly] = perpLeft(s.heading);
    const edge = side === 'left' ? leftEdge(s, width) : rightEdge(s, width);
    return [edge[0] + lx * off * sign, edge[1] + ly * off * sign, s.pos[2]];
  };

  // --- (1) pit wall on the track/lane boundary (leaves entry+exit open) ----
  const WALL_H = 1.0;
  for (let n = 0; n < idx.length - 1; n++) {
    const i = idx[n], j = idx[n + 1];
    if (rel(i) < z.boxA + 2 || rel(j) > z.boxB - 2 || rel(j) - rel(i) > 6) continue;
    const a = at(i, 0), b = at(j, 0);
    const [lx, ly] = perpLeft(samples[i].heading);
    const toLane: Vec3 = [lx * sign, ly * sign, 0];
    const base = wall.vertices.length;
    wall.vertices.push([a[0], a[1], a[2]], [a[0], a[1], a[2] + WALL_H], [b[0], b[1], b[2]], [b[0], b[1], b[2] + WALL_H]);
    wall.uvs!.push([samples[i].dist / 3, 0], [samples[i].dist / 3, 1], [samples[j].dist / 3, 0], [samples[j].dist / 3, 1]);
    addQuadToward(wall.vertices, wall.faces, base, base + 1, base + 3, base + 2, [-toLane[0], -toLane[1], 0]);
    // back face so it's solid from the lane side too
    const b2 = wall.vertices.length;
    wall.vertices.push([a[0], a[1], a[2]], [a[0], a[1], a[2] + WALL_H], [b[0], b[1], b[2]], [b[0], b[1], b[2] + WALL_H]);
    wall.uvs!.push([samples[i].dist / 3, 0], [samples[i].dist / 3, 1], [samples[j].dist / 3, 0], [samples[j].dist / 3, 1]);
    addQuadToward(wall.vertices, wall.faces, b2, b2 + 1, b2 + 3, b2 + 2, toLane);
  }

  // --- (3) painted lines on the lane ---------------------------------------
  const LIFT = 0.014;
  const stripe = (i0: number, i1: number, offA: number, offB: number) => {
    const a0 = at(i0, offA), a1 = at(i0, offB), b0 = at(i1, offA), b1 = at(i1, offB);
    const b = lines.vertices.length;
    lines.vertices.push(
      [a0[0], a0[1], a0[2] + LIFT], [a1[0], a1[1], a1[2] + LIFT],
      [b0[0], b0[1], b0[2] + LIFT], [b1[0], b1[1], b1[2] + LIFT],
    );
    addQuadUp(lines.vertices, lines.faces, b, b + 1, b + 3, b + 2);
  };
  // continuous line along the lane's outer edge, in front of the garages
  for (let n = 0; n < idx.length - 1; n++) {
    if (rel(idx[n + 1]) - rel(idx[n]) > 6) continue; // wrap seam
    stripe(idx[n], idx[n + 1], project.pit.width - 0.35, project.pit.width - 0.15);
  }
  // A BOX painted round every place a car stops. These used to be transverse
  // bars "0.4 m wide" every 8 m, but each one ran to the NEXT centreline sample
  // - ~3 m away - so they came out as fat 3 m white slabs, and on a grid of
  // their own that had nothing to do with where the AC_PIT boxes are. Now each
  // outline is built from the interpolated frame AT the box, exactly.
  const BOX_L = 6.0, BOX_W = 3.0, LINE = 0.12;
  const lane = project.pit.width / 2; // AC_PIT sits on the lane centre
  for (const d of pitBoxDistances(project, totalLength)) {
    const f = frameAtDist(samples, d);
    const fx = Math.cos(f.heading), fy = Math.sin(f.heading);
    const [lx, ly] = perpLeft(f.heading);
    const ex = f.pos[0] + lx * (width / 2) * sign, ey = f.pos[1] + ly * (width / 2) * sign;
    const P = (along: number, out: number): Vec3 =>
      [ex + fx * along + lx * sign * out, ey + fy * along + ly * sign * out, f.pos[2] + LIFT];
    const rect = (a0: number, a1: number, o0: number, o1: number) => {
      const b = lines.vertices.length;
      lines.vertices.push(P(a0, o0), P(a0, o1), P(a1, o0), P(a1, o1));
      addQuadUp(lines.vertices, lines.faces, b, b + 1, b + 3, b + 2);
    };
    const a0 = -BOX_L / 2, a1 = BOX_L / 2, o0 = lane - BOX_W / 2, o1 = lane + BOX_W / 2;
    rect(a0, a0 + LINE, o0, o1);            // front bar
    rect(a1 - LINE, a1, o0, o1);            // back bar
    rect(a0 + LINE, a1 - LINE, o0, o0 + LINE); // side nearest the track
    rect(a0 + LINE, a1 - LINE, o1 - LINE, o1); // side nearest the garage
  }

  // --- (4) pit SPEED LIMIT line + marker board -----------------------------
  // A real pit lane tells you where the limiter has to be on: a white line
  // right across the lane, with a board beside it. The limit begins just after
  // the entry taper (the lane is at full width by then) and ends before the
  // exit taper. `idx` only spans the box zone, so these need their own lookup
  // over the WHOLE pit zone.
  const nearest = (d: number): number | null => {
    let best: number | null = null, bestGap = Infinity;
    for (let i = 0; i < samples.length; i++) {
      const gap = Math.abs(rel(i) - d);
      if (gap < bestGap) { bestGap = gap; best = i; }
    }
    return bestGap <= 6 ? best : null;
  };
  const crossLine = (i: number) => {
    const s0 = samples[i];
    const fx = Math.cos(s0.heading), fy = Math.sin(s0.heading);
    const LEN = 0.5;
    const a0 = at(i, 0.25), a1 = at(i, project.pit.width - 0.25);
    const b = lines.vertices.length;
    lines.vertices.push(
      [a0[0], a0[1], a0[2] + LIFT], [a1[0], a1[1], a1[2] + LIFT],
      [a0[0] + fx * LEN, a0[1] + fy * LEN, a0[2] + LIFT],
      [a1[0] + fx * LEN, a1[1] + fy * LEN, a1[2] + LIFT],
    );
    addQuadUp(lines.vertices, lines.faces, b, b + 1, b + 3, b + 2);
  };
  const iLimit = nearest(z.start + z.taper + 1);
  const iEnd = nearest(z.end - z.taper - 1);
  if (iLimit !== null) crossLine(iLimit);
  if (iEnd !== null) crossLine(iEnd);

  // Board on a post, just beyond the lane's outer edge, facing the cars coming
  // down the lane. It sits BEFORE the garage frontage (which starts at boxA),
  // so it never lands inside the building.
  if (iLimit !== null) {
    const s0 = samples[iLimit];
    const fwd: Vec3 = [Math.cos(s0.heading), Math.sin(s0.heading), 0];
    const facing: Vec3 = [-fwd[0], -fwd[1], 0]; // read by a car driving in
    const foot = at(iLimit, project.pit.width + 0.8);
    const [lx, ly] = perpLeft(s0.heading);
    const across: [number, number] = [lx * sign, ly * sign];
    const PW = 1.3, PH = 1.0, Z0 = 1.0; // panel width/height, bottom height
    const panel = (u: number) => [foot[0] + across[0] * u, foot[1] + across[1] * u] as [number, number];
    const pA = panel(-PW / 2), pB = panel(PW / 2);
    // both sides, so it is never invisible - and 4 cm apart, because two faces
    // on one plane facing opposite ways z-fight wherever both are drawn
    for (const dir of [facing, fwd]) {
      const t = (dir === fwd ? 0.02 : -0.02);
      const qa = [pA[0] + fwd[0] * t, pA[1] + fwd[1] * t], qb = [pB[0] + fwd[0] * t, pB[1] + fwd[1] * t];
      const b = signMesh.vertices.length;
      signMesh.vertices.push(
        [qa[0], qa[1], foot[2] + Z0], [qa[0], qa[1], foot[2] + Z0 + PH],
        [qb[0], qb[1], foot[2] + Z0], [qb[0], qb[1], foot[2] + Z0 + PH],
      );
      signMesh.uvs!.push([0, 0], [0, 1], [1, 0], [1, 1]);
      addQuadToward(signMesh.vertices, signMesh.faces, b, b + 1, b + 3, b + 2, dir);
    }
    // post
    const POST = 0.06;
    for (const dir of [facing, fwd]) {
      const q1 = panel(-POST), q2 = panel(POST);
      const b = signMesh.vertices.length;
      signMesh.vertices.push(
        [q1[0], q1[1], foot[2]], [q1[0], q1[1], foot[2] + Z0],
        [q2[0], q2[1], foot[2]], [q2[0], q2[1], foot[2] + Z0],
      );
      signMesh.uvs!.push([0.46, 0.02], [0.46, 0.06], [0.54, 0.02], [0.54, 0.06]);
      addQuadToward(signMesh.vertices, signMesh.faces, b, b + 1, b + 3, b + 2, dir);
    }
  }
  return out;
}

function emitPitStrip(
  vertices: Vec3[],
  faces: [number, number, number][],
  samples: CenterlineSample[],
  from: number,
  to: number,
  side: 'left' | 'right',
  info: PitSample[],
  width: number,
): void {
  const base = vertices.length;
  const sign = side === 'left' ? 1 : -1;
  for (let r = from; r < to; r++) {
    const s = samples[r];
    const [lx, ly] = perpLeft(s.heading);
    const inner = side === 'left' ? leftEdge(s, width) : rightEdge(s, width);
    const off = info[r][side] * sign;
    vertices.push([inner[0], inner[1], s.pos[2]]);
    vertices.push([inner[0] + lx * off, inner[1] + ly * off, s.pos[2]]);
  }
  const count = to - from;
  for (let r = 0; r < count - 1; r++) {
    const inA = base + 2 * r, outA = base + 2 * r + 1;
    const inB = base + 2 * r + 2, outB = base + 2 * r + 3;
    addQuadUp(vertices, faces, inA, outA, outB, inB);
  }
}
