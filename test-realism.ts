// Temporary smoke test (bundled by vite.test.config.ts, run in node, then deleted).
import { defaultProject } from './src/state/project';
import { buildTrack } from './src/geometry';
import { genFastLaneAi } from './src/export/ai';
import { genFbx } from './src/export/fbx';

const p = defaultProject();
p.corners[0].escape = true;
const built = buildTrack(p);
console.log('meshes:', built.meshes.map((m) => `${m.name}:${m.faces.length}`).join(', '));

const ai = genFastLaneAi(built, p.road.width);
const dv = new DataView(ai.buffer, ai.byteOffset, ai.byteLength);
const n = dv.getInt32(4, true);
const expected = 16 + n * 20 + 4 + n * 72;
console.log('ai bytes', ai.length, '| version', dv.getInt32(0, true), '| points', n, '| expected size', expected, ai.length === expected ? 'OK' : 'MISMATCH');
const eo = 16 + n * 20 + 4;
let vmin = 1e9, vmax = -1e9, badSide = 0;
for (let i = 0; i < n; i++) {
  const sp = dv.getFloat32(eo + i * 72, true);
  vmin = Math.min(vmin, sp); vmax = Math.max(vmax, sp);
  const sl = dv.getFloat32(eo + i * 72 + 20, true);
  const sr = dv.getFloat32(eo + i * 72 + 24, true);
  if (!(sl > 0 && sr > 0 && sl < 20 && sr < 20)) badSide++;
}
console.log('speed range m/s:', vmin.toFixed(1), '-', vmax.toFixed(1), '| bad side values:', badSide);
console.log('extraCount field:', dv.getInt32(16 + n * 20, true));

const fbx = genFbx(p, built);
console.log('fbx chars:', fbx.length, '| has escape road merge:', built.meshes.find((m) => m.name === '1WALLPOLY') ? 'poly yes' : 'poly NO');
const rejoinTest = built.meshes.find((m) => m.name === 'DECOR_BOLLARD');
console.log('bollards faces:', rejoinTest ? rejoinTest.faces.length : 0);
