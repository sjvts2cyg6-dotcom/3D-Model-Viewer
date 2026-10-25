/**
 * Offline encoding to GPU-native block formats. The engine uploads the
 * resulting levels with writeTexture as-is: no transcoding, no decompression.
 *
 *   bc7   UASTC (Basis encoder, no supercompression) -> BC7 via the Basis
 *         transcoder run here, in the baker (UASTC->BC7 is near-lossless).
 *   etc2  same UASTC -> ETC2 RGBA8 (alpha) or ETC1-as-ETC2 RGB8 (opaque).
 *   astc  ARM astcenc (WASM) on our own sRGB-aware mip chain; any LDR block size.
 *   rgba8 raw mip chain (see image.ts).
 */
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASTCConfig, ASTCConfigFlags, ASTCContext, ASTCImage, ASTCProfile, ASTCQualityPreset, ASTCSwizzle, ASTCType } from 'astc-encoder.js';
import { textureLevelBytes } from '../../../src/assets/wgm/format';
import { buildMipChain, type MipMode, type RgbaImage } from './image';
import { encodeKtx2, type TextureUsage } from './ktx2';

export type NativeFormat = 'bc7' | 'astc' | 'etc2' | 'rgba8';
export const NATIVE_FORMATS: readonly NativeFormat[] = ['bc7', 'astc', 'etc2', 'rgba8'];
export type AstcBlock = '4x4' | '5x5' | '6x6' | '8x8';
export const ASTC_BLOCKS: readonly AstcBlock[] = ['4x4', '5x5', '6x6', '8x8'];

export interface NativeLevel { data: Uint8Array; width: number; height: number }
export interface NativeTexture { format: string; levels: NativeLevel[] }

export interface NativeOptions {
  usage: TextureUsage;
  srgb: boolean;
  hasAlpha: boolean;
  astcBlock: AstcBlock;
  /** UASTC pack level 0..4 for the intermediate used by bc7/etc2. */
  uastcLevel: number;
  /** astcenc effort preset. */
  astcQuality: 'fast' | 'medium' | 'thorough';
}

/** Level-0 size multiple a format needs (WebGPU: compressed textures are whole blocks at level 0). */
export function blockMultiple(format: NativeFormat, astcBlock: AstcBlock): [number, number] {
  if (format === 'rgba8') return [1, 1];
  if (format === 'astc') { const [w, h] = astcBlock.split('x').map(Number); return [w, h]; }
  return [4, 4];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let basisTranscoder: Promise<any> | null = null;
function transcoder(): Promise<any> {
  basisTranscoder ??= (async () => {
    // The same vendored Basis transcoder the engine can load for opt-in universal files.
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../public/basis');
    const BASIS = createRequire(import.meta.url)(path.join(dir, 'basis_transcoder.js'));
    const m = await BASIS({ wasmBinary: await readFile(path.join(dir, 'basis_transcoder.wasm')), print: () => {}, printErr: () => {} });
    m.initializeBasis();
    return m;
  })();
  return basisTranscoder;
}

export async function encodeNative(img: RgbaImage, format: NativeFormat, mode: MipMode, o: NativeOptions): Promise<NativeTexture> {
  const suffix = o.srgb ? '-srgb' : '';
  if (format === 'rgba8') {
    return { format: `rgba8unorm${suffix}`, levels: buildMipChain(img, mode).map((l) => ({ data: l.data, width: l.width, height: l.height })) };
  }
  if (format === 'astc') return encodeAstc(img, mode, o);

  // bc7 / etc2: UASTC intermediate (no Zstd, no RDO), transcoded offline.
  const ktx2 = await encodeKtx2(img, { codec: 'uastc', usage: o.usage, etc1sQuality: 128, uastcLevel: o.uastcLevel, uastcRdo: false, zstd: false });
  const basis = await transcoder();
  const F = basis.transcoder_texture_format;
  let fmt: number, gpuFormat: string;
  if (format === 'bc7') { fmt = F.cTFBC7_RGBA.value; gpuFormat = `bc7-rgba-unorm${suffix}`; }
  else if (o.hasAlpha) { fmt = F.cTFETC2_RGBA.value; gpuFormat = `etc2-rgba8unorm${suffix}`; }
  else { fmt = F.cTFETC1_RGB.value; gpuFormat = `etc2-rgb8unorm${suffix}`; }
  const file = new basis.KTX2File(ktx2);
  try {
    if (!file.isValid() || !file.startTranscoding()) throw new Error('UASTC intermediate is not transcodable');
    const levels: NativeLevel[] = [];
    for (let level = 0; level < file.getLevels(); level++) {
      const info = file.getImageLevelInfo(level, 0, 0);
      const data = new Uint8Array(file.getImageTranscodedSizeInBytes(level, 0, 0, fmt));
      if (!file.transcodeImage(data, level, 0, 0, fmt, 0, -1, -1)) throw new Error(`UASTC -> ${format} failed at level ${level}`);
      const want = textureLevelBytes(gpuFormat, info.origWidth, info.origHeight);
      if (data.byteLength !== want) throw new Error(`${gpuFormat} level ${level}: ${data.byteLength} B, expected ${want} B`);
      levels.push({ data, width: info.origWidth, height: info.origHeight });
    }
    return { format: gpuFormat, levels };
  } finally {
    file.close();
    file.delete();
  }
}

async function encodeAstc(img: RgbaImage, mode: MipMode, o: NativeOptions): Promise<NativeTexture> {
  const [bx, by] = o.astcBlock.split('x').map(Number);
  const quality = o.astcQuality === 'fast' ? ASTCQualityPreset.FAST : o.astcQuality === 'thorough' ? ASTCQualityPreset.THOROUGH : ASTCQualityPreset.MEDIUM;
  let flags = 0;
  if (o.usage === 'color') flags |= ASTCConfigFlags.USE_PERCEPTUAL;
  if (o.hasAlpha) flags |= ASTCConfigFlags.USE_APLHA_WEIGHT;
  const config = new ASTCConfig(o.srgb ? ASTCProfile.LDR_SRGB : ASTCProfile.LDR, bx, by, 1, quality, flags);
  if (o.usage === 'normal') { config.cwRWeight = 1; config.cwGWeight = 1; config.cwBWeight = 1; config.cwAWeight = 0; }
  const ctx = new ASTCContext(config);
  const levels: NativeLevel[] = [];
  for (const l of buildMipChain(img, mode)) {
    const data = await ctx.compress(new ASTCImage(ASTCType.U8, l.width, l.height, 1, l.data), new ASTCSwizzle());
    const format = `astc-${o.astcBlock}-unorm${o.srgb ? '-srgb' : ''}`;
    const want = textureLevelBytes(format, l.width, l.height);
    if (data.byteLength !== want) throw new Error(`${format} ${l.width}x${l.height}: ${data.byteLength} B, expected ${want} B`);
    levels.push({ data, width: l.width, height: l.height });
  }
  return { format: `astc-${o.astcBlock}-unorm${o.srgb ? '-srgb' : ''}`, levels };
}
