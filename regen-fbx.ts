// Dev helper: regenerate a track FBX from its .acforge.json (node, headless).
// Usage: node test-dist/regen-fbx.cjs <project.acforge.json> <out.fbx>
import * as fs from 'node:fs';
import { withDefaults } from './src/state/project';
import { buildTrack } from './src/geometry';
import { genFbx } from './src/export/fbx';

const [, , projPath, outPath] = process.argv;
const p = withDefaults(JSON.parse(fs.readFileSync(projPath, 'utf8')));
const built = buildTrack(p);
fs.writeFileSync(outPath, genFbx(p, built));
console.log('written', outPath, 'meshes', built.meshes.length);
