import type { TrackProject } from '../types';
import type { CenterlineSample, MeshData, Vec3 } from './types';
import { perpLeft, leftEdge, rightEdge } from './frames';
import { addQuadUp } from './meshbuilder';

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
  const start = Math.max(0, Math.min(project.pit.entry, project.pit.exit));
  const end = Math.min(total, Math.max(project.pit.entry, project.pit.exit));
  const span = Math.max(1, end - start);
  const taper = Math.min(35, span / 3);
  return { start, end, taper, boxA: start + taper + 4, boxB: end - taper - 4 };
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
    const d = samples[i].dist;
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
  const idx: number[] = [];
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].dist >= z.boxA && samples[i].dist <= z.boxB) idx.push(i);
  }
  for (let n = 0; n < idx.length - 1; n++) {
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
