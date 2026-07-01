import type { TrackProject } from '../types';
import type { BuiltTrack } from '../geometry';

// ui/ui_track.json. pitboxes MUST equal the number of AC_PIT_* empties or AC
// rejects the track, so we count them from the built result, not the config.
export function genUiTrack(project: TrackProject, built: BuiltTrack): string {
  const pitboxes = built.empties.filter((e) => e.name.startsWith('AC_PIT_')).length;
  const data = {
    name: project.meta.name,
    description: `${project.meta.name} — generated with AC Track Forge.`,
    tags: ['ac track forge', 'generated', project.meta.theme],
    geotags: [],
    country: project.meta.country,
    city: '',
    length: String(Math.round(built.totalLength)),
    width: String(project.road.width),
    pitboxes: String(pitboxes),
    run: project.meta.direction === 'cw' ? 'clockwise' : 'counterclockwise',
    author: project.meta.author,
    version: '1.0',
    url: '',
  };
  return JSON.stringify(data, null, 2);
}
