import type { TargetProfile } from './types';
import { webgpuTarget } from './webgpu';

/**
 * Registered target profiles. Future engines (e.g. a native mobile engine
 * wanting interleaved snorm16 vertices + ASTC-only textures) add an entry here.
 */
export const TARGETS: Record<string, TargetProfile> = {
  [webgpuTarget.id]: webgpuTarget,
};

export type { BakeContext, BakeOptions, BakeOutput, TargetProfile, TextureFormatOption } from './types';
