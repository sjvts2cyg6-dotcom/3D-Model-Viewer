import type { GpuContext } from '../core/gpu';
import type { PerspectiveCamera } from '../scene/camera';
import type { Scene } from '../scene/scene';
import { resolveRendererConfig, type RendererConfig, type ResolvedRendererConfig } from './config';
import { featuresFromConfig, type ShaderFeatures } from './features';
import { createGpuPrimitive, createBuffer, type GpuPrimitive, type PrimitiveData } from './mesh';
import { MATERIAL_UNIFORM_SIZE, materialSortKey, packMaterialUniforms, type GpuMaterial, type MaterialDesc } from './material';
import {
  createSharedLayouts, DRAW_UNIFORM_SIZE, FRAME_BINDING, FRAME_LAYOUT, frameUniformSize, PipelineCache, pipelineKey,
  type SharedLayouts,
} from './pipelines';
import { ForwardPass, type DrawItem, type FrameData, type PassContext, type RenderPass, type RenderStats } from './passes';
import { createSolidTexture, createTextureFromImage, MipmapGenerator, SamplerCache, type SamplerDesc } from './textures';

export type { RenderStats } from './passes';

/**
 * Frame orchestrator. Each frame it:
 *   1. updates camera + scene transforms,
 *   2. builds one sorted draw list and uploads all per-draw matrices at once,
 *   3. fills frame uniforms, lets passes `prepare` (e.g. write light matrices),
 *   4. records every enabled pass in order into one command encoder.
 *
 * Which passes exist and which shader features are compiled in are decided
 * once from the RendererConfig (see createPasses / features.ts).
 *
 * Bind group frequency:
 *   group 0 – per frame  (camera, light, ambient [+ feature bindings, e.g. shadow map])
 *   group 1 – per material (factors + 5 textures + sampler) – feature-independent
 *   group 2 – per draw  (model/normal matrices via one dynamic-offset buffer)
 */
export class Renderer {
  readonly device: GPUDevice;
  readonly config: ResolvedRendererConfig;
  readonly features: ShaderFeatures;
  readonly layouts: SharedLayouts;
  readonly samplers: SamplerCache;
  readonly stats: RenderStats = { drawCalls: 0, triangles: 0, pipelineSwitches: 0 };
  readonly passes: readonly RenderPass[];

  exposure: number;

  private readonly pipelines: PipelineCache;
  private readonly mipmaps: MipmapGenerator;
  private readonly defaults: { white: GPUTexture; flatNormal: GPUTexture; black: GPUTexture };

  private readonly frameBuffer: GPUBuffer;
  private frameBindGroup!: GPUBindGroup;
  private readonly frameData: Float32Array<ArrayBuffer>;

  private readonly drawStride: number;
  private drawCapacity = 0;
  private drawBuffer!: GPUBuffer;
  private drawBindGroup!: GPUBindGroup;
  private drawStaging = new Float32Array(0);

  private width = 0;
  private height = 0;
  private nextMaterialId = 1;
  private readonly drawList: DrawItem[] = [];

  constructor(private readonly gpu: GpuContext, config: RendererConfig = {}) {
    const device = (this.device = gpu.device);
    this.config = resolveRendererConfig(config);
    this.features = featuresFromConfig(this.config);
    this.exposure = this.config.exposure;

    this.layouts = createSharedLayouts(device);
    this.pipelines = new PipelineCache(device, this.layouts, gpu.colorFormat, this.config.msaa);
    this.mipmaps = new MipmapGenerator(device);
    this.samplers = new SamplerCache(device, this.config.maxAnisotropy);
    this.defaults = {
      white: createSolidTexture(device, [255, 255, 255, 255], false, 'default white'),
      flatNormal: createSolidTexture(device, [128, 128, 255, 255], false, 'default normal'),
      black: createSolidTexture(device, [0, 0, 0, 255], false, 'default black'),
    };

    const frameSize = frameUniformSize(this.features);
    this.frameData = new Float32Array(frameSize / 4);
    this.frameBuffer = device.createBuffer({
      label: 'frame uniforms',
      size: frameSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const align = device.limits.minUniformBufferOffsetAlignment;
    this.drawStride = Math.ceil(DRAW_UNIFORM_SIZE / align) * align;
    this.ensureDrawCapacity(64);

    const ctx: PassContext = {
      device, gpu, config: this.config, features: this.features, layouts: this.layouts, pipelines: this.pipelines,
    };
    this.passes = this.createPasses();
    for (const p of this.passes) p.setup(ctx);
    this.rebuildFrameBindGroup();
  }

  /**
   * The ordered pass list for this config. Feature passes go before the
   * forward pass that consumes their output, e.g.:
   *
   *   if (this.config.shadows) passes.push(new ShadowPass());   // see passes/shadowPass.ts
   */
  private createPasses(): RenderPass[] {
    const passes: RenderPass[] = [];
    passes.push(new ForwardPass());
    return passes;
  }

  /** Rebuild group 0 (call if a pass replaces a resource it exposes, e.g. shadow map resize). */
  rebuildFrameBindGroup(): void {
    const entries: GPUBindGroupEntry[] = [{ binding: FRAME_BINDING.uniforms, resource: { buffer: this.frameBuffer } }];
    for (const p of this.passes) if (p.frameBindGroupEntries) entries.push(...p.frameBindGroupEntries());
    this.frameBindGroup = this.device.createBindGroup({
      label: 'frame',
      layout: this.pipelines.frameLayout(this.features),
      entries,
    });
  }

  // ---------------------------------------------------------------- resources

  createTexture(image: ImageBitmap, srgb: boolean, label?: string): GPUTexture {
    return createTextureFromImage(this.device, this.mipmaps, image, srgb, label);
  }

  getSampler(desc?: SamplerDesc): GPUSampler {
    return this.samplers.get(desc);
  }

  createMaterial(desc: MaterialDesc): GpuMaterial {
    const uniformBuffer = createBuffer(
      this.device, packMaterialUniforms(desc), GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, `${desc.name ?? 'material'} uniforms`,
    );
    if (uniformBuffer.size < MATERIAL_UNIFORM_SIZE) throw new Error('material uniform size mismatch');
    const d = this.defaults;
    const bindGroup = this.device.createBindGroup({
      label: desc.name ?? 'material',
      layout: this.layouts.material,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: desc.sampler ?? this.samplers.get() },
        { binding: 2, resource: (desc.baseColorTexture ?? d.white).createView() },
        { binding: 3, resource: (desc.metallicRoughnessTexture ?? d.white).createView() },
        { binding: 4, resource: (desc.normalTexture ?? d.flatNormal).createView() },
        { binding: 5, resource: (desc.occlusionTexture ?? d.white).createView() },
        { binding: 6, resource: (desc.emissiveTexture ?? d.white).createView() },
      ],
    });
    // Pre-warm the pipeline variant so the first frame doesn't hitch.
    this.pipelines.get(this.features, desc.alphaMode, desc.doubleSided);
    const id = this.nextMaterialId++;
    return {
      id,
      sortKey: materialSortKey(desc.alphaMode, desc.doubleSided, id),
      name: desc.name ?? '',
      bindGroup,
      uniformBuffer,
      alphaMode: desc.alphaMode,
      doubleSided: desc.doubleSided,
      pipelineKey: pipelineKey(desc.alphaMode, desc.doubleSided),
    };
  }

  createPrimitive(data: PrimitiveData, material: GpuMaterial, label?: string): GpuPrimitive {
    return createGpuPrimitive(this.device, data, material, label);
  }

  // ------------------------------------------------------------------- frame

  render(scene: Scene, camera: PerspectiveCamera): void {
    const { device, gpu } = this;
    const swapTexture = gpu.context.getCurrentTexture();
    const { width, height } = swapTexture;
    if (width !== this.width || height !== this.height) {
      this.width = width;
      this.height = height;
      for (const p of this.passes) p.resize(width, height);
    }

    camera.aspect = width / height;
    camera.update();
    scene.update();

    // Gather + sort draws: opaque/mask grouped by pipeline then material, blend last.
    // (No back-to-front sort for BLEND yet, and no frustum culling – see README roadmap.)
    const list = this.drawList;
    list.length = 0;
    scene.root.traverse((node) => {
      if (!node.visible || !node.mesh) return;
      for (const prim of node.mesh.primitives) list.push({ node, prim, sortKey: prim.material.sortKey, slot: 0 });
    });
    list.sort((a, b) => a.sortKey - b.sortKey);

    // Per-draw uniforms: one CPU staging array, one writeBuffer.
    this.ensureDrawCapacity(list.length);
    const strideF = this.drawStride / 4;
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      item.slot = i;
      this.drawStaging.set(item.node.worldMatrix, i * strideF);
      this.drawStaging.set(item.node.normalMatrix, i * strideF + 16);
    }
    if (list.length) device.queue.writeBuffer(this.drawBuffer, 0, this.drawStaging, 0, list.length * strideF);

    const stats = this.stats;
    stats.drawCalls = stats.triangles = stats.pipelineSwitches = 0;
    const frame: FrameData = {
      scene, camera,
      drawList: list,
      drawBindGroup: this.drawBindGroup,
      drawStride: this.drawStride,
      frameBindGroup: this.frameBindGroup,
      frameUniforms: this.frameData,
      swapTexture,
      swapView: swapTexture.createView({ format: gpu.colorFormat }),
      width, height,
      stats,
    };

    this.fillFrameUniforms(scene, camera);
    for (const p of this.passes) if (p.enabled) p.prepare?.(frame);
    device.queue.writeBuffer(this.frameBuffer, 0, this.frameData);

    const encoder = device.createCommandEncoder({ label: 'frame' });
    for (const p of this.passes) if (p.enabled) p.execute(encoder, frame);
    device.queue.submit([encoder.finish()]);
  }

  destroy(): void {
    for (const p of this.passes) p.destroy();
    this.frameBuffer.destroy();
    this.drawBuffer.destroy();
  }

  private fillFrameUniforms(scene: Scene, camera: PerspectiveCamera): void {
    const f = this.frameData;
    const L = FRAME_LAYOUT;
    const { light, ambient } = scene;
    f.set(camera.viewProjection, L.viewProj);
    f.set([camera.position[0], camera.position[1], camera.position[2], 1], L.cameraPos);
    const len = Math.hypot(light.direction[0], light.direction[1], light.direction[2]) || 1;
    f.set([light.direction[0] / len, light.direction[1] / len, light.direction[2] / len, 0], L.lightDir);
    f.set([light.color[0] * light.intensity, light.color[1] * light.intensity, light.color[2] * light.intensity, 1], L.lightColor);
    f.set([ambient.skyColor[0] * ambient.intensity, ambient.skyColor[1] * ambient.intensity, ambient.skyColor[2] * ambient.intensity, 1], L.skyColor);
    f.set([ambient.groundColor[0] * ambient.intensity, ambient.groundColor[1] * ambient.intensity, ambient.groundColor[2] * ambient.intensity, 1], L.groundColor);
    f.set([this.exposure, 0, 0, 0], L.params);
    // SHADOWS-only fields (lightViewProj, shadowParams) are written by the shadow pass in prepare().
  }

  private ensureDrawCapacity(count: number): void {
    if (count <= this.drawCapacity) return;
    let cap = Math.max(64, this.drawCapacity);
    while (cap < count) cap *= 2;
    this.drawBuffer?.destroy();
    this.drawBuffer = this.device.createBuffer({
      label: 'draw uniforms',
      size: cap * this.drawStride,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.drawBindGroup = this.device.createBindGroup({
      label: 'draw',
      layout: this.layouts.draw,
      entries: [{ binding: 0, resource: { buffer: this.drawBuffer, size: DRAW_UNIFORM_SIZE } }],
    });
    this.drawStaging = new Float32Array((cap * this.drawStride) / 4);
    this.drawCapacity = cap;
  }
}
