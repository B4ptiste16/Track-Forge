// Generates the export artifacts to disk so they can be validated externally
// (e.g. py_compile on the Blender script). Run: npx tsx scripts/verify_export.mts <outdir>
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { defaultProject } from '../src/state/project';
import { buildTrack } from '../src/geometry';
import { genBlenderScript } from '../src/export/blenderScript';
import { genFbx } from '../src/export/fbx';
import { genSurfacesIni } from '../src/export/surfaces';
import { genUiTrack } from '../src/export/uiTrack';
import { genInstructions } from '../src/export/instructions';

const outDir = process.argv[2] ?? '.';
mkdirSync(outDir, { recursive: true });

const p = defaultProject();
const built = buildTrack(p);
const slug = 'my_circuit';

writeFileSync(join(outDir, `${slug}.fbx`), genFbx(p, built));
writeFileSync(join(outDir, 'build_track.py'), genBlenderScript(p, built, slug));
writeFileSync(join(outDir, 'surfaces.ini'), genSurfacesIni());
writeFileSync(join(outDir, 'ui_track.json'), genUiTrack(p, built));
writeFileSync(join(outDir, 'INSTRUCTIONS.md'), genInstructions(p, built, slug));

console.log('wrote artifacts to', outDir);
console.log('totalLength', Math.round(built.totalLength), 'closed', built.closure.closed);
console.log('meshes', built.meshes.map((m) => m.name).join(', '));
