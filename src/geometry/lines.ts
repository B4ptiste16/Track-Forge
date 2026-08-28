import type { CenterlineSample, MeshData, Vec3 } from './types';
import { offsetPoint, perpLeft } from './frames';
import { addQuadUp } from './meshbuilder';

const LINE_W = 0.2; // painted line width (m)
const INSET = 0.12; // from the road edge to the line's outer side (m)
const LIFT = 0.006; // above the road, below the kerbs (0.01)

// Continuous white edge lines on both sides of the road. Visual-only mesh
// (no digit prefix), floats just above 1ROAD so the car physically drives on
// the road surface beneath it.
export function buildRoadLines(samples: CenterlineSample[], width: number): MeshData {
  const mesh: MeshData = { name: 'ROAD_LINE', vertices: [], faces: [] };
  for (const sign of [1, -1]) {
    const oOut = (width / 2 - INSET) * sign;
    const oIn = (width / 2 - INSET - LINE_W) * sign;
    for (let i = 0; i < samples.length - 1; i++) {
      const b = mesh.vertices.length;
      const a0 = offsetPoint(samples[i], oIn);
      const a1 = offsetPoint(samples[i], oOut);
      const c0 = offsetPoint(samples[i + 1], oIn);
      const c1 = offsetPoint(samples[i + 1], oOut);
      mesh.vertices.push(
        [a0[0], a0[1], a0[2] + LIFT], [a1[0], a1[1], a1[2] + LIFT],
        [c0[0], c0[1], c0[2] + LIFT], [c1[0], c1[1], c1[2] + LIFT],
      );
      addQuadUp(mesh.vertices, mesh.faces, b, b + 1, b + 3, b + 2);
    }
  }
  addStartLine(mesh, samples, width);
  return mesh;
}

// START/FINISH. A band right across the road at lap distance 0 — the same place
// AC times the lap (distance 0 of fast_lane.ai), so what the driver sees and
// what the game counts are the same line. Painted on the SAME visual mesh as
// the edge lines: one material, no extra draw call.
const START_LEN = 0.6; // along the track (m)

function addStartLine(mesh: MeshData, samples: CenterlineSample[], width: number): void {
  if (samples.length < 2) return;
  const s0 = samples[0];
  const half = width / 2 - INSET;
  const [lx, ly] = perpLeft(s0.heading);
  const fx = Math.cos(s0.heading), fy = Math.sin(s0.heading);
  // Built from the frame at d=0 and extended forward by hand rather than from
  // the next sample: samples can be metres apart, and snapping the line to one
  // would paint a band that wide.
  const corner = (f: number, l: number): Vec3 =>
    [s0.pos[0] + fx * f + lx * l, s0.pos[1] + fy * f + ly * l, s0.pos[2] + LIFT];
  const b = mesh.vertices.length;
  mesh.vertices.push(
    corner(0, -half), corner(0, half),
    corner(START_LEN, -half), corner(START_LEN, half),
  );
  addQuadUp(mesh.vertices, mesh.faces, b, b + 1, b + 3, b + 2);
}
