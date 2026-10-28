/** Programmatic entry point: read a glTF/GLB, run a target profile, return the baked bytes. */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { DEFAULT_TOLERANCE } from './quantize';
import { TARGETS, type BakeContext, type BakeOptions, type BakeOutput, type TargetProfile } from './targets';

export const BASE_OPTIONS: BakeOptions = {
  lods: 1, lodRatio: 0.5, lodMaxError: 0.05, textureFormat: 'auto', astcBlock: '4x4', astcQuality: 'medium', maxTextureSize: 4096,
  etc1sQuality: 192, uastcLevel: 2, uastcRdo: false, zstd: false, recomputeTangents: false, maxTriangles: 0, maxDrawnTriangles: 0,
  vertexPrecision: 'auto', normalEncoding: 'auto', vertexTolerance: { ...DEFAULT_TOLERANCE },
};

/** The input could not be read or parsed (CLI exit code 3). */
export class BakeInputError extends Error { override name = 'BakeInputError'; }

export function getTarget(id: string): TargetProfile {
  const t = TARGETS[id];
  if (!t) throw new Error(`unknown target "${id}" (available: ${Object.keys(TARGETS).join(', ')})`);
  return t;
}

export async function bakeFile(
  input: string, targetId: string, overrides: Partial<BakeOptions>, log: Pick<BakeContext, 'log' | 'warn'>,
  device?: Record<string, unknown>,
): Promise<BakeOutput & { target: TargetProfile; options: BakeOptions }> {
  const target = getTarget(targetId);
  const options: BakeOptions = { ...BASE_OPTIONS, ...target.defaults, ...overrides };
  if (!target.textureFormats.includes(options.textureFormat)) {
    throw new Error(`target "${target.id}" does not support --texture-format ${options.textureFormat} (use ${target.textureFormats.join(' | ')})`);
  }
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  let doc;
  try { doc = await io.read(input); } catch (e) { throw new BakeInputError(`cannot read ${input}: ${(e as Error).message}`); }
  doc.setLogger({ debug() {}, info() {}, warn: (m: string) => log.warn(m), error: (m: string) => log.warn(m) } as never);
  const out = await target.bake(doc, { options, device, ...log });
  return { ...out, target, options };
}
