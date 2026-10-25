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

/** One level of detail: a sub-range of the primitive's index range. */
export interface LodLevel {
  /** First index, relative to `indexOffset`. */
  firstIndex: number;
  indexCount: number;
  /** Geometric error in mesh-local units (0 = full detail). Ascending across levels. */
  error: number;
}

export interface GpuPrimitive {
  /**
   * Slot order matches the pipeline's vertex buffer layouts. Several
   * primitives may share one GPUBuffer (baked .wgm files use a single vertex
   * and a single index buffer per file) and address it with offsets.
   */
  vertexBuffers: [position: GPUBuffer, normal: GPUBuffer, uv: GPUBuffer, tangent: GPUBuffer];
  /** Byte offsets into `vertexBuffers` (multiples of 4). */
  vertexOffsets: [number, number, number, number];
  indexBuffer: GPUBuffer;
  /** Byte offset into `indexBuffer` (multiple of the index size). */
  indexOffset: number;
  indexFormat: GPUIndexFormat;
  /** Full-detail index count (== lods[0].indexCount). */
  indexCount: number;
  /** lods[0] is full detail; always at least one entry. */
  lods: LodLevel[];
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
    vertexOffsets: [0, 0, 0, 0],
    indexBuffer: createBuffer(device, data.indices, GPUBufferUsage.INDEX, `${label} idx`),
    indexOffset: 0,
    indexFormat: data.indices instanceof Uint16Array ? 'uint16' : 'uint32',
    indexCount: data.indices.length,
    lods: [{ firstIndex: 0, indexCount: data.indices.length, error: 0 }],
    material,
    boundsMin: data.boundsMin,
    boundsMax: data.boundsMax,
  };
}
