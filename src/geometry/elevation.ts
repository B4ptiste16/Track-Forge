import type { ElevationPoint } from '../types';
import type { CenterlineSample } from './types';

// Build a height(dist) sampler from elevation points using a Catmull-Rom
// spline (clamped at the ends). Empty input => flat (height 0 everywhere).
export function makeHeightFn(points: ElevationPoint[]): (dist: number) => number {
  if (points.length === 0) return () => 0;

  const pts = [...points].sort((a, b) => a.dist - b.dist);
  if (pts.length === 1) {
    const h = pts[0].height;
    return () => h;
  }

  return (dist: number): number => {
    // Clamp outside the defined range.
    if (dist <= pts[0].dist) return pts[0].height;
    if (dist >= pts[pts.length - 1].dist) return pts[pts.length - 1].height;

    // Find the segment [i, i+1] containing dist.
    let i = 0;
    while (i < pts.length - 1 && pts[i + 1].dist < dist) i++;

    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p0 = pts[i - 1] ?? p1;
    const p3 = pts[i + 2] ?? p2;

    const span = p2.dist - p1.dist;
    if (span <= 0) return p1.height;
    const t = (dist - p1.dist) / span;

    // Catmull-Rom basis on the heights, parameter t in [0,1].
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      0.5 *
      (2 * p1.height +
        (-p0.height + p2.height) * t +
        (2 * p0.height - 5 * p1.height + 4 * p2.height - p3.height) * t2 +
        (-p0.height + 3 * p1.height - 3 * p2.height + p3.height) * t3)
    );
  };
}

// Apply heights in-place to centerline samples (sets the Z coordinate).
export function applyElevation(samples: CenterlineSample[], points: ElevationPoint[]): void {
  const h = makeHeightFn(points);
  for (const s of samples) {
    s.pos[2] = h(s.dist);
  }
}

/**
 * Smooth a sampled height profile.
 *
 * Elevation points are sparse — a handful of heights along a 5 km lap — and the
 * spline through them can arrive at each one steeply, so a profile that reads
 * as gentle in the list drives like a series of ramps. This flattens the
 * transitions without moving the points themselves: heights still pass close to
 * what was asked for, they just get there gradually.
 *
 * `amount` 0 = untouched, 1 = heavily smoothed (a ~400 m rolling window).
 * Two box passes approximate a Gaussian, which is what keeps the result free of
 * the corners a single pass leaves behind.
 * `closed` wraps the window across the start/finish line so a lap has no step
 * where it joins back up.
 */
export function smoothHeights(
  heights: number[], totalLength: number, amount: number, closed: boolean,
): number[] {
  const n = heights.length;
  if (n < 3 || amount <= 0) return heights;
  const windowM = 20 + Math.min(1, amount) * 380; // 20 m .. 400 m
  const spacing = Math.max(0.5, totalLength / n);
  const half = Math.max(1, Math.round(windowM / 2 / spacing));
  let cur = heights;
  for (let pass = 0; pass < 2; pass++) {
    const out = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      let sum = 0, cnt = 0;
      for (let k = -half; k <= half; k++) {
        let j = i + k;
        if (closed) j = ((j % n) + n) % n;
        else if (j < 0 || j >= n) continue;
        sum += cur[j]; cnt++;
      }
      out[i] = sum / cnt;
    }
    cur = out;
  }
  return cur;
}

/** Steepest gradient in the profile, as a percentage — what "too steep" means
 *  objectively. Real circuits sit around 3-10%; Eau Rouge is about 17%. */
export function maxGradientPct(heights: number[], totalLength: number): number {
  const n = heights.length;
  if (n < 2) return 0;
  const spacing = Math.max(0.5, totalLength / n);
  let worst = 0;
  for (let i = 1; i < n; i++) {
    worst = Math.max(worst, Math.abs(heights[i] - heights[i - 1]) / spacing);
  }
  return worst * 100;
}
