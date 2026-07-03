import type { BuiltTrack } from '../geometry';
import type { Theme } from '../types';
import { meshColor, type Palette } from '../state/project';
import { KERB_PATTERNS } from '../geometry/kerbs';

const TRICOLORE = ['#0055A4', '#f2f2f2', '#EF4135'];

export interface TexFile {
  path: string; // e.g. texture/road.png
  name: string; // e.g. road.png
  surface: string; // e.g. 1ROAD
  bytes: Uint8Array;
}

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

// Draw a 64x64 placeholder texture for a surface: a solid base colour with very
// light noise, painted stripes for kerbs, and tricolore art for the France decor.
function drawTexture(surface: string, hex: string, theme: Theme): string {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = hex;
  ctx.fillRect(0, 0, size, size);

  if (surface === '1KERB') {
    const pattern = KERB_PATTERNS[theme] ?? KERB_PATTERNS.tarmac_day;
    const w = size / pattern.length;
    pattern.forEach((col, i) => {
      ctx.fillStyle = col;
      ctx.fillRect(Math.round(i * w), 0, Math.ceil(w), size);
    });
  } else if (surface === 'DECOR_FLAG' || surface === 'DECOR_ARCH') {
    TRICOLORE.forEach((col, i) => {
      ctx.fillStyle = col;
      ctx.fillRect(Math.round((i * size) / 3), 0, Math.ceil(size / 3), size);
    });
  } else if (surface === 'DECOR_STAND') {
    TRICOLORE.forEach((col, i) => {
      ctx.fillStyle = col;
      ctx.fillRect(0, Math.round((i * size) / 3), size, Math.ceil(size / 3));
    });
  } else {
    // subtle per-pixel noise so it isn't dead flat
    const [r, g, b] = hexRgb(hex);
    const img = ctx.getImageData(0, 0, size, size);
    for (let i = 0; i < img.data.length; i += 4) {
      const n = (Math.random() - 0.5) * 16;
      img.data[i] = Math.max(0, Math.min(255, r + n));
      img.data[i + 1] = Math.max(0, Math.min(255, g + n));
      img.data[i + 2] = Math.max(0, Math.min(255, b + n));
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }
  return c.toDataURL('image/png');
}

// One placeholder PNG per surface present in the track, coloured from the theme.
export function genTextures(built: BuiltTrack, pal: Palette, theme: Theme): TexFile[] {
  const seen = new Set<string>();
  const out: TexFile[] = [];
  for (const m of built.meshes) {
    if (seen.has(m.name)) continue;
    seen.add(m.name);
    const name = `${shortName(m.name)}.png`;
    out.push({
      path: `texture/${name}`,
      name,
      surface: m.name,
      bytes: dataUrlToBytes(drawTexture(m.name, meshColor(m.name, pal), theme)),
    });
  }
  return out;
}
