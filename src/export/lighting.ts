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
