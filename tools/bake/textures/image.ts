/**
 * CPU image helpers for the baker: decode (PNG/JPEG via pure-JS decoders),
 * resize, and an sRGB-aware mip-chain builder. No native dependencies.
 */
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';

export interface RgbaImage {
  width: number;
  height: number;
  /** Tightly packed RGBA8, row-major, top row first. */
  data: Uint8Array;
}

export function decodeImage(bytes: Uint8Array, mimeType: string): RgbaImage {
  const isPng = mimeType === 'image/png' || (bytes[0] === 0x89 && bytes[1] === 0x50);
  const isJpeg = mimeType === 'image/jpeg' || (bytes[0] === 0xff && bytes[1] === 0xd8);
  if (isPng) {
    const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    return { width: png.width, height: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength) };
  }
  if (isJpeg) {
    const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 2048 });
    return { width: img.width, height: img.height, data: img.data };
  }
  throw new Error(`unsupported image type "${mimeType}" (baker decodes PNG and JPEG)`);
}

export function hasAlpha(img: RgbaImage): boolean {
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i] !== 255) return true;
  return false;
}

// sRGB <-> linear lookup (8-bit in, float out) and a fine inverse table.
const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const LINEAR_TO_SRGB_STEPS = 4096;
const LINEAR_TO_SRGB = new Uint8Array(LINEAR_TO_SRGB_STEPS + 1);
for (let i = 0; i <= LINEAR_TO_SRGB_STEPS; i++) {
  const l = i / LINEAR_TO_SRGB_STEPS;
  const s = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055;
  LINEAR_TO_SRGB[i] = Math.round(Math.min(1, Math.max(0, s)) * 255);
}
const toSrgb8 = (l: number) => LINEAR_TO_SRGB[Math.round(Math.min(1, Math.max(0, l)) * LINEAR_TO_SRGB_STEPS)];

export type MipMode = 'srgb' | 'linear' | 'normal';

/**
 * Resample to (w, h) with a box/area filter (each destination texel averages
 * the source texels it covers; bilinear-ish when upscaling). Colour channels
 * are averaged in linear light for 'srgb'; normals are renormalised.
 */
export function resize(src: RgbaImage, w: number, h: number, mode: MipMode): RgbaImage {
  if (w === src.width && h === src.height) return src;
  const out = new Uint8Array(w * h * 4);
  const sx = src.width / w, sy = src.height / h;
  const acc = new Float64Array(4);
  for (let y = 0; y < h; y++) {
    const y0 = y * sy, y1 = Math.max(y0 + 1e-6, (y + 1) * sy);
    for (let x = 0; x < w; x++) {
      const x0 = x * sx, x1 = Math.max(x0 + 1e-6, (x + 1) * sx);
      acc.fill(0);
      let wsum = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
        const wy = Math.min(yy + 1, y1) - Math.max(yy, y0);
        if (wy <= 0) continue;
        const row = Math.min(yy, src.height - 1) * src.width;
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
          const wx = Math.min(xx + 1, x1) - Math.max(xx, x0);
          if (wx <= 0) continue;
          const wgt = wx * wy;
          const i = (row + Math.min(xx, src.width - 1)) * 4;
          if (mode === 'srgb') {
            acc[0] += SRGB_TO_LINEAR[src.data[i]] * wgt;
            acc[1] += SRGB_TO_LINEAR[src.data[i + 1]] * wgt;
            acc[2] += SRGB_TO_LINEAR[src.data[i + 2]] * wgt;
          } else {
            acc[0] += src.data[i] * wgt;
            acc[1] += src.data[i + 1] * wgt;
            acc[2] += src.data[i + 2] * wgt;
          }
          acc[3] += src.data[i + 3] * wgt;
          wsum += wgt;
        }
      }
      const o = (y * w + x) * 4;
      const inv = 1 / wsum;
      if (mode === 'srgb') {
        out[o] = toSrgb8(acc[0] * inv);
        out[o + 1] = toSrgb8(acc[1] * inv);
        out[o + 2] = toSrgb8(acc[2] * inv);
      } else if (mode === 'normal') {
        let nx = (acc[0] * inv) / 127.5 - 1, ny = (acc[1] * inv) / 127.5 - 1, nz = (acc[2] * inv) / 127.5 - 1;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len; ny /= len; nz /= len;
        out[o] = Math.round((nx + 1) * 127.5);
        out[o + 1] = Math.round((ny + 1) * 127.5);
        out[o + 2] = Math.round((nz + 1) * 127.5);
      } else {
        out[o] = Math.round(acc[0] * inv);
        out[o + 1] = Math.round(acc[1] * inv);
        out[o + 2] = Math.round(acc[2] * inv);
      }
      out[o + 3] = Math.round(acc[3] * inv);
    }
  }
  return { width: w, height: h, data: out };
}

/** Full mip chain down to 1x1 (level 0 = input). Each level halves (floor, min 1). */
export function buildMipChain(base: RgbaImage, mode: MipMode): RgbaImage[] {
  const levels = [base];
  let cur = base;
  while (cur.width > 1 || cur.height > 1) {
    cur = resize(cur, Math.max(1, cur.width >> 1), Math.max(1, cur.height >> 1), mode);
    levels.push(cur);
  }
  return levels;
}

/** Fit inside maxSize (keeping aspect) and optionally round each side up to a multiple of `multiple`. */
export function targetSize(w: number, h: number, maxSize: number, multiple: number | [number, number]): [number, number] {
  const [mx, my] = typeof multiple === 'number' ? [multiple, multiple] : multiple;
  const s = Math.min(1, maxSize / Math.max(w, h));
  let tw = Math.max(1, Math.round(w * s)), th = Math.max(1, Math.round(h * s));
  // Block formats need level 0 in whole blocks: round to the nearest multiple,
  // never above maxSize (unless maxSize is smaller than one block).
  const fit = (v: number, m: number) => {
    if (m <= 1) return v;
    const cap = Math.max(m, Math.floor(maxSize / m) * m);
    return Math.min(cap, Math.max(m, Math.round(v / m) * m));
  };
  tw = fit(tw, mx);
  th = fit(th, my);
  return [tw, th];
}
