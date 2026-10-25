import { pbrWgsl } from '../shaders';
import type { AlphaMode } from './material';

export const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus';
/** model mat4 + normal mat4 */
export const DRAW_UNIFORM_SIZE = 128;
export const FRAME_UNIFORM_SIZE = 64 + 16 * 6;

export interface BindGroupLayouts {
  frame: GPUBindGroupLayout;
  material: GPUBindGroupLayout;
  draw: GPUBindGroupLayout;
}

export function createBindGroupLayouts(device: GPUDevice): BindGroupLayouts {
  const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
  const F = GPUShaderStage.FRAGMENT;
  const tex = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: F, texture: { sampleType: 'float' } });
  return {
    frame: device.createBindGroupLayout({
      label: 'frame',
      entries: [{ binding: 0, visibility: VF, buffer: { type: 'uniform' } }],
    }),
    material: device.createBindGroupLayout({
      label: 'material',
      entries: [
        { binding: 0, visibility: F, buffer: { type: 'uniform' } },
        { binding: 1, visibility: F, sampler: { type: 'filtering' } },
        tex(2), tex(3), tex(4), tex(5), tex(6),
      ],
    }),
    draw: device.createBindGroupLayout({
      label: 'draw',
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: DRAW_UNIFORM_SIZE },
      }],
    }),
  };
}

const VERTEX_LAYOUTS: GPUVertexBufferLayout[] = [
  { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
  { arrayStride: 12, attributes: [{ shaderLocation: 1, offset: 0, format: 'float32x3' }] },
  { arrayStride: 8, attributes: [{ shaderLocation: 2, offset: 0, format: 'float32x2' }] },
  { arrayStride: 16, attributes: [{ shaderLocation: 3, offset: 0, format: 'float32x4' }] },
];

export function pipelineKey(alphaMode: AlphaMode, doubleSided: boolean): string {
  return `${alphaMode}|${doubleSided ? 'ds' : 'ss'}`;
}

/** Lazily creates and caches PBR pipeline variants (alpha mode x culling). */
export class PipelineCache {
  private readonly module: GPUShaderModule;
  private readonly layout: GPUPipelineLayout;
  private readonly cache = new Map<string, GPURenderPipeline>();

  constructor(
    private readonly device: GPUDevice,
    layouts: BindGroupLayouts,
    private readonly colorFormat: GPUTextureFormat,
    private readonly sampleCount: number,
  ) {
    this.module = device.createShaderModule({ label: 'pbr', code: pbrWgsl });
    this.layout = device.createPipelineLayout({
      label: 'pbr',
      bindGroupLayouts: [layouts.frame, layouts.material, layouts.draw],
    });
  }

  get(alphaMode: AlphaMode, doubleSided: boolean): GPURenderPipeline {
    const key = pipelineKey(alphaMode, doubleSided);
    let p = this.cache.get(key);
    if (p) return p;
    const blend = alphaMode === 'BLEND';
    p = this.device.createRenderPipeline({
      label: `pbr ${key}`,
      layout: this.layout,
      vertex: { module: this.module, entryPoint: 'vs_main', buffers: VERTEX_LAYOUTS },
      fragment: {
        module: this.module,
        entryPoint: 'fs_main',
        targets: [{
          format: this.colorFormat,
          blend: blend
            ? {
                color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
                alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
              }
            : undefined,
        }],
      },
      primitive: { topology: 'triangle-list', cullMode: doubleSided ? 'none' : 'back', frontFace: 'ccw' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: !blend, depthCompare: 'less' },
      multisample: { count: this.sampleCount, alphaToCoverageEnabled: false },
    });
    this.cache.set(key, p);
    return p;
  }
}
