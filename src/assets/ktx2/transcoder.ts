/**
 * Runtime KTX2 (Basis Universal ETC1S / UASTC) transcoding.
 *
 * The Basis transcoder (public/basis/, Apache-2.0, ~1 MB wasm) is loaded
 * lazily on the first KTX2 texture, so glTF-only or rgba8-baked scenes never
 * download it. Each texture is transcoded to the best block format the device
 * supports, then uploaded level by level:
 *
 *   texture-compression-bc    -> BC7          (desktop)
 *   texture-compression-astc  -> ASTC 4x4     (most phones, Apple silicon)
 *   texture-compression-etc2  -> ETC2 RGBA8 / ETC1-as-ETC2 RGB8 (older mobile)
 *   none                      -> RGBA8 (uncompressed fallback)
 *
 * Transcoding currently runs on the main thread (see README roadmap: worker).
 */

export type TranscodeTarget = 'bc7' | 'astc' | 'etc2' | 'rgba8';

/* Minimal typings for the Emscripten module (basis_universal webgl/transcoder). */
interface BasisEnumValue { value: number }
interface KTX2File {
  isValid(): boolean;
  getWidth(): number;
  getHeight(): number;
  getLevels(): number;
  getHasAlpha(): boolean;
  isUASTC(): boolean;
  isETC1S(): boolean;
  startTranscoding(): boolean;
  getImageLevelInfo(level: number, layer: number, face: number): { origWidth: number; origHeight: number; width: number; height: number };
  getImageTranscodedSizeInBytes(level: number, layer: number, face: number, format: number): number;
  transcodeImage(dst: Uint8Array, level: number, layer: number, face: number, format: number, getAlphaForOpaque: number, channel0: number, channel1: number): number;
  close(): void;
  delete(): void;
}
interface BasisModule {
  initializeBasis(): void;
  KTX2File: new (data: Uint8Array) => KTX2File;
  transcoder_texture_format: Record<string, BasisEnumValue>;
}
type BasisFactory = (opts: { wasmBinary: ArrayBuffer }) => Promise<BasisModule>;

declare global {
  interface Window { BASIS?: BasisFactory }
}

let modulePromise: Promise<BasisModule> | null = null;

/** Base URL of the vendored transcoder (respects Vite's `base`). */
export const BASIS_TRANSCODER_PATH = `${import.meta.env.BASE_URL}basis/`;

export function loadBasisTranscoder(path = BASIS_TRANSCODER_PATH): Promise<BasisModule> {
  modulePromise ??= (async () => {
    const wasm = fetch(`${path}basis_transcoder.wasm`).then((r) => {
      if (!r.ok) throw new Error(`KTX2: failed to fetch basis_transcoder.wasm (${r.status})`);
      return r.arrayBuffer();
    });
    if (!window.BASIS) {
      await new Promise<void>((resolve, reject) => {
        const s = document.createElement('script');
        s.src = `${path}basis_transcoder.js`;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error(`KTX2: failed to load ${s.src}`));
        document.head.appendChild(s);
      });
    }
    if (!window.BASIS) throw new Error('KTX2: basis_transcoder.js did not define BASIS');
    const m = await window.BASIS({ wasmBinary: await wasm });
    m.initializeBasis();
    return m;
  })();
  modulePromise.catch(() => { modulePromise = null; });
  return modulePromise;
}

/** Best transcode target for a device, in preference order. */
export function pickTranscodeTarget(device: GPUDevice): TranscodeTarget {
  if (device.features.has('texture-compression-bc')) return 'bc7';
  if (device.features.has('texture-compression-astc')) return 'astc';
  if (device.features.has('texture-compression-etc2')) return 'etc2';
  return 'rgba8';
}

/** Features to request at device creation so compressed targets are available. */
export const TEXTURE_COMPRESSION_FEATURES: GPUFeatureName[] = [
  'texture-compression-bc', 'texture-compression-astc', 'texture-compression-etc2',
];

export interface TranscodedTexture {
  format: GPUTextureFormat;
  target: TranscodeTarget;
  levels: { data: Uint8Array; width: number; height: number }[];
}

/**
 * Transcode a KTX2 file to `target` (falls back to rgba8 if the device lacks
 * the feature). Returns every mip level ready for createTextureFromLevels.
 */
export async function transcodeKtx2(
  device: GPUDevice, ktx2: Uint8Array, srgb: boolean, target: TranscodeTarget = pickTranscodeTarget(device),
): Promise<TranscodedTexture> {
  const basis = await loadBasisTranscoder();
  const supported = target === 'rgba8' ||
    device.features.has(target === 'bc7' ? 'texture-compression-bc' : target === 'astc' ? 'texture-compression-astc' : 'texture-compression-etc2');
  if (!supported) target = 'rgba8';

  const file = new basis.KTX2File(ktx2);
  try {
    if (!file.isValid()) throw new Error('KTX2: invalid or unsupported file');
    if (!file.startTranscoding()) throw new Error('KTX2: startTranscoding failed');
    const hasAlpha = file.getHasAlpha();
    const F = basis.transcoder_texture_format;
    let fmt: number, format: GPUTextureFormat;
    switch (target) {
      case 'bc7': fmt = F.cTFBC7_RGBA.value; format = srgb ? 'bc7-rgba-unorm-srgb' : 'bc7-rgba-unorm'; break;
      case 'astc': fmt = F.cTFASTC_4x4_RGBA.value; format = srgb ? 'astc-4x4-unorm-srgb' : 'astc-4x4-unorm'; break;
      case 'etc2':
        if (hasAlpha) { fmt = F.cTFETC2_RGBA.value; format = srgb ? 'etc2-rgba8unorm-srgb' : 'etc2-rgba8unorm'; }
        else { fmt = F.cTFETC1_RGB.value; format = srgb ? 'etc2-rgb8unorm-srgb' : 'etc2-rgb8unorm'; }
        break;
      default: fmt = F.cTFRGBA32.value; format = srgb ? 'rgba8unorm-srgb' : 'rgba8unorm';
    }
    const levels: TranscodedTexture['levels'] = [];
    for (let level = 0; level < file.getLevels(); level++) {
      const info = file.getImageLevelInfo(level, 0, 0);
      const size = file.getImageTranscodedSizeInBytes(level, 0, 0, fmt);
      const data = new Uint8Array(size);
      if (!file.transcodeImage(data, level, 0, 0, fmt, 0, -1, -1)) throw new Error(`KTX2: transcode failed at level ${level}`);
      levels.push({ data, width: info.origWidth, height: info.origHeight });
    }
    return { format, target, levels };
  } finally {
    file.close();
    file.delete();
  }
}
