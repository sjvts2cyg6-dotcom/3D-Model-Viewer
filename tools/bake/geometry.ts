/**
 * Index-level optimisation with meshoptimizer (WASM):
 *   - vertex cache optimisation + vertex fetch remap for LOD0,
 *   - LOD chain via attribute-aware simplification; every LOD indexes the
 *     same vertex buffer, so a LOD costs only its indices,
 *   - each LOD gets its own vertex-cache-optimised triangle order.
 */
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

export interface SourceGeometry {
  positions: Float32Array;
  normals: Float32Array;
  uvs?: Float32Array;
  tangents?: Float32Array;
  indices: Uint32Array;
}

export interface OptimizedGeometry extends SourceGeometry {
  vertexCount: number;
  /** All LOD index lists concatenated, LOD0 first. */
  lodIndices: Uint32Array;
  lods: { firstIndex: number; indexCount: number; error: number }[];
}

export interface LodPolicy {
  levels: number;
  ratio: number;
  maxError: number;
  /**
   * Pre-reduction of the full-detail level (1 = keep the source triangles).
   * Used for device triangle budgets; the reduced mesh becomes LOD0.
   */
  baseRatio?: number;
  /**
   * Error limit for that pre-reduction, in mesh units (absolute). The budget reduction stops
   * there even if the budget is not reached. Undefined = no limit.
   */
  baseMaxError?: number;
}

function attributeStream(normals: Float32Array, uvs: Float32Array | undefined, count: number) {
  const stride = uvs ? 5 : 3;
  const attrs = new Float32Array(count * stride);
  for (let v = 0; v < count; v++) {
    attrs.set(normals.subarray(v * 3, v * 3 + 3), v * stride);
    if (uvs) attrs.set(uvs.subarray(v * 2, v * 2 + 2), v * stride + 3);
  }
  return { attrs, stride, weights: uvs ? [0.5, 0.5, 0.5, 1, 1] : [0.5, 0.5, 0.5] };
}

export async function optimizeGeometry(src: SourceGeometry, policy: LodPolicy): Promise<OptimizedGeometry> {
  await Promise.all([MeshoptEncoder.ready, MeshoptSimplifier.ready]);
  const vertexCountIn = src.positions.length / 3;

  // 0. Optional budget reduction of the full-detail level (before the remap, so
  //    vertices only the removed triangles used are dropped below).
  let lod0: Uint32Array = src.indices.slice();
  let baseError = 0;
  const baseRatio = policy.baseRatio ?? 1;
  if (baseRatio < 1 && lod0.length >= 3 * 16) {
    const { attrs, stride, weights } = attributeStream(src.normals, src.uvs, vertexCountIn);
    const target = Math.max(3, Math.floor((lod0.length * baseRatio) / 3) * 3);
    const scale = MeshoptSimplifier.getScale(src.positions, 3);
    const relLimit = policy.baseMaxError !== undefined && scale > 0 ? policy.baseMaxError / scale : 1;
    const [out, relErr] = MeshoptSimplifier.simplifyWithAttributes(
      lod0, src.positions, 3, attrs, stride, weights, null, target, relLimit, [],
    );
    if (out.length > 0 && out.length < lod0.length) {
      lod0 = out;
      baseError = relErr * MeshoptSimplifier.getScale(src.positions, 3);
    }
  }

  // 1. Vertex cache order + fetch remap on LOD0 (drops unreferenced vertices).
  const [remap, unique] = MeshoptEncoder.reorderMesh(lod0, true, false);
  const permute = (a: Float32Array | undefined, n: number): Float32Array | undefined => {
    if (!a) return undefined;
    const out = new Float32Array(unique * n);
    for (let v = 0; v < remap.length && v < vertexCountIn; v++) {
      const d = remap[v];
      if (d === 0xffffffff) continue;
      for (let k = 0; k < n; k++) out[d * n + k] = a[v * n + k];
    }
    return out;
  };
  const positions = permute(src.positions, 3)!;
  const normals = permute(src.normals, 3)!;
  const uvs = permute(src.uvs, 2);
  const tangents = permute(src.tangents, 4);

  // 2. LOD chain, always simplified from LOD0 so the reported error is absolute to the original.
  const levels: { indices: Uint32Array; error: number }[] = [{ indices: lod0, error: baseError }];
  if (policy.levels > 1 && lod0.length >= 3 * 64) {
    const scale = MeshoptSimplifier.getScale(positions, 3);
    const { attrs, stride: attrStride, weights } = attributeStream(normals, uvs, unique);
    for (let l = 1; l < policy.levels; l++) {
      const prev = levels[levels.length - 1].indices;
      const target = Math.max(3, Math.floor((lod0.length * Math.pow(policy.ratio, l)) / 3) * 3);
      const [out, relErr] = MeshoptSimplifier.simplifyWithAttributes(
        lod0, positions, 3, attrs, attrStride, weights, null, target, policy.maxError, [],
      );
      // Stop when simplification stalls (hit the error cap) or degenerates.
      if (out.length === 0 || out.length > prev.length * 0.85) break;
      levels.push({ indices: cacheOptimizeInPlaceIds(out), error: Math.max(baseError, relErr * scale) });
    }
  }

  let total = 0;
  for (const l of levels) total += l.indices.length;
  const lodIndices = new Uint32Array(total);
  const lods: OptimizedGeometry['lods'] = [];
  let o = 0;
  for (const l of levels) {
    lodIndices.set(l.indices, o);
    lods.push({ firstIndex: o, indexCount: l.indices.length, error: l.error });
    o += l.indices.length;
  }
  return { positions, normals, uvs, tangents, indices: lod0, vertexCount: unique, lodIndices, lods };
}

/**
 * Vertex-cache-optimise a coarse LOD without renumbering vertices (it must keep
 * indexing LOD0's buffer). reorderMesh also remaps for fetch order, so we undo
 * that remap afterwards.
 */
function cacheOptimizeInPlaceIds(indices: Uint32Array): Uint32Array {
  const work = indices.slice();
  const [remap] = MeshoptEncoder.reorderMesh(work, true, false);
  const inverse = new Uint32Array(remap.length);
  for (let v = 0; v < remap.length; v++) if (remap[v] !== 0xffffffff) inverse[remap[v]] = v;
  for (let i = 0; i < work.length; i++) work[i] = inverse[work[i]];
  return work;
}
