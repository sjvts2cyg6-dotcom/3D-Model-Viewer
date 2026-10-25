/** Vertex quantization: error bounds, octahedral round trips, precision selection, native texture encoders. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO } from '@gltf-transform/core';
import {
  chooseNormals, chooseTangents, chooseUvs, DEFAULT_TOLERANCE, encodeNormals, encodeTangents, fromHalf, fromSnorm,
  octDecode, octEncode, packOctSign, quantizePositions, toHalf, unpackOctSign,
} from '../quantize';
import { encodeNative } from '../textures/native';
import { targetSize } from '../textures/image';
import { readWgm, textureLevelBytes } from '../../../src/assets/wgm/format';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function rng(seed: number) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
function randomUnit(n: number, comps: 3 | 4, seed = 1): Float32Array {
  const r = rng(seed), out = new Float32Array(n * comps);
  for (let i = 0; i < n; i++) {
    let x = r() * 2 - 1, y = r() * 2 - 1, z = r() * 2 - 1;
    const l = Math.hypot(x, y, z) || 1; x /= l; y /= l; z /= l;
    out.set(comps === 3 ? [x, y, z] : [x, y, z, r() < 0.5 ? -1 : 1], i * comps);
  }
  // Include the axes and octahedron edges (the hard cases).
  const special = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [0.7071, 0, -0.7071]];
  special.forEach((v, i) => out.set(comps === 3 ? v : [...v, i % 2 ? -1 : 1], i * comps));
  return out;
}

test('half floats round-trip within 2^-11 relative', () => {
  for (const v of [0, 1, -1, 0.5, 0.123456, 3.75, 65504, 1e-5, -2.5e-3]) {
    const h = fromHalf(toHalf(v));
    assert.ok(Math.abs(h - v) <= Math.abs(v) * 2 ** -11 + 2 ** -24, `${v} -> ${h}`);
  }
});

test('positions: unorm16 grid error <= half a step per axis, zero extent handled', () => {
  const r = rng(7), n = 1000, p = new Float32Array(n * 3);
  for (let i = 0; i < p.length; i++) p[i] = i % 3 === 2 ? 0.25 : r() * 10 - 3; // flat in z
  const q = quantizePositions(p, [-3, -3, 0.25], [7, 7, 0.25]);
  assert.equal(q.data.length, n * 4);
  assert.equal(q.scale[2], 0);
  const halfStep = 10 / 65535 / 2;
  assert.ok(q.maxError <= Math.hypot(halfStep, halfStep) * 1.001, `max ${q.maxError}`);
  for (let i = 0; i < n; i++) assert.equal(q.data[i * 4 + 2] * q.scale[2] + q.offset[2], 0.25);
});

test('normals and tangents: snorm8 < 1°, snorm16 and oct16 < 0.02°, tangent sign always exact', () => {
  const n = randomUnit(5000, 3);
  assert.ok(encodeNormals(n, 'snorm8x4').maxError < 1);
  assert.ok(encodeNormals(n, 'snorm16x4').maxError < 0.02);
  assert.ok(encodeNormals(n, 'snorm16x2').maxError < 0.02);
  const t = randomUnit(5000, 4, 3);
  for (const f of ['snorm8x4', 'snorm16x4', 'snorm16x2'] as const) {
    const e = encodeTangents(t, f);
    assert.ok(e.maxError < (f === 'snorm8x4' ? 1 : 0.02), `${f} ${e.maxError}`);
    const d = e.data as Int8Array | Int16Array;
    for (let i = 0; i < 5000; i++) {
      const w = t[i * 4 + 3];
      if (f === 'snorm16x2') assert.equal(unpackOctSign(fromSnorm(d[i * 2 + 1], 16))[1], w);
      else assert.equal(Math.sign(d[i * 4 + 3]), w);
    }
  }
  // oct encode/decode is exact before quantization, including the lower hemisphere.
  for (const v of [[0, 0, -1], [0.6, -0.8, 0], [0.5773, 0.5773, -0.5773]]) {
    const d = octDecode(...octEncode(v[0], v[1], v[2]));
    assert.ok(Math.hypot(d[0] - v[0], d[1] - v[1], d[2] - v[2]) < 1e-3, `${v} -> ${d}`);
  }
  assert.deepEqual(unpackOctSign(packOctSign(-1, -1)).map((x) => Math.round(x * 1e6) / 1e6), [-1, -1]);
  assert.deepEqual(unpackOctSign(packOctSign(1, 1)).map((x) => Math.round(x * 1e6) / 1e6), [1, 1]);
});

test('precision selection follows the tolerance and the --vertex-precision override', () => {
  const n = randomUnit(2000, 3);
  const tol = { ...DEFAULT_TOLERANCE };
  assert.equal(chooseNormals(n, 'auto', 'auto', { ...tol, normalDegrees: 1 }).stream.format, 'snorm8x4');
  assert.equal(chooseNormals(n, 'auto', 'auto', { ...tol, normalDegrees: 0.05 }).stream.format, 'snorm16x4');
  assert.equal(chooseNormals(n, 'auto', 'oct', { ...tol, normalDegrees: 0.05 }).stream.format, 'snorm16x2');
  assert.equal(chooseNormals(n, 'auto', 'auto', { ...tol, normalDegrees: 0.0001 }).stream.format, 'float32x3');
  assert.equal(chooseNormals(n, 'full', 'auto', tol).stream.format, 'float32x3');
  assert.equal(chooseNormals(n, 'low', 'auto', { ...tol, normalDegrees: 0.0001 }).stream.format, 'snorm8x4');
  assert.equal(chooseTangents(randomUnit(100, 4), 'auto', 'auto', tol).stream.format, 'snorm8x4');
  // A degenerate (zero) tangent, as MikkTSpace emits for collapsed UVs, must not force float32.
  const withZero = randomUnit(100, 4); withZero.set([0, 0, 0, 1], 50 * 4);
  assert.equal(chooseTangents(withZero, 'auto', 'auto', tol).stream.format, 'snorm8x4');
  const nZero = randomUnit(100, 3); nZero.set([0, 0, 0], 30);
  assert.equal(chooseNormals(nZero, 'auto', 'auto', tol).stream.format, 'snorm8x4');
  const inside = Float32Array.from({ length: 200 }, (_, i) => (i % 17) / 16);
  const outside = Float32Array.from(inside, (v) => v * 4 - 1.5);
  assert.equal(chooseUvs(inside, 'auto', 2048, tol).stream.format, 'unorm16x2');
  assert.equal(chooseUvs(outside, 'auto', 64, tol).stream.format, 'float16x2', 'outside [0,1], small texture -> half');
  assert.equal(chooseUvs(Float32Array.from(inside, (v) => v * 1000 + 0.3), 'auto', 4096, tol).stream.format, 'float32x2', 'huge UVs need float32');
  assert.equal(chooseUvs(inside, 'full', 2048, tol).stream.format, 'float32x2');
});

test('native encoders: exact block sizes for bc7, astc 4x4/6x6, etc2 and rgba8; level 0 in whole blocks', async () => {
  const w = 40, h = 24, data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([(i * 7) & 255, (i * 3) & 255, 128, 255], i * 4);
  const img = { width: w, height: h, data };
  const base = { usage: 'color' as const, srgb: true, hasAlpha: false, astcBlock: '4x4' as const, uastcLevel: 1, astcQuality: 'fast' as const };
  for (const [fmt, block, want] of [['bc7', '4x4', 'bc7-rgba-unorm-srgb'], ['astc', '4x4', 'astc-4x4-unorm-srgb'], ['etc2', '4x4', 'etc2-rgb8unorm-srgb'], ['rgba8', '4x4', 'rgba8unorm-srgb']] as const) {
    const t = await encodeNative(img, fmt, 'srgb', { ...base, astcBlock: block });
    assert.equal(t.format, want);
    assert.equal(t.levels.length, 6);
    for (const l of t.levels) assert.equal(l.data.byteLength, textureLevelBytes(t.format, l.width, l.height));
  }
  const a = await encodeNative({ width: 36, height: 24, data: new Uint8Array(36 * 24 * 4).fill(200) }, 'astc', 'linear', { ...base, srgb: false, usage: 'data', astcBlock: '6x6' });
  assert.equal(a.format, 'astc-6x6-unorm');
  assert.equal(a.levels[0].data.byteLength, 6 * 4 * 16);
  const alpha = await encodeNative(img, 'etc2', 'srgb', { ...base, hasAlpha: true });
  assert.equal(alpha.format, 'etc2-rgba8unorm-srgb');
  assert.deepEqual(targetSize(1000, 600, 512, [6, 6]), [510, 306]);
  assert.deepEqual(targetSize(2048, 2048, 2048, [6, 6]), [2046, 2046], 'rounded down, never above the cap');
});

test('CLI: --texture-format each writes one file per native format; presets resolve', () => {
  const doc = new Document();
  const buf = doc.createBuffer();
  const prim = doc.createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setBuffer(buf).setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])))
    .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setBuffer(buf).setArray(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1])));
  doc.createScene().addChild(doc.createNode('n').setMesh(doc.createMesh('m').addPrimitive(prim)));
  const dir = mkdtempSync(path.join(tmpdir(), 'wgm-each-'));
  const input = path.join(dir, 'tri.glb');
  return new NodeIO().writeBinary(doc).then((b) => {
    writeFileSync(input, b);
    const run = (...args: string[]) => spawnSync(process.execPath, [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(ROOT, 'tools/bake/cli.ts'), input, '--json', ...args], { encoding: 'utf8' });
    const r = run('--texture-format', 'each', '-o', path.join(dir, 'each'));
    assert.equal(r.status, 0, r.stderr);
    const events = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(events.filter((e) => e.event === 'output').length, 4);
    const result = events.find((e) => e.event === 'result');
    assert.match(result.output, /tri\.\{tex\}\.wgm$/);
    assert.deepEqual(readdirSync(path.join(dir, 'each')).sort(), ['tri.astc.wgm', 'tri.bc7.wgm', 'tri.etc2.wgm', 'tri.rgba8.wgm']);
    const p = run('--device', 'phone', '--detail', 'low', '-o', path.join(dir, 'phone'));
    assert.equal(p.status, 0, p.stderr);
    const dev = p.stdout.trim().split('\n').map((l) => JSON.parse(l)).find((e) => e.event === 'device');
    assert.equal(dev.options.textureFormat, 'astc');
    assert.equal(dev.options.astcBlock, '6x6');
    const f = readWgm(new Uint8Array(readFileSync(path.join(dir, 'phone', 'tri.wgm'))));
    assert.equal(f.manifest.meshes[0].primitives[0].streams.position.format, 'unorm16x4');
  });
});
