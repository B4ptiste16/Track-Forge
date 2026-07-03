import type { CornerConfig, Segment } from '../types';
import type { CenterlineSample, SegmentSpan, MeshData, Vec3 } from './types';
import { addQuadUp, addQuadToward } from './meshbuilder';

// Monza-T1-style escape roads: where a corner has `escape` ticked, a straight
// tarmac road continues along the braking line, separated from the corner by a
// sausage-kerb strip, guided by orange bollards, and closed off by rows of
// yellow polystyrene blocks at the far end. The car brakes straight on, stops
// at the blocks, turns round and rejoins.

const LEN = 80; // escape road length (m)
const LIFT = 0.012; // above surrounding aprons so physics picks the tarmac

export interface EscapeCorridor {
  origin: [number, number];
  dir: [number, number]; // unit, direction of travel at corner entry
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

    // frame at corner entry
    let e = 0;
    for (let i = 0; i < samples.length; i++) {
      if (samples[i].segIndex === span.segIndex) { e = i; break; }
    }
    const s0 = samples[e];
    const dir: [number, number] = [Math.cos(s0.heading), Math.sin(s0.heading)];
    const perp: [number, number] = [-dir[1], dir[0]];
    const ox = s0.pos[0], oy = s0.pos[1], z = s0.pos[2] + LIFT;
    const at = (t: number, off: number): Vec3 => [
      ox + dir[0] * t + perp[0] * off,
      oy + dir[1] * t + perp[1] * off,
      z,
    ];

    // --- tarmac strip, slight taper toward the end -------------------------
    const STEP = 4;
    const halfAt = (t: number) => (width / 2) * (1 - 0.25 * (t / LEN));
    for (let t = 0; t < LEN; t += STEP) {
      const t2 = Math.min(LEN, t + STEP);
      const b = road.vertices.length;
      road.vertices.push(at(t, halfAt(t)), at(t, -halfAt(t)), at(t2, halfAt(t2)), at(t2, -halfAt(t2)));
      addQuadUp(road.vertices, road.faces, b, b + 1, b + 3, b + 2);
    }

    // --- sausage kerb separating escape road from the corner ---------------
    // the track bends toward seg.dir, so the corner side of the escape road is
    // that same side (left corner => kerb on the left edge).
    const kSign = seg.dir === 'left' ? 1 : -1;
    const K_W = 0.9, K_H = 0.075, COLS = 6;
    for (let t = 6; t < 52; t += 2) {
      const t2 = t + 2;
      const b = kerbHi.vertices.length;
      for (const tt of [t, t2]) {
        const edge = halfAt(tt) * kSign;
        for (let c = 0; c <= COLS; c++) {
          const f = c / COLS;
          const p = at(tt, edge + f * K_W * kSign);
          kerbHi.vertices.push([p[0], p[1], z + 0.005 + Math.sin(Math.PI * f) * K_H]);
        }
      }
      for (let c = 0; c < COLS; c++) {
        const a0 = b + c, a1 = b + c + 1, b0 = b + COLS + 1 + c, b1 = b + COLS + 1 + c + 1;
        addQuadUp(kerbHi.vertices, kerbHi.faces, a0, a1, b1, b0);
      }
    }

    // --- yellow polystyrene block rows near the end -------------------------
    for (const t of [LEN - 9, LEN - 2]) {
      const half = halfAt(t) - 0.4;
      const n = Math.max(2, Math.floor((half * 2) / 2.8));
      for (let k = 0; k < n; k++) {
        const off = -half + 1.1 + k * ((half * 2 - 2.2) / Math.max(1, n - 1));
        const p = at(t, off);
        // long side across the escape road
        emitBox(poly, p[0], p[1], z, [perp[0] * 1.1, perp[1] * 1.1], [dir[0] * 0.4, dir[1] * 0.4], 0.9);
      }
    }

    // --- orange bollards along both edges -----------------------------------
    for (let t = 8; t <= 56; t += 6) {
      for (const sgn of [1, -1]) {
        const p = at(t, (halfAt(t) + 0.7) * sgn);
        emitBox(bollards, p[0], p[1], z - LIFT, [dir[0] * 0.09, dir[1] * 0.09], [perp[0] * 0.09, perp[1] * 0.09], 1.0);
      }
    }

    corridors.push({ origin: [ox, oy], dir, len: LEN + 3, halfW: width / 2 + 1.8 });
  }

  return { road, kerbHi, poly, bollards, corridors };
}
