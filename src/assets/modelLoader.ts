/**
 * Model entry point. `loadModel` fetches once and sniffs the bytes:
 *   - .wgm (baked by tools/bake)  -> wgm/loader.ts (minimal CPU work)
 *   - .glb / .gltf                -> gltf.ts + `instantiate` below (fallback path)
 */
import { Node } from '../scene/node';
import { defaultMaterialDesc, type GpuMaterial } from '../renderer/material';
import type { GpuMesh } from '../renderer/mesh';
import type { Renderer } from '../renderer/renderer';
import { parseGltf, type GltfAsset } from './gltf';
import { isWgm } from './wgm/format';
import { instantiateWgm, type WgmLoadOptions } from './wgm/loader';

export interface ModelLoadOptions extends WgmLoadOptions {}

export async function loadModel(renderer: Renderer, url: string, opts: ModelLoadOptions = {}): Promise<Node> {
  const t0 = performance.now();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch ${url} (${res.status} ${res.statusText})`);
  const data = await res.arrayBuffer();
  const name = url.split('/').pop()?.split('?')[0] ?? 'model';
  if (opts.stats) Object.assign(opts.stats, { fetchMs: performance.now() - t0, fileBytes: data.byteLength });
  if (isWgm(data)) {
    if (opts.stats) opts.stats.format = 'wgm';
    return instantiateWgm(renderer, data, name, opts);
  }
  if (opts.stats) opts.stats.format = 'gltf';
  const t1 = performance.now();
  const asset = await parseGltf(data, new URL(url, location.href));
  const t2 = performance.now();
  const root = instantiate(renderer, asset, name);
  if (opts.stats) Object.assign(opts.stats, { parseMs: t2 - t1, totalInstantiateMs: performance.now() - t1 });
  return root;
}

export function instantiate(renderer: Renderer, asset: GltfAsset, name = 'model'): Node {
  // The same image may be needed as sRGB (base colour/emissive) and linear; cache per (index, space).
  const texCache = new Map<string, GPUTexture>();
  const texture = (index: number | undefined, srgb: boolean): GPUTexture | undefined => {
    if (index === undefined || !asset.textures[index]) return undefined;
    const key = `${index}:${srgb ? 's' : 'l'}`;
    let t = texCache.get(key);
    if (!t) {
      t = renderer.createTexture(asset.textures[index].image, srgb, `${name} tex${index}${srgb ? ' srgb' : ''}`);
      texCache.set(key, t);
    }
    return t;
  };

  const materials: GpuMaterial[] = asset.materials.map((m) => {
    // One sampler per material (taken from the first textured slot) keeps the bind group small.
    const firstTex = [m.baseColorTexture, m.metallicRoughnessTexture, m.normalTexture, m.occlusionTexture, m.emissiveTexture]
      .find((t) => t !== undefined);
    return renderer.createMaterial({
      ...m,
      baseColorTexture: texture(m.baseColorTexture, true),
      metallicRoughnessTexture: texture(m.metallicRoughnessTexture, false),
      normalTexture: texture(m.normalTexture, false),
      occlusionTexture: texture(m.occlusionTexture, false),
      emissiveTexture: texture(m.emissiveTexture, true),
      sampler: renderer.getSampler(firstTex !== undefined ? asset.textures[firstTex].sampler : undefined),
    });
  });

  let fallback: GpuMaterial | undefined;
  const materialFor = (i: number | undefined): GpuMaterial =>
    (i !== undefined ? materials[i] : undefined) ?? (fallback ??= renderer.createMaterial({ ...defaultMaterialDesc(), name: 'default' }));

  const meshes: GpuMesh[] = asset.meshes.map((m) => ({
    name: m.name,
    primitives: m.primitives.map((p, i) => renderer.createPrimitive(p, materialFor(p.material), `${m.name}#${i}`)),
  }));

  // Decoded images now live on the GPU; free the CPU copies.
  for (const t of asset.textures) t.image.close();

  const nodes = asset.nodes.map((nd) => {
    const node = new Node(nd.name);
    if (nd.matrix) node.setMatrix(nd.matrix);
    else {
      if (nd.translation) node.position.set(nd.translation);
      if (nd.rotation) node.rotation.set(nd.rotation);
      if (nd.scale) node.scale.set(nd.scale);
      node.markDirty();
    }
    if (nd.mesh !== undefined) node.mesh = meshes[nd.mesh] ?? null;
    return node;
  });
  asset.nodes.forEach((nd, i) => nd.children.forEach((c) => nodes[i].add(nodes[c])));

  const root = new Node(name);
  for (const r of asset.roots) root.add(nodes[r]);
  return root;
}
