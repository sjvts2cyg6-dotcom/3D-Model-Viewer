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

/**
 * Texture output. Native formats are uploaded by the engine as-is (no CPU work):
 *   auto       pick from the device profile (bc7 > astc > etc2 > rgba8; mobile prefers astc);
 *              without a profile: bc7 (desktop assumption)
 *   bc7 | astc | etc2 | rgba8   force one native format
 *   each       one output file per native format (name.bc7.wgm, name.astc.wgm, ...),
 *              for when the target's formats are unknown
 *   universal  KTX2/Basis, transcoded AT LOAD by the engine (the only such mode);
 *              `uastc` / `etc1s` are aliases of universal with that codec
 */
export type TextureFormatOption = 'auto' | 'bc7' | 'astc' | 'etc2' | 'rgba8' | 'each' | 'universal' | 'uastc' | 'etc1s';

export type { VertexPrecision, NormalEncoding, VertexTolerance } from '../quantize';
import type { VertexPrecision, NormalEncoding, VertexTolerance } from '../quantize';
import type { AstcBlock } from '../textures/native';

export interface BakeOptions {
  /** Total LOD levels including full detail (1 = no LODs). */
  lods: number;
  /** Target index-count ratio between successive LODs. */
  lodRatio: number;
  /** Stop generating LODs once the relative simplification error exceeds this (fraction of mesh extent). */
  lodMaxError: number;
  textureFormat: TextureFormatOption;
  /** ASTC block footprint (bigger = fewer bits per texel, lower quality). */
  astcBlock: AstcBlock;
  /** astcenc effort. */
  astcQuality: 'fast' | 'medium' | 'thorough';
  /** Clamp the largest texture side (power-of-two not required). */
  maxTextureSize: number;
  /** universal mode only */
  etc1sQuality: number;
  /** UASTC pack level (BC7/ETC2 intermediate and universal mode). */
  uastcLevel: number;
  /** universal mode only (smaller with Zstd, lower quality). */
  uastcRdo: boolean;
  /** universal mode only: Zstd-supercompress UASTC (decompressed at load). Off by default. */
  zstd: boolean;
  /** Regenerate tangents even when the source provides them. */
  recomputeTangents: boolean;
  /**
   * LOD0 triangle budget for the scene's UNIQUE geometry: each mesh counted once, however many
   * nodes instance it, and identical primitives (same positions + indices) once. 0 = unlimited. Over budget, every primitive's LOD0 is simplified by the
   * same ratio, but never past the position pixel tolerance (`vertexTolerance.pixelError` at
   * `screenPixels` with the mesh filling the screen): detail the device can display is kept.
   */
  maxTriangles: number;
  /**
   * Estimate of the triangles the device can draw per frame for the whole scene (instances
   * counted). 0 = unlimited. Never changes LOD0; when the scene as drawn at LOD0 exceeds it,
   * the LOD chain gets more levels so runtime LOD selection can bring distant copies under it.
   */
  maxDrawnTriangles: number;
  /** full = float32 streams; auto = smallest GPU format within `vertexTolerance`; low = smallest formats. */
  vertexPrecision: VertexPrecision;
  /** auto = snorm8/16 xyz normals & tangents; oct = octahedral snorm16x2 (decoded in the vertex shader). */
  normalEncoding: NormalEncoding;
  vertexTolerance: VertexTolerance;
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
