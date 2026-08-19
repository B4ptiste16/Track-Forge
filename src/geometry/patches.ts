import type { SurfacePatch } from '../types';
import type { CenterlineSample, MeshData, Vec3 } from './types';
import { addQuadUp } from './meshbuilder';

// HAND-PLACED SURFACE PATCHES.
// Automatic escape roads have to guess where a car will leave the track, and on
// an AI-written circuit they guess badly — which is how you end up with run-off
// scattered around the lap. A patch is the opposite: a piece of surface put
// exactly where it was asked for. Use them to lay paved run-off at the corners
// that actually need it, concrete aprons, or a gravel bed.
const SURFACE_MESH: Record<string, string> = {
  concrete: '1CONCRETE',
  tarmac: '1TARMAC',
  gravel: '1SAND',
  grass: '1GRASS',
  dirt: '1DIRT',
};

// Patches follow the ground they sit on, so they work on an elevated circuit.
// They sit a hair BELOW the racing surface for the same reason run-off does:
// where a patch meets the track, the track must be the surface you see.
const PATCH_SINK = 0.03;

export function buildPatches(patches: SurfacePatch[], samples: CenterlineSample[]): MeshData[] {
  if (!patches?.length || samples.length < 2) return [];
  const zAt = (x: number, y: number): number => {
    let bz = 0, bd = Infinity;
    for (const s of samples) {
      const dx = x - s.pos[0], dy = y - s.pos[1];
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; bz = s.pos[2]; }
    }
    return bz;
  };

  const meshes = new Map<string, MeshData>();
  for (const p of patches) {
    const name = SURFACE_MESH[p.surface] ?? '1CONCRETE';
    let m = meshes.get(name);
    if (!m) { m = { name, vertices: [], faces: [], uvs: [] }; meshes.set(name, m); }

    const rad = (p.rot * Math.PI) / 180;
    const ca = Math.cos(rad), sa = Math.sin(rad);
    const hw = Math.max(0.5, p.w) / 2, hd = Math.max(0.5, p.d) / 2;
    // Subdivide so a big patch can follow rising ground instead of cutting
    // through it as one flat plane.
    const nx = Math.max(1, Math.round(p.w / 8)), ny = Math.max(1, Math.round(p.d / 8));
    const base = m.vertices.length;
    for (let j = 0; j <= ny; j++) {
      for (let i = 0; i <= nx; i++) {
        const lx = -hw + (p.w * i) / nx, ly = -hd + (p.d * j) / ny;
        const x = p.x + lx * ca - ly * sa;
        const y = p.y + lx * sa + ly * ca;
        m.vertices.push([x, y, zAt(x, y) - PATCH_SINK] as Vec3);
        m.uvs!.push([x / 4, y / 4]);
      }
    }
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const a = base + j * (nx + 1) + i;
        addQuadUp(m.vertices, m.faces, a, a + 1, a + nx + 2, a + nx + 1);
      }
    }
  }
  return [...meshes.values()];
}
