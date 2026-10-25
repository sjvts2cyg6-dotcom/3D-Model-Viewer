/**
 * Target-independent clean-up on the glTF-Transform document:
 *   dequantize -> dedup -> weld -> normals (if missing) ->
 *   MikkTSpace tangents (normal-mapped primitives only) -> weld -> prune.
 *
 * The result has float attributes, indexed triangle lists, merged identical
 * vertices, and TANGENT only where a normal map needs it.
 */
import { type Document, type Primitive } from '@gltf-transform/core';
import { dedup, dequantize, normals, prune, tangents, unweld, weld } from '@gltf-transform/functions';
import { generateTangents } from 'mikktspace';
import type { BakeContext } from './targets/types';

export async function prepareDocument(doc: Document, ctx: BakeContext): Promise<void> {
  const root = doc.getRoot();
  if (root.listAnimations().length) ctx.warn(`${root.listAnimations().length} animation(s) ignored (not supported yet)`);
  if (root.listSkins().length) ctx.warn(`${root.listSkins().length} skin(s) ignored (not supported yet)`);

  // Non-triangle primitives cannot be rendered by the engine; drop them early.
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      if (prim.getMode() !== 4 /* TRIANGLES */) {
        ctx.warn(`mesh "${mesh.getName()}": dropping primitive with mode ${prim.getMode()} (only TRIANGLES supported)`);
        mesh.removePrimitive(prim);
        prim.dispose();
      }
    }
  }

  await doc.transform(dequantize(), dedup(), weld());
  const missingNormals = root.listMeshes().flatMap((m) => m.listPrimitives()).filter((p) => !p.getAttribute('NORMAL'));
  if (missingNormals.length) {
    await doc.transform(normals({ overwrite: false }));
    ctx.log(`normals generated for ${missingNormals.length} primitive(s)`);
  }

  const needsTangents = (p: Primitive) => !!p.getMaterial()?.getNormalTexture() && !!p.getAttribute('TEXCOORD_0');
  const prims = root.listMeshes().flatMap((m) => m.listPrimitives());
  if (ctx.options.recomputeTangents) {
    for (const p of prims) if (needsTangents(p)) p.setAttribute('TANGENT', null);
  }
  const toGenerate = prims.filter((p) => needsTangents(p) && !p.getAttribute('TANGENT'));
  if (toGenerate.length) {
    // MikkTSpace operates on unindexed triangles; weld again afterwards.
    await doc.transform(unweld(), tangents({ generateTangents, overwrite: false }), weld());
    ctx.log(`mikktspace tangents generated for ${toGenerate.length} primitive(s)`);
  }
  // Tangents without a normal map are dead weight (16 B/vertex).
  for (const p of prims) {
    if (p.getAttribute('TANGENT') && !p.getMaterial()?.getNormalTexture()) p.setAttribute('TANGENT', null);
  }
  for (const p of prims) {
    const mat = p.getMaterial();
    const uvSets = [mat?.getBaseColorTextureInfo(), mat?.getNormalTextureInfo(), mat?.getMetallicRoughnessTextureInfo(),
      mat?.getOcclusionTextureInfo(), mat?.getEmissiveTextureInfo()].map((i) => i?.getTexCoord() ?? 0);
    if (uvSets.some((s) => s !== 0)) ctx.warn(`material "${mat?.getName()}": TEXCOORD_1+ not supported, using TEXCOORD_0`);
    if (p.getAttribute('COLOR_0')) ctx.warn('COLOR_0 vertex colours ignored (not supported yet)');
  }
  await doc.transform(prune());
}
