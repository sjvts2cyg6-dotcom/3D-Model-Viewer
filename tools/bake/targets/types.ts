/**
 * Target profiles. Each engine/platform gets one profile that turns a cleaned
 * glTF-Transform Document into that engine's native container. Profiles share
 * the generic steps in ../prepare.ts and ../geometry.ts but own every
 * platform decision: vertex layout, index width, LOD policy, texture codecs,
 * and the output format itself.
 *
 * Adding a target = implement TargetProfile and register it in ./index.ts.
 */
import type { Document } from '@gltf-transform/core';

/** `auto` lets the profile pick per texture usage (webgpu: UASTC for normal/data, ETC1S for colour). */
export type TextureFormatOption = 'auto' | 'uastc' | 'etc1s' | 'rgba8';

export interface BakeOptions {
  /** Total LOD levels including full detail (1 = no LODs). */
  lods: number;
  /** Target index-count ratio between successive LODs. */
  lodRatio: number;
  /** Stop generating LODs once the relative simplification error exceeds this (fraction of mesh extent). */
  lodMaxError: number;
  textureFormat: TextureFormatOption;
  /** Clamp the largest texture side (power-of-two not required). */
  maxTextureSize: number;
  etc1sQuality: number;
  uastcLevel: number;
  uastcRdo: boolean;
  /** Regenerate tangents even when the source provides them. */
  recomputeTangents: boolean;
  /**
   * Full-detail triangle budget for the whole scene as drawn (instances counted);
   * 0 = unlimited. Over budget, every primitive's LOD0 is simplified by the same ratio.
   */
  maxTriangles: number;
}

export interface BakeContext {
  options: BakeOptions;
  /** Summary of the device profile the options were derived from (embedded in the output's stats). */
  device?: Record<string, unknown>;
  log(msg: string): void;
  warn(msg: string): void;
}

export interface BakeOutput {
  bytes: Uint8Array;
  /** Human-oriented numbers printed by the CLI and embedded in the manifest. */
  stats: Record<string, unknown>;
}

export interface TargetProfile {
  readonly id: string;
  readonly description: string;
  /** Output file extension including the dot. */
  readonly fileExtension: string;
  readonly textureFormats: readonly TextureFormatOption[];
  /** Option defaults for this target (CLI flags override). */
  readonly defaults: Partial<BakeOptions>;
  bake(doc: Document, ctx: BakeContext): Promise<BakeOutput>;
}
