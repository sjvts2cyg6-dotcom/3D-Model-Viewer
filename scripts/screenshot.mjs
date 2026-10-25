// Headless render check: serves dist/ with `vite preview`, opens it in Chrome
// with a software (SwiftShader/Vulkan) WebGPU adapter, waits for frames and
// writes screenshot.png. Usage: npm run build && npm run screenshot
//   CHROME=/path/to/chrome  OUT=file.png  URL_QUERY="?model=/x.glb"
//   ASSETS_DIR=test-assets   serve a local folder at /local/ (e.g. URL_QUERY="?model=/local/baked/Box.wgm")
//   HIDE_HUD=1               hide the HUD overlay before capturing (for image diffs)
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { preview } from 'vite';
import puppeteer from 'puppeteer-core';

const chromePath = process.env.CHROME ?? '/usr/bin/google-chrome';
const out = process.env.OUT ?? 'screenshot.png';
const DEFAULT_GPU_FLAGS =
  '--enable-unsafe-webgpu --enable-unsafe-swiftshader --enable-features=Vulkan --use-vulkan=swiftshader ' +
  '--use-angle=swiftshader --use-webgpu-adapter=swiftshader';
const query = process.env.URL_QUERY ?? '';

const assetsDir = process.env.ASSETS_DIR ? path.resolve(process.env.ASSETS_DIR) : null;
const serveLocal = {
  name: 'serve-local-assets',
  configurePreviewServer(server) {
    if (!assetsDir) return;
    server.middlewares.use('/local', (req, res, next) => {
      const file = path.join(assetsDir, decodeURIComponent((req.url ?? '/').split('?')[0]));
      if (!file.startsWith(assetsDir + path.sep)) return next();
      let st;
      try { st = statSync(file); } catch { return next(); }
      if (!st.isFile()) return next();
      res.setHeader('Content-Length', st.size);
      res.setHeader('Content-Type', 'application/octet-stream');
      createReadStream(file).pipe(res);
    });
  },
};

const server = await preview({ plugins: [serveLocal], preview: { port: 4179, strictPort: false, host: '127.0.0.1' } });
const url = `${server.resolvedUrls.local[0]}${query}`;
const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  dumpio: !!process.env.DUMPIO,
  args: [
    '--no-sandbox',
    '--window-size=1280,800',
    ...(process.env.CHROME_GPU_FLAGS ?? DEFAULT_GPU_FLAGS).split(/\s+/).filter(Boolean),
  ],
});
let code = 0;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  page.on('console', (m) => console.log(`[page:${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(
    () => window.__engine?.error || (window.__engine?.framesRendered ?? 0) >= 20,
    { timeout: 120_000, polling: 250 },
  );
  const state = await page.evaluate(() => {
    const e = window.__engine ?? {};
    return { framesRendered: e.framesRendered, ready: e.ready, error: e.error, loadMs: e.loadMs, loadStats: e.loadStats, hud: document.getElementById('hud')?.textContent };
  });
  if (process.env.HIDE_HUD) await page.evaluate(() => { document.getElementById('hud').style.display = 'none'; });
  console.log('engine state:', JSON.stringify(state));
  await page.screenshot({ path: out });
  console.log(`wrote ${out}`);
  if (state.error) code = 1;
} catch (e) {
  console.error(e);
  code = 1;
} finally {
  await browser.close();
  await new Promise((r) => server.httpServer.close(r));
}
process.exit(code);
