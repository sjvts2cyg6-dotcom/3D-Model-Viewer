/**
 * Turns a parsed glTF asset into GPU resources + a scene-graph subtree.
 * This is the only place that knows about both the glTF data model and the
 * renderer; a future baked-format loader would sit alongside it.
 */
import { Node } from '../scene/node';
import { defaultMaterialDesc, type GpuMaterial } from '../renderer/material';
import type { GpuMesh } from '../renderer/mesh';
import type { Renderer } from '../renderer/renderer';
import { loadGltf, type GltfAsset } from './gltf';

export async function loadModel(renderer: Renderer, url: string): Promise<Node> {
  const asset = await loadGltf(url);
  return instantiate(renderer, asset, url.split('/').pop() ?? 'model');
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
