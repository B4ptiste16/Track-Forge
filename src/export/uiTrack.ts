import type { TrackProject } from '../types';
import type { BuiltTrack } from '../geometry';


// Net direction of travel around the lap: sum the signed corner angles, right
// negative (clockwise). A circuit's overall handedness is whichever way it turns
// the most in total.
function netTurnIsClockwise(project: TrackProject): boolean {
  let net = 0;
  for (const seg of project.segments) {
    if (seg.kind !== 'corner') continue;
    net += seg.dir === 'right' ? -seg.angle : seg.angle;
  }
  // Ties (a perfectly balanced layout) fall back to whatever the user picked.
  if (net === 0) return project.meta.direction === 'cw';
  return net < 0;
}

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
    // Derived from the SHAPE, not from the dropdown. The direction field never
    // fed the geometry — it only ever labelled this file — so a track drawn with
    // right-handers could be exported as "counterclockwise" simply because the
    // dropdown said so, and nothing on track agreed with it. Net turn decides:
    // right-hand corners are clockwise.
    run: netTurnIsClockwise(project) ? 'clockwise' : 'counterclockwise',
    author: project.meta.author,
    version: '1.0',
    url: '',
  };
  return JSON.stringify(data, null, 2);
}
