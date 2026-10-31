import type { TrackProject } from '../types';
import type { CenterlineSample, MeshData, Vec3 } from './types';
import { frameAtDist, perpLeft } from './frames';
import { pitZone, pitBoxDistances, GARAGE_DEPTH } from './pitlane';
import data from '../data/pitModels.json';

// ---------------------------------------------------------------------------
// The F1 pit complex: Blender-modelled garage units, transporters and team
// motorhomes (blender/build_pit_complex.py -> src/data/pitModels.json).
//
//   one GARAGE UNIT per pit box, its door facing the box, widened or narrowed
//   to the box spacing; together they form one continuous pit building
//   one TRANSPORTER and one MOTORHOME per team (two boxes), in the paddock
//   behind - so a longer pit lane brings a bigger paddock with it
//
// Everything stays inside the pit zone's box section (boxA..boxB), which is
// exactly the stretch the run-off and barrier are pushed back for. Outside it
// the barrier is at its normal distance, and a garage there would stand in it.
// ---------------------------------------------------------------------------

interface Model { v: number[][]; t: number[][]; tm: string[]; min: number[]; max: number[] }
const LIB = data as unknown as {
  garageWidth: number; garageDepth: number;
  garage: Model; motorhome: Model; transporter: Model;
};
if (LIB.garageDepth !== GARAGE_DEPTH) {
  throw new Error(`pitModels.json garage depth ${LIB.garageDepth} != GARAGE_DEPTH ${GARAGE_DEPTH}`);
}

export const TEAM_COUNT = 8;
/** Team liveries are drawn for faces this many times longer than they are tall. */
export const TEAM_ASPECT = 4;

// metres per texture tile for world-space mapping, by material
const TILE: Record<string, number> = { DECOR_ROOF: 6, DECOR_CHASSIS: 2, DECOR_LAMP: 2 };
const MAX_GARAGE_W = 18;
const MIN_GARAGE_W = 8;

type V2 = [number, number];

function normalOf(p: Vec3[]): Vec3 {
  const u = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
  const v = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
  const n: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
}

// UVs in WORLD space, after placement. A unit is widened to fit its box, so
// model-space UVs would stretch the cladding with it; mapped here, textures keep
// their real scale and run on unbroken from one garage into the next.
function uvFor(material: string, p: Vec3[]): V2[] {
  const n = normalOf(p);
  const flat = Math.abs(n[2]) > 0.7;
  // a vertical face's "right", as seen by someone standing in front of it,
  // so lettering reads left to right whichever way the face points
  const rl = Math.hypot(n[0], n[1]) || 1;
  const r: V2 = [-n[1] / rl, n[0] / rl];
  const across = (q: Vec3) => q[0] * r[0] + q[1] * r[1];
  const zs = p.map((q) => q[2]);
  const z0 = Math.min(...zs), z1 = Math.max(...zs);

  if (material === 'TEAM') {
    // roofs and canopy tops: plain team colour, from the solid patch at the
    // right of the livery (past the swoosh) - tiling the whole livery there
    // scattered dozens of tiny team names across the roof
    if (flat) return p.map((): V2 => [0.965, 0.5]);
    const H = Math.max(0.05, z1 - z0);
    return p.map((q) => [across(q) / (TEAM_ASPECT * H), (q[2] - z0) / H]);
  }
  if (material === 'DECOR_GARAGE' && !flat) {
    // one whole shutter per door face
    const a = p.map(across), a0 = Math.min(...a), a1 = Math.max(...a);
    return p.map((q, k) => [(a[k] - a0) / Math.max(0.05, a1 - a0), (q[2] - z0) / Math.max(0.05, z1 - z0)]);
  }
  const T = TILE[material] ?? 4;
  if (flat) return p.map((q) => [q[0] / T, q[1] / T]);
  return p.map((q) => [across(q) / T, q[2] / T]);
}

export function buildPitComplex(
  samples: CenterlineSample[],
  project: TrackProject,
  width: number,
): MeshData[] {
  if (!project.pit.enabled || !(project.pit.structures ?? true) || samples.length < 2) return [];
  const total = samples[samples.length - 1].dist;
  const z = pitZone(project, total);
  if (z.boxB - z.boxA < 12) return [];
  const boxes = pitBoxDistances(project, total);
  if (!boxes.length) return [];
  const sign = project.pit.side === 'left' ? 1 : -1;

  const meshes = new Map<string, MeshData>();
  const get = (name: string): MeshData => {
    let m = meshes.get(name);
    if (!m) { m = { name, vertices: [], faces: [], uvs: [] }; meshes.set(name, m); }
    return m;
  };

  // Place a model with its local Y=0 plane `off` metres out from the road edge,
  // centred `d` along the lap, its X scaled by `sx`.
  const place = (mdl: Model, d: number, off: number, sx: number, team: number) => {
    const f = frameAtDist(samples, d);
    const fwd: V2 = [Math.cos(f.heading), Math.sin(f.heading)];
    const [lx, ly] = perpLeft(f.heading);
    const out: V2 = [lx * sign, ly * sign];                 // model +Y: away from the track
    // model +X: along the lane, reversed on the right so the frame stays
    // right-handed - a proper rotation, so triangle winding is preserved
    const ax: V2 = sign > 0 ? fwd : [-fwd[0], -fwd[1]];
    const ox = f.pos[0] + lx * (width / 2) * sign + out[0] * off;
    const oy = f.pos[1] + ly * (width / 2) * sign + out[1] * off;
    const oz = f.pos[2];
    const world = mdl.v.map((q): Vec3 => [
      ox + ax[0] * q[0] * sx + out[0] * q[1],
      oy + ax[1] * q[0] * sx + out[1] * q[1],
      oz + q[2],
    ]);
    const livery = `DECOR_TEAM${(team % TEAM_COUNT) + 1}`;
    for (let k = 0; k < mdl.t.length; k++) {
      const [a, b, c] = mdl.t[k];
      const src = mdl.tm[k];
      const m = get(src === 'TEAM' ? livery : src);
      const tri = [world[a], world[b], world[c]];
      const base = m.vertices.length;
      // own vertices per triangle: flat shading, which an architectural model
      // needs - shared vertices would round every edge of every box
      m.vertices.push([...tri[0]] as Vec3, [...tri[1]] as Vec3, [...tri[2]] as Vec3);
      m.faces.push([base, base + 1, base + 2]);
      m.uvs!.push(...uvFor(src, tri));
    }
  };

  const clip = (lo: number, hi: number): [number, number] => [Math.max(lo, z.boxA), Math.min(hi, z.boxB)];
  // Garage SLOTS. Normally one per box, centred on it. But a pit lane can hold
  // more boxes than it has room for - 20 boxes in 42 m is 1.8 m each, narrower
  // than a car - and one garage per box there means no garages at all. Cars
  // share a garage when space is that tight, so then the stretch is filled with
  // properly sized ~12 m garages instead.
  const spacing = boxes.length > 1 ? (boxes[boxes.length - 1] - boxes[0]) / (boxes.length - 1) : LIB.garageWidth;
  let slots: number[];
  let half: number;
  if (spacing >= MIN_GARAGE_W) {
    slots = boxes;
    half = Math.min(spacing, MAX_GARAGE_W) / 2;
  } else {
    const len = z.boxB - z.boxA;
    const n = Math.max(1, Math.round(len / 12));
    half = len / n / 2;
    slots = Array.from({ length: n }, (_, k) => z.boxA + half * (2 * k + 1));
  }

  // garages, shoulder to shoulder
  slots.forEach((d, j) => {
    const [lo, hi] = clip(d - half, d + half);
    if (hi - lo < 4) return;
    place(LIB.garage, (lo + hi) / 2, project.pit.width, (hi - lo) / LIB.garageWidth, Math.floor(j / 2));
  });

  // paddock: a transporter and a motorhome per team, behind its two garages
  if (project.pit.paddock ?? true) {
    const back = project.pit.width + GARAGE_DEPTH;
    const len = (m: Model) => m.max[0] - m.min[0];
    for (let team = 0; team * 2 < slots.length; team++) {
      const ds = slots.slice(team * 2, team * 2 + 2);
      const [lo, hi] = clip(ds[0] - half, ds[ds.length - 1] + half);
      const room = hi - lo, mid = (lo + hi) / 2;
      const tr = Math.min(1, (room - 1.5) / len(LIB.transporter));
      if (tr >= 0.6) place(LIB.transporter, mid, back + 3.0, tr, team);
      const mh = Math.min(1, (room - 2) / len(LIB.motorhome));
      if (mh >= 0.55) place(LIB.motorhome, mid, back + 11.5, mh, team);
    }
  }
  return [...meshes.values()];
}
