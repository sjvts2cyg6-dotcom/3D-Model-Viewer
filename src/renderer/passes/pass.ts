import type { GpuContext } from '../../core/gpu';
import type { PerspectiveCamera } from '../../scene/camera';
import type { Node } from '../../scene/node';
import type { Scene } from '../../scene/scene';
import type { ResolvedRendererConfig } from '../config';
import type { ShaderFeatures } from '../features';
import type { GpuPrimitive } from '../mesh';
import type { PipelineCache, SharedLayouts } from '../pipelines';

/** Long-lived resources a pass may use; handed to `setup` once. */
export interface PassContext {
  readonly device: GPUDevice;
  readonly gpu: GpuContext;
  readonly config: ResolvedRendererConfig;
  readonly features: ShaderFeatures;
  readonly layouts: SharedLayouts;
  readonly pipelines: PipelineCache;
}

export interface DrawItem {
  readonly node: Node;
  readonly prim: GpuPrimitive;
  sortKey: number;
  /** Index into the per-draw uniform buffer (dynamic offset = slot * drawStride). */
  slot: number;
  /** Selected level of detail (index into prim.lods). */
  lod: number;
}

export interface RenderStats {
  drawCalls: number;
  triangles: number;
  pipelineSwitches: number;
  /** Draws that used a reduced level of detail (lod > 0). */
  lodReducedDraws: number;
}

/** Per-frame data built once by the Renderer and shared by all passes. */
export interface FrameData {
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  /** Sorted: opaque/mask by pipeline+material, then blend. */
  readonly drawList: readonly DrawItem[];
  readonly drawBindGroup: GPUBindGroup;
  readonly drawStride: number;
  /** Group 0: frame uniforms + any pass-provided frame bindings. */
  readonly frameBindGroup: GPUBindGroup;
  /** Frame uniform staging array; passes may write their own fields in `prepare`. */
  readonly frameUniforms: Float32Array;
  readonly swapTexture: GPUTexture;
  readonly swapView: GPUTextureView;
  readonly width: number;
  readonly height: number;
  readonly stats: RenderStats;
}

/**
 * A render pass/feature. The Renderer owns an ordered list of these, built
 * from the config, and calls them in order every frame:
 *
 *   setup(ctx)            once, after registration
 *   resize(w, h)          when the swap chain size changes (and before the first frame)
 *   prepare(frame)        CPU work before uniforms are uploaded (optional)
 *   execute(enc, frame)   record GPU commands
 *   destroy()             release GPU resources
 *
 * Passes that feed data into the main lighting shader (e.g. a shadow map)
 * expose it through `frameBindGroupEntries`, which the Renderer merges into
 * group 0 at the reserved binding slots (see FRAME_BINDING).
 */
export interface RenderPass {
  readonly name: string;
  enabled: boolean;
  setup(ctx: PassContext): void;
  resize(width: number, height: number): void;
  prepare?(frame: FrameData): void;
  execute(encoder: GPUCommandEncoder, frame: FrameData): void;
  destroy(): void;
  /** Extra group-0 entries this pass provides (must match the frame layout for the active features). */
  frameBindGroupEntries?(): GPUBindGroupEntry[];
}
