// NIGHT LIGHTING for an exported track.
//
// IMPORTANT, and the reason this file is config rather than geometry alone:
// VANILLA Assetto Corsa has no dynamic track lights. Its track lighting is the
// sun plus baked ambient, so at night a vanilla track is simply dark — there is
// no supported way to add working lamps to it. Real night racing in AC comes
// from Custom Shaders Patch (CSP), which reads light sources from
// `extension/ext_config.ini`.
//
// So we emit BOTH halves:
//   1. `data/lighting.ini` — sane sun/ambient for the track (vanilla AC reads
//      this; it's what stops a night session being pitch black at ground level).
//   2. `extension/ext_config.ini` — real CSP floodlights positioned to match the
//      light masts the builder places around the circuit. Harmless if CSP isn't
//      installed (AC ignores the folder); lights up properly the moment it is.
// The masts themselves are geometry — see buildLightMasts in geometry/decor.ts.
import type { BuiltTrack } from '../geometry';
import type { LightMast } from '../geometry/types';

// Sun/ambient. NIGHT_* keys are what keep a dark session from crushing to black
// in vanilla; CSP overrides these with its own weather/lighting model.
export function genLightingIni(): string {
  return `[LIGHTING]
SUN_PITCH_ANGLE=42
SUN_HEADING_ANGLE=-20
; Ambient floor so a night session still reads at ground level in vanilla AC.
; (Vanilla AC cannot do dynamic track lamps — install CSP for real floodlights;
; extension/ext_config.ini in this package already defines them.)
AMBIENT_MIN=0.12
AMBIENT_MAX=0.85
`;
}

/**
 * CSP light sources, one spot per floodlight mast, aimed down and inward at the
 * track. CONDITION=NIGHT so they only burn after dark (and don't wash out a day
 * session or cost frames in it).
 */
export function genExtConfig(masts: LightMast[]): string {
  const head = `; AC BAPTOU — night lighting for this circuit.
; Requires Custom Shaders Patch (CSP). Vanilla AC has no dynamic track lights,
; so without CSP a night session stays dark and this file is simply ignored.
; Install CSP from Content Manager (Settings -> Custom Shaders Patch).

[LIGHTING]
CAST_SHADOWS_FROM_LIGHTS=1
`;
  const blocks = masts.map((m, i) => {
    // aim from the lamp head down toward its target point on the track
    const dx = m.aim[0] - m.head[0];
    const dy = m.aim[1] - m.head[1];
    const dz = m.aim[2] - m.head[2];
    const len = Math.hypot(dx, dy, dz) || 1;
    const f = (n: number) => n.toFixed(3);
    return `[LIGHT_${i}]
ACTIVE=1
DESCRIPTION=Floodlight mast ${i + 1}
POSITION=${f(m.head[0])}, ${f(m.head[2])}, ${f(-m.head[1])}
DIRECTION=${f(dx / len)}, ${f(dz / len)}, ${f(-dy / len)}
COLOR=1.0, 0.96, 0.88, ${m.pit ? 2.2 : 3.0}
RANGE=${m.pit ? 70 : 110}
RANGE_GRADIENT_OFFSET=0.25
SPOT=${m.pit ? 110 : 96}
SPOT_SHARPNESS=0.28
FADE_AT=1400
FADE_SMOOTH=200
CONDITION=NIGHT
CONDITION_OFFSET=0.1
SPECULAR_MULT=0.7
SHADOWS=0
`;
  });
  return head + '\n' + blocks.join('\n');
}

/**
 * CSP Grass FX — procedurally generated 3D grass, drawn by the patch at runtime.
 *
 * This is how a modern AC track gets grass that stands up out of the ground
 * without shipping the geometry for it: CSP grows it on whichever MATERIALS you
 * nominate, and hides it under the ones you list as occluding, so the road and
 * kerbs stay clear. Far cheaper than cards — nothing is added to the model.
 *
 * The grass-card geometry the app can also build is listed under
 * ORIGINAL_GRASS_MATERIALS, which is CSP's own mechanism for "hide the track's
 * built-in grass, mine replaces it". So a track can carry cards as a fallback
 * for anyone without CSP and still look right for anyone who has it — you never
 * get both at once.
 */
export function genGrassFx(built: BuiltTrack): string {
  const present = new Set(built.meshes.map((m) => m.name.replace(/_\d+$/, '')));
  if (!present.has('1GRASS')) return '';

  // Everything a car drives on must suppress grass, or it grows through the
  // racing surface. Only list what this track actually contains.
  const occluders = ['1ROAD', '1PIT', '1KERB', '1KERBHI', '1CONCRETE', '1TARMAC', '1SAND', '1DIRT',
    'ROAD_LINE', 'PIT_LINE', '1WALL']
    .filter((n) => present.has(n))
    .map((n) => `mat_${n}`);
  const cards = present.has('DECOR_GRASSTUFT') ? 'mat_DECOR_GRASSTUFT' : '';

  return `[GRASS_FX]
; Grass grows on the grass material and is suppressed on everything drivable.
GRASS_MATERIALS = mat_1GRASS
OCCLUDING_MATERIALS = ${occluders.join(', ')}
; Hide the app's own grass cards when CSP is doing the grass, so a track that
; ships both never renders two layers of it.
ORIGINAL_GRASS_MATERIALS = ${cards}
; The grass material is grass by definition here — it was generated as such — so
; spawn across all of it rather than sampling the texture for green pixels.
MASK_MAIN_THRESHOLD = -1
MASK_RED_THRESHOLD = -1
MASK_MIN_LUMINANCE = 0
MASK_MAX_LUMINANCE = 1
`;
}
