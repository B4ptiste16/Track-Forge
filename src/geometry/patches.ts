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
// Just enough to stop a patch z-fighting the road where the two overlap, and
// far below anything the eye or a wheel reads as a step. It used to be 0.03,
// which put every patch a visible 3 cm below the tarmac it adjoined.
const PATCH_SINK = 0.005;

export function buildPatches(patches: SurfacePatch[], samples: CenterlineSample[]): MeshData[] {
  if (!patches?.length || samples.length < 2) return [];
  // Height of the track at (x, y), INTERPOLATED along the centreline. Snapping
  // to the nearest sample made this a staircase: on a gradient a patch could
  // land half a sample spacing's worth of climb away from the tarmac it was
  // supposed to sit flush with - several cm on a hilly track, and the steeper
  // the track the worse it got.
  const zAt = (x: number, y: number): number => {
    let bz = samples[0].pos[2], bd = Infinity;
    for (let i = 0; i < samples.length - 1; i++) {
      const a = samples[i].pos, b = samples[i + 1].pos;
      const ex = b[0] - a[0], ey = b[1] - a[1];
      const len2 = ex * ex + ey * ey;
      const t = len2 > 1e-9 ? Math.max(0, Math.min(1, ((x - a[0]) * ex + (y - a[1]) * ey) / len2)) : 0;
      const px = a[0] + ex * t, py = a[1] + ey * t;
      const d = (x - px) * (x - px) + (y - py) * (y - py);
      if (d < bd) { bd = d; bz = a[2] + (b[2] - a[2]) * t; }
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
