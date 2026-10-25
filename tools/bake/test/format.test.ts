/**
 * Cheap automated checks (no GPU, no sample assets needed):
 *   - WGM writer/reader round trip, alignment and corruption detection,
 *   - geometry optimiser invariants (LODs share vertices, valid ranges),
 *   - a full bake of a generated glTF through the webgpu target, read back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { PNG } from 'pngjs';
import {
  readWgm, writeWgm, isWgm, SectionBuilder, WgmFormatError, WGM_HEADER_SIZE, WGM_SECTION_ALIGN, WGM_VERTEX_LAYOUT,
  type WgmManifest,
} from '../../../src/assets/wgm/format';
import { optimizeGeometry } from '../geometry';
import { bakeFile } from '../bake';

const quiet = { log() {}, warn() {} };

function sampleManifest(): Omit<WgmManifest, 'format' | 'version' | 'sections'> {
  return {
    target: 'webgpu', generator: 'test', vertexLayout: WGM_VERTEX_LAYOUT,
    nodes: [{ name: 'n', mesh: 0, translation: [1, 2, 3] }], roots: [0],
    meshes: [{
      name: 'tri',
      primitives: [{
        material: null, vertexCount: 3,
        streams: { position: { byteOffset: 0, byteLength: 36 }, normal: { byteOffset: 36, byteLength: 36 } },
        indices: { byteOffset: 0, byteLength: 6, format: 'uint16', count: 3 },
        lods: [{ firstIndex: 0, indexCount: 3, error: 0 }],
        bounds: { min: [0, 0, 0], max: [1, 1, 0] },
      }],
    }],
    materials: [], textures: [], samplers: [], bounds: { min: [0, 0, 0], max: [1, 1, 0] },
  };
}

test('wgm round trip preserves manifest and section bytes', () => {
  const vertex = new SectionBuilder();
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const nrm = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  vertex.push(pos); vertex.push(nrm);
  const index = new SectionBuilder();
  index.push(new Uint16Array([0, 1, 2]));
  const bytes = writeWgm({ manifest: sampleManifest(), sections: { vertex: vertex.finish(), index: index.finish() } });

  assert.ok(isWgm(bytes));
  assert.equal(bytes.byteLength % WGM_SECTION_ALIGN, 0);
  const f = readWgm(bytes);
  assert.deepEqual(f.manifest.nodes, sampleManifest().nodes);
  assert.deepEqual(f.manifest.meshes, sampleManifest().meshes);
  assert.equal(f.header.binaryByteOffset % WGM_SECTION_ALIGN, 0);
  assert.ok(f.header.binaryByteOffset >= WGM_HEADER_SIZE);
  const v = f.section('vertex');
  assert.deepEqual(new Float32Array(v.slice(0, 36).buffer), pos);
  assert.deepEqual(new Float32Array(v.slice(36, 72).buffer), nrm);
  assert.deepEqual(new Uint16Array(f.section('index').slice(0, 6).buffer), new Uint16Array([0, 1, 2]));
  assert.equal(f.section('texture').byteLength, 0);
  // Sections are zero-copy views into the input.
  assert.equal(v.buffer, bytes.buffer);
});

test('wgm reader rejects corrupt input', () => {
  const vertex = new SectionBuilder();
  vertex.push(new Float32Array(18));
  const index = new SectionBuilder();
  index.push(new Uint16Array([0, 1, 2]));
  const good = writeWgm({ manifest: sampleManifest(), sections: { vertex: vertex.finish(), index: index.finish() } });

  const badMagic = good.slice(); badMagic[0] ^= 0xff;
  assert.throws(() => readWgm(badMagic), WgmFormatError);
  assert.throws(() => readWgm(good.slice(0, good.byteLength - 16)), /length mismatch/);
  const badVersion = good.slice(); new DataView(badVersion.buffer).setUint16(4, 99, true);
  assert.throws(() => readWgm(badVersion), /major version/);

  const m = sampleManifest();
  m.meshes[0].primitives[0].lods = [{ firstIndex: 0, indexCount: 6, error: 0 }];
  assert.throws(() => readWgm(writeWgm({ manifest: m, sections: { vertex: vertex.finish(), index: index.finish() } })), /LOD range/);
  const m2 = sampleManifest();
  m2.meshes[0].primitives[0].vertexCount = 100;
  assert.throws(() => readWgm(writeWgm({ manifest: m2, sections: { vertex: vertex.finish(), index: index.finish() } })), /expected/);
});

function grid(n: number) {
  const positions: number[] = [], normals: number[] = [], uvs: number[] = [], indices: number[] = [];
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) {
    positions.push(x / n, y / n, 0.05 * Math.sin(x * 0.7) * Math.cos(y * 0.5));
    normals.push(0, 0, 1);
    uvs.push(x / n, y / n);
  }
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const a = y * (n + 1) + x, b = a + 1, c = a + n + 1, d = c + 1;
    indices.push(a, b, d, a, d, c);
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), uvs: new Float32Array(uvs), indices: new Uint32Array(indices) };
}

test('geometry optimiser: LOD chain shares vertices and shrinks', async () => {
  const g = grid(40);
  const out = await optimizeGeometry(g, { levels: 4, ratio: 0.5, maxError: 0.1 });
  assert.equal(out.vertexCount, (40 + 1) ** 2);
  assert.ok(out.lods.length >= 2, `expected LODs, got ${out.lods.length}`);
  assert.equal(out.lods[0].indexCount, g.indices.length);
  for (let i = 1; i < out.lods.length; i++) {
    assert.ok(out.lods[i].indexCount < out.lods[i - 1].indexCount);
    assert.ok(out.lods[i].error >= out.lods[i - 1].error);
  }
  for (const i of out.lodIndices) assert.ok(i < out.vertexCount);
  // LOD0 is a permutation of the same triangles (same count, all vertices used).
  assert.equal(new Set(out.indices).size, out.vertexCount);
});

test('bake: generated glTF through the webgpu target reads back consistently', async () => {
  const doc = new Document();
  const buffer = doc.createBuffer();
  const g = grid(16);
  const acc = (arr: Float32Array<ArrayBuffer> | Uint32Array<ArrayBuffer>, type: 'VEC3' | 'VEC2' | 'SCALAR') => doc.createAccessor().setArray(arr).setType(type).setBuffer(buffer);
  const png = new PNG({ width: 8, height: 8 });
  for (let i = 0; i < 64; i++) png.data.set(((i >> 3) + i) % 2 ? [255, 255, 255, 255] : [40, 40, 40, 255], i * 4);
  const tex = doc.createTexture('checker').setImage(new Uint8Array(PNG.sync.write(png))).setMimeType('image/png');
  const normalTex = doc.createTexture('flat').setImage(new Uint8Array(PNG.sync.write(png))).setMimeType('image/png');
  const mat = doc.createMaterial('m').setBaseColorTexture(tex).setNormalTexture(normalTex);
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', acc(g.positions, 'VEC3'))
    .setAttribute('NORMAL', acc(g.normals, 'VEC3'))
    .setAttribute('TEXCOORD_0', acc(g.uvs, 'VEC2'))
    .setIndices(acc(g.indices, 'SCALAR'))
    .setMaterial(mat);
  const mesh = doc.createMesh('grid').addPrimitive(prim);
  // Same geometry reused by a second mesh with a different material must be shared in the file.
  const prim2 = prim.clone().setMaterial(doc.createMaterial('plain'));
  const mesh2 = doc.createMesh('grid2').addPrimitive(prim2);
  doc.createScene().addChild(doc.createNode('a').setMesh(mesh)).addChild(doc.createNode('b').setMesh(mesh2).setTranslation([2, 0, 0]));

  const dir = await mkdtemp(path.join(tmpdir(), 'wgm-test-'));
  const input = path.join(dir, 'grid.glb');
  await writeFile(input, await new NodeIO().writeBinary(doc));

  for (const textureFormat of ['rgba8', 'auto'] as const) {
    const res = await bakeFile(input, 'webgpu', { textureFormat, lods: 3 }, quiet);
    const f = readWgm(res.bytes);
    const m = f.manifest;
    assert.equal(m.target, 'webgpu');
    assert.equal(m.meshes.length, 2);
    const p = m.meshes[0].primitives[0];
    assert.equal(p.indices.format, 'uint16');
    assert.ok(p.streams.uv && p.streams.tangent, 'normal-mapped primitive needs uv + tangent streams');
    // MikkTSpace tangents: unit xyz, w = +-1.
    const v = f.section('vertex');
    const tan = new Float32Array(v.buffer, v.byteOffset + p.streams.tangent.byteOffset, p.vertexCount * 4);
    for (let i = 0; i < p.vertexCount; i++) {
      assert.ok(Math.abs(Math.hypot(tan[i * 4], tan[i * 4 + 1], tan[i * 4 + 2]) - 1) < 1e-3);
      assert.equal(Math.abs(tan[i * 4 + 3]), 1);
    }
    const q = m.meshes[1].primitives[0];
    assert.equal(q.streams.tangent, undefined, 'no tangents without a normal map');
    assert.equal(q.streams.position.byteOffset !== p.streams.position.byteOffset || !q.streams.uv, true);
    // One image used as colour and as normal map -> two entries (different colour space / codec).
    assert.equal(m.textures.length, 2);
    for (const t of m.textures) {
      assert.equal(t.encoding, textureFormat === 'rgba8' ? 'rgba8' : 'ktx2');
      assert.equal(t.mipLevelCount, 4);
      if (t.encoding === 'rgba8') assert.equal(t.levels!.length, 4);
      else {
        const k = f.section('texture').subarray(t.data.byteOffset, t.data.byteOffset + 12);
        assert.deepEqual([...k], [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
      }
    }
    assert.equal(m.textures.find((t) => t.usage === 'color')!.colorSpace, 'srgb');
    assert.equal(m.textures.find((t) => t.usage === 'normal')!.colorSpace, 'linear');
  }
});
