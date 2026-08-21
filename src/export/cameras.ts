import type { BuiltTrack } from '../geometry';
import type { TrackCamera, TrackProject } from '../types';
import { perpLeft } from '../geometry/frames';

// TRACKSIDE TV CAMERAS (data/cameras.ini).
//
// These are the broadcast cameras AC cuts between when you watch a replay or
// press F3. Without the file AC falls back to a single default view, which is
// why a home-made track never looks like a race on television.
//
// Each camera owns a STRETCH of the lap (IN_POINT..OUT_POINT, normalised) and
// AC switches to it while the car is in that stretch — so the set has to cover
// 0..1 with no gaps, or the view drops out partway round.

const AUTO_SPACING_M = 420; // roughly one camera per this much lap

/** Cameras placed automatically: one per stretch of track, sitting off the
 *  outside of whatever the track is doing there and looking at the middle of
 *  its own stretch. The outside is where a real camera goes — it sees the whole
 *  corner rather than the inside kerb. */
export function autoCameras(built: BuiltTrack, project: TrackProject): TrackCamera[] {
  const total = built.totalLength;
  if (total < 50 || built.centerline.length < 8) return [];
  const n = Math.max(4, Math.min(20, Math.round(total / AUTO_SPACING_M)));
  const out: TrackCamera[] = [];
  for (let i = 0; i < n; i++) {
    const dist = ((i + 0.5) / n) * total;
    // Which way does the track bend here? Put the camera on the outside of it.
    const j = nearestIndex(built, dist);
    const k = nearestIndex(built, (dist + total * 0.03) % total);
    let dh = built.centerline[k].heading - built.centerline[j].heading;
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    // dh > 0 = turning left, so the outside is the right-hand side.
    const side: 'left' | 'right' = dh > 0.02 ? 'right' : dh < -0.02 ? 'left' : (i % 2 ? 'left' : 'right');
    out.push({
      id: `cam${i}`,
      dist,
      side,
      offset: 32 + (project.road.width / 2),
      height: 11,
      fov: 30,
    });
  }
  return out;
}

function nearestIndex(built: BuiltTrack, dist: number): number {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < built.centerline.length; i++) {
    const d = Math.abs(built.centerline[i].dist - dist);
    if (d < bd) { bd = d; bi = i; }
  }
  return bi;
}

export function genCamerasIni(built: BuiltTrack, project: TrackProject): string {
  const cams = (project.cameras?.length ? project.cameras : autoCameras(built, project))
    .slice()
    .sort((a, b) => a.dist - b.dist);
  if (!cams.length) return '';
  const total = built.totalLength;

  const blocks = cams.map((c, i) => {
    const j = nearestIndex(built, c.dist);
    const s = built.centerline[j];
    const [lx, ly] = perpLeft(s.heading);
    const sgn = c.side === 'left' ? 1 : -1;
    // Camera position, native frame, then converted to AC's (x, up, -y).
    const cx = s.pos[0] + lx * c.offset * sgn;
    const cy = s.pos[1] + ly * c.offset * sgn;
    const cz = s.pos[2] + c.height;
    // Look at the track a little further on, so the car comes TOWARD the shot
    // rather than being abeam of it the whole time.
    const t = built.centerline[nearestIndex(built, (c.dist + total * 0.02) % total)];

    const px = cx, py = cz, pz = -cy;              // AC: x, up, -y
    const tx = t.pos[0], ty = t.pos[2] + 1.0, tz = -t.pos[1];
    let fx = tx - px, fy = ty - py, fz = tz - pz;
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl; fy /= fl; fz /= fl;
    // UP = world up made perpendicular to FORWARD (this is exactly what Kunos'
    // own cameras carry: a world up with the forward's pitch removed).
    let ux = -fx * fy, uy = 1 - fy * fy, uz = -fz * fy;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;

    // The stretch this camera covers: from halfway back to the previous camera
    // to halfway on to the next, so the set tiles the lap with no gaps.
    const prev = cams[(i - 1 + cams.length) % cams.length];
    const next = cams[(i + 1) % cams.length];
    const midBack = midpoint(prev.dist, c.dist, total);
    const midFwd = midpoint(c.dist, next.dist, total);
    const f = (v: number) => (v / total + 1) % 1;

    const num = (v: number) => v.toFixed(6);
    return `[CAMERA_${i}]
NAME=${c.name ?? `camera ${i + 1}`}
POSITION=${num(px)} ,${num(py)} ,${num(pz)}
FORWARD=${num(fx)} ,${num(fy)} ,${num(fz)}
UP=${num(ux)} ,${num(uy)} ,${num(uz)}
MIN_FOV=${Math.max(2, (c.fov ?? 30) * 0.35)}
MAX_FOV=${c.fov ?? 30}
IN_POINT=${num(f(midBack))}
OUT_POINT=${num(f(midFwd))}
SHADOW_SPLIT0=60
SHADOW_SPLIT1=180
SHADOW_SPLIT2=500
NEAR_PLANE=1
FAR_PLANE=35000
MIN_EXPOSURE=0.35
MAX_EXPOSURE=0.55
DOF_FACTOR=3
DOF_RANGE=250
DOF_FOCUS=50
DOF_MANUAL=0
SPLINE=
SPLINE_ROTATION=0
FOV_GAMMA=0.7
SPLINE_ANIMATION_LENGTH=0
IS_FIXED=1
`;
  });

  return `[HEADER]
VERSION=3
CAMERA_COUNT=${cams.length}
SET_NAME=TV 1

${blocks.join('\n')}`;
}

// Midpoint of two lap positions the short way round (the set wraps at the line).
function midpoint(a: number, b: number, total: number): number {
  let d = b - a;
  if (d < 0) d += total;
  return (a + d / 2) % total;
}
