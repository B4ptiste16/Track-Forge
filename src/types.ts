// Core data model for AC Track Forge.
// This is ALSO the save/load project format (serialized to JSON verbatim).

export type Segment =
  | { id: string; kind: 'straight'; length: number } // metres
  | { id: string; kind: 'corner'; radius: number; angle: number; dir: 'left' | 'right' }; // m, degrees

export interface ElevationPoint {
  dist: number; // distance along centerline (m)
  height: number; // height (m)
}

export type KerbType =
  | 'none'
  | 'flat' // low flat painted red/white kerb
  | 'serrated' // ramped saw-tooth rumble kerb
  | 'ripple' // continuous rounded rumble ridges
  | 'sausage' // raised rounded yellow "sausage" bump
  | 'tall' // taller aggressive yellow sausage
  | 'combo'; // flat red/white kerb + raised yellow sausage (the F1 look)

export interface CornerConfig {
  cornerIndex: number; // 0-based index among corner segments, in lap order
  entry: KerbType;
  apex: KerbType;
  exit: KerbType;
  escape?: boolean; // paved escape road on the outside of this corner
  kerbWidth?: number; // legacy single width (fallback for the per-part widths)
  entryW?: number; // m — entry kerb cross-section width
  apexW?: number; // m — apex kerb cross-section width
  exitW?: number; // m — exit kerb cross-section width
  entryLen?: number; // m of entry kerb before the corner (default 25)
  exitLen?: number; // m of exit kerb after the corner (default 30)
  apexLen?: number; // m of apex kerb, centered mid-corner, fully free (default 60% of arc)
  insideSurface?: 'grass' | 'gravel' | 'concrete'; // infield fill inside this corner
}

// Legacy per-segment runoff (old projects) — migrated to Trackside on load.
export type RunoffType = 'grass' | 'gravel' | 'concrete' | 'wall';
export interface SectionSide {
  type: RunoffType;
  dist: number;
  wall: boolean;
}
export interface SectionRunoff {
  left: SectionSide;
  right: SectionSide;
}

// ---------------------------------------------------------------------------
// Trackside: one continuous strip along each side of the whole lap, plus
// distance-range zones that override it (wider, different texture, wall pushed
// further out...). 'gravel_spaced' = 0.5 m of grass between track and gravel.
// ---------------------------------------------------------------------------
export type StripTexture = 'grass' | 'gravel' | 'gravel_spaced' | 'concrete';
export interface StripCfg {
  texture: StripTexture;
  width: number; // strip width from the track edge (m)
  wall: boolean; // barrier at the outer boundary
  wallDist?: number; // wall distance from the track edge (defaults to width)
}
export interface TracksideZone extends StripCfg {
  id: string;
  side: 'left' | 'right' | 'both';
  from: number; // m along the lap
  to: number;
}
export interface Trackside {
  left: StripCfg;
  right: StripCfg;
  zones: TracksideZone[];
}

// A placeable decorative building (visual only in AC).
export interface Building {
  id: string;
  x: number;
  y: number; // native world XY
  w: number; // length (m), along rot
  d: number; // depth (m)
  h: number; // height (m)
  rot: number; // degrees, CCW
}

// An alternate track layout: everything shape-related, saved under a name.
export interface SavedLayout {
  name: string;
  segments: Segment[];
  corners: CornerConfig[];
  elevation: ElevationPoint[];
  startFinishDist: number;
  trackside: Trackside;
  manualWalls: ManualWall[];
  wallGaps: WallGap[];
}

export type Theme = 'tarmac_day' | 'tarmac_dusk' | 'desert' | 'france';
export type Direction = 'cw' | 'ccw';

export interface PitConfig {
  enabled: boolean;
  side: 'left' | 'right'; // which side of the main road the pit lane sits on
  width: number; // pit lane width (m)
  entry: number; // distance along the lap where the pit lane begins (m)
  exit: number; // distance along the lap where the pit lane ends (m)
  limitFrom: number; // distance where the pit speed limit starts (m)
  limitTo: number; // distance where the pit speed limit ends (m)
  paddock?: boolean; // paved paddock beside the lane; pit boxes sit on it (track-day spawns)
  structures?: boolean; // pit wall vs track + garage building + painted box lines
}

export type WallStyle = 'solid' | 'armco' | 'tecpro' | 'blocks';
export interface WallConfig {
  enabled: boolean; // master switch for all barriers
  height: number; // wall height (m)
  style: WallStyle; // concrete / metal guardrail / TecPro / tyre-poly blocks
}

export interface BridgeConfig {
  auto: boolean; // auto-raise one pass where the track crosses itself
  incline: number; // ramp slope (rise/run), e.g. 0.05 = 5% — the "aggressiveness"
  clearance: number; // vertical clearance at the overpass (m)
}

// A hand-drawn barrier: a polyline of world XY points (built as a 1WALL strip).
export interface ManualWall {
  id: string;
  points: [number, number][];
}

// A stretch of the auto-generated barrier to remove, by distance along the lap.
export interface WallGap {
  from: number;
  to: number;
}

export interface TrackProject {
  meta: {
    name: string;
    author: string;
    country: string;
    theme: Theme;
    direction: Direction;
  };
  road: {
    width: number; // default 12
    defaultKerb: KerbType;
  };
  segments: Segment[];
  elevation: ElevationPoint[];
  corners: CornerConfig[]; // one per corner segment
  startFinishDist: number; // position of S/F line along centerline (m)
  grid: {
    pits: number; // pit box count
    starts: number; // grid slot count
  };
  pit: PitConfig;
  walls: WallConfig;
  bridge: BridgeConfig;
  trackside: Trackside; // continuous side strips + zone overrides
  buildings: Building[]; // placeable decorative buildings
  layouts?: SavedLayout[]; // saved alternate layouts of this track
  runoffDefault?: SectionSide; // LEGACY (pre-trackside projects; migrated on load)
  runoff?: SectionRunoff[]; // LEGACY
  autoClipRunoff: boolean; // shrink runoff so it never overlaps nearby track
  manualWalls: ManualWall[]; // hand-drawn barriers
  wallGaps: WallGap[]; // stretches where the auto barrier is removed
}
