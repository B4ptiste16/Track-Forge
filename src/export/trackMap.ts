// TRACK MAP + MENU ART.
//
// Assetto Corsa needs two separate things that both come from the same shape:
//   map.png + data/map.ini  — the LIVE minimap. AC draws the car's dot onto this
//                             image using the ini's offsets/scale, so the two
//                             must agree exactly or the dot sits off the track.
//   ui/outline.png          — the shape shown next to the track in the menus.
//   ui/preview.png          — the picture of the track in the menus.
// Without these AC shows no image for the track and no map while driving, which
// is what "there is no track map" means: the files simply were not there.
import type { BuiltTrack } from '../geometry';
import type { TrackProject } from '../types';
import { THEME_PALETTES } from '../state/project';

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const b64 = dataUrl.split(',')[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

// The lap in AC's world frame. Native XY is Z-up; AC is Y-up, so its ground
// plane is (x, z) where z = -y — the same conversion the FBX and the AI line
// use. Getting this wrong is what puts a minimap dot on the wrong side.
function acGroundPath(built: BuiltTrack): { x: number; z: number }[] {
  return built.centerline.map((s) => ({ x: s.pos[0], z: -s.pos[1] }));
}

export interface TrackMapFiles {
  mapPng: Uint8Array;
  mapIni: string;
  outlinePng: Uint8Array;
  previewPng: Uint8Array;
}

const MARGIN = 20;      // px of blank space around the track, as Kunos maps use
const DRAWING_SIZE = 10; // AC's own line-thickness hint, echoed into map.ini

/**
 * Draw the minimap and the menu art, and write the ini that calibrates them.
 *
 * `scale` is px per metre. 0.5 keeps a 5 km circuit near 1200 px — big enough
 * to read, small enough that AC isn't loading a huge texture for a HUD element.
 */
export function genTrackMap(built: BuiltTrack, project: TrackProject, scale = 0.5): TrackMapFiles {
  const pts = acGroundPath(built);
  const width = Math.max(1, project.road.width);

  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  // Room for the track's own width, so a ribbon at the edge isn't clipped.
  const pad = width;
  minX -= pad; maxX += pad; minZ -= pad; maxZ += pad;

  const w = Math.ceil((maxX - minX) * scale) + MARGIN * 2;
  const h = Math.ceil((maxZ - minZ) * scale) + MARGIN * 2;
  // AC maps a world point to the image as (world + OFFSET) * SCALE_FACTOR, so
  // these offsets are what put minX/minZ at exactly MARGIN pixels in.
  const xOffset = -minX + MARGIN / scale;
  const zOffset = -minZ + MARGIN / scale;
  const toPx = (p: { x: number; z: number }) => ({
    x: (p.x + xOffset) * scale,
    y: (p.z + zOffset) * scale,
  });

  // --- map.png: white ribbon on transparent, exactly what AC expects --------
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(2, width * scale);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  pts.forEach((p, i) => {
    const q = toPx(p);
    if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
  });
  if (built.closure.closed) ctx.closePath();
  ctx.stroke();
  const mapPng = dataUrlToBytes(c.toDataURL('image/png'));

  const mapIni = `[PARAMETERS]
WIDTH=${w}
HEIGHT=${h}
MARGIN=${MARGIN}
SCALE_FACTOR=${scale}
X_OFFSET=${xOffset.toFixed(3)}
Z_OFFSET=${zOffset.toFixed(3)}
DRAWING_SIZE=${DRAWING_SIZE}
`;

  // --- ui/outline.png: the shape shown beside the track in the menus --------
  const OUT = 512;
  const oc = document.createElement('canvas');
  oc.width = OUT; oc.height = OUT;
  const octx = oc.getContext('2d')!;
  octx.clearRect(0, 0, OUT, OUT);
  const spanX = maxX - minX, spanZ = maxZ - minZ;
  const fit = (OUT - 48) / Math.max(spanX, spanZ);
  const ox = (OUT - spanX * fit) / 2, oy = (OUT - spanZ * fit) / 2;
  const toOut = (p: { x: number; z: number }) => ({
    x: ox + (p.x - minX) * fit, y: oy + (p.z - minZ) * fit,
  });
  octx.strokeStyle = '#ffffff';
  octx.lineWidth = Math.max(3, width * fit);
  octx.lineJoin = 'round'; octx.lineCap = 'round';
  octx.beginPath();
  pts.forEach((p, i) => {
    const q = toOut(p);
    if (i === 0) octx.moveTo(q.x, q.y); else octx.lineTo(q.x, q.y);
  });
  if (built.closure.closed) octx.closePath();
  octx.stroke();
  const outlinePng = dataUrlToBytes(oc.toDataURL('image/png'));

  // --- ui/preview.png: the track's picture in the menus ---------------------
  // A drawn map rather than a screenshot: it always matches the circuit, and a
  // sketch of the real layout tells you more at a glance than a photo of one
  // corner would. 1024x575 is the size AC's menus expect.
  const PW = 1024, PH = 575;
  const pc = document.createElement('canvas');
  pc.width = PW; pc.height = PH;
  const pctx = pc.getContext('2d')!;
  const pal = THEME_PALETTES[project.meta.theme];
  const g = pctx.createLinearGradient(0, 0, 0, PH);
  g.addColorStop(0, pal.grass ?? '#2f4a22');
  g.addColorStop(1, '#1b2a14');
  pctx.fillStyle = g;
  pctx.fillRect(0, 0, PW, PH);

  const pfit = Math.min((PW - 150) / spanX, (PH - 110) / spanZ);
  const px0 = (PW - spanX * pfit) / 2, py0 = (PH - spanZ * pfit) / 2 + 10;
  const toPrev = (p: { x: number; z: number }) => ({
    x: px0 + (p.x - minX) * pfit, y: py0 + (p.z - minZ) * pfit,
  });
  const ribbon = (lw: number, style: string) => {
    pctx.strokeStyle = style;
    pctx.lineWidth = lw;
    pctx.lineJoin = 'round'; pctx.lineCap = 'round';
    pctx.beginPath();
    pts.forEach((p, i) => {
      const q = toPrev(p);
      if (i === 0) pctx.moveTo(q.x, q.y); else pctx.lineTo(q.x, q.y);
    });
    if (built.closure.closed) pctx.closePath();
    pctx.stroke();
  };
  const lw = Math.max(6, width * pfit);
  ribbon(lw + 8, 'rgba(0,0,0,0.35)');       // soft edge so it reads on grass
  ribbon(lw, pal.road ?? '#3a3a3d');        // the tarmac
  pctx.setLineDash([10, 12]);
  ribbon(1.5, 'rgba(255,255,255,0.35)');    // hint of a centre line
  pctx.setLineDash([]);

  // start/finish marker
  if (pts.length > 2) {
    const q = toPrev(pts[0]);
    pctx.strokeStyle = '#ffffff';
    pctx.lineWidth = 3;
    pctx.beginPath();
    pctx.arc(q.x, q.y, lw * 0.9, 0, Math.PI * 2);
    pctx.stroke();
  }

  pctx.fillStyle = 'rgba(0,0,0,0.55)';
  pctx.fillRect(0, PH - 64, PW, 64);
  pctx.fillStyle = '#ffffff';
  pctx.font = 'bold 30px sans-serif';
  pctx.fillText(project.meta.name || 'Circuit', 26, PH - 26);
  pctx.font = '18px sans-serif';
  pctx.fillStyle = 'rgba(255,255,255,0.75)';
  const km = (built.totalLength / 1000).toFixed(2);
  const corners = built.spans.filter((s) => s.kind === 'corner').length;
  pctx.fillText(`${km} km · ${corners} corners`, PW - 240, PH - 26);
  const previewPng = dataUrlToBytes(pc.toDataURL('image/png'));

  return { mapPng, mapIni, outlinePng, previewPng };
}
