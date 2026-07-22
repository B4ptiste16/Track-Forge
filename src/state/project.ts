import type {
  TrackProject, KerbType, Theme, Segment, CornerConfig, SectionSide, SectionRunoff,
  Trackside, StripCfg, TracksideZone, SavedLayout,
} from '../types';
import { countCorners, buildCenterline } from '../geometry';

let idCounter = 0;
export function newSegId(): string {
  return `seg_${Date.now().toString(36)}_${idCounter++}`;
}

export interface Palette {
  road: string;
  grass: string;
  kerb: string;
  kerbHi: string; // raised yellow sausage part
  wall: string;
  pit: string;
  sand: string;
  concrete: string;
  background: string;
}

export const THEME_PALETTES: Record<Theme, Palette> = {
  tarmac_day: { road: '#3a3a3e', grass: '#4f7a3a', kerb: '#c43a3a', kerbHi: '#e8b200', wall: '#7d7f86', pit: '#46464c', sand: '#b9a06a', concrete: '#8f9095', background: '#afc7e0' },
  tarmac_dusk: { road: '#2e2e36', grass: '#3f5f36', kerb: '#d05a2a', kerbHi: '#d99a10', wall: '#5c5e66', pit: '#3a3a44', sand: '#8f7a4e', concrete: '#6f7076', background: '#6b5a78' },
  desert: { road: '#4a4540', grass: '#c2a868', kerb: '#c0392b', kerbHi: '#e0b020', wall: '#9a8f78', pit: '#55504a', sand: '#cdb277', concrete: '#b8a98f', background: '#e9c98f' },
  france: { road: '#3a3a3e', grass: '#4f7a3a', kerb: '#0055A4', kerbHi: '#e8b200', wall: '#7d7f86', pit: '#46464c', sand: '#b9a06a', concrete: '#8f9095', background: '#bcd2ea' },
};

// Colour for a baked mesh by its AC surface name.
export function meshColor(name: string, pal: Palette): string {
  if (name === '1ROAD') return pal.road;
  if (name === '1KERBHI') return pal.kerbHi;
  if (name === '1KERB') return pal.kerb;
  if (name === '1GRASS') return pal.grass;
  if (name === '1WALL') return pal.wall;
  if (name === '1PIT') return pal.pit;
  if (name === '1SAND') return pal.sand;
  if (name === '1CONCRETE') return pal.concrete;
  if (name === '1TARMAC') return '#4a4c52'; // paved run-off: lighter than the racing surface
  if (name === '1DIRT') return '#7a5d40';
  if (name === 'ROAD_LINE') return '#eef0f2';
  if (name === 'PIT_LINE') return '#f0f1f3';
  if (name === 'DECOR_BUILDING') return '#b9b3a8';
  if (name === 'DECOR_BLDGLASS') return '#7d95a8';
  if (name === 'DECOR_BLDBRICK') return '#9a6a52';
  if (name === 'DECOR_BLDHANGAR') return '#aab0b6';
  if (name === 'DECOR_PITBLDG') return '#8e8b84';
  if (name === 'DECOR_GARAGE') return '#23252a';
  if (name === '1WALLPOLY') return '#e8d24a';
  if (name === 'DECOR_BOLLARD') return '#ff7a1a';
  if (name === 'DECOR_POLE') return '#9ea3aa';
  if (name === 'DECOR_FLAG') return '#0055A4';
  if (name === 'DECOR_STAND') return '#5f646b';
  if (name === 'DECOR_FRAME') return '#7c8087';
  if (name === 'DECOR_ARCH') return '#f2f2f2';
  if (name === 'DECOR_MARKER') return '#f2f2f2';
  if (name === 'DECOR_GANTRY') return '#b9bcc2';
  if (name === 'DECOR_LIGHTS') return '#111318';
  return '#808080';
}

// Preview colour of the 1WALL barrier per wall style.
export const WALL_STYLE_COLORS: Record<string, string> = {
  tecpro: '#c8322e',
  blocks: '#33363b',
  armco: '#a7adb5',
  hay: '#c9a94e',
};

// A small closed oval — a working starting point that already passes closure.
// straight(200) + 180° left + straight(200) + 180° left  => returns to origin.
export function defaultProject(): TrackProject {
  const R = 40;
  const L = 200;
  const segments: Segment[] = [
    { id: newSegId(), kind: 'straight', length: L },
    { id: newSegId(), kind: 'corner', radius: R, angle: 180, dir: 'left' },
    { id: newSegId(), kind: 'straight', length: L },
    { id: newSegId(), kind: 'corner', radius: R, angle: 180, dir: 'left' },
  ];
  return {
    meta: {
      name: 'My Circuit',
      author: 'AC Track Forge',
      country: 'Italy',
      theme: 'tarmac_day',
      direction: 'ccw',
    },
    road: { width: 12, defaultKerb: 'flat' },
    segments,
    elevation: [],
    corners: syncCorners(segments, [], 'flat'),
    startFinishDist: 100,
    grid: { pits: 2, starts: 2 },
    pit: { enabled: true, side: 'right', width: 8, entry: 0, exit: 95, limitFrom: 0, limitTo: 100, paddock: true, structures: true },
    walls: { enabled: true, height: 1.2, style: 'solid' },
    bridge: { auto: true, incline: 0.05, clearance: 7 },
    trackside: defaultTrackside(),
    buildings: [],
    autoClipRunoff: true,
    manualWalls: [],
    wallGaps: [],
  };
}

export function defaultTrackside(): Trackside {
  const strip = (): StripCfg => ({ texture: 'grass', width: 14, wall: true });
  return { left: strip(), right: strip(), zones: [] };
}

let zoneCounter = 0;
export function newZoneId(): string {
  return `zone_${Date.now().toString(36)}_${zoneCounter++}`;
}

// Convert a legacy per-segment runoff config into trackside default + zones.
function migrateRunoff(p: TrackProject): Trackside {
  const def = p.runoffDefault ?? { type: 'grass', dist: 14, wall: true };
  const toStrip = (s: SectionSide): StripCfg => ({
    texture: s.type === 'wall' ? 'grass' : s.type === 'gravel' ? 'gravel' : (s.type as StripCfg['texture']),
    width: s.type === 'wall' ? Math.max(2, s.dist) : s.dist,
    wall: s.type === 'wall' ? true : s.wall,
    wallDist: s.type === 'wall' ? s.dist : undefined,
  });
  const ts: Trackside = { left: toStrip(def), right: toStrip(def), zones: [] };
  const runoff = p.runoff;
  if (runoff?.length) {
    try {
      const { spans } = buildCenterline(p.segments);
      const same = (a: SectionSide, b: SectionSide) =>
        a.type === b.type && a.dist === b.dist && a.wall === b.wall;
      for (const span of spans) {
        const sec = runoff[span.segIndex];
        if (!sec) continue;
        for (const side of ['left', 'right'] as const) {
          if (!same(sec[side], def)) {
            ts.zones.push({
              id: newZoneId(), side, from: Math.round(span.startDist), to: Math.round(span.endDist),
              ...toStrip(sec[side]),
            });
          }
        }
      }
    } catch {
      // keep just the defaults if the old geometry can't be rebuilt
    }
  }
  return ts;
}

// Keep one SectionRunoff per segment. Preserve existing by index; fill new ones
// with a copy of the default (both sides).
export function syncRunoff(
  segments: Segment[],
  existing: SectionRunoff[],
  def: SectionSide,
): SectionRunoff[] {
  return segments.map((_, i) => existing[i] ?? { left: { ...def }, right: { ...def } });
}

// Fill in any config sections missing from an older/partial loaded project.
export function withDefaults(p: TrackProject): TrackProject {
  const d = defaultProject();
  const walls = p.walls ? { ...d.walls, ...p.walls } : d.walls;
  // Migrate an older pit config (which had `length`) to entry/exit/limit.
  let pit = p.pit ?? d.pit;
  if (pit && (pit as { entry?: number }).entry === undefined) {
    const sf = p.startFinishDist ?? 100;
    const oldLen = (pit as unknown as { length?: number }).length ?? 120;
    pit = {
      enabled: pit.enabled, side: pit.side, width: pit.width,
      entry: Math.max(0, sf - oldLen), exit: sf,
      limitFrom: Math.max(0, sf - oldLen), limitTo: sf,
    };
  }
  if (pit && pit.paddock === undefined) pit = { ...pit, paddock: true };
  if (pit && pit.structures === undefined) pit = { ...pit, structures: true };
  // Migrate legacy per-segment runoff to the trackside strips + zones.
  const trackside = p.trackside ?? migrateRunoff(p);
  return {
    ...p,
    pit,
    walls,
    bridge: p.bridge ?? d.bridge,
    trackside,
    buildings: p.buildings ?? [],
    layouts: p.layouts ?? [],
    autoClipRunoff: p.autoClipRunoff ?? d.autoClipRunoff,
    manualWalls: p.manualWalls ?? [],
    wallGaps: p.wallGaps ?? [],
  };
}

// Snapshot / restore an alternate layout (everything shape-related).
export function snapshotLayout(p: TrackProject, name: string): SavedLayout {
  return JSON.parse(
    JSON.stringify({
      name,
      segments: p.segments,
      corners: p.corners,
      elevation: p.elevation,
      startFinishDist: p.startFinishDist,
      trackside: p.trackside,
      manualWalls: p.manualWalls,
      wallGaps: p.wallGaps,
    }),
  ) as SavedLayout;
}

export function applyLayout(p: TrackProject, l: SavedLayout): TrackProject {
  const copy = JSON.parse(JSON.stringify(l)) as SavedLayout;
  return {
    ...p,
    segments: copy.segments,
    corners: copy.corners,
    elevation: copy.elevation,
    startFinishDist: copy.startFinishDist,
    trackside: copy.trackside,
    manualWalls: copy.manualWalls,
    wallGaps: copy.wallGaps,
  };
}

// A single zone's ids need to be unique when duplicated.
export function cloneZone(z: TracksideZone): TracksideZone {
  return { ...z, id: newZoneId() };
}

// Keep one CornerConfig per corner segment. Preserve existing entries by index;
// fill new ones with the default kerb on all three parts.
export function syncCorners(
  segments: Segment[],
  existing: CornerConfig[],
  defaultKerb: KerbType,
): CornerConfig[] {
  const n = countCorners(segments);
  const out: CornerConfig[] = [];
  for (let i = 0; i < n; i++) {
    const prev = existing.find((c) => c.cornerIndex === i);
    if (prev) {
      // migrate the legacy boolean escape flag to escapeType (once)
      if (prev.escapeType === undefined && prev.escape) prev.escapeType = 'sausage';
      out.push(prev);
    } else {
      out.push({ cornerIndex: i, entry: defaultKerb, apex: defaultKerb, exit: defaultKerb });
    }
  }
  return out;
}

// All corners set to a single kerb type (used when "customize" is off), while
// preserving each corner's escape flag.
export function uniformCorners(
  segments: Segment[],
  kerb: KerbType,
  existing: CornerConfig[] = [],
): CornerConfig[] {
  const n = countCorners(segments);
  const out: CornerConfig[] = [];
  for (let i = 0; i < n; i++) {
    const prev = existing.find((c) => c.cornerIndex === i);
    // keep every per-corner tweak (escape, widths, lengths, inside surface);
    // only the kerb TYPES become uniform.
    out.push({ ...(prev ?? {}), cornerIndex: i, entry: kerb, apex: kerb, exit: kerb });
  }
  return out;
}

// Smallest corner radius a road of this width can physically turn without the
// inside edge folding over the arc centre. Kept in sync with build.ts.
export function minCornerRadius(width: number): number {
  return width / 2 + 3;
}

// Lowercase, no spaces / special chars — required for AC folder + file names.
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/_+/g, '_') || 'track'
  );
}
