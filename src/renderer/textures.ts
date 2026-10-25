import { mipmapWgsl } from '../shaders';

export function mipLevelCount(width: number, height: number): number {
  return Math.floor(Math.log2(Math.max(width, height))) + 1;
}

/**
 * Generates a full mip chain on the GPU by repeatedly rendering level N-1 into
 * level N with a linear sampler. One pipeline is cached per texture format.
 */
export class MipmapGenerator {
  private readonly module: GPUShaderModule;
  private readonly sampler: GPUSampler;
  private readonly pipelines = new Map<GPUTextureFormat, GPURenderPipeline>();

  constructor(private readonly device: GPUDevice) {
    this.module = device.createShaderModule({ label: 'mipmap', code: mipmapWgsl });
    this.sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  }

  private pipeline(format: GPUTextureFormat): GPURenderPipeline {
    let p = this.pipelines.get(format);
    if (!p) {
      p = this.device.createRenderPipeline({
        label: `mipmap ${format}`,
        layout: 'auto',
        vertex: { module: this.module, entryPoint: 'vs_main' },
        fragment: { module: this.module, entryPoint: 'fs_main', targets: [{ format }] },
        primitive: { topology: 'triangle-list' },
      });
      this.pipelines.set(format, p);
    }
    return p;
  }

  generate(texture: GPUTexture): void {
    if (texture.mipLevelCount < 2) return;
    const pipeline = this.pipeline(texture.format);
    const encoder = this.device.createCommandEncoder({ label: 'mipmap gen' });
    for (let level = 1; level < texture.mipLevelCount; level++) {
      const bindGroup = this.device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.sampler },
          { binding: 1, resource: texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }) },
        ],
      });
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: texture.createView({ baseMipLevel: level, mipLevelCount: 1 }),
          loadOp: 'clear',
          storeOp: 'store',
        }],
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.draw(3);
      pass.end();
    }
    this.device.queue.submit([encoder.finish()]);
  }
}

/** Uploads a decoded image as an RGBA8 texture (sRGB or linear) with mips. */
export function createTextureFromImage(
  device: GPUDevice,
  mipmaps: MipmapGenerator,
  image: ImageBitmap,
  srgb: boolean,
  label?: string,
): GPUTexture {
  const format: GPUTextureFormat = srgb ? 'rgba8unorm-srgb' : 'rgba8unorm';
  const texture = device.createTexture({
    label,
    size: [image.width, image.height],
    format,
    mipLevelCount: mipLevelCount(image.width, image.height),
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
  });
  device.queue.copyExternalImageToTexture({ source: image }, { texture }, [image.width, image.height]);
  mipmaps.generate(texture);
  return texture;
}

/** 1x1 constant texture used when a material slot has no image. */
export function createSolidTexture(device: GPUDevice, rgba: [number, number, number, number], srgb: boolean, label: string): GPUTexture {
  const texture = device.createTexture({
    label,
    size: [1, 1],
    format: srgb ? 'rgba8unorm-srgb' : 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture }, new Uint8Array(rgba), { bytesPerRow: 4 }, [1, 1]);
  return texture;
}

export interface SamplerDesc {
  magFilter?: GPUFilterMode;
  minFilter?: GPUFilterMode;
  mipmapFilter?: GPUMipmapFilterMode;
  addressModeU?: GPUAddressMode;
  addressModeV?: GPUAddressMode;
}

/** De-duplicates samplers by their state. */
export class SamplerCache {
  private readonly cache = new Map<string, GPUSampler>();
  constructor(private readonly device: GPUDevice, private readonly maxAnisotropy = 8) {}

  get(desc: SamplerDesc = {}): GPUSampler {
    const d: Required<SamplerDesc> = {
      magFilter: desc.magFilter ?? 'linear',
      minFilter: desc.minFilter ?? 'linear',
      mipmapFilter: desc.mipmapFilter ?? 'linear',
      addressModeU: desc.addressModeU ?? 'repeat',
      addressModeV: desc.addressModeV ?? 'repeat',
    };
    const key = `${d.magFilter}|${d.minFilter}|${d.mipmapFilter}|${d.addressModeU}|${d.addressModeV}`;
    let s = this.cache.get(key);
    if (!s) {
      const allLinear = d.magFilter === 'linear' && d.minFilter === 'linear' && d.mipmapFilter === 'linear';
      s = this.device.createSampler({ ...d, maxAnisotropy: allLinear ? this.maxAnisotropy : 1 });
      this.cache.set(key, s);
    }
    return s;
  }
}
