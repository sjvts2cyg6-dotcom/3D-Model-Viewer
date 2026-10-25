/** Device profile -> options mapping, triangle budget, and the CLI's --json / exit-code interface. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDeviceProfile, type DeviceProfile } from '../../../src/probe/profile';
import { deriveOptions, parseDeviceProfile, DeviceProfileError } from '../device';
import { optimizeGeometry } from '../geometry';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const BASE: DeviceProfile = JSON.parse(readFileSync(path.join(ROOT, 'tools/local/test/fixtures/profile.json'), 'utf8'));
const variant = (patch: (p: DeviceProfile) => void): DeviceProfile => { const p = structuredClone(BASE); patch(p); return p; };

test('fixture profile (captured from the probe page) is valid', () => {
  assert.deepEqual(validateDeviceProfile(BASE), []);
  assert.throws(() => parseDeviceProfile('{"schema":"wgm-device-profile"}', 'x'), DeviceProfileError);
  assert.throws(() => parseDeviceProfile('nope', 'x'), DeviceProfileError);
});

test('deriveOptions: class, screen, limits and detail drive texture size and triangle budget', () => {
  const desktop = variant((p) => {
    p.deviceClass = 'desktop';
    Object.assign(p.display, { screenWidth: 2560, screenHeight: 1440, devicePixelRatio: 1 });
    p.platform.deviceMemoryGB = 8;
  });
  const phone = variant((p) => {
    p.deviceClass = 'mobile';
    Object.assign(p.display, { screenWidth: 390, screenHeight: 844, devicePixelRatio: 3 });
    p.gpu.textureCompression = { bc: false, astc: true, etc2: true };
    p.platform.deviceMemoryGB = 4;
  });
  const d = deriveOptions(desktop, 'medium');
  assert.equal(d.options.maxTextureSize, 4096);
  assert.equal(d.options.maxTriangles, 2_000_000);
  assert.match(d.decisions.join('\n'), /BC7/);
  const m = deriveOptions(phone, 'medium');
  assert.equal(m.options.maxTextureSize, 2048, 'mobile capped at 2048 for medium');
  assert.equal(m.options.maxTriangles, 300_000);
  assert.match(m.decisions.join('\n'), /ASTC/);
  assert.equal(deriveOptions(phone, 'low').options.maxTriangles, 75_000);
  assert.equal(deriveOptions(desktop, 'max').options.maxTriangles, 0, 'max = unlimited');
  const limited = variant((p) => { p.deviceClass = 'desktop'; p.gpu.limits.maxTextureDimension2D = 2048; p.platform.deviceMemoryGB = 8; });
  assert.ok(deriveOptions(limited, 'max').options.maxTextureSize! <= 2048, 'never above the device limit');
});

test('triangle budget: baseRatio simplifies LOD0 and keeps LOD invariants', async () => {
  const n = 64, positions: number[] = [], normals: number[] = [], indices: number[] = [];
  for (let y = 0; y <= n; y++) for (let x = 0; x <= n; x++) { positions.push(x / n, y / n, 0.05 * Math.sin(x * 0.4)); normals.push(0, 0, 1); }
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const a = y * (n + 1) + x; indices.push(a, a + 1, a + n + 2, a, a + n + 2, a + n + 1); }
  const src = { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices) };
  const full = await optimizeGeometry(src, { levels: 1, ratio: 0.5, maxError: 1 });
  const cut = await optimizeGeometry(src, { levels: 3, ratio: 0.5, maxError: 1, baseRatio: 0.25 });
  assert.ok(cut.lods[0].indexCount <= full.lods[0].indexCount * 0.3, `${cut.lods[0].indexCount} vs ${full.lods[0].indexCount}`);
  assert.ok(cut.vertexCount < full.vertexCount, 'unused vertices dropped');
  for (let i = 0; i < cut.lodIndices.length; i++) assert.ok(cut.lodIndices[i] < cut.vertexCount);
});

test('CLI --json: events, --device - from stdin, flags override device, exit codes', () => {
  const cli = [path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(ROOT, 'tools/bake/cli.ts')];
  const run = (args: string[], input?: string) => {
    const r = spawnSync(process.execPath, [...cli, ...args], { input, encoding: 'utf8', cwd: ROOT });
    return { code: r.status, events: r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) };
  };
  const p = run(['--device', '-', '--print-device', '--json'], JSON.stringify(BASE));
  assert.equal(p.code, 0);
  assert.deepEqual(p.events.map((e) => e.event), ['start', 'profile']);
  assert.equal(p.events[1].source, 'stdin');
  assert.equal(run(['--device', '-', '--print-device', '--json'], '{"bad":1}').code, 4);
  assert.equal(run(['missing.glb', '--json']).code, 3);
  assert.equal(run(['--nope', '--json']).code, 2);
  assert.equal(run(['--json']).events.at(-1).code, 'usage');
  // Bake: device says 1024 max texture (software); explicit flag wins and is reported.
  const tmpOut = path.join(ROOT, 'node_modules/.cache/wgm-device-test');
  const gltf = path.join(tmpOut, 'q.gltf');
  mkdirSync(tmpOut, { recursive: true });
  const buf = Buffer.concat([Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer)]);
  writeFileSync(gltf, JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: 36, uri: `data:application/octet-stream;base64,${buf.toString('base64')}` }],
    bufferViews: [{ buffer: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
  }));
  const b = run([gltf, '-o', tmpOut, '--device', '-', '--max-texture-size', '300', '--json'], JSON.stringify(BASE));
  assert.equal(b.code, 0, JSON.stringify(b.events));
  const dev = b.events.find((e) => e.event === 'device');
  assert.deepEqual(dev.overriddenByFlags, ['maxTextureSize']);
  const res = b.events.find((e) => e.event === 'result');
  assert.equal(res.options.maxTextureSize, 300);
  assert.equal(res.device.deviceClass, BASE.deviceClass);
});
