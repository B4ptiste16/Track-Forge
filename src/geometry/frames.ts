import type { CenterlineSample, Vec3 } from './types';

// Unit left-perpendicular of the heading, in the XY plane.
export function perpLeft(heading: number): [number, number] {
  return [-Math.sin(heading), Math.cos(heading)];
}

// Point offset from a sample by `offset` metres along the left-perp direction,
// keeping the sample's elevation (Z).
export function offsetPoint(s: CenterlineSample, offset: number): Vec3 {
  const [lx, ly] = perpLeft(s.heading);
  return [s.pos[0] + lx * offset, s.pos[1] + ly * offset, s.pos[2]];
}

export function leftEdge(s: CenterlineSample, width: number): Vec3 {
  return offsetPoint(s, width / 2);
}

export function rightEdge(s: CenterlineSample, width: number): Vec3 {
  return offsetPoint(s, -width / 2);
}

// Position + travel direction at a distance along the centreline, INTERPOLATED
// between samples (they are ~3 m apart, so snapping to one is not good enough
// for anything that has to land exactly - a spawn, a painted box).
export interface Frame {
  pos: Vec3;
  tangent: Vec3; // unit, direction of travel (incl. slope)
  heading: number; // rad, XY yaw
}

export function frameAtDist(samples: CenterlineSample[], dist: number): Frame {
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
  const l = Math.hypot(tangent[0], tangent[1], tangent[2]) || 1;
  tangent = [tangent[0] / l, tangent[1] / l, tangent[2] / l];
  return { pos, tangent, heading: Math.atan2(tangent[1], tangent[0]) };
}
