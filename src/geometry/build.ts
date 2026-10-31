import type { TrackProject, StripCfg, RunoffType } from '../types';
import type { BuiltTrack, MeshData } from './types';
import { buildCenterline, computeClosure, insertSamples } from './centerline';
import { makeHeightFn, smoothProfile } from './elevation';

// Every metre of track gets SOME run-off and a barrier behind it — a stretch
// with neither is just a place to fall off the world.
const MIN_RUNOFF_M = 3;
import { detectOverlaps, makeBridgeHeightFn } from './bridges';
import { perpLeft } from './frames';
import { buildRoad } from './road';
import { buildRoadLines } from './lines';
import { computeKerbInfo, buildKerbs, KERB_PATTERNS, kerbTaperBreaks } from './kerbs';
import { computePitInfo, buildPitLane, buildPaddock, buildPitStructures, pitZone, pitRel, GARAGE_DEPTH } from './pitlane';
import { buildPitComplex } from './pitComplex';
import { buildBuildings } from './buildings';
import { autoAdverts, buildProps } from './props';
import { buildPatches } from './patches';
import { buildGrassTufts } from './grassTufts';
import {
  buildRunoff, buildGroundPlane, buildManualWalls, buildCornerFill, clampUnder, computeCurvatureCap, computeOverlapCap, runoffSurfaceName,
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
  const bridgeH = makeBridgeHeightFn(overlaps, project.bridge, project.road.width);
  // Smooth the HAND-SET profile only. Bridge ramps are deliberate shapes with a
  // clearance to hit, so they are added after smoothing and left alone.
  // Closure is a question about XY and heading, so it is already answerable
  // before any height is applied — and the smoother needs it to decide whether
  // to wrap its window across the start/finish line.
  const closure = computeClosure(samples);
  const manualH = makeHeightFn(project.elevation, totalLength, closure.closed);
  const smoothH = smoothProfile(samples.map((s) => s.dist), totalLength, manualH,
    project.elevationSmoothing ?? 0, closure.closed);
  for (let i = 0; i < samples.length; i++) {
    samples[i].pos[2] = smoothH[i] + bridgeH(samples[i].dist);
  }

  // A sample at every corner of every kerb's end taper, so the kerb, the grass
  // edge and the run-off are all built from the same outline (kerbTaperBreaks).
  // Inserted AFTER elevation, with heights interpolated from the finished
  // profile: smoothHeights sizes its window in samples from totalLength / n, so
  // inserting before it changed n and moved the whole profile - up to 65 cm on
  // hexagone. Inserted here, every original sample keeps its exact height.
  // Nothing before this point holds sample indices: overlaps and the bridge
  // ramp are keyed by distance.
  insertSamples(samples, spans,
    kerbTaperBreaks(samples, spans, project.corners, project.road.defaultKerb));

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
  // The paddock is a fixed service yard now. Its depth used to be derived from
  // the pit-box count, because the boxes were parked ON it in rows; they sit on
  // the lane in front of the garages instead, so its size is just how much yard
  // a circuit wants behind the building.
  const pitPaddockDepth = project.pit.enabled && (project.pit.paddock ?? true) ? 25 : 0;
  // Outer edge of the whole pit complex at a sample on the pit side (0 elsewhere).
  const pitComplexOuter = (i: number, side: 'left' | 'right'): number => {
    if (!project.pit.enabled || side !== project.pit.side) return 0;
    const z = pitZone(project, totalLength);
    const rd = pitRel(samples[i].dist, z, totalLength);
    if (rd < z.start || rd > z.end) return 0;
    // in the full-width box zone reserve lane + paddock; in the tapers just the
    // (tapered) lane, so the runoff hugs the lane where there's no paddock.
    const laneW = pitInfo[i][side];
    if (rd >= z.boxA && rd <= z.boxB) return project.pit.width + GARAGE_DEPTH + pitPaddockDepth + 2;
    return laneW;
  };

  // Inner offset where the grass/runoff starts. The pit lane (and its paddock)
  // reserve room — the runoff starts beyond the whole pit complex on the pit
  // side. Kerbs do NOT reserve room (grass runs to the road edge, kerb sits
  // flush on top) so the ground is continuous with no gaps between kerbs.
  // The strip starts at the OUTER EDGE OF THE KERB, not at the road edge. Grass
  // used to run underneath the kerb, and because the verge sits proud of the
  // tarmac it came up through low kerbs — the kerb looked set back from the
  // track with grass in between. A kerb belongs against the racing surface.
  const innerOffsets: SideOffset[] = samples.map((_, i) => ({
    left: Math.max(pitInfo[i].left, pitComplexOuter(i, 'left'), kerbInfo[i].leftEff),
    right: Math.max(pitInfo[i].right, pitComplexOuter(i, 'right'), kerbInfo[i].rightEff),
  }));

  // Per-sample, per-side mask: suppress the inside barrier around each corner —
  // through the corner AND a margin onto the braking/traction straights so the
  // straight's wall stops well before a tight corner instead of cutting across
  // its inside. The margin grows as the corner tightens.
  const suppressWall = samples.map(() => ({ left: false, right: false }));
  // Continuous barriers (the default): never drop a stretch of wall. The
  // curvature cap keeps it geometrically sane through a corner's inside.
  const continuousWalls = project.walls.continuous !== false;
  for (const span of continuousWalls ? [] : spans) {
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
    width: Math.max(cfg.width, MIN_RUNOFF_M),
    wall: cfg.wall,
    wallDist: Math.max(cfg.wallDist ?? cfg.width, MIN_RUNOFF_M),
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
        const complex = project.pit.width + GARAGE_DEPTH + (((project.pit.paddock ?? true)) ? pitPaddockDepth : 2) + 3;
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
      // With continuous barriers on, every sample gets one on both sides —
      // "wall everywhere" has to mean everywhere, not just where a strip
      // happened to have its barrier toggle set.
      left: suppressWall[i].left ? { ...L, wall: false } : (continuousWalls ? { ...L, wall: true } : L),
      right: suppressWall[i].right ? { ...R, wall: false } : (continuousWalls ? { ...R, wall: true } : R),
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

  const paddockDepth = pitPaddockDepth;
  // Pit structures: wall between track and pit lane, garage building along the
  // paddock, painted pit-box lines on the lane.
  const pitDeco = buildPitStructures(samples, project, width, totalLength);
  // garages, transporters and motorhomes: one garage per box, a truck and a
  // motorhome per team, modelled in Blender
  const pitComplex = buildPitComplex(samples, project, width);

  const runoffMeshes = buildRunoff(samples, width, resolved, innerOffsets, curvCap, overlapCap, project.walls, closure.closed, project.wallGaps, esc.corridors,
    project.surfaceDetail ?? { grassHeight: 0, gravelDepth: 0 }, project.decor?.adverts ?? false);
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

    // A corner's infield is only free real estate if no OTHER part of the track
    // runs through it. On a loop-back (hairpin throat, a straight passing inside
    // a long corner) it does, and an unclipped fill lays grass straight over the
    // tarmac. Stop the fill short of whatever intrudes, and never close it into
    // a pie when something is in there.
    const spanIdx: number[] = [];
    for (let i = 0; i < samples.length; i++) if (samples[i].segIndex === span.segIndex) spanIdx.push(i);
    let depth = Math.max(6, midCfg.width);
    let noPie = false;
    if (spanIdx.length >= 2) {
      const rIn = seg.radius - width / 2;
      const sign = seg.dir === 'left' ? 1 : -1;
      const mid = samples[spanIdx[Math.floor(spanIdx.length / 2)]];
      const [lx, ly] = perpLeft(mid.heading);
      const cx = mid.pos[0] + lx * seg.radius * sign;
      const cy = mid.pos[1] + ly * seg.radius * sign;
      const segAdjacent = (a: number, b: number) => {
        let d = Math.abs(a - b);
        if (closure.closed && project.segments.length > 0) d = Math.min(d, project.segments.length - d);
        return d <= 1;
      };
      // Innermost radius the fill may reach: outside every intruder's own edge.
      let holdR = 0;
      for (let j = 0; j < samples.length; j++) {
        if (segAdjacent(span.segIndex, Math.max(0, samples[j].segIndex))) continue;
        const d = Math.hypot(samples[j].pos[0] - cx, samples[j].pos[1] - cy);
        if (d >= rIn) continue; // that part is outside this corner
        noPie = true;
        holdR = Math.max(holdR, d + width / 2 + 1.0);
      }
      if (noPie) depth = Math.min(depth, Math.max(0, rIn - holdR));
    }
    if (depth < 0.5) continue; // nothing safe to fill here

    fills.push({
      span, radius: seg.radius, dir: seg.dir,
      surface: runoffSurfaceName(insideType as RunoffType),
      depth,
      noPie,
    });
  }
  // Service yard behind the garages. It is a SEPARATE surface from the lane —
  // merging it into the pit mesh (which it was) made the whole yard read as pit
  // lane to AC, because surfaces.ini marks 1PIT with IS_PITLANE=1.
  if (project.pit.enabled && (project.pit.paddock ?? true)) {
    const yard = buildPaddock(samples, project, width, paddockDepth);
    if (yard.faces.length) {
      const host = runoffMeshes.find((m) => m.name === yard.name);
      if (host) mergeInto(host, yard); else runoffMeshes.push(yard);
    }
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
  // Everything laid inside the barriers, so the terrain can be capped under all
  // of it — not just under the track. Without the aprons here, grass came up
  // through the concrete and gravel beside the circuit.
  const placedSurfaces = [road, pit, kerb.base, kerb.hi, ...runoffMeshes.filter((m) => m.name !== '1GRASS' && m.name !== '1WALL')];
  const ground = buildGroundPlane(samples, placedSurfaces);
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
  const adverts = project.decor?.adverts ? autoAdverts(samples, resolved, width) : [];
  const propMeshes = buildProps([...(project.props ?? []), ...adverts], samples);
  // Hand-placed surface patches, merged with the aprons so they share materials.
  const patchMeshes = buildPatches(project.patches ?? [], samples);
  // Grass that stands up out of the verge (alpha-cut cards) — the thing a flat
  // ground texture fundamentally cannot do.
  // no grass on the pit lane, in the garages or across the paddock
  const tufts = buildGrassTufts(samples, width, resolved, project.decor?.grassTufts ?? 0, (i, side) =>
    pitComplexOuter(i, side) > pitInfo[i][side] ? Infinity : innerOffsets[i][side]);

  // Draw/export order: aprons first, then road/pit/lines/kerbs, walls, decor.
  for (const pm of patchMeshes) {
    const host = runoffMeshes.find((m) => m.name === pm.name);
    if (host) mergeInto(host, pm); else runoffMeshes.push(pm);
  }
  // Final invariant, applied once everything laid inside the barriers exists —
  // including hand-placed patches, which are merged just above. Grass is drawn
  // across escape roads and aprons and lifted by grassHeight, which put the
  // verge ON TOP of the paved run-off; rather than teach every producer about
  // every other one, push grass under whatever it overlaps, here, at the end.
  const grassAll = runoffMeshes.find((m) => m.name === '1GRASS');
  if (grassAll) {
    const blockers = runoffMeshes.filter((m) => m.name === '1TARMAC' || m.name === '1CONCRETE' || m.name === '1SAND' || m.name === '1DIRT');
    // pad 0: strict overlap only. A proximity margin also caught grass that
    // legitimately BORDERS an apron — the 0.5 m verge of 'gravel_spaced' sits
    // entirely within any margin, so the whole band got pushed under the gravel
    // and left a gap you could see through.
    if (blockers.length) clampUnder(grassAll, blockers, 0.005, 0);
  }

  const aprons = runoffMeshes.filter((m) => m.name !== '1WALL');
  const wallMesh = runoffMeshes.filter((m) => m.name === '1WALL');
  const meshes: MeshData[] = [
    ...aprons, road, pit, lines, pitDeco.lines, kerb.base, kerb.hi, ...wallMesh,
    esc.poly, esc.bollards, ...(tufts ? [tufts] : []), ...decor.meshes, pitDeco.sign, ...pitComplex, ...bldgs, ...propMeshes,
  ].filter((m) => m.faces.length > 0);

  // RENDER STACK. Levelling every surface to the road plane fixed the steps you
  // could see and feel, but it left grass, gravel, concrete and tarmac sharing
  // EXACTLY the same plane wherever they overlap — 8,533 coplanar triangles at
  // 0.0000 m on one test track — and two coplanar surfaces z-fight, which
  // shimmers far worse than a step you cannot see.
  //
  // So each ground surface gets a fixed 3 mm rank below the road. The whole
  // stack spans 18 mm: no wheel feels it, nothing reads as a step (the
  // levelness tolerance is 20 mm), but no two layers ever share a plane and
  // the more deliberate surface always wins the depth test.
  const SURFACE_RANK: Record<string, number> = {
    '1ROAD': 0, '1PIT': -0.003, '1TARMAC': -0.006,
    '1CONCRETE': -0.009, '1SAND': -0.012, '1DIRT': -0.015, '1GRASS': -0.018,
  };
  for (const m of meshes) {
    const dz = SURFACE_RANK[m.name];
    if (!dz) continue;
    for (const v of m.vertices) v[2] += dz;
  }

  // Every mesh needs UVs for its texture; anything that didn't set its own
  // (road, aprons, walls…) gets planar world mapping — one tile per 6 m.
  const UV_TILE = 6;
  for (const m of meshes) {
    if (!m.uvs || m.uvs.length !== m.vertices.length) {
      m.uvs = m.vertices.map((v) => [v[0] / UV_TILE, v[1] / UV_TILE]);
    }
  }

  return { centerline: samples, spans, totalLength, closure, meshes, empties, overlaps, lightMasts: decor.masts };
}
