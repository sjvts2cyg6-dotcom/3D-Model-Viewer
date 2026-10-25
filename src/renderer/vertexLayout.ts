/**
 * Vertex layouts: which GPU vertex format each of the four streams uses.
 * Baked .wgm files store quantized, GPU-native formats (unorm16 positions,
 * snorm8/16 or octahedral normals, unorm16/float16 UVs); the vertex fetch
 * unit converts them, so nothing is decoded on the CPU. Pipelines are cached
 * per layout key, and layouts that need extra shader code (octahedral decode)
 * add a WGSL define, so they share the feature-variant machinery.
 */
import type { Defines } from './shaderPreprocessor';

export interface VertexStreamFormats {
  position: GPUVertexFormat;
  normal: GPUVertexFormat;
  /** null = stream absent (bound to the zero buffer with arrayStride 0). */
  uv: GPUVertexFormat | null;
  tangent: GPUVertexFormat | null;
  /** normal / tangent stored octahedral (snorm16x2), decoded in the vertex shader. */
  octNormal?: boolean;
  octTangent?: boolean;
}

export interface VertexLayout {
  /** Stable cache key, e.g. "float32x3|float32x3|float32x2|float32x4". */
  readonly key: string;
  readonly buffers: GPUVertexBufferLayout[];
  readonly defines: Defines;
}

const BYTES: Record<string, number> = {
  float32x2: 8, float32x3: 12, float32x4: 16, float16x2: 4, float16x4: 8,
  unorm16x2: 4, unorm16x4: 8, snorm16x2: 4, snorm16x4: 8, snorm8x4: 4, unorm8x4: 4,
};

const cache = new Map<string, VertexLayout>();

export function vertexLayout(f: VertexStreamFormats): VertexLayout {
  const oct = (on: boolean | undefined) => (on ? '/oct' : '');
  const key = `${f.position}|${f.normal}${oct(f.octNormal)}|${f.uv ?? '-'}|${f.tangent ?? '-'}${oct(f.octTangent)}`;
  let l = cache.get(key);
  if (l) return l;
  const stream = (loc: number, format: GPUVertexFormat | null, fallback: GPUVertexFormat): GPUVertexBufferLayout => {
    const fmt = format ?? fallback;
    const stride = format ? BYTES[fmt] : 0;
    if (stride === undefined) throw new Error(`vertexLayout: unsupported vertex format ${fmt}`);
    return { arrayStride: stride, attributes: [{ shaderLocation: loc, offset: 0, format: fmt }] };
  };
  l = {
    key,
    buffers: [
      stream(0, f.position, 'float32x3'),
      stream(1, f.normal, 'float32x3'),
      stream(2, f.uv, 'float32x2'),
      stream(3, f.tangent, 'float32x4'),
    ],
    defines: { OCT_NORMAL: !!f.octNormal, OCT_TANGENT: !!f.octTangent },
  };
  cache.set(key, l);
  return l;
}

/** Unquantized layout used by the glTF loader and procedural meshes. */
export const F32_VERTEX_LAYOUT = vertexLayout({ position: 'float32x3', normal: 'float32x3', uv: 'float32x2', tangent: 'float32x4' });

/** Short key for the shader-module cache (only defines that change WGSL). */
export function layoutShaderKey(l: VertexLayout): string {
  return Object.entries(l.defines).filter(([, on]) => on).map(([k]) => k).sort().join('+');
}
