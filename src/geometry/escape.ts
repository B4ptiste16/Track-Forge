import type { CornerConfig, EscapeType, Segment } from '../types';
import type { CenterlineSample, SegmentSpan, MeshData, Vec3 } from './types';
import { offsetPoint } from './frames';
import { addQuadUp, addQuadToward } from './meshbuilder';

// Escape roads on the OUTSIDE of a corner. Where a car overshoots, a run-off
// continues straight along the braking line, then curves back to REJOIN the
// track after the exit — a safe route back on, not a shortcut. The path is a
// CUBIC bezier tangent to the entry direction at the split and to the track
// direction at the rejoin, so it always curves back smoothly (the old
// line-intersection version fell back to a straight dead-end whenever the two
// tangents didn't cross cleanly — that's the "just goes straight" bug).
//
// Per-corner escapeType decides how the car is slowed:
//   tarmac  — clean paved run-off, only edge bollards
//   sausage — rows of sausage kerbs ACROSS the lane (speed bumps)
//   slalom  — staggered block gates
//   gravel  — gravel surface over the run-off (drags the car down)

const LIFT = 0.012; // above surrounding aprons so physics picks the escape surface

export interface EscapeCorridor {
  origin: [number, number];
  dir: [number, number];
  len: number;
  halfW: number;
}

export interface EscapeBuild {
  road: MeshData; // merge into 1ROAD (tarmac escapes)
  gravel: MeshData; // merge into 1SAND (gravel escapes)
  kerbHi: MeshData; // merge into 1KERBHI (sausage rows, rumble)
  poly: MeshData; // 1WALLPOLY — physical block rows (WALL keyword = collision)
  bollards: MeshData; // DECOR_BOLLARD — visual
  corridors: EscapeCorridor[]; // keep auto walls out of the escape road
}

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

interface PathPt { x: number; y: number; tx: number; ty: number; half: number; z: number; }

export function escapeTypeOf(cfg: CornerConfig | undefined): EscapeType {
  if (!cfg) return 'none';
  if (cfg.escapeType) return cfg.escapeType;
  return cfg.escape ? 'sausage' : 'none';
}

// The DEFAULT escape control frame for a corner — the 4 cubic-bezier control
// points [split, ctrl1, ctrl2, rejoin] plus the elevations and start width.
// Single source of truth: the geometry and the 2D editor both use this so a
// custom shape starts exactly where the default was. Returns null if the
// corner geometry can't host an escape (too near the lap end, etc.).
export interface EscapeFrame {
  points: [[number, number], [number, number], [number, number], [number, number]];
  zStart: number;
  zEnd: number;
  startHalf: number;
}

export function escapeControlPoints(
  samples: CenterlineSample[],
  span: SegmentSpan,
  seg: { kind: 'corner'; radius: number; dir: 'left' | 'right' } | { kind: string },
  width: number,
): EscapeFrame | null {
  if (seg.kind !== 'corner' || samples.length < 2) return null;
  const radius = (seg as { radius: number }).radius;
  const dir = (seg as { dir: 'left' | 'right' }).dir;

  let e = 0;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].segIndex === span.segIndex) { e = i; break; }
  }
  const s0 = samples[e];
  const d0: [number, number] = [Math.cos(s0.heading), Math.sin(s0.heading)];
  const kSign = dir === 'left' ? 1 : -1;

  const START_HALF = width / 2;
  const p0 = offsetPoint(s0, -kSign * (START_HALF - 0.3));

  const total = samples[samples.length - 1].dist;
  const rDist = Math.min(total - 1, span.endDist + Math.max(35, radius * 0.6));
  let r = samples.length - 1;
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].dist >= rDist) { r = i; break; }
  }
  const sR = samples[r];
  const d1: [number, number] = [Math.cos(sR.heading), Math.sin(sR.heading)];
  const END_HALF = 2.6;
  const p3 = offsetPoint(sR, -kSign * (width / 2 + END_HALF - 0.6));

  const chord = Math.hypot(p3[0] - p0[0], p3[1] - p0[1]);
  const arm = Math.max(18, Math.min(120, chord * 0.42));
  const p1: [number, number] = [p0[0] + d0[0] * arm, p0[1] + d0[1] * arm];
  const p2: [number, number] = [p3[0] - d1[0] * arm, p3[1] - d1[1] * arm];

  return { points: [[p0[0], p0[1]], p1, p2, [p3[0], p3[1]]], zStart: s0.pos[2], zEnd: sR.pos[2], startHalf: START_HALF };
}

export function buildEscapes(
  samples: CenterlineSample[],
  spans: SegmentSpan[],
  segs: Segment[],
  corners: CornerConfig[],
  width: number,
): EscapeBuild {
  const road: MeshData = { name: '1ROAD', vertices: [], faces: [] };
  const gravel: MeshData = { name: '1SAND', vertices: [], faces: [] };
  const kerbHi: MeshData = { name: '1KERBHI', vertices: [], faces: [] };
  const poly: MeshData = { name: '1WALLPOLY', vertices: [], faces: [] };
  const bollards: MeshData = { name: 'DECOR_BOLLARD', vertices: [], faces: [] };
  const corridors: EscapeCorridor[] = [];

  for (const span of spans) {
    if (span.kind !== 'corner') continue;
    const seg = segs[span.segIndex];
    if (seg.kind !== 'corner') continue;
    const cfg = corners.find((c) => c.cornerIndex === span.cornerIndex);
    const type = escapeTypeOf(cfg);
    if (type === 'none') continue;

    const frame = escapeControlPoints(samples, span, seg, width);
    if (!frame) continue;
    const kSign = seg.dir === 'left' ? 1 : -1;
    // Custom shape overrides the default control points (the editor drags these).
    const cp = (cfg?.escapeNodes && cfg.escapeNodes.length === 4 ? cfg.escapeNodes : frame.points) as
      [[number, number], [number, number], [number, number], [number, number]];
    const [p0, p1, p2, p3] = cp;
    const END_HALF = 2.6;

    const M = 44;
    const path: PathPt[] = [];
    for (let k = 0; k <= M; k++) {
      const u = k / M;
      const mu = 1 - u;
      const b0 = mu * mu * mu, b1 = 3 * mu * mu * u, b2 = 3 * mu * u * u, b3 = u * u * u;
      const x = b0 * p0[0] + b1 * p1[0] + b2 * p2[0] + b3 * p3[0];
      const y = b0 * p0[1] + b1 * p1[1] + b2 * p2[1] + b3 * p3[1];
      let dx = 3 * mu * mu * (p1[0] - p0[0]) + 6 * mu * u * (p2[0] - p1[0]) + 3 * u * u * (p3[0] - p2[0]);
      let dy = 3 * mu * mu * (p1[1] - p0[1]) + 6 * mu * u * (p2[1] - p1[1]) + 3 * u * u * (p3[1] - p2[1]);
      const dl = Math.hypot(dx, dy) || 1;
      dx /= dl; dy /= dl;
      const half = u < 0.3 ? frame.startHalf + (5 - frame.startHalf) * (u / 0.3) : 5 + (END_HALF - 5) * ((u - 0.3) / 0.7);
      const z = frame.zStart + (frame.zEnd - frame.zStart) * u + LIFT;
      path.push({ x, y, tx: dx, ty: dy, half, z });
    }

    emitEscape(type, { road, gravel, kerbHi, poly, bollards, corridors }, path, kSign);
  }

  return { road, gravel, kerbHi, poly, bollards, corridors };
}

function emitEscape(
  type: EscapeType,
  out: Omit<EscapeBuild, never>,
  path: PathPt[],
  kSign: number,
): void {
  const { road, gravel, kerbHi, poly, bollards, corridors } = out;
  const M = path.length - 1;
  const at = (p: PathPt, off: number): Vec3 => [p.x - p.ty * off, p.y + p.tx * off, p.z];
  // perp of tangent (tx,ty) is (-ty,tx) = "left of travel"; off>0 = left.

  // paved (or gravel) run-off surface
  const surf = type === 'gravel' ? gravel : road;
  for (let k = 0; k < M; k++) {
    const a = path[k], b = path[k + 1];
    const vb = surf.vertices.length;
    surf.vertices.push(at(a, a.half), at(a, -a.half), at(b, b.half), at(b, -b.half));
    addQuadUp(surf.vertices, surf.faces, vb, vb + 1, vb + 3, vb + 2);
  }

  if (type === 'sausage') {
    // Rows of sausage kerbs ACROSS the whole lane (speed bumps), spaced along
    // the middle stretch — the car bumps over them slowing down, then has
    // clear tarmac to reaccelerate before the rejoin.
    const K_H = 0.09;
    for (let k = Math.round(M * 0.25); k <= Math.round(M * 0.7); k += 4) {
      const p = path[k], pn = path[Math.min(M, k + 1)];
      const half = p.half - 0.4;
      const COLS = Math.max(6, Math.round((half * 2) / 1.2));
      const vb = kerbHi.vertices.length;
      for (const row of [p, pn]) {
        for (let c = 0; c <= COLS; c++) {
          const off = -half + (2 * half) * (c / COLS);
          const pos = at(row, off);
          // bump profile ACROSS the row so it reads as a rounded rumble strip
          const bump = Math.sin(Math.PI * ((c % 3) / 3 + 0.15)) * K_H;
          kerbHi.vertices.push([pos[0], pos[1], row.z - LIFT + 0.01 + bump]);
        }
      }
      for (let c = 0; c < COLS; c++) {
        const a0 = vb + c, a1 = vb + c + 1, b0 = vb + COLS + 1 + c, b1 = vb + COLS + 1 + c + 1;
        addQuadUp(kerbHi.vertices, kerbHi.faces, a0, a1, b1, b0);
      }
    }
  } else if (type === 'slalom') {
    // Staggered block gates: alternate which half is blocked so the car must
    // weave, scrubbing speed.
    let side = 1;
    for (let k = Math.round(M * 0.28); k <= Math.round(M * 0.72); k += Math.round(M * 0.12)) {
      const p = path[k];
      const gapEdge = 0.5;
      const blockHalf = (p.half - gapEdge) / 2;
      if (blockHalf < 0.6) continue;
      const centerOff = side * (gapEdge + blockHalf);
      const c = at(p, centerOff);
      const perp: [number, number] = [-p.ty, p.tx];
      emitBox(poly, c[0], c[1], p.z, [perp[0] * blockHalf, perp[1] * blockHalf], [p.tx * 0.4, p.ty * 0.4], 0.9);
      side = -side;
    }
  }
  // 'tarmac' and 'gravel' get no in-lane furniture — just the surface + edges.

  // edge bollards along both sides (all types)
  for (let k = Math.round(M * 0.08); k <= Math.round(M * 0.92); k += 3) {
    const p = path[k];
    for (const sgn of [1, -1]) {
      const c = at(p, (p.half + 0.7) * sgn);
      emitBox(bollards, c[0], c[1], p.z - LIFT, [p.tx * 0.09, p.ty * 0.09], [-p.ty * 0.09, p.tx * 0.09], 1.0);
    }
  }

  // wall-free corridors so the auto barrier doesn't wall across the run-off
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
  void kSign;
}
