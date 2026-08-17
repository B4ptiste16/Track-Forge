// CIRCUIT PRESETS — pick a circuit *character* instead of hand-setting every
// kerb, run-off, barrier and facility.
//
// A preset is a complete FURNISHING of a track: kerb styles, what's beside the
// track (grass / gravel / paved run-off) and how wide, which barrier type,
// escape roads, the pit complex, scenery density, surface relief and the colour
// theme. It deliberately does NOT touch the SHAPE (segments, elevation, S/F,
// pit entry/exit distances) — applying a preset re-dresses the circuit you
// drew, it never redraws it.
//
// Everything a preset sets stays editable afterwards: it writes ordinary
// project values, so the existing panels keep working as manual overrides.
import type {
  CornerConfig, DecorConfig, EscapeType, KerbType, StripCfg, SurfaceDetail,
  Theme, TrackProject, WallStyle,
} from '../types';

export interface CircuitPreset {
  id: string;
  name: string;
  blurb: string; // one line shown in the picker
  theme: Theme;
  roadWidth: number; // m
  kerb: { entry: KerbType; apex: KerbType; exit: KerbType; width: number };
  /** Run-off strip applied to BOTH sides (still overridable per-zone after). */
  strip: StripCfg;
  /** Escape road on corners (applied to the tighter/slower corners). */
  escape: EscapeType;
  insideSurface: 'grass' | 'gravel' | 'concrete';
  walls: { enabled: boolean; height: number; style: WallStyle };
  pit: { paddock: boolean; structures: boolean };
  decor: DecorConfig;
  surfaceDetail: SurfaceDetail;
}

export const CIRCUIT_PRESETS: CircuitPreset[] = [
  {
    id: 'modern_gp',
    name: 'Modern Grand Prix',
    blurb: 'Wide paved run-off, combo kerbs, TecPro, big grandstands — current F1 look.',
    theme: 'tarmac_day',
    roadWidth: 14,
    kerb: { entry: 'combo', apex: 'combo', exit: 'combo', width: 1.2 },
    strip: { texture: 'tarmac', width: 18, wall: true, wallDist: 24 },
    escape: 'tarmac',
    insideSurface: 'grass',
    walls: { enabled: true, height: 1.3, style: 'tecpro' },
    pit: { paddock: true, structures: true },
    decor: { trees: 0.25, grandstands: true, lightSpacing: 85 },
    surfaceDetail: { grassHeight: 0.05, gravelDepth: 0.07 },
  },
  {
    id: 'classic',
    name: 'Classic Circuit',
    blurb: 'Grass to the edge, flat kerbs, Armco and hay bales, treelined — 60s/70s.',
    theme: 'tarmac_day',
    roadWidth: 10,
    kerb: { entry: 'flat', apex: 'flat', exit: 'flat', width: 0.8 },
    strip: { texture: 'grass', width: 10, wall: true, wallDist: 11 },
    escape: 'none',
    insideSurface: 'grass',
    walls: { enabled: true, height: 1.0, style: 'armco' },
    pit: { paddock: false, structures: true },
    decor: { trees: 0.85, grandstands: true, lightSpacing: 0 },
    surfaceDetail: { grassHeight: 0.07, gravelDepth: 0.05 },
  },
  {
    id: 'national',
    name: 'National / Club',
    blurb: 'Gravel traps at the corners, serrated kerbs, Armco — permanent club circuit.',
    theme: 'tarmac_day',
    roadWidth: 12,
    kerb: { entry: 'serrated', apex: 'serrated', exit: 'flat', width: 1.0 },
    strip: { texture: 'gravel_spaced', width: 13, wall: true, wallDist: 16 },
    escape: 'gravel',
    insideSurface: 'grass',
    walls: { enabled: true, height: 1.1, style: 'armco' },
    pit: { paddock: true, structures: true },
    decor: { trees: 0.55, grandstands: true, lightSpacing: 130 },
    surfaceDetail: { grassHeight: 0.06, gravelDepth: 0.1 },
  },
  {
    id: 'street',
    name: 'Street Circuit',
    blurb: 'No run-off — concrete walls right at the edge, painted kerbs, city blocks.',
    theme: 'tarmac_day',
    roadWidth: 11,
    kerb: { entry: 'painted', apex: 'painted', exit: 'painted', width: 0.6 },
    strip: { texture: 'concrete', width: 2.5, wall: true, wallDist: 2.5 },
    escape: 'none',
    insideSurface: 'concrete',
    walls: { enabled: true, height: 1.6, style: 'solid' },
    pit: { paddock: false, structures: true },
    decor: { trees: 0.15, grandstands: true, lightSpacing: 60 },
    surfaceDetail: { grassHeight: 0.0, gravelDepth: 0.0 },
  },
  {
    id: 'desert_test',
    name: 'Desert Test Track',
    blurb: 'Sand run-off, low kerbs, minimal scenery — proving-ground feel.',
    theme: 'desert',
    roadWidth: 13,
    kerb: { entry: 'flat', apex: 'flat', exit: 'none', width: 0.9 },
    strip: { texture: 'gravel', width: 22, wall: false, wallDist: 30 },
    escape: 'none',
    insideSurface: 'gravel',
    walls: { enabled: false, height: 1.0, style: 'solid' },
    pit: { paddock: true, structures: false },
    decor: { trees: 0.0, grandstands: false, lightSpacing: 0 },
    surfaceDetail: { grassHeight: 0.0, gravelDepth: 0.06 },
  },
  {
    id: 'twilight_gp',
    name: 'Twilight GP',
    blurb: 'Modern GP furnishing under dusk light — floodlit night-race look.',
    theme: 'tarmac_dusk',
    roadWidth: 14,
    kerb: { entry: 'combo', apex: 'combo', exit: 'combo', width: 1.2 },
    strip: { texture: 'tarmac', width: 16, wall: true, wallDist: 21 },
    escape: 'tarmac',
    insideSurface: 'grass',
    walls: { enabled: true, height: 1.4, style: 'tecpro' },
    pit: { paddock: true, structures: true },
    decor: { trees: 0.2, grandstands: true, lightSpacing: 55 },
    surfaceDetail: { grassHeight: 0.05, gravelDepth: 0.07 },
  },
];

export function findPreset(id: string): CircuitPreset | undefined {
  return CIRCUIT_PRESETS.find((p) => p.id === id);
}

// NOTE: presets no longer place escape roads. The old rule ("every corner under
// a 90 m radius") fired on nearly every corner of a real circuit — recreating
// Monza produced escape roads sprayed down the whole lap. Escape roads are a
// PLACED feature now: add them per corner in the Kerbs panel, or from an
// instruction sheet with `ESCAPE <corner> <type>`. A preset furnishes surfaces,
// barriers and scenery; it does not guess where a car will run off.

/**
 * Apply a preset's furnishing to a project. Returns a NEW project; the track
 * SHAPE (segments/elevation/startFinish/pit distances) is preserved exactly.
 * `keepManual` keeps things the user hand-placed (buildings, manual walls,
 * wall gaps, trackside zones, custom escape shapes) so applying a preset never
 * throws away bespoke work.
 */
export function applyPreset(p: TrackProject, preset: CircuitPreset, keepManual = true): TrackProject {
  const corners: CornerConfig[] = p.corners.map((c) => ({
    ...c,
    entry: preset.kerb.entry,
    apex: preset.kerb.apex,
    exit: preset.kerb.exit,
    entryW: preset.kerb.width,
    apexW: preset.kerb.width,
    exitW: preset.kerb.width,
    insideSurface: preset.insideSurface,
    // keep whatever escape road the user placed on this corner (see note above)
    escapeType: c.escapeType,
    // a hand-dragged escape shape is bespoke work — keep it
    escapeNodes: keepManual ? c.escapeNodes : undefined,
  }));

  return {
    ...p,
    meta: { ...p.meta, theme: preset.theme, preset: preset.id },
    road: { ...p.road, width: preset.roadWidth, defaultKerb: preset.kerb.apex },
    corners,
    trackside: {
      left: { ...preset.strip },
      right: { ...preset.strip },
      zones: keepManual ? p.trackside.zones : [],
    },
    walls: { ...preset.walls },
    pit: { ...p.pit, paddock: preset.pit.paddock, structures: preset.pit.structures },
    decor: { ...preset.decor },
    surfaceDetail: { ...preset.surfaceDetail },
    buildings: keepManual ? p.buildings : [],
    manualWalls: keepManual ? p.manualWalls : [],
    wallGaps: keepManual ? p.wallGaps : [],
  };
}
