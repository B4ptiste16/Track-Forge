import type { CenterlineSample, MeshData } from './types';
import { offsetPoint } from './frames';
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
  return mesh;
}
