import type { GpuContext } from '../core/gpu';
import type { PerspectiveCamera } from '../scene/camera';
import type { Node } from '../scene/node';
import type { Scene } from '../scene/scene';
import { createGpuPrimitive, createBuffer, type GpuPrimitive, type PrimitiveData } from './mesh';
import { MATERIAL_UNIFORM_SIZE, materialSortKey, packMaterialUniforms, type GpuMaterial, type MaterialDesc } from './material';
import {
  createBindGroupLayouts, DEPTH_FORMAT, DRAW_UNIFORM_SIZE, FRAME_UNIFORM_SIZE, PipelineCache, pipelineKey,
  type BindGroupLayouts,
} from './pipelines';
import { createSolidTexture, createTextureFromImage, MipmapGenerator, SamplerCache, type SamplerDesc } from './textures';

export interface RendererOptions {
  /** 1 or 4 (WebGPU guarantees 4x MSAA support for renderable formats). */
  sampleCount?: 1 | 4;
  clearColor?: GPUColor;
  exposure?: number;
  maxAnisotropy?: number;
}

export interface RenderStats {
  drawCalls: number;
  triangles: number;
  pipelineSwitches: number;
}

interface DrawItem {
  node: Node;
  prim: GpuPrimitive;
  sortKey: number;
  slot: number;
}

/**
 * Forward renderer: one opaque/mask pass + blended draws last, 4x MSAA
 * resolved straight into the swap-chain texture.
 *
 * Bind group frequency:
 *   group 0 – per frame  (camera, light, ambient)
 *   group 1 – per material (factors + 5 textures + sampler)
 *   group 2 – per draw  (model/normal matrices via one dynamic-offset buffer)
 */
export class Renderer {
  readonly device: GPUDevice;
  readonly layouts: BindGroupLayouts;
  readonly samplers: SamplerCache;
  readonly stats: RenderStats = { drawCalls: 0, triangles: 0, pipelineSwitches: 0 };

  exposure: number;
  clearColor: GPUColor;

  private readonly sampleCount: number;
  private readonly pipelines: PipelineCache;
  private readonly mipmaps: MipmapGenerator;
  private readonly defaults: { white: GPUTexture; flatNormal: GPUTexture; black: GPUTexture };

  private readonly frameBuffer: GPUBuffer;
  private readonly frameBindGroup: GPUBindGroup;
  private readonly frameData = new Float32Array(FRAME_UNIFORM_SIZE / 4);

  private readonly drawStride: number;
  private drawCapacity = 0;
  private drawBuffer!: GPUBuffer;
  private drawBindGroup!: GPUBindGroup;
  private drawStaging = new Float32Array(0);

  private msaaTexture: GPUTexture | null = null;
  private depthTexture: GPUTexture | null = null;
  private nextMaterialId = 1;
  private readonly drawList: DrawItem[] = [];

  constructor(private readonly gpu: GpuContext, opts: RendererOptions = {}) {
    const device = (this.device = gpu.device);
    this.sampleCount = opts.sampleCount ?? 4;
    this.clearColor = opts.clearColor ?? { r: 0.06, g: 0.06, b: 0.08, a: 1 };
    this.exposure = opts.exposure ?? 1;

    this.layouts = createBindGroupLayouts(device);
    this.pipelines = new PipelineCache(device, this.layouts, gpu.colorFormat, this.sampleCount);
    this.mipmaps = new MipmapGenerator(device);
    this.samplers = new SamplerCache(device, opts.maxAnisotropy ?? 8);
    this.defaults = {
      white: createSolidTexture(device, [255, 255, 255, 255], false, 'default white'),
      flatNormal: createSolidTexture(device, [128, 128, 255, 255], false, 'default normal'),
      black: createSolidTexture(device, [0, 0, 0, 255], false, 'default black'),
    };

    this.frameBuffer = device.createBuffer({
      label: 'frame uniforms',
      size: FRAME_UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.frameBindGroup = device.createBindGroup({
      label: 'frame',
      layout: this.layouts.frame,
      entries: [{ binding: 0, resource: { buffer: this.frameBuffer } }],
    });

    const align = device.limits.minUniformBufferOffsetAlignment;
    this.drawStride = Math.ceil(DRAW_UNIFORM_SIZE / align) * align;
    this.ensureDrawCapacity(64);
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
    this.pipelines.get(desc.alphaMode, desc.doubleSided);
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
    this.ensureRenderTargets(swapTexture.width, swapTexture.height);

    camera.aspect = swapTexture.width / swapTexture.height;
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

    this.writeFrameUniforms(scene, camera);

    const encoder = device.createCommandEncoder({ label: 'frame' });
    const swapView = swapTexture.createView({ format: gpu.colorFormat });
    const msaa = this.sampleCount > 1;
    const pass = encoder.beginRenderPass({
      label: 'main',
      colorAttachments: [{
        view: msaa ? this.msaaTexture!.createView() : swapView,
        resolveTarget: msaa ? swapView : undefined,
        clearValue: this.clearColor,
        loadOp: 'clear',
        // MSAA samples are only needed until resolve; discarding saves bandwidth (big win on tilers).
        storeOp: msaa ? 'discard' : 'store',
      }],
      depthStencilAttachment: {
        view: this.depthTexture!.createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
      },
    });

    pass.setBindGroup(0, this.frameBindGroup);
    const stats = this.stats;
    stats.drawCalls = stats.triangles = stats.pipelineSwitches = 0;
    let curPipeline: GPURenderPipeline | null = null;
    let curMaterial: GpuMaterial | null = null;
    let curPrim: GpuPrimitive | null = null;
    const dynOffset = [0];

    for (const { prim, slot } of list) {
      const m = prim.material;
      const pipeline = this.pipelines.get(m.alphaMode, m.doubleSided);
      if (pipeline !== curPipeline) {
        pass.setPipeline(pipeline);
        curPipeline = pipeline;
        stats.pipelineSwitches++;
      }
      if (m !== curMaterial) {
        pass.setBindGroup(1, m.bindGroup);
        curMaterial = m;
      }
      dynOffset[0] = slot * this.drawStride;
      pass.setBindGroup(2, this.drawBindGroup, dynOffset);
      if (prim !== curPrim) {
        for (let s = 0; s < 4; s++) pass.setVertexBuffer(s, prim.vertexBuffers[s]);
        pass.setIndexBuffer(prim.indexBuffer, prim.indexFormat);
        curPrim = prim;
      }
      pass.drawIndexed(prim.indexCount);
      stats.drawCalls++;
      stats.triangles += prim.indexCount / 3;
    }

    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  private writeFrameUniforms(scene: Scene, camera: PerspectiveCamera): void {
    const f = this.frameData;
    const { light, ambient } = scene;
    f.set(camera.viewProjection, 0);
    f.set([camera.position[0], camera.position[1], camera.position[2], 1], 16);
    const len = Math.hypot(light.direction[0], light.direction[1], light.direction[2]) || 1;
    f.set([light.direction[0] / len, light.direction[1] / len, light.direction[2] / len, 0], 20);
    f.set([light.color[0] * light.intensity, light.color[1] * light.intensity, light.color[2] * light.intensity, 1], 24);
    f.set([ambient.skyColor[0] * ambient.intensity, ambient.skyColor[1] * ambient.intensity, ambient.skyColor[2] * ambient.intensity, 1], 28);
    f.set([ambient.groundColor[0] * ambient.intensity, ambient.groundColor[1] * ambient.intensity, ambient.groundColor[2] * ambient.intensity, 1], 32);
    f.set([this.exposure, 0, 0, 0], 36);
    this.device.queue.writeBuffer(this.frameBuffer, 0, f);
  }

  private ensureRenderTargets(width: number, height: number): void {
    const cur = this.depthTexture;
    if (cur && cur.width === width && cur.height === height) return;
    this.msaaTexture?.destroy();
    this.depthTexture?.destroy();
    const size = [width, height];
    this.msaaTexture = this.sampleCount > 1
      ? this.device.createTexture({
          label: 'msaa color', size, sampleCount: this.sampleCount,
          format: this.gpu.colorFormat, usage: GPUTextureUsage.RENDER_ATTACHMENT,
        })
      : null;
    this.depthTexture = this.device.createTexture({
      label: 'depth', size, sampleCount: this.sampleCount,
      format: DEPTH_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
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
