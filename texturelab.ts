import { drawTexture } from './src/export/textures';
import { THEME_PALETTES, meshColor } from './src/state/project';
import type { WallStyle } from './src/types';

const pal = THEME_PALETTES.tarmac_day;
const grid = document.getElementById('grid')!;

const show = (label: string, url: string) => {
  const fig = document.createElement('figure');
  const img = document.createElement('img');
  img.src = url;
  const cap = document.createElement('figcaption');
  cap.textContent = label;
  fig.append(img, cap);
  grid.append(fig);
};

for (const name of ['DECOR_TREE', 'DECOR_BUILDING', 'DECOR_BLDGLASS', 'DECOR_BLDBRICK', 'DECOR_BLDHANGAR', 'DECOR_ROOF', 'DECOR_GANTRY', 'DECOR_BOLLARD', 'DECOR_PITBLDG', 'DECOR_GARAGE', 'DECOR_STAND', 'DECOR_MARKER', '1ROAD', '1KERB', '1GRASS', '1SAND']) {
  show(name, drawTexture(name, meshColor(name, pal), 'tarmac_day', 'solid'));
}

// every wall style, then the other surfaces the request named
for (const style of ['solid', 'armco', 'tecpro', 'blocks', 'hay'] as WallStyle[]) {
  show(`1WALL / ${style}`, drawTexture('1WALL', meshColor('1WALL', pal), 'tarmac_day', style));
}
