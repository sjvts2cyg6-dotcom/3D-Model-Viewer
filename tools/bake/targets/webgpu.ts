/**
 * `webgpu` target: bakes for src/ (the browser WebGPU engine).
 *
 * Everything in the output is in a form the GPU consumes directly; the engine
 * does no decompression, transcoding or per-vertex CPU work at load.
 *
 * Geometry: vertex layout `split-v2`: four non-interleaved streams in
 * GPU-native vertex formats picked per primitive (src/assets/wgm/format.ts):
 * unorm16x4 positions on a per-mesh grid (dequantized in the vertex shader
 * from a per-draw scale/offset), snorm8x4 / snorm16x4 / octahedral normals and
 * tangents, unorm16x2 / float16x2 UVs. Precision is chosen so that the
 * measured error stays below the device profile's visible tolerance
 * (`--vertex-precision full|auto|low`). uint16 indices when vertexCount <= 65536,
 * meshopt cache/fetch optimisation and a shared-vertex LOD chain.
 *
 * Textures: native GPU block formats with precomputed mips: BC7, ASTC (4x4..8x8)
 * or ETC2, or raw RGBA8. `--texture-format universal` instead writes KTX2/Basis,
 * the one mode the engine transcodes at load.
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
import {
  chooseNormals, chooseTangents, chooseUvs, positionPixelError, quantizePositions,
} from '../quantize';
import { decodeImage, hasAlpha, resize, targetSize, type MipMode } from '../textures/image';
import { encodeKtx2, type Ktx2Codec, type TextureUsage } from '../textures/ktx2';
import { blockMultiple, encodeNative, type NativeFormat } from '../textures/native';
import type { BakeContext, BakeOptions, BakeOutput, TargetProfile, TextureFormatOption } from './types';

export const GENERATOR = 'webgpu-engine bake 0.2';

type ResolvedTextureMode = { kind: 'native'; format: NativeFormat } | { kind: 'universal'; codec: Ktx2Codec | 'auto' };

/** Map the --texture-format option to what this bake writes. `each` is expanded by the caller (one bake per format). */
export function resolveTextureMode(f: TextureFormatOption, ctx: Pick<BakeContext, 'warn'>): ResolvedTextureMode {
  switch (f) {
    case 'bc7': case 'astc': case 'etc2': case 'rgba8': return { kind: 'native', format: f };
    case 'universal': return { kind: 'universal', codec: 'auto' };
    case 'uastc': case 'etc1s': return { kind: 'universal', codec: f };
    case 'auto':
      ctx.warn('texture format "auto" without a device profile: writing BC7 (desktop GPUs). Use --device <profile> or --texture-format astc|etc2|each for other targets.');
      return { kind: 'native', format: 'bc7' };
    case 'each': throw new Error('--texture-format each must be expanded into one bake per format by the caller');
  }
}

export const webgpuTarget: TargetProfile = {
  id: 'webgpu',
  description: 'Browser WebGPU engine (src/): .wgm, quantized GPU-native vertex streams, BC7/ASTC/ETC2/RGBA8 mips (KTX2 only with --texture-format universal)',
  fileExtension: '.wgm',
  textureFormats: ['auto', 'bc7', 'astc', 'etc2', 'rgba8', 'each', 'universal', 'uastc', 'etc1s'],
  defaults: { lods: 4 },
  bake: bakeWebgpu,
};

async function bakeWebgpu(doc: Document, ctx: BakeContext): Promise<BakeOutput> {
  const opts = ctx.options;
  await prepareDocument(doc, ctx);
  const root = doc.getRoot();

  const vertex = new SectionBuilder();
  const index = new SectionBuilder();
  const texture = new SectionBuilder();
  const stats = {
    vertices: 0, triangles: 0, lodTriangles: [] as number[], uint16Primitives: 0, uint32Primitives: 0, sharedPrimitives: 0,
    /** Vertex stream bytes as float32 (what v1 / the glTF wrote) vs as written. */
    vertexBytesF32: 0, vertexBytes: 0, indexBytes: 0,
    vertexFormats: {} as Record<string, number>,
    maxPositionPixelError: 0, maxNormalErrorDeg: 0, maxUvErrorTexels: 0,
    textureBytes: 0, textureFormats: {} as Record<string, number>, encodeMs: 0, quantizeMs: 0,
  };
  const texMode = resolveTextureMode(opts.textureFormat, ctx);

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
    const multiple = texMode.kind === 'native' ? blockMultiple(texMode.format, opts.astcBlock) : ([4, 4] as [number, number]);
    const [w, h] = targetSize(src.width, src.height, opts.maxTextureSize, multiple);
    if (w !== src.width || h !== src.height) ctx.log(`texture "${tex.getName() || tex.getURI()}": resized ${src.width}x${src.height} -> ${w}x${h}`);
    const base = resize(src, w, h, mode);
    const alpha = usage === 'color' && hasAlpha(base);
    const name = tex.getName() || tex.getURI() || `texture_${ordinal}`;
    const common = { name, usage, colorSpace: usage === 'color' ? 'srgb' : 'linear', width: w, height: h, hasAlpha: alpha } as const;

    let bytes: Uint8Array;
    let result: Omit<WgmTexture, 'data'>;
    if (texMode.kind === 'native') {
      const nt = await encodeNative(base, texMode.format, mode, {
        usage, srgb: usage === 'color', hasAlpha: alpha, astcBlock: opts.astcBlock, uastcLevel: opts.uastcLevel, astcQuality: opts.astcQuality,
      });
      bytes = new Uint8Array(nt.levels.reduce((n, l) => n + l.data.byteLength, 0));
      const levels: NonNullable<WgmTexture['levels']> = [];
      let o = 0;
      for (const l of nt.levels) {
        bytes.set(l.data, o);
        levels.push({ byteOffset: o, byteLength: l.data.byteLength, width: l.width, height: l.height });
        o += l.data.byteLength;
      }
      result = { ...common, encoding: texMode.format, format: nt.format, mipLevelCount: levels.length, levels };
    } else {
      const codec: Ktx2Codec = texMode.codec !== 'auto' ? texMode.codec : usage === 'color' ? 'etc1s' : 'uastc';
      bytes = await encodeKtx2(base, { codec, usage, etc1sQuality: opts.etc1sQuality, uastcLevel: opts.uastcLevel, uastcRdo: opts.uastcRdo, zstd: opts.zstd });
      result = { ...common, encoding: 'ktx2', codec, mipLevelCount: Math.floor(Math.log2(Math.max(w, h))) + 1 };
    }
    const ms = performance.now() - t0;
    stats.encodeMs += ms;
    const label = result.format ?? `${result.encoding}${result.codec ? `/${result.codec}${opts.zstd && result.codec === 'uastc' ? '+zstd' : ''}` : ''}`;
    stats.textureFormats[label] = (stats.textureFormats[label] ?? 0) + 1;
    ctx.log(`texture "${name}" (${usage}) ${w}x${h} -> ${label} ${(bytes.byteLength / 1024).toFixed(0)} KiB in ${ms.toFixed(0)} ms`);
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

  // The Basis / astcenc WASM encoders are single-threaded; encode one texture at a time, in manifest order.
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
  // Largest texture side each material samples (UV precision is measured in its texels).
  const materialTexSize = materials.map((m) => Math.max(0, ...TEXTURE_SLOTS.map((k) => {
    const ref = m[k];
    return ref ? Math.max(textures[ref.texture].width, textures[ref.texture].height) : 0;
  })));
  for (const mesh of root.listMeshes()) {
    const primitives: WgmPrimitive[] = [];
    const grid = meshGrid(mesh);
    for (const prim of mesh.listPrimitives()) {
      const p = await bakePrimitive(prim, materialList, materialTexSize, grid, vertex, index, geometryCache, ctx, baseRatio, stats);
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

  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const finalStats = {
    ...stats, encodeMs: Math.round(stats.encodeMs), quantizeMs: Math.round(stats.quantizeMs),
    maxPositionPixelError: r3(stats.maxPositionPixelError), maxNormalErrorDeg: r3(stats.maxNormalErrorDeg), maxUvErrorTexels: r3(stats.maxUvErrorTexels),
  };
  ctx.log(`vertex streams ${stats.vertexBytesF32} B as float32 -> ${stats.vertexBytes} B (${stats.vertexBytesF32 ? ((100 * stats.vertexBytes) / stats.vertexBytesF32).toFixed(0) : 100}%), formats ${JSON.stringify(stats.vertexFormats)}`);
  const bytes = writeWgm({
    manifest: {
      target: 'webgpu',
      generator: GENERATOR,
      vertexLayout: WGM_VERTEX_LAYOUT,
      nodes, roots, meshes, materials, textures, samplers, bounds,
      stats: {
        ...finalStats, textureFormat: texMode.kind === 'native' ? texMode.format : 'universal',
        vertexPrecision: opts.vertexPrecision, vertexTolerance: opts.vertexTolerance,
        lods: opts.lods, maxTriangles: opts.maxTriangles, ...(ctx.device ? { device: ctx.device } : {}),
      },
    },
    sections: { vertex: vertex.finish(), index: index.finish(), texture: texture.finish() },
  });
  return { bytes, stats: finalStats };
}

type BakeStats = {
  vertexBytesF32: number; vertexBytes: number; indexBytes: number; vertexFormats: Record<string, number>;
  maxPositionPixelError: number; maxNormalErrorDeg: number; maxUvErrorTexels: number; quantizeMs: number;
};

const TEXTURE_SLOTS = ['baseColorTexture', 'metallicRoughnessTexture', 'normalTexture', 'occlusionTexture', 'emissiveTexture'] as const;

/** Per-mesh position grid: one quantization lattice for all primitives of a mesh (no cracks between them). */
function meshGrid(mesh: Mesh): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const prim of mesh.listPrimitives()) {
    const a = prim.getAttribute('POSITION');
    if (!a) continue;
    const arr = a.getArray()!;
    for (let i = 0; i < arr.length; i += 3) for (let k = 0; k < 3; k++) {
      const v = arr[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return Number.isFinite(min[0]) ? { min, max } : { min: [0, 0, 0], max: [0, 0, 0] };
}

async function bakePrimitive(
  prim: Primitive, materials: Material[], materialTexSize: number[], grid: { min: number[]; max: number[] },
  vertex: SectionBuilder, index: SectionBuilder,
  cache: Map<string, Omit<WgmPrimitive, 'material'>>, ctx: BakeContext, baseRatio: number, stats: BakeStats,
): Promise<{ prim: WgmPrimitive; shared: boolean } | null> {
  const opts: BakeOptions = ctx.options;
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
  const material = mat ? materials.indexOf(mat) : null;
  const texSize = material !== null ? materialTexSize[material] ?? 0 : 0;

  const keepUv = !!(uv && mat && hasAnyTexture(mat));
  const hash = createHash('sha1');
  for (const a of [f32(pos)!, f32(nrm)!, keepUv ? uv : undefined, tan, indices]) {
    hash.update(a ? new Uint8Array(a.buffer, a.byteOffset, a.byteLength) : new Uint8Array(0));
    hash.update('|');
  }
  // Quantization inputs are part of the identity: same geometry on a different grid is different data.
  hash.update(JSON.stringify([grid, texSize, opts.vertexPrecision, opts.normalEncoding, opts.vertexTolerance]));
  const key = hash.digest('hex');
  const cached = cache.get(key);
  if (cached) return { prim: { ...cached, material }, shared: true };

  const g = await optimizeGeometry(
    { positions: f32(pos)!, normals: f32(nrm)!, uvs: uv, tangents: tan, indices },
    { levels: opts.lods, ratio: opts.lodRatio, maxError: opts.lodMaxError, baseRatio },
  );

  // ---- GPU-native vertex formats, measured against the device tolerance.
  const t0 = performance.now();
  const tol = opts.vertexTolerance;
  const prec = opts.vertexPrecision;
  const count = (f: string) => { stats.vertexFormats[f] = (stats.vertexFormats[f] ?? 0) + 1; };
  const streams = {} as WgmPrimitive['streams'];
  let positionTransform: WgmPrimitive['positionTransform'];
  const diag = Math.hypot(grid.max[0] - grid.min[0], grid.max[1] - grid.min[1], grid.max[2] - grid.min[2]);
  if (prec === 'full') {
    streams.position = { ...vertex.push(g.positions), format: 'float32x3' };
    count('position:float32x3');
  } else {
    const q = quantizePositions(g.positions, grid.min, grid.max);
    const px = positionPixelError(q.maxError, diag, tol);
    if (prec === 'auto' && px > tol.pixelError) {
      ctx.log(`positions: unorm16 grid error ${px.toFixed(3)} px > ${tol.pixelError} px at ${tol.screenPixels} px; keeping float32`);
      streams.position = { ...vertex.push(g.positions), format: 'float32x3' };
      count('position:float32x3');
    } else {
      if (px > tol.pixelError) ctx.warn(`positions: ${px.toFixed(3)} px error exceeds tolerance ${tol.pixelError} px (--vertex-precision low)`);
      stats.maxPositionPixelError = Math.max(stats.maxPositionPixelError, px);
      streams.position = { ...vertex.push(q.data), format: q.format };
      positionTransform = { scale: q.scale, offset: q.offset };
      count(`position:${q.format}`);
    }
  }
  const n = chooseNormals(g.normals, prec, opts.normalEncoding, tol);
  streams.normal = { ...vertex.push(n.stream.data), format: n.stream.format, ...(n.stream.encoding ? { encoding: n.stream.encoding } : {}) };
  stats.maxNormalErrorDeg = Math.max(stats.maxNormalErrorDeg, n.stream.maxError);
  count(`normal:${n.stream.format}${n.stream.encoding ? '/oct' : ''}`);
  if (g.uvs && keepUv) {
    const u = chooseUvs(g.uvs, prec, Math.max(1, texSize), tol);
    streams.uv = { ...vertex.push(u.stream.data), format: u.stream.format };
    stats.maxUvErrorTexels = Math.max(stats.maxUvErrorTexels, u.stream.maxError * Math.max(1, texSize));
    count(`uv:${u.stream.format}`);
  }
  if (g.tangents) {
    const t = chooseTangents(g.tangents, prec, opts.normalEncoding, tol);
    streams.tangent = { ...vertex.push(t.stream.data), format: t.stream.format, ...(t.stream.encoding ? { encoding: t.stream.encoding } : {}) };
    stats.maxNormalErrorDeg = Math.max(stats.maxNormalErrorDeg, t.stream.maxError);
    count(`tangent:${t.stream.format}${t.stream.encoding ? '/oct' : ''}`);
  }
  stats.quantizeMs += performance.now() - t0;
  stats.vertexBytesF32 += g.vertexCount * (12 + 12 + (streams.uv ? 8 : 0) + (streams.tangent ? 16 : 0));
  for (const st of Object.values(streams)) if (st) stats.vertexBytes += st.byteLength;

  const use16 = g.vertexCount <= 0x10000;
  const idxData = use16 ? Uint16Array.from(g.lodIndices) : g.lodIndices;
  const range = index.push(idxData, 4);
  stats.indexBytes += range.byteLength;

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
    ...(positionTransform ? { positionTransform } : {}),
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
