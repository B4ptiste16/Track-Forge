import type { BuiltTrack, MeshData, Vec3 } from '../geometry';
import { splitForKn5, computeVertexNormals, baseSurfaceName } from './fbx';
import { materialSpec, meshTextureName } from './ksPersistence';
import type { TexFile } from './textures';

// ---------------------------------------------------------------------------
// Direct KN5 writer: the track model AC loads, produced without KsEditor.
//
// Every choice below was measured from KN5s that KsEditor itself wrote from
// this app's FBX - files that load and drive in game - rather than recalled:
//
//   header        "sc6969", version 6, one extra int32 (0)
//   textures      the image bytes embedded as-is (PNG works; KsEditor did not
//                 convert ours to DDS)
//   materials     shader, blend, alpha test, depth mode, properties as
//                 name + float + float2 + float3 + float4, then samplers
//   node tree     ONE root transform node, every mesh and every AC_* null a
//                 direct child - KsEditor flattens the FBX hierarchy
//   coordinates   native Z-up (x, y, z) -> AC Y-up (x, z, -y), the same proper
//                 rotation the FBX applies, so winding is preserved: the face
//                 order is written unchanged, and cross(b-a, c-a) agrees with
//                 the stored normal on every triangle (2490/2490 on erdre's road)
//   UV            V NEGATED (v' = -v). AC samples with wrap, so this is the same
//                 image as 1 - v; it is what KsEditor wrote, so it is what we write
//   tangent       normalize(cross(dP/dv, N)) - matched on road, wall and trees
//   matrices      row-major, translation in the last row (DirectX); rows are the
//                 node's local X, Y, Z axes in AC space
//   bounds        sphere centred on the MEAN of the vertices, radius to the
//                 farthest one - not the bounding-box centre; matched to the cm
//   mesh flags    shadows on, visible, opaque, renderable, layer 0, no LOD
//
// Meshes over the 16-bit index limit are split exactly as for the FBX
// (1GRASS_01, 1GRASS_02 ...). Unlike KsEditor, which gave each part its own
// copy of the material, parts SHARE their base material - identical shading
// across a split, and AC is fine with several meshes on one material.
// ---------------------------------------------------------------------------

const toAc = (v: Vec3): Vec3 => [v[0], v[2], -v[1]];

class Writer {
  private buf = new Uint8Array(1 << 20);
  private dv = new DataView(this.buf.buffer);
  private o = 0;
  private static enc = new TextEncoder();

  private need(n: number): void {
    if (this.o + n <= this.buf.length) return;
    let cap = this.buf.length;
    while (cap < this.o + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.o));
    this.buf = next;
    this.dv = new DataView(next.buffer);
  }
  i32(v: number): void { this.need(4); this.dv.setInt32(this.o, v, true); this.o += 4; }
  u32(v: number): void { this.need(4); this.dv.setUint32(this.o, v, true); this.o += 4; }
  f32(v: number): void { this.need(4); this.dv.setFloat32(this.o, v, true); this.o += 4; }
  u16(v: number): void { this.need(2); this.dv.setUint16(this.o, v, true); this.o += 2; }
  u8(v: number): void { this.need(1); this.buf[this.o++] = v; }
  bool(v: boolean): void { this.u8(v ? 1 : 0); }
  bytes(b: Uint8Array): void { this.need(b.length); this.buf.set(b, this.o); this.o += b.length; }
  str(s: string): void { const b = Writer.enc.encode(s); this.i32(b.length); this.bytes(b); }
  vec(v: ArrayLike<number>): void { for (let k = 0; k < v.length; k++) this.f32(v[k]); }
  done(): Uint8Array { return this.buf.slice(0, this.o); }
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

interface PreparedMesh {
  name: string;
  material: number;
  pos: Vec3[];
  nrm: Vec3[];
  uv: [number, number][];
  tan: Vec3[];
  idx: number[];
  center: Vec3;
  radius: number;
}

function prepare(part: MeshData, material: number): PreparedMesh {
  const pos = part.vertices.map(toAc);
  const nrm = computeVertexNormals(part).map(toAc);
  const src = part.uvs && part.uvs.length === part.vertices.length
    ? part.uvs
    : part.vertices.map((v) => [v[0] / 6, v[1] / 6] as [number, number]);
  const uv = src.map(([u, v]) => [u, -v] as [number, number]);

  // dP/dv per vertex, accumulated over its triangles, then T = cross(dP/dv, N).
  const dv: Vec3[] = pos.map(() => [0, 0, 0]);
  for (const f of part.faces) {
    const [a, b, c] = f;
    const e1 = [pos[b][0] - pos[a][0], pos[b][1] - pos[a][1], pos[b][2] - pos[a][2]];
    const e2 = [pos[c][0] - pos[a][0], pos[c][1] - pos[a][1], pos[c][2] - pos[a][2]];
    const du1 = uv[b][0] - uv[a][0], dv1 = uv[b][1] - uv[a][1];
    const du2 = uv[c][0] - uv[a][0], dv2 = uv[c][1] - uv[a][1];
    const det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) < 1e-12) continue;
    const r = 1 / det;
    const pv: Vec3 = [(e2[0] * du1 - e1[0] * du2) * r, (e2[1] * du1 - e1[1] * du2) * r, (e2[2] * du1 - e1[2] * du2) * r];
    for (const k of f) { dv[k][0] += pv[0]; dv[k][1] += pv[1]; dv[k][2] += pv[2]; }
  }
  const tan = pos.map((_, i): Vec3 => {
    const n = nrm[i], b = dv[i];
    let t: Vec3 = [b[1] * n[2] - b[2] * n[1], b[2] * n[0] - b[0] * n[2], b[0] * n[1] - b[1] * n[0]];
    let l = Math.hypot(t[0], t[1], t[2]);
    if (l < 1e-9) {           // no usable V gradient: any direction perpendicular to N
      const ref: Vec3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
      t = [ref[1] * n[2] - ref[2] * n[1], ref[2] * n[0] - ref[0] * n[2], ref[0] * n[1] - ref[1] * n[0]];
      l = Math.hypot(t[0], t[1], t[2]) || 1;
    }
    return [t[0] / l, t[1] / l, t[2] / l];
  });

  const center: Vec3 = [0, 0, 0];
  for (const p of pos) { center[0] += p[0]; center[1] += p[1]; center[2] += p[2]; }
  if (pos.length) { center[0] /= pos.length; center[1] /= pos.length; center[2] /= pos.length; }
  let radius = 0;
  for (const p of pos) radius = Math.max(radius, Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]));

  const idx: number[] = [];
  for (const f of part.faces) idx.push(f[0], f[1], f[2]);
  return { name: part.name, material, pos, nrm, uv, tan, idx, center, radius };
}

export interface Kn5Result {
  bytes: Uint8Array;
  /** Texture names the materials reference that no bytes were supplied for. */
  missingTextures: string[];
}

/**
 * Write the track's KN5.
 * @param textures the generated surface textures (as for the FBX export)
 * @param extraTextures bytes for anything else a material samples - prop-pack
 *   textures, and any texture-pack overrides - keyed by file name
 */
export function genKn5(
  built: BuiltTrack,
  textures: TexFile[],
  extraTextures: Record<string, Uint8Array>,
  rootName: string,
): Kn5Result {
  // One material per BASE mesh name, in order of first appearance.
  const matIndex = new Map<string, number>();
  const mats: { name: string; texture: string }[] = [];
  for (const m of built.meshes) {
    const base = baseSurfaceName(m.name);
    if (matIndex.has(base)) continue;
    matIndex.set(base, mats.length);
    mats.push({ name: `mat_${base}`, texture: meshTextureName(base, textures) });
  }

  // Embedded textures: exactly the ones a material samples.
  const lookup = (name: string): Uint8Array | undefined => {
    const lower = name.toLowerCase();
    for (const [k, v] of Object.entries(extraTextures)) if (k.toLowerCase() === lower) return v;
    return textures.find((t) => t.name.toLowerCase() === lower)?.bytes;
  };
  const texNames = [...new Set(mats.map((m) => m.texture))];
  const missingTextures = texNames.filter((n) => !lookup(n));

  const parts = built.meshes.flatMap((m) => splitForKn5(m).map((p) => prepare(p, matIndex.get(baseSurfaceName(m.name))!)));

  const w = new Writer();
  w.bytes(new TextEncoder().encode('sc6969'));
  w.i32(6);
  w.i32(0);

  const present = texNames.filter((n) => lookup(n));
  w.i32(present.length);
  for (const n of present) {
    const b = lookup(n)!;
    w.i32(1);
    w.str(n);
    w.i32(b.length);
    w.bytes(b);
  }

  w.i32(mats.length);
  for (const m of mats) {
    const spec = materialSpec(m.name);
    w.str(m.name);
    w.str(spec.shader);
    w.u8(0);                       // blend mode: opaque
    w.bool(spec.alphaTested);
    w.i32(0);                      // depth mode: normal
    w.u32(spec.vars.length);
    for (const [name, a, c] of spec.vars) {
      w.str(name);
      w.f32(a);
      w.vec([0, 0]);
      w.vec(c ?? [0, 0, 0]);
      w.vec([0, 0, 0, 0]);
    }
    w.u32(1);
    w.str('txDiffuse');
    w.i32(0);
    w.str(m.texture);
  }

  // Root: a transform node holding everything, as KsEditor writes it.
  w.i32(1);
  w.str(rootName);
  w.i32(parts.length + built.empties.length);
  w.bool(true);
  w.vec(IDENTITY);

  for (const p of parts) {
    w.i32(2);
    w.str(p.name);
    w.i32(0);
    w.bool(true);                  // active
    w.bool(true);                  // casts shadows
    w.bool(true);                  // visible
    w.bool(false);                 // transparent
    w.u32(p.pos.length);
    for (let i = 0; i < p.pos.length; i++) {
      w.vec(p.pos[i]); w.vec(p.nrm[i]); w.vec(p.uv[i]); w.vec(p.tan[i]);
    }
    w.u32(p.idx.length);
    for (const k of p.idx) w.u16(k);
    w.i32(p.material);
    w.i32(0);                      // layer
    w.f32(0); w.f32(0);            // LOD in / out: always drawn
    w.vec(p.center);
    w.f32(p.radius);
    w.bool(true);                  // renderable
  }

  for (const e of built.empties) {
    // basis columns are the local axes (native); rotate each into AC space
    const col = (c: number): Vec3 => toAc([e.basis[0][c], e.basis[1][c], e.basis[2][c]]);
    const [x, y, z] = [col(0), col(1), col(2)];
    const t = toAc(e.position);
    w.i32(1);
    w.str(e.name);
    w.i32(0);
    w.bool(true);
    w.vec([x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, t[0], t[1], t[2], 1]);
  }

  return { bytes: w.done(), missingTextures };
}
