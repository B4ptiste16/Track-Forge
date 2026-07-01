import type { CenterlineSample, MeshData, Vec3 } from './types';
import { leftEdge, rightEdge } from './frames';

// Build the road ribbon (1ROAD) as a triangle strip between consecutive
// cross-sections. Winding is chosen so every face normal points up (+Z).
//
// Per sample i we emit two vertices: index 2i = left edge, 2i+1 = right edge.
// For the quad between sample i and i+1:
//   a = L_i (2i), b = R_i (2i+1), c = L_{i+1} (2i+2), d = R_{i+1} (2i+3)
// Triangles (b,c,a) and (b,d,c) both yield a +Z normal (verified analytically
// for the flat case; rotation/elevation preserve the up-facing orientation).
export function buildRoad(samples: CenterlineSample[], width: number): MeshData {
  const vertices: Vec3[] = [];
  const faces: [number, number, number][] = [];

  for (const s of samples) {
    vertices.push(leftEdge(s, width));
    vertices.push(rightEdge(s, width));
  }

  for (let i = 0; i < samples.length - 1; i++) {
    const a = 2 * i;
    const b = 2 * i + 1;
    const c = 2 * i + 2;
    const d = 2 * i + 3;
    faces.push([b, c, a]);
    faces.push([b, d, c]);
  }

  return { name: '1ROAD', vertices, faces };
}
