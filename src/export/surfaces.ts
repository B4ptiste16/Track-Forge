// Minimal but valid AC surfaces.ini. Each surface KEY matches the keyword in the
// mesh name (1ROAD -> ROAD, 1KERB -> KERB, 1KERBHI -> KERBHI, 1GRASS -> GRASS …).
interface SurfaceOpts {
  friction: number;
  valid: number;
  pitlane?: number; // AC logs KEY_NOT_FOUND for every surface without this
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
IS_PITLANE=${o.pitlane ?? 0}
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
    // Grass: slippery and it dirties the tyres, so a trip across it costs you
    // grip for the next corner too. A light SIN_* gives the verge some texture.
    block(3, 'GRASS', { friction: 0.6, valid: 0, dirt: 3, sinHeight: 0.012, sinLength: 0.7, vibGain: 0.35, vibLength: 1.0 }),
    block(4, 'PIT', { friction: 0.9, valid: 1, pitlane: 1 }),
    // SAND (gravel trap): the car should PLOUGH, not skate. Low friction with a
    // strong dirt pickup (tyres cake up and stay slow for a while afterwards)
    // plus a coarse SIN_* so the surface visibly/physically drags and rumbles —
    // that, with the raked drag marks baked into the texture, is how AC conveys
    // "you went through the gravel". AC cannot deform a surface at runtime, so
    // the trap can't carve a new trail where THIS car went.
    block(5, 'SAND', { friction: 0.5, valid: 0, dirt: 6, sinHeight: 0.03, sinLength: 0.5, vibGain: 1.0, vibLength: 0.6 }),
    block(6, 'CONCRETE', { friction: 0.96, valid: 0 }),
    block(7, 'TARMAC', { friction: 0.98, valid: 0 }), // paved run-off: grips, but laps don't validate
    block(8, 'DIRT', { friction: 0.62, valid: 0, dirt: 4, sinHeight: 0.02, sinLength: 0.6, vibGain: 0.6, vibLength: 0.8 }),
  ].join('\n');
}
