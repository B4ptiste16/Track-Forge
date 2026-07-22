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

export function genFastLaneAi(built: BuiltTrack, width: number, sfDist = 0): Uint8Array {
  // Rotate the lap so spline position 0 sits ON the start/finish line: AC's
  // lap timing and normalizedCarPosition then both start at the line instead
  // of at the first segment's origin (which produced phantom ~3 s "laps"
  // after a restart and offset progress readings).
  let src = built.centerline;
  if (built.closure.closed && sfDist > 1) {
    let k = 0;
    while (k < src.length - 1 && src[k].dist < sfDist) k++;
    src = [...src.slice(k), ...src.slice(0, k)];
  }
  const n = src.length;
  if (n < 8) return new Uint8Array(0);

  // --- racing line: drift toward the inside of corners, slope-limited -------
  const curv = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    let dh = src[i + 1].heading - src[i - 1].heading;
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    // positional distance (dist-along wraps at the rotated seam)
    const ds = Math.max(
      0.5,
      Math.hypot(src[i + 1].pos[0] - src[i - 1].pos[0], src[i + 1].pos[1] - src[i - 1].pos[1]),
    );
    curv[i] = dh / ds; // >0 = turning left
  }
  const maxOff = Math.max(0, width / 2 - 2.0);
  const off = curv.map((c) => Math.sign(c) * Math.min(1, Math.abs(c) * 55) * maxOff);
  // smooth the offset so the line doesn't dart around
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < n - 1; i++) off[i] = (off[i - 1] + off[i] * 2 + off[i + 1]) / 4;
  }
  for (let i = 1; i < n; i++) {
    const ds = Math.max(
      0.1,
      Math.hypot(src[i].pos[0] - src[i - 1].pos[0], src[i].pos[1] - src[i - 1].pos[1]),
    );
    const d = off[i] - off[i - 1];
    const lim = 0.15 * ds;
    if (Math.abs(d) > lim) off[i] = off[i - 1] + Math.sign(d) * lim;
  }

  const px = new Array<number>(n), py = new Array<number>(n), pz = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const [lx, ly] = perpLeft(src[i].heading);
    px[i] = src[i].pos[0] + lx * off[i];
    py[i] = src[i].pos[1] + ly * off[i];
    pz[i] = src[i].pos[2];
  }

  // cumulative length of the actual line
  const len = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    len[i] = len[i - 1] + Math.hypot(px[i] - px[i - 1], py[i] - py[i - 1], pz[i] - pz[i - 1]);
  }

  // --- speed profile ---------------------------------------------------------
  const radius = new Array<number>(n).fill(10000);
  for (let i = 1; i < n - 1; i++) {
    const c = Math.abs(curv[i]);
    radius[i] = c > 1e-5 ? Math.min(10000, 1 / c) : 10000;
  }
  const v = radius.map((r) => Math.min(MAX_SPEED, Math.sqrt(LAT_G * Math.max(5, r))));
  const wrap = (i: number) => ((i % n) + n) % n;
  const dsAt = (i: number) => Math.max(0.2, len[wrap(i + 1)] > len[i] ? len[wrap(i + 1)] - len[i] : 2);
  // two wrap-around passes so the closed lap converges
  for (let pass = 0; pass < 2; pass++) {
    for (let k = 2 * n - 1; k >= 0; k--) {
      const i = wrap(k);
      const j = wrap(k + 1);
      v[i] = Math.min(v[i], Math.sqrt(v[j] * v[j] + 2 * BRAKE_G * dsAt(i)));
    }
    for (let k = 0; k < 2 * n; k++) {
      const i = wrap(k);
      const j = wrap(k + 1);
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
    const dirx = Math.cos(src[i].heading), diry = Math.sin(src[i].heading);
    f32(v[i]); // speed (m/s)
    f32(a > 0 ? Math.min(1, a / ACCEL_G) : 0); // gas
    f32(a < 0 ? Math.min(1, -a / BRAKE_G) : 0); // brake
    f32(0); // obsoleteLatG
    f32(radius[i]);
    f32(Math.max(0.5, width / 2 - off[i])); // sideLeft
    f32(Math.max(0.5, width / 2 + off[i])); // sideRight
    f32(0); // camber
    f32(0); // direction
    f32(0); f32(1); f32(0); // normal (Y-up)
    f32(len[i]);
    f32(dirx); f32(0); f32(-diry); // forward, AC frame
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
