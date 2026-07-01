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
