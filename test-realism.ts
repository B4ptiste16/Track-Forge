// Full-pipeline smoke test: a track with a tight chicane must build without
// throwing and produce sane mesh sizes (structural check; the core smoothing
// algorithm itself is verified in isolation — see the unit tests below).
import { defaultProject, newSegId } from './src/state/project';
import { buildTrack } from './src/geometry';
import type { Segment } from './src/types';

const p = defaultProject();
const MINR = p.road.width / 2 + 3;
const segs: Segment[] = [
  { id: newSegId(), kind: 'straight', length: 150 },
  { id: newSegId(), kind: 'corner', radius: MINR, angle: 40, dir: 'left' },
  { id: newSegId(), kind: 'corner', radius: MINR, angle: 40, dir: 'right' },
  { id: newSegId(), kind: 'straight', length: 150 },
  { id: newSegId(), kind: 'corner', radius: 60, angle: 180, dir: 'left' },
  { id: newSegId(), kind: 'straight', length: 100 },
  { id: newSegId(), kind: 'corner', radius: 60, angle: 180, dir: 'left' },
];
p.segments = segs;
p.corners = segs.filter((s) => s.kind === 'corner').map((_, i) => ({ cornerIndex: i, entry: 'flat', apex: 'flat', exit: 'flat' } as const));

const built = buildTrack(p);
console.log('centerline samples:', built.centerline.length);
console.log('meshes:', built.meshes.map((m) => `${m.name}:${m.faces.length}`).join(', '));
const grass = built.meshes.find((m) => m.name === '1GRASS');
console.log('grass mesh built:', grass && grass.faces.length > 0 ? 'OK' : 'MISSING/EMPTY');
console.log('no exceptions thrown -> pipeline integrates cleanly');

// unit tests for the core algorithm (smoothCeiling / erosion safety)
import { slopeLimit, smoothCeiling } from './src/geometry/runoff';
const N = 200, dists = Array.from({ length: N }, (_, i) => i), WIDTH = 14, MAX_SLOPE = 0.4;
function run(cap: number[], inner: number[], smooth: boolean) {
  const ceil = smooth ? smoothCeiling(cap, false) : cap;
  const arr = dists.map((_, i) => Math.max(inner[i], Math.min(inner[i] + WIDTH, ceil[i])));
  slopeLimit(arr, dists, MAX_SLOPE, false);
  for (let i = 0; i < arr.length; i++) arr[i] = Math.max(arr[i], inner[i]);
  return arr;
}
const cap = dists.map((d) => (d >= 90 && d <= 110 ? 1.5 : 200));
const inner = dists.map(() => 0);
const before = run(cap, inner, false), after = run(cap, inner, true);
function curv(a: number[]) { let m = 0; for (let i = 1; i < a.length - 1; i++) m = Math.max(m, Math.abs(a[i - 1] - 2 * a[i] + a[i + 1])); return m; }
console.log(`realistic 20m chicane dip: min preserved ${Math.abs(Math.min(...after) - 1.5) < 0.01} | smoother ${curv(after) < curv(before)}`);
