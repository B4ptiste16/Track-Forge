// Core data model for AC Track Forge.
// This is ALSO the save/load project format (serialized to JSON verbatim).

export type Segment =
  | { id: string; kind: 'straight'; length: number } // metres
  | { id: string; kind: 'corner'; radius: number; angle: number; dir: 'left' | 'right' }; // m, degrees

export interface ElevationPoint {
  dist: number; // distance along centerline (m)
  height: number; // height (m)
}

export type KerbType = 'none' | 'flat' | 'sausage' | 'serrated';

export interface CornerConfig {
  cornerIndex: number; // 0-based index among corner segments, in lap order
  entry: KerbType;
  apex: KerbType;
  exit: KerbType;
  escape?: boolean; // paved escape road on the outside of this corner
}

// Per-section runoff treatment for one side of the road.
export type RunoffType = 'grass' | 'gravel' | 'concrete' | 'wall';
export interface SectionSide {
  type: RunoffType;
  dist: number; // runoff width (m); for 'wall', distance from track to the wall
  wall: boolean; // place a barrier at the outer edge
}
export interface SectionRunoff {
  left: SectionSide;
  right: SectionSide;
}

export type Theme = 'tarmac_day' | 'tarmac_dusk' | 'desert';
export type Direction = 'cw' | 'ccw';

export interface PitConfig {
  enabled: boolean;
  side: 'left' | 'right'; // which side of the main road the pit lane sits on
  width: number; // pit lane width (m)
  entry: number; // distance along the lap where the pit lane begins (m)
  exit: number; // distance along the lap where the pit lane ends (m)
  limitFrom: number; // distance where the pit speed limit starts (m)
  limitTo: number; // distance where the pit speed limit ends (m)
}

export interface WallConfig {
  enabled: boolean; // master switch for all barriers
  height: number; // wall height (m)
  style: 'solid' | 'blocks'; // continuous wall vs polystyrene/tyre blocks
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
  runoffDefault: SectionSide; // applied to sections without an override
  runoff: SectionRunoff[]; // one per segment (synced)
  autoClipRunoff: boolean; // shrink runoff so it never overlaps nearby track
  manualWalls: ManualWall[]; // hand-drawn barriers
  wallGaps: WallGap[]; // stretches where the auto barrier is removed
}
