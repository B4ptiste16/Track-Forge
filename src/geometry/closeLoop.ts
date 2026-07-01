import type { Segment } from '../types';
import { buildCenterline, computeClosure } from './centerline';
import { CLOSE_GAP_TOL, CLOSE_HEADING_TOL } from './types';

let nid = 0;
function newId(): string {
  return `seg_close_${Date.now().toString(36)}_${nid++}`;
}

function closureCost(segs: Segment[]): number {
  const { samples } = buildCenterline(segs);
  const c = computeClosure(samples);
  const headRad = (c.headingOff * Math.PI) / 180;
  return c.gap * c.gap + Math.pow(headRad * 40, 2); // weight heading ~40 m/rad
}

const round1 = (n: number) => Math.round(n * 10) / 10;

// How "convoluted" an appended tail is — used to prefer the simplest, smoothest
// join (a gentle single corner) over a chicane or a near-360 loop.
function tailPenalty(tail: Segment[]): number {
  const corners = tail.filter((s) => s.kind === 'corner') as Extract<Segment, { kind: 'corner' }>[];
  let p = corners.length * 30; // fewer corners is much better (single > chicane)
  let totalAngle = 0;
  for (const c of corners) totalAngle += c.angle;
  p += totalAngle * 0.4; // less total turning is smoother (avoids 360-ish joins)
  let totalLen = 0;
  for (const s of tail) totalLen += s.kind === 'straight' ? s.length : (s.radius * s.angle * Math.PI) / 180;
  p += totalLen * 0.02;
  for (let i = 1; i < corners.length; i++) if (corners[i].dir !== corners[i - 1].dir) p += 60; // chicane
  return p;
}

interface Cand { full: Segment[]; tail: Segment[] | null; gap: number; head: number; penalty: number }

// Adjust the last `count` existing segments (no new segments) to meet the start.
// This is the clean way to close an almost-closed loop — a small tweak to the
// last straight/corner instead of appending a whole detour.
function adjustLast(segments: Segment[], count: number): Cand | null {
  const n = segments.length;
  const params: { i: number; key: 'length' | 'angle' | 'radius'; lo: number; hi: number; orig: number }[] = [];
  for (let i = Math.max(0, n - count); i < n; i++) {
    const s = segments[i];
    if (s.kind === 'straight') params.push({ i, key: 'length', lo: 1, hi: 6000, orig: s.length });
    else {
      params.push({ i, key: 'angle', lo: 1, hi: 359, orig: s.angle });
      params.push({ i, key: 'radius', lo: 8, hi: 3000, orig: s.radius });
    }
  }
  if (!params.length) return null;
  const apply = (vals: number[]): Segment[] =>
    segments.map((s, idx) => {
      let ns = s;
      params.forEach((p, k) => { if (p.i === idx) ns = { ...ns, [p.key]: vals[k] } as Segment; });
      return ns;
    });
  let vals = params.map((p) => p.orig);
  let best = closureCost(apply(vals));
  let step: number[] = params.map((p) => (p.key === 'angle' ? 12 : p.key === 'radius' ? 20 : 25));
  for (let round = 0; round < 80; round++) {
    let improved = false;
    for (let k = 0; k < params.length; k++) {
      for (const s of [step[k], -step[k]]) {
        const nv = [...vals];
        nv[k] = Math.max(params[k].lo, Math.min(params[k].hi, vals[k] + s));
        const c = closureCost(apply(nv));
        if (c < best - 1e-9) { best = c; vals = nv; improved = true; }
      }
    }
    if (!improved) step = step.map((s) => s * 0.6);
    if (step.every((s) => s < 0.05)) break;
  }
  const full = apply(vals);
  const c = computeClosure(buildCenterline(full).samples);
  let change = 0;
  params.forEach((p, k) => { change += Math.abs(vals[k] - p.orig) * (p.key === 'angle' ? 0.5 : 0.05); });
  return { full, tail: null, gap: c.gap, head: c.headingOff, penalty: change };
}

type Dir = 'left' | 'right';

// A closure structure: appended segments parameterised by a numeric vector,
// with `corners` directional corners (their dirs are searched separately).
interface Structure {
  corners: number;
  build: (x: number[], dirs: Dir[]) => Segment[];
  lo: number[];
  hi: number[];
  seeds: number[][];
}

function dirCombos(n: number): Dir[][] {
  if (n === 0) return [[]];
  const sub = dirCombos(n - 1);
  return sub.flatMap((s) => [['left', ...s] as Dir[], ['right', ...s] as Dir[]]);
}

function descend(
  base: Segment[],
  st: Structure,
  dirs: Dir[],
  x0: number[],
): { x: number[]; cost: number } {
  let x = [...x0];
  let best = closureCost([...base, ...st.build(x, dirs)]);
  let step = x.map((_, i) => Math.max((st.hi[i] - st.lo[i]) * 0.2, 1));

  for (let round = 0; round < 100; round++) {
    let improved = false;
    for (let i = 0; i < x.length; i++) {
      for (const s of [step[i], -step[i]]) {
        const nx = [...x];
        nx[i] = Math.max(st.lo[i], Math.min(st.hi[i], x[i] + s));
        const c = closureCost([...base, ...st.build(nx, dirs)]);
        if (c < best - 1e-9) {
          best = c;
          x = nx;
          improved = true;
        }
      }
    }
    if (!improved) step = step.map((s) => s * 0.5);
    if (step.every((s) => s < 0.03)) break;
  }
  return { x, cost: best };
}

// Best-effort loop closer. Tries several tail structures (one or two corners,
// with/without connecting straights), searches corner directions and a few
// seeds, and keeps the best. Never returns a result worse than the input.
export function closeLoop(segments: Segment[]): Segment[] {
  if (segments.length === 0) return segments;

  const { samples } = buildCenterline(segments);
  const origClosure = computeClosure(samples);
  if (origClosure.closed) return segments;

  const end = samples[samples.length - 1];
  const gap = Math.hypot(end.pos[0], end.pos[1]);
  let turn = (-end.heading * 180) / Math.PI;
  turn = (((turn % 360) + 540) % 360) - 180; // -> (-180, 180]
  const aSeed = Math.min(180, Math.abs(turn));
  const rSeed = Math.max(10, Math.min(300, gap || 40));
  const lSeed = Math.max(1, gap);
  const rBig = Math.max(120, gap * 3); // large radius = a "slightly curved straight"

  const corner = (r: number, a: number, dir: Dir): Segment => ({
    id: 'tmp', kind: 'corner', radius: Math.max(5, r), angle: Math.max(0, a), dir,
  });
  const straight = (l: number): Segment => ({ id: 'tmp', kind: 'straight', length: Math.max(0, l) });

  const structures: Structure[] = [
    // one corner
    { corners: 1, build: (x, d) => [corner(x[1], x[0], d[0])], lo: [0, 5], hi: [180, 3000],
      seeds: [[aSeed, rSeed], [aSeed, rBig], [90, 40], [180, 40]] },
    // corner + straight
    { corners: 1, build: (x, d) => [corner(x[1], x[0], d[0]), straight(x[2])], lo: [0, 5, 0], hi: [180, 3000, 5000],
      seeds: [[aSeed, rSeed, lSeed], [aSeed, rBig, lSeed], [aSeed, rBig, 0], [aSeed, rSeed, 0], [Math.max(5, aSeed), rBig, gap]] },
    // straight + corner
    { corners: 1, build: (x, d) => [straight(x[0]), corner(x[2], x[1], d[0])], lo: [0, 0, 5], hi: [5000, 180, 3000],
      seeds: [[lSeed, aSeed, rSeed], [lSeed, aSeed, rBig], [gap, Math.max(5, aSeed), rBig], [0, aSeed, rSeed]] },
    // corner + straight + corner
    { corners: 2,
      build: (x, d) => [corner(x[1], x[0], d[0]), straight(x[2]), corner(x[4], x[3], d[1])],
      lo: [0, 5, 0, 0, 5], hi: [180, 3000, 5000, 180, 3000],
      seeds: [[90, rSeed, lSeed, 90, rSeed], [180, 40, lSeed, 90, 40], [aSeed, rSeed, gap, 90, rSeed]] },
    // corner + straight + corner + straight (most general)
    { corners: 2,
      build: (x, d) => [corner(x[1], x[0], d[0]), straight(x[2]), corner(x[4], x[3], d[1]), straight(x[5])],
      lo: [0, 5, 0, 0, 5, 0], hi: [180, 3000, 5000, 180, 3000, 5000],
      seeds: [[90, rSeed, lSeed, 90, rSeed, lSeed], [180, 40, gap, 90, 40, gap]] },
  ];

  // Collect candidates, then prefer the SIMPLEST one that actually closes
  // (rather than the absolute-lowest-error one, which is often a chicane or a
  // near-360 loop). Adjusting the existing tail is preferred over appending.
  const cands: Cand[] = [];
  for (const st of structures) {
    for (const dirs of dirCombos(st.corners)) {
      for (const seed of st.seeds) {
        const { x } = descend(segments, st, dirs, seed);
        const tail = st.build(x, dirs);
        const c = computeClosure(buildCenterline([...segments, ...tail]).samples);
        cands.push({ full: [...segments, ...tail], tail, gap: c.gap, head: c.headingOff, penalty: tailPenalty(tail) });
      }
    }
  }
  for (const count of [1, 2, 3]) {
    const adj = adjustLast(segments, count);
    if (adj) cands.push(adj);
  }

  const closable = cands.filter((c) => c.gap < CLOSE_GAP_TOL && c.head < CLOSE_HEADING_TOL);
  let best: Cand | null = null;
  if (closable.length) {
    best = closable.reduce((a, b) => (b.penalty < a.penalty ? b : a)); // simplest that closes
  } else if (cands.length) {
    best = cands.reduce((a, b) => (b.gap + b.head * 2 < a.gap + a.head * 2 ? b : a)); // best effort
  }
  // Don't apply something no better than leaving it open.
  if (!best || (best.gap >= origClosure.gap - 0.5 && best.head >= origClosure.headingOff - 0.5)) {
    return segments;
  }

  if (best.tail) {
    const result: Segment[] = [...segments];
    for (const s of best.tail) {
      if (s.kind === 'straight') {
        if (s.length > 0.5) result.push({ id: newId(), kind: 'straight', length: round1(s.length) });
      } else if (s.angle > 0.5) {
        result.push({ id: newId(), kind: 'corner', radius: round1(s.radius), angle: round1(s.angle), dir: s.dir });
      }
    }
    return result;
  }
  // Adjust result: return the modified existing segments (rounded, ids kept).
  return best.full.map((s) =>
    s.kind === 'corner' ? { ...s, radius: round1(s.radius), angle: round1(s.angle) } : { ...s, length: round1(s.length) },
  );
}
