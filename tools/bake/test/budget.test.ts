/** Triangle budgets: LOD0 is budgeted on unique geometry; instances only deepen the LOD chain. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { bakeFile } from '../bake';
import { readWgm } from '../../../src/assets/wgm/format';

const quiet = { log() {}, warn() {} };
const dir = mkdtempSync(path.join(tmpdir(), 'wgm-budget-'));

/** A bumpy 64x64 grid (8192 triangles) referenced by `copies` nodes. */
async function scene(copies: number, separateMeshes = false): Promise<string> {
  const doc = new Document();
  const buf = doc.createBuffer();
  const n = 64, pos: number[] = [], nrm: number[] = [], idx: number[] = [];
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) {
    pos.push(x / n, y / n, 0.04 * Math.sin(x * 0.3) * Math.cos(y * 0.25));
    nrm.push(0, 0, 1);
  }
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const a = y * (n + 1) + x; idx.push(a, a + 1, a + n + 2, a, a + n + 2, a + n + 1); }
  const makeMesh = () => doc.createMesh('grid').addPrimitive(doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(pos)).setBuffer(buf))
    .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(nrm)).setBuffer(buf))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(idx)).setBuffer(buf)));
  const shared = makeMesh();
  const sc = doc.createScene();
  for (let i = 0; i < copies; i++) {
    sc.addChild(doc.createNode(`n${i}`).setMesh(separateMeshes && i > 0 ? makeMesh() : shared).setTranslation([i * 1.5, 0, 0]));
  }
  const file = path.join(dir, `grid-${copies}${separateMeshes ? '-sep' : ''}.glb`);
  await new NodeIO().write(file, doc);
  return file;
}

const permissive = { pixelError: 40, screenPixels: 1000, normalDegrees: 1, uvTexels: 0.5 };
const opts = { textureFormat: 'rgba8' as const, lods: 2, lodMaxError: 1, maxTriangles: 2000, maxDrawnTriangles: 20_000, vertexTolerance: permissive };

async function bake(file: string, o: Record<string, unknown> = {}) {
  const res = await bakeFile(file, 'webgpu', { ...opts, ...o }, quiet);
  const prim = readWgm(res.bytes).manifest.meshes[0].primitives[0];
  return { stats: res.stats as Record<string, number>, lods: prim.lods.map((l) => l.indexCount / 3) };
}

test('N instances of one mesh get the same LOD0 as one instance; instances only add LOD levels', async () => {
  const one = await bake(await scene(1));
  const many = await bake(await scene(30));
  assert.equal(one.stats.sourceUniqueTriangles, 8192);
  assert.equal(many.stats.sourceUniqueTriangles, 8192, 'instances do not count toward the unique budget');
  assert.equal(many.stats.sourceDrawnTriangles, 8192 * 30);
  assert.ok(one.lods[0] < 8192 * 0.5, `budget applied: ${one.lods[0]}`);
  assert.equal(many.lods[0], one.lods[0], 'same LOD0 regardless of instance count');
  assert.equal(one.lods.length, 2, 'single copy is under the drawn estimate: --lods as given');
  assert.ok(many.lods.length > one.lods.length, `drawn estimate deepens the chain: ${many.lods}`);
  assert.equal(many.stats.drawnTrianglesLod0, many.lods[0] * 30);
  assert.ok(many.stats.drawnTrianglesCoarsest < many.stats.drawnTrianglesLod0);
  // Same shape duplicated as 30 separate meshes (as in MetalRoughSpheres) is still unique once.
  const dup = await bake(await scene(30, true));
  assert.equal(dup.stats.sourceUniqueTriangles, 8192);
  assert.equal(dup.lods[0], one.lods[0]);
  // Without a drawn estimate, the chain stays as requested.
  const plain = await bake(await scene(30), { maxDrawnTriangles: 0 });
  assert.deepEqual(plain.lods, one.lods);
});

test('LOD0 budget never simplifies past the pixel tolerance', async () => {
  const file = await scene(1);
  const loose = await bake(file);
  const tight = await bake(file, { vertexTolerance: { ...permissive, pixelError: 0.25, screenPixels: 4000 } });
  assert.ok(tight.lods[0] > loose.lods[0] * 2, `tight ${tight.lods[0]} vs loose ${loose.lods[0]}`);
  assert.ok(tight.lods[0] > opts.maxTriangles, 'kept above the budget because further reduction would be visible');
});
