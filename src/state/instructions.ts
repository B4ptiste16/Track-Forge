// INSTRUCTION SHEET — build a whole circuit from a list of written commands.
//
// The point of this file is that a track can be described in plain text, which
// means an AI (or a person) can WRITE a circuit and the app builds it exactly.
// Every command maps onto the same project fields the manual panels edit, so a
// sheet and hand-editing are interchangeable: build from a sheet, then keep
// tweaking by hand, or vice versa.
//
// Format: one command per line, executed strictly in order. `#` starts a
// comment. Blank lines are ignored. Command names are case-insensitive.
// A bad line never aborts the build — it is reported and the rest still runs,
// so one typo in a 200-line sheet doesn't cost you the whole circuit.
import type {
  Building, BuildingKind, Direction, EscapeType, KerbType, Segment, StripCfg,
  StripTexture, Theme, TrackProject, WallStyle,
} from '../types';
import { newSegId, newZoneId, syncCorners } from './project';
import { buildCenterline } from '../geometry';
import { CIRCUIT_PRESETS, applyPreset } from './presets';

export interface InstructionResult {
  project: TrackProject;
  log: string[];      // one line per executed command
  errors: string[];   // "line 12: ..." — shown but never fatal
  applied: number;    // how many commands actually ran
}

const KERBS: KerbType[] = ['none', 'painted', 'flat', 'serrated', 'ripple', 'sausage', 'tall', 'combo'];
const TEXTURES: StripTexture[] = ['grass', 'gravel', 'gravel_spaced', 'concrete', 'tarmac', 'dirt'];
const ESCAPES: EscapeType[] = ['none', 'tarmac', 'sausage', 'slalom', 'gravel'];
const WALL_STYLES: WallStyle[] = ['solid', 'armco', 'tecpro', 'blocks', 'hay'];
const THEMES: Theme[] = ['tarmac_day', 'tarmac_dusk', 'desert', 'france'];
const BUILDINGS: BuildingKind[] = ['offices', 'glass', 'brick', 'hangar'];

const num = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  const v = Number(s.replace(',', '.'));
  return Number.isFinite(v) ? v : null;
};
const onOff = (s: string | undefined): boolean | null => {
  const t = (s || '').toLowerCase();
  if (['on', 'yes', 'true', '1', 'enabled'].includes(t)) return true;
  if (['off', 'no', 'false', '0', 'disabled'].includes(t)) return false;
  return null;
};
const oneOf = <T extends string>(s: string | undefined, list: T[]): T | null => {
  const t = (s || '').toLowerCase() as T;
  return list.includes(t) ? t : null;
};

/**
 * Run an instruction sheet against a starting project. Returns a NEW project —
 * the input is never mutated, so a failed/odd sheet can be discarded cleanly.
 */
export function applyInstructions(base: TrackProject, text: string): InstructionResult {
  let p: TrackProject = JSON.parse(JSON.stringify(base));
  const log: string[] = [];
  const errors: string[] = [];
  let applied = 0;
  // Segments are collected as the sheet runs; corner configs are re-synced at
  // the end so every corner the sheet created has a config to be styled by.
  let segs: Segment[] = p.segments.slice();
  let clearedShape = false;

  const lines = text.split(/\r?\n/);
  for (let ln = 0; ln < lines.length; ln++) {
    const raw = lines[ln];
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const parts = line.split(/[\s,]+/).filter(Boolean);
    const cmd = parts[0].toUpperCase();
    const a = parts.slice(1);
    const err = (m: string) => errors.push(`line ${ln + 1}: ${m}  ->  "${line}"`);
    const ok = (m: string) => { log.push(m); applied++; };
    // Per-corner commands address corners the sheet itself just created, so the
    // corner list has to be brought up to date with the segments added SO FAR —
    // otherwise an index past the starting project's corner count silently did
    // nothing. Returns false (and reports) when the index doesn't exist.
    const corner = (i: number | null): boolean => {
      p.corners = syncCorners(segs, p.corners, p.road.defaultKerb);
      if (i === null || !Number.isInteger(i) || i < 0 || i >= p.corners.length) {
        err(`corner ${i ?? '?'} does not exist — the sheet has ${p.corners.length} corner(s), numbered from 0`);
        return false;
      }
      return true;
    };

    switch (cmd) {
      // ---- identity -------------------------------------------------------
      case 'NAME': {
        const v = a.join(' ');
        if (!v) { err('NAME needs a value'); break; }
        p.meta = { ...p.meta, name: v }; ok(`name = ${v}`); break;
      }
      case 'AUTHOR': {
        const v = a.join(' ');
        if (!v) { err('AUTHOR needs a value'); break; }
        p.meta = { ...p.meta, author: v }; ok(`author = ${v}`); break;
      }
      case 'COUNTRY': {
        const v = a.join(' ');
        if (!v) { err('COUNTRY needs a value'); break; }
        p.meta = { ...p.meta, country: v }; ok(`country = ${v}`); break;
      }
      case 'THEME': {
        const v = oneOf(a[0], THEMES);
        if (!v) { err(`THEME must be one of ${THEMES.join('|')}`); break; }
        p.meta = { ...p.meta, theme: v }; ok(`theme = ${v}`); break;
      }
      case 'DIRECTION': {
        const v = oneOf(a[0], ['cw', 'ccw'] as Direction[]);
        if (!v) { err('DIRECTION must be cw or ccw'); break; }
        p.meta = { ...p.meta, direction: v }; ok(`direction = ${v}`); break;
      }

      // ---- preset: furnish everything at once ------------------------------
      case 'PRESET': {
        const id = (a[0] || '').toLowerCase();
        const preset = CIRCUIT_PRESETS.find((x) => x.id === id);
        if (!preset) {
          err(`unknown preset. Options: ${CIRCUIT_PRESETS.map((x) => x.id).join(', ')}`);
          break;
        }
        // keepManual=false: a sheet describes the whole circuit, so the preset
        // furnishes cleanly rather than merging with whatever was there.
        p = applyPreset({ ...p, segments: segs }, preset, false);
        segs = p.segments.slice();
        ok(`preset = ${preset.name}`);
        break;
      }

      // ---- road -----------------------------------------------------------
      case 'WIDTH': {
        const v = num(a[0]);
        if (v === null || v < 4 || v > 40) { err('WIDTH needs metres (4..40)'); break; }
        p.road = { ...p.road, width: v }; ok(`road width = ${v} m`); break;
      }
      case 'KERB': {
        const v = oneOf(a[0], KERBS);
        if (!v) { err(`KERB must be one of ${KERBS.join('|')}`); break; }
        p.road = { ...p.road, defaultKerb: v }; ok(`default kerb = ${v}`); break;
      }

      // ---- shape ----------------------------------------------------------
      case 'CLEAR': {
        segs = []; clearedShape = true; ok('cleared the shape'); break;
      }
      case 'STRAIGHT': {
        const v = num(a[0]);
        if (v === null || v <= 0) { err('STRAIGHT needs a length in metres'); break; }
        segs.push({ id: newSegId(), kind: 'straight', length: v });
        ok(`straight ${v} m`); break;
      }
      case 'CORNER': {
        const dir = oneOf(a[0], ['left', 'right'] as const);
        const radius = num(a[1]);
        const angle = num(a[2]);
        if (!dir || radius === null || angle === null) {
          err('CORNER needs: CORNER left|right <radius_m> <angle_deg>'); break;
        }
        if (radius < 5 || angle <= 0 || angle > 180) {
          err('CORNER radius >= 5 m and angle 1..180'); break;
        }
        segs.push({ id: newSegId(), kind: 'corner', radius, angle, dir });
        ok(`corner ${dir} R${radius} ${angle}°`); break;
      }
      case 'STARTLINE': {
        const v = num(a[0]);
        if (v === null || v < 0) { err('STARTLINE needs a distance in metres'); break; }
        p.startFinishDist = v; ok(`start/finish at ${v} m`); break;
      }
      case 'ELEVATION': {
        const d = num(a[0]), h = num(a[1]);
        if (d === null || h === null) { err('ELEVATION needs <dist_m> <height_m>'); break; }
        p.elevation = [...p.elevation.filter((e) => e.dist !== d), { dist: d, height: h }]
          .sort((x, y) => x.dist - y.dist);
        ok(`elevation ${h} m at ${d} m`); break;
      }

      // ---- per-corner detail ----------------------------------------------
      case 'CORNERKERB': {
        const i = num(a[0]);
        const entry = oneOf(a[1], KERBS), apex = oneOf(a[2], KERBS), exit = oneOf(a[3], KERBS);
        if (i === null || !entry || !apex || !exit) {
          err('CORNERKERB needs <corner_index> <entry> <apex> <exit> kerb types'); break;
        }
        if (!corner(i)) break;
        p.corners = p.corners.map((c) => (c.cornerIndex === i ? { ...c, entry, apex, exit } : c));
        ok(`corner ${i} kerbs ${entry}/${apex}/${exit}`); break;
      }
      case 'ESCAPE': {
        const i = num(a[0]);
        const t = oneOf(a[1], ESCAPES);
        if (i === null || !t) { err(`ESCAPE needs <corner_index> ${ESCAPES.join('|')}`); break; }
        if (!corner(i)) break;
        p.corners = p.corners.map((c) => (c.cornerIndex === i ? { ...c, escapeType: t } : c));
        ok(`corner ${i} escape = ${t}`); break;
      }
      case 'INSIDE': {
        const i = num(a[0]);
        const s = oneOf(a[1], ['grass', 'gravel', 'concrete'] as const);
        if (i === null || !s) { err('INSIDE needs <corner_index> grass|gravel|concrete'); break; }
        if (!corner(i)) break;
        p.corners = p.corners.map((c) => (c.cornerIndex === i ? { ...c, insideSurface: s } : c));
        ok(`corner ${i} inside = ${s}`); break;
      }

      // ---- trackside ------------------------------------------------------
      case 'SIDE': {
        const which = oneOf(a[0], ['left', 'right', 'both'] as const);
        const tex = oneOf(a[1], TEXTURES);
        const w = num(a[2]);
        if (!which || !tex || w === null) {
          err(`SIDE needs left|right|both <${TEXTURES.join('|')}> <width_m> [wall <dist_m>]`); break;
        }
        const wallIdx = a.findIndex((t) => t.toLowerCase() === 'wall');
        const cfg: StripCfg = {
          texture: tex, width: w,
          wall: wallIdx >= 0,
          wallDist: wallIdx >= 0 ? (num(a[wallIdx + 1]) ?? w) : undefined,
        };
        if (which === 'left' || which === 'both') p.trackside = { ...p.trackside, left: { ...cfg } };
        if (which === 'right' || which === 'both') p.trackside = { ...p.trackside, right: { ...cfg } };
        ok(`${which} side = ${tex} ${w} m${cfg.wall ? ` + wall @${cfg.wallDist} m` : ''}`); break;
      }
      case 'ZONE': {
        const which = oneOf(a[0], ['left', 'right', 'both'] as const);
        const from = num(a[1]), to = num(a[2]);
        const tex = oneOf(a[3], TEXTURES);
        const w = num(a[4]);
        if (!which || from === null || to === null || !tex || w === null) {
          err('ZONE needs left|right|both <from_m> <to_m> <texture> <width_m> [wall <dist>]'); break;
        }
        const wallIdx = a.findIndex((t) => t.toLowerCase() === 'wall');
        p.trackside = {
          ...p.trackside,
          zones: [...p.trackside.zones, {
            id: newZoneId(), side: which, from, to, texture: tex, width: w,
            wall: wallIdx >= 0, wallDist: wallIdx >= 0 ? (num(a[wallIdx + 1]) ?? w) : undefined,
          }],
        };
        ok(`zone ${which} ${from}-${to} m = ${tex} ${w} m`); break;
      }

      // ---- run-off placed BY CORNER ---------------------------------------
      // ZONE needs distances along the lap, which an AI writing a sheet has no
      // way to know — it would have to integrate every segment length first.
      // RUNOFF takes a corner number instead and works out the distance span
      // itself, which is how you actually think about it: "gravel on the
      // outside of turn 3". Defaults to the OUTSIDE of the corner, because that
      // is the side a car leaves the track on.
      case 'RUNOFF': {
        const i = num(a[0]);
        const tex = oneOf(a[1], TEXTURES);
        const w = num(a[2]);
        if (i === null || !tex || w === null) {
          err(`RUNOFF needs <corner_index> <${TEXTURES.join('|')}> <width_m> [outside|inside|both] [wall <dist_m>]`);
          break;
        }
        if (!corner(i)) break;
        const { spans } = buildCenterline(segs);
        const span = spans.find((s) => s.kind === 'corner' && s.cornerIndex === i);
        if (!span) { err(`corner ${i} has no span (is the shape built?)`); break; }
        // A car runs wide on the OUTSIDE — the opposite hand to the turn.
        const outside: 'left' | 'right' = span.dir === 'left' ? 'right' : 'left';
        const where = oneOf(a[3], ['outside', 'inside', 'both'] as const) ?? 'outside';
        const side: 'left' | 'right' | 'both' =
          where === 'both' ? 'both'
            : where === 'inside' ? (outside === 'left' ? 'right' : 'left')
              : outside;
        // Reach a little before and after the corner: the run-off a driver needs
        // starts in the braking zone and continues past the exit.
        const pad = Math.max(15, (span.endDist - span.startDist) * 0.35);
        const wallIdx = a.findIndex((t) => t.toLowerCase() === 'wall');
        p.trackside = {
          ...p.trackside,
          zones: [...p.trackside.zones, {
            id: newZoneId(), side,
            from: Math.max(0, span.startDist - pad),
            to: span.endDist + pad,
            texture: tex, width: w,
            wall: wallIdx >= 0,
            wallDist: wallIdx >= 0 ? (num(a[wallIdx + 1]) ?? w) : undefined,
          }],
        };
        ok(`corner ${i}: ${tex} ${w} m on the ${side} (${Math.round(span.startDist - pad)}-${Math.round(span.endDist + pad)} m)`);
        break;
      }

      // ---- barriers -------------------------------------------------------
      case 'WALLS': {
        const on = onOff(a[0]);
        if (on === null) { err('WALLS needs on|off [height_m] [style]'); break; }
        const h = num(a[1]);
        const st = oneOf(a[2] ?? a[1], WALL_STYLES);
        p.walls = {
          ...p.walls, enabled: on,
          height: h ?? p.walls.height,
          style: st ?? p.walls.style,
        };
        ok(`walls ${on ? 'on' : 'off'}${st ? ` (${st})` : ''}`); break;
      }

      // ---- pit ------------------------------------------------------------
      case 'PIT': {
        const on = onOff(a[0]);
        if (on === null) { err('PIT needs on|off'); break; }
        p.pit = { ...p.pit, enabled: on }; ok(`pit lane ${on ? 'on' : 'off'}`); break;
      }
      case 'PITSIDE': {
        const s = oneOf(a[0], ['left', 'right'] as const);
        if (!s) { err('PITSIDE needs left|right'); break; }
        p.pit = { ...p.pit, side: s }; ok(`pit side = ${s}`); break;
      }
      case 'PITLANE': {
        const entry = num(a[0]), exit = num(a[1]), w = num(a[2]);
        if (entry === null || exit === null) { err('PITLANE needs <entry_m> <exit_m> [width_m]'); break; }
        p.pit = {
          ...p.pit, enabled: true, entry, exit,
          width: w ?? p.pit.width,
          limitFrom: entry, limitTo: exit,
        };
        ok(`pit lane ${entry} -> ${exit} m`); break;
      }
      case 'PITBOXES': {
        const v = num(a[0]);
        if (v === null || v < 1) { err('PITBOXES needs a count'); break; }
        p.grid = { ...p.grid, pits: Math.round(v) }; ok(`pit boxes = ${Math.round(v)}`); break;
      }
      case 'GRID': {
        const v = num(a[0]);
        if (v === null || v < 1) { err('GRID needs a count'); break; }
        p.grid = { ...p.grid, starts: Math.round(v) }; ok(`grid slots = ${Math.round(v)}`); break;
      }

      // ---- scenery / surface ----------------------------------------------
      case 'TREES': {
        const v = num(a[0]);
        if (v === null || v < 0 || v > 1) { err('TREES needs 0..1'); break; }
        p.decor = { ...(p.decor ?? { trees: 0, grandstands: false }), trees: v };
        ok(`trees = ${v}`); break;
      }
      case 'GRANDSTANDS': {
        const on = onOff(a[0]);
        if (on === null) { err('GRANDSTANDS needs on|off'); break; }
        p.decor = { ...(p.decor ?? { trees: 0, grandstands: false }), grandstands: on };
        ok(`grandstands ${on ? 'on' : 'off'}`); break;
      }
      case 'LIGHTS': {
        const off = onOff(a[0]) === false;
        const v = off ? 0 : num(a[0]);
        if (v === null) { err('LIGHTS needs a spacing in metres, or off'); break; }
        p.decor = { ...(p.decor ?? { trees: 0, grandstands: false }), lightSpacing: v };
        ok(v > 0 ? `floodlight masts every ${v} m` : 'no floodlights'); break;
      }
      case 'GRASSLIP': {
        const v = num(a[0]);
        if (v === null) { err('GRASSLIP needs metres'); break; }
        p.surfaceDetail = { ...(p.surfaceDetail ?? { grassHeight: 0, gravelDepth: 0 }), grassHeight: v };
        ok(`grass lip = ${v} m`); break;
      }
      case 'GRAVELDEPTH': {
        const v = num(a[0]);
        if (v === null) { err('GRAVELDEPTH needs metres'); break; }
        p.surfaceDetail = { ...(p.surfaceDetail ?? { grassHeight: 0, gravelDepth: 0 }), gravelDepth: v };
        ok(`gravel depth = ${v} m`); break;
      }
      case 'BUILDING': {
        const kind = oneOf(a[0], BUILDINGS);
        const x = num(a[1]), y = num(a[2]), w = num(a[3]), d = num(a[4]), h = num(a[5]);
        const rot = num(a[6]) ?? 0;
        if (!kind || x === null || y === null || w === null || d === null || h === null) {
          err(`BUILDING needs <${BUILDINGS.join('|')}> <x> <y> <w> <d> <h> [rot_deg]`); break;
        }
        const b: Building = { id: `b${Date.now()}${p.buildings.length}`, kind, x, y, w, d, h, rot };
        p.buildings = [...p.buildings, b];
        ok(`building ${kind} at ${x},${y}`); break;
      }

      default:
        err(`unknown command "${cmd}"`);
    }
  }

  // Corner configs must line up with however many corners the sheet built.
  p.segments = segs;
  p.corners = syncCorners(segs, p.corners, p.road.defaultKerb);
  if (clearedShape && segs.length === 0) {
    errors.push('the sheet cleared the shape but never added any STRAIGHT/CORNER');
  }
  return { project: p, log, errors, applied };
}

// The spec handed to an AI (or read by a person) so it can write a valid sheet.
// Kept in this file, next to the parser, so the two cannot drift apart.
export const INSTRUCTION_SPEC = `AC BAPTOU — TRACK INSTRUCTION SHEET
Write one command per line. They run in order. "#" starts a comment.
Units: metres and degrees. Command names are not case-sensitive.

IDENTITY
  NAME <text>                     track name
  AUTHOR <text>
  COUNTRY <text>
  THEME tarmac_day|tarmac_dusk|desert|france
  DIRECTION cw|ccw

PRESET (furnishes kerbs, run-off, barriers, pit, scenery in one line)
  PRESET modern_gp|classic|national|street|desert_test|twilight_gp
  Put this FIRST, then override anything below it.

ROAD
  WIDTH <m>                       4..40
  KERB none|painted|flat|serrated|ripple|sausage|tall|combo

SHAPE — the lap, in order. Use CLEAR first to start from nothing.
  CLEAR
  STRAIGHT <length_m>
  CORNER left|right <radius_m> <angle_deg>     radius >= 5, angle 1..180
  STARTLINE <m>                   where the start/finish line sits
  ELEVATION <dist_m> <height_m>   repeat for as many points as you like
  For a circuit that closes, the left and right turn angles should total 360.

PER-CORNER (corner_index counts corners only, from 0, in lap order)
  CORNERKERB <i> <entry> <apex> <exit>    kerb types as above
  INSIDE <i> grass|gravel|concrete

TRACKSIDE / RUN-OFF
  SIDE left|right|both <grass|gravel|gravel_spaced|concrete|tarmac|dirt> <width_m> [wall <dist_m>]
  RUNOFF <corner_index> <texture> <width_m> [outside|inside|both] [wall <dist_m>]
      Easiest way to place run-off: it works out the corner's position for you
      and defaults to the OUTSIDE (the side a car runs wide onto).
      e.g.  RUNOFF 2 gravel 20            gravel trap outside turn 2
            RUNOFF 5 tarmac 25 wall 30    paved run-off + barrier at 30 m
  ZONE left|right|both <from_m> <to_m> <texture> <width_m> [wall <dist_m>]
      Only if you want an exact distance range along the lap.

ESCAPE ROADS — place them ONLY where a car would really overshoot: the end of a
long straight, or a slow chicane. Do not put one on every corner.
  ESCAPE <corner_index> none|tarmac|sausage|slalom|gravel

BARRIERS
  WALLS on|off [height_m] [solid|armco|tecpro|blocks|hay]

PIT
  PIT on|off
  PITSIDE left|right
  PITLANE <entry_m> <exit_m> [width_m]
  PITBOXES <n>
  GRID <n>

SCENERY & SURFACE
  TREES <0..1>
  GRANDSTANDS on|off
  LIGHTS <spacing_m>|off
  GRASSLIP <m>                    how far grass sits above the tarmac
  GRAVELDEPTH <m>                 how far a gravel trap sits below it
  BUILDING offices|glass|brick|hangar <x> <y> <w> <d> <h> [rot_deg]

EXAMPLE
  NAME Riverside Park
  PRESET modern_gp
  WIDTH 13
  CLEAR
  STRAIGHT 850
  CORNER right 45 90
  STRAIGHT 300
  CORNER left 80 120
  STRAIGHT 220
  CORNER right 60 90
  STRAIGHT 400
  CORNER right 35 60
  STRAIGHT 180
  RUNOFF 0 gravel 20          # gravel trap outside the first corner
  RUNOFF 1 tarmac 22 wall 26  # paved run-off + barrier
  ESCAPE 0 tarmac             # only where a car would really overshoot
  CORNERKERB 1 flat combo flat
  PITLANE 60 400 12
  PITBOXES 24
  LIGHTS 80
`;
