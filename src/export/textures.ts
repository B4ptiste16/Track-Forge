import type { BuiltTrack } from '../geometry';
import { meshColor, type Palette } from '../state/project';

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
// light noise, and red/white stripes for kerbs so the track reads clearly.
function drawTexture(surface: string, hex: string): string {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = hex;
  ctx.fillRect(0, 0, size, size);

  if (surface === '1KERB') {
    ctx.fillStyle = '#e8e8e8';
    for (let x = 0; x < size; x += 16) ctx.fillRect(x, 0, 8, size);
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
export function genTextures(built: BuiltTrack, pal: Palette): TexFile[] {
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
      bytes: dataUrlToBytes(drawTexture(m.name, meshColor(m.name, pal))),
    });
  }
  return out;
}
