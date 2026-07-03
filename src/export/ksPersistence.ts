import type { BuiltTrack } from '../geometry';
import type { TexFile } from './textures';

// ---------------------------------------------------------------------------
// KsEditor persistence file (`<name>.fbx.ini`) — the Race Track Builder trick.
// When KsEditor imports `foo.fbx` it automatically loads `foo.fbx.ini` from the
// same folder and applies the saved material setup. By shipping one with every
// export, all materials arrive with shader ksPerPixel + txDiffuse already
// assigned: the user only has to Import FBX → Export KN5.
// Format reverse-engineered from a real ksEditor-saved file (VERSION=4).
// ---------------------------------------------------------------------------

// Minimal MD5 (the header carries an MD5 of the FBX file).
function md5Hex(bytes: Uint8Array): string {
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

  const n = bytes.length;
  const padded = new Uint8Array((((n + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[n] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, (n * 8) >>> 0, true);
  dv.setUint32(padded.length - 4, Math.floor((n * 8) / 4294967296), true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + ((F << S[i]) | (F >>> (32 - S[i])))) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, a0, true); odv.setUint32(4, b0, true);
  odv.setUint32(8, c0, true); odv.setUint32(12, d0, true);
  return [...out].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// "6/22/2026 5:57:02 PM" — the en-US format ksEditor writes.
function usDate(d: Date): string {
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  const p = (x: number) => String(x).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ${h}:${p(d.getMinutes())}:${p(d.getSeconds())} ${ampm}`;
}

function materialBlock(idx: number, name: string, texture: string): string {
  // ksAmbient/ksDiffuse tuned for tracks; the rest mirrors ksEditor defaults.
  const vars: [string, number][] = [
    ['ksAmbient', 0.4], ['ksDiffuse', 0.6], ['ksSpecular', 0.2],
    ['ksSpecularEXP', 12], ['ksEmissive', 0], ['ksAlphaRef', 0],
  ];
  const lines = [
    `[MATERIAL_${idx}]`,
    `NAME=${name}`,
    'SHADER=ksPerPixel',
    'ALPHABLEND=0',
    'ALPHATEST=0',
    'DEPTHMODE=0',
    `VARCOUNT=${vars.length}`,
  ];
  vars.forEach(([vn, v1], i) => {
    lines.push(`VAR_${i}_NAME=${vn}`, `VAR_${i}_FLOAT1=${v1}`, `VAR_${i}_FLOAT2=0,0`, `VAR_${i}_FLOAT3=0,0,0`, `VAR_${i}_FLOAT4=0,0,0,0`);
  });
  lines.push('RESCOUNT=1', 'RES_0_NAME=txDiffuse', 'RES_0_SLOT=0', `RES_0_TEXTURE=${texture}`);
  return lines.join('\r\n');
}

export function genKsPersistence(
  slug: string,
  fbxText: string,
  built: BuiltTrack,
  textures: TexFile[],
): string {
  const fbxName = `${slug}.fbx`;
  const hash = md5Hex(new TextEncoder().encode(fbxText));

  const header = [
    '[HEADER]',
    'VERSION=4',
    'DLC_KEY=0',
    'USERNAME=',
    `DATE=${usDate(new Date())}`,
    `MD5_HASH=${hash}`,
  ].join('\r\n');

  const mats = built.meshes.map((m) => ({
    name: `mat_${m.name}`,
    texture: textures.find((t) => t.surface === m.name)?.name ?? 'road.png',
  }));
  const matList = [`[MATERIAL_LIST]`, `COUNT=${mats.length}`].join('\r\n');
  const matBlocks = mats.map((m, i) => materialBlock(i, m.name, m.texture));

  // Node sections: root, then every node alphabetically (matches ksEditor).
  const nodes: { name: string; isMesh: boolean }[] = [
    ...built.meshes.map((m) => ({ name: m.name, isMesh: true })),
    ...built.empties.map((e) => ({ name: e.name, isMesh: false })),
  ].sort((a, b) => (a.name < b.name ? -1 : 1));

  const nodeBlocks: string[] = [[`[model_FBX: ${fbxName}]`, 'ACTIVE=1', 'PRIORITY=0'].join('\r\n')];
  for (const nd of nodes) {
    nodeBlocks.push([`[model_FBX: ${fbxName}_${nd.name}]`, 'ACTIVE=1', 'PRIORITY=0'].join('\r\n'));
    if (nd.isMesh) {
      nodeBlocks.push([
        `[model_FBX: ${fbxName}_${nd.name}_${nd.name}]`,
        'ACTIVE=1', 'PRIORITY=0', 'VISIBLE=1', 'TRANSPARENT=0',
        'CAST_SHADOWS=1', 'LOD_IN=0', 'LOD_OUT=0', 'RENDERABLE=1',
      ].join('\r\n'));
    }
  }

  return [header, matList, ...matBlocks, ...nodeBlocks].join('\r\n\r\n') + '\r\n';
}
