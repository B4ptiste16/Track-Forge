// Minimal but valid AC surfaces.ini. The KEY of each surface matches the
// keyword in the mesh name (1ROAD -> ROAD, 1KERB -> KERB, 1GRASS -> GRASS).
export function genSurfacesIni(): string {
  const block = (
    idx: number,
    key: string,
    friction: number,
    valid: number,
    extra = '',
  ): string =>
    `[SURFACE_${idx}]
KEY=${key}
FRICTION=${friction}
DAMPING=0
WAV=
WAV_PITCH=0
FF_EFFECT=NULL
DIRT_ADDITIVE=0
IS_VALID_TRACK=${valid}
BLACK_FLAG_TIME=0
SIN_HEIGHT=0
SIN_LENGTH=0
VIBRATION_GAIN=0
VIBRATION_LENGTH=0
${extra}`;

  return [
    block(0, 'ROAD', 0.99, 1),
    block(1, 'KERB', 0.92, 1, 'SIN_HEIGHT=0.03\nSIN_LENGTH=2\nVIBRATION_GAIN=1\nVIBRATION_LENGTH=2\n'),
    block(2, 'GRASS', 0.6, 0, 'DIRT_ADDITIVE=1\n'),
    block(3, 'PIT', 0.9, 1),
    block(4, 'SAND', 0.55, 0, 'DIRT_ADDITIVE=1\n'),
    block(5, 'CONCRETE', 0.96, 0),
  ].join('\n');
}
