// Shared geometry output types. These are consumed identically by the
// three.js preview and by the Blender-script exporter — single source of truth.

export type Vec3 = [number, number, number];

// One sample along the centerline. Coordinates are in the native frame:
// X/Y are the horizontal ground plane, Z is up (metres). This frame matches
// Blender (Z up) and the three.js preview is configured Z-up to match.
export interface CenterlineSample {
  pos: Vec3; // [x, y, z]
  heading: number; // radians, 0 = +X, CCW positive (yaw in XY plane)
  dist: number; // distance along centerline (m)
  segIndex: number; // which segment produced this sample
}

// Maps each input segment to its distance range along the centerline.
export interface SegmentSpan {
  segIndex: number;
  kind: 'straight' | 'corner';
  cornerIndex: number; // -1 for straights; otherwise 0-based corner ordinal
  dir?: 'left' | 'right';
  startDist: number;
  endDist: number;
}

// A baked mesh: vertices + triangle faces. Faces are wound so normals point up.
// `colors` (optional, per-vertex RGB 0..1) drives striped/painted previews; the
// in-game look comes from the exported textures instead.
export interface MeshData {
  name: string; // exactly one AC surface keyword: 1ROAD / 1KERB / 1GRASS
  vertices: Vec3[];
  faces: [number, number, number][];
  colors?: Vec3[];
  uvs?: [number, number][]; // per-vertex; meshes without get planar world UVs
}

// A spawn/timing object, exported as a Blender empty.
// basis columns are the local axes expressed in world space:
//   basis[*][0] = local +X, basis[*][1] = local +Y, basis[*][2] = local +Z.
// By construction local +Z = travel direction, local +Y = up, scale = 1.
export interface EmptyData {
  name: string;
  position: Vec3;
  basis: [Vec3, Vec3, Vec3]; // 3x3, given as rows for the world matrix
}

export interface ClosureInfo {
  gap: number; // metres between last and first centerline point (XY)
  headingOff: number; // degrees, |difference| between end and start heading
  closed: boolean; // within export tolerance
}

// A place where the track centerline crosses over itself (in plan view).
export interface Overlap {
  distA: number; // smaller distance-along of the crossing
  distB: number; // larger distance-along of the crossing
  x: number;
  y: number;
}

export interface BuiltTrack {
  centerline: CenterlineSample[];
  spans: SegmentSpan[];
  totalLength: number;
  closure: ClosureInfo;
  meshes: MeshData[]; // ordered for draw/export: grass, road, pit, kerb, wall
  empties: EmptyData[];
  overlaps: Overlap[];
}

// Export tolerance for loop closure.
export const CLOSE_GAP_TOL = 1.0; // metres
export const CLOSE_HEADING_TOL = 3.0; // degrees
