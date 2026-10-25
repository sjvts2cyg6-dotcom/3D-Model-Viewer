/**
 * Loads a baked .wgm file into the existing renderer objects (GpuMaterial,
 * GpuPrimitive, Node). CPU work is deliberately small:
 *   - one JSON.parse of the manifest,
 *   - one GPU buffer for all vertex streams + one for all indices (single copy each),
 *   - textures: rgba8 levels are uploaded as-is; KTX2 is transcoded (Basis wasm).
 * No vertex/index processing happens at load time.
 */
import { vec3 } from 'wgpu-matrix';
import { Node } from '../../scene/node';
import { createBuffer, type GpuMesh, type GpuPrimitive } from '../../renderer/mesh';
import { defaultMaterialDesc, type GpuMaterial } from '../../renderer/material';
import type { Renderer } from '../../renderer/renderer';
import { transcodeKtx2, type TranscodeTarget } from '../ktx2/transcoder';
import { readWgm, WGM_VERTEX_LAYOUT, WgmFormatError, type WgmTexture } from './format';

export interface WgmLoadOptions {
  /** Force a KTX2 transcode target (default: best supported by the device). */
  transcodeTarget?: TranscodeTarget;
  /** Filled with timing (ms) and texture-format details if provided. */
  stats?: Record<string, number | string>;
}

export async function instantiateWgm(
  renderer: Renderer, data: ArrayBuffer, name = 'model', opts: WgmLoadOptions = {},
): Promise<Node> {
  const device = renderer.device;
  const t0 = performance.now();
  const file = readWgm(data);
  const m = file.manifest;
  if (m.vertexLayout !== WGM_VERTEX_LAYOUT) {
    throw new WgmFormatError(`vertex layout "${m.vertexLayout}" is not supported by this engine (expects ${WGM_VERTEX_LAYOUT})`);
  }
  const tParse = performance.now();

  // ---- geometry: two GPU buffers for the whole file
  const vertexBytes = file.section('vertex');
  const indexBytes = file.section('index');
  const vertexBuffer = vertexBytes.byteLength ? createBuffer(device, vertexBytes, GPUBufferUsage.VERTEX, `${name} vertices`) : null;
  const indexBuffer = indexBytes.byteLength ? createBuffer(device, indexBytes, GPUBufferUsage.INDEX, `${name} indices`) : null;
  const tGeom = performance.now();

  // ---- textures
  const texBytes = file.section('texture');
  const formats = new Set<string>();
  const textures: GPUTexture[] = [];
  for (const t of m.textures) textures.push(await createTexture(renderer, t, texBytes, name, opts.transcodeTarget, formats));
  const tTex = performance.now();

  // ---- materials (one sampler per material, like the glTF path)
  const materials: GpuMaterial[] = m.materials.map((mat) => {
    const refs = [mat.baseColorTexture, mat.metallicRoughnessTexture, mat.normalTexture, mat.occlusionTexture, mat.emissiveTexture];
    const first = refs.find((r) => r !== undefined);
    return renderer.createMaterial({
      ...mat,
      baseColorTexture: mat.baseColorTexture && textures[mat.baseColorTexture.texture],
      metallicRoughnessTexture: mat.metallicRoughnessTexture && textures[mat.metallicRoughnessTexture.texture],
      normalTexture: mat.normalTexture && textures[mat.normalTexture.texture],
      occlusionTexture: mat.occlusionTexture && textures[mat.occlusionTexture.texture],
      emissiveTexture: mat.emissiveTexture && textures[mat.emissiveTexture.texture],
      sampler: renderer.getSampler(first ? m.samplers[first.sampler] : undefined),
    });
  });
  let fallback: GpuMaterial | undefined;
  const materialFor = (i: number | null): GpuMaterial =>
    (i !== null ? materials[i] : undefined) ?? (fallback ??= renderer.createMaterial({ ...defaultMaterialDesc(), name: 'default' }));

  const zero = renderer.zeroVertexBuffer;
  const meshes: GpuMesh[] = m.meshes.map((mesh) => ({
    name: mesh.name,
    primitives: mesh.primitives.map((p): GpuPrimitive => {
      if (!vertexBuffer || !indexBuffer) throw new WgmFormatError('primitive present but vertex/index section missing');
      const s = p.streams;
      return {
        vertexBuffers: [vertexBuffer, vertexBuffer, s.uv ? vertexBuffer : zero, s.tangent ? vertexBuffer : zero],
        vertexOffsets: [s.position.byteOffset, s.normal.byteOffset, s.uv?.byteOffset ?? 0, s.tangent?.byteOffset ?? 0],
        indexBuffer,
        indexOffset: p.indices.byteOffset,
        indexFormat: p.indices.format,
        indexCount: p.lods[0].indexCount,
        lods: p.lods,
        material: materialFor(p.material),
        boundsMin: vec3.fromValues(...p.bounds.min),
        boundsMax: vec3.fromValues(...p.bounds.max),
      };
    }),
  }));

  const nodes = m.nodes.map((nd) => {
    const node = new Node(nd.name);
    if (nd.translation) node.position.set(nd.translation);
    if (nd.rotation) node.rotation.set(nd.rotation);
    if (nd.scale) node.scale.set(nd.scale);
    node.markDirty();
    if (nd.mesh !== undefined) node.mesh = meshes[nd.mesh] ?? null;
    return node;
  });
  m.nodes.forEach((nd, i) => nd.children?.forEach((c) => nodes[i].add(nodes[c])));
  const root = new Node(name);
  for (const r of m.roots) root.add(nodes[r]);

  if (opts.stats) {
    Object.assign(opts.stats, {
      parseMs: tParse - t0,
      geometryUploadMs: tGeom - tParse,
      textureMs: tTex - tGeom,
      totalInstantiateMs: performance.now() - t0,
      textureFormats: [...formats].join(','),
    });
  }
  return root;
}

async function createTexture(
  renderer: Renderer, t: WgmTexture, section: Uint8Array, name: string, target: TranscodeTarget | undefined, formats: Set<string>,
): Promise<GPUTexture> {
  const bytes = section.subarray(t.data.byteOffset, t.data.byteOffset + t.data.byteLength);
  const srgb = t.colorSpace === 'srgb';
  const label = `${name} ${t.name}`;
  if (t.encoding === 'rgba8') {
    if (!t.levels?.length) throw new WgmFormatError(`texture "${t.name}": rgba8 without levels`);
    const levels = t.levels.map((l) => ({ data: bytes.subarray(l.byteOffset, l.byteOffset + l.byteLength), width: l.width, height: l.height }));
    const format: GPUTextureFormat = srgb ? 'rgba8unorm-srgb' : 'rgba8unorm';
    formats.add(format);
    return renderer.createTextureFromLevels(format, levels, label);
  }
  if (t.encoding === 'ktx2') {
    const tx = await transcodeKtx2(renderer.device, bytes, srgb, target);
    formats.add(tx.format);
    return renderer.createTextureFromLevels(tx.format, tx.levels, label);
  }
  throw new WgmFormatError(`texture "${t.name}": unknown encoding ${(t as { encoding: string }).encoding}`);
}
