// Compiles every shader feature variant and builds its pipelines on a real
// (SwiftShader) WebGPU device, so disabled-by-default features such as
// SHADOWS can't silently rot. Usage: npm run check:shaders
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';

const FLAGS = (process.env.CHROME_GPU_FLAGS ??
  '--enable-unsafe-webgpu --enable-unsafe-swiftshader --enable-features=Vulkan --use-vulkan=swiftshader ' +
  '--use-angle=swiftshader --use-webgpu-adapter=swiftshader').split(/\s+/);

const server = await createServer({ server: { port: 4181, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME ?? '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', ...FLAGS],
});
let failed = false;
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:4181/index.html?msaa=1`);
  const results = await page.evaluate(async () => {
    const r = await import('/src/renderer/index.ts');
    const device = await (await navigator.gpu.requestAdapter()).requestDevice();
    const out = [];
    for (const features of [{ shadows: false }, { shadows: true }]) {
      const cache = new r.PipelineCache(device, r.createSharedLayouts(device), 'rgba8unorm-srgb', 4);
      const info = await cache.shaderModule(features).getCompilationInfo();
      const errors = info.messages.filter((m) => m.type === 'error').map((m) => `${m.lineNum}:${m.linePos} ${m.message}`);
      device.pushErrorScope('validation');
      for (const mode of ['OPAQUE', 'MASK', 'BLEND']) for (const ds of [false, true]) cache.get(features, mode, ds);
      r.createFrameLayout(device, features);
      const v = await device.popErrorScope();
      out.push({ variant: r.featureKey(features) || 'base', uniformBytes: r.frameUniformSize(features), compileErrors: errors, validation: v?.message ?? null });
    }
    return out;
  });
  for (const x of results) {
    console.log(JSON.stringify(x));
    if (x.compileErrors.length || x.validation) failed = true;
  }
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  await browser.close();
  await server.close();
}
console.log(failed ? 'shader variant check FAILED' : 'shader variant check OK');
process.exit(failed ? 1 : 0);
