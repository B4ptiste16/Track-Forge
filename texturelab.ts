import { drawTexture } from './src/export/textures';
import { THEME_PALETTES, meshColor } from './src/state/project';
import { LIGHTS_ASPECT } from './src/geometry/decor';
import type { WallStyle } from './src/types';

const pal = THEME_PALETTES.tarmac_day;
const grid = document.getElementById('grid')!;

// `aspect` = width / height of the surface the texture is actually mapped to,
// so textures drawn for a non-square face are previewed at their real shape.
const show = (label: string, url: string, aspect = 1) => {
  const fig = document.createElement('figure');
  const img = document.createElement('img');
  img.src = url;
  if (aspect !== 1) img.style.height = `${Math.round(232 / aspect)}px`;
  const cap = document.createElement('figcaption');
  cap.textContent = aspect === 1 ? label : `${label}  (shown at ${aspect.toFixed(1)}:1)`;
  fig.append(img, cap);
  grid.append(fig);
};
const tex = (name: string, style: WallStyle = 'solid') => drawTexture(name, meshColor(name, pal), 'tarmac_day', style);

show('DECOR_FRAME', tex('DECOR_FRAME'));
show('DECOR_STEEL', tex('DECOR_STEEL'));
show('DECOR_RAIL', tex('DECOR_RAIL'), 2 / 1.1);
show('DECOR_LIGHTS', tex('DECOR_LIGHTS'), LIGHTS_ASPECT);
for (const name of ['DECOR_ARCH', 'DECOR_FLAG', 'DECOR_MAST', 'DECOR_LAMP', 'DECOR_POLE',
  '1TARMAC', '1CONCRETE', '1DIRT', '1WALLPOLY', 'ROAD_LINE',
  'DECOR_TREE', 'DECOR_BUILDING', 'DECOR_BLDGLASS', 'DECOR_BLDBRICK', 'DECOR_BLDHANGAR', 'DECOR_ROOF',
  'DECOR_GANTRY', 'DECOR_BOLLARD', 'DECOR_PITBLDG', 'DECOR_GARAGE', 'DECOR_STAND', 'DECOR_MARKER',
  '1ROAD', '1KERB', '1GRASS', '1SAND']) {
  show(name, tex(name));
}
for (const style of ['solid', 'armco', 'tecpro', 'blocks', 'hay'] as WallStyle[]) {
  show(`1WALL / ${style}`, tex('1WALL', style));
}
