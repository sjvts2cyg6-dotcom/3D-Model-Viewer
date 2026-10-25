/**
 * DeviceProfile v1: what the probe measures on a device and what bakers consume.
 * Pure data + validation (no DOM / WebGPU / Node APIs). The normative description
 * is in PROTOCOL.md; other tools (the local orchestrator, other engines' bakers)
 * re-implement the validation from that spec instead of importing this file.
 */
export const DEVICE_PROFILE_SCHEMA = 'wgm-device-profile';
export const DEVICE_PROFILE_VERSION = 1;

export type DeviceClass = 'desktop' | 'mobile' | 'software';

export interface DeviceProfile {
  schema: typeof DEVICE_PROFILE_SCHEMA;
  version: typeof DEVICE_PROFILE_VERSION;
  /** ISO-8601 timestamp of the measurement. */
  probedAt: string;
  probe: { name: string; version: string; /** Automated / headless browser detected. */ headless: boolean };
  platform: {
    userAgent: string;
    mobile: boolean;
    hardwareConcurrency: number;
    /** navigator.deviceMemory (GiB, coarse, Chromium only) or null. */
    deviceMemoryGB: number | null;
    maxTouchPoints: number;
  };
  display: {
    /** CSS pixels. */
    screenWidth: number;
    screenHeight: number;
    devicePixelRatio: number;
    viewportWidth: number;
    viewportHeight: number;
    colorGamut: 'srgb' | 'p3' | 'rec2020';
    hdr: boolean;
  };
  gpu: {
    available: boolean;
    vendor: string;
    architecture: string;
    device: string;
    description: string;
    isFallbackAdapter: boolean;
    features: string[];
    /** Selected GPUSupportedLimits (always includes maxTextureDimension2D when available). */
    limits: Record<string, number>;
    preferredCanvasFormat: string;
    textureCompression: { bc: boolean; astc: boolean; etc2: boolean };
  };
  benchmark: {
    /** Shaded fill rate of a fixed ALU-heavy full-screen pass, megapixels / second. null if not run. */
    fillRateMPixPerSec: number | null;
    ms: number | null;
  };
  /** Coarse class derived by the probe; bakers may re-derive from the raw fields. */
  deviceClass: DeviceClass;
}

/** Returns a list of problems; empty = valid. */
export function validateDeviceProfile(v: unknown): string[] {
  const errs: string[] = [];
  const o = v as Record<string, any>;
  if (!o || typeof o !== 'object') return ['profile is not an object'];
  if (o.schema !== DEVICE_PROFILE_SCHEMA) errs.push(`schema must be "${DEVICE_PROFILE_SCHEMA}"`);
  if (o.version !== DEVICE_PROFILE_VERSION) errs.push(`version must be ${DEVICE_PROFILE_VERSION}`);
  if (typeof o.probedAt !== 'string' || Number.isNaN(Date.parse(o.probedAt))) errs.push('probedAt must be an ISO date');
  const d = o.display;
  if (!d || typeof d !== 'object') errs.push('display missing');
  else for (const k of ['screenWidth', 'screenHeight', 'devicePixelRatio']) {
    if (typeof d[k] !== 'number' || !(d[k] > 0)) errs.push(`display.${k} must be a positive number`);
  }
  const g = o.gpu;
  if (!g || typeof g !== 'object') errs.push('gpu missing');
  else {
    if (typeof g.available !== 'boolean') errs.push('gpu.available must be boolean');
    if (!Array.isArray(g.features)) errs.push('gpu.features must be an array');
    if (!g.limits || typeof g.limits !== 'object') errs.push('gpu.limits must be an object');
    else if (g.available && typeof g.limits.maxTextureDimension2D !== 'number') errs.push('gpu.limits.maxTextureDimension2D missing');
    const tc = g.textureCompression;
    if (!tc || typeof tc.bc !== 'boolean' || typeof tc.astc !== 'boolean' || typeof tc.etc2 !== 'boolean') {
      errs.push('gpu.textureCompression {bc, astc, etc2} must be booleans');
    }
  }
  if (!o.platform || typeof o.platform !== 'object') errs.push('platform missing');
  if (!['desktop', 'mobile', 'software'].includes(o.deviceClass)) errs.push('deviceClass must be desktop | mobile | software');
  return errs;
}
