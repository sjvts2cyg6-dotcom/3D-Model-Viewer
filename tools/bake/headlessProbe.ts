/**
 * `--device auto`: run the probe page in headless Chrome on this machine and
 * read its DeviceProfile. Headless Chrome usually gets a software adapter
 * (SwiftShader), so this is a fallback, not a substitute for probing in a real
 * browser. Requires a built app (`npm run build` -> dist/probe.html).
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeviceProfileError, parseDeviceProfile } from './device';
import type { DeviceProfile } from '../../src/probe/profile';

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist');
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };
const GPU_FLAGS = '--enable-unsafe-webgpu --enable-unsafe-swiftshader --enable-features=Vulkan --use-vulkan=swiftshader ' +
  '--use-angle=swiftshader --use-webgpu-adapter=swiftshader';

export async function probeHeadless(opts: { chrome?: string; timeoutMs?: number } = {}): Promise<DeviceProfile> {
  if (!existsSync(path.join(DIST, 'probe.html'))) {
    throw new DeviceProfileError(`--device auto needs the built probe page (${path.join(DIST, 'probe.html')} missing): run npm run build`);
  }
  const server = createServer((req, res) => {
    const rel = decodeURIComponent((req.url ?? '/').split('?')[0]);
    const file = path.join(DIST, rel === '/' ? 'index.html' : rel);
    if (!file.startsWith(DIST + path.sep) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  const { default: puppeteer } = await import('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: opts.chrome ?? process.env.CHROME ?? '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox', ...(process.env.CHROME_GPU_FLAGS ?? GPU_FLAGS).split(/\s+/).filter(Boolean)],
  });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/probe.html`, { waitUntil: 'load' });
    await page.waitForFunction(() => {
      const s = (window as unknown as { __probe?: { state: string } }).__probe?.state;
      return s === 'done' || s === 'error';
    }, { timeout: opts.timeoutMs ?? 60_000, polling: 100 });
    const r = await page.evaluate(() => (window as unknown as { __probe: { state: string; profile?: unknown; error?: string } }).__probe);
    if (r.state !== 'done') throw new DeviceProfileError(`headless probe failed: ${r.error}`);
    return parseDeviceProfile(JSON.stringify(r.profile), 'headless probe');
  } finally {
    await browser.close();
    server.close();
  }
}
