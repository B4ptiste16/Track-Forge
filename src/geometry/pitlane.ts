import type { TrackProject } from '../types';
import type { CenterlineSample, MeshData, Vec3 } from './types';
import { perpLeft, leftEdge, rightEdge } from './frames';
import { addQuadUp } from './meshbuilder';

export interface PitSample {
  left: number; // pit lane width on the left at this sample (0 = none)
  right: number;
}

// Which samples the pit lane covers, and on which side.
export function computePitInfo(samples: CenterlineSample[], project: TrackProject): PitSample[] {
  const info: PitSample[] = samples.map(() => ({ left: 0, right: 0 }));
  if (!project.pit.enabled) return info;

  const total = samples.length ? samples[samples.length - 1].dist : 0;
  const start = Math.max(0, Math.min(project.pit.entry, project.pit.exit));
  const end = Math.min(total, Math.max(project.pit.entry, project.pit.exit));
  const side = project.pit.side;

  for (let i = 0; i < samples.length; i++) {
    const d = samples[i].dist;
    if (d >= start && d <= end) info[i][side] = project.pit.width;
  }
  return info;
}

// Drivable pit lane (1PIT): a strip adjacent to the main road edge, sharing the
// edge (no overlap), extending outward by the pit width. Normals up.
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
