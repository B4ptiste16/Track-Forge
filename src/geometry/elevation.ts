import type { ElevationPoint } from '../types';
import type { CenterlineSample } from './types';

/**
 * height(dist) through the elevation points.
 *
 * A MONOTONE CUBIC in true distance (Fritsch-Carlson). It used to be a
 * Catmull-Rom spline parameterised per segment, which ignores how far apart the
 * points are: where a short gap met a long one, the slope arriving at a point
 * differed from the slope leaving it - a kink at every elevation point, worst
 * where the gaps are most uneven. This one is slope-continuous everywhere, and
 * monotone between points, so it never invents a hump or dip the user did not
 * ask for.
 *
 * `closed`: the profile wraps across start/finish (the last point leads into
 * the first), instead of clamping flat at both ends - which left a kink at the
 * first and last points and a step where the lap joins up. Open tracks keep
 * flat ends, now with zero slope at them so the clamp joins smoothly.
 */
export function makeHeightFn(
  points: ElevationPoint[],
  totalLength = 0,
  closed = false,
): (dist: number) => number {
  if (points.length === 0) return () => 0;
  const wrap = closed && totalLength > 0;
  const norm = (d: number) => (wrap ? ((d % totalLength) + totalLength) % totalLength : d);

  // sort, and keep one height per distance
  const byDist = new Map<number, number>();
  for (const p of points) byDist.set(norm(p.dist), p.height);
  const pts = [...byDist].sort((a, b) => a[0] - b[0]);
  if (pts.length === 1) {
    const h = pts[0][1];
    return () => h;
  }

  // Closed: two wrapped points each side, so the first and last real points get
  // proper two-sided tangents and the curve is identical on both sides of S/F.
  const xs: number[] = [], ys: number[] = [];
  if (wrap) {
    const n = pts.length;
    for (const k of [n - 2, n - 1]) if (k >= 0) { xs.push(pts[k][0] - totalLength); ys.push(pts[k][1]); }
  }
  for (const [x, y] of pts) { xs.push(x); ys.push(y); }
  if (wrap) {
    for (const k of [0, 1]) if (k < pts.length) { xs.push(pts[k][0] + totalLength); ys.push(pts[k][1]); }
  }

  const n = xs.length;
  const h = xs.slice(1).map((x, i) => x - xs[i]);
  const delta = h.map((hi, i) => (ys[i + 1] - ys[i]) / hi);
  const m = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const d0 = delta[i - 1], d1 = delta[i];
    if (d0 * d1 <= 0) { m[i] = 0; continue; }          // a crest or dip: level there
    const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
    m[i] = (w1 + w2) / (w1 / d0 + w2 / d1);             // weighted harmonic mean
  }
  // Open ends meet the flat clamp at zero slope. Closed ends are only the
  // wrapped helpers, whose outer segments are never evaluated.
  m[0] = 0;
  m[n - 1] = 0;

  return (dist: number): number => {
    const d = norm(dist);
    if (d <= xs[0]) return ys[0];
    if (d >= xs[n - 1]) return ys[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (xs[mid] <= d) lo = mid; else hi = mid; }
    const span = xs[lo + 1] - xs[lo];
    const t = (d - xs[lo]) / span, t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[lo] + (t3 - 2 * t2 + t) * span * m[lo]
      + (-2 * t3 + 3 * t2) * ys[lo + 1] + (t3 - t2) * span * m[lo + 1];
  };
}

// Apply heights in-place to centerline samples (sets the Z coordinate).
export function applyElevation(samples: CenterlineSample[], points: ElevationPoint[]): void {
  const total = samples.length ? samples[samples.length - 1].dist : 0;
  const h = makeHeightFn(points, total, false);
  for (const s of samples) s.pos[2] = h(s.dist);
}

const GRID = 1; // m

/**
 * The height profile at each sample distance, smoothed.
 *
 * Smoothing runs on a UNIFORM 1 m grid and is then read back at the samples.
 * It used to average over a fixed NUMBER OF SAMPLES, sized from the average
 * spacing - but the centreline is not evenly sampled, and where samples bunch
 * up the window covered fewer metres on one side than the other. That dragged
 * the profile up before a dense stretch and down after it: on trois_vallees a
 * steady -3% became -13.5% for 50 m with a 24 m-radius kink at each end. The
 * smoothing was MAKING the sharp changes of slope. On an even grid it cannot.
 *
 * `amount` 0 = untouched, 1 = heavily smoothed (a ~400 m rolling window). Two
 * box passes approximate a Gaussian. `closed` wraps the window across S/F.
 */
export function smoothProfile(
  dists: number[],
  totalLength: number,
  heightAt: (d: number) => number,
  amount: number,
  closed: boolean,
): number[] {
  if (amount <= 0 || totalLength <= 0 || dists.length < 3) return dists.map(heightAt);
  const N = Math.max(3, Math.ceil(totalLength / GRID) + (closed ? 0 : 1));
  const step = closed ? totalLength / N : totalLength / (N - 1);
  let g = Array.from({ length: N }, (_, j) => heightAt(j * step));

  const windowM = 20 + Math.min(1, amount) * 380; // 20 m .. 400 m
  const half = Math.max(1, Math.round(windowM / 2 / step));
  for (let pass = 0; pass < 2; pass++) {
    // prefix sums: each pass is O(N) however wide the window
    const pre = new Float64Array(N + 1);
    for (let j = 0; j < N; j++) pre[j + 1] = pre[j] + g[j];
    const sum = (a: number, b: number) => pre[b + 1] - pre[a]; // inclusive a..b, 0<=a<=b<N
    const out = new Array<number>(N);
    for (let j = 0; j < N; j++) {
      if (closed) {
        const span = Math.min(half, Math.floor((N - 1) / 2));
        let s = 0;
        const a = j - span, b = j + span;
        if (a < 0) s += sum(a + N, N - 1) + sum(0, b);
        else if (b >= N) s += sum(a, N - 1) + sum(0, b - N);
        else s += sum(a, b);
        out[j] = s / (2 * span + 1);
      } else {
        const a = Math.max(0, j - half), b = Math.min(N - 1, j + half);
        out[j] = sum(a, b) / (b - a + 1);
      }
    }
    g = out;
  }

  return dists.map((d) => {
    let x = d / step;
    if (closed) x = ((x % N) + N) % N;
    else x = Math.max(0, Math.min(N - 1, x));
    const j = Math.floor(x), f = x - j;
    const j1 = closed ? (j + 1) % N : Math.min(N - 1, j + 1);
    return g[j] * (1 - f) + g[j1] * f;
  });
}

/** Steepest gradient in the profile, as a percentage - what "too steep" means
 *  objectively. Real circuits sit around 3-10%; Eau Rouge is about 17%.
 *  Measured over true distances, not an average spacing. */
export function maxGradientPct(heights: number[], dists: number[]): number {
  let worst = 0;
  for (let i = 1; i < heights.length; i++) {
    const ds = dists[i] - dists[i - 1];
    if (ds > 0.25) worst = Math.max(worst, Math.abs(heights[i] - heights[i - 1]) / ds);
  }
  return worst * 100;
}

/** Tightest vertical curve on the lap, in metres of radius (crest or dip),
 *  measured over a ~6 m baseline. Under ~100 m a car is thrown or bottoms out. */
export function tightestVerticalRadius(heights: number[], dists: number[]): number {
  let worst = Infinity;
  for (let i = 2; i < heights.length - 2; i++) {
    const a = dists[i] - dists[i - 2], b = dists[i + 2] - dists[i];
    if (a <= 0.5 || b <= 0.5) continue;
    const s0 = (heights[i] - heights[i - 2]) / a, s1 = (heights[i + 2] - heights[i]) / b;
    const k = Math.abs(s1 - s0) / ((a + b) / 2);
    if (k > 1e-9) worst = Math.min(worst, 1 / k);
  }
  return worst;
}
