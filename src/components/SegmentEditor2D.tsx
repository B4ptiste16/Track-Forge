import { useEffect, useRef, useState } from 'react';
import type { TrackProject, Segment, ManualWall, CornerConfig } from '../types';
import type { BuiltTrack } from '../geometry';
import { perpLeft } from '../geometry';
import { escapeControlPoints, escapeTypeOf } from '../geometry/escape';
import { THEME_PALETTES } from '../state/project';

type EditorMode = 'shape' | 'wall' | 'zone' | 'building';

interface Props {
  project: TrackProject;
  built: BuiltTrack;
  onCloseLoop: () => void;
  onSegmentsChange: (segs: Segment[]) => void;
  onCornersChange: (corners: CornerConfig[]) => void;
  onManualWallsChange: (walls: ManualWall[]) => void;
  onZonePicked: (from: number, to: number, side: 'left' | 'right') => void;
  onPlaceBuilding: (x: number, y: number) => void;
}

interface Transform { minX: number; minY: number; scale: number; ox: number; oy: number; H: number; }
interface Handle {
  segIndex: number;
  kind: 'radius' | 'angle' | 'escape';
  sx: number; sy: number; // screen
  apexHeading: number;
  entry: [number, number];
  entryHeading: number;
  dir: 'left' | 'right';
  cornerIndex?: number; // for escape handles
  nodeIndex?: number; // 0..3 for escape control points
}

function nearestIndex(built: BuiltTrack, dist: number): number {
  const s = built.centerline;
  let best = 0, bd = Infinity;
  for (let i = 0; i < s.length; i++) {
    const d = Math.abs(s[i].dist - dist);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

export function SegmentEditor2D({ project, built, onCloseLoop, onSegmentsChange, onCornersChange, onManualWallsChange, onZonePicked, onPlaceBuilding }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const txRef = useRef<Transform | null>(null);
  const handlesRef = useRef<Handle[]>([]);
  const dragRef = useRef<{ h: Handle; startWorld: [number, number]; startRadius: number } | null>(null);
  const [mode, setMode] = useState<EditorMode>('shape');
  const [draft, setDraft] = useState<[number, number][]>([]);
  const [zoneAnchor, setZoneAnchor] = useState<{ dist: number; side: 'left' | 'right' } | null>(null);
  const [selected, setSelected] = useState<number | null>(null); // segIndex being edited inline
  const [lockRest, setLockRest] = useState(true); // radius drags keep the rest of the track in place
  const [resizeTick, setResizeTick] = useState(0);
  // Keep latest project/built/callback + options for window-level drag handlers.
  const stateRef = useRef({ project, built, onSegmentsChange, onCornersChange, lockRest });
  stateRef.current = { project, built, onSegmentsChange, onCornersChange, lockRest };

  // Redraw when the pane is resized (the divider above can be dragged).
  useEffect(() => {
    const parent = canvasRef.current?.parentElement;
    if (!parent) return;
    const ro = new ResizeObserver(() => setResizeTick((t) => t + 1));
    ro.observe(parent);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement!;
    const W = parent.clientWidth;
    const H = Math.max(220, parent.clientHeight);
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, W, H);

    const pal = THEME_PALETTES[project.meta.theme];
    const samples = built.centerline;
    if (samples.length < 2) {
      ctx.fillStyle = '#888';
      ctx.font = '14px sans-serif';
      ctx.fillText('Add segments to see the track.', 16, 24);
      handlesRef.current = [];
      return;
    }

    const w2 = project.road.width / 2;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const s of samples) {
      const [lx, ly] = perpLeft(s.heading);
      for (const sgn of [1, -1]) {
        const x = s.pos[0] + lx * w2 * sgn, y = s.pos[1] + ly * w2 * sgn;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
    const pad = 48;
    const scale = Math.min((W - 2 * pad) / (maxX - minX || 1), (H - 2 * pad) / (maxY - minY || 1));
    const ox = (W - (maxX - minX) * scale) / 2;
    const oy = (H - (maxY - minY) * scale) / 2;
    txRef.current = { minX, minY, scale, ox, oy, H };
    const sx = (x: number) => ox + (x - minX) * scale;
    const sy = (y: number) => H - (oy + (y - minY) * scale);

    // Road fill.
    ctx.beginPath();
    samples.forEach((s, i) => {
      const [lx, ly] = perpLeft(s.heading);
      const x = sx(s.pos[0] + lx * w2), y = sy(s.pos[1] + ly * w2);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    for (let i = samples.length - 1; i >= 0; i--) {
      const s = samples[i];
      const [lx, ly] = perpLeft(s.heading);
      ctx.lineTo(sx(s.pos[0] - lx * w2), sy(s.pos[1] - ly * w2));
    }
    ctx.closePath();
    ctx.fillStyle = pal.road;
    ctx.fill();

    // Centerline.
    ctx.beginPath();
    samples.forEach((s, i) => {
      const x = sx(s.pos[0]), y = sy(s.pos[1]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.setLineDash([6, 6]); ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);

    // Start marker.
    ctx.fillStyle = '#39d353';
    ctx.beginPath(); ctx.arc(sx(samples[0].pos[0]), sy(samples[0].pos[1]), 5, 0, Math.PI * 2); ctx.fill();

    // Overpass markers.
    for (const o of built.overlaps) {
      const x = sx(o.x), y = sy(o.y);
      ctx.fillStyle = '#b07cff';
      ctx.beginPath();
      ctx.moveTo(x, y - 6); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 6); ctx.lineTo(x - 6, y); ctx.closePath();
      ctx.fill();
    }

    // Corner labels + draggable handles.
    handlesRef.current = [];
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'center';
    for (const span of built.spans) {
      if (span.kind !== 'corner') continue;
      const midI = nearestIndex(built, (span.startDist + span.endDist) / 2);
      const entryI = nearestIndex(built, span.startDist);
      const exitI = nearestIndex(built, span.endDist);
      const m = samples[midI];
      const [lx, ly] = perpLeft(m.heading);
      const labelSign = span.dir === 'left' ? 1 : -1;
      const lxp = sx(m.pos[0] + lx * (w2 + 8) * labelSign);
      const lyp = sy(m.pos[1] + ly * (w2 + 8) * labelSign);
      ctx.fillStyle = '#ffd24a';
      ctx.fillText(`T${span.cornerIndex + 1}`, lxp, lyp);

      const apexS = { sx: sx(m.pos[0]), sy: sy(m.pos[1]) };
      const ex = samples[exitI];
      const handleBase = {
        segIndex: span.segIndex, apexHeading: m.heading,
        entry: [samples[entryI].pos[0], samples[entryI].pos[1]] as [number, number],
        entryHeading: samples[entryI].heading, dir: span.dir!,
      };
      handlesRef.current.push({ ...handleBase, kind: 'radius', sx: apexS.sx, sy: apexS.sy });
      handlesRef.current.push({ ...handleBase, kind: 'angle', sx: sx(ex.pos[0]), sy: sy(ex.pos[1]) });

      // radius handle (filled yellow), angle handle (hollow cyan)
      ctx.beginPath(); ctx.arc(apexS.sx, apexS.sy, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#ffd24a'; ctx.fill();
      ctx.strokeStyle = '#1a1500'; ctx.lineWidth = 1; ctx.stroke();
      ctx.beginPath(); ctx.arc(sx(ex.pos[0]), sy(ex.pos[1]), 5, 0, Math.PI * 2);
      ctx.strokeStyle = '#33e0ff'; ctx.lineWidth = 2; ctx.stroke();
    }

    // Escape roads: draw the bezier path + 4 draggable control nodes for every
    // corner that has an escape. Custom shape (escapeNodes) overrides default.
    for (const span of built.spans) {
      if (span.kind !== 'corner') continue;
      const cfg = project.corners.find((c) => c.cornerIndex === span.cornerIndex);
      if (escapeTypeOf(cfg) === 'none') continue;
      const segE = project.segments[span.segIndex];
      const frame = escapeControlPoints(samples, span, segE, project.road.width);
      if (!frame) continue;
      const cp = (cfg?.escapeNodes && cfg.escapeNodes.length === 4 ? cfg.escapeNodes : frame.points) as [number, number][];
      // bezier polyline
      ctx.beginPath();
      for (let k = 0; k <= 30; k++) {
        const u = k / 30, mu = 1 - u;
        const b0 = mu * mu * mu, b1 = 3 * mu * mu * u, b2 = 3 * mu * u * u, b3 = u * u * u;
        const x = b0 * cp[0][0] + b1 * cp[1][0] + b2 * cp[2][0] + b3 * cp[3][0];
        const y = b0 * cp[0][1] + b1 * cp[1][1] + b2 * cp[2][1] + b3 * cp[3][1];
        if (k === 0) ctx.moveTo(sx(x), sy(y)); else ctx.lineTo(sx(x), sy(y));
      }
      ctx.strokeStyle = cfg?.escapeNodes ? '#ff9e3d' : 'rgba(255,158,61,0.6)';
      ctx.setLineDash([4, 4]); ctx.lineWidth = 2; ctx.stroke(); ctx.setLineDash([]);
      // control arms (faint) from endpoints to their handles
      ctx.strokeStyle = 'rgba(255,158,61,0.35)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(sx(cp[0][0]), sy(cp[0][1])); ctx.lineTo(sx(cp[1][0]), sy(cp[1][1])); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(sx(cp[3][0]), sy(cp[3][1])); ctx.lineTo(sx(cp[2][0]), sy(cp[2][1])); ctx.stroke();
      // 4 nodes: endpoints square-ish (start/end), controls small circles
      for (let n = 0; n < 4; n++) {
        const px = sx(cp[n][0]), py = sy(cp[n][1]);
        handlesRef.current.push({
          segIndex: span.segIndex, kind: 'escape', sx: px, sy: py,
          apexHeading: 0, entry: [0, 0], entryHeading: 0, dir: (segE.kind === 'corner' ? segE.dir : 'left'),
          cornerIndex: span.cornerIndex, nodeIndex: n,
        });
        ctx.beginPath();
        if (n === 0 || n === 3) ctx.rect(px - 5, py - 5, 10, 10);
        else ctx.arc(px, py, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = '#ff9e3d'; ctx.fill();
        ctx.strokeStyle = '#3a2400'; ctx.lineWidth = 1; ctx.stroke();
      }
    }

    // Selected segment highlight (click-to-edit).
    if (selected !== null) {
      const span = built.spans.find((sp) => sp.segIndex === selected);
      if (span) {
        ctx.beginPath();
        let started = false;
        for (const s of samples) {
          if (s.dist < span.startDist || s.dist > span.endDist) continue;
          const x = sx(s.pos[0]), y = sy(s.pos[1]);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = '#ffd24a';
        ctx.lineWidth = 3;
        ctx.stroke();
      }
    }

    // S/F line.
    const sf = samples[nearestIndex(built, project.startFinishDist)];
    const [lx, ly] = perpLeft(sf.heading);
    ctx.beginPath();
    ctx.moveTo(sx(sf.pos[0] + lx * w2), sy(sf.pos[1] + ly * w2));
    ctx.lineTo(sx(sf.pos[0] - lx * w2), sy(sf.pos[1] - ly * w2));
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 3; ctx.stroke();

    // Spawn slot markers.
    for (const e of built.empties) {
      const isPit = e.name.startsWith('AC_PIT_');
      const isStart = e.name.startsWith('AC_START_');
      if (!isPit && !isStart) continue;
      const px = sx(e.position[0]), py = sy(e.position[1]);
      const fx = e.basis[0][2], fy = e.basis[1][2];
      ctx.fillStyle = isPit ? '#4aa3ff' : '#ff7a4a';
      ctx.beginPath(); ctx.arc(px, py, 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + fx * 12, py - fy * 12);
      ctx.strokeStyle = ctx.fillStyle as string; ctx.lineWidth = 1.5; ctx.stroke();
    }

    // Trackside zones highlighted along the road edge.
    const zoneColor: Record<string, string> = {
      grass: '#57a05a', gravel: '#c9a35c', gravel_spaced: '#d9b46a', concrete: '#9aa0a8',
    };
    for (const z of project.trackside?.zones ?? []) {
      for (const zside of z.side === 'both' ? (['left', 'right'] as const) : [z.side]) {
        const sgn = zside === 'left' ? 1 : -1;
        ctx.beginPath();
        let started = false;
        for (const s of samples) {
          if (s.dist < Math.min(z.from, z.to) || s.dist > Math.max(z.from, z.to)) continue;
          const [lx, ly] = perpLeft(s.heading);
          const x = sx(s.pos[0] + lx * (w2 + 3) * sgn), y = sy(s.pos[1] + ly * (w2 + 3) * sgn);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = zoneColor[z.texture] ?? '#888';
        ctx.lineWidth = 4;
        ctx.stroke();
      }
    }

    // Buildings (rotated rectangles).
    for (const b of project.buildings ?? []) {
      const a = (b.rot * Math.PI) / 180;
      const ux = Math.cos(a), uy = Math.sin(a), vx = -Math.sin(a), vy = Math.cos(a);
      const pts: [number, number][] = [
        [b.x - ux * b.w / 2 - vx * b.d / 2, b.y - uy * b.w / 2 - vy * b.d / 2],
        [b.x + ux * b.w / 2 - vx * b.d / 2, b.y + uy * b.w / 2 - vy * b.d / 2],
        [b.x + ux * b.w / 2 + vx * b.d / 2, b.y + uy * b.w / 2 + vy * b.d / 2],
        [b.x - ux * b.w / 2 + vx * b.d / 2, b.y - uy * b.w / 2 + vy * b.d / 2],
      ];
      ctx.beginPath();
      pts.forEach((p, i) => { const x = sx(p[0]), y = sy(p[1]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
      ctx.closePath();
      ctx.fillStyle = 'rgba(185,179,168,0.55)';
      ctx.fill();
      ctx.strokeStyle = '#b9b3a8';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Pending zone anchor marker.
    if (zoneAnchor) {
      const i = nearestIndex(built, zoneAnchor.dist);
      const s = samples[i];
      const [lx, ly] = perpLeft(s.heading);
      const sgn = zoneAnchor.side === 'left' ? 1 : -1;
      const x = sx(s.pos[0] + lx * (w2 + 3) * sgn), y = sy(s.pos[1] + ly * (w2 + 3) * sgn);
      ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#ffd24a'; ctx.fill();
    }

    // Manual (hand-drawn) walls.
    for (const w of project.manualWalls ?? []) {
      if (w.points.length < 1) continue;
      ctx.beginPath();
      w.points.forEach((p, i) => { const x = sx(p[0]), y = sy(p[1]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
      ctx.strokeStyle = '#d0d3da'; ctx.lineWidth = 3; ctx.stroke();
    }
    // Draft wall being drawn.
    if (draft.length) {
      ctx.beginPath();
      draft.forEach((p, i) => { const x = sx(p[0]), y = sy(p[1]); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
      ctx.strokeStyle = '#ffd24a'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]); ctx.stroke(); ctx.setLineDash([]);
      for (const p of draft) { ctx.beginPath(); ctx.arc(sx(p[0]), sy(p[1]), 3, 0, Math.PI * 2); ctx.fillStyle = '#ffd24a'; ctx.fill(); }
    }
    ctx.textAlign = 'left';
  }, [project, built, mode, draft, zoneAnchor, selected, resizeTick]);

  // ---- dragging ----
  const screenToWorld = (clientX: number, clientY: number): [number, number] => {
    const canvas = canvasRef.current!;
    const tx = txRef.current!;
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left, py = clientY - rect.top;
    const x = tx.minX + (px - tx.ox) / tx.scale;
    const y = tx.minY + (tx.H - py - tx.oy) / tx.scale;
    return [x, y];
  };

  // Nearest centerline sample to a world point -> (dist along lap, side of track).
  const trackHit = (wx: number, wy: number): { dist: number; side: 'left' | 'right' } => {
    const s = stateRef.current.built.centerline;
    let bi = 0, bd = Infinity;
    for (let i = 0; i < s.length; i++) {
      const d = (s[i].pos[0] - wx) ** 2 + (s[i].pos[1] - wy) ** 2;
      if (d < bd) { bd = d; bi = i; }
    }
    const [lx, ly] = perpLeft(s[bi].heading);
    const lat = (wx - s[bi].pos[0]) * lx + (wy - s[bi].pos[1]) * ly;
    return { dist: s[bi].dist, side: lat >= 0 ? 'left' : 'right' };
  };

  const onMouseDown = (ev: React.MouseEvent) => {
    // Wall-draw mode: each click drops a point on the wall being drawn.
    if (mode === 'wall') {
      setDraft((d) => [...d, screenToWorld(ev.clientX, ev.clientY)]);
      ev.preventDefault();
      return;
    }
    // Zone-select mode: two clicks along the track define a trackside zone.
    if (mode === 'zone') {
      const [wx, wy] = screenToWorld(ev.clientX, ev.clientY);
      const hit = trackHit(wx, wy);
      if (!zoneAnchor) {
        setZoneAnchor(hit);
      } else {
        onZonePicked(Math.min(zoneAnchor.dist, hit.dist), Math.max(zoneAnchor.dist, hit.dist), zoneAnchor.side);
        setZoneAnchor(null);
      }
      ev.preventDefault();
      return;
    }
    // Building mode: drop a building where clicked.
    if (mode === 'building') {
      const [wx, wy] = screenToWorld(ev.clientX, ev.clientY);
      onPlaceBuilding(Math.round(wx), Math.round(wy));
      ev.preventDefault();
      return;
    }
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left, my = ev.clientY - rect.top;
    let hit: Handle | null = null;
    for (const h of handlesRef.current) {
      if (Math.hypot(h.sx - mx, h.sy - my) < 10) { hit = h; break; }
    }
    if (!hit) {
      // No handle under the cursor: clicking near the track selects that
      // SEGMENT for inline editing; clicking empty space deselects.
      const [wx, wy] = screenToWorld(ev.clientX, ev.clientY);
      const s = stateRef.current.built.centerline;
      let bi = 0, bd = Infinity;
      for (let i = 0; i < s.length; i++) {
        const d = (s[i].pos[0] - wx) ** 2 + (s[i].pos[1] - wy) ** 2;
        if (d < bd) { bd = d; bi = i; }
      }
      const nearPx = Math.sqrt(bd) * (txRef.current?.scale ?? 1);
      if (nearPx < 18) {
        const span = stateRef.current.built.spans.find(
          (sp) => s[bi].dist >= sp.startDist && s[bi].dist <= sp.endDist,
        );
        setSelected(span ? span.segIndex : null);
      } else {
        setSelected(null);
      }
      return;
    }
    const seg = stateRef.current.project.segments[hit.segIndex];
    if (!seg || seg.kind !== 'corner') return;
    setSelected(hit.segIndex);
    dragRef.current = { h: hit, startWorld: screenToWorld(ev.clientX, ev.clientY), startRadius: seg.radius };
    window.addEventListener('mousemove', hit.kind === 'escape' ? onEscapeMove : onWindowMove);
    window.addEventListener('mouseup', onWindowUp);
    ev.preventDefault();
  };

  // Drag one escape control node -> write this corner's escapeNodes. Seeds
  // from the current default shape so the first drag starts exactly on it.
  const onEscapeMove = (ev: MouseEvent) => {
    const drag = dragRef.current;
    if (!drag || drag.h.kind !== 'escape') return;
    const { project: proj, built: b, onCornersChange: cb } = stateRef.current;
    const span = b.spans.find((sp) => sp.segIndex === drag.h.segIndex);
    if (!span) return;
    const seg = proj.segments[drag.h.segIndex];
    const frame = escapeControlPoints(b.centerline, span, seg, proj.road.width);
    if (!frame) return;
    const cur = proj.corners.find((c) => c.cornerIndex === drag.h.cornerIndex);
    const nodes: [number, number][] =
      cur?.escapeNodes && cur.escapeNodes.length === 4
        ? cur.escapeNodes.map((p) => [p[0], p[1]])
        : frame.points.map((p) => [p[0], p[1]]);
    nodes[drag.h.nodeIndex!] = screenToWorld(ev.clientX, ev.clientY);
    const corners = proj.corners.map((c) =>
      c.cornerIndex === drag.h.cornerIndex ? { ...c, escapeNodes: nodes } : c,
    );
    cb(corners);
  };

  const onWindowMove = (ev: MouseEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const { project: proj, onSegmentsChange: cb, lockRest: lock } = stateRef.current;
    const seg = proj.segments[drag.h.segIndex];
    if (!seg || seg.kind !== 'corner') return;
    const cur = screenToWorld(ev.clientX, ev.clientY);

    let next: Segment;
    if (drag.h.kind === 'radius') {
      // Outward (away from arc centre) drag increases the radius. Gain is in
      // SCREEN pixels (not world metres), so a zoomed-out map doesn't turn a
      // small mouse move into a huge radius jump.
      const [plx, ply] = perpLeft(drag.h.apexHeading);
      const outSign = drag.h.dir === 'left' ? -1 : 1; // away from centre
      const dx = cur[0] - drag.startWorld[0], dy = cur[1] - drag.startWorld[1];
      const worldDelta = (dx * plx + dy * ply) * outSign;
      const pxDelta = worldDelta * (txRef.current?.scale ?? 1); // metres -> px
      const delta = pxDelta * 0.35; // 0.35 m of radius per pixel dragged
      next = { ...seg, radius: Math.max(1, Math.round((drag.startRadius + delta) * 10) / 10) };
      // LOCAL REPROFILING: segments are chained, so changing a radius normally
      // shifts everything after the corner. With the lock on, absorb the shift
      // in the two NEIGHBOURING STRAIGHTS: the corner's chord displacement is
      // linear in R (chord = R*K), so solving dL1*u_in + dL2*u_out = -dR*K
      // keeps the corner's exit exactly where it was — the rest of the track
      // does not move at all.
      const i = drag.h.segIndex;
      const prev = proj.segments[i - 1];
      const nxt = proj.segments[i + 1];
      if (lock && prev?.kind === 'straight' && nxt?.kind === 'straight' && next.kind === 'corner') {
        const dR = next.radius - seg.radius;
        if (dR !== 0) {
          const th = (seg.angle * Math.PI) / 180;
          const phi = (drag.h.dir === 'left' ? 1 : -1) * th;
          const h0 = drag.h.entryHeading;
          const u1: [number, number] = [Math.cos(h0), Math.sin(h0)];
          const u2: [number, number] = [Math.cos(h0 + phi), Math.sin(h0 + phi)];
          const [nx, ny] = perpLeft(h0);
          const dSign = drag.h.dir === 'left' ? 1 : -1;
          const n0: [number, number] = [nx * dSign, ny * dSign];
          const rot: [number, number] = [
            n0[0] * Math.cos(phi) - n0[1] * Math.sin(phi),
            n0[0] * Math.sin(phi) + n0[1] * Math.cos(phi),
          ];
          const K: [number, number] = [n0[0] - rot[0], n0[1] - rot[1]];
          const det = u1[0] * u2[1] - u1[1] * u2[0]; // sin(phi)
          if (Math.abs(det) > 1e-3) {
            const rx = -dR * K[0], ry = -dR * K[1];
            const dL1 = (rx * u2[1] - ry * u2[0]) / det;
            const dL2 = (u1[0] * ry - u1[1] * rx) / det;
            const L1 = Math.round((prev.length + dL1) * 10) / 10;
            const L2 = Math.round((nxt.length + dL2) * 10) / 10;
            if (L1 >= 2 && L2 >= 2) {
              const segs = proj.segments.map((sg, idx) =>
                idx === i ? next : idx === i - 1 ? { ...prev, length: L1 } : idx === i + 1 ? { ...nxt, length: L2 } : sg,
              );
              cb(segs);
              return;
            }
          }
        }
      }
    } else {
      // Drag the corner's exit around its arc to change the swept angle.
      const r = seg.radius;
      const [plx, ply] = perpLeft(drag.h.entryHeading);
      const inSign = drag.h.dir === 'left' ? 1 : -1; // toward centre
      const cx = drag.h.entry[0] + plx * r * inSign;
      const cy = drag.h.entry[1] + ply * r * inSign;
      const aE = Math.atan2(drag.h.entry[1] - cy, drag.h.entry[0] - cx);
      const aD = Math.atan2(cur[1] - cy, cur[0] - cx);
      let raw = aD - aE;
      if (drag.h.dir === 'right') raw = -raw;
      raw = ((raw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      let deg = Math.max(1, Math.min(350, Math.round((raw * 180) / Math.PI)));
      // rate-limit: the atan2 can snap across the wrap; never jump more than
      // 6 deg per mouse event, so the corner can't flip tiny/huge in one move
      deg = Math.max(seg.angle - 6, Math.min(seg.angle + 6, deg));
      next = { ...seg, angle: deg };
    }
    const segs = proj.segments.map((s, i) => (i === drag.h.segIndex ? next : s));
    cb(segs);
  };

  const onWindowUp = () => {
    dragRef.current = null;
    window.removeEventListener('mousemove', onWindowMove);
    window.removeEventListener('mousemove', onEscapeMove);
    window.removeEventListener('mouseup', onWindowUp);
  };

  // Reset the selected corner's escape shape back to the auto default.
  const resetEscapeShape = () => {
    if (selected === null) return;
    const span = built.spans.find((sp) => sp.segIndex === selected);
    if (!span) return;
    onCornersChange(project.corners.map((c) =>
      c.cornerIndex === span.cornerIndex ? { ...c, escapeNodes: undefined } : c,
    ));
  };
  const selectedCornerCfg = selected !== null
    ? project.corners.find((c) => {
      const sp = built.spans.find((s) => s.segIndex === selected);
      return sp && c.cornerIndex === sp.cornerIndex;
    })
    : undefined;

  const finishWall = () => {
    if (draft.length >= 2) {
      const id = 'wall_' + Date.now().toString(36);
      onManualWallsChange([...(project.manualWalls ?? []), { id, points: draft }]);
    }
    setDraft([]);
  };
  const wallCount = project.manualWalls?.length ?? 0;

  const c = built.closure;
  return (
    <div className="editor2d">
      <div className="canvas-wrap">
        <canvas ref={canvasRef} onMouseDown={onMouseDown} style={{ cursor: mode === 'shape' ? 'crosshair' : 'copy' }} />
      </div>
      <div className="closure-bar">
        <span className="mode-toggle">
          <button className={mode === 'shape' ? 'active' : ''} onClick={() => { setMode('shape'); setDraft([]); setZoneAnchor(null); }}>Shape</button>
          <button className={mode === 'zone' ? 'active' : ''} onClick={() => { setMode('zone'); setDraft([]); }}>Select strip</button>
          <button className={mode === 'wall' ? 'active' : ''} onClick={() => { setMode('wall'); setZoneAnchor(null); }}>Draw wall</button>
          <button className={mode === 'building' ? 'active' : ''} onClick={() => { setMode('building'); setDraft([]); setZoneAnchor(null); }}>Place building</button>
        </span>
        {mode === 'shape' && (
          <>
            <span className={c.closed ? 'ok' : 'warn'}>
              Gap: {c.gap.toFixed(1)} m · off {c.headingOff.toFixed(0)}° {c.closed ? '✓' : '✕'}
            </span>
            {selected !== null && project.segments[selected] ? (
              <span className="seg-inline-edit">
                {(() => {
                  const sSel = project.segments[selected];
                  const patch = (p: Partial<Segment>) =>
                    onSegmentsChange(project.segments.map((sg, i) => (i === selected ? ({ ...sg, ...p } as Segment) : sg)));
                  return sSel.kind === 'corner' ? (
                    <>
                      <b>corner</b>
                      <label>R
                        <input type="number" min={1} step={1} value={sSel.radius}
                          onChange={(e) => patch({ radius: Math.max(1, Number(e.target.value)) })} />
                      </label>
                      <label>angle°
                        <input type="number" min={1} max={350} step={1} value={sSel.angle}
                          onChange={(e) => patch({ angle: Math.max(1, Math.min(350, Number(e.target.value))) })} />
                      </label>
                      <select value={sSel.dir} onChange={(e) => patch({ dir: e.target.value as 'left' | 'right' })}>
                        <option value="left">left</option>
                        <option value="right">right</option>
                      </select>
                    </>
                  ) : (
                    <>
                      <b>straight</b>
                      <label>length
                        <input type="number" min={2} step={1} value={sSel.length}
                          onChange={(e) => patch({ length: Math.max(2, Number(e.target.value)) })} />
                      </label>
                    </>
                  );
                })()}
                <button className="small" onClick={() => setSelected(null)}>✕</button>
              </span>
            ) : (
              <span className="muted hint">click a segment to edit · drag ● radius · ○ angle · ▢ escape nodes</span>
            )}
            {selectedCornerCfg && escapeTypeOf(selectedCornerCfg) !== 'none' && selectedCornerCfg.escapeNodes && (
              <button className="small" onClick={resetEscapeShape} title="Reset this corner's escape road to its default shape">
                reset escape shape
              </button>
            )}
            <label className="checkbox" title="While dragging a corner's radius, adjust the two neighbouring straights so the REST of the track stays exactly where it is">
              <input type="checkbox" checked={lockRest} onChange={(e) => setLockRest(e.target.checked)} />
              lock rest
            </label>
            <button onClick={onCloseLoop}>Close loop</button>
          </>
        )}
        {mode === 'zone' && (
          <span className="muted hint">
            {zoneAnchor
              ? `start set at ${Math.round(zoneAnchor.dist)} m (${zoneAnchor.side}) — click the end of the stretch`
              : 'click the START of the stretch, on the side you want (left/right of the road)'}
          </span>
        )}
        {mode === 'wall' && (
          <>
            <span className="muted hint">click to drop points · {wallCount} wall(s)</span>
            <button onClick={() => setDraft((d) => d.slice(0, -1))} disabled={!draft.length}>Undo pt</button>
            <button onClick={finishWall} disabled={draft.length < 2}>Finish wall</button>
            <button className="danger" onClick={() => onManualWallsChange([])} disabled={!wallCount}>Clear walls</button>
          </>
        )}
        {mode === 'building' && (
          <span className="muted hint">click anywhere to drop a building — tune size/rotation in the Facilities tab</span>
        )}
      </div>
    </div>
  );
}
