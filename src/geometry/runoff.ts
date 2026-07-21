import type { RunoffType, WallConfig, WallGap, ManualWall } from '../types';
import type { CenterlineSample, MeshData, SegmentSpan, Vec3 } from './types';
import { perpLeft, leftEdge, rightEdge } from './frames';
import { addQuadUp, addQuadToward, addTriUp } from './meshbuilder';

export interface SideOffset {
  left: number;
  right: number;
}

// A big flat grass plane under the whole track so there are never holes to fall
// through (inside corners, beyond the runoff, etc.). It sits just below the
// lowest point so the road/runoff always win the physics raycast (no quicksand).
export function buildGroundPlane(samples: CenterlineSample[], margin = 80): MeshData {
  if (samples.length < 2) return { name: '1GRASS', vertices: [], faces: [] };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, minZ = Infinity;
  for (const s of samples) {
    minX = Math.min(minX, s.pos[0]); maxX = Math.max(maxX, s.pos[0]);
    minY = Math.min(minY, s.pos[1]); maxY = Math.max(maxY, s.pos[1]);
    minZ = Math.min(minZ, s.pos[2]);
  }
  const z = minZ - 0.1;
  const vertices: Vec3[] = [
    [minX - margin, minY - margin, z],
    [maxX + margin, minY - margin, z],
    [maxX + margin, maxY + margin, z],
    [minX - margin, maxY + margin, z],
  ];
  const faces: [number, number, number][] = [];
  addQuadUp(vertices, faces, 0, 1, 2, 3);
  return { name: '1GRASS', vertices, faces };
}

// Resolved trackside strip for one sample-side (defaults + zone overrides).
export interface ResolvedSide {
  surface: string; // mesh name: 1GRASS / 1SAND / 1CONCRETE
  width: number; // strip width (m)
  wall: boolean; // barrier at wallDist
  wallDist: number; // wall distance from the track edge (m)
  splitAt?: number; // 'gravel_spaced': grass up to here (m), then `surface`
  splitSurface?: string; // surface of the inner split band (1GRASS)
}
export interface ResolvedSample {
  left: ResolvedSide;
  right: ResolvedSide;
}

export function runoffSurfaceName(type: RunoffType | string): string {
  if (type === 'gravel') return '1SAND';
  if (type === 'concrete') return '1CONCRETE';
  if (type === 'tarmac') return '1TARMAC';
  if (type === 'dirt') return '1DIRT';
  return '1GRASS'; // grass and the verge of a 'wall' section
}

// One corner to fill on the inside, with the surface chosen for its infield.
export interface CornerFill {
  span: SegmentSpan;
  radius: number; // clamped corner radius
  dir: 'left' | 'right';
  surface: string; // mesh name: 1GRASS / 1SAND / 1CONCRETE
  depth: number; // how far in from the road edge to fill (m)
}

// Clean infield fill for the inside of each corner: a concentric ring from the
// inside road edge toward the arc centre (a full pie when the corner is tight).
// This replaces the old clamped/slope-limited apron there, which produced a
// lumpy blob shape on hairpins.
export function buildCornerFill(
  samples: CenterlineSample[],
  width: number,
  fills: CornerFill[],
): MeshData[] {
  const bySurface = new Map<string, MeshData>();
  const get = (name: string): MeshData => {
    let m = bySurface.get(name);
    if (!m) { m = { name, vertices: [], faces: [] }; bySurface.set(name, m); }
    return m;
  };

  for (const fl of fills) {
    const span = fl.span;
    const idx: number[] = [];
    for (let i = 0; i < samples.length; i++) {
      if (samples[i].segIndex === span.segIndex) idx.push(i);
    }
    if (idx.length < 2) continue;

    const rIn = fl.radius - width / 2; // radius of the inside road edge arc
    if (rIn <= 0.2) continue;
    const sign = fl.dir === 'left' ? 1 : -1;
    // Fill from the edge inward by `depth`; if what would remain in the middle
    // is a sliver, fill all the way to the centre (pie) for a clean hairpin.
    const CORE_MIN = 8;
    const toCentre = rIn - Math.max(0, Math.min(fl.depth, rIn)) < CORE_MIN;
    const holdR = toCentre ? 0 : rIn - fl.depth;

    const mesh = get(fl.surface);
    const edge = (i: number): Vec3 => {
      const s = samples[i];
      return fl.dir === 'left' ? leftEdge(s, width) : rightEdge(s, width);
    };
    const centre = (i: number): Vec3 => {
      const s = samples[i];
      const [lx, ly] = perpLeft(s.heading);
      return [s.pos[0] + lx * fl.radius * sign, s.pos[1] + ly * fl.radius * sign, s.pos[2]];
    };
    const ringPt = (i: number, r: number): Vec3 => {
      const c = centre(i);
      const e = edge(i);
      const t = rIn > 0 ? r / rIn : 0;
      return [c[0] + (e[0] - c[0]) * t, c[1] + (e[1] - c[1]) * t, e[2]];
    };

    if (toCentre) {
      // Pie: ring strip from the edge down to a tiny core, then a fan to centre.
      const rims = [rIn, rIn * 0.6, rIn * 0.25];
      for (let k = 0; k < rims.length - 1; k++) {
        for (let n = 0; n < idx.length - 1; n++) {
          const b = mesh.vertices.length;
          mesh.vertices.push(ringPt(idx[n], rims[k]));
          mesh.vertices.push(ringPt(idx[n], rims[k + 1]));
          mesh.vertices.push(ringPt(idx[n + 1], rims[k]));
          mesh.vertices.push(ringPt(idx[n + 1], rims[k + 1]));
          addQuadUp(mesh.vertices, mesh.faces, b, b + 1, b + 3, b + 2);
        }
      }
      // central fan (single centre vertex at the mean height)
      const mid = idx[Math.floor(idx.length / 2)];
      const c = centre(mid);
      let zSum = 0;
      for (const i of idx) zSum += samples[i].pos[2];
      const cv = mesh.vertices.length;
      mesh.vertices.push([c[0], c[1], zSum / idx.length]);
      for (let n = 0; n < idx.length - 1; n++) {
        const b = mesh.vertices.length;
        mesh.vertices.push(ringPt(idx[n], rims[rims.length - 1]));
        mesh.vertices.push(ringPt(idx[n + 1], rims[rims.length - 1]));
        addTriUp(mesh.vertices, mesh.faces, cv, b, b + 1);
      }
    } else {
      // Ring band from the road edge inward by `depth`.
      for (let n = 0; n < idx.length - 1; n++) {
        const b = mesh.vertices.length;
        mesh.vertices.push(edge(idx[n]));
        mesh.vertices.push(ringPt(idx[n], holdR));
        mesh.vertices.push(edge(idx[n + 1]));
        mesh.vertices.push(ringPt(idx[n + 1], holdR));
        addQuadUp(mesh.vertices, mesh.faces, b, b + 1, b + 3, b + 2);
      }
    }
  }
  return [...bySurface.values()].filter((m) => m.faces.length > 0);
}

// Per-sample corner info (null on straights) used for the inside clamp.
export interface CornerAtSample {
  radius: number;
  dir: 'left' | 'right';
}

// Inside-of-corner cap: a runoff offset can't reach the arc centre or it folds
// over the track. Outside of a corner (and on straights) it's unbounded.
export function computeCurvatureCap(
  perSample: (CornerAtSample | null)[],
  width: number,
): SideOffset[] {
  const half = width / 2;
  // Keep the inside strip at least CLEARANCE metres from the arc centre (past
  // it the offset points fold into a spike). Small, so the strip keeps its
  // full width through all but the tightest corners — uniform band, no wedges.
  const CLEARANCE = 1.5;
  return perSample.map((c) => {
    if (!c) return { left: Infinity, right: Infinity };
    const cap = Math.max(0, c.radius - half - CLEARANCE);
    return c.dir === 'left' ? { left: cap, right: Infinity } : { left: Infinity, right: cap };
  });
}

// Cap so two genuinely-different parts of the track (parallel straights, hairpin
// throats) never get overlapping runoff. "Different part" is judged by SEGMENT
// adjacency — a sample is only clipped against samples that are 2+ segments away
// (with wrap on a closed loop). This way a long corner never clips against its
// own arc or its own entry/exit straights, so corners keep their runoff.
export function computeOverlapCap(
  samples: CenterlineSample[],
  width: number,
  segCount: number,
  closed: boolean,
): number[] {
  const n = samples.length;
  const caps = new Array<number>(n).fill(Infinity);
  const segOf = (i: number) => Math.max(0, samples[i].segIndex);
  const adjacent = (a: number, b: number) => {
    let d = Math.abs(a - b);
    if (closed && segCount > 0) d = Math.min(d, segCount - d);
    return d <= 1;
  };
  for (let i = 0; i < n; i++) {
    let minD = Infinity;
    const si = segOf(i);
    for (let j = 0; j < n; j++) {
      if (adjacent(si, segOf(j))) continue;
      const dx = samples[j].pos[0] - samples[i].pos[0];
      const dy = samples[j].pos[1] - samples[i].pos[1];
      const d = Math.hypot(dx, dy);
      if (d < minD) minD = d;
    }
    // Reach at most halfway to the other part (small margin avoids touching it).
    if (minD < Infinity) caps[i] = Math.max(0, (minD - width) / 2 - 0.3);
  }
  return caps;
}

// Reduce an offset profile so it changes no faster than `maxSlope` per metre.
// Reducing-only, so the result always stays within the original caps (never on
// the track), but the offset ramps smoothly in/out of tight spots — no kinks.
export function slopeLimit(offsets: number[], dists: number[], maxSlope: number, closed: boolean): void {
  const n = offsets.length;
  if (n < 2) return;
  const passes = closed ? 3 : 1;
  for (let p = 0; p < passes; p++) {
    for (let i = 1; i < n; i++) {
      const ds = Math.max(0.001, dists[i] - dists[i - 1]);
      offsets[i] = Math.min(offsets[i], offsets[i - 1] + maxSlope * ds);
    }
    for (let i = n - 2; i >= 0; i--) {
      const ds = Math.max(0.001, dists[i + 1] - dists[i]);
      offsets[i] = Math.min(offsets[i], offsets[i + 1] + maxSlope * ds);
    }
    if (closed) {
      // Couple the seam (last <-> first) so a closed loop stays smooth there too.
      offsets[0] = Math.min(offsets[0], offsets[n - 1] + maxSlope * 3);
      offsets[n - 1] = Math.min(offsets[n - 1], offsets[0] + maxSlope * 3);
    }
  }
}

const MAX_OFFSET_SLOPE = 0.4; // m of offset change per m along the track

// Windowed minimum (morphological erosion): widens a dip so it spans at least
// `radius` samples on each side of its narrowest point. Needed before blurring
// — a dip only 1-2 samples wide would otherwise be averaged away entirely by
// the box blur below, silently deleting a real safety constraint (the point
// closest to the arc centre / another track part).
function erodeMin(cap: number[], radius: number, closed: boolean): number[] {
  const n = cap.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let m = cap[i];
    for (let k = 1; k <= radius; k++) {
      const lo = i - k, hi = i + k;
      if (closed) {
        m = Math.min(m, cap[(lo + n) % n], cap[hi % n]);
      } else {
        if (lo >= 0) m = Math.min(m, cap[lo]);
        if (hi < n) m = Math.min(m, cap[hi]);
      }
    }
    out[i] = m;
  }
  return out;
}

// Round off a tight cap dip (e.g. two back-to-back min-radius chicane corners)
// BEFORE it's used as a ceiling. Smoothing the ceiling itself — rather than
// smoothing the output and re-clamping to the original hard ceiling — avoids
// re-introducing a cliff exactly at the dip's boundary (clamping a rounded
// curve back down to a razor-flat plateau just moves the sharp corner to the
// clamp edge instead of removing it). Erosion first guarantees even a
// knife-narrow dip survives the blur at close to its true value; the blur then
// rounds the transition in and out into a curve instead of a straight wedge.
export function smoothCeiling(cap: number[], closed: boolean, passes = 6, erosion = 4): number[] {
  const SENTINEL = 1000; // far beyond any real strip/wall width — stands in for Infinity
  const clipped = cap.map((v) => Math.min(v, SENTINEL));
  const arr = erodeMin(clipped, erosion, closed);
  for (let p = 0; p < passes; p++) {
    const prev = arr.slice();
    for (let i = 0; i < arr.length; i++) {
      const im1 = i > 0 ? i - 1 : closed ? arr.length - 1 : i;
      const ip1 = i < arr.length - 1 ? i + 1 : closed ? 0 : i;
      arr[i] = (prev[im1] + prev[i] * 2 + prev[ip1]) / 4;
    }
  }
  return arr;
}

// A rectangular corridor (escape road) where auto walls must not be built.
export interface WallFreeCorridor {
  origin: [number, number];
  dir: [number, number];
  len: number;
  halfW: number;
}

// Build the runoff aprons (grouped by surface) and the barrier walls (1WALL).
export function buildRunoff(
  samples: CenterlineSample[],
  width: number,
  resolved: ResolvedSample[],
  innerOffsets: SideOffset[],
  curvCap: SideOffset[],
  overlapCap: number[],
  walls: WallConfig,
  closed: boolean,
  wallGaps: WallGap[] = [],
  wallFree: WallFreeCorridor[] = [],
): MeshData[] {
  const surfaces = new Map<string, MeshData>();
  const getSurface = (name: string): MeshData => {
    let m = surfaces.get(name);
    if (!m) { m = { name, vertices: [], faces: [] }; surfaces.set(name, m); }
    return m;
  };
  const wall: MeshData = { name: '1WALL', vertices: [], faces: [], uvs: [] };

  const dists = samples.map((s) => s.dist);
  const inGap = (d: number) => wallGaps.some((g) => d >= Math.min(g.from, g.to) && d <= Math.max(g.from, g.to));
  const inCorridor = (p: Vec3) =>
    wallFree.some((c) => {
      const rx = p[0] - c.origin[0], ry = p[1] - c.origin[1];
      const t = rx * c.dir[0] + ry * c.dir[1];
      if (t < -3 || t > c.len) return false;
      return Math.abs(-c.dir[1] * rx + c.dir[0] * ry) <= c.halfW;
    });
  const innerAt = (i: number, side: 'left' | 'right') => innerOffsets[i][side];

  // Pre-compute the strip outer offset AND the (independent) wall offset per
  // side, then slope-limit both so nothing kinks into tight sections.
  const outer: Record<'left' | 'right', number[]> = { left: [], right: [] };
  const wallOff: Record<'left' | 'right', number[]> = { left: [], right: [] };
  for (const side of ['left', 'right'] as const) {
    const innerArr = samples.map((_, i) => innerAt(i, side));
    const capArr = samples.map((_, i) => Math.min(curvCap[i][side], overlapCap[i]));
    // Round off tight dips (e.g. a chicane) BEFORE they become a hard ceiling —
    // smoothing the ceiling itself, not the output, avoids reintroducing a
    // cliff at the dip's edge (see smoothCeiling's comment).
    const smoothCap = smoothCeiling(capArr, closed);

    const arr = samples.map((_, i) => Math.max(innerArr[i], Math.min(innerArr[i] + resolved[i][side].width, smoothCap[i])));
    slopeLimit(arr, dists, MAX_OFFSET_SLOPE, closed);
    for (let i = 0; i < arr.length; i++) arr[i] = Math.max(arr[i], innerArr[i]);
    outer[side] = arr;

    const warr = samples.map((_, i) => Math.max(innerArr[i], Math.min(innerArr[i] + resolved[i][side].wallDist, smoothCap[i])));
    slopeLimit(warr, dists, MAX_OFFSET_SLOPE, closed);
    for (let i = 0; i < warr.length; i++) warr[i] = Math.max(warr[i], innerArr[i]);
    wallOff[side] = warr;
  }
  const outerAt = (i: number, side: 'left' | 'right') => outer[side][i];
  const edgePt = (i: number, side: 'left' | 'right', off: number): Vec3 => {
    const s = samples[i];
    const [lx, ly] = perpLeft(s.heading);
    const sign = side === 'left' ? 1 : -1;
    const edge = side === 'left' ? leftEdge(s, width) : rightEdge(s, width);
    return [edge[0] + lx * off * sign, edge[1] + ly * off * sign, s.pos[2]];
  };

  for (const side of ['left', 'right'] as const) {
    for (let i = 0; i < samples.length - 1; i++) {
      const inA = outerVsInner(innerAt(i, side), outerAt(i, side));
      const inB = outerVsInner(innerAt(i + 1, side), outerAt(i + 1, side));
      // Strip quad(s) (skip if both ends collapse to zero width). For a
      // 'gravel_spaced' strip there are two bands: a thin grass band at the
      // track edge, then the gravel out to the strip edge.
      if (inA || inB) {
        const r = resolved[i][side];
        const emitBand = (surfName: string, offIn: (k: number) => number, offOut: (k: number) => number) => {
          const oInA = offIn(i), oOutA = offOut(i), oInB = offIn(i + 1), oOutB = offOut(i + 1);
          if (oOutA - oInA <= 0.03 && oOutB - oInB <= 0.03) return;
          const mesh = getSurface(surfName);
          const base = mesh.vertices.length;
          mesh.vertices.push(edgePt(i, side, oInA));
          mesh.vertices.push(edgePt(i, side, oOutA));
          mesh.vertices.push(edgePt(i + 1, side, oInB));
          mesh.vertices.push(edgePt(i + 1, side, oOutB));
          addQuadUp(mesh.vertices, mesh.faces, base, base + 1, base + 3, base + 2);
        };
        if (r.splitAt && r.splitSurface) {
          const split = r.splitAt;
          emitBand(r.splitSurface, (k) => innerAt(k, side), (k) => Math.min(innerAt(k, side) + split, outerAt(k, side)));
          emitBand(r.surface, (k) => Math.min(innerAt(k, side) + split, outerAt(k, side)), (k) => outerAt(k, side));
        } else {
          emitBand(r.surface, (k) => innerAt(k, side), (k) => outerAt(k, side));
        }
      }
      // Wall at its own (independent) distance from the track edge.
      const gapped = inGap(samples[i].dist) || inGap(samples[i + 1].dist);
      if (walls.enabled && !gapped && resolved[i][side].wall && resolved[i + 1][side].wall) {
        const oA = edgePt(i, side, wallOff[side][i]);
        const oB = edgePt(i + 1, side, wallOff[side][i + 1]);
        if (inCorridor(oA) || inCorridor(oB)) continue;
        const [plx, ply] = perpLeft(samples[i].heading);
        const inwardSign = side === 'left' ? -1 : 1; // toward the track
        const inward: Vec3 = [plx * inwardSign, ply * inwardSign, 0];
        const uA = samples[i].dist / 3, uB = samples[i + 1].dist / 3;
        // ALL walls are SOLID boxes now, not thin single-sided planes. A thin
        // one-sided wall lets the car penetrate and then grab it ("100% grip,
        // completely stick, lose control"); a solid box has a clean continuous
        // track-facing face plus a back face, so the car slides along it and
        // can't clip through and get stuck. Thickness varies by barrier type.
        const thick =
          walls.style === 'tecpro' ? 1.0
            : walls.style === 'blocks' ? BLOCK_THICK
              : walls.style === 'hay' ? 0.6
                : walls.style === 'armco' ? 0.3
                  : 0.4; // solid concrete
        emitWallBox(wall, oA, oB, inward, walls.height, thick, uA, uB);
      }
    }
  }

  const out = [...surfaces.values()].filter((m) => m.faces.length > 0);
  if (wall.faces.length > 0) out.push(wall);
  return out;
}

function outerVsInner(inner: number, outer: number): boolean {
  return outer - inner > 0.05;
}

// Build hand-drawn barriers (1WALL) from polylines of world XY points. Each
// point's height is taken from the nearest centerline sample so walls sit on
// the local ground.
export function buildManualWalls(
  walls: ManualWall[],
  samples: CenterlineSample[],
  height: number,
): MeshData {
  const mesh: MeshData = { name: '1WALL', vertices: [], faces: [], uvs: [] };
  const zAt = (x: number, y: number): number => {
    let bz = 0, bd = Infinity;
    for (const s of samples) {
      const dx = x - s.pos[0], dy = y - s.pos[1];
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; bz = s.pos[2]; }
    }
    return bz;
  };
  for (const w of walls) {
    let run = 0;
    for (let i = 0; i < w.points.length - 1; i++) {
      const ax = w.points[i][0], ay = w.points[i][1];
      const bx = w.points[i + 1][0], by = w.points[i + 1][1];
      const oA: Vec3 = [ax, ay, zAt(ax, ay)];
      const oB: Vec3 = [bx, by, zAt(bx, by)];
      const seg = Math.hypot(bx - ax, by - ay);
      // Solid box (thickness perpendicular to the drawn line), so a hand-drawn
      // barrier collides like a real wall — car slides, doesn't clip & stick.
      const dx = (bx - ax) / (seg || 1), dy = (by - ay) / (seg || 1);
      const perp: Vec3 = [-dy, dx, 0];
      emitWallBox(mesh, oA, oB, perp, height, 0.3, run / 3, (run + seg) / 3);
      run += seg;
    }
  }
  return mesh;
}


// Chunky barrier (tyre/poly blocks, TecPro): a contiguous box (thickness +
// top) per segment, so it reads as a row of blocks. Still gapless for collision.
const BLOCK_THICK = 0.7;
function emitWallBox(wall: MeshData, oA: Vec3, oB: Vec3, inward: Vec3, h: number, thick: number, uA: number, uB: number): void {
  const base = wall.vertices.length;
  const t: Vec3 = [inward[0] * thick, inward[1] * thick, 0];
  // bottom: 0=a0 1=a1 2=b0 3=b1 ; top: 4=a0h 5=a1h 6=b0h 7=b1h
  wall.vertices.push([oA[0], oA[1], oA[2]]);
  wall.vertices.push([oA[0] + t[0], oA[1] + t[1], oA[2]]);
  wall.vertices.push([oB[0], oB[1], oB[2]]);
  wall.vertices.push([oB[0] + t[0], oB[1] + t[1], oB[2]]);
  wall.vertices.push([oA[0], oA[1], oA[2] + h]);
  wall.vertices.push([oA[0] + t[0], oA[1] + t[1], oA[2] + h]);
  wall.vertices.push([oB[0], oB[1], oB[2] + h]);
  wall.vertices.push([oB[0] + t[0], oB[1] + t[1], oB[2] + h]);
  wall.uvs!.push([uA, 0], [uA, 0], [uB, 0], [uB, 0], [uA, 1], [uA, 1], [uB, 1], [uB, 1]);
  const out: Vec3 = [-inward[0], -inward[1], 0];
  addQuadToward(wall.vertices, wall.faces, base + 0, base + 4, base + 6, base + 2, out); // track-facing
  addQuadToward(wall.vertices, wall.faces, base + 1, base + 5, base + 7, base + 3, inward); // back
  addQuadUp(wall.vertices, wall.faces, base + 4, base + 5, base + 7, base + 6); // top
}
