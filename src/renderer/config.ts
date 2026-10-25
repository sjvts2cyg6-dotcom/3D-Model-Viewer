/**
 * Renderer configuration. The resolved config is the single source of truth
 * for (a) which passes get registered and (b) which shader features are
 * compiled in. Disabled features cost nothing: no pass, no bindings, no
 * uniforms, no shader code.
 */

export interface ShadowConfig {
  /** Shadow map resolution (square). */
  mapSize: number;
  /** Constant depth bias applied when sampling. */
  depthBias: number;
  /** Normal-offset bias in world units, scaled by texel size. */
  normalBias: number;
}

export interface RendererConfig {
  /** MSAA sample count (WebGPU guarantees 4x for renderable formats). */
  msaa?: 1 | 4;
  /**
   * Directional-light shadow mapping. Reserved for a future ShadowPass; see
   * renderer/passes/shadowPass.ts. Currently ignored (with a warning) if set.
   */
  shadows?: boolean | Partial<ShadowConfig>;
  clearColor?: GPUColor;
  exposure?: number;
  maxAnisotropy?: number;
}

export interface ResolvedRendererConfig {
  readonly msaa: 1 | 4;
  /** `null` = shadows disabled (default). */
  readonly shadows: Readonly<ShadowConfig> | null;
  readonly clearColor: GPUColor;
  readonly exposure: number;
  readonly maxAnisotropy: number;
}

export const DEFAULT_SHADOW_CONFIG: Readonly<ShadowConfig> = { mapSize: 2048, depthBias: 0.002, normalBias: 1.5 };

/** Flip to true once ShadowPass exists (and register it in Renderer.createPasses). */
const SHADOW_PASS_IMPLEMENTED = false;

export function resolveRendererConfig(c: RendererConfig = {}): ResolvedRendererConfig {
  let shadows: ShadowConfig | null = null;
  if (c.shadows) {
    if (SHADOW_PASS_IMPLEMENTED) {
      shadows = { ...DEFAULT_SHADOW_CONFIG, ...(typeof c.shadows === 'object' ? c.shadows : {}) };
    } else {
      console.warn('[renderer] shadows requested but ShadowPass is not implemented yet; rendering without shadows.');
    }
  }
  return {
    msaa: c.msaa ?? 4,
    shadows,
    clearColor: c.clearColor ?? { r: 0.06, g: 0.06, b: 0.08, a: 1 },
    exposure: c.exposure ?? 1,
    maxAnisotropy: c.maxAnisotropy ?? 8,
  };
}
