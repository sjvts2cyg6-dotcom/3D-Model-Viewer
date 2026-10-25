/**
 * Message formats the orchestrator speaks (PROTOCOL.md is normative).
 * Deliberately self-contained: the orchestrator re-implements the DeviceProfile
 * checks from the spec instead of importing the probe or the baker.
 */

export const PROFILE_SCHEMA = 'wgm-device-profile';
export const PROFILE_VERSION = 1;

/** Opaque to the orchestrator beyond the fields it validates. */
export type DeviceProfileJson = Record<string, unknown> & { schema: string; version: number; deviceClass: string };

/** Probe -> orchestrator report (POST body). */
export type ProbeReport =
  | { type: 'profile'; token: string; profile: unknown }
  | { type: 'error'; token: string; message: string }
  | { type: 'closed'; token: string };

/** Structural validation per PROTOCOL.md "DeviceProfile v1". Returns problems; [] = valid. */
export function validateProfile(v: unknown): string[] {
  const errs: string[] = [];
  if (!v || typeof v !== 'object' || Array.isArray(v)) return ['profile is not an object'];
  const o = v as Record<string, unknown>;
  const obj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
  if (o.schema !== PROFILE_SCHEMA) errs.push(`schema must be "${PROFILE_SCHEMA}"`);
  if (o.version !== PROFILE_VERSION) errs.push(`version must be ${PROFILE_VERSION}`);
  if (typeof o.probedAt !== 'string' || Number.isNaN(Date.parse(o.probedAt))) errs.push('probedAt must be an ISO date');
  if (!obj(o.display)) errs.push('display missing');
  else for (const k of ['screenWidth', 'screenHeight', 'devicePixelRatio']) {
    const n = o.display[k];
    if (typeof n !== 'number' || !(n > 0)) errs.push(`display.${k} must be a positive number`);
  }
  if (!obj(o.gpu)) errs.push('gpu missing');
  else {
    const g = o.gpu;
    if (typeof g.available !== 'boolean') errs.push('gpu.available must be boolean');
    if (!Array.isArray(g.features)) errs.push('gpu.features must be an array');
    if (!obj(g.limits)) errs.push('gpu.limits must be an object');
    else if (g.available === true && typeof g.limits.maxTextureDimension2D !== 'number') errs.push('gpu.limits.maxTextureDimension2D missing');
    const tc = g.textureCompression;
    if (!obj(tc) || typeof tc.bc !== 'boolean' || typeof tc.astc !== 'boolean' || typeof tc.etc2 !== 'boolean') {
      errs.push('gpu.textureCompression {bc, astc, etc2} must be booleans');
    }
  }
  if (!obj(o.platform)) errs.push('platform missing');
  if (!['desktop', 'mobile', 'software'].includes(o.deviceClass as string)) errs.push('deviceClass must be desktop | mobile | software');
  return errs;
}

/** Short human summary of a validated profile. */
export function summarize(p: DeviceProfileJson): string {
  const g = (p.gpu ?? {}) as Record<string, unknown>;
  const d = (p.display ?? {}) as Record<string, unknown>;
  const probe = (p.probe ?? {}) as Record<string, unknown>;
  const gpu = [g.vendor, g.architecture, g.description].filter(Boolean).join(' ') || (g.available ? 'GPU (info hidden)' : 'no WebGPU');
  return `${p.deviceClass}, ${gpu}, screen ${d.screenWidth}x${d.screenHeight}@${d.devicePixelRatio}${probe.headless ? ', HEADLESS browser' : ''}`;
}

/** One NDJSON event from the baker (`--json`). */
export interface BakerEvent { event: string; t?: number; [k: string]: unknown }

export function parseNdjsonLine(line: string): BakerEvent | null {
  const s = line.trim();
  if (!s) return null;
  try {
    const v = JSON.parse(s) as unknown;
    return v && typeof v === 'object' && typeof (v as BakerEvent).event === 'string' ? (v as BakerEvent) : null;
  } catch { return null; }
}
