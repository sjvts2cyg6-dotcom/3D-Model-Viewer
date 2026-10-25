/**
 * Device measurement for the probe page. Runs in any browser; WebGPU is
 * optional (a profile with gpu.available = false is still valid).
 */
import { DEVICE_PROFILE_SCHEMA, DEVICE_PROFILE_VERSION, type DeviceClass, type DeviceProfile } from './profile';

export const PROBE_VERSION = '1.0.0';

const LIMIT_KEYS = [
  'maxTextureDimension2D', 'maxTextureArrayLayers', 'maxBufferSize', 'maxStorageBufferBindingSize',
  'maxUniformBufferBindingSize', 'maxVertexBuffers', 'maxVertexAttributes', 'maxBindGroups',
  'maxSampledTexturesPerShaderStage', 'maxColorAttachments', 'maxComputeWorkgroupStorageSize',
] as const;

const BENCH_WGSL = /* wgsl */ `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = array(vec2f(-1, -3), vec2f(3, 1), vec2f(-1, 1));
  return vec4f(p[i], 0, 1);
}
@fragment fn fs(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  var c = fc.xy * 0.001;
  for (var k = 0; k < 16; k++) { c = vec2f(sin(c.x * 1.7 + c.y), cos(c.y * 1.3 - c.x)); }
  return vec4f(c * 0.5 + 0.5, 0, 1);
}`;

/** Fixed workload: N full-screen passes into a 1024² target; time to queue completion. */
async function benchmark(device: GPUDevice): Promise<DeviceProfile['benchmark']> {
  const size = 1024, passes = 8;
  const module = device.createShaderModule({ code: BENCH_WGSL });
  const pipeline = device.createRenderPipeline({
    layout: 'auto', vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
  });
  const target = device.createTexture({ size: [size, size], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT });
  const run = async (n: number) => {
    const enc = device.createCommandEncoder();
    for (let i = 0; i < n; i++) {
      const pass = enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store' }] });
      pass.setPipeline(pipeline);
      pass.draw(3);
      pass.end();
    }
    const t = performance.now();
    device.queue.submit([enc.finish()]);
    await device.queue.onSubmittedWorkDone();
    return performance.now() - t;
  };
  await run(1); // warm-up (pipeline compile)
  const ms = await run(passes);
  target.destroy();
  return { fillRateMPixPerSec: Math.round((size * size * passes) / 1e6 / (ms / 1000)), ms: Math.round(ms * 10) / 10 };
}

function classify(p: Omit<DeviceProfile, 'deviceClass'>): DeviceClass {
  const desc = `${p.gpu.vendor} ${p.gpu.architecture} ${p.gpu.description}`.toLowerCase();
  if (!p.gpu.available || p.gpu.isFallbackAdapter || /swiftshader|llvmpipe|software|warp/.test(desc)) return 'software';
  if (p.platform.mobile || (p.platform.maxTouchPoints > 0 && !p.gpu.textureCompression.bc)) return 'mobile';
  return 'desktop';
}

export async function measureDevice(opts: { benchmark?: boolean } = {}): Promise<DeviceProfile> {
  const nav = navigator as Navigator & { deviceMemory?: number; userAgentData?: { mobile?: boolean } };
  const ua = nav.userAgent;
  const gamut = matchMedia('(color-gamut: rec2020)').matches ? 'rec2020' : matchMedia('(color-gamut: p3)').matches ? 'p3' : 'srgb';
  const base: Omit<DeviceProfile, 'deviceClass'> = {
    schema: DEVICE_PROFILE_SCHEMA,
    version: DEVICE_PROFILE_VERSION,
    probedAt: new Date().toISOString(),
    probe: { name: 'webgpu-engine-probe', version: PROBE_VERSION, headless: !!nav.webdriver || /HeadlessChrome/.test(ua) },
    platform: {
      userAgent: ua,
      mobile: nav.userAgentData?.mobile ?? /Android|iPhone|iPad|Mobile/i.test(ua),
      hardwareConcurrency: nav.hardwareConcurrency ?? 1,
      deviceMemoryGB: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
      maxTouchPoints: nav.maxTouchPoints ?? 0,
    },
    display: {
      screenWidth: screen.width, screenHeight: screen.height, devicePixelRatio: devicePixelRatio || 1,
      viewportWidth: innerWidth, viewportHeight: innerHeight,
      colorGamut: gamut, hdr: matchMedia('(dynamic-range: high)').matches,
    },
    gpu: {
      available: false, vendor: '', architecture: '', device: '', description: '', isFallbackAdapter: false,
      features: [], limits: {}, preferredCanvasFormat: '', textureCompression: { bc: false, astc: false, etc2: false },
    },
    benchmark: { fillRateMPixPerSec: null, ms: null },
  };

  const adapter = 'gpu' in navigator && navigator.gpu
    ? await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }).catch(() => null)
    : null;
  if (adapter) {
    const info = (adapter as GPUAdapter & { info?: GPUAdapterInfo & { isFallbackAdapter?: boolean } }).info;
    const features = [...adapter.features].map(String).sort();
    const limits: Record<string, number> = {};
    for (const k of LIMIT_KEYS) limits[k] = Number((adapter.limits as unknown as Record<string, number>)[k]);
    base.gpu = {
      available: true,
      vendor: info?.vendor ?? '', architecture: info?.architecture ?? '', device: info?.device ?? '', description: info?.description ?? '',
      isFallbackAdapter: !!(info?.isFallbackAdapter ?? (adapter as unknown as { isFallbackAdapter?: boolean }).isFallbackAdapter),
      features, limits,
      preferredCanvasFormat: navigator.gpu.getPreferredCanvasFormat(),
      textureCompression: {
        bc: features.includes('texture-compression-bc'),
        astc: features.includes('texture-compression-astc'),
        etc2: features.includes('texture-compression-etc2'),
      },
    };
    if (opts.benchmark !== false) {
      try {
        const device = await adapter.requestDevice();
        base.benchmark = await benchmark(device);
        device.destroy();
      } catch { /* benchmark is best-effort */ }
    }
  }
  return { ...base, deviceClass: classify(base) };
}
