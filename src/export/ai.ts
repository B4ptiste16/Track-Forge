import type { BuiltTrack } from '../geometry';
import type { TrackProject } from '../types';
import { perpLeft } from '../geometry/frames';

// AC applies its pit speed limiter (and its AI uses the pit lane) when the
// track provides ai/pit_lane.ai — a spline down the pit lane. Generating it
// here means the user never has to set the pit lane up in KsEditor. The spline
// carries a low, constant speed (the pit limit) so the lane reads as a pit.
const PIT_LIMIT_KMH = 60; // pit-lane target speed baked into the spline

// ---------------------------------------------------------------------------
// AC AI spline writer (`ai/fast_lane.ai`, version 7) — the file AC's built-in
// AI and the "ideal line" app follow. Binary, little-endian:
//   int32 version(7), int32 detailCount, int32 lapTime(0), int32 sampleCount(0)
//   detailCount × { float3 position, float length, int32 id }
//   int32 extraCount(=detailCount)
//   extraCount × 18 floats { speed, gas, brake, obsoleteLatG, radius,
//     sideLeft, sideRight, camber, direction, normal xyz, length,
//     forward xyz, tag, grade }
// Positions are in the same world frame as the KN5 (Y-up): (x, z, -y) of our
// native Z-up coordinates — identical to the FBX conversion.
// ---------------------------------------------------------------------------

const MAX_SPEED = 84; // m/s (~300 km/h)
const LAT_G = 11; // m/s² usable lateral accel for corner speed
const BRAKE_G = 9; // m/s² braking
const ACCEL_G = 4.5; // m/s² traction

// Racing line: lateral offsets from the centreline that minimise curvature
// (outside on entry, apex on the inside, outside on exit) within the road,
// keeping the car's centre EDGE_MARGIN inside each edge.
const LINE_STEP = 2; // m between racing-line points
const EDGE_MARGIN = 1.2; // m from the line to the nearest road edge, minimum
const COARSE = 16; // coarsest solver stride (stations); closed laps use a multiple of it

const wrapPi = (a: number) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};

interface Stations {
  cx: Float64Array; cy: Float64Array; cz: Float64Array;
  nx: Float64Array; ny: Float64Array; // unit left normal of the centreline
}

// Centreline resampled at uniform arc length (planar), starting at src[0].
function resample(src: BuiltTrack['centerline'], closed: boolean): Stations | null {
  const m = src.length;
  const cum = [0];
  for (let i = 1; i < m; i++) {
    cum.push(cum[i - 1] + Math.hypot(src[i].pos[0] - src[i - 1].pos[0], src[i].pos[1] - src[i - 1].pos[1]));
  }
  let total = cum[m - 1];
  if (closed) total += Math.hypot(src[0].pos[0] - src[m - 1].pos[0], src[0].pos[1] - src[m - 1].pos[1]);
  if (total < 8 * LINE_STEP) return null;
  const n = closed
    ? Math.max(COARSE, COARSE * Math.round(total / (COARSE * LINE_STEP)))
    : Math.max(8, Math.round(total / LINE_STEP) + 1);
  const h = closed ? total / n : total / (n - 1);
  const st: Stations = {
    cx: new Float64Array(n), cy: new Float64Array(n), cz: new Float64Array(n),
    nx: new Float64Array(n), ny: new Float64Array(n),
  };
  let seg = 0;
  for (let k = 0; k < n; k++) {
    const s = k * h;
    while (seg < m - 1 && cum[seg + 1] < s) seg++;
    const a = src[seg];
    const last = seg >= m - 1;
    const b = last ? src[0] : src[seg + 1];
    const len = (last ? total : cum[seg + 1]) - cum[seg];
    const t = len > 1e-9 ? Math.min(1, Math.max(0, (s - cum[seg]) / len)) : 0;
    st.cx[k] = a.pos[0] + (b.pos[0] - a.pos[0]) * t;
    st.cy[k] = a.pos[1] + (b.pos[1] - a.pos[1]) * t;
    st.cz[k] = a.pos[2] + (b.pos[2] - a.pos[2]) * t;
    const [lx, ly] = perpLeft(a.heading + wrapPi(b.heading - a.heading) * t);
    st.nx[k] = lx;
    st.ny[k] = ly;
  }
  return st;
}

// Minimum-curvature lateral offsets (+ = left), |w| <= maxW. Projected
// Gauss-Seidel on sum c[j] |P[j-1] - 2P[j] + P[j+1]|^2 with P = C + w*N,
// solved coarse-to-fine so long corners converge in a few hundred sweeps.
// c[j] = 1/h[j]^3 (h = local point spacing) makes the sum the true integral
// of curvature^2 along the LINE: stations bunch up on the inside of a corner,
// and unweighted they made a tight apex look ~4x cheaper than it is.
function racingOffsets(st: Stations, maxW: number, closed: boolean): Float64Array {
  const n = st.cx.length;
  const w = new Float64Array(n);
  if (maxW <= 0) return w;
  for (let stride = COARSE; stride >= 1; stride >>= 1) {
    const idx: number[] = [];
    for (let i = 0; i < n; i += stride) idx.push(i);
    if (!closed && idx[idx.length - 1] !== n - 1) idx.push(n - 1);
    const k = idx.length;
    if (k < 8) continue;
    const ptX = (j: number) => {
      const i = idx[closed ? ((j % k) + k) % k : Math.max(0, Math.min(k - 1, j))];
      return st.cx[i] + st.nx[i] * w[i];
    };
    const ptY = (j: number) => {
      const i = idx[closed ? ((j % k) + k) % k : Math.max(0, Math.min(k - 1, j))];
      return st.cy[i] + st.ny[i] * w[i];
    };
    const sweeps = stride >= 8 ? 2000 : stride >= 2 ? 800 : 400;
    const lo = closed ? 0 : 2, hi = closed ? k : k - 2;
    // 1/h^3 per station (h = mean spacing to its neighbours), refreshed each
    // sweep; open ends get no curvature term
    const c = new Float64Array(k);
    const cw = (j: number) => (closed ? c[((j % k) + k) % k] : j < 0 || j >= k ? 0 : c[j]);
    for (let it = 0; it < sweeps; it++) {
      for (let j = 0; j < k; j++) {
        if (!closed && (j === 0 || j === k - 1)) { c[j] = 0; continue; }
        const h = 0.5 * (Math.hypot(ptX(j) - ptX(j - 1), ptY(j) - ptY(j - 1))
          + Math.hypot(ptX(j + 1) - ptX(j), ptY(j + 1) - ptY(j)));
        c[j] = 1 / Math.max(1e-3, h * h * h);
      }
      let moved = 0;
      for (let j = lo; j < hi; j++) {
        const i = idx[j];
        const cm = cw(j - 1), c0 = cw(j), cp = cw(j + 1);
        const den = cm + 4 * c0 + cp;
        if (den <= 0) continue;
        const m1x = ptX(j - 1), p1x = ptX(j + 1), m1y = ptY(j - 1), p1y = ptY(j + 1);
        const tx = (cm * (2 * m1x - ptX(j - 2)) + 2 * c0 * (m1x + p1x) + cp * (2 * p1x - ptX(j + 2))) / den;
        const ty = (cm * (2 * m1y - ptY(j - 2)) + 2 * c0 * (m1y + p1y) + cp * (2 * p1y - ptY(j + 2))) / den;
        const px = st.cx[i] + st.nx[i] * w[i], py = st.cy[i] + st.ny[i] * w[i];
        const step = 1.5 * ((tx - px) * st.nx[i] + (ty - py) * st.ny[i]); // over-relaxed
        const nw = Math.max(-maxW, Math.min(maxW, w[i] + step));
        moved = Math.max(moved, Math.abs(nw - w[i]));
        w[i] = nw;
      }
      if (moved < 1e-4) break;
    }
    if (stride > 1) {
      // linear fill between solved stations -> start of the next, finer level
      for (let j = 0; j < k; j++) {
        const i0 = idx[j];
        const i1 = j + 1 < k ? idx[j + 1] : closed ? n : -1;
        if (i1 < 0) break;
        const w1 = i1 === n ? w[0] : w[i1];
        for (let i = i0 + 1; i < i1; i++) w[i] = w[i0] + ((w1 - w[i0]) * (i - i0)) / (i1 - i0);
      }
    }
  }
  return w;
}

export function genFastLaneAi(built: BuiltTrack, width: number, sfDist = 0): Uint8Array {
  // Rotate the lap so spline position 0 sits ON the start/finish line: AC's
  // lap timing and normalizedCarPosition then both start at the line instead
  // of at the first segment's origin (which produced phantom ~3 s "laps"
  // after a restart and offset progress readings).
  const closed = built.closure.closed;
  let src = built.centerline;
  if (closed && sfDist > 1) {
    let k = 0;
    while (k < src.length - 1 && src[k].dist < sfDist) k++;
    src = [...src.slice(k), ...src.slice(0, k)];
  }
  if (src.length < 8) return new Uint8Array(0);
  const st = resample(src, closed);
  if (!st) return new Uint8Array(0);
  const n = st.cx.length;

  // --- racing line -----------------------------------------------------------
  const off = racingOffsets(st, Math.max(0, width / 2 - EDGE_MARGIN), closed);
  const px = new Array<number>(n), py = new Array<number>(n), pz = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    px[i] = st.cx[i] + st.nx[i] * off[i];
    py[i] = st.cy[i] + st.ny[i] * off[i];
    pz[i] = st.cz[i];
  }
  const wrap = (i: number) => (closed ? ((i % n) + n) % n : Math.max(0, Math.min(n - 1, i)));

  // heading + signed curvature (+ = turning left) OF THE LINE ITSELF
  const head = new Array<number>(n);
  const curv = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const a = wrap(i - 1), b = wrap(i + 1);
    head[i] = Math.atan2(py[b] - py[a], px[b] - px[a]);
    if (a === i || b === i) continue;
    const ax = px[i] - px[a], ay = py[i] - py[a], bx = px[b] - px[i], by = py[b] - py[i];
    const d = Math.hypot(ax, ay) * Math.hypot(bx, by) * Math.hypot(ax + bx, ay + by);
    curv[i] = d > 1e-9 ? (2 * (ax * by - ay * bx)) / d : 0;
  }
  for (let pass = 0; pass < 2; pass++) {
    const c0 = curv.slice();
    for (let i = 0; i < n; i++) curv[i] = (c0[wrap(i - 1)] + 2 * c0[i] + c0[wrap(i + 1)]) / 4;
  }

  // cumulative length of the line
  const len = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    len[i] = len[i - 1] + Math.hypot(px[i] - px[i - 1], py[i] - py[i - 1], pz[i] - pz[i - 1]);
  }

  // --- speed profile on the line's own curvature -----------------------------
  const radius = curv.map((c) => (Math.abs(c) > 1e-5 ? Math.min(10000, 1 / Math.abs(c)) : 10000));
  const v = radius.map((r) => Math.min(MAX_SPEED, Math.sqrt(LAT_G * Math.max(5, r))));
  const dsAt = (i: number) =>
    Math.max(0.2, Math.hypot(px[wrap(i + 1)] - px[i], py[wrap(i + 1)] - py[i], pz[wrap(i + 1)] - pz[i]));
  // closed lap: two wrap-around passes so it converges
  const laps = closed ? 2 : 1;
  for (let pass = 0; pass < laps; pass++) {
    for (let k = laps * n - 1; k >= 0; k--) {
      const i = k % n;
      if (!closed && i === n - 1) continue;
      const j = wrap(i + 1);
      v[i] = Math.min(v[i], Math.sqrt(v[j] * v[j] + 2 * BRAKE_G * dsAt(i)));
    }
    for (let k = 0; k < laps * n; k++) {
      const i = k % n;
      if (!closed && i === n - 1) continue;
      const j = wrap(i + 1);
      v[j] = Math.min(v[j], Math.sqrt(v[i] * v[i] + 2 * ACCEL_G * dsAt(i)));
    }
  }

  // --- write -----------------------------------------------------------------
  const DETAIL = 20, EXTRA = 72;
  const buf = new ArrayBuffer(16 + n * DETAIL + 4 + n * EXTRA);
  const dv = new DataView(buf);
  let o = 0;
  const i32 = (x: number) => { dv.setInt32(o, x, true); o += 4; };
  const f32 = (x: number) => { dv.setFloat32(o, x, true); o += 4; };

  i32(7); i32(n); i32(0); i32(0);
  for (let i = 0; i < n; i++) {
    // native Z-up -> AC Y-up: (x, z, -y)
    f32(px[i]); f32(pz[i]); f32(-py[i]);
    f32(len[i]);
    i32(i);
  }
  i32(n);
  for (let i = 0; i < n; i++) {
    const j = wrap(i + 1);
    const ds = dsAt(i);
    const a = (v[j] * v[j] - v[i] * v[i]) / (2 * ds);
    const dirx = Math.cos(head[i]), diry = Math.sin(head[i]);
    f32(v[i]); // speed (m/s)
    f32(a > 0 ? Math.min(1, a / ACCEL_G) : 0); // gas
    f32(a < 0 ? Math.min(1, -a / BRAKE_G) : 0); // brake
    f32(0); // obsoleteLatG
    f32(radius[i]);
    // distances from the LINE to each road edge (not half-widths)
    f32(Math.max(0.5, width / 2 - off[i])); // sideLeft
    f32(Math.max(0.5, width / 2 + off[i])); // sideRight
    f32(0); // camber
    f32(0); // direction
    f32(0); f32(1); f32(0); // normal (Y-up)
    f32(len[i]);
    f32(dirx); f32(0); f32(-diry); // forward of the line, AC frame
    f32(0); // tag
    f32(0); // grade
  }
  return new Uint8Array(buf);
}

// Pit-lane spline (ai/pit_lane.ai). Runs down the pit lane (offset to the pit
// side, between entry and exit) at a constant low speed, so AC recognises the
// pit lane and applies its speed limiter without any KsEditor setup.
export function genPitLaneAi(built: BuiltTrack, project: TrackProject): Uint8Array {
  if (!project.pit.enabled) return new Uint8Array(0);
  const samples = built.centerline;
  const total = built.totalLength;
  if (samples.length < 8 || total < 10) return new Uint8Array(0);

  const width = project.road.width;
  const e0 = Math.max(0, Math.min(total, project.pit.entry));
  const e1 = Math.max(0, Math.min(total, project.pit.exit));
  const wraps = e1 < e0;
  // pit-lane centre offset from the road centreline, on the pit side
  const sideSign = project.pit.side === 'left' ? 1 : -1;
  const laneOff = (width / 2 + project.pit.width / 2) * sideSign;

  // collect the pit-zone samples in order (wrap-aware), a little before entry
  // and after exit so the lane blends onto the track.
  const inZone = (d: number) => (wraps ? d >= e0 - 12 || d <= e1 + 12 : d >= e0 - 12 && d <= e1 + 12);
  const seq: typeof samples = [];
  const startK = samples.findIndex((s) => (wraps ? s.dist >= e0 - 12 : inZone(s.dist)));
  if (wraps) {
    for (let i = 0; i < samples.length; i++) {
      const s = samples[(startK + i) % samples.length];
      if (inZone(s.dist)) seq.push(s);
    }
  } else {
    for (const s of samples) if (inZone(s.dist)) seq.push(s);
  }
  const n = seq.length;
  if (n < 8) return new Uint8Array(0);

  const px = new Array<number>(n), py = new Array<number>(n), pz = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const [lx, ly] = perpLeft(seq[i].heading);
    px[i] = seq[i].pos[0] + lx * laneOff;
    py[i] = seq[i].pos[1] + ly * laneOff;
    pz[i] = seq[i].pos[2];
  }
  const len = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) len[i] = len[i - 1] + Math.hypot(px[i] - px[i - 1], py[i] - py[i - 1], pz[i] - pz[i - 1]);

  const vpit = PIT_LIMIT_KMH / 3.6;
  const DETAIL = 20, EXTRA = 72;
  const buf = new ArrayBuffer(16 + n * DETAIL + 4 + n * EXTRA);
  const dv = new DataView(buf);
  let o = 0;
  const i32 = (x: number) => { dv.setInt32(o, x, true); o += 4; };
  const f32 = (x: number) => { dv.setFloat32(o, x, true); o += 4; };
  i32(7); i32(n); i32(0); i32(0);
  for (let i = 0; i < n; i++) {
    f32(px[i]); f32(pz[i]); f32(-py[i]);
    f32(len[i]);
    i32(i);
  }
  i32(n);
  const halfW = project.pit.width / 2;
  for (let i = 0; i < n; i++) {
    const dirx = Math.cos(seq[i].heading), diry = Math.sin(seq[i].heading);
    f32(vpit); // constant pit speed
    f32(0.3); f32(0); // gentle gas, no brake
    f32(0);
    f32(10000); // straight-ish
    f32(halfW); f32(halfW);
    f32(0); f32(0);
    f32(0); f32(1); f32(0);
    f32(len[i]);
    f32(dirx); f32(0); f32(-diry);
    f32(0); f32(0);
  }
  return new Uint8Array(buf);
}
