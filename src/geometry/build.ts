import type { TrackProject, StripCfg, RunoffType } from '../types';
import type { BuiltTrack, MeshData } from './types';
import { buildCenterline, computeClosure } from './centerline';
import { makeHeightFn } from './elevation';
import { detectOverlaps, makeBridgeHeightFn } from './bridges';
import { buildRoad } from './road';
import { buildRoadLines } from './lines';
import { computeKerbInfo, buildKerbs, KERB_PATTERNS } from './kerbs';
import { computePitInfo, buildPitLane, buildPaddock, buildPitStructures, pitZone, pitRel } from './pitlane';
import { buildBuildings } from './buildings';
import {
  buildRunoff, buildGroundPlane, buildManualWalls, buildCornerFill, computeCurvatureCap, computeOverlapCap, runoffSurfaceName,
  type SideOffset, type ResolvedSample, type ResolvedSide, type CornerAtSample, type CornerFill,
} from './runoff';
import { buildEscapes } from './escape';
import { buildDecor } from './decor';
import { buildEmpties } from './spawns';

// Append src's geometry into target (same mesh name). Keeps UVs only when both
// sides have them; otherwise the planar fallback recomputes for the whole mesh.
function mergeInto(target: MeshData, src: MeshData): void {
  if (!src.faces.length) return;
  const canKeepUvs = !!target.uvs && !!src.uvs;
  const b = target.vertices.length;
  src.vertices.forEach((v) => target.vertices.push(v));
  src.faces.forEach((f) => target.faces.push([f[0] + b, f[1] + b, f[2] + b]));
  if (canKeepUvs) src.uvs!.forEach((u) => target.uvs!.push(u));
  else delete target.uvs;
}

export function buildTrack(project: TrackProject): BuiltTrack {
  const width = project.road.width;
  // A road of this width physically can't turn tighter than ~half its width —
  // below that the inside edge (and its kerb) crosses the arc centre and the
  // entry side folds onto the exit side. Cap the effective radius so it can't.
  const minR = width / 2 + 3;
  const segsClamped = project.segments.map((s) =>
    s.kind === 'corner' ? { ...s, radius: Math.max(s.radius, minR) } : s,
  );

  const { samples, spans, totalLength } = buildCenterline(segsClamped);

  const overlaps = detectOverlaps(samples);
  const manualH = makeHeightFn(project.elevation);
  const bridgeH = makeBridgeHeightFn(overlaps, project.bridge, project.road.width);
  for (const s of samples) s.pos[2] = manualH(s.dist) + bridgeH(s.dist);

  const closure = computeClosure(samples);

  const kerbInfo = computeKerbInfo(samples, spans, project.corners, project.road.defaultKerb);
  const pitInfo = computePitInfo(samples, project);

  // Per-segment lookups: corner direction/(clamped) radius + escape flag.
  const escapeOf = (cfg: { escape?: boolean; escapeType?: string } | undefined): boolean =>
    !!cfg && (cfg.escapeType ? cfg.escapeType !== 'none' : !!cfg.escape);
  const segCorner = new Map<number, { dir: 'left' | 'right'; radius: number; escape: boolean }>();
  for (const span of spans) {
    if (span.kind !== 'corner') continue;
    const seg = segsClamped[span.segIndex];
    if (seg.kind !== 'corner') continue;
    const cfg = project.corners.find((c) => c.cornerIndex === span.cornerIndex);
    segCorner.set(span.segIndex, { dir: seg.dir, radius: seg.radius, escape: escapeOf(cfg) });
  }

  // Pit complex footprint (lane + paddock) — the trackside runoff must start
  // BEYOND it on the pit side, or the runoff apron overlaps the pit ground
  // (that was the "runoff overlaps pit lane" bug). Paddock depth is known here
  // (same formula as where the paddock mesh is built), so we can reserve it.
  let pitPaddockDepth = 0;
  if (project.pit.enabled && (project.pit.paddock ?? true)) {
    const z = pitZone(project, totalLength);
    const span = Math.max(1, z.boxB - 4 - (z.boxA + 4));
    const perRow = Math.max(1, Math.floor(span / 8));
    const rows = Math.ceil(project.grid.pits / perRow);
    pitPaddockDepth = 8 + rows * 7;
  }
  // Outer edge of the whole pit complex at a sample on the pit side (0 elsewhere).
  const pitComplexOuter = (i: number, side: 'left' | 'right'): number => {
    if (!project.pit.enabled || side !== project.pit.side) return 0;
    const z = pitZone(project, totalLength);
    const rd = pitRel(samples[i].dist, z, totalLength);
    if (rd < z.start || rd > z.end) return 0;
    // in the full-width box zone reserve lane + paddock; in the tapers just the
    // (tapered) lane, so the runoff hugs the lane where there's no paddock.
    const laneW = pitInfo[i][side];
    if (rd >= z.boxA && rd <= z.boxB) return project.pit.width + pitPaddockDepth + 2;
    return laneW;
  };

  // Inner offset where the grass/runoff starts. The pit lane (and its paddock)
  // reserve room — the runoff starts beyond the whole pit complex on the pit
  // side. Kerbs do NOT reserve room (grass runs to the road edge, kerb sits
  // flush on top) so the ground is continuous with no gaps between kerbs.
  const innerOffsets: SideOffset[] = samples.map((_, i) => ({
    left: Math.max(pitInfo[i].left, pitComplexOuter(i, 'left')),
    right: Math.max(pitInfo[i].right, pitComplexOuter(i, 'right')),
  }));

  // Per-sample, per-side mask: suppress the inside barrier around each corner —
  // through the corner AND a margin onto the braking/traction straights so the
  // straight's wall stops well before a tight corner instead of cutting across
  // its inside. The margin grows as the corner tightens.
  const suppressWall = samples.map(() => ({ left: false, right: false }));
  for (const span of spans) {
    if (span.kind !== 'corner') continue;
    const seg = segsClamped[span.segIndex];
    if (seg.kind !== 'corner') continue;
    const inside = seg.dir; // 'left' | 'right'
    const margin = Math.max(20, Math.min(60, 500 / Math.max(5, seg.radius)));
    for (let i = 0; i < samples.length; i++) {
      const d = samples[i].dist;
      if (d >= span.startDist - margin && d <= span.endDist + margin) suppressWall[i][inside] = true;
    }
  }

  // Resolve the trackside strip per sample/side: default strip, then zone
  // overrides by distance range, then per-corner geometry overrides.
  const ts = project.trackside;
  const stripAt = (d: number, side: 'left' | 'right'): StripCfg => {
    let cfg = ts[side];
    for (const z of ts.zones) {
      if ((z.side === side || z.side === 'both') && d >= Math.min(z.from, z.to) && d <= Math.max(z.from, z.to)) {
        cfg = z;
      }
    }
    return cfg;
  };
  const stripSurface = (t: StripCfg['texture']): string =>
    t === 'gravel' || t === 'gravel_spaced' ? '1SAND'
      : t === 'concrete' ? '1CONCRETE'
        : t === 'tarmac' ? '1TARMAC'
          : t === 'dirt' ? '1DIRT'
            : '1GRASS';
  const toResolved = (cfg: StripCfg): ResolvedSide => ({
    surface: stripSurface(cfg.texture),
    width: cfg.width,
    wall: cfg.wall,
    wallDist: cfg.wallDist ?? cfg.width,
    ...(cfg.texture === 'gravel_spaced' ? { splitAt: 0.5, splitSurface: '1GRASS' } : {}),
  });
  const resolveSide = (d: number, segIndex: number, side: 'left' | 'right'): ResolvedSide => {
    const base = toResolved(stripAt(d, side));
    // Inside the pit zone on the pit side, keep the barrier BEYOND the whole pit
    // complex (the runoff already starts there via innerOffsets, so it no longer
    // overlaps the pit ground). The strip texture is whatever the user set.
    if (project.pit.enabled && side === project.pit.side) {
      const zz = pitZone(project, totalLength);
      const rd = pitRel(d, zz, totalLength);
      if (rd >= zz.start && rd <= zz.end) {
        const complex = project.pit.width + (((project.pit.paddock ?? true)) ? pitPaddockDepth : 2) + 3;
        return {
          ...base,
          width: Math.max(base.width, complex + 4),
          wallDist: Math.max(base.wallDist ?? base.width, complex),
        };
      }
    }
    const corner = segCorner.get(segIndex);
    const outside = corner ? (corner.dir === 'left' ? 'right' : 'left') : null;
    if (corner?.escape && side === outside) {
      // Monza-style escape road is built separately; never wall off its side.
      return { ...base, wall: false };
    }
    if (corner && side === corner.dir) {
      // Inside of a corner: the strip RUNS CONTINUOUSLY (zeroing it here made
      // ugly tapered wedges at every corner); the curvature cap alone keeps it
      // off the arc centre on tight corners. Just no wall on the inside.
      return { ...base, wall: false };
    }
    return base;
  };
  const resolved: ResolvedSample[] = samples.map((s, i) => {
    const L = resolveSide(s.dist, s.segIndex, 'left');
    const R = resolveSide(s.dist, s.segIndex, 'right');
    return {
      left: suppressWall[i].left ? { ...L, wall: false } : L,
      right: suppressWall[i].right ? { ...R, wall: false } : R,
    };
  });

  // Clamps that keep runoff/walls off the track.
  const perSampleCorner: (CornerAtSample | null)[] = samples.map((s) => {
    const c = segCorner.get(s.segIndex);
    return c ? { radius: c.radius, dir: c.dir } : null;
  });
  const curvCap = computeCurvatureCap(perSampleCorner, width);
  const overlapCap = project.autoClipRunoff
    ? computeOverlapCap(samples, width, project.segments.length, closure.closed)
    : samples.map(() => Infinity);

  const road = buildRoad(samples, width);
  const lines = buildRoadLines(samples, width);
  const pit = buildPitLane(samples, pitInfo, width);
  const kerb = buildKerbs(samples, kerbInfo, width, KERB_PATTERNS[project.meta.theme] ?? KERB_PATTERNS.tarmac_day);

  // Monza-style escape roads (per-corner `escape`): straight tarmac + sausage
  // separator + poly blocks + bollards; walls stay out of their corridors.
  const esc = buildEscapes(samples, spans, segsClamped, project.corners, width);
  mergeInto(road, esc.road);
  mergeInto(kerb.hi, esc.kerbHi);

  // Paddock beside the pit lane, deep enough for however many box rows
  // (depth already computed above as pitPaddockDepth so the runoff can reserve it).
  const paddockDepth = pitPaddockDepth;
  if (project.pit.enabled && (project.pit.paddock ?? true)) {
    mergeInto(pit, buildPaddock(samples, project, width, paddockDepth));
  }
  // Pit structures: wall between track and pit lane, garage building along the
  // paddock, painted pit-box lines on the lane.
  const pitDeco = buildPitStructures(samples, project, width, totalLength, paddockDepth);

  const runoffMeshes = buildRunoff(samples, width, resolved, innerOffsets, curvCap, overlapCap, project.walls, closure.closed, project.wallGaps, esc.corridors);
  // gravel escape surface merges into the 1SAND apron mesh if present, else adds
  if (esc.gravel.faces.length) {
    const sand = runoffMeshes.find((m) => m.name === '1SAND');
    if (sand) mergeInto(sand, esc.gravel);
    else runoffMeshes.push(esc.gravel);
  }

  // Clean infield fill on the inside of every corner (surface per corner config).
  const fills: CornerFill[] = [];
  for (const span of spans) {
    if (span.kind !== 'corner') continue;
    const seg = segsClamped[span.segIndex];
    if (seg.kind !== 'corner') continue;
    const cfg = project.corners.find((c) => c.cornerIndex === span.cornerIndex);
    const midCfg = stripAt((span.startDist + span.endDist) / 2, seg.dir);
    const insideType = cfg?.insideSurface ?? (midCfg.texture === 'gravel_spaced' ? 'gravel' : midCfg.texture);
    fills.push({
      span, radius: seg.radius, dir: seg.dir,
      surface: runoffSurfaceName(insideType as RunoffType),
      depth: Math.max(6, midCfg.width),
    });
  }
  for (const fm of buildCornerFill(samples, width, fills)) {
    const target = runoffMeshes.find((m) => m.name === fm.name);
    if (target) mergeInto(target, fm);
    else runoffMeshes.push(fm);
  }

  // Hand-drawn barriers merge into the 1WALL mesh.
  if (project.manualWalls?.length) {
    const manual = buildManualWalls(project.manualWalls, samples, project.walls.height);
    if (manual.faces.length) {
      const wallMesh = runoffMeshes.find((m) => m.name === '1WALL');
      if (wallMesh) mergeInto(wallMesh, manual);
      else runoffMeshes.push(manual);
    }
  }

  // Fill the whole footprint with a base grass plane so there are no holes to
  // fall through. Merge it into the grass apron mesh (same surface).
  const ground = buildGroundPlane(samples);
  if (ground.faces.length) {
    const grassMesh = runoffMeshes.find((m) => m.name === '1GRASS');
    if (grassMesh) mergeInto(grassMesh, ground);
    else runoffMeshes.unshift(ground);
  }

  // Pit wall merges into the physical 1WALL mesh.
  if (pitDeco.wall.faces.length) {
    const wallMesh0 = runoffMeshes.find((m) => m.name === '1WALL');
    if (wallMesh0) mergeInto(wallMesh0, pitDeco.wall);
    else runoffMeshes.push(pitDeco.wall);
  }

  const empties = buildEmpties(samples, project);
  const decor = buildDecor(project, samples, spans, width, resolved);
  const bldgs = buildBuildings(project.buildings ?? [], samples);

  // Draw/export order: aprons first, then road/pit/lines/kerbs, walls, decor.
  const aprons = runoffMeshes.filter((m) => m.name !== '1WALL');
  const wallMesh = runoffMeshes.filter((m) => m.name === '1WALL');
  const meshes: MeshData[] = [
    ...aprons, road, pit, lines, pitDeco.lines, kerb.base, kerb.hi, ...wallMesh,
    esc.poly, esc.bollards, ...decor, pitDeco.building, pitDeco.garage, ...bldgs,
  ].filter((m) => m.faces.length > 0);

  // Every mesh needs UVs for its texture; anything that didn't set its own
  // (road, aprons, walls…) gets planar world mapping — one tile per 6 m.
  const UV_TILE = 6;
  for (const m of meshes) {
    if (!m.uvs || m.uvs.length !== m.vertices.length) {
      m.uvs = m.vertices.map((v) => [v[0] / UV_TILE, v[1] / UV_TILE]);
    }
  }

  return { centerline: samples, spans, totalLength, closure, meshes, empties, overlaps };
}
