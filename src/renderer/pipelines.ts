import { pbrWgsl } from '../shaders';
import { featureDefines, featureKey, type ShaderFeatures } from './features';
import type { AlphaMode } from './material';
import { preprocessWgsl } from './shaderPreprocessor';
import { F32_VERTEX_LAYOUT, layoutShaderKey, type VertexLayout } from './vertexLayout';

export const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus';
/**
 * model mat4 + normal mat4 + position dequantization (posScale, posOffset):
 * local = in.position.xyz * posScale.xyz + posOffset.xyz (identity for float32 positions).
 */
export const DRAW_UNIFORM_SIZE = 160;
/** Float offsets inside one Draw uniform (must match pbr.wgsl `struct Draw`). */
export const DRAW_LAYOUT = { model: 0, normalMat: 16, posScale: 32, posOffset: 36 } as const;

/** Group 0 (per-frame / lighting) binding slots. Slots 1-2 are reserved for shadows. */
export const FRAME_BINDING = {
  uniforms: 0,
  shadowMap: 1,
  shadowSampler: 2,
} as const;

/** Float offsets into the Frame uniform struct (must match pbr.wgsl `struct Frame`). */
export const FRAME_LAYOUT = {
  viewProj: 0,
  cameraPos: 16,
  lightDir: 20,
  lightColor: 24,
  skyColor: 28,
  groundColor: 32,
  params: 36,
  /** SHADOWS only */
  lightViewProj: 40,
  /** SHADOWS only */
  shadowParams: 56,
} as const;

/** Byte size of the Frame uniform block for a feature set (no shadow fields unless enabled). */
export function frameUniformSize(f: ShaderFeatures): number {
  return (f.shadows ? FRAME_LAYOUT.shadowParams + 4 : FRAME_LAYOUT.params + 4) * 4;
}

/** Layouts shared by every feature variant: materials and draws never change shape. */
export interface SharedLayouts {
  material: GPUBindGroupLayout;
  draw: GPUBindGroupLayout;
}

export function createSharedLayouts(device: GPUDevice): SharedLayouts {
  const F = GPUShaderStage.FRAGMENT;
  const tex = (binding: number): GPUBindGroupLayoutEntry => ({ binding, visibility: F, texture: { sampleType: 'float' } });
  return {
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

/** Group 0 layout for a feature set. */
export function createFrameLayout(device: GPUDevice, f: ShaderFeatures): GPUBindGroupLayout {
  const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
  const entries: GPUBindGroupLayoutEntry[] = [
    { binding: FRAME_BINDING.uniforms, visibility: VF, buffer: { type: 'uniform', minBindingSize: frameUniformSize(f) } },
  ];
  if (f.shadows) {
    entries.push(
      { binding: FRAME_BINDING.shadowMap, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
      { binding: FRAME_BINDING.shadowSampler, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
    );
  }
  return device.createBindGroupLayout({ label: `frame [${featureKey(f) || 'base'}]`, entries });
}

/**
 * Unquantized vertex streams, one buffer per attribute (glTF path). Baked
 * files use per-primitive layouts from vertexLayout.ts. A depth-only pass
 * (e.g. shadows) can bind just slot 0 with the layout's `buffers[0]`.
 */
export const VERTEX_LAYOUTS: GPUVertexBufferLayout[] = F32_VERTEX_LAYOUT.buffers;
export const POSITION_ONLY_LAYOUT: GPUVertexBufferLayout[] = [VERTEX_LAYOUTS[0]];

export function pipelineKey(alphaMode: AlphaMode, doubleSided: boolean): string {
  return `${alphaMode}|${doubleSided ? 'ds' : 'ss'}`;
}

/**
 * Lazily creates and caches PBR pipelines keyed by
 * (shader feature set, vertex layout, alpha mode, culling). Shader modules are
 * cached per (feature set + layout defines); frame layouts per feature set.
 */
export class PipelineCache {
  private readonly modules = new Map<string, GPUShaderModule>();
  private readonly frameLayouts = new Map<string, GPUBindGroupLayout>();
  private readonly pipelineLayouts = new Map<string, GPUPipelineLayout>();
  private readonly pipelines = new Map<string, GPURenderPipeline>();

  constructor(
    private readonly device: GPUDevice,
    private readonly shared: SharedLayouts,
    private readonly colorFormat: GPUTextureFormat,
    private readonly sampleCount: number,
  ) {}

  frameLayout(f: ShaderFeatures): GPUBindGroupLayout {
    const fk = featureKey(f);
    let l = this.frameLayouts.get(fk);
    if (!l) {
      l = createFrameLayout(this.device, f);
      this.frameLayouts.set(fk, l);
    }
    return l;
  }

  shaderModule(f: ShaderFeatures, layout: VertexLayout = F32_VERTEX_LAYOUT): GPUShaderModule {
    const mk = [featureKey(f), layoutShaderKey(layout)].filter(Boolean).join('+');
    let m = this.modules.get(mk);
    if (!m) {
      m = this.device.createShaderModule({
        label: `pbr [${mk || 'base'}]`,
        code: preprocessWgsl(pbrWgsl, { ...featureDefines(f), ...layout.defines }),
      });
      this.modules.set(mk, m);
    }
    return m;
  }

  /** Number of distinct shader modules / pipelines built so far (diagnostics, tests). */
  get counts(): { modules: number; pipelines: number } {
    return { modules: this.modules.size, pipelines: this.pipelines.size };
  }

  private pipelineLayout(f: ShaderFeatures): GPUPipelineLayout {
    const fk = featureKey(f);
    let l = this.pipelineLayouts.get(fk);
    if (!l) {
      l = this.device.createPipelineLayout({
        label: `pbr [${fk || 'base'}]`,
        bindGroupLayouts: [this.frameLayout(f), this.shared.material, this.shared.draw],
      });
      this.pipelineLayouts.set(fk, l);
    }
    return l;
  }

  get(f: ShaderFeatures, alphaMode: AlphaMode, doubleSided: boolean, layout: VertexLayout = F32_VERTEX_LAYOUT): GPURenderPipeline {
    const key = `${featureKey(f)}/${layout.key}/${pipelineKey(alphaMode, doubleSided)}`;
    let p = this.pipelines.get(key);
    if (p) return p;
    const module = this.shaderModule(f, layout);
    const blend = alphaMode === 'BLEND';
    p = this.device.createRenderPipeline({
      label: `pbr ${key}`,
      layout: this.pipelineLayout(f),
      vertex: { module, entryPoint: 'vs_main', buffers: layout.buffers },
      fragment: {
        module,
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
    this.pipelines.set(key, p);
    return p;
  }
}
