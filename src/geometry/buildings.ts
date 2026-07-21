import type { Building, BuildingKind } from '../types';
import type { CenterlineSample, MeshData, Vec3 } from './types';
import { addQuadUp, addQuadToward } from './meshbuilder';

// Facade style -> mesh (each mesh gets its own generated texture).
const KIND_MESH: Record<BuildingKind, string> = {
  offices: 'DECOR_BUILDING',
  glass: 'DECOR_BLDGLASS',
  brick: 'DECOR_BLDBRICK',
  hangar: 'DECOR_BLDHANGAR',
};

// Placeable decorative buildings (visual only in AC — no surface prefix).
// Simple rotated boxes; ground height from the nearest centerline sample.
// One mesh PER FACADE KIND so each kind renders with its own texture.
export function buildBuildings(buildings: Building[], samples: CenterlineSample[]): MeshData[] {
  const meshes = new Map<string, MeshData>();
  if (!buildings.length || samples.length < 2) return [];

  const zAt = (x: number, y: number): number => {
    let bz = 0, bd = Infinity;
    for (const s of samples) {
      const dx = x - s.pos[0], dy = y - s.pos[1];
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; bz = s.pos[2]; }
    }
    return bz;
  };

  for (const b of buildings) {
    const name = KIND_MESH[b.kind ?? 'offices'] ?? 'DECOR_BUILDING';
    let mesh = meshes.get(name);
    if (!mesh) {
      mesh = { name, vertices: [], faces: [], uvs: [] };
      meshes.set(name, mesh);
    }
    const a = (b.rot * Math.PI) / 180;
    const ux = Math.cos(a), uy = Math.sin(a); // along length
    const vx = -Math.sin(a), vy = Math.cos(a); // along depth
    const hw = b.w / 2, hd = b.d / 2;
    const z0 = zAt(b.x, b.y);
    const c: [number, number][] = [
      [b.x - ux * hw - vx * hd, b.y - uy * hw - vy * hd],
      [b.x + ux * hw - vx * hd, b.y + uy * hw - vy * hd],
      [b.x + ux * hw + vx * hd, b.y + uy * hw + vy * hd],
      [b.x - ux * hw + vx * hd, b.y - uy * hw + vy * hd],
    ];
    for (let i = 0; i < 4; i++) {
      const p = c[i], q = c[(i + 1) % 4];
      const out: Vec3 = [(p[0] + q[0]) / 2 - b.x, (p[1] + q[1]) / 2 - b.y, 0];
      const base = mesh.vertices.length;
      mesh.vertices.push([p[0], p[1], z0], [p[0], p[1], z0 + b.h], [q[0], q[1], z0], [q[0], q[1], z0 + b.h]);
      const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
      mesh.uvs!.push([0, 0], [0, b.h / 4], [len / 4, 0], [len / 4, b.h / 4]);
      addQuadToward(mesh.vertices, mesh.faces, base, base + 1, base + 3, base + 2, out);
    }
    const base = mesh.vertices.length;
    for (const [x, y] of c) {
      mesh.vertices.push([x, y, z0 + b.h]);
      mesh.uvs!.push([x / 6, y / 6]);
    }
    addQuadUp(mesh.vertices, mesh.faces, base, base + 1, base + 2, base + 3);
  }
  return [...meshes.values()];
}
