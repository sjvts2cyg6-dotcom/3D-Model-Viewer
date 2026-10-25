/**
 * Orchestrator tests: runs `tools/local/cli.ts` as a process against the real
 * baker CLI and the real (built) probe page, with headless Chrome standing in
 * for the user's browser. Also checks the orchestrator's import graph.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startLocalServer } from '../server';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const LOCAL = path.join(ROOT, 'tools/local');
const TSX = path.join(ROOT, 'node_modules/tsx/dist/cli.mjs');
const FIX = path.join(LOCAL, 'test/fixtures');
const STANDIN = `${process.execPath} ${path.join(ROOT, 'scripts/headless-browser.mjs')}`;
const tmp = mkdtempSync(path.join(os.tmpdir(), 'wgm-local-'));
const cacheDir = path.join(tmp, 'cfg');

// A tiny glTF (two triangles, positions + indices) so the test needs no sample assets.
const MODEL = path.join(tmp, 'quad.gltf');
{
  const pos = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  const idx = new Uint16Array([0, 1, 2, 0, 2, 3]);
  const buf = Buffer.concat([Buffer.from(pos.buffer), Buffer.from(idx.buffer)]);
  writeFileSync(MODEL, JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: buf.length, uri: `data:application/octet-stream;base64,${buf.toString('base64')}` }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 48 }, { buffer: 0, byteOffset: 48, byteLength: 12 }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
  }));
}

interface Ev { event: string; t: number; [k: string]: any }

function runLocal(args: string[], env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; events: Ev[]; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TSX, path.join(LOCAL, 'cli.ts'), ...args, '--json', '--cache-dir', cacheDir],
      { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => resolve({
      code, stderr: err,
      events: out.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Ev),
    }));
  });
}
const states = (evs: Ev[]) => evs.filter((e) => e.event === 'state').map((e) => e.to as string);
const first = (evs: Ev[], pred: (e: Ev) => boolean) => evs.findIndex(pred);

test('setup: built probe page exists (vite build)', () => {
  if (!existsSync(path.join(ROOT, 'dist/probe.html'))) {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: ROOT, stdio: 'ignore' });
    assert.equal(r.status, 0, 'vite build failed');
  }
  assert.ok(existsSync(path.join(ROOT, 'dist/probe.html')));
});

test('import graph: orchestrator only imports node built-ins and its own modules', () => {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    const specs = [...src.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm)]
      .map((m) => m[1] ?? m[2] ?? m[3]);
    for (const s of specs) {
      if (s.startsWith('node:')) continue;
      assert.ok(s.startsWith('./'), `${path.relative(ROOT, file)} imports "${s}" (only node: built-ins and ./ siblings allowed)`);
      const target = path.resolve(path.dirname(file), s.endsWith('.ts') ? s : `${s}.ts`);
      assert.ok(target.startsWith(LOCAL + path.sep) && !target.includes(`${path.sep}test${path.sep}`), `${s} escapes tools/local`);
      visit(target);
    }
  };
  for (const f of readdirSync(LOCAL).filter((f) => f.endsWith('.ts'))) visit(path.join(LOCAL, f));
  assert.ok(seen.size >= 4);
  for (const f of seen) assert.ok(!/tools[\\/]bake|[\\/]src[\\/]/.test(path.relative(ROOT, f)), f);
});

test('server: loopback only, rejects wrong token / malformed profiles, token is one-time', async () => {
  const rejected: number[] = [];
  const s = await startLocalServer({ appDir: path.join(ROOT, 'dist'), onRejected: (r) => rejected.push(r.status) });
  try {
    assert.match(s.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    const post = (b: string) => fetch(s.reportUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: b });
    assert.equal((await post('{')).status, 400);
    assert.equal((await post(JSON.stringify({ type: 'profile', token: 'x'.repeat(48), profile: {} }))).status, 403);
    assert.equal((await post(JSON.stringify({ type: 'profile', token: s.token, profile: { schema: 'nope' } }))).status, 400);
    const cached = JSON.parse(readFileSync(path.join(FIX, 'profile.json'), 'utf8'));
    const next = s.nextReport();
    assert.equal((await post(JSON.stringify({ type: 'profile', token: s.token, profile: cached }))).status, 200);
    assert.equal((await next).kind, 'profile');
    assert.equal((await post(JSON.stringify({ type: 'profile', token: s.token, profile: cached }))).status, 409, 'token reused');
    assert.equal((await fetch(`${s.origin}/../../etc/passwd`)).status, 404);
    assert.equal((await fetch(`${s.origin}/probe.html`)).status, 200);
    assert.deepEqual(rejected, [400, 403, 400, 409]);
  } finally { await s.close(); }
});

test('happy path: probe reports first, then the real baker runs with that profile; --open serves the viewer', async () => {
  const log = path.join(tmp, 'standin.log');
  const out = path.join(tmp, 'out');
  const r = await runLocal([MODEL, '-o', out, '--browser-cmd', STANDIN, '--probe-timeout', '90', '--detail', 'low', '--lods', '2', '--open', '--serve-for', '15'],
    { STANDIN_LOG: log });
  assert.equal(r.code, 0, r.stderr + JSON.stringify(r.events.filter((e) => e.event === 'error')));
  assert.deepEqual(states(r.events), ['probing', 'profile-received', 'baking', 'done']);
  const iProfile = first(r.events, (e) => e.event === 'profile');
  const iSpawn = first(r.events, (e) => e.event === 'baker-spawned');
  const iBakerFirst = first(r.events, (e) => e.event === 'baker');
  assert.equal(r.events[iProfile].source, 'browser');
  assert.ok(iProfile >= 0 && iSpawn > iProfile && iBakerFirst > iSpawn, 'baker must start after the profile arrived');
  assert.ok(r.events[iSpawn].t >= r.events[iProfile].t);
  const spawnArgs: string[] = r.events[iSpawn].args;
  assert.deepEqual(spawnArgs.slice(-4), ['--detail', 'low', '--lods', '2'], 'knobs passed through');
  assert.ok(spawnArgs.includes('--device') && spawnArgs[spawnArgs.indexOf('--device') + 1] === '-');
  // Baker received the profile over stdin and used it.
  const dev = r.events.find((e) => e.event === 'baker' && e.data.event === 'device');
  assert.equal(dev?.data.source, 'stdin');
  const res = r.events.find((e) => e.event === 'baker' && e.data.event === 'result');
  const file = res!.data.output as string;
  assert.equal(readFileSync(file).subarray(0, 4).toString('latin1'), 'WGMB');
  assert.equal(res!.data.device.detail, 'low');
  assert.equal(res!.data.device.source, 'stdin');
  // Cache written from the browser profile.
  const cache = JSON.parse(readFileSync(path.join(cacheDir, 'device-profile.json'), 'utf8'));
  assert.equal(cache.source, 'browser');
  assert.equal(cache.profile.schema, 'wgm-device-profile');
  // Viewer opened on the baked file and rendered it.
  const viewer = r.events.find((e) => e.event === 'viewer');
  assert.match(viewer!.url, /\?model=\/out\/quad\.wgm$/);
  const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines[0].probe.report, 'sent');
  const v = lines.find((l) => l.action === 'viewer');
  assert.ok(v && v.engine.frames >= 5 && !v.engine.error, JSON.stringify(lines));
  assert.equal(v.engine.loadStats.format, 'wgm');
});

test('timeout: no report -> stops with exit 10 and never starts the baker', async () => {
  const marker = path.join(tmp, 'spy-timeout');
  const r = await runLocal([MODEL, '-o', path.join(tmp, 'o2'), '--browser-cmd', `${process.execPath} ${FIX}/noop-browser.mjs`,
    '--probe-timeout', '2', '--baker-cmd', `${process.execPath} ${FIX}/spy-baker.mjs`], { SPY_MARKER: marker });
  assert.equal(r.code, 10);
  assert.deepEqual(states(r.events), ['probing', 'error']);
  assert.ok(!existsSync(marker), 'baker was spawned');
  assert.equal(r.events.find((e) => e.event === 'error')?.bakerSpawned, false);
  assert.ok(!existsSync(path.join(tmp, 'o2')));
});

test('malformed and wrong-token reports are rejected; still no bake', async () => {
  const marker = path.join(tmp, 'spy-bad');
  const log = path.join(tmp, 'bad.log');
  const r = await runLocal([MODEL, '--browser-cmd', `${process.execPath} ${FIX}/bad-reporter.mjs`, '--probe-timeout', '4',
    '--baker-cmd', `${process.execPath} ${FIX}/spy-baker.mjs`], { SPY_MARKER: marker, STANDIN_LOG: log });
  assert.equal(r.code, 10);
  assert.deepEqual(r.events.filter((e) => e.event === 'report-rejected').map((e) => e.status), [400, 403, 400]);
  assert.deepEqual(JSON.parse(readFileSync(log, 'utf8')).statuses, [400, 403, 400]);
  assert.ok(!existsSync(marker));
});

test('user closes the probe page -> exit 11, no bake', async () => {
  const marker = path.join(tmp, 'spy-closed');
  const r = await runLocal([MODEL, '--browser-cmd', STANDIN, '--probe-timeout', '60',
    '--baker-cmd', `${process.execPath} ${FIX}/spy-baker.mjs`], { SPY_MARKER: marker, STANDIN_ACTION: 'close' });
  assert.equal(r.code, 11, JSON.stringify(r.events));
  assert.equal(r.events.find((e) => e.event === 'probe-failed')?.code, 'probe-closed');
  assert.ok(!existsSync(marker));
});

test('no display and no --browser-cmd -> exit 12, no bake', async () => {
  const marker = path.join(tmp, 'spy-nobrowser');
  const r = await runLocal([MODEL, '--baker-cmd', `${process.execPath} ${FIX}/spy-baker.mjs`],
    { SPY_MARKER: marker, DISPLAY: '', WAYLAND_DISPLAY: '', WGM_BROWSER: '' });
  assert.equal(r.code, 12);
  assert.ok(!existsSync(marker));
});

test('--allow-cached: after a probe timeout the cached profile is used (stated as source cache)', async () => {
  const r = await runLocal([MODEL, '-o', path.join(tmp, 'o3'), '--browser-cmd', `${process.execPath} ${FIX}/noop-browser.mjs`,
    '--probe-timeout', '1', '--allow-cached']);
  assert.equal(r.code, 0, JSON.stringify(r.events.filter((e) => e.event === 'error')));
  assert.equal(r.events.find((e) => e.event === 'profile')?.source, 'cache');
  assert.ok(first(r.events, (e) => e.event === 'probe-failed') < first(r.events, (e) => e.event === 'baker-spawned'));
  assert.ok(existsSync(path.join(tmp, 'o3/quad.wgm')));
});

test('--fallback-headless: baker --device auto --print-device probes first, then a separate bake', async () => {
  const r = await runLocal([MODEL, '-o', path.join(tmp, 'o4'), '--browser-cmd', '/nonexistent/browser',
    '--probe-timeout', '5', '--fallback-headless', '--no-cache']);
  assert.equal(r.code, 0, JSON.stringify(r.events.filter((e) => e.event === 'error')));
  assert.equal(r.events.find((e) => e.event === 'probe-failed')?.code, 'browser-failed');
  assert.equal(r.events.find((e) => e.event === 'profile')?.source, 'headless');
  const iProfile = first(r.events, (e) => e.event === 'profile');
  const iSpawn = first(r.events, (e) => e.event === 'baker-spawned');
  assert.ok(iSpawn > iProfile);
  assert.ok(r.events.slice(0, iProfile).every((e) => e.event !== 'baker' || e.phase === 'probe'));
  assert.ok(existsSync(path.join(tmp, 'o4/quad.wgm')));
});
