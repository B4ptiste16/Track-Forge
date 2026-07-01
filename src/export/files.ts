import type { TrackProject } from '../types';
import { buildTrack } from '../geometry';
import { slugify, THEME_PALETTES } from '../state/project';
import { genBlenderScript } from './blenderScript';
import { genFbx } from './fbx';
import { genSurfacesIni } from './surfaces';
import { genUiTrack } from './uiTrack';
import { genInstructions } from './instructions';
import { genTextures } from './textures';

// One file in the track package. Either text or binary bytes.
export interface TrackFile {
  path: string; // relative path within the track folder
  text?: string;
  bytes?: Uint8Array;
}

// Build every file that makes up the exported track. Shared by the browser
// (zips them for download) and the desktop app (writes them straight to disk).
export function buildFileMap(project: TrackProject): { slug: string; files: TrackFile[] } {
  const slug = slugify(project.meta.name);
  const built = buildTrack(project);
  const textures = genTextures(built, THEME_PALETTES[project.meta.theme]);

  const files: TrackFile[] = [
    { path: `${slug}.fbx`, text: genFbx(project, built) },
    { path: 'data/surfaces.ini', text: genSurfacesIni() },
    { path: 'ui/ui_track.json', text: genUiTrack(project, built) },
    { path: 'INSTRUCTIONS.md', text: genInstructions(project, built, slug, textures) },
    { path: 'ai/.gitkeep', text: '' },
    { path: 'blender_fallback/build_track.py', text: genBlenderScript(project, built, slug) },
    { path: `${slug}.acforge.json`, text: JSON.stringify(project, null, 2) },
    ...textures.map((t) => ({ path: t.path, bytes: t.bytes })),
  ];
  return { slug, files };
}
