// Headless check: the trackside strip must stay ~uniform width around corners
// (the old wedges came from the inside strip collapsing to 0 at every corner).
import { defaultProject } from './src/state/project';
import { buildTrack, perpLeft } from './src/geometry';

const p = defaultProject();
p.trackside.left.texture = 'grass';
p.trackside.right.texture = 'grass';
const built = buildTrack(p);
const w2 = p.road.width / 2;
const grass = built.meshes.find((m) => m.name === '1GRASS')!;

// For each centerline sample, find how far the grass extends past the INSIDE
// road edge of the corner. If the fix worked it stays ~= strip width, not 0.
function insideStripWidth(dist: number, dir: 'left' | 'right'): number {
  // nearest sample
  let s = built.centerline[0];
  for (const c of built.centerline) if (Math.abs(c.dist - dist) < Math.abs(s.dist - dist)) s = c;
  const [lx, ly] = perpLeft(s.heading);
  const sgn = dir === 'left' ? 1 : -1; // toward the inside
  const ex = s.pos[0] + lx * w2 * sgn, ey = s.pos[1] + ly * w2 * sgn; // inside edge
  // max grass vertex projection beyond the edge along the inside normal, near s
  let maxOut = 0;
  for (const v of grass.vertices) {
    if (Math.hypot(v[0] - s.pos[0], v[1] - s.pos[1]) > w2 + 30) continue;
    const proj = (v[0] - ex) * lx * sgn + (v[1] - ey) * ly * sgn;
    const along = Math.abs((v[0] - s.pos[0]) * Math.cos(s.heading) + (v[1] - s.pos[1]) * Math.sin(s.heading));
    if (along < 4 && proj > maxOut && proj < 40) maxOut = proj;
  }
  return maxOut;
}

const corner = built.spans.find((s) => s.kind === 'corner')!;
const dir = corner.dir!;
let minW = 1e9, maxW = 0;
for (let d = corner.startDist + 2; d < corner.endDist - 2; d += 4) {
  const w = insideStripWidth(d, dir);
  minW = Math.min(minW, w); maxW = Math.max(maxW, w);
}
console.log(`inside-corner grass coverage over the corner: ${minW.toFixed(1)}-${maxW.toFixed(1)} m`);
console.log(minW > 10 ? 'OK — strip stays wide through the corner (no wedge)' : 'STILL COLLAPSING');
console.log('meshes:', built.meshes.map((m) => m.name).join(', '));
