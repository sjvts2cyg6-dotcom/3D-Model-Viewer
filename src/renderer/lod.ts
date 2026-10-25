import { vec3 } from 'wgpu-matrix';
import type { PerspectiveCamera } from '../scene/camera';
import type { Node } from '../scene/node';
import type { GpuPrimitive } from './mesh';

/** Runtime LOD policy. Mutable at runtime via `renderer.lod`. */
export interface LodSettings {
  /** Max projected simplification error, in pixels, before a finer level is used. */
  pixelError: number;
  /** Force a level for every primitive (clamped to the available levels); null = automatic. */
  force: number | null;
}

export const DEFAULT_LOD_SETTINGS: Readonly<LodSettings> = { pixelError: 1, force: null };

/** Picks a level for one primitive instance. Replace `renderer.lodSelector` to customise. */
export type LodSelector = (
  prim: GpuPrimitive, node: Node, camera: PerspectiveCamera, viewportHeight: number, settings: LodSettings,
) => number;

const center = vec3.create();

/**
 * Screen-space error selector: projects each level's geometric error at the
 * distance of the primitive's bounding sphere (nearest point) and returns the
 * coarsest level whose error stays under `settings.pixelError`.
 */
export const screenSpaceLodSelector: LodSelector = (prim, node, camera, viewportHeight, settings) => {
  const n = prim.lods.length;
  if (n <= 1) return 0;
  if (settings.force !== null) return Math.min(n - 1, Math.max(0, Math.floor(settings.force)));

  const m = node.worldMatrix;
  // Largest axis scale of the world transform.
  const sx = Math.hypot(m[0], m[1], m[2]), sy = Math.hypot(m[4], m[5], m[6]), sz = Math.hypot(m[8], m[9], m[10]);
  const scale = Math.max(sx, sy, sz);

  const bmin = prim.boundsMin, bmax = prim.boundsMax;
  vec3.set((bmin[0] + bmax[0]) / 2, (bmin[1] + bmax[1]) / 2, (bmin[2] + bmax[2]) / 2, center);
  vec3.transformMat4(center, m, center);
  const radius = 0.5 * Math.hypot(bmax[0] - bmin[0], bmax[1] - bmin[1], bmax[2] - bmin[2]) * scale;
  const dist = Math.max(camera.near, vec3.distance(center, camera.position) - radius);

  const pixelsPerUnit = viewportHeight / (2 * Math.tan(camera.fovY / 2) * dist);
  const k = scale * pixelsPerUnit;
  let chosen = 0;
  for (let i = 1; i < n; i++) {
    if (prim.lods[i].error * k <= settings.pixelError) chosen = i;
    else break;
  }
  return chosen;
};
