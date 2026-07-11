// Headless smoke test (bundled by vite.test.config.ts, run with node).
import { defaultProject, withDefaults, snapshotLayout, applyLayout } from './src/state/project';
import { buildTrack } from './src/geometry';
import { genFastLaneAi } from './src/export/ai';
import { genFbx } from './src/export/fbx';

const p = defaultProject();
p.corners[0].escape = true;
// per-part kerb widths + free apex length overflowing the corner
p.corners[0].apexW = 3;
p.corners[0].apexLen = 300;
// trackside: spaced gravel zone with wall pushed further out
p.trackside.zones.push({
  id: 'z1', side: 'right', from: 40, to: 160,
  texture: 'gravel_spaced', width: 12, wall: true, wallDist: 25,
});
// a building
p.buildings.push({ id: 'b1', x: 100, y: -60, w: 24, d: 10, h: 7, rot: 30 });

const built = buildTrack(p);
console.log('meshes:', built.meshes.map((m) => `${m.name}:${m.faces.length}`).join(', '));

const names = new Set(built.meshes.map((m) => m.name));
for (const want of ['1SAND', 'PIT_LINE', 'DECOR_PITBLDG', 'DECOR_GARAGE', 'DECOR_BUILDING', '1WALL']) {
  if (!names.has(want)) console.log('MISSING MESH:', want);
}

// AI line rotated so index 0 sits at the S/F line
const ai = genFastLaneAi(built, p.road.width, p.startFinishDist);
const dv = new DataView(ai.buffer, ai.byteOffset, ai.byteLength);
const n = dv.getInt32(4, true);
const expected = 16 + n * 20 + 4 + n * 72;
console.log('ai bytes', ai.length, '| points', n, '| size', ai.length === expected ? 'OK' : 'MISMATCH');
// first ai point should be near the S/F sample position
let sf = built.centerline[0];
for (const s of built.centerline) { if (s.dist >= p.startFinishDist) { sf = s; break; } }
const ax = dv.getFloat32(16, true), az = dv.getFloat32(24, true);
const d0 = Math.hypot(ax - sf.pos[0], -az - sf.pos[1]);
console.log(`ai point0 vs S/F line: ${d0.toFixed(1)} m ${d0 < 8 ? 'OK (starts at the line)' : 'WRONG'}`);
let vmin = 1e9, vmax = -1e9;
const eo = 16 + n * 20 + 4;
for (let i = 0; i < n; i++) {
  const sp = dv.getFloat32(eo + i * 72, true);
  vmin = Math.min(vmin, sp); vmax = Math.max(vmax, sp);
}
console.log('speed range m/s:', vmin.toFixed(1), '-', vmax.toFixed(1));

// layouts: snapshot -> mutate -> restore
const withL = { ...p, layouts: [snapshotLayout(p, 'gp')] };
withL.segments = withL.segments.slice(0, 2);
const restored = applyLayout(withL, withL.layouts![0]);
console.log('layout restore:', restored.segments.length === 4 ? 'OK' : 'FAIL');

// legacy migration: old runoff project -> trackside zones
const legacy = defaultProject() as ReturnType<typeof defaultProject> & Record<string, unknown>;
delete (legacy as Record<string, unknown>).trackside;
legacy.runoffDefault = { type: 'grass', dist: 14, wall: true };
legacy.runoff = legacy.segments.map((_, i) =>
  i === 1
    ? { left: { type: 'gravel' as const, dist: 20, wall: false }, right: { type: 'grass' as const, dist: 14, wall: true } }
    : { left: { type: 'grass' as const, dist: 14, wall: true }, right: { type: 'grass' as const, dist: 14, wall: true } },
);
const migrated = withDefaults(legacy);
console.log('migration zones:', migrated.trackside.zones.length === 1 ? 'OK (1 zone from old sections)' : `got ${migrated.trackside.zones.length}`);

const fbx = genFbx(p, built);
console.log('fbx chars:', fbx.length);
