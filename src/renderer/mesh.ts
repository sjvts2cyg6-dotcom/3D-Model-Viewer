import type { Vec3 } from 'wgpu-matrix';
import type { GpuMaterial } from './material';

/** CPU-side geometry in the engine's canonical (non-interleaved) layout. */
export interface PrimitiveData {
  positions: Float32Array; // xyz
  normals: Float32Array;   // xyz
  uvs: Float32Array;       // uv
  tangents: Float32Array;  // xyzw (w = bitangent sign)
  indices: Uint16Array | Uint32Array;
  boundsMin: Vec3;
  boundsMax: Vec3;
}

export interface GpuPrimitive {
  /** Slot order matches the pipeline's vertex buffer layouts. */
  vertexBuffers: [position: GPUBuffer, normal: GPUBuffer, uv: GPUBuffer, tangent: GPUBuffer];
  indexBuffer: GPUBuffer;
  indexFormat: GPUIndexFormat;
  indexCount: number;
  material: GpuMaterial;
  boundsMin: Vec3;
  boundsMax: Vec3;
}

export interface GpuMesh {
  name: string;
  primitives: GpuPrimitive[];
}

export function createBuffer(device: GPUDevice, data: ArrayBufferView, usage: GPUBufferUsageFlags, label?: string): GPUBuffer {
  // Buffer sizes must be 4-byte aligned (e.g. odd-count uint16 index buffers).
  const size = Math.max(4, (data.byteLength + 3) & ~3);
  const buffer = device.createBuffer({ label, size, usage, mappedAtCreation: true });
  new Uint8Array(buffer.getMappedRange()).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  buffer.unmap();
  return buffer;
}

export function createGpuPrimitive(device: GPUDevice, data: PrimitiveData, material: GpuMaterial, label = ''): GpuPrimitive {
  const V = GPUBufferUsage.VERTEX;
  return {
    vertexBuffers: [
      createBuffer(device, data.positions, V, `${label} pos`),
      createBuffer(device, data.normals, V, `${label} nrm`),
      createBuffer(device, data.uvs, V, `${label} uv`),
      createBuffer(device, data.tangents, V, `${label} tan`),
    ],
    indexBuffer: createBuffer(device, data.indices, GPUBufferUsage.INDEX, `${label} idx`),
    indexFormat: data.indices instanceof Uint16Array ? 'uint16' : 'uint32',
    indexCount: data.indices.length,
    material,
    boundsMin: data.boundsMin,
    boundsMax: data.boundsMax,
  };
}
