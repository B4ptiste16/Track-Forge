import type { TrackProp } from '../types';
import type { CenterlineSample, MeshData, Vec3 } from './types';
import type { ResolvedSample } from './runoff';
import { perpLeft } from './frames';
import propData from '../data/props.json';

interface RawProp {
  v: number[][];   // vertices, origin centred in plan and sitting on z = 0
  uv: number[][];
  t: number[][];   // triangles
  tm: string[];    // destination mesh name per triangle (one per material)
  size: number[];
}
const LIB = propData as unknown as Record<string, RawProp>;

export const PROP_NAMES = Object.keys(LIB).sort();

// One mesh PER SOURCE MATERIAL. The pack's props share a texture library — the
// same 'Vehicles' sheet skins every car and truck, 'barrier-zp' every banner —
// so grouping by material keeps the draw calls down while still letting each
// prop get the texture it was painted with. A single merged mesh would force
// every prop to share one texture.

export function propSize(kind: string): number[] | null {
  return LIB[kind]?.size ?? null;
}

// Place the library props around the lap. Each one is yawed to face the track
// (plus its own rot), lifted onto the local surface height, and appended to a
// single mesh.
export function buildProps(props: TrackProp[], samples: CenterlineSample[]): MeshData[] {
  if (!props?.length || samples.length < 2) return [];
  const byMesh = new Map<string, MeshData>();
  const getMesh = (name: string): MeshData => {
    let m = byMesh.get(name);
    if (!m) { m = { name, vertices: [], faces: [], uvs: [] }; byMesh.set(name, m); }
    return m;
  };

  const total = samples[samples.length - 1].dist;
  const frameAt = (dist: number) => {
    const d = total > 0 ? ((dist % total) + total) % total : 0;
    let i = 0;
    while (i < samples.length - 1 && samples[i + 1].dist < d) i++;
    return samples[i];
  };

  for (const p of props) {
    const raw = LIB[p.kind];
    if (!raw) continue;
    const s = frameAt(p.dist);
    const [lx, ly] = perpLeft(s.heading);
    const sign = p.side === 'left' ? 1 : -1;
    const ox = s.pos[0] + lx * p.offset * sign;
    const oy = s.pos[1] + ly * p.offset * sign;

    // ALIGN WITH the track and face it. The prop's long axis (local X) runs along
    // the direction of travel and its front (local -Y) looks inward, which is how
    // trackside furniture actually sits: a hoarding runs down the barrier, a
    // grandstand runs down the straight. The first version yawed by another 90
    // degrees, which turned every prop broadside — a 4 m board became a fin
    // sticking out of the wall, and the 102 m grandstand would have speared
    // straight across the circuit. Anything that genuinely spans the track, like
    // a gantry, asks for it with rot 90.
    const yaw = s.heading + (p.side === 'right' ? Math.PI : 0) + ((p.rot ?? 0) * Math.PI) / 180;
    const c = Math.cos(yaw), sn = Math.sin(yaw);
    const k = p.scale && p.scale > 0 ? p.scale : 1;

    // A prop's vertices are shared across its materials, so each destination mesh
    // takes only the ones its own triangles actually reference. Copying the whole
    // vertex block into every mesh bloated them several times over, and KN5 caps
    // a mesh at 65,535 vertices — a track with a lot of scenery would hit it.
    const remap = new Map<string, Map<number, number>>();
    const place = (vi: number, mesh: MeshData, name: string): number => {
      let r = remap.get(name);
      if (!r) { r = new Map(); remap.set(name, r); }
      let j = r.get(vi);
      if (j === undefined) {
        j = mesh.vertices.length;
        r.set(vi, j);
        const v = raw.v[vi];
        const x = v[0] * k, y = v[1] * k, z = v[2] * k;
        mesh.vertices.push([ox + x * c - y * sn, oy + x * sn + y * c, s.pos[2] + z] as Vec3);
        const uv = raw.uv[vi];
        mesh.uvs!.push([uv[0], uv[1]]);
      }
      return j;
    };
    for (let ti = 0; ti < raw.t.length; ti++) {
      const name = raw.tm[ti];
      const mesh = getMesh(name);
      const t = raw.t[ti];
      mesh.faces.push([place(t[0], mesh, name), place(t[1], mesh, name), place(t[2], mesh, name)]);
    }
  }
  return [...byMesh.values()].filter((m) => m.faces.length > 0);
}

// Hoardings placed automatically. Two kinds, because that is how a real circuit
// carries advertising:
//   - panels ON the barrier face, wherever there IS a barrier. A board planted
//     in a field beside an open run-off looks like fly-posting; real hoardings
//     are bolted to the wall.
//   - a gantry spanning the track every so often, which is the other place a
//     circuit puts a sponsor.
const ADVERT_SPACING = 26;   // m between wall panels (they run nose to tail)
const GANTRY_SPACING = 520;  // m between overhead gantries

export function autoAdverts(samples: CenterlineSample[], resolved: ResolvedSample[], width: number): TrackProp[] {
  if (samples.length < 4) return [];
  const out: TrackProp[] = [];
  let n = 0;

  for (const side of ['left', 'right'] as const) {
    let next = side === 'left' ? ADVERT_SPACING / 2 : ADVERT_SPACING;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      if (s.dist < next) continue;
      const r = resolved[i]?.[side];
      // No barrier here means nothing to mount to. Skipping is deliberate: the
      // alternative is a sign standing on its own in the grass.
      if (!r || !r.wall) { next = s.dist + 4; continue; }
      next = s.dist + ADVERT_SPACING;
      // Sit against the inner face of the barrier, a little proud of it so the
      // two do not z-fight.
      const off = width / 2 + (r.wallDist ?? r.width) - 0.35;
      if (off <= width / 2 + 0.5) continue;
      out.push({ id: `adv${side}${n++}`, kind: 'AC BAPTOU Wall Panel', dist: s.dist, side, offset: off });
    }
  }

  // Overhead gantries. Placed from the RIGHT so the prop's long axis ends up
  // across the track rather than along it (the yaw is heading + 90 on that
  // side), centred on the road.
  const total = samples[samples.length - 1].dist;
  for (let d = GANTRY_SPACING; d < total - 40; d += GANTRY_SPACING) {
    out.push({ id: `advg${n++}`, kind: 'AC BAPTOU Gantry', dist: d, side: 'right', offset: 0, rot: 90 });
  }
  return out;
}
