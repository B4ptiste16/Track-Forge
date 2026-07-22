import type { TrackProject } from '../types';
import { buildTrack } from '../geometry';
import { slugify, THEME_PALETTES } from '../state/project';
import { genBlenderScript } from './blenderScript';
import { genFbx } from './fbx';
import { genSurfacesIni } from './surfaces';
import { genUiTrack } from './uiTrack';
import { genInstructions } from './instructions';
import { genTextures } from './textures';
import { genKsPersistence } from './ksPersistence';
import { genFastLaneAi, genPitLaneAi } from './ai';

// One file in the track package. Either text or binary bytes.
export interface TrackFile {
  path: string; // relative path within the track folder
  text?: string;
  bytes?: Uint8Array;
}

// Build every file that makes up the exported track. Shared by the browser
// (zips them for download) and the desktop app (writes them straight to disk).
export function buildFileMap(project: TrackProject, slugOverride?: string): { slug: string; files: TrackFile[] } {
  const slug = slugOverride ? slugify(slugOverride) : slugify(project.meta.name);
  const built = buildTrack(project);
  const textures = genTextures(built, THEME_PALETTES[project.meta.theme], project.meta.theme, project.walls.style);
  const fbxText = genFbx(project, built);
  const aiLine = genFastLaneAi(built, project.road.width, project.startFinishDist);
  const pitLane = genPitLaneAi(built, project);

  const files: TrackFile[] = [
    { path: `${slug}.fbx`, text: fbxText },
    // KsEditor auto-loads this on Import FBX → all materials pre-assigned.
    { path: `${slug}.fbx.ini`, text: genKsPersistence(slug, fbxText, built, textures) },
    { path: 'data/surfaces.ini', text: genSurfacesIni() },
    { path: 'ui/ui_track.json', text: genUiTrack(project, built) },
    { path: 'INSTRUCTIONS.md', text: genInstructions(project, built, slug, textures) },
    // AI racing line — AC's opponents + the "ideal line" app work out of the box.
    ...(aiLine.length ? [{ path: 'ai/fast_lane.ai', bytes: aiLine }] : [{ path: 'ai/.gitkeep', text: '' }]),
    // Pit-lane spline — AC recognises the pit lane + applies its speed limiter.
    ...(pitLane.length ? [{ path: 'ai/pit_lane.ai', bytes: pitLane }] : []),
    { path: 'blender_fallback/build_track.py', text: genBlenderScript(project, built, slug) },
    { path: `${slug}.acforge.json`, text: JSON.stringify(project, null, 2) },
    ...textures.map((t) => ({ path: t.path, bytes: t.bytes })),
  ];
  return { slug, files };
}
