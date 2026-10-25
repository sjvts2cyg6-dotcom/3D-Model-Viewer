#!/usr/bin/env node
// Headless stand-in for "the user's default browser", for tests and display-less
// boxes: `--browser-cmd "node scripts/headless-browser.mjs"`. Opens the URL in
// headless Chrome (SwiftShader WebGPU) and behaves like a user who leaves the
// tab open until the page finished its job:
//   probe page  -> waits until it reported (or failed)
//   viewer page -> waits until 5 frames rendered
// STANDIN_ACTION=close   closes the probe tab as soon as it starts (user closed the page)
// STANDIN_LOG=<file>     append one JSON line per page with what happened
import { appendFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const url = process.argv[2];
if (!url) { console.error('usage: headless-browser.mjs <url>'); process.exit(2); }
const flags = (process.env.CHROME_GPU_FLAGS ??
  '--enable-unsafe-webgpu --enable-unsafe-swiftshader --enable-features=Vulkan --use-vulkan=swiftshader ' +
  '--use-angle=swiftshader --use-webgpu-adapter=swiftshader').split(/\s+/).filter(Boolean);
const log = (o) => { if (process.env.STANDIN_LOG) appendFileSync(process.env.STANDIN_LOG, JSON.stringify({ t: Date.now(), url, ...o }) + '\n'); };

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/usr/bin/google-chrome', headless: true,
  args: ['--no-sandbox', '--window-size=1280,800', ...flags],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(url, { waitUntil: 'load' });
  const isProbe = new URL(url).pathname.endsWith('probe.html');
  if (isProbe && process.env.STANDIN_ACTION === 'close') {
    await page.close({ runBeforeUnload: true });
    log({ action: 'closed' });
  } else if (isProbe) {
    await page.waitForFunction(() => window.__probe && (['sent', 'failed'].includes(window.__probe.report) || window.__probe.state === 'error'),
      { timeout: 120_000, polling: 100 });
    log({ action: 'probe', probe: await page.evaluate(() => ({ state: window.__probe.state, report: window.__probe.report, reportError: window.__probe.reportError })) });
  } else {
    await page.waitForFunction(() => window.__engine?.error || (window.__engine?.framesRendered ?? 0) >= 5, { timeout: 120_000, polling: 100 });
    log({ action: 'viewer', engine: await page.evaluate(() => ({ frames: window.__engine.framesRendered, error: window.__engine.error ?? null, loadStats: window.__engine.loadStats ?? null })) });
  }
} catch (e) {
  log({ action: 'error', message: String(e?.message ?? e) });
  process.exitCode = 1;
} finally {
  await browser.close();
}
