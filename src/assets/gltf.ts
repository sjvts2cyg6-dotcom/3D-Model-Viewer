/**
 * glTF 2.0 / GLB parser -> engine-neutral CPU data (no GPU calls here).
 *
 * Supported: .gltf (external or data: URIs) and .glb, TRIANGLES primitives,
 * POSITION / NORMAL / TEXCOORD_0 / TANGENT, any index type, interleaved and
 * sparse accessors, normalized integer attributes, node TRS or matrix,
 * metallic-roughness materials with all 5 core textures, samplers,
 * KHR_materials_emissive_strength.
 */
import { vec3 } from 'wgpu-matrix';
import type { AlphaMode } from '../renderer/material';
import type { PrimitiveData } from '../renderer/mesh';
import { computeBounds, computeNormals, computeTangents } from './geometry';

// ------------------------------------------------------------ JSON schema (subset)

interface GltfTextureInfo { index: number; texCoord?: number; scale?: number; strength?: number }
interface GltfJson {
  asset: { version: string };
  extensionsUsed?: string[];
  extensionsRequired?: string[];
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: {
    name?: string; mesh?: number; children?: number[]; matrix?: number[];
    translation?: number[]; rotation?: number[]; scale?: number[];
  }[];
  meshes?: { name?: string; primitives: GltfPrimitive[] }[];
  accessors?: GltfAccessor[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  buffers?: { uri?: string; byteLength: number }[];
  materials?: GltfMaterial[];
  textures?: { sampler?: number; source?: number }[];
  images?: { uri?: string; bufferView?: number; mimeType?: string }[];
  samplers?: { magFilter?: number; minFilter?: number; wrapS?: number; wrapT?: number }[];
}
interface GltfPrimitive { attributes: Record<string, number>; indices?: number; material?: number; mode?: number }
interface GltfAccessor {
  bufferView?: number; byteOffset?: number; componentType: number; normalized?: boolean;
  count: number; type: keyof typeof COMPONENTS; min?: number[]; max?: number[];
  sparse?: {
    count: number;
    indices: { bufferView: number; byteOffset?: number; componentType: number };
    values: { bufferView: number; byteOffset?: number };
  };
}
interface GltfMaterial {
  name?: string;
  pbrMetallicRoughness?: {
    baseColorFactor?: number[]; baseColorTexture?: GltfTextureInfo;
    metallicFactor?: number; roughnessFactor?: number; metallicRoughnessTexture?: GltfTextureInfo;
  };
  normalTexture?: GltfTextureInfo;
  occlusionTexture?: GltfTextureInfo;
  emissiveTexture?: GltfTextureInfo;
  emissiveFactor?: number[];
  alphaMode?: AlphaMode;
  alphaCutoff?: number;
  doubleSided?: boolean;
  extensions?: { KHR_materials_emissive_strength?: { emissiveStrength?: number } };
}

// ------------------------------------------------------------ output types

export interface SamplerData {
  magFilter: GPUFilterMode;
  minFilter: GPUFilterMode;
  mipmapFilter: GPUMipmapFilterMode;
  addressModeU: GPUAddressMode;
  addressModeV: GPUAddressMode;
}

export interface TextureData { image: ImageBitmap; sampler: SamplerData }

export interface MaterialData {
  name: string;
  baseColorFactor: [number, number, number, number];
  metallicFactor: number;
  roughnessFactor: number;
  emissiveFactor: [number, number, number];
  normalScale: number;
  occlusionStrength: number;
  alphaMode: AlphaMode;
  alphaCutoff: number;
  doubleSided: boolean;
  baseColorTexture?: number;
  metallicRoughnessTexture?: number;
  normalTexture?: number;
  occlusionTexture?: number;
  emissiveTexture?: number;
}

export interface MeshData { name: string; primitives: (PrimitiveData & { material?: number })[] }

export interface NodeData {
  name: string;
  mesh?: number;
  children: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}

export interface GltfAsset {
  meshes: MeshData[];
  materials: MaterialData[];
  textures: TextureData[];
  nodes: NodeData[];
  roots: number[];
}

// ------------------------------------------------------------ constants

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 } as const;
const BYTE = 5120, UBYTE = 5121, SHORT = 5122, USHORT = 5123, UINT = 5125, FLOAT = 5126;
const COMPONENT_SIZE: Record<number, number> = { [BYTE]: 1, [UBYTE]: 1, [SHORT]: 2, [USHORT]: 2, [UINT]: 4, [FLOAT]: 4 };
const MODE_TRIANGLES = 4;

const SUPPORTED_REQUIRED_EXTENSIONS = new Set(['KHR_materials_emissive_strength']);

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

// ------------------------------------------------------------ entry point

export async function loadGltf(url: string): Promise<GltfAsset> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`glTF: failed to fetch ${url} (${res.status} ${res.statusText})`);
  return parseGltf(await res.arrayBuffer(), new URL(url, location.href));
}

/** True if `data` starts with the GLB magic. */
export function isGlb(data: ArrayBuffer): boolean {
  return data.byteLength >= 12 && new DataView(data).getUint32(0, true) === GLB_MAGIC;
}

/** Parse an already-fetched .glb or .gltf; external buffers/images resolve against `baseUrl`. */
export async function parseGltf(data: ArrayBuffer, baseUrl: URL): Promise<GltfAsset> {
  let json: GltfJson;
  let glbBin: ArrayBuffer | undefined;
  if (isGlb(data)) {
    ({ json, bin: glbBin } = parseGlb(data));
  } else {
    json = JSON.parse(new TextDecoder().decode(data)) as GltfJson;
  }

  if (!json.asset?.version?.startsWith('2.')) throw new Error(`glTF: unsupported version ${json.asset?.version}`);
  const unsupported = (json.extensionsRequired ?? []).filter((e) => !SUPPORTED_REQUIRED_EXTENSIONS.has(e));
  if (unsupported.length) throw new Error(`glTF: required extensions not supported: ${unsupported.join(', ')}`);

  const buffers = await Promise.all(
    (json.buffers ?? []).map(async (b, i) => {
      if (b.uri === undefined) {
        if (i === 0 && glbBin) return glbBin;
        throw new Error(`glTF: buffer ${i} has no uri and no GLB BIN chunk`);
      }
      return fetchBinary(new URL(b.uri, baseUrl).href);
    }),
  );

  const ctx: Ctx = { json, buffers };
  const textures = await loadTextures(ctx, baseUrl);

  return {
    meshes: (json.meshes ?? []).map((m, i) => parseMesh(ctx, m, i)),
    materials: (json.materials ?? []).map(parseMaterial),
    textures,
    nodes: (json.nodes ?? []).map((n, i) => ({
      name: n.name ?? `node_${i}`,
      mesh: n.mesh,
      children: n.children ?? [],
      matrix: n.matrix,
      translation: n.translation,
      rotation: n.rotation,
      scale: n.scale,
    })),
    roots: sceneRoots(json),
  };
}

// ------------------------------------------------------------ internals

interface Ctx { json: GltfJson; buffers: ArrayBuffer[] }

function parseGlb(data: ArrayBuffer): { json: GltfJson; bin?: ArrayBuffer } {
  const dv = new DataView(data);
  const version = dv.getUint32(4, true);
  if (version !== 2) throw new Error(`GLB: unsupported container version ${version}`);
  const length = Math.min(dv.getUint32(8, true), data.byteLength);
  let offset = 12;
  let json: GltfJson | undefined;
  let bin: ArrayBuffer | undefined;
  while (offset + 8 <= length) {
    const chunkLength = dv.getUint32(offset, true);
    const chunkType = dv.getUint32(offset + 4, true);
    const start = offset + 8;
    if (chunkType === CHUNK_JSON) {
      json = JSON.parse(new TextDecoder().decode(new Uint8Array(data, start, chunkLength))) as GltfJson;
    } else if (chunkType === CHUNK_BIN && !bin) {
      bin = data.slice(start, start + chunkLength);
    }
    offset = start + chunkLength;
  }
  if (!json) throw new Error('GLB: missing JSON chunk');
  return { json, bin };
}

async function fetchBinary(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`glTF: failed to fetch ${url} (${r.status})`);
  return r.arrayBuffer();
}

function sceneRoots(json: GltfJson): number[] {
  const scene = json.scenes?.[json.scene ?? 0];
  if (scene?.nodes) return scene.nodes;
  // No scenes: every node that isn't someone's child is a root.
  const isChild = new Set<number>();
  for (const n of json.nodes ?? []) for (const c of n.children ?? []) isChild.add(c);
  return (json.nodes ?? []).map((_, i) => i).filter((i) => !isChild.has(i));
}

function readComponent(dv: DataView, offset: number, componentType: number, normalized: boolean): number {
  switch (componentType) {
    case FLOAT: return dv.getFloat32(offset, true);
    case UBYTE: { const v = dv.getUint8(offset); return normalized ? v / 255 : v; }
    case BYTE: { const v = dv.getInt8(offset); return normalized ? Math.max(v / 127, -1) : v; }
    case USHORT: { const v = dv.getUint16(offset, true); return normalized ? v / 65535 : v; }
    case SHORT: { const v = dv.getInt16(offset, true); return normalized ? Math.max(v / 32767, -1) : v; }
    case UINT: return dv.getUint32(offset, true);
    default: throw new Error(`glTF: bad componentType ${componentType}`);
  }
}

/** Reads any accessor as tightly-packed numbers in `out` (Float32Array or Uint32Array). */
function readAccessorInto<T extends Float32Array | Uint32Array>(ctx: Ctx, index: number, make: (n: number) => T): { data: T; components: number; count: number } {
  const acc = ctx.json.accessors?.[index];
  if (!acc) throw new Error(`glTF: missing accessor ${index}`);
  const n = COMPONENTS[acc.type];
  const out = make(acc.count * n);
  const compSize = COMPONENT_SIZE[acc.componentType];
  const normalized = !!acc.normalized;

  if (acc.bufferView !== undefined) {
    const bv = ctx.json.bufferViews![acc.bufferView];
    const buffer = ctx.buffers[bv.buffer];
    const base = (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const elemSize = compSize * n;
    const stride = bv.byteStride ?? elemSize;
    const sameType = (out instanceof Float32Array && acc.componentType === FLOAT) || (out instanceof Uint32Array && acc.componentType === UINT);
    if (sameType && stride === elemSize) {
      // Fast path: tightly packed, same element type -> single memcpy (slice handles misalignment).
      out.set(new (out.constructor as Float32ArrayConstructor)(buffer.slice(base, base + acc.count * elemSize)));
    } else {
      const dv = new DataView(buffer);
      for (let i = 0; i < acc.count; i++) {
        const o = base + i * stride;
        for (let c = 0; c < n; c++) out[i * n + c] = readComponent(dv, o + c * compSize, acc.componentType, normalized);
      }
    }
  }

  if (acc.sparse) {
    const { indices, values, count } = acc.sparse;
    const ibv = ctx.json.bufferViews![indices.bufferView];
    const vbv = ctx.json.bufferViews![values.bufferView];
    const idv = new DataView(ctx.buffers[ibv.buffer]);
    const vdv = new DataView(ctx.buffers[vbv.buffer]);
    const iBase = (ibv.byteOffset ?? 0) + (indices.byteOffset ?? 0);
    const vBase = (vbv.byteOffset ?? 0) + (values.byteOffset ?? 0);
    const iSize = COMPONENT_SIZE[indices.componentType];
    for (let s = 0; s < count; s++) {
      const target = readComponent(idv, iBase + s * iSize, indices.componentType, false);
      for (let c = 0; c < n; c++) {
        out[target * n + c] = readComponent(vdv, vBase + (s * n + c) * compSize, acc.componentType, normalized);
      }
    }
  }
  return { data: out, components: n, count: acc.count };
}

const readFloats = (ctx: Ctx, i: number) => readAccessorInto(ctx, i, (n) => new Float32Array(n));

function readIndices(ctx: Ctx, i: number, vertexCount: number): Uint16Array | Uint32Array {
  const { data } = readAccessorInto(ctx, i, (n) => new Uint32Array(n));
  return vertexCount <= 0xffff ? Uint16Array.from(data) : data;
}

function sequentialIndices(count: number): Uint16Array | Uint32Array {
  const out = count <= 0xffff ? new Uint16Array(count) : new Uint32Array(count);
  for (let i = 0; i < count; i++) out[i] = i;
  return out;
}

/** Copies `src` (n components per element) into an array with `want` components, padding with `fill`. */
function reshape(src: Float32Array, n: number, count: number, want: number, fill: number[]): Float32Array {
  if (n === want) return src;
  const out = new Float32Array(count * want);
  for (let i = 0; i < count; i++) for (let c = 0; c < want; c++) out[i * want + c] = c < n ? src[i * n + c] : fill[c];
  return out;
}

function parseMesh(ctx: Ctx, mesh: NonNullable<GltfJson['meshes']>[number], meshIndex: number): MeshData {
  const primitives: MeshData['primitives'] = [];
  for (const p of mesh.primitives) {
    if ((p.mode ?? MODE_TRIANGLES) !== MODE_TRIANGLES) {
      console.warn(`glTF: mesh ${meshIndex}: skipping primitive with mode ${p.mode} (only TRIANGLES supported)`);
      continue;
    }
    if (p.attributes.POSITION === undefined) continue;

    const pos = readFloats(ctx, p.attributes.POSITION);
    const count = pos.count;
    const positions = pos.data;

    const indices: Uint16Array | Uint32Array = p.indices !== undefined
      ? readIndices(ctx, p.indices, count)
      : sequentialIndices(count);

    const normals = p.attributes.NORMAL !== undefined ? readFloats(ctx, p.attributes.NORMAL).data : computeNormals(positions, indices);

    let uvs: Float32Array;
    if (p.attributes.TEXCOORD_0 !== undefined) {
      const t = readFloats(ctx, p.attributes.TEXCOORD_0);
      uvs = reshape(t.data, t.components, count, 2, [0, 0]);
    } else {
      uvs = new Float32Array(count * 2);
    }

    let tangents: Float32Array;
    if (p.attributes.TANGENT !== undefined) {
      const t = readFloats(ctx, p.attributes.TANGENT);
      tangents = reshape(t.data, t.components, count, 4, [0, 0, 0, 1]);
    } else {
      const usesNormalMap = p.material !== undefined && ctx.json.materials?.[p.material]?.normalTexture !== undefined;
      // Only spend CPU on tangents when a normal map will actually consume them.
      tangents = usesNormalMap && p.attributes.TEXCOORD_0 !== undefined
        ? computeTangents(positions, normals, uvs, indices)
        : new Float32Array(count * 4);
    }

    const acc = ctx.json.accessors![p.attributes.POSITION];
    const b = acc.min && acc.max ? { min: acc.min, max: acc.max } : computeBounds(positions);
    primitives.push({
      positions, normals, uvs, tangents, indices,
      boundsMin: vec3.create(b.min[0], b.min[1], b.min[2]),
      boundsMax: vec3.create(b.max[0], b.max[1], b.max[2]),
      material: p.material,
    });
  }
  return { name: mesh.name ?? `mesh_${meshIndex}`, primitives };
}

function parseMaterial(m: GltfMaterial, i: number): MaterialData {
  const pbr = m.pbrMetallicRoughness ?? {};
  const strength = m.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1;
  const e = m.emissiveFactor ?? [0, 0, 0];
  const bc = pbr.baseColorFactor ?? [1, 1, 1, 1];
  return {
    name: m.name ?? `material_${i}`,
    baseColorFactor: [bc[0], bc[1], bc[2], bc[3]],
    metallicFactor: pbr.metallicFactor ?? 1,
    roughnessFactor: pbr.roughnessFactor ?? 1,
    emissiveFactor: [e[0] * strength, e[1] * strength, e[2] * strength],
    normalScale: m.normalTexture?.scale ?? 1,
    occlusionStrength: m.occlusionTexture?.strength ?? 1,
    alphaMode: m.alphaMode ?? 'OPAQUE',
    alphaCutoff: m.alphaCutoff ?? 0.5,
    doubleSided: m.doubleSided ?? false,
    baseColorTexture: pbr.baseColorTexture?.index,
    metallicRoughnessTexture: pbr.metallicRoughnessTexture?.index,
    normalTexture: m.normalTexture?.index,
    occlusionTexture: m.occlusionTexture?.index,
    emissiveTexture: m.emissiveTexture?.index,
  };
}

function filterOf(f: number | undefined): GPUFilterMode {
  return f === 9728 || f === 9984 || f === 9986 ? 'nearest' : 'linear';
}
function mipFilterOf(f: number | undefined): GPUMipmapFilterMode {
  return f === 9984 || f === 9985 ? 'nearest' : 'linear';
}
function wrapOf(w: number | undefined): GPUAddressMode {
  return w === 33071 ? 'clamp-to-edge' : w === 33648 ? 'mirror-repeat' : 'repeat';
}

async function loadTextures(ctx: Ctx, baseUrl: URL): Promise<TextureData[]> {
  const { json } = ctx;
  // Decode each image once even if several textures reference it.
  const images = new Map<number, Promise<ImageBitmap>>();
  const decode = (i: number): Promise<ImageBitmap> => {
    let p = images.get(i);
    if (!p) {
      p = (async () => {
        const img = json.images![i];
        let blob: Blob;
        if (img.bufferView !== undefined) {
          const bv = json.bufferViews![img.bufferView];
          const start = bv.byteOffset ?? 0;
          blob = new Blob([ctx.buffers[bv.buffer].slice(start, start + bv.byteLength)], { type: img.mimeType ?? 'image/png' });
        } else if (img.uri) {
          const r = await fetch(new URL(img.uri, baseUrl).href);
          if (!r.ok) throw new Error(`glTF: failed to fetch image ${img.uri} (${r.status})`);
          blob = await r.blob();
        } else {
          throw new Error(`glTF: image ${i} has neither uri nor bufferView`);
        }
        // No colour-space conversion / premultiply: glTF texture data is used verbatim.
        return createImageBitmap(blob, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      })();
      images.set(i, p);
    }
    return p;
  };

  return Promise.all(
    (json.textures ?? []).map(async (t) => {
      if (t.source === undefined) throw new Error('glTF: texture without source (extension-only textures unsupported)');
      const s = t.sampler !== undefined ? json.samplers?.[t.sampler] : undefined;
      return {
        image: await decode(t.source),
        sampler: {
          magFilter: filterOf(s?.magFilter),
          minFilter: filterOf(s?.minFilter),
          mipmapFilter: mipFilterOf(s?.minFilter),
          addressModeU: wrapOf(s?.wrapS),
          addressModeV: wrapOf(s?.wrapT),
        },
      };
    }),
  );
}
