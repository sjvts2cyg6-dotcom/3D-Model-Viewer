/**
 * WebGPU adapter/device/canvas bootstrap.
 *
 * The canvas is configured with its preferred *storage* format (usually
 * bgra8unorm) plus an sRGB *view* format, so the renderer can write linear
 * colour and let the hardware do the sRGB encode on store.
 */

export class WebGPUUnsupportedError extends Error {
  override name = 'WebGPUUnsupportedError';
}

export interface GpuContext {
  readonly adapter: GPUAdapter;
  readonly device: GPUDevice;
  readonly canvas: HTMLCanvasElement;
  readonly context: GPUCanvasContext;
  /** Storage format of the swap-chain texture. */
  readonly canvasFormat: GPUTextureFormat;
  /** sRGB view format we render into (and the MSAA target format). */
  readonly colorFormat: GPUTextureFormat;
}

export interface GpuInitOptions {
  powerPreference?: GPUPowerPreference;
  /** Optional features to enable when the adapter has them. */
  optionalFeatures?: GPUFeatureName[];
  onDeviceLost?: (info: GPUDeviceLostInfo) => void;
}

const HELP =
  'Use a recent Chrome/Edge (113+), Safari (26+), or Firefox with WebGPU enabled, ' +
  'served from a secure context (https:// or http://localhost).';

function srgbViewOf(format: GPUTextureFormat): GPUTextureFormat {
  switch (format) {
    case 'bgra8unorm': return 'bgra8unorm-srgb';
    case 'rgba8unorm': return 'rgba8unorm-srgb';
    default: return format;
  }
}

export async function initGpu(canvas: HTMLCanvasElement, opts: GpuInitOptions = {}): Promise<GpuContext> {
  if (!window.isSecureContext) {
    throw new WebGPUUnsupportedError(`WebGPU requires a secure context. ${HELP}`);
  }
  if (!('gpu' in navigator) || !navigator.gpu) {
    throw new WebGPUUnsupportedError(`This browser does not expose WebGPU (navigator.gpu is missing). ${HELP}`);
  }

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: opts.powerPreference ?? 'high-performance' });
  if (!adapter) {
    throw new WebGPUUnsupportedError(
      `WebGPU is present but no suitable GPU adapter was found (it may be blocklisted or disabled). ${HELP}`,
    );
  }

  const requiredFeatures = (opts.optionalFeatures ?? []).filter((f) => adapter.features.has(f));
  const device = await adapter.requestDevice({ requiredFeatures });

  device.lost.then((info) => {
    console.error(`[gpu] device lost (${info.reason}): ${info.message}`);
    opts.onDeviceLost?.(info);
  });
  device.addEventListener('uncapturederror', (e) => {
    console.error('[gpu] uncaptured error:', (e as GPUUncapturedErrorEvent).error.message);
  });

  const context = canvas.getContext('webgpu');
  if (!context) throw new WebGPUUnsupportedError('Could not get a "webgpu" context from the canvas.');

  const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
  const colorFormat = srgbViewOf(canvasFormat);
  context.configure({
    device,
    format: canvasFormat,
    viewFormats: colorFormat !== canvasFormat ? [colorFormat] : [],
    alphaMode: 'opaque',
  });

  return { adapter, device, canvas, context, canvasFormat, colorFormat };
}
