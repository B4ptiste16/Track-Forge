import type { BuiltTrack } from '../geometry';
import type { Theme, WallStyle } from '../types';
import { meshColor, type Palette } from '../state/project';
import { KERB_PATTERNS } from '../geometry/kerbs';
import { SEAT_PATTERNS } from '../geometry/decor';

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
    ctx.beginPath();
    ctx.arc(Math.random() * SIZE, Math.random() * SIZE, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function bandsAcross(ctx: CanvasRenderingContext2D, colors: string[]): void {
  const w = SIZE / colors.length;
  colors.forEach((col, i) => {
    ctx.fillStyle = col;
    ctx.fillRect(Math.round(i * w), 0, Math.ceil(w), SIZE);
  });
}

// Draw the texture for one surface. Rich enough to read as a material in-game;
// the UVs exported in the FBX make stripes/bands land where they should.
function drawTexture(surface: string, hex: string, theme: Theme, wallStyle: WallStyle): string {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = hex;
  ctx.fillRect(0, 0, SIZE, SIZE);

  switch (surface) {
    case '1ROAD':
    case '1PIT': {
      grain(ctx, 10);
      // asphalt = a mix of aggregate sizes in binder, not uniform speckle
      speckle(ctx, dens(900), [px(0.4), px(1.1)], 0.16, true); // fine aggregate
      speckle(ctx, dens(500), [px(0.4), px(1.0)], 0.18, false);
      speckle(ctx, dens(90), [px(1.1), px(2.3)], 0.13, true);  // coarser stones
      // broad tonal patches: laid in passes, so asphalt is never one flat tone
      const [rr, gg, bb] = hexRgb(hex);
      for (let i = 0; i < dens(14); i++) {
        const x = Math.random() * SIZE, y = Math.random() * SIZE, rad = px(18 + Math.random() * 46);
        const d = -7 + Math.random() * 14;
        const gr = ctx.createRadialGradient(x, y, 1, x, y, rad);
        gr.addColorStop(0, `rgba(${rr + d},${gg + d},${bb + d},0.5)`);
        gr.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gr;
        ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill();
      }
      break;
    }
    case '1GRASS': {
      grain(ctx, 13);
      const [r, g, b] = hexRgb(hex);
      // 1) mown/growth clumps — big soft tonal variation so it isn't flat green
      for (let i = 0; i < dens(20); i++) {
        const x = Math.random() * SIZE, y = Math.random() * SIZE, rad = px(14 + Math.random() * 40);
        const d = -16 + Math.random() * 30;
        const gr = ctx.createRadialGradient(x, y, 1, x, y, rad);
        gr.addColorStop(0, `rgba(${r + d},${g + d + 6},${b + d},0.55)`);
        gr.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = gr;
        ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2); ctx.fill();
      }
      // 2) individual blades, angled and varied in length/tone (not all vertical)
      for (let i = 0; i < dens(2600); i++) {
        const d = Math.random() < 0.5 ? -26 - Math.random() * 12 : 20 + Math.random() * 16;
        ctx.save();
        ctx.translate(Math.random() * SIZE, Math.random() * SIZE);
        ctx.rotate((Math.random() - 0.5) * 1.1); // lean
        ctx.fillStyle = `rgb(${r + d},${g + d},${b + d})`;
        ctx.fillRect(0, 0, px(1), px(2 + Math.random() * 4));
        ctx.restore();
      }
      // 3) a few dry/bare scuffs
      for (let i = 0; i < dens(7); i++) {
        ctx.fillStyle = `rgba(${r + 34},${g + 22},${b - 6},0.22)`;
        ctx.beginPath();
        ctx.ellipse(Math.random() * SIZE, Math.random() * SIZE, px(6 + Math.random() * 12), px(3 + Math.random() * 6),
          Math.random() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case '1SAND': { // gravel trap
      grain(ctx, 8);
      const [r, g, b] = hexRgb(hex);
      // 1) DRAG MARKS: a used trap is raked into ruts and scored by cars that
      //    ploughed through it. Baked in, because AC can't deform a surface at
      //    runtime — this is what gives the "cars have been through here" read.
      for (let i = 0; i < dens(9); i++) {
        const y0 = Math.random() * SIZE;
        const ang = (Math.random() - 0.5) * 0.5;
        ctx.save();
        ctx.translate(Math.random() * SIZE, y0);
        ctx.rotate(ang);
        const w = px(5 + Math.random() * 9), len = px(60 + Math.random() * 180);
        ctx.fillStyle = 'rgba(0,0,0,0.16)'; // gouged trough
        ctx.fillRect(-len / 2, 0, len, w);
        ctx.fillStyle = `rgba(${r + 30},${g + 26},${b + 20},0.35)`; // thrown-up ridge
        ctx.fillRect(-len / 2, -px(2), len, px(2.5));
        ctx.fillRect(-len / 2, w, len, px(2.5));
        ctx.restore();
      }
      // 2) pebbles: lit body + darker under-edge, several size classes
      for (let i = 0; i < dens(1100); i++) {
        const pr = px(0.8 + Math.random() * (Math.random() < 0.12 ? 4.2 : 2.0));
        const x = Math.random() * SIZE, y = Math.random() * SIZE;
        const d = -24 + Math.random() * 62;
        ctx.fillStyle = `rgb(${r + d},${g + d},${b + d})`;
        ctx.beginPath(); ctx.arc(x, y, pr, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        ctx.beginPath(); ctx.arc(x + pr * 0.3, y + pr * 0.45, pr * 0.8, 0, Math.PI); ctx.fill();
      }
      break;
    }
    case '1CONCRETE': {
      grain(ctx, 6);
      speckle(ctx, dens(350), [px(0.4), px(1.0)], 0.10, false);
      ctx.fillStyle = 'rgba(0,0,0,0.18)'; // slab seams
      for (let y = 0; y < SIZE; y += px(64)) ctx.fillRect(0, y, SIZE, px(1));
      for (let x = 0; x < SIZE; x += px(128)) ctx.fillRect(x, 0, px(1), SIZE);
      break;
    }
    case '1TARMAC': { // paved run-off: like the road but lighter, patch seams
      grain(ctx, 11);
      speckle(ctx, dens(800), [px(0.4), px(1.1)], 0.14, true);
      speckle(ctx, dens(450), [px(0.4), px(1.0)], 0.16, false);
      ctx.fillStyle = 'rgba(0,0,0,0.10)'; // repave patch seams
      ctx.fillRect(0, px(90), SIZE, px(4));
      ctx.fillRect(px(150), 0, px(4), SIZE);
      break;
    }
    case '1DIRT': { // packed earth
      grain(ctx, 12);
      const [r, g, b] = hexRgb(hex);
      for (let i = 0; i < dens(900); i++) { // dry clods + small stones
        const d = -30 + Math.random() * 55;
        ctx.fillStyle = `rgb(${r + d},${g + d},${b + d})`;
        const pr = px(0.6 + Math.random() * 1.8);
        ctx.beginPath();
        ctx.arc(Math.random() * SIZE, Math.random() * SIZE, pr, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = 'rgba(0,0,0,0.10)'; // faint wheel ruts
      ctx.fillRect(0, px(70), SIZE, px(8));
      ctx.fillRect(0, px(180), SIZE, px(8));
      break;
    }
    case '1KERB': {
      const pattern = KERB_PATTERNS[theme] ?? KERB_PATTERNS.tarmac_day;
      bandsAcross(ctx, pattern);
      grain(ctx, 7);
      ctx.fillStyle = 'rgba(0,0,0,0.25)'; // paint edges between stripes
      const w = SIZE / pattern.length;
      for (let i = 1; i < pattern.length; i++) ctx.fillRect(Math.round(i * w) - 1, 0, 2, SIZE);
      break;
    }
    case '1KERBHI': {
      grain(ctx, 9);
      break;
    }
    case '1WALL': {
      // v runs bottom (y=SIZE) -> top (y=0) on wall quads.
      if (wallStyle === 'tecpro') {
        ctx.fillStyle = '#c8322e';
        ctx.fillRect(0, 0, SIZE, SIZE);
        ctx.fillStyle = '#e9eaec'; // white top band
        ctx.fillRect(0, 0, SIZE, Math.round(SIZE * 0.28));
        grain(ctx, 5);
        ctx.fillStyle = 'rgba(0,0,0,0.28)'; // block joints
        for (let x = 0; x < SIZE; x += 48) ctx.fillRect(x, 0, 3, SIZE);
      } else if (wallStyle === 'armco') {
        ctx.fillStyle = '#9aa0a8';
        ctx.fillRect(0, 0, SIZE, SIZE);
        grain(ctx, 6);
        // two corrugated rails
        for (const yc of [SIZE * 0.30, SIZE * 0.66]) {
          ctx.fillStyle = 'rgba(255,255,255,0.35)';
          ctx.fillRect(0, yc - 14, SIZE, 10);
          ctx.fillStyle = 'rgba(0,0,0,0.30)';
          ctx.fillRect(0, yc + 2, SIZE, 6);
        }
        ctx.fillStyle = 'rgba(0,0,0,0.35)'; // posts
        for (let x = 16; x < SIZE; x += 64) ctx.fillRect(x, 0, 5, SIZE);
      } else if (wallStyle === 'blocks') {
        ctx.fillStyle = '#2c2e33'; // tyre stacks
        ctx.fillRect(0, 0, SIZE, SIZE);
        grain(ctx, 7);
        ctx.strokeStyle = 'rgba(0,0,0,0.5)';
        ctx.lineWidth = 3;
        for (let y = 16; y < SIZE; y += 32) {
          for (let x = 16; x < SIZE + 16; x += 32) {
            ctx.beginPath(); ctx.arc(x, y, 14, 0, Math.PI * 2); ctx.stroke();
          }
        }
      } else if (wallStyle === 'hay') {
        ctx.fillStyle = '#c9a94e'; // stacked hay bales (classic-circuit look)
        ctx.fillRect(0, 0, SIZE, SIZE);
        grain(ctx, 10);
        const [r, g, b] = hexRgb('#c9a94e');
        for (let i = 0; i < 1200; i++) { // straw streaks
          const d = -35 + Math.random() * 60;
          ctx.fillStyle = `rgb(${r + d},${g + d},${b + d})`;
          ctx.fillRect(Math.random() * SIZE, Math.random() * SIZE, 3 + Math.random() * 5, 1);
        }
        ctx.fillStyle = 'rgba(0,0,0,0.30)'; // bale joints, brick-laid
        for (let y = 0; y < SIZE; y += 44) ctx.fillRect(0, y, SIZE, 3);
        for (let y = 0; y < SIZE; y += 44) {
          const off = (y / 44) % 2 === 0 ? 0 : 40;
          for (let x = off; x < SIZE; x += 80) ctx.fillRect(x, y, 3, 44);
        }
        ctx.fillStyle = 'rgba(120,80,30,0.35)'; // twine bands
        for (let y = 12; y < SIZE; y += 44) ctx.fillRect(0, y, SIZE, 2);
      } else {
        grain(ctx, 6);
        ctx.fillStyle = 'rgba(0,0,0,0.16)'; // concrete segment joints
        for (let x = 0; x < SIZE; x += 64) ctx.fillRect(x, 0, 2, SIZE);
        ctx.fillRect(0, 150, SIZE, 3);
      }
      break;
    }
    case '1WALLPOLY': { // yellow polystyrene escape-road blocks
      grain(ctx, 8);
      ctx.fillStyle = 'rgba(0,0,0,0.20)'; // block joints
      for (let x = 0; x < SIZE; x += 56) ctx.fillRect(x, 0, 3, SIZE);
      ctx.fillStyle = 'rgba(255,255,255,0.25)';
      ctx.fillRect(0, 0, SIZE, 10);
      break;
    }
    case 'ROAD_LINE':
    case 'PIT_LINE': {
      grain(ctx, 5);
      break;
    }
    case 'DECOR_BUILDING': {
      grain(ctx, 6);
      // window grid
      ctx.fillStyle = 'rgba(30,40,55,0.85)';
      for (let y = 24; y < SIZE - 16; y += 48) {
        for (let x = 16; x < SIZE - 16; x += 40) ctx.fillRect(x, y, 24, 20);
      }
      break;
    }
    case 'DECOR_BLDGLASS': { // full glass curtain wall
      grain(ctx, 3);
      for (let y = 4; y < SIZE; y += 36) {
        for (let x = 4; x < SIZE; x += 30) {
          const sky = 120 + Math.random() * 70;
          ctx.fillStyle = `rgba(${sky * 0.75},${sky * 0.9},${sky},0.9)`;
          ctx.fillRect(x, y, 26, 32);
        }
      }
      ctx.fillStyle = 'rgba(20,25,32,0.8)'; // mullions
      for (let y = 0; y < SIZE; y += 36) ctx.fillRect(0, y, SIZE, 4);
      for (let x = 0; x < SIZE; x += 30) ctx.fillRect(x, 0, 4, SIZE);
      break;
    }
    case 'DECOR_BLDBRICK': { // brick courses with mortar joints
      grain(ctx, 8);
      ctx.fillStyle = 'rgba(230,225,215,0.5)';
      for (let y = 0; y < SIZE; y += 16) {
        ctx.fillRect(0, y, SIZE, 2);
        const off = (y / 16) % 2 === 0 ? 0 : 16;
        for (let x = off; x < SIZE; x += 32) ctx.fillRect(x, y, 2, 16);
      }
      ctx.fillStyle = 'rgba(30,40,55,0.85)'; // sparse windows
      for (let y = 30; y < SIZE - 20; y += 64) {
        for (let x = 20; x < SIZE - 20; x += 72) ctx.fillRect(x, y, 28, 24);
      }
      break;
    }
    case 'DECOR_BLDHANGAR': { // corrugated metal shed
      grain(ctx, 5);
      for (let x = 0; x < SIZE; x += 12) { // vertical corrugation
        ctx.fillStyle = 'rgba(255,255,255,0.16)';
        ctx.fillRect(x, 0, 4, SIZE);
        ctx.fillStyle = 'rgba(0,0,0,0.16)';
        ctx.fillRect(x + 6, 0, 4, SIZE);
      }
      ctx.fillStyle = 'rgba(0,0,0,0.30)'; // panel seams
      for (let y = 0; y < SIZE; y += 84) ctx.fillRect(0, y, SIZE, 3);
      break;
    }
    case 'DECOR_PITBLDG': {
      grain(ctx, 6);
      ctx.fillStyle = 'rgba(255,255,255,0.18)'; // fascia band
      ctx.fillRect(0, 0, SIZE, 26);
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      for (let x = 0; x < SIZE; x += 64) ctx.fillRect(x, 0, 2, SIZE);
      break;
    }
    case 'DECOR_GARAGE': {
      grain(ctx, 5);
      ctx.fillStyle = 'rgba(255,255,255,0.10)'; // roller-door ribs
      for (let y = 6; y < SIZE; y += 18) ctx.fillRect(0, y, SIZE, 4);
      break;
    }
    case 'DECOR_BOLLARD': {
      // A trackside marker post, read from bottom (V=0) to top (V=1): a dark
      // weathered foot, the orange body, and two retro-reflective bands near the
      // top — the thing a driver actually picks out at the edge of a run-off.
      // The previous version was one translucent stripe on flat orange, which on
      // a post barely read as a texture at all.
      const base = Math.round(SIZE * 0.14);
      ctx.fillStyle = '#2b2b2e';                       // dirty concrete foot
      ctx.fillRect(0, SIZE - base, SIZE, base);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';              // shadow where it meets
      ctx.fillRect(0, SIZE - base - px(3), SIZE, px(3));
      // vertical shading so the round post doesn't look like a flat card
      for (let x = 0; x < SIZE; x++) {
        const k = Math.sin((x / SIZE) * Math.PI);       // bright in the middle
        ctx.fillStyle = `rgba(0,0,0,${(0.34 * (1 - k)).toFixed(3)})`;
        ctx.fillRect(x, 0, 1, SIZE - base);
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
      bandsAcross(ctx, TRICOLORE);
      // soft horizontal waves so it reads as cloth
      for (let y = 0; y < SIZE; y++) {
        const s = Math.sin(y / 9) * 0.5 + Math.sin(y / 23) * 0.5;
        ctx.fillStyle = s > 0 ? `rgba(255,255,255,${0.10 * s})` : `rgba(0,0,0,${-0.12 * s})`;
        ctx.fillRect(0, y, SIZE, 1);
      }
      break;
    }
    case 'DECOR_ARCH': {
      bandsAcross(ctx, TRICOLORE);
      grain(ctx, 4);
      break;
    }
    case 'DECOR_MARKER': {
      // three horizontal bands (v = distance): 100 m, 50 m, 25 m, each a white
      // board with descending black chevrons so the count reads as the distance.
      const third = SIZE / 3;
      const counts = [3, 2, 1]; // top band = furthest (3 chevrons) ... 1 nearest
      for (let bnd = 0; bnd < 3; bnd++) {
        const y0 = bnd * third;
        ctx.fillStyle = '#f4f4f4';
        ctx.fillRect(0, y0, SIZE, third);
        ctx.fillStyle = '#111';
        const nC = counts[bnd];
        const cw = SIZE / (nC * 2 + 1);
        for (let k = 0; k < nC; k++) {
          const x = cw * (k * 2 + 1);
          ctx.fillRect(x, y0 + 10, cw, third - 20);
        }
        ctx.strokeStyle = '#111'; ctx.lineWidth = 4;
        ctx.strokeRect(2, y0 + 2, SIZE - 4, third - 4);
      }
      break;
    }
    case 'DECOR_GANTRY': {
      grain(ctx, 5);
      speckle(ctx, 200, [0.4, 1.0], 0.08, false);
      break;
    }
    case 'DECOR_LIGHTS': {
      // black panel with a row of five red start lights (lit).
      ctx.fillStyle = '#0b0d11';
      ctx.fillRect(0, 0, SIZE, SIZE);
      const n = 5, r = SIZE / 14;
      for (let k = 0; k < n; k++) {
        const cx = (SIZE / (n + 1)) * (k + 1);
        const cy = SIZE / 2;
        const g = ctx.createRadialGradient(cx, cy, 1, cx, cy, r * 1.6);
        g.addColorStop(0, '#ff5a4a'); g.addColorStop(0.6, '#d21f10'); g.addColorStop(1, 'rgba(120,10,5,0.2)');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(cx, cy, r * 1.6, 0, Math.PI * 2); ctx.fill();
      }
      break;
    }
    case 'DECOR_STAND': {
      bandsAcross(ctx, SEAT_PATTERNS[theme] ?? SEAT_PATTERNS.tarmac_day); // seat colour blocks
      ctx.fillStyle = 'rgba(0,0,0,0.30)'; // seat rows
      for (let y = 0; y < SIZE; y += 18) ctx.fillRect(0, y, SIZE, 2);
      ctx.fillStyle = 'rgba(0,0,0,0.15)'; // seat separations
      for (let x = 0; x < SIZE; x += 10) ctx.fillRect(x, 0, 1, SIZE);
      break;
    }
    case 'DECOR_FRAME': {
      grain(ctx, 7);
      speckle(ctx, 250, [0.4, 1.0], 0.10, false);
      break;
    }
    case 'DECOR_LAMP': {
      // Lamp head: a grid of bright lens squares in a dark housing, so the
      // fixture reads as a floodlight cluster rather than a white box.
      ctx.fillStyle = '#2a2c31';
      ctx.fillRect(0, 0, SIZE, SIZE);
      const cell = px(42);
      for (let y = px(6); y < SIZE - px(6); y += cell) {
        for (let x = px(6); x < SIZE - px(6); x += cell) {
          const g2 = ctx.createRadialGradient(x + cell * 0.4, y + cell * 0.4, 1, x + cell * 0.4, y + cell * 0.4, cell * 0.5);
          g2.addColorStop(0, '#ffffff');
          g2.addColorStop(0.55, '#fff3cf');
          g2.addColorStop(1, 'rgba(255,225,160,0.35)');
          ctx.fillStyle = g2;
          ctx.fillRect(x, y, cell * 0.8, cell * 0.8);
        }
      }
      break;
    }
    case 'DECOR_MAST': {
      // Galvanised pole: vertical shading + faint banding.
      const [r, g, b] = hexRgb(hex);
      for (let x = 0; x < SIZE; x++) {
        const k = 1 - Math.abs(x - SIZE / 2) / (SIZE / 2);
        const d = -34 + 58 * k;
        ctx.fillStyle = `rgb(${r + d},${g + d},${b + d})`;
        ctx.fillRect(x, 0, 1, SIZE);
      }
      ctx.fillStyle = 'rgba(0,0,0,0.14)';
      for (let y = 0; y < SIZE; y += px(64)) ctx.fillRect(0, y, SIZE, px(2));
      break;
    }
    case 'DECOR_TREE': {
      // Mottled foliage: clumps of light/dark leaves. Per-tree vertex colours
      // tint this, so one texture covers a whole varied treeline.
      grain(ctx, 12);
      const [r, g, b] = hexRgb(hex);
      for (let i = 0; i < dens(1500); i++) {
        const d = -40 + Math.random() * 80;
        ctx.fillStyle = `rgba(${r + d},${g + d},${b + d * 0.6},0.75)`;
        ctx.beginPath();
        ctx.arc(Math.random() * SIZE, Math.random() * SIZE, px(1 + Math.random() * 3.5), 0, Math.PI * 2);
        ctx.fill();
      }
      for (let i = 0; i < dens(14); i++) { // shadowed gaps between leaf clusters
        ctx.fillStyle = 'rgba(0,0,0,0.16)';
        ctx.beginPath();
        ctx.arc(Math.random() * SIZE, Math.random() * SIZE, px(6 + Math.random() * 14), 0, Math.PI * 2);
        ctx.fill();
      }
      break;
    }
    case 'DECOR_POLE': {
      // vertical cylinder shading: bright centre, darker edges
      const [r, g, b] = hexRgb(hex);
      for (let x = 0; x < SIZE; x++) {
        const k = 1 - Math.abs(x - SIZE / 2) / (SIZE / 2);
        const d = -30 + 55 * k;
        ctx.fillStyle = `rgb(${r + d},${g + d},${b + d})`;
        ctx.fillRect(x, 0, 1, SIZE);
      }
      break;
    }
    default:
      grain(ctx, 8);
  }
  return c.toDataURL('image/png');
}

// One PNG per surface present in the track. Textures live NEXT TO the fbx so
// KsEditor's persistence auto-load finds them (same layout RTB uses).
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
