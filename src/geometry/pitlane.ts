import type { TrackProject } from '../types';
import type { CenterlineSample, MeshData, Vec3 } from './types';
import { perpLeft, leftEdge, rightEdge } from './frames';
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
export function buildPaddock(
  samples: CenterlineSample[],
  project: TrackProject,
  width: number,
  depth: number,
): MeshData {
  const mesh: MeshData = { name: '1PIT', vertices: [], faces: [] };
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
      const o0 = project.pit.width * sign;
      const o1 = (project.pit.width + depth) * sign;
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
  building: MeshData; // DECOR_PITBLDG (visual)
  garage: MeshData; // DECOR_GARAGE door quads (visual)
  lines: MeshData; // PIT_LINE painted markings (visual)
}

export function buildPitStructures(
  samples: CenterlineSample[],
  project: TrackProject,
  width: number,
  totalLength: number,
  paddockDepth: number,
): PitStructures {
  const wall: MeshData = { name: '1WALL', vertices: [], faces: [], uvs: [] };
  const building: MeshData = { name: 'DECOR_PITBLDG', vertices: [], faces: [] };
  const garage: MeshData = { name: 'DECOR_GARAGE', vertices: [], faces: [] };
  const lines: MeshData = { name: 'PIT_LINE', vertices: [], faces: [] };
  const out = { wall, building, garage, lines };
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

  // --- (2) garage building along the outer edge of lane/paddock ------------
  const off0 = project.pit.width + Math.max(0, paddockDepth);
  const DEPTH = 7, H = 5;
  const emitQuadToward = (m: MeshData, p1: Vec3, p2: Vec3, z0: number, z1: number, dir: Vec3) => {
    const b = m.vertices.length;
    m.vertices.push([p1[0], p1[1], z0], [p1[0], p1[1], z1], [p2[0], p2[1], z0], [p2[0], p2[1], z1]);
    addQuadToward(m.vertices, m.faces, b, b + 1, b + 3, b + 2, dir);
  };
  for (let n = 0; n < idx.length - 1; n++) {
    const i = idx[n], j = idx[n + 1];
    if (rel(j) - rel(i) > 6) continue; // wrap seam
    const [lx, ly] = perpLeft(samples[i].heading);
    const toLane: Vec3 = [-lx * sign, -ly * sign, 0]; // building front faces the lane
    const f1 = at(i, off0), f2 = at(j, off0);
    emitQuadToward(building, f1, f2, f1[2], f1[2] + H, toLane); // front
    const r1 = at(i, off0 + DEPTH), r2 = at(j, off0 + DEPTH);
    emitQuadToward(building, r1, r2, r1[2], r1[2] + H, [-toLane[0], -toLane[1], 0]); // rear
    // roof
    const b = building.vertices.length;
    building.vertices.push(
      [f1[0], f1[1], f1[2] + H], [r1[0], r1[1], r1[2] + H],
      [f2[0], f2[1], f2[2] + H], [r2[0], r2[1], r2[2] + H],
    );
    addQuadUp(building.vertices, building.faces, b, b + 1, b + 3, b + 2);
  }
  // garage doors: dark quads slightly in front of the facade, every 8 m
  for (let d = z.boxA + 4; d < z.boxB - 6; d += 8) {
    let i0 = idx[0];
    for (const i of idx) { if (rel(i) >= d) { i0 = i; break; } }
    let i1 = i0;
    for (const i of idx) { if (rel(i) >= d + 5) { i1 = i; break; } }
    if (i1 === i0) continue;
    const [lx, ly] = perpLeft(samples[i0].heading);
    const toLane: Vec3 = [-lx * sign, -ly * sign, 0];
    const g1 = at(i0, off0 - 0.06), g2 = at(i1, off0 - 0.06);
    emitQuadToward(garage, g1, g2, g1[2], g1[2] + 3.2, toLane);
  }

  // --- (3) painted pit-box lines on the lane --------------------------------
  const LIFT = 0.007;
  const stripe = (i0: number, i1: number, offA: number, offB: number) => {
    const a0 = at(i0, offA), a1 = at(i0, offB), b0 = at(i1, offA), b1 = at(i1, offB);
    const b = lines.vertices.length;
    lines.vertices.push(
      [a0[0], a0[1], a0[2] + LIFT], [a1[0], a1[1], a1[2] + LIFT],
      [b0[0], b0[1], b0[2] + LIFT], [b1[0], b1[1], b1[2] + LIFT],
    );
    addQuadUp(lines.vertices, lines.faces, b, b + 1, b + 3, b + 2);
  };
  // continuous line along the lane's outer edge
  for (let n = 0; n < idx.length - 1; n++) {
    if (rel(idx[n + 1]) - rel(idx[n]) > 6) continue; // wrap seam
    stripe(idx[n], idx[n + 1], project.pit.width - 0.35, project.pit.width - 0.15);
  }
  // transverse box line every 8 m
  for (let d = z.boxA + 4; d < z.boxB - 2; d += 8) {
    let i0 = idx[0];
    for (const i of idx) { if (rel(i) >= d) { i0 = i; break; } }
    let i1 = i0;
    for (const i of idx) { if (rel(i) >= d + 0.4) { i1 = i; break; } }
    if (i1 !== i0) stripe(i0, i1, 0.4, project.pit.width - 0.5);
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
