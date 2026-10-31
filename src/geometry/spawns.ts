import type { TrackProject } from '../types';
import type { CenterlineSample, EmptyData, Vec3 } from './types';
import { pitBoxDistances } from './pitlane';
import { frameAtDist, type Frame } from './frames';

const HEIGHT_ABOVE = 1.0; // m above the surface


function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
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

  // Orthonormal basis, Zc ALONG travel. Measured from Kunos content rather than
  // guessed: every AC_START node in magione.kn5 has local +Z dotted with the
  // direction of travel of its own fast_lane.ai equal to +1.000, and local Y
  // exactly (0,1,0). So a spawn null faces its local +Z. An earlier comment here
  // claimed the opposite and negated Zc, which pointed the whole grid back down
  // the circuit; while the export was also hitting gimbal lock that showed up as
  // only HALF the grid being wrong, which masked the sign error.
  //
  // FLAT, i.e. yaw only — no pitch from the track's slope. Tilting the null to
  // follow the gradient made it a three-axis rotation, and the exporter writes
  // XYZ Euler angles: a grid pointing along the FBX X axis lands exactly on the
  // XYZ gimbal singularity, where the X and Z angles come out of atan2(~0, ~0)
  // and are numerically meaningless. Neighbouring slots then got decompositions
  // 76 degrees apart for the same orientation, and any consumer using a
  // different rotation order read half the grid as facing backwards. A yaw-only
  // basis is one rotation about world up: stable, and identical in every Euler
  // order. Cars spawn HEIGHT_ABOVE over the surface and settle onto it, so the
  // lost pitch costs nothing.
  const flatLen = Math.hypot(fr.tangent[0], fr.tangent[1]) || 1;
  const zc: Vec3 = [fr.tangent[0] / flatLen, fr.tangent[1] / flatLen, 0];
  const yc: Vec3 = [0, 0, 1];
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
    // Boxes ALWAYS sit on the lane, in front of the garage doors. With a paddock
    // they used to be parked out on the paddock in rows, several metres clear of
    // the lane — track-day style, but not how a circuit works, and AC wants a
    // box it can drive to along the pit lane. The paddock is a yard behind the
    // building now and has nothing to do with where a car stops.
    const lateral = sign * (w / 2 + project.pit.width * 0.5);
    pitBoxDistances(project, total).forEach((dist, i) => {
      out.push(makeEmpty(`AC_PIT_${i}`, frameAtDist(samples, dist), lateral));
    });
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
