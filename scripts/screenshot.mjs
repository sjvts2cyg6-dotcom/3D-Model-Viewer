// Headless render check: serves dist/ with `vite preview`, opens it in Chrome
// with a software (SwiftShader/Vulkan) WebGPU adapter, waits for frames and
// writes screenshot.png. Usage: npm run build && npm run screenshot
//   CHROME=/path/to/chrome  OUT=file.png  URL_QUERY="?model=/x.glb"
import { preview } from 'vite';
import puppeteer from 'puppeteer-core';

const chromePath = process.env.CHROME ?? '/usr/bin/google-chrome';
const out = process.env.OUT ?? 'screenshot.png';
const DEFAULT_GPU_FLAGS =
  '--enable-unsafe-webgpu --enable-unsafe-swiftshader --enable-features=Vulkan --use-vulkan=swiftshader ' +
  '--use-angle=swiftshader --use-webgpu-adapter=swiftshader';
const query = process.env.URL_QUERY ?? '';

const server = await preview({ preview: { port: 4179, strictPort: false, host: '127.0.0.1' } });
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
  const state = await page.evaluate(() => ({ ...window.__engine, hud: document.getElementById('hud')?.textContent }));
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
