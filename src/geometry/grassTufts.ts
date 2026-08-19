import type { CenterlineSample, MeshData, Vec3 } from './types';
import type { ResolvedSample } from './runoff';
import { perpLeft } from './frames';

// GRASS TUFTS — grass that actually stands up out of the ground.
//
// A flat texture can never look like the grass on a Kunos track, however well it
// is drawn, because it is a flat plane: from a car you are looking ACROSS the
// verge, nearly edge-on, and a painted plane has no blades to catch the light.
// Imola's grass is geometry — Kunos modelled it — and this is the same standard
// technique: small "cards" of alpha-cut grass, two crossed quads per tuft so the
// tuft reads from every angle, scattered over the verge.
//
// The mesh is deliberately NOT named with a leading digit: cards are scenery and
// must not be collidable, or you would hit them.
const TUFT_MESH = 'DECOR_GRASSTUFT';

export function buildGrassTufts(
  samples: CenterlineSample[],
  width: number,
  resolved: ResolvedSample[],
  density: number,
): MeshData | null {
  if (density <= 0 || samples.length < 4) return null;
  const mesh: MeshData = { name: TUFT_MESH, vertices: [], faces: [], uvs: [] };

  // Deterministic scatter: the same track must produce the same grass every
  // build, or every re-export would shuffle the whole verge.
  let seed = 20260819;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  // Spacing along the track. Denser than ~1.2 m stops being worth the vertices;
  // sparser than ~6 m reads as scattered clumps rather than a grass verge.
  const step = 6.0 - 4.8 * Math.min(1, density);
  const half = width / 2;

  let acc = 0;
  for (let i = 1; i < samples.length; i++) {
    const s = samples[i];
    acc += Math.hypot(s.pos[0] - samples[i - 1].pos[0], s.pos[1] - samples[i - 1].pos[1]);
    if (acc < step) continue;
    acc = 0;

    const [lx, ly] = perpLeft(s.heading);
    for (const side of ['left', 'right'] as const) {
      const r = resolved[i][side];
      // Only where the verge is actually grass — no tufts in a gravel trap or
      // on paved run-off.
      if (r.surface !== '1GRASS') continue;
      const band = Math.min(r.width, 14); // beyond ~14 m you cannot tell anyway
      if (band < 1.5) continue;
      const sgn = side === 'left' ? 1 : -1;

      const perRow = 1 + Math.round(3 * Math.min(1, density));
      for (let k = 0; k < perRow; k++) {
        // sit clear of the track edge so tufts never poke through the tarmac
        const off = half + 0.8 + rnd() * (band - 1.0);
        const jitter = (rnd() - 0.5) * step;
        const x = s.pos[0] + lx * off * sgn + Math.cos(s.heading) * jitter;
        const y = s.pos[1] + ly * off * sgn + Math.sin(s.heading) * jitter;
        const z = s.pos[2];
        const h = 0.22 + rnd() * 0.30;   // 22-52 cm, like an unmown verge
        const w = 0.30 + rnd() * 0.35;
        addTuft(mesh, x, y, z, w, h, rnd() * Math.PI);
      }
    }
  }
  return mesh.faces.length ? mesh : null;
}

// Two quads crossed at 90 degrees. Cheap (8 verts) and reads as a clump of
// grass from any direction, which a single flat card does not.
function addTuft(m: MeshData, x: number, y: number, z: number, w: number, h: number, rot: number): void {
  for (const a of [rot, rot + Math.PI / 2]) {
    const dx = Math.cos(a) * w / 2, dy = Math.sin(a) * w / 2;
    const b = m.vertices.length;
    m.vertices.push(
      [x - dx, y - dy, z] as Vec3,
      [x + dx, y + dy, z] as Vec3,
      [x + dx, y + dy, z + h] as Vec3,
      [x - dx, y - dy, z + h] as Vec3,
    );
    // The whole card samples the whole texture, so each tuft shows a full clump.
    m.uvs!.push([0, 1], [1, 1], [1, 0], [0, 0]);
    // Double-sided: one winding each way, so a card is never invisible from
    // behind (AC does not render backfaces).
    m.faces.push([b, b + 1, b + 2], [b, b + 2, b + 3]);
    m.faces.push([b, b + 2, b + 1], [b, b + 3, b + 2]);
  }
}
