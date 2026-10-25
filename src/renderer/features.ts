import type { ResolvedRendererConfig } from './config';
import type { Defines } from './shaderPreprocessor';

/**
 * Compile-time shader feature set. Each flag maps to a WGSL `#if` define and
 * participates in the pipeline-cache key, so variants never collide.
 * To add a feature: add a flag here, a define in `featureDefines`, guarded
 * code in the WGSL, and (if it needs GPU data) a pass that provides it.
 */
export interface ShaderFeatures {
  readonly shadows: boolean;
}

export function featuresFromConfig(config: ResolvedRendererConfig): ShaderFeatures {
  return { shadows: config.shadows !== null };
}

export function featureDefines(f: ShaderFeatures): Defines {
  return { SHADOWS: f.shadows };
}

/** Stable, compact cache key, e.g. "" (no features) or "SHADOWS". */
export function featureKey(f: ShaderFeatures): string {
  return Object.entries(featureDefines(f)).filter(([, on]) => on).map(([k]) => k).sort().join('+');
}
