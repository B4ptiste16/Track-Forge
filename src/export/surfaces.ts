// Minimal but valid AC surfaces.ini. Each surface KEY matches the keyword in the
// mesh name (1ROAD -> ROAD, 1KERB -> KERB, 1KERBHI -> KERBHI, 1GRASS -> GRASS …).
interface SurfaceOpts {
  friction: number;
  valid: number;
  sinHeight?: number; // bump height the physics feels (rumble)
  sinLength?: number;
  vibGain?: number; // controller vibration
  vibLength?: number;
  dirt?: number;
}

export function genSurfacesIni(): string {
  const block = (idx: number, key: string, o: SurfaceOpts): string =>
    `[SURFACE_${idx}]
KEY=${key}
FRICTION=${o.friction}
DAMPING=0
WAV=
WAV_PITCH=0
FF_EFFECT=NULL
DIRT_ADDITIVE=${o.dirt ?? 0}
IS_VALID_TRACK=${o.valid}
BLACK_FLAG_TIME=0
SIN_HEIGHT=${o.sinHeight ?? 0}
SIN_LENGTH=${o.sinLength ?? 0}
VIBRATION_GAIN=${o.vibGain ?? 0}
VIBRATION_LENGTH=${o.vibLength ?? 0}
`;

  // Kerbs rumble: SIN_HEIGHT/LENGTH make the physics bump, VIBRATION_* shake the wheel.
  const kerb: SurfaceOpts = { friction: 0.94, valid: 1, sinHeight: 0.04, sinLength: 1.5, vibGain: 1.3, vibLength: 1.5 };

  return [
    block(0, 'ROAD', { friction: 0.99, valid: 1 }),
    block(1, 'KERBHI', kerb), // longer key first so it matches 1KERBHI before KERB
    block(2, 'KERB', kerb),
    block(3, 'GRASS', { friction: 0.6, valid: 0, dirt: 1 }),
    block(4, 'PIT', { friction: 0.9, valid: 1 }),
    block(5, 'SAND', { friction: 0.55, valid: 0, dirt: 1 }),
    block(6, 'CONCRETE', { friction: 0.96, valid: 0 }),
    block(7, 'TARMAC', { friction: 0.98, valid: 0 }), // paved run-off: grips, but laps don't validate
    block(8, 'DIRT', { friction: 0.62, valid: 0, dirt: 1 }),
  ].join('\n');
}
