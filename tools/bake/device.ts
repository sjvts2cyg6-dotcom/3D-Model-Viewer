/**
 * Device profile -> bake options. The profile comes from the probe page
 * (src/probe, schema in src/probe/profile.ts and PROTOCOL.md); this module only
 * reads the data, it never measures anything itself.
 */
import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDeviceProfile, type DeviceProfile } from '../../src/probe/profile';
import type { BakeOptions } from './targets';

export type DetailLevel = 'low' | 'medium' | 'high' | 'max';
export const DETAIL_LEVELS: readonly DetailLevel[] = ['low', 'medium', 'high', 'max'];

export class DeviceProfileError extends Error { override name = 'DeviceProfileError'; }

export function parseDeviceProfile(text: string, origin: string): DeviceProfile {
  let v: unknown;
  try { v = JSON.parse(text); } catch (e) { throw new DeviceProfileError(`${origin}: not valid JSON (${(e as Error).message})`); }
  const errs = validateDeviceProfile(v);
  if (errs.length) throw new DeviceProfileError(`${origin}: invalid device profile: ${errs.join('; ')}`);
  return v as DeviceProfile;
}

/** Built-in profiles (tools/bake/presets/*.json). Hand-written ESTIMATES of typical devices, not measurements. */
export const PRESET_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'presets');
export function listPresets(): string[] {
  try { return readdirSync(PRESET_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort(); } catch { return []; }
}

/**
 * `file` is a path, `-` (stdin), `preset:<name>`, or a bare preset name
 * (when no file of that name exists).
 */
export async function readDeviceProfile(file: string): Promise<DeviceProfile> {
  let text: string;
  const presetName = file.startsWith('preset:') ? file.slice(7) : null;
  if (presetName !== null || (file !== '-' && !file.includes('/') && !file.endsWith('.json') && listPresets().includes(file))) {
    const name = presetName ?? file;
    if (!listPresets().includes(name)) throw new DeviceProfileError(`unknown preset "${name}" (available: ${listPresets().join(', ')})`);
    file = path.join(PRESET_DIR, `${name}.json`);
  }
  if (file === '-') {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    text = Buffer.concat(chunks).toString('utf8');
  } else {
    try { text = await readFile(file, 'utf8'); } catch (e) { throw new DeviceProfileError(`cannot read ${file}: ${(e as Error).message}`); }
  }
  return parseDeviceProfile(text, file === '-' ? 'stdin' : file);
}

/** Full-detail triangle budgets at `medium`; low = x0.25, high = x4, max = unlimited. */
const TRIANGLE_BUDGET: Record<DeviceProfile['deviceClass'], number> = {
  desktop: 2_000_000, mobile: 300_000, software: 100_000,
};
/**
 * Per-frame drawn triangles (all instances) a device class is assumed to handle at `medium`.
 * An estimate, not a measurement; it only decides how deep the LOD chain goes.
 */
const DRAWN_TRIANGLE_BUDGET: Record<DeviceProfile['deviceClass'], number> = {
  desktop: 5_000_000, mobile: 750_000, software: 250_000,
};
const DETAIL_SCALE: Record<DetailLevel, number> = { low: 0.25, medium: 1, high: 4, max: Infinity };
/** Texture side relative to the longest physical screen side. */
const TEXTURE_SCREEN_FACTOR: Record<DetailLevel, number> = { low: 0.5, medium: 1, high: 2, max: Infinity };

/** Visible-error tolerances per detail level. */
const PIXEL_TOLERANCE: Record<DetailLevel, number> = { low: 1, medium: 0.5, high: 0.25, max: 0.1 };
const NORMAL_TOLERANCE_DEG: Record<DetailLevel, number> = { low: 1, medium: 0.5, high: 0.25, max: 0.05 };
const UV_TOLERANCE_TEXELS: Record<DetailLevel, number> = { low: 0.5, medium: 0.25, high: 0.125, max: 0.0625 };

const pow2ceil = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(1, n)));

export interface DeviceDerivation {
  options: Partial<BakeOptions>;
  /** Human-readable reasons, one per decision. */
  decisions: string[];
  /** Compact description embedded in the baked file's stats. */
  summary: Record<string, unknown>;
}

/**
 * Derive bake options for a device. Only fields not explicitly set by the user
 * are returned; explicit CLI flags always win (the caller merges them last).
 */
export function deriveOptions(p: DeviceProfile, detail: DetailLevel): DeviceDerivation {
  const options: Partial<BakeOptions> = {};
  const decisions: string[] = [];
  const cls = p.deviceClass;

  // Textures: never larger than the device can sample, and not much larger than
  // the screen can show (a texture rarely covers more than the screen).
  const deviceMax = p.gpu.available ? (p.gpu.limits.maxTextureDimension2D ?? 8192) : 2048;
  const screenLong = Math.max(p.display.screenWidth, p.display.screenHeight) * p.display.devicePixelRatio;
  let tex = Math.min(4096, deviceMax, pow2ceil(screenLong * TEXTURE_SCREEN_FACTOR[detail]));
  if (cls === 'mobile' && (detail === 'low' || detail === 'medium')) tex = Math.min(tex, 2048);
  if (cls === 'software') tex = Math.min(tex, detail === 'max' ? 4096 : 1024);
  if (p.platform.deviceMemoryGB !== null && p.platform.deviceMemoryGB <= 2) tex = Math.min(tex, 1024);
  tex = Math.max(256, tex);
  options.maxTextureSize = tex;
  decisions.push(`max texture ${tex}px (screen ${Math.round(screenLong)} physical px, device limit ${deviceMax}, ${cls}, detail ${detail}` +
    `${p.platform.deviceMemoryGB !== null ? `, ${p.platform.deviceMemoryGB} GB RAM` : ''})`);

  // Geometry budget.
  const budget = TRIANGLE_BUDGET[cls] * DETAIL_SCALE[detail];
  options.maxTriangles = Number.isFinite(budget) ? Math.round(budget) : 0;
  decisions.push(options.maxTriangles
    ? `LOD0 triangle budget ${options.maxTriangles} for unique geometry, instances not counted (${cls}, detail ${detail}; never past the pixel tolerance)`
    : 'no LOD0 triangle budget (detail max)');
  const drawnBudget = DRAWN_TRIANGLE_BUDGET[cls] * DETAIL_SCALE[detail];
  options.maxDrawnTriangles = Number.isFinite(drawnBudget) ? Math.round(drawnBudget) : 0;
  decisions.push(options.maxDrawnTriangles
    ? `drawn-triangle estimate ${options.maxDrawnTriangles} per frame, instances counted (only deepens the LOD chain; LOD0 untouched)`
    : 'no drawn-triangle estimate (detail max)');

  // Textures: a native GPU format the device samples directly (no transcode at load).
  const tc = p.gpu.textureCompression;
  if (!p.gpu.available) {
    options.textureFormat = 'each';
    decisions.push('textures: WebGPU unavailable in the probe, format support unknown -> one file per native format (each)');
  } else if (tc.astc && (cls === 'mobile' || !tc.bc)) {
    options.textureFormat = 'astc';
    options.astcBlock = detail === 'low' ? '6x6' : '4x4';
    decisions.push(`textures ASTC ${options.astcBlock} (device has ASTC${cls === 'mobile' ? ', mobile' : ''}; ${detail === 'low' ? '3.56' : '8'} bits/texel, uploaded as-is)`);
  } else if (tc.bc) {
    options.textureFormat = 'bc7';
    decisions.push('textures BC7 (device has texture-compression-bc; 8 bits/texel, uploaded as-is)');
  } else if (tc.etc2) {
    options.textureFormat = 'etc2';
    decisions.push('textures ETC2 (device has only texture-compression-etc2; uploaded as-is)');
  } else {
    options.textureFormat = 'rgba8';
    decisions.push('textures RGBA8 (no GPU texture compression on this device)');
  }

  // Vertex precision: errors below what this screen can show at this detail level.
  options.vertexTolerance = {
    pixelError: PIXEL_TOLERANCE[detail],
    screenPixels: Math.round(screenLong),
    normalDegrees: NORMAL_TOLERANCE_DEG[detail],
    uvTexels: UV_TOLERANCE_TEXELS[detail],
  };
  decisions.push(`vertex tolerance ${PIXEL_TOLERANCE[detail]} px at ${Math.round(screenLong)} px, normals ${NORMAL_TOLERANCE_DEG[detail]}°, UV ${UV_TOLERANCE_TEXELS[detail]} texel (detail ${detail})`);

  // LOD chain: keep the target default; software adapters benefit from coarser steps.
  if (cls === 'software') { options.lodRatio = 0.35; decisions.push('LOD ratio 0.35 (software adapter)'); }

  return {
    options,
    decisions,
    summary: {
      deviceClass: cls, probedAt: p.probedAt, headless: p.probe.headless, detail,
      gpu: `${p.gpu.vendor} ${p.gpu.architecture} ${p.gpu.description}`.trim(),
      screen: `${p.display.screenWidth}x${p.display.screenHeight}@${p.display.devicePixelRatio}`,
      textureCompression: Object.entries(tc).filter(([, v]) => v).map(([k]) => k),
    },
  };
}
