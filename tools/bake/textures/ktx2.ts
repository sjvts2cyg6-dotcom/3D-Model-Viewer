/**
 * KTX2 / Basis Universal encoding via the Basis encoder compiled to WASM
 * (bundled in the `ktx2-encoder` package; no native binaries). We drive the
 * BasisEncoder object directly so we control mip filtering per texture usage:
 *
 *   color  (base colour, emissive): ETC1S (default) or UASTC, sRGB transfer fn,
 *          perceptual metrics, mips filtered in linear light.
 *   normal: UASTC, normal-map preset, linear, renormalised mips.
 *   data   (metallic-roughness / occlusion): UASTC, linear, linear mips.
 *
 * Used (a) as the offline intermediate for native BC7/ETC2 (textures/native.ts)
 * and (b) for the opt-in `universal` texture mode, the only mode transcoded at
 * load. Zstd supercompression is off unless explicitly requested (`--zstd`).
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { RgbaImage } from './image';

/* eslint-disable @typescript-eslint/no-explicit-any */
type BasisModule = any;

let modulePromise: Promise<BasisModule> | null = null;

async function basis(): Promise<BasisModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      // The package's export map hides the raw wasm wrapper; resolve it next to the node entry.
      const entry = fileURLToPath(import.meta.resolve('ktx2-encoder'));
      const wrapper = path.join(path.dirname(entry), '..', 'basis', 'basis_encoder.js');
      const mod = (await import(pathToUrl(wrapper))) as { default: (opts?: object) => Promise<BasisModule> };
      const m = await mod.default({ print: () => {}, printErr: () => {} });
      m.initializeBasis();
      return m;
    })();
  }
  return modulePromise;
}

function pathToUrl(p: string): string {
  return new URL(`file://${p}`).href;
}

export type Ktx2Codec = 'etc1s' | 'uastc';
export type TextureUsage = 'color' | 'normal' | 'data';

export interface Ktx2Options {
  codec: Ktx2Codec;
  usage: TextureUsage;
  /** ETC1S quality 1..255. */
  etc1sQuality: number;
  /** UASTC effort/pack level 0..4. */
  uastcLevel: number;
  /** Enable UASTC RDO (smaller after Zstd, slightly lower quality). */
  uastcRdo: boolean;
  /** Zstd supercompression of UASTC (needs decompression at load; opt-in only). */
  zstd: boolean;
}

/** Encode one image (dimensions must be multiples of 4) into a KTX2 file with a full mip chain. */
export async function encodeKtx2(img: RgbaImage, opts: Ktx2Options): Promise<Uint8Array> {
  if (img.width % 4 || img.height % 4) throw new Error(`KTX2 input must be a multiple of 4 (got ${img.width}x${img.height})`);
  const m = await basis();
  const enc = new m.BasisEncoder();
  try {
    enc.setDebug(false);
    enc.setStatusOutput?.(false);
    enc.setPrintStats?.(false);
    enc.setCreateKTX2File(true);
    enc.setTexType(0 /* cBASISTexType2D */);
    enc.setSliceSourceImage(0, img.data, img.width, img.height, 0 /* raw RGBA */);

    const srgb = opts.usage === 'color';
    enc.setUASTC(opts.codec === 'uastc');
    if (opts.usage === 'normal') enc.setNormalMapPreset();
    enc.setPerceptual(srgb);
    enc.setKTX2AndBasisSRGBTransferFunc(srgb);
    enc.setMipGen(true);
    enc.setMipSRGB(srgb);
    enc.setMipRenormalize(opts.usage === 'normal');
    enc.setMipSmallestDimension(1);
    if (opts.codec === 'uastc') {
      enc.setKTX2UASTCSupercompression(opts.zstd);
      enc.setPackUASTCFlags(opts.uastcLevel);
      if (opts.uastcRdo && opts.usage !== 'normal') enc.setRDOUASTC(true);
    } else {
      enc.setQualityLevel(opts.etc1sQuality);
      enc.setETC1SCompressionLevel(2);
    }

    let capacity = Math.ceil(img.width * img.height * 4 * 1.4) + 65536;
    for (let attempt = 0; attempt < 2; attempt++, capacity *= 2) {
      const out = new Uint8Array(capacity);
      const n = enc.encode(out);
      if (n > 0) return out.slice(0, n);
    }
    throw new Error('Basis encoder failed');
  } finally {
    enc.delete();
  }
}
