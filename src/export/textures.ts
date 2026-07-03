import type { BuiltTrack } from '../geometry';
import type { Theme } from '../types';
import { meshColor, type Palette } from '../state/project';
import { KERB_PATTERNS } from '../geometry/kerbs';

export interface TexFile {
  path: string; // e.g. road.png (beside the fbx, where KsEditor looks)
  name: string; // e.g. road.png
  surface: string; // e.g. 1ROAD
  bytes: Uint8Array;
}

const SIZE = 256;
const TRICOLORE = ['#0055A4', '#f2f2f2', '#EF4135'];

// Short texture filename for a surface mesh name (1ROAD -> road).
function shortName(meshName: string): string {
  return meshName.replace(/^1/, '').toLowerCase();
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
function drawTexture(surface: string, hex: string, theme: Theme): string {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = hex;
  ctx.fillRect(0, 0, SIZE, SIZE);

  switch (surface) {
    case '1ROAD':
    case '1PIT': {
      grain(ctx, 10);
      speckle(ctx, 900, [0.4, 1.1], 0.16, true); // fine aggregate
      speckle(ctx, 500, [0.4, 1.0], 0.18, false);
      break;
    }
    case '1GRASS': {
      grain(ctx, 13);
      // short blade streaks
      const [r, g, b] = hexRgb(hex);
      for (let i = 0; i < 1400; i++) {
        const dark = Math.random() < 0.5;
        const d = dark ? -26 : 22;
        ctx.fillStyle = `rgb(${r + d},${g + d},${b + d})`;
        ctx.fillRect(Math.random() * SIZE, Math.random() * SIZE, 1, 2 + Math.random() * 3);
      }
      break;
    }
    case '1SAND': { // gravel trap
      grain(ctx, 8);
      const [r, g, b] = hexRgb(hex);
      for (let i = 0; i < 700; i++) {
        // little pebbles: lit body + a darker under-edge
        const pr = 1 + Math.random() * 2.4;
        const x = Math.random() * SIZE, y = Math.random() * SIZE;
        const d = -24 + Math.random() * 60;
        ctx.fillStyle = `rgb(${r + d},${g + d},${b + d})`;
        ctx.beginPath(); ctx.arc(x, y, pr, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = 'rgba(0,0,0,0.22)';
        ctx.beginPath(); ctx.arc(x + pr * 0.3, y + pr * 0.45, pr * 0.8, 0, Math.PI); ctx.fill();
      }
      break;
    }
    case '1CONCRETE': {
      grain(ctx, 6);
      speckle(ctx, 350, [0.4, 1.0], 0.10, false);
      ctx.fillStyle = 'rgba(0,0,0,0.18)'; // slab seams
      for (let y = 0; y < SIZE; y += 64) ctx.fillRect(0, y, SIZE, 1);
      for (let x = 0; x < SIZE; x += 128) ctx.fillRect(x, 0, 1, SIZE);
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
      grain(ctx, 6);
      ctx.fillStyle = 'rgba(0,0,0,0.16)'; // barrier segment joints
      for (let x = 0; x < SIZE; x += 64) ctx.fillRect(x, 0, 2, SIZE);
      ctx.fillRect(0, 150, SIZE, 3); // horizontal rail shadow
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
    case 'DECOR_STAND': {
      bandsAcross(ctx, TRICOLORE); // seat colour blocks along the stand
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
export function genTextures(built: BuiltTrack, pal: Palette, theme: Theme): TexFile[] {
  const seen = new Set<string>();
  const out: TexFile[] = [];
  for (const m of built.meshes) {
    if (seen.has(m.name)) continue;
    seen.add(m.name);
    const name = `${shortName(m.name)}.png`;
    out.push({
      path: name,
      name,
      surface: m.name,
      bytes: dataUrlToBytes(drawTexture(m.name, meshColor(m.name, pal), theme)),
    });
  }
  return out;
}
