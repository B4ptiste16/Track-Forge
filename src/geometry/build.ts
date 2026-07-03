import type { TrackProject, SectionSide } from '../types';
import type { BuiltTrack, MeshData } from './types';
import { buildCenterline, computeClosure } from './centerline';
import { makeHeightFn } from './elevation';
import { detectOverlaps, makeBridgeHeightFn } from './bridges';
import { buildRoad } from './road';
import { buildRoadLines } from './lines';
import { computeKerbInfo, buildKerbs, KERB_PATTERNS } from './kerbs';
import { computePitInfo, buildPitLane, buildPaddock, pitZone } from './pitlane';
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
  const segCorner = new Map<number, { dir: 'left' | 'right'; radius: number; escape: boolean }>();
  for (const span of spans) {
    if (span.kind !== 'corner') continue;
    const seg = segsClamped[span.segIndex];
    if (seg.kind !== 'corner') continue;
    const cfg = project.corners.find((c) => c.cornerIndex === span.cornerIndex);
    segCorner.set(span.segIndex, { dir: seg.dir, radius: seg.radius, escape: !!cfg?.escape });
  }

  // Inner offset where the grass/runoff starts. Only the pit lane reserves room
  // (it's a separate drivable surface); kerbs do NOT — the grass runs all the way
  // to the road edge and the kerb sits flush on top of it. This guarantees the
  // ground is continuous so there are never gaps to fall through between kerbs.
  const innerOffsets: SideOffset[] = samples.map((_, i) => ({
    left: pitInfo[i].left,
    right: pitInfo[i].right,
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

  // Resolve runoff per sample/side from section config + escape overrides.
  const sectionFor = (segIndex: number) => project.runoff?.[segIndex];
  const resolveSide = (segIndex: number, side: 'left' | 'right'): ResolvedSide => {
    const sec = sectionFor(segIndex);
    const base: SectionSide = (sec ? sec[side] : project.runoffDefault) ?? project.runoffDefault;
    const corner = segCorner.get(segIndex);
    const outside = corner ? (corner.dir === 'left' ? 'right' : 'left') : null;
    if (corner?.escape && side === outside) {
      // Monza-style escape road is built separately; keep the outside apron
      // but never wall it off (the corridor check also protects neighbours).
      return { surface: runoffSurfaceName(base.type === 'wall' ? 'grass' : base.type), width: base.dist, wall: false };
    }
    if (corner && side === corner.dir) {
      // Inside of a corner: covered by the concentric infield fill instead of
      // the strip apron (which went lumpy on hairpins). No apron, no wall.
      return { surface: runoffSurfaceName(base.type === 'wall' ? 'grass' : base.type), width: 0, wall: false };
    }
    return { surface: runoffSurfaceName(base.type), width: base.dist, wall: base.type === 'wall' ? true : base.wall };
  };
  const resolved: ResolvedSample[] = samples.map((s, i) => {
    const L = resolveSide(s.segIndex, 'left');
    const R = resolveSide(s.segIndex, 'right');
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

  // Paddock beside the pit lane, deep enough for however many box rows.
  if (project.pit.enabled && (project.pit.paddock ?? true)) {
    const z = pitZone(project, totalLength);
    const span = Math.max(1, z.boxB - 4 - (z.boxA + 4));
    const perRow = Math.max(1, Math.floor(span / 8));
    const rows = Math.ceil(project.grid.pits / perRow);
    mergeInto(pit, buildPaddock(samples, project, width, 8 + rows * 7));
  }

  const runoffMeshes = buildRunoff(samples, width, resolved, innerOffsets, curvCap, overlapCap, project.walls, closure.closed, project.wallGaps, esc.corridors);

  // Clean infield fill on the inside of every corner (surface per corner config).
  const fills: CornerFill[] = [];
  for (const span of spans) {
    if (span.kind !== 'corner') continue;
    const seg = segsClamped[span.segIndex];
    if (seg.kind !== 'corner') continue;
    const cfg = project.corners.find((c) => c.cornerIndex === span.cornerIndex);
    const sec = sectionFor(span.segIndex);
    const sideCfg: SectionSide = (sec ? sec[seg.dir] : project.runoffDefault) ?? project.runoffDefault;
    const insideType = cfg?.insideSurface ?? (sideCfg.type === 'wall' ? 'grass' : sideCfg.type);
    fills.push({
      span, radius: seg.radius, dir: seg.dir,
      surface: runoffSurfaceName(insideType),
      depth: Math.max(6, sideCfg.dist),
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

  const empties = buildEmpties(samples, project);
  const decor = buildDecor(project, samples, spans, width, resolved);

  // Draw/export order: aprons first, then road/pit/lines/kerbs, walls, decor.
  const aprons = runoffMeshes.filter((m) => m.name !== '1WALL');
  const wallMesh = runoffMeshes.filter((m) => m.name === '1WALL');
  const meshes: MeshData[] = [
    ...aprons, road, pit, lines, kerb.base, kerb.hi, ...wallMesh, esc.poly, esc.bollards, ...decor,
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
