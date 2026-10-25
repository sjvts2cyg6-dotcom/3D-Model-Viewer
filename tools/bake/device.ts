/**
 * Device profile -> bake options. The profile comes from the probe page
 * (src/probe, schema in src/probe/profile.ts and PROTOCOL.md); this module only
 * reads the data, it never measures anything itself.
 */
import { readFile } from 'node:fs/promises';
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

export async function readDeviceProfile(file: string): Promise<DeviceProfile> {
  let text: string;
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
const DETAIL_SCALE: Record<DetailLevel, number> = { low: 0.25, medium: 1, high: 4, max: Infinity };
/** Texture side relative to the longest physical screen side. */
const TEXTURE_SCREEN_FACTOR: Record<DetailLevel, number> = { low: 0.5, medium: 1, high: 2, max: Infinity };

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
  decisions.push(options.maxTriangles ? `triangle budget ${options.maxTriangles} (${cls}, detail ${detail})` : 'no triangle budget (detail max)');

  // Texture codecs: KTX2 everywhere (smaller download, GPU-compressed when possible).
  const tc = p.gpu.textureCompression;
  const runtime = tc.bc ? 'BC7' : tc.astc ? 'ASTC 4x4' : tc.etc2 ? 'ETC2' : 'RGBA8 (no GPU compression)';
  options.textureFormat = 'auto';
  decisions.push(`textures KTX2 auto; runtime will transcode to ${runtime}`);

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
