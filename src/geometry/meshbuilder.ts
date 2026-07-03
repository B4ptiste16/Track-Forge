import type { Vec3 } from './types';

// Z-component of the normal of triangle (a,b,c) = (b-a) x (c-a).
function triNormalZ(a: Vec3, b: Vec3, c: Vec3): number {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  return ux * vy - uy * vx;
}

// Full normal of triangle (a,b,c).
function triNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

// Add a quad (given its four corner indices in ring order) as two triangles,
// guaranteeing both face normals point up (+Z). [CORRECTNESS] This is the
// single chokepoint that keeps every generated surface visible/solid from above.
export function addQuadUp(
  vertices: Vec3[],
  faces: [number, number, number][],
  v0: number,
  v1: number,
  v2: number,
  v3: number,
): void {
  const a = vertices[v0];
  const b = vertices[v1];
  const c = vertices[v2];
  if (triNormalZ(a, b, c) >= 0) {
    faces.push([v0, v1, v2]);
    faces.push([v0, v2, v3]);
  } else {
    faces.push([v0, v2, v1]);
    faces.push([v0, v3, v2]);
  }
}

// Add a single triangle wound so its normal points up (+Z).
export function addTriUp(
  vertices: Vec3[],
  faces: [number, number, number][],
  v0: number,
  v1: number,
  v2: number,
): void {
  if (triNormalZ(vertices[v0], vertices[v1], vertices[v2]) >= 0) faces.push([v0, v1, v2]);
  else faces.push([v0, v2, v1]);
}

// Add a quad whose face normals are made to point toward `dir` (used for walls,
// so barriers are lit/visible from the track side).
export function addQuadToward(
  vertices: Vec3[],
  faces: [number, number, number][],
  v0: number,
  v1: number,
  v2: number,
  v3: number,
  dir: Vec3,
): void {
  const n = triNormal(vertices[v0], vertices[v1], vertices[v2]);
  if (n[0] * dir[0] + n[1] * dir[1] + n[2] * dir[2] >= 0) {
    faces.push([v0, v1, v2]);
    faces.push([v0, v2, v3]);
  } else {
    faces.push([v0, v2, v1]);
    faces.push([v0, v3, v2]);
  }
}
