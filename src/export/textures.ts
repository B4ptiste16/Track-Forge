import type { BuiltTrack } from '../geometry';
import type { Theme, WallStyle } from '../types';
import { meshColor, type Palette } from '../state/project';
import { ADVERT_ASPECT } from '../geometry/runoff';
import { KERB_PATTERNS } from '../geometry/kerbs';
import { SEAT_PATTERNS, TREE_ATLAS, LIGHTS_ASPECT } from '../geometry/decor';

export interface TexFile {
  path: string; // e.g. texture/road.png (the subfolder KsEditor searches)
  name: string; // e.g. road.png
  surface: string; // e.g. 1ROAD
  bytes: Uint8Array;
}

// 512² instead of 256²: 4x the pixels, so surfaces hold up when the camera is
// close to the ground (the old ones went mushy under the car). Feature COUNTS
// scale with the area via dens(), otherwise a bigger canvas would just look
// like the same texture blurred up rather than a more detailed one.
const SIZE = 512;
const S = SIZE / 256; // linear scale vs the original authoring size
const dens = (base: number) => Math.round(base * S * S); // per-area feature count
const px = (n: number) => n * S; // a length authored at 256 -> this canvas
const TRICOLORE = ['#0055A4', '#f2f2f2', '#EF4135'];

// Short texture filename for a surface mesh name (1ROAD -> road).
function shortName(meshName: string): string {
  return meshName.replace(/^1/, '').toLowerCase();
}

// The texture PNG that goes with a mesh — also referenced from inside the FBX
// so ksEditor auto-assigns txDiffuse on import (the Race Track Builder way).
export function textureFileName(meshName: string): string {
  return `${shortName(meshName)}.png`;
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const b64 = dataUrl.split(',')[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

// Per-pixel brightness noise over the whole canvas.
function grain(ctx: CanvasRenderingContext2D, amount: number): void {
  const img = ctx.getImageData(0, 0, SIZE, SIZE);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 2 * amount;
    img.data[i] = Math.max(0, Math.min(255, img.data[i] + n));
    img.data[i + 1] = Math.max(0, Math.min(255, img.data[i + 1] + n));
    img.data[i + 2] = Math.max(0, Math.min(255, img.data[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);
}

function speckle(ctx: CanvasRenderingContext2D, count: number, size: [number, number], alpha: number, light: boolean): void {
  for (let i = 0; i < count; i++) {
    const v = light ? 255 : 0;
    ctx.fillStyle = `rgba(${v},${v},${v},${alpha * (0.4 + Math.random() * 0.6)})`;
    const r = size[0] + Math.random() * (size[1] - size[0]);
    const x = Math.random() * SIZE, y = Math.random() * SIZE;
    // Wrapped: an unwrapped dot is sliced in half at the tile edge, and that
    // slice repeats across the ground as a line. speckle feeds concrete, road,
    // tarmac and gravel, so this was a seam on all of them.
    wrap(x, y, r + 1, (wx, wy) => {
      ctx.beginPath();
      ctx.arc(wx, wy, r, 0, Math.PI * 2);
      ctx.fill();
    });
  }
}

function bandsAcross(ctx: CanvasRenderingContext2D, colors: string[]): void {
  const w = SIZE / colors.length;
  colors.forEach((col, i) => {
    ctx.fillStyle = col;
    ctx.fillRect(Math.round(i * w), 0, Math.ceil(w), SIZE);
  });
}


// SEAMLESS DRAWING. A texture tiles every few metres, so anything drawn near an
// edge is chopped in half and the cut shows up as a hard line repeating across
// the ground. Drawing the same feature again offset by a full tile makes the
// half that fell off one edge reappear on the opposite one, so the pattern
// joins up invisibly. Only the copies that can actually be visible are drawn.
function wrap(x: number, y: number, r: number, fn: (x: number, y: number) => void): void {
  fn(x, y);
  const l = x < r, rt = x > SIZE - r, t = y < r, b = y > SIZE - r;
  if (l) fn(x + SIZE, y);
  if (rt) fn(x - SIZE, y);
  if (t) fn(x, y + SIZE);
  if (b) fn(x, y - SIZE);
  if (l && t) fn(x + SIZE, y + SIZE);
  if (l && b) fn(x + SIZE, y - SIZE);
  if (rt && t) fn(x - SIZE, y + SIZE);
  if (rt && b) fn(x - SIZE, y - SIZE);
}

// One blade of grass: a tapered sliver leaning off vertical, drawn from its root.
function blade(ctx: CanvasRenderingContext2D, x: number, y: number, len: number,
               wid: number, lean: number, col: string): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(lean);
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.moveTo(-wid / 2, 0);
  ctx.lineTo(wid / 2, 0);
  ctx.lineTo(wid * 0.12, -len);   // tapers to a point
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// Draw the texture for one surface. Rich enough to read as a material in-game;
// the UVs exported in the FBX make stripes/bands land where they should.
// ---------------------------------------------------------------------------
// SHADING TOOLKIT
//
// The generators used to be flat fillRect blocks, and that - far more than the
// resolution - is what made the track read as generated. A painted grey stripe
// cannot look like a curved Armco beam; it needs a gradient across its height
// so the eye reads a cylinder. Real surfaces also carry dirt where water runs,
// darkness where two parts meet, and a highlight on the edge that faces the
// sky. These helpers supply exactly those four things.
// ---------------------------------------------------------------------------

type RGB = [number, number, number];

function shade(c: RGB, k: number, a = 1): string {
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v * k)));
  return `rgba(${f(c[0])},${f(c[1])},${f(c[2])},${a})`;
}

// Vertical gradient over a band, from c0 at y0 to c1 at y1.
function vgrad(ctx: CanvasRenderingContext2D, y0: number, y1: number, stops: [number, string][]): void {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  for (const [t, col] of stops) g.addColorStop(Math.max(0, Math.min(1, t)), col);
  ctx.fillStyle = g;
  ctx.fillRect(0, Math.min(y0, y1), SIZE, Math.abs(y1 - y0));
}

// A horizontal bar lit as a CYLINDER: dark at both edges, hot highlight just
// above centre. This is what turns a flat stripe into a rolled steel beam.
function cylBar(ctx: CanvasRenderingContext2D, y0: number, h: number, base: RGB): void {
  vgrad(ctx, y0, y0 + h, [
    [0, shade(base, 0.45)],
    [0.18, shade(base, 0.8)],
    [0.34, shade(base, 1.35)],
    [0.5, shade(base, 1.08)],
    [0.82, shade(base, 0.66)],
    [1, shade(base, 0.38)],
  ]);
}

// Ambient occlusion: a soft dark falloff along one edge of a rectangle. `dir`
// is the direction the shadow spreads INTO the shape.
function ao(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number,
  dir: 'down' | 'up' | 'right' | 'left', strength = 0.45): void {
  const horiz = dir === 'left' || dir === 'right';
  const g = horiz
    ? ctx.createLinearGradient(dir === 'right' ? x : x + w, 0, dir === 'right' ? x + w : x, 0)
    : ctx.createLinearGradient(0, dir === 'down' ? y : y + h, 0, dir === 'down' ? y + h : y);
  g.addColorStop(0, `rgba(0,0,0,${strength})`);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
}

// Vertical weathering: rain and dirt running DOWN a surface, strongest under
// whatever it ran off. Tapers out, never a hard line.
function streaks(ctx: CanvasRenderingContext2D, count: number, yFrom: number, len: number, alpha: number): void {
  for (let i = 0; i < count; i++) {
    const x = Math.random() * SIZE;
    const w = px(0.6) + Math.random() * px(2.4);
    const l = len * (0.35 + Math.random() * 0.9);
    const g = ctx.createLinearGradient(0, yFrom, 0, yFrom + l);
    g.addColorStop(0, `rgba(30,26,20,${alpha})`);
    g.addColorStop(1, 'rgba(30,26,20,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x, yFrom, w, l);
  }
}

// Grime gathering at the foot of a vertical surface - every real barrier has it.
function groundGrime(ctx: CanvasRenderingContext2D, height = 0.26, alpha = 0.5): void {
  vgrad(ctx, SIZE * (1 - height), SIZE, [
    [0, 'rgba(42,36,28,0)'],
    [0.55, `rgba(42,36,28,${alpha * 0.5})`],
    [1, `rgba(28,24,18,${alpha})`],
  ]);
}

// A bolt / rivet head with its own tiny highlight and drop shadow.
function bolt(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.beginPath(); ctx.arc(x + r * 0.25, y + r * 0.3, r, 0, Math.PI * 2); ctx.fill();
  const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.35, r * 0.1, x, y, r);
  g.addColorStop(0, 'rgba(236,238,242,0.95)');
  g.addColorStop(0.65, 'rgba(150,155,163,0.9)');
  g.addColorStop(1, 'rgba(92,96,104,0.9)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
}

// Scuffed rubber where cars have brushed a barrier.
function rubberScuff(ctx: CanvasRenderingContext2D, count: number, yc: number, spread: number): void {
  // Clustered and TAPERED. Evenly scattered hard-edged dashes read as dirt
  // speckle floating on the surface rather than rubber laid down by a car.
  const clusters = Math.max(1, Math.round(count / 4));
  for (let c = 0; c < clusters; c++) {
    const cx = Math.random() * SIZE;
    const cy = yc + (Math.random() - 0.5) * spread;
    for (let i = 0; i < 4; i++) {
      const x = cx + (Math.random() - 0.5) * px(26);
      const y = cy + (Math.random() - 0.5) * px(10);
      const w = px(8) + Math.random() * px(34);
      const h = px(1) + Math.random() * px(2.4);
      const g = ctx.createLinearGradient(x, 0, x + w, 0);
      const a = 0.1 + Math.random() * 0.26;
      g.addColorStop(0, 'rgba(18,16,16,0)');
      g.addColorStop(0.4, `rgba(18,16,16,${a})`);
      g.addColorStop(1, 'rgba(18,16,16,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x, y, w, h);
    }
  }
}

// Tyre marks on 6-m-per-tile planar ground (85 px/m). Each car leaves two
// marks ~1.5 m apart, each ~0.25 m wide with a soft edge, fading in and out
// along a ~6 m arc. The arc is anchored on a point INSIDE the tile: at a real
// 9-23 m radius its centre lies far outside, and a random sweep about that
// centre mostly missed the tile, so the marks often never appeared. Drawn at
// all nine tile offsets so it tiles; wrap() only shifts one tile, for small
// features centred in the tile.
function tyreMarks(ctx: CanvasRenderingContext2D, cars: number, alpha: number): void {
  const M = SIZE / 6;
  for (let i = 0; i < cars; i++) {
    const ax = Math.random() * SIZE, ay = Math.random() * SIZE;
    const r = M * (9 + Math.random() * 14);
    const th = Math.random() * Math.PI * 2;
    const cx = ax - Math.cos(th) * r, cy = ay - Math.sin(th) * r;
    const half = (M * 3) / r;
    const SEG = 14;
    for (const off of [0, M * 1.5]) {
      for (const [w, a] of [[M * 0.3, alpha * 0.45], [M * 0.18, alpha]] as [number, number][]) {
        ctx.lineWidth = w;
        for (let k = 0; k < SEG; k++) {
          const t0 = th - half + (2 * half * k) / SEG, t1 = t0 + (2 * half) / SEG;
          const fade = Math.sin(((k + 0.5) / SEG) * Math.PI);  // in and out
          ctx.strokeStyle = `rgba(16,15,15,${(a * fade).toFixed(3)})`;
          for (let dx = -SIZE; dx <= SIZE; dx += SIZE) {
            for (let dy = -SIZE; dy <= SIZE; dy += SIZE) {
              ctx.beginPath(); ctx.arc(cx + dx, cy + dy, r + off, t0, t1); ctx.stroke();
            }
          }
        }
      }
    }
  }
}

export function drawTexture(surface: string, hex: string, theme: Theme, wallStyle: WallStyle): string {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = hex;
  ctx.fillRect(0, 0, SIZE, SIZE);

  switch (surface) {
    case '1ROAD':
    case '1PIT': {
      // ASPHALT = stones in binder. The broad tonal patches used to run at
      // alpha 0.5 and dens(14) - 56 overlapping blobs - which read as a
      // stained carpet and swamped the aggregate underneath. The stones are
      // the texture; the patches are a whisper on top of them.
      const [rr, gg, bb] = hexRgb(hex);
      grain(ctx, 9);
      // Each stone gets a lit cap and a shadow offset, which is what makes a
      // flat speckle read as chippings with depth.
      for (let i = 0; i < dens(1500); i++) {
        const x = Math.random() * SIZE, y = Math.random() * SIZE;
        const r = px(0.35) + Math.random() * px(1.5);
        const d = -26 + Math.random() * 62;
        ctx.fillStyle = `rgba(0,0,0,${0.1 + Math.random() * 0.18})`;
        ctx.fillRect(x + r * 0.45, y + r * 0.5, r * 1.5, r * 1.3);
        ctx.fillStyle = `rgba(${rr + d},${gg + d},${bb + d},${0.45 + Math.random() * 0.45})`;
        ctx.fillRect(x, y, r * 1.5, r * 1.3);
      }
      for (let i = 0; i < dens(120); i++) { // coarser chippings catching light
        const x = Math.random() * SIZE, y = Math.random() * SIZE;
        const r = px(1.4) + Math.random() * px(1.9);
        ctx.fillStyle = `rgba(0,0,0,0.26)`;
        ctx.fillRect(x + r * 0.4, y + r * 0.45, r, r * 0.9);
        const d = 16 + Math.random() * 46;
        ctx.fillStyle = `rgba(${rr + d},${gg + d},${bb + d},0.6)`;
        ctx.fillRect(x, y, r, r * 0.9);
      }
      speckle(ctx, dens(420), [px(0.3), px(0.8)], 0.14, false); // binder pitting
      for (let i = 0; i < dens(4); i++) {   // laid in passes - barely-there tone
        const x = Math.random() * SIZE, y = Math.random() * SIZE, rad = px(40 + Math.random() * 70);
        const d = -5 + Math.random() * 10;
        const gr = ctx.createRadialGradient(x, y, 1, x, y, rad);
        gr.addColorStop(0, `rgba(${rr + d},${gg + d},${bb + d},0.12)`);
        gr.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gr;
        ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill();
      }
      break;
    }
    case '1GRASS': {
      // Grass seen from a car: you should read individual blades and the dark
      // soil between them, not a flat green field with speckles on it. Built in
      // depth order — soil, shadowed under-layer, the bulk of the sward, then a
      // few bright tips catching the light — and every blade is wrapped, so the
      // texture tiles without a seam.
      const [gr, gg, gb] = hexRgb(hex);
      const soil = `rgb(${Math.max(0, gr - 26)},${Math.max(0, gg - 34)},${Math.max(0, gb - 22)})`;
      ctx.fillStyle = soil;
      ctx.fillRect(0, 0, SIZE, SIZE);

      // patchiness: mown bands and richer clumps, so it isn't one even tone
      for (let i = 0; i < dens(22); i++) {
        const x = Math.random() * SIZE, y = Math.random() * SIZE, rad = px(16 + Math.random() * 44);
        const d = -14 + Math.random() * 26;
        wrap(x, y, rad, (wx, wy) => {
          const g2 = ctx.createRadialGradient(wx, wy, 1, wx, wy, rad);
          g2.addColorStop(0, `rgba(${gr + d},${gg + d + 8},${gb + d},0.5)`);
          g2.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = g2;
          ctx.beginPath(); ctx.arc(wx, wy, rad, 0, Math.PI * 2); ctx.fill();
        });
      }

      // Three passes of blades. Roots are scattered, each blade leans a
      // different way, and length/tone vary — that variation is what stops it
      // reading as a dotted pattern.
      const pass = (count: number, lo: number, hi: number, dMin: number, dMax: number, alpha: number) => {
        for (let i = 0; i < count; i++) {
          const x = Math.random() * SIZE, y = Math.random() * SIZE;
          const len = px(lo + Math.random() * (hi - lo));
          const wid = px(0.7 + Math.random() * 0.8);
          const lean = (Math.random() - 0.5) * 1.3;
          const d = dMin + Math.random() * (dMax - dMin);
          const col = `rgba(${Math.max(0, gr + d)},${Math.max(0, gg + d)},${Math.max(0, gb + d)},${alpha})`;
          wrap(x, y, len + wid, (wx, wy) => blade(ctx, wx, wy, len, wid, lean, col));
        }
      };
      pass(dens(1500), 3, 7, -40, -22, 1);    // shaded under-layer, deep in the sward
      pass(dens(2000), 4, 10, -14, 10, 1);    // the body of the grass
      pass(dens(900), 5, 12, 18, 40, 0.95);   // tips catching the light

      // a few dry patches and seed heads for variety
      for (let i = 0; i < dens(6); i++) {
        const x = Math.random() * SIZE, y = Math.random() * SIZE, rad = px(5 + Math.random() * 10);
        wrap(x, y, rad, (wx, wy) => {
          ctx.fillStyle = `rgba(${gr + 40},${gg + 26},${gb - 8},0.20)`;
          ctx.beginPath();
          ctx.ellipse(wx, wy, rad, rad * 0.6, Math.random() * Math.PI, 0, Math.PI * 2);
          ctx.fill();
        });
      }
      grain(ctx, 7);
      break;
    }
    case '1SAND': { // gravel trap
      grain(ctx, 8);
      const [r, g, b] = hexRgb(hex);
      // 1) DRAG MARKS: a used trap is raked into ruts and scored by cars that
      //    ploughed through it. Baked in, because AC can't deform a surface at
      //    runtime — this is what gives the "cars have been through here" read.
      for (let i = 0; i < dens(9); i++) {
        const x0 = Math.random() * SIZE, y0 = Math.random() * SIZE;
        const ang = (Math.random() - 0.5) * 0.5;
        const w = px(5 + Math.random() * 9), len = px(60 + Math.random() * 180);
        wrap(x0, y0, len, (wx, wy) => {
          ctx.save();
          ctx.translate(wx, wy);
          ctx.rotate(ang);
          ctx.fillStyle = 'rgba(0,0,0,0.16)'; // gouged trough
          ctx.fillRect(-len / 2, 0, len, w);
          ctx.fillStyle = `rgba(${r + 30},${g + 26},${b + 20},0.35)`; // thrown-up ridge
          ctx.fillRect(-len / 2, -px(2), len, px(2.5));
          ctx.fillRect(-len / 2, w, len, px(2.5));
          ctx.restore();
        });
      }
      // 2) pebbles: lit body + darker under-edge, several size classes
      for (let i = 0; i < dens(1100); i++) {
        const pr = px(0.8 + Math.random() * (Math.random() < 0.12 ? 4.2 : 2.0));
        const x = Math.random() * SIZE, y = Math.random() * SIZE;
        const d = -24 + Math.random() * 62;
        wrap(x, y, pr + px(1), (wx, wy) => {
          ctx.fillStyle = `rgb(${r + d},${g + d},${b + d})`;
          ctx.beginPath(); ctx.arc(wx, wy, pr, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = 'rgba(0,0,0,0.22)';
          ctx.beginPath(); ctx.arc(wx, wy + pr * 0.35, pr * 0.85, 0, Math.PI * 2); ctx.fill();
        });
      }
      break;
    }
    case '1CONCRETE': {
      const [cr, cg, cb] = hexRgb(hex);
      grain(ctx, 6);
      // Cast concrete is blotchy: pours cure at different rates and it stains.
      // Wrapped, so the blotches carry across the tile edge instead of stopping.
      for (let i = 0; i < dens(16); i++) {
        const x = Math.random() * SIZE, y = Math.random() * SIZE, rad = px(14 + Math.random() * 40);
        const d = -12 + Math.random() * 20;
        wrap(x, y, rad, (wx, wy) => {
          const g2 = ctx.createRadialGradient(wx, wy, 1, wx, wy, rad);
          g2.addColorStop(0, `rgba(${cr + d},${cg + d},${cb + d},0.45)`);
          g2.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = g2;
          ctx.beginPath(); ctx.arc(wx, wy, rad, 0, Math.PI * 2); ctx.fill();
        });
      }
      speckle(ctx, dens(350), [px(0.4), px(1.0)], 0.10, false);
      // Fine surface cracks, wrapped so they run on across tiles.
      for (let i = 0; i < dens(7); i++) {
        const x = Math.random() * SIZE, y = Math.random() * SIZE;
        const len = px(20 + Math.random() * 50), ang = Math.random() * Math.PI;
        wrap(x, y, len, (wx, wy) => {
          ctx.strokeStyle = 'rgba(0,0,0,0.16)';
          ctx.lineWidth = px(0.6);
          ctx.beginPath();
          ctx.moveTo(wx, wy);
          let px2 = wx, py2 = wy, a = ang;
          for (let k = 0; k < 5; k++) {
            a += (Math.random() - 0.5) * 0.8;
            px2 += Math.cos(a) * len / 5; py2 += Math.sin(a) * len / 5;
            ctx.lineTo(px2, py2);
          }
          ctx.stroke();
        });
      }
      // NO slab joints. They were drawn on the tile edges so neighbouring tiles
      // would share one — but a hard dark line at every tile boundary is
      // indistinguishable from a seam, which is precisely what it looked like.
      // Cast concrete run-off is continuous anyway; its character comes from the
      // blotches and cracks above, all of which wrap.
      // Saw-cut expansion joints every 3 m (one tile is 6 m), and tyre marks
      // left by cars using the run-off - both wrapped so they cross tile edges.
      for (const t of [0, SIZE / 2]) {
        ctx.fillStyle = 'rgba(0,0,0,0.34)';
        ctx.fillRect(t, 0, px(1.6), SIZE);
        ctx.fillRect(0, t, SIZE, px(1.6));
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(t + px(1.6), 0, px(0.8), SIZE);
        ctx.fillRect(0, t + px(1.6), SIZE, px(0.8));
      }
      tyreMarks(ctx, 2, 0.14);
      break;
    }
    case '1TARMAC': {
      // Paved run-off: the same construction as the racing surface - stones in
      // binder, each with a lit cap and a shadow - but older and more open,
      // so it reads as a different, rougher surface. Planar, 6 m per tile;
      // nothing distinctive enough to show the tiling on a big apron.
      const [rr, gg, bb] = hexRgb(hex);
      grain(ctx, 10);
      for (let i = 0; i < dens(1100); i++) {
        const x = Math.random() * SIZE, y = Math.random() * SIZE;
        const r = px(0.4) + Math.random() * px(1.7);
        ctx.fillStyle = `rgba(0,0,0,${0.12 + Math.random() * 0.18})`;
        ctx.fillRect(x + r * 0.45, y + r * 0.5, r * 1.4, r * 1.25);
        const d = -20 + Math.random() * 58;
        ctx.fillStyle = `rgba(${rr + d},${gg + d},${bb + d},${0.4 + Math.random() * 0.45})`;
        ctx.fillRect(x, y, r * 1.4, r * 1.25);
      }
      speckle(ctx, dens(520), [px(0.3), px(0.9)], 0.16, false); // open texture, weathered
      for (let i = 0; i < dens(6); i++) {                       // patchy fading
        const x = Math.random() * SIZE, y = Math.random() * SIZE, rad = px(40 + Math.random() * 70);
        const d = -4 + Math.random() * 14;
        wrap(x, y, rad, (wx, wy) => {
          const g = ctx.createRadialGradient(wx, wy, 1, wx, wy, rad);
          g.addColorStop(0, `rgba(${rr + d},${gg + d},${bb + d},0.16)`);
          g.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(wx, wy, rad, 0, Math.PI * 2); ctx.fill();
        });
      }
      tyreMarks(ctx, 2, 0.16);                                 // cars running wide
      break;
    }
    case '1DIRT': {
      // Packed earth. The ruts used to be two hard-edged bars ruled straight
      // across the tile, which read as stripes on a 6 m grid. Now: damp and
      // dry patches, shaded pebbles, dust, and a net of dry cracks.
      const base = hexRgb(hex) as RGB;
      grain(ctx, 10);
      for (let i = 0; i < dens(8); i++) {
        const x = Math.random() * SIZE, y = Math.random() * SIZE, r = px(30 + Math.random() * 60);
        const k = 0.78 + Math.random() * 0.32;
        wrap(x, y, r, (wx, wy) => {
          const g = ctx.createRadialGradient(wx, wy, 1, wx, wy, r);
          g.addColorStop(0, shade(base, k, 0.4));
          g.addColorStop(1, shade(base, k, 0));
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(wx, wy, r, 0, Math.PI * 2); ctx.fill();
        });
      }
      for (let i = 0; i < dens(70); i++) {                  // dry cracks
        let x = Math.random() * SIZE, y = Math.random() * SIZE;
        ctx.strokeStyle = `rgba(40,28,18,${0.18 + Math.random() * 0.2})`;
        ctx.lineWidth = px(0.6);
        ctx.beginPath(); ctx.moveTo(x, y);
        for (let k = 0; k < 4; k++) {
          x += (Math.random() - 0.5) * px(14); y += (Math.random() - 0.5) * px(14);
          ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      // Stones: sparse and irregular, mostly half-buried, a few sizes. Nine
      // hundred near-identical round pebbles read as beads on a tray.
      for (let i = 0; i < dens(70); i++) {
        const x = Math.random() * SIZE, y = Math.random() * SIZE;
        const r = px(0.5) + Math.pow(Math.random(), 2.2) * px(3.2);   // mostly small
        const e = 0.45 + Math.random() * 0.5, rot = Math.random() * Math.PI;
        ctx.fillStyle = 'rgba(28,20,12,0.32)';
        ctx.beginPath(); ctx.ellipse(x + r * 0.3, y + r * 0.35, r, r * e, rot, 0, Math.PI * 2); ctx.fill();
        const k = 0.88 + Math.random() * 0.36;
        ctx.fillStyle = Math.random() < 0.3 ? shade([150, 144, 132], k) : shade(base, k);
        ctx.beginPath(); ctx.ellipse(x, y, r, r * e, rot, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(255,240,220,0.14)';
        ctx.beginPath(); ctx.ellipse(x - r * 0.25, y - r * 0.25, r * 0.4, r * e * 0.35, rot, 0, Math.PI * 2); ctx.fill();
      }
      speckle(ctx, dens(400), [px(0.3), px(0.8)], 0.12, true); // dust
      break;
    }
    case '1KERB': {
      // v (vertical here) runs ACROSS the kerb, track edge -> outer edge. A
      // kerb is a cast ramp, so it needs cross-profile shading: the inner lip
      // sits in the road's shadow, the crown catches the sky, the outer edge
      // falls away into dirt. Flat colour bands with a line ruled between them
      // read as painted tarmac, not concrete.
      const pattern = KERB_PATTERNS[theme] ?? KERB_PATTERNS.tarmac_day;
      bandsAcross(ctx, pattern);
      const w = SIZE / pattern.length;
      for (let i = 1; i < pattern.length; i++) { // cast joints between blocks
        const x = Math.round(i * w);
        ctx.fillStyle = 'rgba(0,0,0,0.42)';
        ctx.fillRect(x - px(1), 0, px(2), SIZE);
        ao(ctx, x + px(1), 0, px(5), SIZE, 'right', 0.26);
      }
      // the ramp profile
      vgrad(ctx, 0, SIZE, [
        [0, 'rgba(0,0,0,0.34)'],      // inner lip, shadowed by the road
        [0.1, 'rgba(0,0,0,0.05)'],
        [0.42, 'rgba(255,255,255,0.2)'], // crown
        [0.78, 'rgba(0,0,0,0.04)'],
        [1, 'rgba(0,0,0,0.3)'],       // outer edge drops into the verge
      ]);
      grain(ctx, 6);
      speckle(ctx, dens(260), [px(0.3), px(1.2)], 0.1, true); // concrete aggregate
      // worn paint + rubber on the inner half, where the cars actually ride it
      for (let i = 0; i < dens(70); i++) {
        const x = Math.random() * SIZE;
        const y = Math.random() * SIZE * 0.6;
        ctx.fillStyle = `rgba(40,36,34,${0.06 + Math.random() * 0.22})`;
        ctx.fillRect(x, y, px(3) + Math.random() * px(16), px(0.8) + Math.random() * px(2.2));
      }
      for (let i = 0; i < dens(18); i++) { // chipped paint showing concrete
        ctx.fillStyle = `rgba(236,234,228,${0.05 + Math.random() * 0.1})`;
        ctx.fillRect(Math.random() * SIZE, Math.random() * SIZE, px(1) + Math.random() * px(3), px(1) + Math.random() * px(2));
      }
      vgrad(ctx, SIZE * 0.82, SIZE, [ // grass/dirt staining at the outer edge
        [0, 'rgba(58,52,34,0)'], [1, 'rgba(58,52,34,0.4)'],
      ]);
      break;
    }
    case '1KERBHI': {
      // The raised sausage: a cylinder, so it needs a cylinder's shading.
      cylBar(ctx, 0, SIZE, hexRgb(hex) as RGB);
      grain(ctx, 7);
      speckle(ctx, dens(200), [px(0.3), px(1.1)], 0.1, true);
      rubberScuff(ctx, dens(22), SIZE * 0.45, SIZE * 0.5);
      break;
    }
    case '1WALL': {
      // v runs bottom (y=SIZE) -> top (y=0), so y=0 is the TOP of the barrier
      // and y=SIZE sits on the ground. Grime collects at high y, rain streaks
      // run toward high y, and the sky-facing highlight belongs at low y.
      if (wallStyle === 'tecpro') {
        // Moulded plastic energy-absorber blocks: red body, white cap, and a
        // pronounced roll on every moulded edge.
        const red: RGB = [200, 50, 46];
        const capH = SIZE * 0.3;
        vgrad(ctx, 0, capH, [[0, '#fbfcfd'], [0.45, '#e4e6ea'], [1, '#c2c6cd']]);
        vgrad(ctx, capH, SIZE, [
          [0, shade(red, 1.18)], [0.3, shade(red, 1.0)], [1, shade(red, 0.64)],
        ]);
        grain(ctx, 4);
        ao(ctx, 0, capH, SIZE, px(10), 'down', 0.5);      // under the white cap
        ao(ctx, 0, 0, SIZE, px(5), 'down', 0.3);          // top lip
        const blockW = px(46);
        for (let x = 0; x < SIZE; x += blockW) {
          ao(ctx, x, 0, px(9), SIZE, 'right', 0.5);       // moulded vertical seam
          ao(ctx, x - px(9), 0, px(9), SIZE, 'left', 0.3);
          ctx.fillStyle = 'rgba(255,255,255,0.14)';       // seam highlight
          ctx.fillRect(x + px(9), 0, px(1.5), SIZE);
        }
        ctx.fillStyle = 'rgba(28,28,32,0.5)';             // retaining straps
        for (const yc of [SIZE * 0.46, SIZE * 0.78]) {
          ctx.fillRect(0, yc, SIZE, px(4));
          ao(ctx, 0, yc + px(4), SIZE, px(5), 'down', 0.35);
        }
        rubberScuff(ctx, dens(14), SIZE * 0.62, SIZE * 0.3);
        groundGrime(ctx, 0.2, 0.45);
      } else if (wallStyle === 'armco') {
        // Galvanised W-beam: two rails, each a pair of cylindrical humps, on
        // posts. The humps are what make it read as rolled steel rather than
        // a painted grey stripe.
        const steel: RGB = [154, 160, 168];
        vgrad(ctx, 0, SIZE, [[0, shade(steel, 1.1)], [0.6, shade(steel, 0.92)], [1, shade(steel, 0.62)]]);
        speckle(ctx, dens(260), [0.5, 2.2], 0.07, true);  // galvanising mottle
        const postW = px(13), postStep = px(66);
        for (let x = px(10); x < SIZE; x += postStep) {   // posts BEHIND the rails
          ctx.fillStyle = shade(steel, 0.72);
          ctx.fillRect(x, 0, postW, SIZE);
          ao(ctx, x + postW, 0, px(7), SIZE, 'right', 0.42);
          ao(ctx, x - px(7), 0, px(7), SIZE, 'left', 0.42);
        }
        for (const yc of [SIZE * 0.26, SIZE * 0.62]) {    // two W-beam rails
          const railH = px(30);
          ao(ctx, 0, yc - px(8), SIZE, px(8), 'up', 0.4); // shadow the rail casts up
          cylBar(ctx, yc, railH / 2, steel);              // upper hump
          cylBar(ctx, yc + railH / 2, railH / 2, steel);  // lower hump
          ctx.fillStyle = 'rgba(0,0,0,0.5)';              // valley between humps
          ctx.fillRect(0, yc + railH / 2 - px(1), SIZE, px(2));
          ao(ctx, 0, yc + railH, SIZE, px(11), 'down', 0.5); // drop shadow
          for (let x = px(10); x < SIZE; x += postStep) {    // bolt at every post
            bolt(ctx, x + postW / 2, yc + railH / 2, px(3.6));
          }
        }
        streaks(ctx, dens(26), SIZE * 0.3, SIZE * 0.5, 0.14);
        rubberScuff(ctx, dens(10), SIZE * 0.34, SIZE * 0.14);
        groundGrime(ctx, 0.24, 0.5);
      } else if (wallStyle === 'blocks') {
        // Tyre wall: stacked tyres, each shaded as a torus with a dark hub.
        ctx.fillStyle = '#17181c';
        ctx.fillRect(0, 0, SIZE, SIZE);
        const step = px(32), r = px(15);
        for (let row = 0, y = px(16); y < SIZE + step; y += step, row++) {
          const xOff = row % 2 ? step / 2 : 0;            // stagger the courses
          for (let x = xOff - step; x < SIZE + step; x += step) {
            const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.08, x, y, r);
            g.addColorStop(0, '#5c5f66');                 // sky bounce, upper-left
            g.addColorStop(0.42, '#3a3c42');
            g.addColorStop(0.82, '#232428');
            g.addColorStop(1, '#101113');
            ctx.fillStyle = g;
            ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = '#0a0b0d';                    // hub
            ctx.beginPath(); ctx.arc(x, y, r * 0.34, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = 'rgba(0,0,0,0.75)';         // contact shadow
            ctx.lineWidth = px(1.6);
            ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
          }
        }
        ctx.fillStyle = 'rgba(214,206,186,0.5)';          // conveyor-belt straps
        for (let y = px(16); y < SIZE; y += step * 2) {
          ctx.fillRect(0, y - px(3), SIZE, px(6));
          ao(ctx, 0, y + px(3), SIZE, px(5), 'down', 0.4);
        }
        groundGrime(ctx, 0.18, 0.55);
      } else if (wallStyle === 'hay') {
        // Round bales, lit as cylinders lying on their sides.
        const straw: RGB = [201, 169, 78];
        const baleH = px(44);
        for (let y = 0; y < SIZE; y += baleH) cylBar(ctx, y, baleH, straw);
        for (let i = 0; i < dens(900); i++) {             // straw fibres
          const d = -35 + Math.random() * 60;
          ctx.fillStyle = `rgba(${201 + d},${169 + d},${78 + d},0.75)`;
          ctx.fillRect(Math.random() * SIZE, Math.random() * SIZE, px(1.5) + Math.random() * px(2.5), px(0.5));
        }
        for (let y = 0; y < SIZE; y += baleH) {           // bale ends, brick-laid
          ao(ctx, 0, y, SIZE, px(6), 'down', 0.45);
          const off = (y / baleH) % 2 === 0 ? 0 : px(40);
          for (let x = off; x < SIZE; x += px(80)) ao(ctx, x, y, px(7), baleH, 'right', 0.4);
        }
        ctx.fillStyle = 'rgba(96,66,26,0.4)';             // twine
        for (let y = px(12); y < SIZE; y += baleH) ctx.fillRect(0, y, SIZE, px(1.5));
        groundGrime(ctx, 0.16, 0.4);
      } else {
        // Precast concrete: panels with chamfered joints, a sky-lit top edge,
        // rain running from every joint, and rubber where cars have kissed it.
        const conc: RGB = [176, 176, 172];
        vgrad(ctx, 0, SIZE, [
          [0, shade(conc, 1.1)], [0.14, shade(conc, 1.0)],
          [0.7, shade(conc, 0.9)], [1, shade(conc, 0.66)],
        ]);
        grain(ctx, 5);
        speckle(ctx, dens(180), [0.4, 1.6], 0.06, false);
        ctx.fillStyle = 'rgba(255,255,255,0.22)';         // sky-facing top edge
        ctx.fillRect(0, 0, SIZE, px(3));
        ao(ctx, 0, px(3), SIZE, px(9), 'down', 0.3);
        const panelW = px(64);
        for (let x = 0; x < SIZE; x += panelW) {          // chamfered joints
          ctx.fillStyle = 'rgba(0,0,0,0.3)';
          ctx.fillRect(x, 0, px(2.5), SIZE);
          ao(ctx, x + px(2.5), 0, px(8), SIZE, 'right', 0.3);
          ctx.fillStyle = 'rgba(255,255,255,0.12)';
          ctx.fillRect(x + px(2.5), 0, px(1), SIZE);
          streaks(ctx, 3, px(14), SIZE * 0.75, 0.1);
        }
        rubberScuff(ctx, dens(16), SIZE * 0.6, SIZE * 0.34);
        streaks(ctx, dens(18), 0, SIZE * 0.8, 0.1);
        groundGrime(ctx, 0.26, 0.5);
      }
      break;
    }
    case '1WALLPOLY': {
      // Polystyrene blocks. emitBox gives each of a block's four faces one
      // QUARTER of U and the full V (foot to top, once - no tiling), so this is
      // drawn as four faces side by side, each with moulded edges, a groove,
      // tyre scuffs and dirt at the foot.
      const yel: RGB = [232, 206, 66];
      vgrad(ctx, 0, SIZE, [[0, shade(yel, 1.08)], [0.7, shade(yel, 0.96)], [1, shade(yel, 0.8)]]);
      grain(ctx, 5);
      for (let x = 0; x < SIZE; x++) {                      // rounded edges, per face
        const ph = ((x / SIZE) * 4) % 1;
        const k = Math.sin(ph * Math.PI);
        ctx.fillStyle = `rgba(0,0,0,${(0.32 * (1 - k)).toFixed(3)})`;
        ctx.fillRect(x, 0, 1, SIZE);
      }
      const gy = SIZE * 0.5;                                // moulded groove
      ctx.fillStyle = 'rgba(0,0,0,0.32)';
      ctx.fillRect(0, gy, SIZE, px(3));
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.fillRect(0, gy + px(3), SIZE, px(1.5));
      ctx.fillStyle = 'rgba(255,255,255,0.35)';             // top edge catches the sky
      ctx.fillRect(0, 0, SIZE, px(4));
      rubberScuff(ctx, dens(24), SIZE * 0.66, SIZE * 0.4);
      groundGrime(ctx, 0.22, 0.55);
      break;
    }
    case 'ROAD_LINE':
    case 'PIT_LINE': {
      // Worn line paint. Paint sits on the asphalt, so the tops of the stones
      // break through it as it wears, and rubber gets laid over the top.
      grain(ctx, 4);
      for (let i = 0; i < dens(700); i++) {                 // stones through the paint
        const x = Math.random() * SIZE, y = Math.random() * SIZE, r = px(0.3) + Math.random() * px(1.1);
        ctx.fillStyle = `rgba(60,62,66,${0.12 + Math.random() * 0.3})`;
        ctx.fillRect(x, y, r * 1.4, r * 1.2);
      }
      for (let i = 0; i < dens(5); i++) {                   // worn-through patches
        const x = Math.random() * SIZE, y = Math.random() * SIZE, r = px(14 + Math.random() * 30);
        wrap(x, y, r, (wx, wy) => {
          const g = ctx.createRadialGradient(wx, wy, 1, wx, wy, r);
          g.addColorStop(0, 'rgba(96,98,102,0.18)');
          g.addColorStop(1, 'rgba(96,98,102,0)');
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(wx, wy, r, 0, Math.PI * 2); ctx.fill();
        });
      }
      speckle(ctx, dens(120), [px(0.6), px(2)], 0.12, false); // rubber
      break;
    }
    // BUILDING FACADES. Building walls are UV'd at ONE TILE PER 4 m on both
    // axes, so each of these is exactly one storey, 4 m wide, at real scale:
    // 128 px to the metre. The old office texture drew ~120 windows per tile -
    // 30 cm windows - which is why buildings read as graph paper. Nothing here
    // may use groundGrime(): the tile repeats every storey, so dirt at the foot
    // of the tile would be dirt at every floor line.
    case 'DECOR_BUILDING': {
      const M = SIZE / 4;                                   // px per metre
      const rend: RGB = hexRgb(hex) as RGB;
      grain(ctx, 4);
      speckle(ctx, dens(160), [0.4, 1.4], 0.05, false);
      // floor slab edge at the foot of the storey
      const slabY = SIZE - 0.4 * M;
      ctx.fillStyle = shade(rend, 1.12);
      ctx.fillRect(0, slabY, SIZE, SIZE - slabY);
      ao(ctx, 0, slabY, SIZE, px(4), 'down', 0.35);
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(0, slabY, SIZE, px(1));
      // two windows, 1.4 m x 2.0 m, head 0.5 m below the slab above
      const wy0 = 0.5 * M, wy1 = wy0 + 2.0 * M, ww = 1.4 * M;
      for (const cx of [SIZE * 0.25, SIZE * 0.75]) {
        const x0 = cx - ww / 2, x1 = cx + ww / 2;
        const g = ctx.createLinearGradient(0, wy0, 0, wy1);
        g.addColorStop(0, '#a7bccd');                       // sky in the upper pane
        g.addColorStop(0.42, '#6f879a');
        g.addColorStop(1, '#2f3b46');                       // dark interior below
        ctx.fillStyle = g;
        ctx.fillRect(x0, wy0, ww, wy1 - wy0);
        const r = ctx.createLinearGradient(x0, wy0, x1, wy1); // one diagonal reflection
        r.addColorStop(0.25, 'rgba(255,255,255,0)');
        r.addColorStop(0.4, 'rgba(255,255,255,0.2)');
        r.addColorStop(0.52, 'rgba(255,255,255,0)');
        ctx.fillStyle = r;
        ctx.fillRect(x0, wy0, ww, wy1 - wy0);
        ctx.fillStyle = 'rgba(36,40,46,0.95)';              // frame, mullion, transom
        ctx.lineWidth = px(3);
        ctx.strokeStyle = 'rgba(36,40,46,0.95)';
        ctx.strokeRect(x0 + px(1.5), wy0 + px(1.5), ww - px(3), wy1 - wy0 - px(3));
        ctx.fillRect(cx - px(1.5), wy0, px(3), wy1 - wy0);
        ctx.fillRect(x0, wy0 + (wy1 - wy0) * 0.3, ww, px(2.5));
        ao(ctx, x0, wy0, ww, px(14), 'down', 0.55);        // deep reveal under the head
        ao(ctx, x0, wy0, px(9), wy1 - wy0, 'right', 0.35);  // and down one jamb
        ctx.fillStyle = shade(rend, 1.3);                   // projecting sill
        ctx.fillRect(x0 - px(5), wy1, ww + px(10), px(5));
        ao(ctx, x0 - px(5), wy1 + px(5), ww + px(10), px(8), 'down', 0.4);
        for (let k = 0; k < 4; k++) {                       // dirt washed off the sill
          const sx = x0 + Math.random() * ww;
          const g2 = ctx.createLinearGradient(0, wy1 + px(5), 0, slabY);
          g2.addColorStop(0, 'rgba(40,36,30,0.16)');
          g2.addColorStop(1, 'rgba(40,36,30,0)');
          ctx.fillStyle = g2;
          ctx.fillRect(sx, wy1 + px(5), px(2) + Math.random() * px(5), slabY - wy1 - px(5));
        }
      }
      ctx.fillStyle = 'rgba(0,0,0,0.1)';                    // render panel joints
      for (const x of [0, SIZE / 2]) ctx.fillRect(x, 0, px(1.2), slabY);
      break;
    }
    case 'DECOR_BLDGLASS': { // structural glass curtain wall
      const M = SIZE / 4;
      const panelW = SIZE / 3;                              // 1.33 m modules
      const transY = SIZE - 0.9 * M;                        // spandrel line
      const mull = px(4.5);
      for (let k = 0; k < 3; k++) {
        const x0 = k * panelW;
        const t = 0.85 + Math.random() * 0.3;               // each pane its own sky
        const g = ctx.createLinearGradient(0, 0, 0, transY);
        g.addColorStop(0, `rgb(${Math.round(150 * t)},${Math.round(178 * t)},${Math.round(200 * t)})`);
        g.addColorStop(0.55, `rgb(${Math.round(98 * t)},${Math.round(124 * t)},${Math.round(146 * t)})`);
        g.addColorStop(1, `rgb(${Math.round(56 * t)},${Math.round(72 * t)},${Math.round(88 * t)})`);
        ctx.fillStyle = g;
        ctx.fillRect(x0, 0, panelW, transY);
        if (k === 1) {                                      // blinds half down in one bay
          ctx.fillStyle = 'rgba(214,214,206,0.42)';
          for (let y = px(4); y < transY * 0.38; y += px(5)) ctx.fillRect(x0, y, panelW, px(3));
        }
      }
      // one continuous reflection across the whole sheet, mullions included
      const refl = ctx.createLinearGradient(0, 0, SIZE, transY);
      refl.addColorStop(0.2, 'rgba(255,255,255,0)');
      refl.addColorStop(0.36, 'rgba(255,255,255,0.22)');
      refl.addColorStop(0.46, 'rgba(255,255,255,0)');
      ctx.fillStyle = refl;
      ctx.fillRect(0, 0, SIZE, transY);
      // spandrel: opaque, darker glass over the floor slab
      vgrad(ctx, transY, SIZE, [[0, '#34404c'], [1, '#232b33']]);
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fillRect(0, transY + px(6), SIZE, px(2));
      // anodised frame
      const frame = (x: number, y: number, w: number, h: number) => {
        ctx.fillStyle = '#2a2f36';
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = 'rgba(255,255,255,0.22)';
        ctx.fillRect(x, y, Math.min(w, px(1)), h);
      };
      for (let k = 0; k < 3; k++) frame(k * panelW, 0, mull, SIZE);
      frame(0, 0, SIZE, mull);                              // head transom (covers the seam)
      frame(0, transY, SIZE, mull);
      for (let k = 0; k < 3; k++) {
        ao(ctx, k * panelW + mull, 0, px(6), transY, 'right', 0.3);
      }
      ao(ctx, 0, mull, SIZE, px(6), 'down', 0.3);
      break;
    }
    case 'DECOR_BLDBRICK': { // brick at real scale, one window per storey
      const M = SIZE / 4;
      const base = hexRgb(hex) as RGB;
      ctx.fillStyle = '#b7ab98';                            // mortar
      ctx.fillRect(0, 0, SIZE, SIZE);
      const rows = 52, cols = 17;                           // 77 mm courses, 235 mm bricks
      const rh = SIZE / rows, bw = SIZE / cols, gap = px(0.8);
      const brick = (x: number, y: number, w: number, h: number) => {
        const k = 0.8 + Math.random() * 0.36;
        const warm = Math.random() * 14;
        ctx.fillStyle = `rgb(${Math.round(base[0] * k + warm)},${Math.round(base[1] * k)},${Math.round(base[2] * k - warm * 0.4)})`;
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = 'rgba(0,0,0,0.18)';                 // recessed joint shades the top
        ctx.fillRect(x, y, w, px(0.8));
      };
      for (let r = 0; r < rows; r++) {
        const off = r % 2 ? bw / 2 : 0;
        for (let c = -1; c <= cols; c++) {
          brick(c * bw + off + gap, r * rh + gap, bw - gap * 2, rh - gap * 2);
        }
      }
      speckle(ctx, dens(260), [0.4, 1.3], 0.08, false);
      // window 1.2 m x 1.6 m with a soldier-course head and a stone sill
      const ww = 1.2 * M, wh = 1.6 * M, x0 = (SIZE - ww) / 2, y0 = 0.62 * M, y1 = y0 + wh;
      const soldier = 0.225 * M;
      for (let x = x0 - px(4); x < x0 + ww + px(4); x += rh) {
        brick(x + gap, y0 - soldier + gap, rh - gap * 2, soldier - gap * 2);
      }
      ctx.fillStyle = '#e9e6dd';                            // painted timber frame
      ctx.fillRect(x0, y0, ww, wh);
      const g = ctx.createLinearGradient(0, y0, 0, y1);
      g.addColorStop(0, '#93a8b8'); g.addColorStop(0.5, '#56697a'); g.addColorStop(1, '#27313a');
      ctx.fillStyle = g;
      const fr = px(6);
      ctx.fillRect(x0 + fr, y0 + fr, ww - fr * 2, wh - fr * 2);
      ctx.fillStyle = '#e9e6dd';                            // glazing bars, 2x2 panes
      ctx.fillRect(x0 + ww / 2 - px(2), y0, px(4), wh);
      ctx.fillRect(x0, y0 + wh / 2 - px(2), ww, px(4));
      ao(ctx, x0, y0, ww, px(12), 'down', 0.5);
      ao(ctx, x0, y0, px(8), wh, 'right', 0.3);
      ctx.fillStyle = '#d4cfc3';                            // stone sill
      ctx.fillRect(x0 - px(8), y1, ww + px(16), px(7));
      ao(ctx, x0 - px(8), y1 + px(7), ww + px(16), px(10), 'down', 0.45);
      for (let k = 0; k < 5; k++) {
        const sx = x0 + Math.random() * ww;
        const g2 = ctx.createLinearGradient(0, y1 + px(7), 0, SIZE);
        g2.addColorStop(0, 'rgba(30,26,22,0.18)'); g2.addColorStop(1, 'rgba(30,26,22,0)');
        ctx.fillStyle = g2;
        ctx.fillRect(sx, y1 + px(7), px(2) + Math.random() * px(6), SIZE - y1);
      }
      break;
    }
    case 'DECOR_BLDHANGAR': { // corrugated steel cladding
      const base = hexRgb(hex) as RGB;
      const pitch = SIZE / 52;                              // ~77 mm corrugation
      for (let x = 0; x < SIZE; x++) {
        // a sine profile lit from one side: the near flank bright, the far dark
        const ph = (x / pitch) % 1;
        const k = 0.9 + 0.24 * Math.cos(ph * Math.PI * 2);
        ctx.fillStyle = shade(base, k);
        ctx.fillRect(x, 0, 1, SIZE);
      }
      speckle(ctx, dens(320), [0.4, 1.8], 0.07, true);     // galvanised mottle
      // horizontal sheet lap with its fixings
      const lapY = SIZE * 0.3;
      ctx.fillStyle = 'rgba(0,0,0,0.42)';
      ctx.fillRect(0, lapY, SIZE, px(2));
      ctx.fillStyle = 'rgba(255,255,255,0.2)';
      ctx.fillRect(0, lapY - px(1.5), SIZE, px(1.5));
      ao(ctx, 0, lapY + px(2), SIZE, px(7), 'down', 0.32);
      for (let x = pitch / 2; x < SIZE; x += pitch * 2) {
        bolt(ctx, x, lapY + px(5), px(1.8));
        if (Math.random() < 0.45) {                         // rust bleeding off a fixing
          const g = ctx.createLinearGradient(0, lapY + px(6), 0, lapY + px(6) + SIZE * 0.25);
          g.addColorStop(0, 'rgba(120,64,28,0.32)'); g.addColorStop(1, 'rgba(120,64,28,0)');
          ctx.fillStyle = g;
          ctx.fillRect(x - px(1), lapY + px(6), px(2.5), SIZE * 0.25);
        }
      }
      streaks(ctx, dens(22), 0, SIZE, 0.08);
      break;
    }
    case 'DECOR_ROOF':
    case 'DECOR_STANDROOF': {
      // Single-ply roofing membrane, planar at one tile per 6 m: laps every
      // metre, ponding where water sits, dust blown into the corners.
      const base = hexRgb(hex) as RGB;
      grain(ctx, 6);
      const sheet = SIZE / 6;
      for (let x = 0; x < SIZE; x += sheet) {
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(x, 0, px(1.5), SIZE);
        ao(ctx, x + px(1.5), 0, px(5), SIZE, 'right', 0.25);
      }
      for (let i = 0; i < dens(5); i++) {                   // ponding stains
        const x = Math.random() * SIZE, y = Math.random() * SIZE, r = px(14 + Math.random() * 30);
        const g = ctx.createRadialGradient(x, y, 1, x, y, r);
        g.addColorStop(0, shade(base, 0.72, 0.42));
        g.addColorStop(1, shade(base, 0.72, 0));
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
      speckle(ctx, dens(240), [0.4, 1.5], 0.1, true);       // dust and grit
      break;
    }
    case 'DECOR_PITBLDG': {
      // The pit complex is mapped planar at one tile per 6 m, so this is ONE
      // storey: a glazed team-viewing band over a clad lower wall, with the
      // structural bay columns standing proud of both. It used to be flat grey
      // with lines ruled down it, which is what a building looks like before
      // anyone decides what it is made of.
      const clad: RGB = [142, 139, 132];
      vgrad(ctx, 0, SIZE, [
        [0, shade(clad, 1.16)], [0.22, shade(clad, 1.02)],
        [0.74, shade(clad, 0.92)], [1, shade(clad, 0.7)],
      ]);
      grain(ctx, 5);
      // glazing band — the viewing gallery above the garages
      const gy0 = SIZE * 0.1, gy1 = SIZE * 0.4;
      vgrad(ctx, gy0, gy1, [
        [0, '#53657a'], [0.45, '#7f9bb2'], [0.75, '#44586b'], [1, '#33424f'],
      ]);
      ao(ctx, 0, gy0, SIZE, px(8), 'down', 0.5);          // reveal above the glass
      ao(ctx, 0, gy1 - px(8), SIZE, px(8), 'up', 0.45);    // sill shadow
      ctx.fillStyle = 'rgba(255,255,255,0.3)';             // sill
      ctx.fillRect(0, gy1, SIZE, px(3));
      for (let x = px(14); x < SIZE; x += px(28)) {        // window mullions
        ctx.fillStyle = 'rgba(28,32,38,0.75)';
        ctx.fillRect(x, gy0, px(3), gy1 - gy0);
      }
      for (let x = 0; x < SIZE; x += px(21)) {             // glass reflections
        const g = ctx.createLinearGradient(x, gy0, x + px(21), gy1);
        g.addColorStop(0, 'rgba(255,255,255,0.14)');
        g.addColorStop(0.5, 'rgba(255,255,255,0.02)');
        g.addColorStop(1, 'rgba(255,255,255,0.1)');
        ctx.fillStyle = g;
        ctx.fillRect(x, gy0, px(21), gy1 - gy0);
      }
      // structural columns between the bays, standing proud of the cladding
      for (let x = 0; x < SIZE; x += px(64)) {
        ctx.fillStyle = shade(clad, 1.1);
        ctx.fillRect(x, 0, px(13), SIZE);
        ao(ctx, x + px(13), 0, px(9), SIZE, 'right', 0.45);
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fillRect(x, 0, px(2), SIZE);
      }
      ctx.fillStyle = 'rgba(248,249,250,0.9)';             // fascia at the roofline
      ctx.fillRect(0, 0, SIZE, px(13));
      ao(ctx, 0, px(13), SIZE, px(10), 'down', 0.4);
      for (let x = 0; x < SIZE; x += px(21)) {             // cladding panel joints
        ctx.fillStyle = 'rgba(0,0,0,0.14)';
        ctx.fillRect(x, gy1 + px(4), px(1.5), SIZE - gy1);
      }
      streaks(ctx, dens(20), gy1, SIZE * 0.5, 0.1);        // rain off the sill
      groundGrime(ctx, 0.14, 0.4);
      break;
    }
    case 'DECOR_GARAGE': {
      // A roller shutter: horizontal slats, each a shallow cylinder. Flat ribs
      // at 10% white read as a drawn-on grille rather than a rolled door.
      const slat: RGB = [58, 61, 68];
      const h = px(13);
      for (let y = 0; y < SIZE; y += h) {
        cylBar(ctx, y, h, slat);
        ctx.fillStyle = 'rgba(0,0,0,0.6)';   // the gap the slats hinge on
        ctx.fillRect(0, y + h - px(1.5), SIZE, px(1.5));
      }
      grain(ctx, 4);
      speckle(ctx, dens(120), [0.4, 1.4], 0.05, true);
      ao(ctx, 0, 0, SIZE, px(14), 'down', 0.55);           // dark under the lintel
      groundGrime(ctx, 0.12, 0.6);
      rubberScuff(ctx, dens(8), SIZE * 0.78, SIZE * 0.2);
      break;
    }
    case 'DECOR_BOLLARD': {
      // A trackside marker post, read from bottom (V=0) to top (V=1): a dark
      // weathered foot, the orange body, and two retro-reflective bands near the
      // top — the thing a driver actually picks out at the edge of a run-off.
      // The previous version was one translucent stripe on flat orange, which on
      // a post barely read as a texture at all.
      // The post is a box whose four faces each take a QUARTER of U (emitBox
      // maps face i to i/4..(i+1)/4). The shading used to be one sine across
      // the whole width, so two faces came out dark and two bright whichever
      // way the sun was. Now each quarter is its own face with rounded edges.
      for (let x = 0; x < SIZE; x++) {
        const ph = ((x / SIZE) * 4) % 1;
        const k = Math.sin(ph * Math.PI);
        ctx.fillStyle = `rgba(0,0,0,${(0.3 * (1 - k)).toFixed(3)})`;
        ctx.fillRect(x, 0, 1, SIZE);
      }
      // Mud and spray thrown up from the run-off, heaviest at the foot,
      // instead of a hard-edged grey band painted round the bottom.
      vgrad(ctx, SIZE * 0.72, SIZE, [[0, 'rgba(46,38,30,0)'], [0.6, 'rgba(46,38,30,0.45)'], [1, 'rgba(32,26,20,0.85)']]);
      for (let i = 0; i < dens(40); i++) {
        const y = SIZE - Math.pow(Math.random(), 2) * SIZE * 0.4;
        ctx.fillStyle = `rgba(42,34,26,${0.2 + Math.random() * 0.4})`;
        ctx.beginPath(); ctx.arc(Math.random() * SIZE, y, px(0.6) + Math.random() * px(1.6), 0, Math.PI * 2); ctx.fill();
      }
      // two reflective bands
      for (const fy of [0.18, 0.34]) {
        const y = Math.round(SIZE * fy), hgt = Math.round(SIZE * 0.085);
        ctx.fillStyle = '#f2f4f7';
        ctx.fillRect(0, y, SIZE, hgt);
        ctx.fillStyle = 'rgba(255,255,255,0.55)';       // hot highlight
        ctx.fillRect(0, y + Math.round(hgt * 0.25), SIZE, Math.round(hgt * 0.3));
        ctx.fillStyle = 'rgba(0,0,0,0.22)';             // edges so it has depth
        ctx.fillRect(0, y, SIZE, px(1));
        ctx.fillRect(0, y + hgt - px(1), SIZE, px(1));
      }
      grain(ctx, 5);
      break;
    }
    case 'DECOR_FLAG': {
      // A flag flying from a pole folds in ripples PARALLEL to the pole, so the
      // light and shadow vary along its length (U). The old shading varied
      // with height, which is how a flag hanging limp would look.
      bandsAcross(ctx, TRICOLORE);
      for (let x = 0; x < SIZE; x++) {
        const t = x / SIZE;
        const s = Math.sin(t * 26 + Math.sin(t * 7) * 1.6) * (0.4 + 0.6 * t); // more flutter at the fly end
        ctx.fillStyle = s > 0 ? `rgba(255,255,255,${(0.16 * s).toFixed(3)})` : `rgba(0,0,0,${(-0.24 * s).toFixed(3)})`;
        ctx.fillRect(x, 0, 1, SIZE);
      }
      ctx.fillStyle = '#e6e6e2';                            // hoist sleeve at the pole
      ctx.fillRect(0, 0, px(6), SIZE);
      ao(ctx, px(6), 0, px(5), SIZE, 'right', 0.3);
      grain(ctx, 3);
      break;
    }
    case 'DECOR_ARCH': {
      // Printed banner fabric: hems top and bottom with eyelets, and the
      // shallow vertical sag folds of a banner stretched between two posts.
      bandsAcross(ctx, TRICOLORE);
      // U spans the whole ~16 m banner, so 64 folds was one every 25 cm and
      // read as corrugated pinstripe. A stretched banner sags in a handful of
      // soft, uneven folds.
      for (let x = 0; x < SIZE; x++) {
        const t = x / SIZE;
        const s = 0.6 * Math.sin(t * Math.PI * 9 + 0.7) + 0.4 * Math.sin(t * Math.PI * 23 + 2.1);
        ctx.fillStyle = s > 0 ? `rgba(255,255,255,${(0.06 * s).toFixed(3)})` : `rgba(0,0,0,${(-0.09 * s).toFixed(3)})`;
        ctx.fillRect(x, 0, 1, SIZE);
      }
      const hem = px(14);
      for (const y of [0, SIZE - hem]) {
        ctx.fillStyle = 'rgba(0,0,0,0.16)';
        ctx.fillRect(0, y, SIZE, hem);
        ctx.fillStyle = 'rgba(255,255,255,0.35)';           // stitch line
        for (let x = 0; x < SIZE; x += px(5)) ctx.fillRect(x, y + (y === 0 ? hem - px(2) : px(1)), px(3), px(1));
      }
      for (let x = px(10); x < SIZE; x += px(40)) {         // eyelets along the top
        ctx.fillStyle = '#c9ccd2';
        ctx.beginPath(); ctx.arc(x, hem / 2, px(3), 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#2a2c30';
        ctx.beginPath(); ctx.arc(x, hem / 2, px(1.5), 0, Math.PI * 2); ctx.fill();
      }
      grain(ctx, 3);
      break;
    }
    case 'DECOR_MARKER': {
      // Braking boards: three bands stacked in V — 100, 50, 25 — each a white
      // board with the DISTANCE ON IT. It used to draw black chevron blocks,
      // which told a driver nothing and (because the geometry sampled these
      // along U) rendered as meaningless dark blocks anyway.
      // The left edge of every band is left blank: the sides of the block map
      // there, so only the faces the driver reads carry a numeral.
      const third = SIZE / 3;
      const labels = ['100', '50', '25'];
      for (let bnd = 0; bnd < 3; bnd++) {
        const y0 = bnd * third;
        // Board face: not flat white. Real boards are weathered, lit from
        // above, and sit proud of their frame.
        vgrad(ctx, y0, y0 + third, [
          [0, '#ffffff'], [0.3, '#f4f4f1'], [0.86, '#dcdcd6'], [1, '#c3c3bc'],
        ]);
        const fx = SIZE * 0.14, fy = y0 + px(4), fw = SIZE * 0.83, fh = third - px(8);
        ctx.fillStyle = 'rgba(0,0,0,0.5)';            // recessed frame
        ctx.fillRect(fx, fy, fw, px(2.5));
        ctx.fillRect(fx, fy + fh - px(2.5), fw, px(2.5));
        ao(ctx, fx, fy, fw, px(9), 'down', 0.3);      // frame shadows the face
        ctx.strokeStyle = 'rgba(20,22,26,0.85)';      // black border, as on a real board
        ctx.lineWidth = px(4);
        ctx.strokeRect(fx + px(6), fy + px(7), fw - px(12), fh - px(14));
        ctx.fillStyle = '#15171a';
        ctx.font = `bold ${Math.round(third * 0.66)}px Arial, Helvetica, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        // centred within the numbered region (u 0.12..1), not the whole tile
        ctx.fillText(labels[bnd], SIZE * 0.56, y0 + third / 2);
        streaks(ctx, 5, y0 + px(8), third * 0.8, 0.07);
        ao(ctx, fx, y0 + third - px(14), fw, px(14), 'down', 0.28);
      }
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
      break;
    }
    case 'DECOR_PITSIGN': {
      // Pit speed-limit board: the regulation red-ringed roundel over a
      // "PIT LANE" caption, so it reads as a real sign rather than a blank
      // panel. 80 km/h is Assetto Corsa's default pit limiter speed.
      ctx.fillStyle = '#f4f4f2';
      ctx.fillRect(0, 0, SIZE, SIZE);
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = px(2);
      ctx.strokeRect(px(3), px(3), SIZE - px(6), SIZE - px(6));
      const cx = SIZE / 2, cy = SIZE * 0.42, r = SIZE * 0.29;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = r * 0.22;
      ctx.strokeStyle = '#c8102e';
      ctx.stroke();
      ctx.fillStyle = '#15171a';
      ctx.font = `bold ${Math.round(r * 0.95)}px Arial, Helvetica, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('80', cx, cy);
      ctx.font = `bold ${Math.round(SIZE * 0.11)}px Arial, Helvetica, sans-serif`;
      ctx.fillText('PIT LANE', cx, SIZE * 0.85);
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
      break;
    }
    case 'DECOR_ADVERT1':
    case 'DECOR_ADVERT2':
    case 'DECOR_ADVERT3':
    case 'DECOR_ADVERT4': {
      // The artwork is drawn into a BAND across the middle of the tile, not over
      // the whole square, and the hoarding maps only that band. A hoarding is a
      // long thin strip — roughly ADVERT_ASPECT to 1 — so a square texture
      // stretched onto it pulled the wordmark sideways until it ran off the end
      // of the sign. A band of the same proportion maps 1:1 and the advert fits.
      const idx = Number(surface.slice(-1)) - 1;
      // The app's own violet, sampled from build/icon.png (#5858f8 / #7048f8),
      // rather than a guess at "purple".
      const schemes: [string, string, string][] = [
        ['#1a1440', '#8b7cff', '#ffffff'], // deep indigo, light violet wordmark
        ['#6a4ff8', '#ffffff', '#f4f1ff'], // brand violet, reversed out in white
        ['#f2f0ff', '#4a3ad0', '#5f56a0'], // pale violet, dark type
        ['#2a1f5c', '#a78bfa', '#ffffff'], // muted indigo
      ];
      const [bg, fg, sub] = schemes[idx % schemes.length];
      const band = SIZE / ADVERT_ASPECT;      // height of the artwork strip
      const y0 = (SIZE - band) / 2;
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, SIZE, SIZE);         // fill everything so bleed matches
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = px(3);
      ctx.strokeRect(px(3), y0 + px(3), SIZE - px(6), band - px(6));
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = fg;
      ctx.font = `bold ${Math.round(band * 0.44)}px Arial, Helvetica, sans-serif`;
      ctx.fillText('AC BAPTOU', SIZE / 2, y0 + band * 0.40);
      ctx.fillStyle = sub;
      ctx.font = `${Math.round(band * 0.16)}px Arial, Helvetica, sans-serif`;
      ctx.fillText('BUILD  •  DRIVE  •  TRAIN', SIZE / 2, y0 + band * 0.74);
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
      break;
    }
    case 'DECOR_GANTRY': {
      // Painted structural steel at one tile per 4 m: a bolted splice plate
      // every 2 m, rust weeping from the bolts, the paint chalking with age.
      // The beam samples the bottom 0.8 m of this tile, the posts all of it.
      const steel = hexRgb(hex) as RGB;
      grain(ctx, 4);
      speckle(ctx, dens(140), [0.5, 1.8], 0.06, false);
      for (let x = SIZE * 0.25; x < SIZE; x += SIZE / 2) {
        const pw = px(30), x0 = x - pw / 2;
        ctx.fillStyle = shade(steel, 1.06);                 // plate stands proud
        ctx.fillRect(x0, 0, pw, SIZE);
        ao(ctx, x0 + pw, 0, px(6), SIZE, 'right', 0.38);
        ctx.fillStyle = 'rgba(255,255,255,0.22)';
        ctx.fillRect(x0, 0, px(1.2), SIZE);
        for (let y = px(10); y < SIZE; y += px(22)) {
          for (const bx of [x0 + pw * 0.3, x0 + pw * 0.7]) {
            bolt(ctx, bx, y, px(2.6));
            if (Math.random() < 0.22) {
              const g = ctx.createLinearGradient(0, y, 0, y + px(40));
              g.addColorStop(0, 'rgba(118,62,26,0.38)'); g.addColorStop(1, 'rgba(118,62,26,0)');
              ctx.fillStyle = g;
              ctx.fillRect(bx - px(1), y + px(2), px(2.2), px(40));
            }
          }
        }
      }
      streaks(ctx, dens(16), 0, SIZE, 0.07);
      break;
    }
    case 'DECOR_LIGHTS': {
      // Start-light panel, drawn for its real proportions: the quad is
      // LIGHTS_ASPECT times wider than it is tall, so a round lamp has to be
      // drawn that much narrower here to come out round on the gantry. Five
      // pods, each with a lit red lamp over an unlit one, under a visor.
      const A = LIGHTS_ASPECT;
      const sx = (m: number) => (m / A) * SIZE;             // across: metres of panel height units
      ctx.fillStyle = '#0c0d10';
      ctx.fillRect(0, 0, SIZE, SIZE);
      ctx.strokeStyle = '#2b2e35';                          // housing frame
      ctx.lineWidth = px(6);
      ctx.strokeRect(px(3), px(3), SIZE - px(6), SIZE - px(6));
      const r = 0.14;                                        // lamp radius, in panel heights
      for (let k = 0; k < 5; k++) {
        const cx = ((k + 0.5) / 5) * SIZE;
        // pod
        ctx.fillStyle = '#16181d';
        ctx.fillRect(cx - sx(0.42), SIZE * 0.06, sx(0.84), SIZE * 0.88);
        for (const [cyf, lit] of [[0.32, true], [0.72, false]] as [number, boolean][]) {
          const cy = cyf * SIZE, rx = sx(r), ry = r * SIZE;
          if (lit) {
            const g = ctx.createRadialGradient(cx, cy, 1, cx, cy, ry * 1.5);
            g.addColorStop(0, 'rgba(255,120,96,1)'); g.addColorStop(0.45, 'rgba(232,32,18,0.95)');
            g.addColorStop(1, 'rgba(160,10,4,0)');
            ctx.fillStyle = g;
            ctx.beginPath(); ctx.ellipse(cx, cy, rx * 1.5, ry * 1.5, 0, 0, Math.PI * 2); ctx.fill();
          }
          ctx.fillStyle = lit ? '#ff5a40' : '#3a0a08';      // the lens itself
          ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.fill();
          if (!lit) {                                       // unlit glass still catches light
            ctx.fillStyle = 'rgba(255,255,255,0.35)';
            ctx.beginPath(); ctx.ellipse(cx - rx * 0.35, cy - ry * 0.4, rx * 0.22, ry * 0.18, 0, 0, Math.PI * 2); ctx.fill();
          }
          ctx.fillStyle = '#050607';                        // visor shading the top
          ctx.beginPath(); ctx.ellipse(cx, cy - ry * 0.55, rx * 1.15, ry * 0.5, 0, Math.PI, Math.PI * 2); ctx.fill();
        }
      }
      break;
    }
    case 'DECOR_STAND': {
      // INDIVIDUAL bucket seats rather than colour bands with lines ruled over
      // them. Each seat gets a lit top edge and its own shadow, and the row
      // behind casts onto the row in front - that shadowing is what stops a
      // grandstand reading as striped wallpaper from the car.
      bandsAcross(ctx, SEAT_PATTERNS[theme] ?? SEAT_PATTERNS.tarmac_day);
      const rowH = px(18), seatW = px(10);
      const img = ctx.getImageData(0, 0, SIZE, SIZE); // sample the band colours
      const sampleAt = (x: number, y: number): RGB => {
        const i = ((Math.floor(y) * SIZE + Math.floor(x)) * 4) | 0;
        return [img.data[i], img.data[i + 1], img.data[i + 2]];
      };
      for (let y = 0; y < SIZE; y += rowH) {
        for (let x = 0; x < SIZE; x += seatW) {
          const base = sampleAt(Math.min(SIZE - 1, x + seatW / 2), Math.min(SIZE - 1, y + rowH / 2));
          // a few seats sit empty or in shadow, so the block is never uniform
          const k = 0.72 + ((Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1 + 1) % 1 * 0.5;
          const pad = px(1.2);
          const g = ctx.createLinearGradient(0, y + pad, 0, y + rowH - pad);
          g.addColorStop(0, shade(base, k * 1.3));   // sky-lit top of the backrest
          g.addColorStop(0.45, shade(base, k));
          g.addColorStop(1, shade(base, k * 0.52));  // into the seat pan
          ctx.fillStyle = g;
          ctx.fillRect(x + pad, y + pad, seatW - pad * 2, rowH - pad * 2);
        }
        ao(ctx, 0, y, SIZE, px(5), 'down', 0.55);    // row behind shadows the one in front
        ctx.fillStyle = 'rgba(255,255,255,0.1)';     // step nosing catches the light
        ctx.fillRect(0, y + rowH - px(2), SIZE, px(1));
      }
      for (let x = 0; x < SIZE; x += seatW) ao(ctx, x, 0, px(2.5), SIZE, 'right', 0.3);
      speckle(ctx, dens(90), [0.5, 1.8], 0.05, false);
      break;
    }
    case 'DECOR_FRAME': {
      // PRECAST CONCRETE - the grandstand's risers, back and end walls. Mapped
      // world-anchored at one tile per 4 m, so it must tile both ways: nothing
      // here starts or stops inside the tile. Panel joints every 2 m, and the
      // grid of form-tie holes every precast panel carries.
      const conc: RGB = [150, 149, 144];
      ctx.fillStyle = shade(conc, 1);
      ctx.fillRect(0, 0, SIZE, SIZE);
      grain(ctx, 5);
      for (let i = 0; i < dens(10); i++) {                  // pour-to-pour tone
        const x = Math.random() * SIZE, y = Math.random() * SIZE, r = px(20 + Math.random() * 40);
        const k = 0.9 + Math.random() * 0.16;
        wrap(x, y, r, (wx, wy) => {
          const g = ctx.createRadialGradient(wx, wy, 1, wx, wy, r);
          g.addColorStop(0, shade(conc, k, 0.35));
          g.addColorStop(1, shade(conc, k, 0));
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(wx, wy, r, 0, Math.PI * 2); ctx.fill();
        });
      }
      speckle(ctx, dens(260), [0.4, 1.4], 0.08, false);
      for (let i = 0; i < dens(10); i++) {                  // rain: full height, so it tiles
        ctx.fillStyle = `rgba(52,48,42,${0.04 + Math.random() * 0.07})`;
        ctx.fillRect(Math.random() * SIZE, 0, px(1) + Math.random() * px(5), SIZE);
      }
      const tie = SIZE / 6.5;                               // ~0.6 m grid
      for (let y = tie / 2; y < SIZE; y += tie) {
        for (let x = tie / 2; x < SIZE; x += tie) {
          ctx.fillStyle = 'rgba(255,255,255,0.18)';
          ctx.beginPath(); ctx.arc(x + px(0.5), y + px(0.5), px(2.6), 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = 'rgba(30,28,26,0.55)';
          ctx.beginPath(); ctx.arc(x, y, px(1.9), 0, Math.PI * 2); ctx.fill();
        }
      }
      for (const x of [0, SIZE / 2]) {                      // panel joints
        ctx.fillStyle = 'rgba(0,0,0,0.42)';
        ctx.fillRect(x, 0, px(2), SIZE);
        ao(ctx, x + px(2), 0, px(7), SIZE, 'right', 0.26);
        ctx.fillStyle = 'rgba(255,255,255,0.14)';
        ctx.fillRect(x - px(1), 0, px(1), SIZE);
      }
      break;
    }
    case 'DECOR_STEEL': {
      // Painted structural steel: grandstand columns and brake-board legs.
      // paintBox gives each face a world-planar slice at one tile per 4 m, so
      // this tiles both ways and carries no lighting of its own - the engine
      // lights each face. Weathering only.
      const paint: RGB = [118, 124, 134];
      ctx.fillStyle = shade(paint, 1);
      ctx.fillRect(0, 0, SIZE, SIZE);
      grain(ctx, 4);
      speckle(ctx, dens(150), [0.4, 1.6], 0.06, true);
      for (let i = 0; i < dens(14); i++) {                  // full-height run marks
        ctx.fillStyle = `rgba(40,38,34,${0.04 + Math.random() * 0.08})`;
        ctx.fillRect(Math.random() * SIZE, 0, px(0.8) + Math.random() * px(3), SIZE);
      }
      for (let i = 0; i < dens(5); i++) {                   // the odd chip, to primer or rust
        const x = Math.random() * SIZE, y = Math.random() * SIZE, r = px(0.4) + Math.random() * px(0.9);
        ctx.fillStyle = Math.random() < 0.5 ? 'rgba(176,170,156,0.32)' : 'rgba(104,56,26,0.36)';
        ctx.beginPath(); ctx.ellipse(x, y, r * 1.5, r, Math.random() * Math.PI, 0, Math.PI * 2); ctx.fill();
      }
      break;
    }
    case 'DECOR_RAIL': {
      // Grandstand front: a concrete upstand with a galvanised handrail on
      // stanchions above it. U runs one tile per 2 m (stanchions every 1 m)
      // and V spans the parapet's full 1.1 m exactly once - it does NOT
      // repeat, so it can have a coping, a gap and a dirty foot.
      const conc: RGB = [154, 153, 148];
      const steel: RGB = [178, 184, 190];
      const railY = px(4), railH = px(12);
      const gapY0 = railY + railH, gapY1 = SIZE * 0.3;
      ctx.fillStyle = '#26282d';                            // looking through to the stand
      ctx.fillRect(0, 0, SIZE, gapY1);
      for (const x of [SIZE * 0.25, SIZE * 0.75]) {         // stanchions
        const w = px(7);
        const g = ctx.createLinearGradient(x - w, 0, x + w, 0);
        g.addColorStop(0, shade(steel, 0.5)); g.addColorStop(0.35, shade(steel, 1.25));
        g.addColorStop(1, shade(steel, 0.55));
        ctx.fillStyle = g;
        ctx.fillRect(x - w, gapY0, w * 2, gapY1 - gapY0);
      }
      cylBar(ctx, railY, railH, steel);                     // handrail
      ao(ctx, 0, gapY0, SIZE, px(6), 'down', 0.5);
      // upstand
      ctx.fillStyle = shade(conc, 1);
      ctx.fillRect(0, gapY1, SIZE, SIZE - gapY1);
      grain(ctx, 4);
      speckle(ctx, dens(120), [0.4, 1.3], 0.07, false);
      ctx.fillStyle = shade(conc, 1.22);                    // coping
      ctx.fillRect(0, gapY1, SIZE, px(9));
      ao(ctx, 0, gapY1 + px(9), SIZE, px(10), 'down', 0.38);
      ctx.fillStyle = 'rgba(0,0,0,0.38)';                   // joint every 2 m
      ctx.fillRect(0, gapY1, px(2), SIZE - gapY1);
      streaks(ctx, dens(14), gapY1 + px(9), SIZE * 0.5, 0.09);
      groundGrime(ctx, 0.2, 0.5);
      break;
    }
    case 'DECOR_LAMP': {
      // Floodlight head: a grid of lamps in a dark housing. The head is a box
      // 2.3 m wide and 0.9 m tall, mapped at one tile per 4 m - so a face shows
      // just over half the tile's width and its bottom fifth. The grid is at
      // real scale (9 lamps per 4 m) and tiles, so any window of it is right.
      ctx.fillStyle = '#23252a';
      ctx.fillRect(0, 0, SIZE, SIZE);
      const cell = SIZE / 9;
      for (let y = 0; y < SIZE; y += cell) {
        for (let x = 0; x < SIZE; x += cell) {
          const cx = x + cell / 2, cy = y + cell / 2, r = cell * 0.38;
          ctx.fillStyle = '#121316';                        // recess
          ctx.fillRect(x + cell * 0.06, y + cell * 0.06, cell * 0.88, cell * 0.88);
          const g = ctx.createRadialGradient(cx - r * 0.2, cy - r * 0.2, 1, cx, cy, r);
          g.addColorStop(0, '#ffffff'); g.addColorStop(0.5, '#fff1c8'); g.addColorStop(1, '#c8a868');
          ctx.fillStyle = g;
          ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = 'rgba(180,184,190,0.5)';        // reflector rim
          ctx.lineWidth = px(1.2);
          ctx.beginPath(); ctx.arc(cx, cy, r + px(1.5), 0, Math.PI * 2); ctx.stroke();
        }
      }
      break;
    }
    case 'DECOR_MAST': {
      // Galvanised floodlight mast. Same paintBox mapping as the poles, so the
      // same rule: tileable, no baked-in lighting. One bolted flange per 4 m
      // tile, and the mottled zinc that galvanising always has.
      const zinc: RGB = [154, 160, 166];
      ctx.fillStyle = shade(zinc, 1);
      ctx.fillRect(0, 0, SIZE, SIZE);
      speckle(ctx, dens(380), [0.6, 2.4], 0.08, true);
      speckle(ctx, dens(220), [0.5, 1.8], 0.07, false);
      for (let i = 0; i < dens(12); i++) {
        ctx.fillStyle = `rgba(48,44,38,${0.04 + Math.random() * 0.07})`;
        ctx.fillRect(Math.random() * SIZE, 0, px(1) + Math.random() * px(4), SIZE);
      }
      const fy = SIZE * 0.5, fh = px(10);
      ctx.fillStyle = shade(zinc, 1.12);
      ctx.fillRect(0, fy, SIZE, fh);
      ao(ctx, 0, fy + fh, SIZE, px(8), 'down', 0.4);
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillRect(0, fy, SIZE, px(1.2));
      for (let x = px(8); x < SIZE; x += px(22)) bolt(ctx, x, fy + fh / 2, px(2.2));
      break;
    }
    case 'DECOR_GRASSTUFT': {
      // A CLUMP of grass on a TRANSPARENT background. This is the one texture
      // that must have alpha: the card is a rectangle, and everything that
      // isn't a blade has to be cut away or you see a green sheet standing in
      // the verge. Blades fan from the bottom centre so a card reads as one
      // tuft growing out of the ground.
      ctx.clearRect(0, 0, SIZE, SIZE);
      const [tr, tg, tb] = hexRgb(hex);
      const rootY = SIZE * 0.99;
      const draw = (count: number, lo: number, hi: number, dMin: number, dMax: number) => {
        for (let i = 0; i < count; i++) {
          const spread = (Math.random() - 0.5) * SIZE * 0.86;
          const len = SIZE * (lo + Math.random() * (hi - lo));
          const wid = px(1.6 + Math.random() * 2.4);
          // blades splay outward more the further they start from the centre
          const lean = (spread / (SIZE * 0.5)) * 0.55 + (Math.random() - 0.5) * 0.3;
          const d = dMin + Math.random() * (dMax - dMin);
          blade(ctx, SIZE / 2 + spread, rootY, len, wid,
            lean, `rgb(${Math.max(0, tr + d)},${Math.max(0, tg + d)},${Math.max(0, tb + d)})`);
        }
      };
      draw(150, 0.30, 0.55, -46, -26); // shaded inner blades
      draw(210, 0.40, 0.75, -16, 10);  // the body of the tuft
      draw(120, 0.50, 0.92, 16, 42);   // lit outer blades
      break;
    }
    case 'DECOR_TREE': {
      // An ATLAS, laid out by TREE_ATLAS in geometry/decor.ts: bark plus three
      // foliage tones. It used to be one foliage texture tinted per tree by
      // vertex colour, but the game never receives vertex colours, so every
      // tree was identical - and the trunks, which were only brown by vertex
      // colour, rendered as leaves.
      const rect = (r: readonly [number, number, number, number]) =>
        [r[0] * SIZE, (1 - r[3]) * SIZE, (r[2] - r[0]) * SIZE, (r[3] - r[1]) * SIZE] as const;
      const inRegion = (r: readonly [number, number, number, number], draw: (x: number, y: number, w: number, h: number) => void) => {
        const [x, y, w, h] = rect(r);
        ctx.save();
        ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
        draw(x, y, w, h);
        ctx.restore();
      };

      // BARK: vertical fissures over ridges, lichen creeping up from the root.
      inRegion(TREE_ATLAS.bark, (x, y, w, h) => {
        ctx.fillStyle = '#4e3a2a';
        ctx.fillRect(x, y, w, h);
        for (let i = 0; i < dens(120); i++) {
          let fx = x + Math.random() * w;
          const fw = px(0.8) + Math.random() * px(2.6);
          ctx.fillStyle = Math.random() < 0.55 ? 'rgba(20,14,10,0.55)' : 'rgba(120,96,72,0.4)';
          for (let fy = y; fy < y + h; fy += px(3)) {        // wandering, not ruled
            fx += (Math.random() - 0.5) * px(1.6);
            ctx.fillRect(fx, fy, fw, px(3.4));
          }
        }
        for (let i = 0; i < dens(30); i++) {                // cross-cracks
          ctx.fillStyle = 'rgba(15,10,8,0.5)';
          ctx.fillRect(x + Math.random() * w, y + Math.random() * h, px(3) + Math.random() * px(9), px(0.8));
        }
        vgrad(ctx, y + h * 0.7, y + h, [[0, 'rgba(96,112,72,0)'], [1, 'rgba(96,112,72,0.45)']]);
      });

      // FOLIAGE: clumps of leaves over dark gaps. Each clump is lit from above
      // and shadowed underneath, and the whole region darkens toward its foot,
      // which is the bottom of whichever canopy tier samples it.
      const leaves = (r: readonly [number, number, number, number], gap: RGB, leaf: RGB) =>
        inRegion(r, (x, y, w, h) => {
          ctx.fillStyle = shade(gap, 1);
          ctx.fillRect(x, y, w, h);
          for (let c = 0; c < dens(26); c++) {
            const cx = x + Math.random() * w, cy = y + Math.random() * h;
            const cr = px(10) + Math.random() * px(16);
            for (let i = 0; i < 70; i++) {
              const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * cr;
              const lx = cx + Math.cos(a) * d, ly = cy + Math.sin(a) * d;
              const lit = 0.62 + 0.62 * Math.max(0, (cy - ly) / cr + 0.5);  // top of clump lit
              const k = lit * (0.85 + Math.random() * 0.3);
              ctx.fillStyle = shade(leaf, k, 0.9);
              ctx.beginPath();
              ctx.ellipse(lx, ly, px(1.4) + Math.random() * px(1.8), px(0.9) + Math.random() * px(1.2),
                Math.random() * Math.PI, 0, Math.PI * 2);
              ctx.fill();
            }
          }
          vgrad(ctx, y, y + h, [[0, 'rgba(255,255,230,0.06)'], [0.6, 'rgba(0,0,0,0)'], [1, 'rgba(0,0,0,0.2)']]);
        });
      leaves(TREE_ATLAS.leafA, [40, 58, 26], [108, 146, 62]);
      leaves(TREE_ATLAS.leafB, [30, 46, 22], [78, 112, 48]);
      leaves(TREE_ATLAS.leafC, [18, 32, 22], [50, 82, 50]);
      break;
    }
    case 'DECOR_POLE': {
      // Painted pole (flag pole, arch posts). paintBox gives each side a
      // world-planar slice of U, so the old single sine of 'cylinder shading'
      // landed on each face at an arbitrary brightness. Tile both ways, carry
      // no lighting of its own, weather it.
      const base = hexRgb(hex) as RGB;
      ctx.fillStyle = shade(base, 1);
      ctx.fillRect(0, 0, SIZE, SIZE);
      grain(ctx, 4);
      for (let i = 0; i < dens(12); i++) {
        ctx.fillStyle = `rgba(50,46,40,${0.04 + Math.random() * 0.07})`;
        ctx.fillRect(Math.random() * SIZE, 0, px(0.8) + Math.random() * px(3), SIZE);
      }
      speckle(ctx, dens(90), [0.4, 1.4], 0.06, false);
      break;
    }
    default:
      grain(ctx, 8);
  }
  return c.toDataURL('image/png');
}

// One PNG per surface present in the track. Textures live NEXT TO the fbx so
// KsEditor's persistence auto-load finds them (same layout RTB uses).
// The same textures the export writes, kept as data URLs so the in-app preview
// can show the real material instead of a flat colour. Sharing one drawing path
// means the preview cannot drift from what Assetto Corsa ends up with.
export function genTextureUrls(built: BuiltTrack, pal: Palette, theme: Theme, wallStyle: WallStyle): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of built.meshes) {
    const base = m.name.replace(/_\d+$/, '');
    if (out.has(base)) continue;
    out.set(base, drawTexture(base, meshColor(base, pal), theme, wallStyle));
  }
  return out;
}

export function genTextures(built: BuiltTrack, pal: Palette, theme: Theme, wallStyle: WallStyle): TexFile[] {
  const seen = new Set<string>();
  const out: TexFile[] = [];
  for (const m of built.meshes) {
    if (seen.has(m.name)) continue;
    seen.add(m.name);
    const name = `${shortName(m.name)}.png`;
    // ksEditor resolves texture FILES from the `texture\` subfolder next to
    // the FBX (verified live: root-level pngs stay NULL, texture\ loads).
    out.push({
      path: `texture/${name}`,
      name,
      surface: m.name,
      bytes: dataUrlToBytes(drawTexture(m.name, meshColor(m.name, pal), theme, wallStyle)),
    });
  }
  return out;
}
