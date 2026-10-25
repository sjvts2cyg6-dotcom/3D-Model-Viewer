/**
 * `webgpu` target: bakes for src/ (the browser WebGPU engine).
 *
 * Geometry: engine-native vertex layout `f32-split-v1` (four non-interleaved
 * float32 streams that match VERTEX_LAYOUTS in src/renderer/pipelines.ts
 * byte-for-byte), uint16 indices when vertexCount <= 65536, meshopt cache/fetch
 * optimisation and a shared-vertex LOD chain.
 *
 * Textures: KTX2/Basis (UASTC+Zstd for normal & data maps, ETC1S for colour by
 * default) with a full mip chain, transcoded at load to BC7 / ASTC / ETC2 /
 * RGBA8 depending on device features. `--texture-format rgba8` writes a raw
 * pre-mipped RGBA8 chain instead (no transcoder needed, 4-8x larger).
 */
import type { Document, Material, Mesh, Primitive, Texture, TextureInfo } from '@gltf-transform/core';
import { getBounds } from '@gltf-transform/functions';
import { createHash } from 'node:crypto';
import {
  SectionBuilder, WGM_VERTEX_LAYOUT, writeWgm,
  type WgmBounds, type WgmMaterial, type WgmMesh, type WgmNode, type WgmPrimitive, type WgmSampler, type WgmTexture,
  type WgmTextureRef,
} from '../../../src/assets/wgm/format';
import { optimizeGeometry } from '../geometry';
import { prepareDocument } from '../prepare';
import { buildMipChain, decodeImage, hasAlpha, resize, targetSize, type MipMode } from '../textures/image';
import { encodeKtx2, type Ktx2Codec, type TextureUsage } from '../textures/ktx2';
import type { BakeContext, BakeOutput, TargetProfile } from './types';

export const GENERATOR = 'webgpu-engine bake 0.1';

export const webgpuTarget: TargetProfile = {
  id: 'webgpu',
  description: 'Browser WebGPU engine (src/): .wgm, f32 split streams, KTX2/Basis or RGBA8 mips',
  fileExtension: '.wgm',
  textureFormats: ['auto', 'uastc', 'etc1s', 'rgba8'],
  defaults: {
    lods: 4, lodRatio: 0.5, lodMaxError: 0.05, textureFormat: 'auto', maxTextureSize: 4096,
    etc1sQuality: 192, uastcLevel: 2, uastcRdo: true, recomputeTangents: false,
  },
  bake: bakeWebgpu,
};

async function bakeWebgpu(doc: Document, ctx: BakeContext): Promise<BakeOutput> {
  const opts = ctx.options;
  await prepareDocument(doc, ctx);
  const root = doc.getRoot();

  const vertex = new SectionBuilder();
  const index = new SectionBuilder();
  const texture = new SectionBuilder();
  const stats = { vertices: 0, triangles: 0, lodTriangles: [] as number[], uint16Primitives: 0, uint32Primitives: 0, sharedPrimitives: 0, textureBytes: 0, encodeMs: 0 };

  // ---------------------------------------------------------------- textures
  const samplers: WgmSampler[] = [];
  const samplerIndex = new Map<string, number>();
  const textureJobs: { tex: Texture; usage: TextureUsage }[] = [];
  const textureIndex = new Map<string, number>();

  const samplerFor = (info: TextureInfo | null): number => {
    const filter = (f: number | null, fallback: 'linear' | 'nearest') =>
      f === null ? fallback : (f === 9728 || f === 9984 || f === 9986) ? 'nearest' : 'linear';
    const mip = (f: number | null): 'linear' | 'nearest' => (f === 9984 || f === 9985) ? 'nearest' : 'linear';
    const wrap = (w: number): WgmSampler['addressModeU'] => (w === 33071 ? 'clamp-to-edge' : w === 33648 ? 'mirror-repeat' : 'repeat');
    const min = info?.getMinFilter() ?? null;
    const s: WgmSampler = {
      magFilter: filter(info?.getMagFilter() ?? null, 'linear'),
      minFilter: filter(min, 'linear'),
      mipmapFilter: mip(min),
      addressModeU: wrap(info?.getWrapS() ?? 10497),
      addressModeV: wrap(info?.getWrapT() ?? 10497),
    };
    const key = JSON.stringify(s);
    let i = samplerIndex.get(key);
    if (i === undefined) { i = samplers.length; samplers.push(s); samplerIndex.set(key, i); }
    return i;
  };

  const textureFor = (tex: Texture | null, info: TextureInfo | null, usage: TextureUsage): WgmTextureRef | undefined => {
    if (!tex) return undefined;
    const key = `${root.listTextures().indexOf(tex)}:${usage}`;
    let i = textureIndex.get(key);
    if (i === undefined) {
      i = textureJobs.length;
      textureIndex.set(key, i);
      textureJobs.push({ tex, usage });
    }
    return { texture: i, sampler: samplerFor(info) };
  };

  const encodeTexture = async (tex: Texture, usage: TextureUsage, ordinal: number): Promise<{ meta: Omit<WgmTexture, 'data'>; bytes: Uint8Array }> => {
    const t0 = performance.now();
    const image = tex.getImage();
    if (!image) throw new Error(`texture "${tex.getName()}" has no image data`);
    const src = decodeImage(image, tex.getMimeType());
    const mode: MipMode = usage === 'color' ? 'srgb' : usage === 'normal' ? 'normal' : 'linear';
    const raw = opts.textureFormat === 'rgba8';
    const [w, h] = targetSize(src.width, src.height, opts.maxTextureSize, raw ? 1 : 4);
    if (w !== src.width || h !== src.height) ctx.log(`texture "${tex.getName() || tex.getURI()}": resized ${src.width}x${src.height} -> ${w}x${h}`);
    const base = resize(src, w, h, mode);
    const alpha = usage === 'color' && hasAlpha(base);
    const name = tex.getName() || tex.getURI() || `texture_${ordinal}`;
    const common = { name, usage, colorSpace: usage === 'color' ? 'srgb' : 'linear', width: w, height: h, hasAlpha: alpha } as const;

    let bytes: Uint8Array;
    let result: Omit<WgmTexture, 'data'>;
    if (raw) {
      const chain = buildMipChain(base, mode);
      const total = chain.reduce((n, l) => n + l.data.byteLength, 0);
      bytes = new Uint8Array(total);
      const levels: NonNullable<WgmTexture['levels']> = [];
      let o = 0;
      for (const l of chain) {
        bytes.set(l.data, o);
        levels.push({ byteOffset: o, byteLength: l.data.byteLength, width: l.width, height: l.height });
        o += l.data.byteLength;
      }
      result = { ...common, encoding: 'rgba8', mipLevelCount: chain.length, levels };
    } else {
      const codec: Ktx2Codec = opts.textureFormat === 'uastc' || opts.textureFormat === 'etc1s'
        ? opts.textureFormat
        : usage === 'color' ? 'etc1s' : 'uastc';
      bytes = await encodeKtx2(base, { codec, usage, etc1sQuality: opts.etc1sQuality, uastcLevel: opts.uastcLevel, uastcRdo: opts.uastcRdo });
      result = { ...common, encoding: 'ktx2', codec, mipLevelCount: Math.floor(Math.log2(Math.max(w, h))) + 1 };
    }
    const ms = performance.now() - t0;
    stats.encodeMs += ms;
    ctx.log(`texture "${name}" (${usage}) ${w}x${h} -> ${result.encoding}${result.codec ? `/${result.codec}` : ''} ${(bytes.byteLength / 1024).toFixed(0)} KiB in ${ms.toFixed(0)} ms`);
    return { meta: result, bytes };
  };

  // --------------------------------------------------------------- materials
  const materials: WgmMaterial[] = root.listMaterials().map((m: Material) => {
    const strength = (m.getExtension('KHR_materials_emissive_strength') as { getEmissiveStrength(): number } | null)?.getEmissiveStrength() ?? 1;
    const e = m.getEmissiveFactor();
    const out: WgmMaterial = {
      name: m.getName(),
      baseColorFactor: m.getBaseColorFactor() as [number, number, number, number],
      metallicFactor: m.getMetallicFactor(),
      roughnessFactor: m.getRoughnessFactor(),
      emissiveFactor: [e[0] * strength, e[1] * strength, e[2] * strength],
      normalScale: m.getNormalScale(),
      occlusionStrength: m.getOcclusionStrength(),
      alphaMode: m.getAlphaMode(),
      alphaCutoff: m.getAlphaCutoff(),
      doubleSided: m.getDoubleSided(),
    };
    const refs = {
      baseColorTexture: textureFor(m.getBaseColorTexture(), m.getBaseColorTextureInfo(), 'color'),
      metallicRoughnessTexture: textureFor(m.getMetallicRoughnessTexture(), m.getMetallicRoughnessTextureInfo(), 'data'),
      normalTexture: textureFor(m.getNormalTexture(), m.getNormalTextureInfo(), 'normal'),
      occlusionTexture: textureFor(m.getOcclusionTexture(), m.getOcclusionTextureInfo(), 'data'),
      emissiveTexture: textureFor(m.getEmissiveTexture(), m.getEmissiveTextureInfo(), 'color'),
    };
    for (const [k, v] of Object.entries(refs)) if (v) (out as unknown as Record<string, unknown>)[k] = v;
    return out;
  });

  // The Basis WASM encoder is single-threaded; encode one texture at a time, in manifest order.
  const textures: WgmTexture[] = [];
  for (let i = 0; i < textureJobs.length; i++) {
    const { meta, bytes } = await encodeTexture(textureJobs[i].tex, textureJobs[i].usage, i);
    const data = texture.push(bytes, 16);
    stats.textureBytes += data.byteLength;
    textures.push({ ...meta, data });
  }

  // ------------------------------------------------------------------ meshes
  const materialList = root.listMaterials();
  const meshes: WgmMesh[] = [];
  // Primitives with identical geometry (common: one sphere/rock mesh reused with
  // different materials) share vertex streams and index ranges in the file.
  const geometryCache = new Map<string, Omit<WgmPrimitive, 'material'>>();
  const baseRatio = triangleBudgetRatio(doc, opts.maxTriangles, ctx);
  for (const mesh of root.listMeshes()) {
    const primitives: WgmPrimitive[] = [];
    for (const prim of mesh.listPrimitives()) {
      const p = await bakePrimitive(prim, materialList, vertex, index, geometryCache, ctx, baseRatio);
      if (!p) continue;
      primitives.push(p.prim);
      if (p.shared) { stats.sharedPrimitives++; continue; }
      stats.vertices += p.prim.vertexCount;
      stats.triangles += p.prim.lods[0].indexCount / 3;
      p.prim.lods.forEach((l, i) => { stats.lodTriangles[i] = (stats.lodTriangles[i] ?? 0) + l.indexCount / 3; });
      if (p.prim.indices.format === 'uint16') stats.uint16Primitives++; else stats.uint32Primitives++;
    }
    meshes.push({ name: mesh.getName(), primitives });
  }

  // ------------------------------------------------------------------- nodes
  const nodeList = root.listNodes();
  const meshList = root.listMeshes();
  const nodes: WgmNode[] = nodeList.map((n) => {
    const out: WgmNode = { name: n.getName() };
    const t = n.getTranslation(), r = n.getRotation(), s = n.getScale();
    if (t.some((v) => v !== 0)) out.translation = [...t] as WgmNode['translation'];
    if (r[0] !== 0 || r[1] !== 0 || r[2] !== 0 || r[3] !== 1) out.rotation = [...r] as WgmNode['rotation'];
    if (s.some((v) => v !== 1)) out.scale = [...s] as WgmNode['scale'];
    const m = n.getMesh();
    if (m) out.mesh = meshList.indexOf(m);
    const children = n.listChildren().map((c) => nodeList.indexOf(c));
    if (children.length) out.children = children;
    return out;
  });
  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  const roots = scene ? scene.listChildren().map((c) => nodeList.indexOf(c)) : [];
  const b = scene ? getBounds(scene) : { min: [0, 0, 0], max: [0, 0, 0] };
  const bounds: WgmBounds = { min: [...b.min] as WgmBounds['min'], max: [...b.max] as WgmBounds['max'] };

  const finalStats = { ...stats, encodeMs: Math.round(stats.encodeMs) };
  const bytes = writeWgm({
    manifest: {
      target: 'webgpu',
      generator: GENERATOR,
      vertexLayout: WGM_VERTEX_LAYOUT,
      nodes, roots, meshes, materials, textures, samplers, bounds,
      stats: { ...finalStats, textureFormat: opts.textureFormat, lods: opts.lods, maxTriangles: opts.maxTriangles, ...(ctx.device ? { device: ctx.device } : {}) },
    },
    sections: { vertex: vertex.finish(), index: index.finish(), texture: texture.finish() },
  });
  return { bytes, stats: finalStats };
}

async function bakePrimitive(
  prim: Primitive, materials: Material[], vertex: SectionBuilder, index: SectionBuilder,
  cache: Map<string, Omit<WgmPrimitive, 'material'>>, ctx: BakeContext, baseRatio: number,
): Promise<{ prim: WgmPrimitive; shared: boolean } | null> {
  const pos = prim.getAttribute('POSITION');
  const nrm = prim.getAttribute('NORMAL');
  if (!pos || !nrm) { ctx.warn('primitive without POSITION/NORMAL skipped'); return null; }
  const f32 = (a: ReturnType<Primitive['getAttribute']>) => {
    const arr = a?.getArray();
    return arr ? (arr instanceof Float32Array ? arr : Float32Array.from(arr)) : undefined;
  };
  const mat = prim.getMaterial();
  const uv = f32(prim.getAttribute('TEXCOORD_0'));
  const tan = mat?.getNormalTexture() ? f32(prim.getAttribute('TANGENT')) : undefined;
  const vcount = pos.getCount();
  const idxAcc = prim.getIndices();
  const indices = idxAcc ? Uint32Array.from(idxAcc.getArray()!) : Uint32Array.from({ length: vcount }, (_, i) => i);

  const keepUv = !!(uv && mat && hasAnyTexture(mat));
  const hash = createHash('sha1');
  for (const a of [f32(pos)!, f32(nrm)!, keepUv ? uv : undefined, tan, indices]) {
    hash.update(a ? new Uint8Array(a.buffer, a.byteOffset, a.byteLength) : new Uint8Array(0));
    hash.update('|');
  }
  const key = hash.digest('hex');
  const material = mat ? materials.indexOf(mat) : null;
  const cached = cache.get(key);
  if (cached) return { prim: { ...cached, material }, shared: true };

  const g = await optimizeGeometry(
    { positions: f32(pos)!, normals: f32(nrm)!, uvs: uv, tangents: tan, indices },
    { levels: ctx.options.lods, ratio: ctx.options.lodRatio, maxError: ctx.options.lodMaxError, baseRatio },
  );

  const streams: WgmPrimitive['streams'] = {
    position: vertex.push(g.positions),
    normal: vertex.push(g.normals),
  };
  if (g.uvs && keepUv) streams.uv = vertex.push(g.uvs);
  if (g.tangents) streams.tangent = vertex.push(g.tangents);

  const use16 = g.vertexCount <= 0x10000;
  const idxData = use16 ? Uint16Array.from(g.lodIndices) : g.lodIndices;
  const range = index.push(idxData, 4);

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < g.positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = g.positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  const geometry: Omit<WgmPrimitive, 'material'> = {
    vertexCount: g.vertexCount,
    streams,
    indices: { ...range, format: use16 ? 'uint16' : 'uint32', count: g.lodIndices.length },
    lods: g.lods,
    bounds: { min, max },
  };
  cache.set(key, geometry);
  return { prim: { ...geometry, material }, shared: false };
}

/** Triangles drawn at full detail (mesh instances counted) vs the budget -> uniform LOD0 ratio. */
function triangleBudgetRatio(doc: Document, budget: number, ctx: BakeContext): number {
  if (!budget || budget <= 0) return 1;
  const instances = new Map<Mesh, number>();
  for (const n of doc.getRoot().listNodes()) {
    const m = n.getMesh();
    if (m) instances.set(m, (instances.get(m) ?? 0) + 1);
  }
  let drawn = 0;
  for (const [mesh, count] of instances) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      drawn += ((idx ? idx.getCount() : prim.getAttribute('POSITION')?.getCount() ?? 0) / 3) * count;
    }
  }
  if (drawn <= budget) {
    ctx.log(`triangle budget ${budget}: scene draws ${Math.round(drawn)} triangles, no reduction`);
    return 1;
  }
  const ratio = budget / drawn;
  ctx.log(`triangle budget ${budget}: scene draws ${Math.round(drawn)} triangles, simplifying LOD0 to ${(ratio * 100).toFixed(1)}%`);
  return ratio;
}

function hasAnyTexture(m: Material): boolean {
  return !!(m.getBaseColorTexture() || m.getMetallicRoughnessTexture() || m.getNormalTexture() ||
    m.getOcclusionTexture() || m.getEmissiveTexture());
}
