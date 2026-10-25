import { FrameLoop, initGpu, observeCanvasSize, WebGPUUnsupportedError } from './core';
import { Renderer } from './renderer';
import { PerspectiveCamera, Scene, computeWorldBounds } from './scene';
import { loadModel, TEXTURE_COMPRESSION_FEATURES, type TranscodeTarget } from './assets';
import { OrbitControls } from './controls';

declare global {
  interface Window {
    /** Exposed for automated screenshot tests. */
    __engine?: {
      framesRendered: number; ready: boolean; error?: string;
      /** Time from fetch start to the model being in the scene (ms). */
      loadMs?: number;
      loadStats?: Record<string, number | string>;
      renderer?: Renderer;
    };
  }
}

const canvas = document.getElementById('view') as HTMLCanvasElement;
const hud = document.getElementById('hud') as HTMLDivElement;
const errorBox = document.getElementById('error') as HTMLDivElement;
const status: NonNullable<Window['__engine']> = (window.__engine = { framesRendered: 0, ready: false });

function showError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  status.error = msg;
  console.error(err);
  errorBox.textContent = err instanceof WebGPUUnsupportedError ? `WebGPU unavailable: ${msg}` : `Error: ${msg}`;
  errorBox.style.display = 'flex';
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const modelUrl = params.get('model');
  const msaa = params.get('msaa') === '1' ? 1 : 4;
  const maxDpr = Number(params.get('dpr') ?? Infinity);
  // ?lod=N forces a level for every mesh; ?lodpx=E sets the pixel-error threshold.
  const lodParam = params.get('lod');
  const lodPx = Number(params.get('lodpx') ?? 1);
  // ?tex=bc7|astc|etc2|rgba8 forces the KTX2 transcode target (default: best supported).
  const texParam = params.get('tex') as TranscodeTarget | null;

  const gpu = await initGpu(canvas, {
    optionalFeatures: TEXTURE_COMPRESSION_FEATURES,
    onDeviceLost: (i) => showError(new Error(`GPU device lost: ${i.message || i.reason}`)),
  });
  observeCanvasSize(canvas, { maxTextureDimension: gpu.device.limits.maxTextureDimension2D, maxPixelRatio: maxDpr });

  // Opt-in features are config flags, e.g. { shadows: true } once ShadowPass lands.
  const renderer = new Renderer(gpu, {
    msaa, shadows: false,
    lod: { pixelError: lodPx, force: lodParam !== null ? Number(lodParam) : null },
  });
  status.renderer = renderer;
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  const controls = new OrbitControls(canvas, camera);

  let loadMs = 0;
  if (modelUrl) {
    hud.textContent = `loading ${modelUrl}…`;
    const t0 = performance.now();
    const loadStats: Record<string, number | string> = {};
    const model = await loadModel(renderer, modelUrl, { stats: loadStats, transcodeTarget: texParam ?? undefined });
    await gpu.device.queue.onSubmittedWorkDone();
    status.loadStats = loadStats;
    scene.add(model);
    scene.update();
    controls.frame(computeWorldBounds(scene.root));
    controls.setAngles(0.5, 0.25);
    loadMs = performance.now() - t0;
    status.loadMs = loadMs;
  }
  const hint = modelUrl ? `load ${loadMs.toFixed(0)} ms` : 'no model: add ?model=/path/to/file.glb (or a baked .wgm) to the URL';

  let fpsAccum = 0, fpsFrames = 0, fps = 0;
  const loop = new FrameLoop((dt) => {
    controls.update(dt);
    renderer.render(scene, camera);
    status.framesRendered++;
    status.ready = true;

    fpsAccum += dt; fpsFrames++;
    if (fpsAccum >= 0.5) {
      fps = fpsFrames / fpsAccum; fpsAccum = 0; fpsFrames = 0;
      const s = renderer.stats;
      hud.textContent =
        `${fps.toFixed(0)} fps  ${canvas.width}x${canvas.height}  MSAA ${msaa}x\n` +
        `draws ${s.drawCalls}  tris ${Math.round(s.triangles).toLocaleString()}  pipelines ${s.pipelineSwitches}  lod-reduced ${s.lodReducedDraws}\n` +
        hint;
    }
  });
  loop.start();
}

main().catch(showError);
