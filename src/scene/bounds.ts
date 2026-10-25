import { vec3, type Mat4, type Vec3 } from 'wgpu-matrix';
import type { Node } from './node';

export interface Aabb { min: Vec3; max: Vec3 }

export function emptyAabb(): Aabb {
  return { min: vec3.create(Infinity, Infinity, Infinity), max: vec3.create(-Infinity, -Infinity, -Infinity) };
}

export function isEmpty(b: Aabb): boolean {
  return b.min[0] > b.max[0];
}

/** Expands `out` by the 8 corners of local box (min,max) transformed by m. */
export function expandByTransformedBox(out: Aabb, min: Vec3, max: Vec3, m: Mat4): void {
  const p = vec3.create();
  for (let i = 0; i < 8; i++) {
    vec3.set(i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2], p);
    vec3.transformMat4(p, m, p);
    vec3.min(out.min, p, out.min);
    vec3.max(out.max, p, out.max);
  }
}

/** World-space bounds of every mesh under `root` (call updateWorld first). */
export function computeWorldBounds(root: Node): Aabb {
  const out = emptyAabb();
  root.traverse((n) => {
    if (!n.mesh) return;
    for (const p of n.mesh.primitives) expandByTransformedBox(out, p.boundsMin, p.boundsMax, n.worldMatrix);
  });
  return out;
}
