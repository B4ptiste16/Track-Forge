import type { CornerConfig, Segment } from '../types';
import type { CenterlineSample, SegmentSpan, MeshData, Vec3 } from './types';
import { offsetPoint } from './frames';
import { addQuadUp, addQuadToward } from './meshbuilder';

// Monza-T1-style escape roads: where a corner has `escape` ticked, a tarmac
// bypass continues along the braking line, bends round behind the corner and
// REJOINS the track shortly after the exit — so it's a safe way back on, not a
// shortcut: a staggered slalom of yellow polystyrene blocks mid-bypass forces
// you to slow right down, a sausage-kerb strip separates it from the corner,
// and orange bollards line the edges. Hairpins (no clean rejoin geometry)
// fall back to a straight dead-end closed by block rows.

const LIFT = 0.012; // above surrounding aprons so physics picks the tarmac

export interface EscapeCorridor {
  origin: [number, number];
  dir: [number, number];
  len: number;
  halfW: number;
}

export interface EscapeBuild {
  road: MeshData; // merge into 1ROAD
  kerbHi: MeshData; // merge into 1KERBHI (sausage separator, rumbles)
  poly: MeshData; // 1WALLPOLY — physical block rows (WALL keyword = collision)
  bollards: MeshData; // DECOR_BOLLARD — visual
  corridors: EscapeCorridor[]; // keep auto walls out of the escape road
}

// Small oriented box (4 sides + top): centre (cx,cy), half-extent vectors
// A and B in the ground plane, height h from z0.
function emitBox(m: MeshData, cx: number, cy: number, z0: number, A: [number, number], B: [number, number], h: number): void {
  const c: [number, number][] = [
    [cx - A[0] - B[0], cy - A[1] - B[1]],
    [cx + A[0] - B[0], cy + A[1] - B[1]],
    [cx + A[0] + B[0], cy + A[1] + B[1]],
    [cx - A[0] + B[0], cy - A[1] + B[1]],
  ];
  for (let i = 0; i < 4; i++) {
    const a = c[i], b = c[(i + 1) % 4];
    const out: Vec3 = [(a[0] + b[0]) / 2 - cx, (a[1] + b[1]) / 2 - cy, 0];
    const base = m.vertices.length;
    m.vertices.push([a[0], a[1], z0], [a[0], a[1], z0 + h], [b[0], b[1], z0], [b[0], b[1], z0 + h]);
    addQuadToward(m.vertices, m.faces, base, base + 1, base + 3, base + 2, out);
  }
  const base = m.vertices.length;
  for (const [x, y] of c) m.vertices.push([x, y, z0 + h]);
  addQuadUp(m.vertices, m.faces, base, base + 1, base + 2, base + 3);
}

// A path point of the bypass: position, unit tangent, half-width, height.
interface PathPt {
  x: number;
  y: number;
  tx: number;
  ty: number;
  half: number;
  z: number;
}

export function buildEscapes(
  samples: CenterlineSample[],
  spans: SegmentSpan[],
  segs: Segment[],
  corners: CornerConfig[],
  width: number,
): EscapeBuild {
  const road: MeshData = { name: '1ROAD', vertices: [], faces: [] };
  const kerbHi: MeshData = { name: '1KERBHI', vertices: [], faces: [] };
  const poly: MeshData = { name: '1WALLPOLY', vertices: [], faces: [] };
  const bollards: MeshData = { name: 'DECOR_BOLLARD', vertices: [], faces: [] };
  const corridors: EscapeCorridor[] = [];

  for (const span of spans) {
    if (span.kind !== 'corner') continue;
    const seg = segs[span.segIndex];
    if (seg.kind !== 'corner') continue;
    const cfg = corners.find((c) => c.cornerIndex === span.cornerIndex);
    if (!cfg?.escape) continue;

    // entry frame
    let e = 0;
    for (let i = 0; i < samples.length; i++) {
      if (samples[i].segIndex === span.segIndex) { e = i; break; }
    }
    const s0 = samples[e];
    const d0: [number, number] = [Math.cos(s0.heading), Math.sin(s0.heading)];
    const kSign = seg.dir === 'left' ? 1 : -1; // which side the track curves off to

    // rejoin frame: a bit after the corner exit, at the outside edge
    const total = samples[samples.length - 1].dist;
    const rDist = Math.min(total - 1, span.endDist + 45);
    let r = samples.length - 1;
    for (let i = 0; i < samples.length; i++) {
      if (samples[i].dist >= rDist) { r = i; break; }
    }
    const sR = samples[r];
    const d1: [number, number] = [Math.cos(sR.heading), Math.sin(sR.heading)];
    const END_HALF = 2.5;
    const rj = offsetPoint(sR, -kSign * (width / 2 + END_HALF - 0.5)); // outside edge, slight overlap

    // control point = intersection of entry line and (reversed) rejoin line
    const det = d0[0] * -d1[1] - d0[1] * -d1[0];
    let path: PathPt[] | null = null;
    if (Math.abs(det) > 0.05) {
      const rx = rj[0] - s0.pos[0], ry = rj[1] - s0.pos[1];
      const t = (rx * -d1[1] - ry * -d1[0]) / det; // along d0 from entry
      const s = (d0[0] * ry - d0[1] * rx) / det; // along d1 back from rejoin
      if (t > 15 && t < 260 && s > 15 && s < 260) {
        const cx = s0.pos[0] + d0[0] * t;
        const cy = s0.pos[1] + d0[1] * t;
        const M = 40;
        path = [];
        for (let k = 0; k <= M; k++) {
          const u = k / M;
          const a = (1 - u) * (1 - u), b = 2 * u * (1 - u), c2 = u * u;
          const x = a * s0.pos[0] + b * cx + c2 * rj[0];
          const y = a * s0.pos[1] + b * cy + c2 * rj[1];
          // derivative
          let dx = 2 * (1 - u) * (cx - s0.pos[0]) + 2 * u * (rj[0] - cx);
          let dy = 2 * (1 - u) * (cy - s0.pos[1]) + 2 * u * (rj[1] - cy);
          const dl = Math.hypot(dx, dy) || 1;
          dx /= dl; dy /= dl;
          // width: full road at the split, narrow service road, small at rejoin
          const half = u < 0.25 ? width / 2 + (4 - width / 2) * (u / 0.25) : 4 + (END_HALF - 4) * ((u - 0.25) / 0.75);
          const z = s0.pos[2] + (sR.pos[2] - s0.pos[2]) * u + LIFT;
          path.push({ x, y, tx: dx, ty: dy, half, z });
        }
      }
    }

    if (path) {
      emitBypass(road, kerbHi, poly, bollards, corridors, path, kSign);
    } else {
      // hairpin/no clean rejoin: straight dead-end closed by block rows
      emitDeadEnd(road, kerbHi, poly, bollards, corridors, s0.pos, d0, width, kSign);
    }
  }

  return { road, kerbHi, poly, bollards, corridors };
}

function emitBypass(
  road: MeshData,
  kerbHi: MeshData,
  poly: MeshData,
  bollards: MeshData,
  corridors: EscapeCorridor[],
  path: PathPt[],
  kSign: number,
): void {
  const M = path.length - 1;
  const at = (p: PathPt, off: number): Vec3 => [p.x - p.ty * off, p.y + p.tx * off, p.z];
  // NOTE: perp of tangent (tx,ty) is (-ty,tx) = "left of travel"; off>0 = left.

  // tarmac strip
  for (let k = 0; k < M; k++) {
    const a = path[k], b = path[k + 1];
    const vb = road.vertices.length;
    road.vertices.push(at(a, a.half), at(a, -a.half), at(b, b.half), at(b, -b.half));
    addQuadUp(road.vertices, road.faces, vb, vb + 1, vb + 3, vb + 2);
  }

  // sausage kerb along the corner side over the first half (the separator)
  const K_W = 0.9, K_H = 0.075, COLS = 6;
  const k0 = Math.round(M * 0.06), k1 = Math.round(M * 0.5);
  for (let k = k0; k < k1; k++) {
    const rows = [path[k], path[k + 1]];
    const vb = kerbHi.vertices.length;
    for (const p of rows) {
      for (let c = 0; c <= COLS; c++) {
        const f = c / COLS;
        const pos = at(p, (p.half + f * K_W) * kSign);
        kerbHi.vertices.push([pos[0], pos[1], p.z - LIFT + 0.01 + Math.sin(Math.PI * f) * K_H]);
      }
    }
    for (let c = 0; c < COLS; c++) {
      const a0 = vb + c, a1 = vb + c + 1, b0 = vb + COLS + 1 + c, b1 = vb + COLS + 1 + c + 1;
      addQuadUp(kerbHi.vertices, kerbHi.faces, a0, a1, b1, b0);
    }
  }

  // staggered slalom: block the outer half, then the inner half — kills speed
  for (const [u, sideSign] of [[0.42, -kSign], [0.58, kSign]] as [number, number][]) {
    const p = path[Math.round(M * u)];
    const gapEdge = 0.4; // leave the other half open
    const blockHalf = (p.half - gapEdge) / 2;
    const centerOff = sideSign * (gapEdge + blockHalf);
    const c = at(p, centerOff);
    const perp: [number, number] = [-p.ty, p.tx];
    emitBox(poly, c[0], c[1], p.z, [perp[0] * blockHalf, perp[1] * blockHalf], [p.tx * 0.4, p.ty * 0.4], 0.9);
  }

  // bollards along both edges
  for (let k = Math.round(M * 0.08); k <= Math.round(M * 0.92); k += 3) {
    const p = path[k];
    for (const sgn of [1, -1]) {
      const c = at(p, (p.half + 0.7) * sgn);
      emitBox(bollards, c[0], c[1], p.z - LIFT, [p.tx * 0.09, p.ty * 0.09], [-p.ty * 0.09, p.tx * 0.09], 1.0);
    }
  }

  // wall-free corridors along the path
  for (let k = 0; k < M; k += 4) {
    const a = path[k], b = path[Math.min(M, k + 4)];
    const dl = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    corridors.push({
      origin: [a.x, a.y],
      dir: [(b.x - a.x) / dl, (b.y - a.y) / dl],
      len: dl + 2,
      halfW: Math.max(a.half, b.half) + 1.8,
    });
  }
}

function emitDeadEnd(
  road: MeshData,
  kerbHi: MeshData,
  poly: MeshData,
  bollards: MeshData,
  corridors: EscapeCorridor[],
  origin: Vec3,
  dir: [number, number],
  width: number,
  kSign: number,
): void {
  const LEN = 60;
  const perp: [number, number] = [-dir[1], dir[0]];
  const z = origin[2] + LIFT;
  const at = (t: number, off: number): Vec3 => [
    origin[0] + dir[0] * t + perp[0] * off,
    origin[1] + dir[1] * t + perp[1] * off,
    z,
  ];
  const halfAt = (t: number) => (width / 2) * (1 - 0.3 * (t / LEN));
  for (let t = 0; t < LEN; t += 4) {
    const t2 = Math.min(LEN, t + 4);
    const b = road.vertices.length;
    road.vertices.push(at(t, halfAt(t)), at(t, -halfAt(t)), at(t2, halfAt(t2)), at(t2, -halfAt(t2)));
    addQuadUp(road.vertices, road.faces, b, b + 1, b + 3, b + 2);
  }
  const K_W = 0.9, K_H = 0.075, COLS = 6;
  for (let t = 6; t < 40; t += 2) {
    const b = kerbHi.vertices.length;
    for (const tt of [t, t + 2]) {
      for (let c = 0; c <= COLS; c++) {
        const f = c / COLS;
        const p = at(tt, (halfAt(tt) + f * K_W) * kSign);
        kerbHi.vertices.push([p[0], p[1], z - LIFT + 0.01 + Math.sin(Math.PI * f) * K_H]);
      }
    }
    for (let c = 0; c < COLS; c++) {
      const a0 = b + c, a1 = b + c + 1, b0 = b + COLS + 1 + c, b1 = b + COLS + 1 + c + 1;
      addQuadUp(kerbHi.vertices, kerbHi.faces, a0, a1, b1, b0);
    }
  }
  for (const t of [LEN - 8, LEN - 2]) {
    const half = halfAt(t) - 0.4;
    const n = Math.max(2, Math.floor((half * 2) / 2.8));
    for (let k = 0; k < n; k++) {
      const off = -half + 1.1 + k * ((half * 2 - 2.2) / Math.max(1, n - 1));
      const p = at(t, off);
      emitBox(poly, p[0], p[1], z, [perp[0] * 1.1, perp[1] * 1.1], [dir[0] * 0.4, dir[1] * 0.4], 0.9);
    }
  }
  for (let t = 8; t <= 44; t += 6) {
    for (const sgn of [1, -1]) {
      const p = at(t, (halfAt(t) + 0.7) * sgn);
      emitBox(bollards, p[0], p[1], z - LIFT, [dir[0] * 0.09, dir[1] * 0.09], [perp[0] * 0.09, perp[1] * 0.09], 1.0);
    }
  }
  corridors.push({ origin: [origin[0], origin[1]], dir, len: LEN + 3, halfW: width / 2 + 1.8 });
}
