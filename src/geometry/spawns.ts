import type { TrackProject } from '../types';
import type { CenterlineSample, EmptyData, Vec3 } from './types';
import { pitZone } from './pitlane';

const HEIGHT_ABOVE = 1.0; // m above the surface

interface Frame {
  pos: Vec3;
  tangent: Vec3; // unit, direction of travel (incl. slope)
  heading: number; // rad, XY yaw
}

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

// Interpolate position + travel tangent at a distance along the centerline.
function frameAtDist(samples: CenterlineSample[], dist: number): Frame {
  const total = samples[samples.length - 1].dist;
  // WRAP instead of clamping: a pit zone crossing the S/F line produces box
  // distances beyond `total`, which belong at the start of the lap.
  const d = total > 0 ? ((dist % total) + total) % total : 0;

  let i = 0;
  while (i < samples.length - 1 && samples[i + 1].dist < d) i++;
  const a = samples[i];
  const b = samples[Math.min(i + 1, samples.length - 1)];

  const span = b.dist - a.dist;
  const f = span > 0 ? (d - a.dist) / span : 0;
  const pos: Vec3 = [
    a.pos[0] + (b.pos[0] - a.pos[0]) * f,
    a.pos[1] + (b.pos[1] - a.pos[1]) * f,
    a.pos[2] + (b.pos[2] - a.pos[2]) * f,
  ];

  let tangent: Vec3 = [b.pos[0] - a.pos[0], b.pos[1] - a.pos[1], b.pos[2] - a.pos[2]];
  if (Math.hypot(tangent[0], tangent[1], tangent[2]) < 1e-6) {
    tangent = [Math.cos(a.heading), Math.sin(a.heading), 0];
  }
  tangent = normalize(tangent);
  return { pos, tangent, heading: Math.atan2(tangent[1], tangent[0]) };
}

// Build a spawn/timing empty. [CORRECTNESS] local +Z = travel direction,
// local +Y = up, scale = 1. Cars spawn upright and facing forward.
function makeEmpty(name: string, fr: Frame, lateral: number): EmptyData {
  // Lateral offset uses the XY left-perp; height is along world up.
  const lx = -Math.sin(fr.heading);
  const ly = Math.cos(fr.heading);
  const position: Vec3 = [
    fr.pos[0] + lx * lateral,
    fr.pos[1] + ly * lateral,
    fr.pos[2] + HEIGHT_ABOVE,
  ];

  // Orthonormal basis: Zc = travel, Yc = up (orthogonalised), Xc = Yc x Zc.
  const zc = fr.tangent;
  const upDot = zc[2];
  let yc: Vec3 = [-zc[0] * upDot, -zc[1] * upDot, 1 - zc[2] * upDot];
  yc = normalize(yc);
  const xc = normalize(cross(yc, zc));

  // World matrix columns are the local axes; emit rows for Blender's Matrix().
  const basis: [Vec3, Vec3, Vec3] = [
    [xc[0], yc[0], zc[0]],
    [xc[1], yc[1], zc[1]],
    [xc[2], yc[2], zc[2]],
  ];
  return { name, position, basis };
}

// All spawn/timing empties for the track.
export function buildEmpties(
  samples: CenterlineSample[],
  project: TrackProject,
): EmptyData[] {
  if (samples.length < 2) return [];
  const out: EmptyData[] = [];
  const w = project.road.width;
  const sf = project.startFinishDist;
  const { pits, starts } = project.grid;

  // Grid: two columns, staggered, just behind the S/F line.
  const colOff = w * 0.22;
  for (let i = 0; i < starts; i++) {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const dist = sf - 8 - row * 9;
    const lateral = col === 0 ? colOff : -colOff;
    out.push(makeEmpty(`AC_START_${i}`, frameAtDist(samples, dist), lateral));
  }

  // Pit boxes. With a paddock, boxes sit on it in rows (track-day style);
  // otherwise they line up on the pit lane inside the full-width zone.
  if (project.pit.enabled) {
    const sign = project.pit.side === 'left' ? 1 : -1;
    const total = samples[samples.length - 1].dist;
    const z = pitZone(project, total);
    const a = z.boxA + 4;
    const b = Math.max(a + 1, z.boxB - 4);
    const span = b - a;
    if (project.pit.paddock ?? true) {
      const perRow = Math.max(1, Math.floor(span / 8));
      for (let i = 0; i < pits; i++) {
        const row = Math.floor(i / perRow);
        const dist = a + (i % perRow) * 8;
        const lateral = sign * (w / 2 + project.pit.width + 4 + row * 7);
        out.push(makeEmpty(`AC_PIT_${i}`, frameAtDist(samples, dist), lateral));
      }
    } else {
      const lateral = sign * (w / 2 + project.pit.width * 0.5);
      for (let i = 0; i < pits; i++) {
        const dist = pits > 1 ? a + (span * i) / (pits - 1) : a + span / 2;
        out.push(makeEmpty(`AC_PIT_${i}`, frameAtDist(samples, dist), lateral));
      }
    }
  } else {
    const startRows = Math.max(1, Math.ceil(starts / 2));
    const pitBase = sf - 8 - startRows * 9 - 6;
    for (let i = 0; i < pits; i++) {
      out.push(makeEmpty(`AC_PIT_${i}`, frameAtDist(samples, pitBase - i * 8), -w * 0.3));
    }
  }

  // Hotlap start: on the S/F line.
  out.push(makeEmpty('AC_HOTLAP_START_0', frameAtDist(samples, sf), 0));

  // Start/finish timing gate posts: left and right road edges at the S/F line.
  // Span the WHOLE corridor (run-off both sides + the pit lane), so the
  // crossing registers even off track or driving through the pits.
  const gate = frameAtDist(samples, sf);
  const gateSpan = w / 2 + 30;
  out.push(makeEmpty('AC_TIME_0_L', gate, gateSpan));
  out.push(makeEmpty('AC_TIME_0_R', gate, -gateSpan));

  return out;
}
