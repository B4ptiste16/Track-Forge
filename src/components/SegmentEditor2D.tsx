import { useEffect, useRef, useState } from 'react';
import type { TrackProject, Segment, ManualWall } from '../types';
import type { BuiltTrack } from '../geometry';
import { perpLeft } from '../geometry';
import { THEME_PALETTES } from '../state/project';

type EditorMode = 'shape' | 'wall';

interface Props {
  project: TrackProject;
  built: BuiltTrack;
  onCloseLoop: () => void;
  onSegmentsChange: (segs: Segment[]) => void;
  onManualWallsChange: (walls: ManualWall[]) => void;
}

interface Transform { minX: number; minY: number; scale: number; ox: number; oy: number; H: number; }
interface Handle {
  segIndex: number;
  kind: 'radius' | 'angle';
  sx: number; sy: number; // screen
  apexHeading: number;
  entry: [number, number];
  entryHeading: number;
  dir: 'left' | 'right';
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

export function SegmentEditor2D({ project, built, onCloseLoop, onSegmentsChange, onManualWallsChange }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const txRef = useRef<Transform | null>(null);
  const handlesRef = useRef<Handle[]>([]);
  const dragRef = useRef<{ h: Handle; startWorld: [number, number]; startRadius: number } | null>(null);
  const [mode, setMode] = useState<EditorMode>('shape');
  const [draft, setDraft] = useState<[number, number][]>([]);
  // Keep latest project/built/callback for window-level drag handlers.
  const stateRef = useRef({ project, built, onSegmentsChange });
  stateRef.current = { project, built, onSegmentsChange };

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
  }, [project, built, mode, draft]);

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

  const onMouseDown = (ev: React.MouseEvent) => {
    // Wall-draw mode: each click drops a point on the wall being drawn.
    if (mode === 'wall') {
      setDraft((d) => [...d, screenToWorld(ev.clientX, ev.clientY)]);
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
    if (!hit) return;
    const seg = stateRef.current.project.segments[hit.segIndex];
    if (!seg || seg.kind !== 'corner') return;
    dragRef.current = { h: hit, startWorld: screenToWorld(ev.clientX, ev.clientY), startRadius: seg.radius };
    window.addEventListener('mousemove', onWindowMove);
    window.addEventListener('mouseup', onWindowUp);
    ev.preventDefault();
  };

  const onWindowMove = (ev: MouseEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const { project: proj, onSegmentsChange: cb } = stateRef.current;
    const seg = proj.segments[drag.h.segIndex];
    if (!seg || seg.kind !== 'corner') return;
    const cur = screenToWorld(ev.clientX, ev.clientY);

    let next: Segment;
    if (drag.h.kind === 'radius') {
      // Outward (away from arc centre) drag increases the radius.
      const [plx, ply] = perpLeft(drag.h.apexHeading);
      const outSign = drag.h.dir === 'left' ? -1 : 1; // away from centre
      const dx = cur[0] - drag.startWorld[0], dy = cur[1] - drag.startWorld[1];
      const delta = (dx * plx + dy * ply) * outSign;
      next = { ...seg, radius: Math.max(5, Math.round((drag.startRadius + delta) * 10) / 10) };
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
      const deg = Math.max(1, Math.min(350, Math.round((raw * 180) / Math.PI)));
      next = { ...seg, angle: deg };
    }
    const segs = proj.segments.map((s, i) => (i === drag.h.segIndex ? next : s));
    cb(segs);
  };

  const onWindowUp = () => {
    dragRef.current = null;
    window.removeEventListener('mousemove', onWindowMove);
    window.removeEventListener('mouseup', onWindowUp);
  };

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
        <canvas ref={canvasRef} onMouseDown={onMouseDown} style={{ cursor: mode === 'wall' ? 'copy' : 'crosshair' }} />
      </div>
      <div className="closure-bar">
        <span className="mode-toggle">
          <button className={mode === 'shape' ? 'active' : ''} onClick={() => { setMode('shape'); setDraft([]); }}>Shape</button>
          <button className={mode === 'wall' ? 'active' : ''} onClick={() => setMode('wall')}>Draw wall</button>
        </span>
        {mode === 'shape' ? (
          <>
            <span className={c.closed ? 'ok' : 'warn'}>
              Gap: {c.gap.toFixed(1)} m · off {c.headingOff.toFixed(0)}° {c.closed ? '✓' : '✕'}
            </span>
            <span className="muted hint">drag ● radius · ○ angle</span>
            <button onClick={onCloseLoop}>Close loop</button>
          </>
        ) : (
          <>
            <span className="muted hint">click to drop points · {wallCount} wall(s)</span>
            <button onClick={() => setDraft((d) => d.slice(0, -1))} disabled={!draft.length}>Undo pt</button>
            <button onClick={finishWall} disabled={draft.length < 2}>Finish wall</button>
            <button className="danger" onClick={() => onManualWallsChange([])} disabled={!wallCount}>Clear walls</button>
          </>
        )}
      </div>
    </div>
  );
}
