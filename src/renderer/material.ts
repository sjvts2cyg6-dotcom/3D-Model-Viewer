export type AlphaMode = 'OPAQUE' | 'MASK' | 'BLEND';

/** Engine-level material description (format-agnostic, GPU resources resolved). */
export interface MaterialDesc {
  name?: string;
  baseColorFactor: [number, number, number, number];
  metallicFactor: number;
  roughnessFactor: number;
  emissiveFactor: [number, number, number];
  normalScale: number;
  occlusionStrength: number;
  alphaMode: AlphaMode;
  alphaCutoff: number;
  doubleSided: boolean;
  baseColorTexture?: GPUTexture;        // rgba8unorm-srgb
  metallicRoughnessTexture?: GPUTexture; // linear, G = roughness, B = metallic
  normalTexture?: GPUTexture;            // linear
  occlusionTexture?: GPUTexture;         // linear, R
  emissiveTexture?: GPUTexture;          // srgb
  sampler?: GPUSampler;
}

export interface GpuMaterial {
  readonly id: number;
  readonly name: string;
  readonly bindGroup: GPUBindGroup;
  readonly uniformBuffer: GPUBuffer;
  readonly alphaMode: AlphaMode;
  readonly doubleSided: boolean;
  /** Pipeline variant key, used to sort/batch draws. */
  readonly pipelineKey: string;
  /** Numeric draw-sort key: [blend pass | pipeline variant | material id]. */
  readonly sortKey: number;
}

export function materialSortKey(alphaMode: AlphaMode, doubleSided: boolean, id: number): number {
  const pass = alphaMode === 'BLEND' ? 1 : 0;
  const variant = (alphaMode === 'OPAQUE' ? 0 : alphaMode === 'MASK' ? 1 : 2) * 2 + (doubleSided ? 1 : 0);
  return pass * 2 ** 28 + variant * 2 ** 24 + (id & 0xffffff);
}

export const MATERIAL_UNIFORM_SIZE = 64;

export function defaultMaterialDesc(): MaterialDesc {
  return {
    baseColorFactor: [1, 1, 1, 1],
    metallicFactor: 1,
    roughnessFactor: 1,
    emissiveFactor: [0, 0, 0],
    normalScale: 1,
    occlusionStrength: 1,
    alphaMode: 'OPAQUE',
    alphaCutoff: 0.5,
    doubleSided: false,
  };
}

export function packMaterialUniforms(d: MaterialDesc): Float32Array<ArrayBuffer> {
  const u = new Float32Array(MATERIAL_UNIFORM_SIZE / 4);
  u.set(d.baseColorFactor, 0);
  u.set(d.emissiveFactor, 4);
  u.set([d.metallicFactor, d.roughnessFactor, d.normalScale, d.occlusionStrength], 8);
  u.set([d.alphaCutoff, d.alphaMode === 'MASK' ? 1 : 0, 0, 0], 12);
  return u;
}
