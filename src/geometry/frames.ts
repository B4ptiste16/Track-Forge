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
