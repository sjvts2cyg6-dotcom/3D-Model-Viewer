/**
 * GPU-native vertex quantization (no CPU decode at load, no shader-side
 * decompression beyond what vertex fetch does for normalized formats):
 *
 *   position  unorm16x4  q in [0,1] per axis, local = q * scale + offset (per-mesh grid)
 *   normal    snorm8x4 | snorm16x4 | oct snorm16x2 (octahedral, decoded in the VS)
 *   tangent   snorm8x4 | snorm16x4 | oct snorm16x2 (bitangent sign folded into y)
 *   uv        unorm16x2 (UVs inside [0,1]) | float16x2 | float32x2
 *
 * Every candidate is actually encoded, decoded the way the GPU will, and its
 * worst-case error measured; the smallest format within tolerance wins.
 */
import type { WgmNormalFormat, WgmTangentFormat, WgmUvFormat } from '../../src/assets/wgm/format';

export type VertexPrecision = 'full' | 'auto' | 'low';
export type NormalEncoding = 'auto' | 'oct';

export interface VertexTolerance {
  /** Max position error in screen pixels when the mesh fills `screenPixels` (its bounding diagonal). */
  pixelError: number;
  /** Longest physical screen side the error is measured against. */
  screenPixels: number;
  /** Max angular error of normals / tangents, degrees. */
  normalDegrees: number;
  /** Max UV error in texels of the largest texture the primitive samples. */
  uvTexels: number;
}

export const DEFAULT_TOLERANCE: VertexTolerance = { pixelError: 0.5, screenPixels: 3840, normalDegrees: 0.5, uvTexels: 0.25 };

// ------------------------------------------------------------------ scalar codecs (match WebGPU conversion rules)

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** float -> snorm (round to nearest); decode = max(q / max, -1). */
export const toSnorm = (v: number, bits: 8 | 16) => { const m = bits === 8 ? 127 : 32767; return Math.round(clamp(v, -1, 1) * m); };
export const fromSnorm = (q: number, bits: 8 | 16) => Math.max(q / (bits === 8 ? 127 : 32767), -1);
export const toUnorm16 = (v: number) => Math.round(clamp(v, 0, 1) * 65535);

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
/** IEEE half from float (round to nearest even); Node 20 has no Float16Array. */
export function toHalf(v: number): number {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  let e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    let h = mant >> shift;
    const rem = mant & ((1 << shift) - 1), half = 1 << (shift - 1);
    if (rem > half || (rem === half && (h & 1))) h++;
    return sign | h;
  }
  let h = (e << 10) | (mant >> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && (h & 1))) h++;
  return sign | h;
}
export function fromHalf(h: number): number {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return s * m * 2 ** -24;
  if (e === 0x1f) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

// ------------------------------------------------------------------ octahedral

/** Unit vector -> octahedral [-1,1]^2. */
export function octEncode(x: number, y: number, z: number): [number, number] {
  const l1 = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
  let u = x / l1, v = y / l1;
  if (z < 0) {
    const ou = u;
    u = (1 - Math.abs(v)) * (ou >= 0 ? 1 : -1);
    v = (1 - Math.abs(ou)) * (v >= 0 ? 1 : -1);
  }
  return [u, v];
}
/** Same as the WGSL octDecode in pbr.wgsl. */
export function octDecode(u: number, v: number): [number, number, number] {
  let x = u, y = v;
  const z = 1 - Math.abs(u) - Math.abs(v);
  const t = Math.max(-z, 0);
  x += x >= 0 ? -t : t;
  y += y >= 0 ? -t : t;
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}
const OCT_EPS = 1 / 32767;
/** Fold the bitangent sign into the oct y component: |y'| in [eps, 1], sign(y') = w. */
export const packOctSign = (v: number, w: number) => (w < 0 ? -1 : 1) * (OCT_EPS + (v * 0.5 + 0.5) * (1 - OCT_EPS));
export const unpackOctSign = (y: number): [number, number] => [((Math.abs(y) - OCT_EPS) / (1 - OCT_EPS)) * 2 - 1, y < 0 ? -1 : 1];

/** Best snorm16 oct quantization: try the 4 neighbouring grid points, keep the most accurate. */
function octQuant16(x: number, y: number, z: number): [number, number] {
  const [u, v] = octEncode(x, y, z);
  let best: [number, number] = [toSnorm(u, 16), toSnorm(v, 16)], bestDot = -2;
  const fu = Math.floor(u * 32767), fv = Math.floor(v * 32767);
  for (const qu of [fu, fu + 1]) for (const qv of [fv, fv + 1]) {
    if (Math.abs(qu) > 32767 || Math.abs(qv) > 32767) continue;
    const d = octDecode(fromSnorm(qu, 16), fromSnorm(qv, 16));
    const dot = d[0] * x + d[1] * y + d[2] * z;
    if (dot > bestDot) { bestDot = dot; best = [qu, qv]; }
  }
  return best;
}

// ------------------------------------------------------------------ streams

export interface EncodedStream<F extends string> { format: F; encoding?: 'oct'; data: ArrayBufferView; maxError: number }

/**
 * Angle between source and decoded direction. A degenerate (zero-length) source has no direction,
 * and the float32 path normalizes it to NaN in the shader just the same, so it does not count.
 */
const angleDeg = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
  const la = Math.hypot(ax, ay, az), lb = Math.hypot(bx, by, bz) || 1;
  if (!(la > 1e-6)) return 0;
  return (Math.acos(clamp((ax * bx + ay * by + az * bz) / (la * lb), -1, 1)) * 180) / Math.PI;
};

/** Positions -> unorm16x4 on the grid [min, max] (per mesh). Error in mesh units (vector length). */
export function quantizePositions(p: Float32Array, min: number[], max: number[]): Omit<EncodedStream<'unorm16x4'>, 'data'> & { data: Uint16Array; scale: [number, number, number]; offset: [number, number, number] } {
  const n = p.length / 3;
  const scale = [0, 1, 2].map((k) => max[k] - min[k]) as [number, number, number];
  const offset = [min[0], min[1], min[2]] as [number, number, number];
  const out = new Uint16Array(n * 4);
  let maxErr = 0;
  for (let i = 0; i < n; i++) {
    let e2 = 0;
    for (let k = 0; k < 3; k++) {
      const v = p[i * 3 + k];
      const q = scale[k] > 0 ? toUnorm16((v - offset[k]) / scale[k]) : 0;
      out[i * 4 + k] = q;
      const d = Math.fround(Math.fround(q / 65535) * scale[k] + offset[k]) - v;
      e2 += d * d;
    }
    maxErr = Math.max(maxErr, Math.sqrt(e2));
  }
  return { format: 'unorm16x4', data: out, maxError: maxErr, scale, offset };
}

/** Encode normals in `format`; maxError in degrees. */
export function encodeNormals(nrm: Float32Array, format: WgmNormalFormat): EncodedStream<WgmNormalFormat> {
  const n = nrm.length / 3;
  if (format === 'float32x3') return { format, data: nrm, maxError: 0 };
  let maxErr = 0;
  if (format === 'snorm16x2') {
    const out = new Int16Array(n * 2);
    for (let i = 0; i < n; i++) {
      const x = nrm[i * 3], y = nrm[i * 3 + 1], z = nrm[i * 3 + 2];
      const l = Math.hypot(x, y, z) || 1;
      const [qu, qv] = octQuant16(x / l, y / l, z / l);
      out[i * 2] = qu; out[i * 2 + 1] = qv;
      const d = octDecode(fromSnorm(qu, 16), fromSnorm(qv, 16));
      maxErr = Math.max(maxErr, angleDeg(x, y, z, d[0], d[1], d[2]));
    }
    return { format, encoding: 'oct', data: out, maxError: maxErr };
  }
  const bits = format === 'snorm8x4' ? 8 : 16;
  const out = bits === 8 ? new Int8Array(n * 4) : new Int16Array(n * 4);
  for (let i = 0; i < n; i++) {
    const x = nrm[i * 3], y = nrm[i * 3 + 1], z = nrm[i * 3 + 2];
    const l = Math.hypot(x, y, z) || 1;
    const q = [toSnorm(x / l, bits), toSnorm(y / l, bits), toSnorm(z / l, bits)];
    out.set(q, i * 4);
    maxErr = Math.max(maxErr, angleDeg(x, y, z, fromSnorm(q[0], bits), fromSnorm(q[1], bits), fromSnorm(q[2], bits)));
  }
  return { format, data: out, maxError: maxErr };
}

/** Encode tangents (xyz + w sign) in `format`; maxError in degrees (the sign is always exact). */
export function encodeTangents(tan: Float32Array, format: WgmTangentFormat): EncodedStream<WgmTangentFormat> {
  const n = tan.length / 4;
  if (format === 'float32x4') return { format, data: tan, maxError: 0 };
  let maxErr = 0;
  if (format === 'snorm16x2') {
    const out = new Int16Array(n * 2);
    for (let i = 0; i < n; i++) {
      const x = tan[i * 4], y = tan[i * 4 + 1], z = tan[i * 4 + 2], w = tan[i * 4 + 3];
      const l = Math.hypot(x, y, z) || 1;
      const [u, v] = octEncode(x / l, y / l, z / l);
      const qu = toSnorm(u, 16), qv = toSnorm(packOctSign(v, w), 16);
      out[i * 2] = qu; out[i * 2 + 1] = qv;
      const [dv, sign] = unpackOctSign(fromSnorm(qv, 16));
      if (sign !== (w < 0 ? -1 : 1)) throw new Error('oct tangent sign lost');
      const d = octDecode(fromSnorm(qu, 16), dv);
      maxErr = Math.max(maxErr, angleDeg(x, y, z, d[0], d[1], d[2]));
    }
    return { format, encoding: 'oct', data: out, maxError: maxErr };
  }
  const bits = format === 'snorm8x4' ? 8 : 16;
  const out = bits === 8 ? new Int8Array(n * 4) : new Int16Array(n * 4);
  for (let i = 0; i < n; i++) {
    const x = tan[i * 4], y = tan[i * 4 + 1], z = tan[i * 4 + 2], w = tan[i * 4 + 3];
    const l = Math.hypot(x, y, z) || 1;
    const q = [toSnorm(x / l, bits), toSnorm(y / l, bits), toSnorm(z / l, bits), w < 0 ? -(bits === 8 ? 127 : 32767) : (bits === 8 ? 127 : 32767)];
    out.set(q, i * 4);
    maxErr = Math.max(maxErr, angleDeg(x, y, z, fromSnorm(q[0], bits), fromSnorm(q[1], bits), fromSnorm(q[2], bits)));
  }
  return { format, data: out, maxError: maxErr };
}

/** Encode UVs; maxError in UV units (multiply by texture size for texels). unorm16x2 only if all UVs lie in [0,1]. */
export function encodeUvs(uv: Float32Array, format: WgmUvFormat): EncodedStream<WgmUvFormat> | null {
  if (format === 'float32x2') return { format, data: uv, maxError: 0 };
  let maxErr = 0;
  if (format === 'unorm16x2') {
    const out = new Uint16Array(uv.length);
    for (let i = 0; i < uv.length; i++) {
      const v = uv[i];
      if (v < -1e-6 || v > 1 + 1e-6) return null;
      out[i] = toUnorm16(v);
      maxErr = Math.max(maxErr, Math.abs(out[i] / 65535 - v));
    }
    return { format, data: out, maxError: maxErr };
  }
  const out = new Uint16Array(uv.length);
  for (let i = 0; i < uv.length; i++) {
    out[i] = toHalf(uv[i]);
    maxErr = Math.max(maxErr, Math.abs(fromHalf(out[i]) - uv[i]));
  }
  return { format, data: out, maxError: maxErr };
}

// ------------------------------------------------------------------ selection

export interface Choice<F extends string> { stream: EncodedStream<F>; reason: string }

/** Pick the smallest normal encoding within tolerance (or the given precision policy). */
export function chooseNormals(nrm: Float32Array, precision: VertexPrecision, enc: NormalEncoding, tol: VertexTolerance): Choice<WgmNormalFormat> {
  if (precision === 'full') return { stream: encodeNormals(nrm, 'float32x3'), reason: 'full precision' };
  const order: WgmNormalFormat[] = enc === 'oct' ? ['snorm16x2', 'snorm16x4', 'float32x3'] : ['snorm8x4', 'snorm16x4', 'float32x3'];
  if (precision === 'low') return { stream: encodeNormals(nrm, order[0]), reason: 'low precision' };
  for (const f of order) {
    const s = encodeNormals(nrm, f);
    if (s.maxError <= tol.normalDegrees || f === 'float32x3') return { stream: s, reason: `max ${s.maxError.toFixed(3)}° <= ${tol.normalDegrees}°` };
  }
  throw new Error('unreachable');
}

export function chooseTangents(tan: Float32Array, precision: VertexPrecision, enc: NormalEncoding, tol: VertexTolerance): Choice<WgmTangentFormat> {
  if (precision === 'full') return { stream: encodeTangents(tan, 'float32x4'), reason: 'full precision' };
  const order: WgmTangentFormat[] = enc === 'oct' ? ['snorm16x2', 'snorm16x4', 'float32x4'] : ['snorm8x4', 'snorm16x4', 'float32x4'];
  if (precision === 'low') return { stream: encodeTangents(tan, order[0]), reason: 'low precision' };
  for (const f of order) {
    const s = encodeTangents(tan, f);
    if (s.maxError <= tol.normalDegrees || f === 'float32x4') return { stream: s, reason: `max ${s.maxError.toFixed(3)}° <= ${tol.normalDegrees}°` };
  }
  throw new Error('unreachable');
}

/** `texSize`: largest texture side (texels) the primitive samples. */
export function chooseUvs(uv: Float32Array, precision: VertexPrecision, texSize: number, tol: VertexTolerance): Choice<WgmUvFormat> {
  if (precision === 'full') return { stream: encodeUvs(uv, 'float32x2')!, reason: 'full precision' };
  for (const f of ['unorm16x2', 'float16x2', 'float32x2'] as WgmUvFormat[]) {
    const s = encodeUvs(uv, f);
    if (!s) continue;
    const texels = s.maxError * texSize;
    if (precision === 'low' || texels <= tol.uvTexels || f === 'float32x2') {
      return { stream: s, reason: `max ${texels.toFixed(4)} texels @${texSize}px${f === 'float16x2' ? ' (UVs outside [0,1])' : ''}` };
    }
  }
  throw new Error('unreachable');
}

/** Pixel error of a position grid for a mesh whose bounding diagonal fills the screen. */
export function positionPixelError(maxError: number, diagonal: number, tol: VertexTolerance): number {
  return diagonal > 0 ? (maxError / diagonal) * tol.screenPixels : 0;
}
