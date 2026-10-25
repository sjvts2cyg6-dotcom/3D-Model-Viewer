/** Programmatic entry point: read a glTF/GLB, run a target profile, return the baked bytes. */
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { TARGETS, type BakeContext, type BakeOptions, type BakeOutput, type TargetProfile } from './targets';

export const BASE_OPTIONS: BakeOptions = {
  lods: 1, lodRatio: 0.5, lodMaxError: 0.05, textureFormat: 'auto', maxTextureSize: 4096,
  etc1sQuality: 192, uastcLevel: 2, uastcRdo: true, recomputeTangents: false,
};

export function getTarget(id: string): TargetProfile {
  const t = TARGETS[id];
  if (!t) throw new Error(`unknown target "${id}" (available: ${Object.keys(TARGETS).join(', ')})`);
  return t;
}

export async function bakeFile(
  input: string, targetId: string, overrides: Partial<BakeOptions>, log: Pick<BakeContext, 'log' | 'warn'>,
): Promise<BakeOutput & { target: TargetProfile; options: BakeOptions }> {
  const target = getTarget(targetId);
  const options: BakeOptions = { ...BASE_OPTIONS, ...target.defaults, ...overrides };
  if (!target.textureFormats.includes(options.textureFormat)) {
    throw new Error(`target "${target.id}" does not support --texture-format ${options.textureFormat} (use ${target.textureFormats.join(' | ')})`);
  }
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(input);
  doc.setLogger({ debug() {}, info() {}, warn: (m: string) => log.warn(m), error: (m: string) => log.warn(m) } as never);
  const out = await target.bake(doc, { options, ...log });
  return { ...out, target, options };
}
