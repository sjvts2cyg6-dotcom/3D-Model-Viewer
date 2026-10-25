import { mat4, vec3, type Mat4 } from 'wgpu-matrix';
import type { Aabb } from './bounds';
import type { DirectionalLight } from './scene';

/**
 * Light-space view-projection for a directional light that encloses `bounds`
 * (hook for a future ShadowPass; unused while shadows are disabled).
 *
 * Fits an orthographic box around the bounding *sphere* of the AABB, which is
 * rotation-stable (no shimmering when the camera orbits). Output uses WebGPU
 * clip conventions (depth 0..1), matching `directionalLightVisibility` in pbr.wgsl.
 * Cascaded / camera-frustum fitting can replace this without touching the shader contract.
 */
export function computeDirectionalLightViewProj(light: DirectionalLight, bounds: Aabb, out: Mat4 = mat4.create()): Mat4 {
  const center = vec3.lerp(bounds.min, bounds.max, 0.5);
  const radius = Math.max(vec3.distance(bounds.min, bounds.max) * 0.5, 1e-4);
  const dir = vec3.normalize(light.direction);
  const eye = vec3.addScaled(center, dir, -2 * radius);
  const up = Math.abs(dir[1]) > 0.99 ? vec3.create(0, 0, 1) : vec3.create(0, 1, 0);
  const view = mat4.lookAt(eye, center, up);
  const proj = mat4.ortho(-radius, radius, -radius, radius, radius * 0.5, radius * 3.5);
  return mat4.multiply(proj, view, out);
}
