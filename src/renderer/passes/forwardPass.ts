import { DEPTH_FORMAT } from '../pipelines';
import type { GpuMaterial } from '../material';
import type { GpuPrimitive } from '../mesh';
import type { FrameData, PassContext, RenderPass } from './pass';

/**
 * Main forward pass: draws the sorted draw list with the PBR pipelines into a
 * 4x MSAA target that resolves straight into the swap-chain texture.
 * MSAA color and depth use storeOp 'discard' (only the resolve hits memory).
 */
export class ForwardPass implements RenderPass {
  readonly name = 'forward';
  enabled = true;

  private ctx!: PassContext;
  private msaaTexture: GPUTexture | null = null;
  private depthTexture: GPUTexture | null = null;

  setup(ctx: PassContext): void {
    this.ctx = ctx;
  }

  resize(width: number, height: number): void {
    const { device, gpu, config } = this.ctx;
    this.msaaTexture?.destroy();
    this.depthTexture?.destroy();
    const size = [width, height];
    this.msaaTexture = config.msaa > 1
      ? device.createTexture({
          label: 'msaa color', size, sampleCount: config.msaa,
          format: gpu.colorFormat, usage: GPUTextureUsage.RENDER_ATTACHMENT,
        })
      : null;
    this.depthTexture = device.createTexture({
      label: 'depth', size, sampleCount: config.msaa,
      format: DEPTH_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
  }

  execute(encoder: GPUCommandEncoder, frame: FrameData): void {
    const { config, features, pipelines } = this.ctx;
    const msaa = this.msaaTexture !== null;
    const pass = encoder.beginRenderPass({
      label: 'forward',
      colorAttachments: [{
        view: msaa ? this.msaaTexture!.createView() : frame.swapView,
        resolveTarget: msaa ? frame.swapView : undefined,
        clearValue: config.clearColor,
        loadOp: 'clear',
        storeOp: msaa ? 'discard' : 'store',
      }],
      depthStencilAttachment: {
        view: this.depthTexture!.createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'discard',
      },
    });

    pass.setBindGroup(0, frame.frameBindGroup);
    const stats = frame.stats;
    let curPipeline: GPURenderPipeline | null = null;
    let curMaterial: GpuMaterial | null = null;
    let curPrim: GpuPrimitive | null = null;
    const dynOffset = [0];

    for (const { prim, slot } of frame.drawList) {
      const m = prim.material;
      const pipeline = pipelines.get(features, m.alphaMode, m.doubleSided);
      if (pipeline !== curPipeline) {
        pass.setPipeline(pipeline);
        curPipeline = pipeline;
        stats.pipelineSwitches++;
      }
      if (m !== curMaterial) {
        pass.setBindGroup(1, m.bindGroup);
        curMaterial = m;
      }
      dynOffset[0] = slot * frame.drawStride;
      pass.setBindGroup(2, frame.drawBindGroup, dynOffset);
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
  }

  destroy(): void {
    this.msaaTexture?.destroy();
    this.depthTexture?.destroy();
    this.msaaTexture = this.depthTexture = null;
  }
}
