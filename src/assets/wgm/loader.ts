/**
 * Loads a baked .wgm file into the existing renderer objects (GpuMaterial,
 * GpuPrimitive, Node). CPU work is deliberately small:
 *   - one JSON.parse of the manifest,
 *   - one GPU buffer for all vertex streams + one for all indices (single copy
 *     each); quantized vertex formats are converted by the GPU's vertex fetch,
 *   - textures: native BC7 / ASTC / ETC2 / RGBA8 levels go to writeTexture
 *     as-is (no CPU decode). Only files baked with `--texture-format universal`
 *     contain KTX2, and only then is the Basis transcoder fetched and run.
 * The file's texture formats are checked against the device BEFORE anything
 * is uploaded; a missing feature is a clear error that names the re-bake.
 */
import { vec3 } from 'wgpu-matrix';
import { Node } from '../../scene/node';
import { createBuffer, type GpuMesh, type GpuPrimitive } from '../../renderer/mesh';
import { defaultMaterialDesc, type GpuMaterial } from '../../renderer/material';
import type { Renderer } from '../../renderer/renderer';
import { vertexLayout } from '../../renderer/vertexLayout';
import type { TranscodeTarget } from '../ktx2/transcoder';
import {
  readWgm, requiredTextureFeature, WGM_F32_FORMATS, WgmFormatError, type WgmManifest, type WgmPrimitive, type WgmTexture,
} from './format';

const SUPPORTED_LAYOUTS = ['f32-split-v1', 'split-v2'];

/** Thrown when the device cannot sample a texture format stored in the file. */
export class WgmUnsupportedFormatError extends WgmFormatError {
  override name = 'WgmUnsupportedFormatError';
}

/** Best native format suffix for `{tex}` in model URLs (files baked with --texture-format each). */
export function pickNativeTextureFormat(device: GPUDevice): 'bc7' | 'astc' | 'etc2' | 'rgba8' {
  if (device.features.has('texture-compression-bc')) return 'bc7';
  if (device.features.has('texture-compression-astc')) return 'astc';
  if (device.features.has('texture-compression-etc2')) return 'etc2';
  return 'rgba8';
}

/** Throws WgmUnsupportedFormatError listing every texture format the device lacks. */
export function checkTextureSupport(device: GPUDevice, m: WgmManifest): void {
  const missing = new Map<string, string>();
  for (const t of m.textures) {
    if (t.encoding === 'ktx2' || !t.format) continue;
    const f = requiredTextureFeature(t.format);
    if (f && !device.features.has(f)) missing.set(t.format, f);
  }
  if (!missing.size) return;
  const list = [...missing].map(([fmt, f]) => `${fmt} (needs ${f})`).join(', ');
  const have = ['bc', 'astc', 'etc2'].filter((k) => device.features.has(`texture-compression-${k}` as GPUFeatureName));
  throw new WgmUnsupportedFormatError(
    `this GPU cannot sample the file's texture format: ${list}. The device supports ${have.length ? have.join(', ') : 'no compressed formats'}. ` +
    `Re-bake for this device: npm run bake -- <model> --device <its probe profile>, or --texture-format ${pickNativeTextureFormat(device)}` +
    ` (or --texture-format each and load <name>.{tex}.wgm).`,
  );
}

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
  if (!SUPPORTED_LAYOUTS.includes(m.vertexLayout)) {
    throw new WgmFormatError(`vertex layout "${m.vertexLayout}" is not supported by this engine (expects ${SUPPORTED_LAYOUTS.join(' or ')})`);
  }
  checkTextureSupport(device, m);
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
  const timing = { transcodeMs: 0, transcoderLoadMs: 0, textureBytes: 0 };
  for (const t of m.textures) textures.push(await createTexture(renderer, t, texBytes, name, opts.transcodeTarget, formats, timing));
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
  const layouts = new Set<string>();
  const meshes: GpuMesh[] = m.meshes.map((mesh) => ({
    name: mesh.name,
    primitives: mesh.primitives.map((p): GpuPrimitive => {
      if (!vertexBuffer || !indexBuffer) throw new WgmFormatError('primitive present but vertex/index section missing');
      const s = p.streams;
      const layout = primitiveLayout(p);
      const material = materialFor(p.material);
      if (!layouts.has(`${layout.key}/${material.id}`)) {
        layouts.add(`${layout.key}/${material.id}`);
        renderer.prewarmPipelines(material, layout);
      }
      return {
        vertexBuffers: [vertexBuffer, vertexBuffer, s.uv ? vertexBuffer : zero, s.tangent ? vertexBuffer : zero],
        vertexOffsets: [s.position.byteOffset, s.normal.byteOffset, s.uv?.byteOffset ?? 0, s.tangent?.byteOffset ?? 0],
        vertexLayout: layout,
        ...(p.positionTransform ? { positionTransform: p.positionTransform } : {}),
        indexBuffer,
        indexOffset: p.indices.byteOffset,
        indexFormat: p.indices.format,
        indexCount: p.lods[0].indexCount,
        lods: p.lods,
        material,
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
    const tEnd = performance.now();
    Object.assign(opts.stats, {
      parseMs: tParse - t0,
      geometryUploadMs: tGeom - tParse,
      /** Everything texture-related: upload + (universal files only) transcoder load + transcode. */
      textureMs: tTex - tGeom,
      textureUploadMs: tTex - tGeom - timing.transcodeMs - timing.transcoderLoadMs,
      transcoderLoadMs: timing.transcoderLoadMs,
      transcodeMs: timing.transcodeMs,
      /** CPU decode of vertex data: always 0 (GPU vertex fetch converts quantized formats). */
      vertexDecodeMs: 0,
      materialsAndNodesMs: tEnd - tTex,
      totalInstantiateMs: tEnd - t0,
      textureFormats: [...formats].join(','),
      textureBytes: timing.textureBytes,
      vertexBytes: vertexBytes.byteLength,
      indexBytes: indexBytes.byteLength,
      vertexLayouts: [...new Set([...layouts].map((k) => k.split('/')[0]))].join(' ; '),
      wgmVersion: m.version.join('.'),
    });
  }
  return root;
}

/** GPU vertex layout of a primitive (v1 files: all float32). */
function primitiveLayout(p: WgmPrimitive) {
  const s = p.streams;
  const fmt = <K extends keyof typeof WGM_F32_FORMATS>(k: K) => (s[k]?.format ?? WGM_F32_FORMATS[k]) as GPUVertexFormat;
  return vertexLayout({
    position: fmt('position'),
    normal: fmt('normal'),
    uv: s.uv ? fmt('uv') : null,
    tangent: s.tangent ? fmt('tangent') : null,
    octNormal: s.normal.encoding === 'oct',
    octTangent: s.tangent?.encoding === 'oct',
  });
}

async function createTexture(
  renderer: Renderer, t: WgmTexture, section: Uint8Array, name: string, target: TranscodeTarget | undefined, formats: Set<string>,
  timing: { transcodeMs: number; transcoderLoadMs: number; textureBytes: number },
): Promise<GPUTexture> {
  const bytes = section.subarray(t.data.byteOffset, t.data.byteOffset + t.data.byteLength);
  const srgb = t.colorSpace === 'srgb';
  const label = `${name} ${t.name}`;
  if (t.encoding !== 'ktx2') {
    // Native: the stored bytes are exactly what the GPU samples.
    if (!t.levels?.length) throw new WgmFormatError(`texture "${t.name}": ${t.encoding} without levels`);
    const format = (t.format ?? (srgb ? 'rgba8unorm-srgb' : 'rgba8unorm')) as GPUTextureFormat;
    const levels = t.levels.map((l) => ({ data: bytes.subarray(l.byteOffset, l.byteOffset + l.byteLength), width: l.width, height: l.height }));
    formats.add(format);
    timing.textureBytes += bytes.byteLength;
    return renderer.createTextureFromLevels(format, levels, label);
  }
  // Opt-in universal mode: the only path that transcodes at load. The transcoder is a lazy chunk.
  const t0 = performance.now();
  const { transcodeKtx2, loadBasisTranscoder } = await import('../ktx2/transcoder');
  await loadBasisTranscoder();
  const t1 = performance.now();
  const tx = await transcodeKtx2(renderer.device, bytes, srgb, target);
  const t2 = performance.now();
  timing.transcoderLoadMs += t1 - t0;
  timing.transcodeMs += t2 - t1;
  formats.add(`${tx.format} (transcoded from KTX2)`);
  timing.textureBytes += tx.levels.reduce((n, l) => n + l.data.byteLength, 0);
  return renderer.createTextureFromLevels(tx.format, tx.levels, label);
}
