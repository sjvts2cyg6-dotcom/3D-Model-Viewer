import { mat4, quat, vec3, type Mat4, type Quat, type Vec3 } from 'wgpu-matrix';
import type { GpuMesh } from '../renderer/mesh';

/**
 * Scene-graph node with a TRS local transform and a cached world matrix.
 * Call `markDirty()` after editing position/rotation/scale; world matrices
 * are only recomputed for dirty subtrees.
 */
export class Node {
  readonly position: Vec3 = vec3.create(0, 0, 0);
  readonly rotation: Quat = quat.identity();
  readonly scale: Vec3 = vec3.create(1, 1, 1);

  readonly localMatrix: Mat4 = mat4.identity();
  readonly worldMatrix: Mat4 = mat4.identity();
  /** Inverse-transpose of worldMatrix (for normals). */
  readonly normalMatrix: Mat4 = mat4.identity();

  parent: Node | null = null;
  readonly children: Node[] = [];
  mesh: GpuMesh | null = null;
  visible = true;

  private localDirty = true;
  private worldDirty = true;

  constructor(public name = '') {}

  add(child: Node): this {
    child.parent?.remove(child);
    child.parent = this;
    child.worldDirty = true;
    this.children.push(child);
    return this;
  }

  remove(child: Node): void {
    const i = this.children.indexOf(child);
    if (i >= 0) {
      this.children.splice(i, 1);
      child.parent = null;
      child.worldDirty = true;
    }
  }

  markDirty(): void {
    this.localDirty = true;
  }

  /** Sets TRS by decomposing a column-major matrix (glTF `matrix` nodes). */
  setMatrix(m: ArrayLike<number>): void {
    vec3.set(m[12], m[13], m[14], this.position);
    const sx = Math.hypot(m[0], m[1], m[2]);
    const sy = Math.hypot(m[4], m[5], m[6]);
    let sz = Math.hypot(m[8], m[9], m[10]);
    // Negative determinant -> mirror on Z.
    const det = mat4.determinant(m as unknown as Mat4);
    if (det < 0) sz = -sz;
    vec3.set(sx, sy, sz, this.scale);
    const r = mat4.identity();
    for (let c = 0; c < 3; c++) {
      const s = c === 0 ? sx : c === 1 ? sy : sz;
      r[c * 4 + 0] = m[c * 4 + 0] / s;
      r[c * 4 + 1] = m[c * 4 + 1] / s;
      r[c * 4 + 2] = m[c * 4 + 2] / s;
    }
    quat.fromMat(r, this.rotation);
    this.localDirty = true;
  }

  /** Recomputes world matrices for this subtree where needed. */
  updateWorld(parentWorld: Mat4 | null = null, parentChanged = false): void {
    let changed = parentChanged || this.worldDirty;
    if (this.localDirty) {
      composeTRS(this.position, this.rotation, this.scale, this.localMatrix);
      this.localDirty = false;
      changed = true;
    }
    if (changed) {
      if (parentWorld) mat4.multiply(parentWorld, this.localMatrix, this.worldMatrix);
      else mat4.copy(this.localMatrix, this.worldMatrix);
      mat4.transpose(mat4.inverse(this.worldMatrix, this.normalMatrix), this.normalMatrix);
      this.worldDirty = false;
    }
    for (const c of this.children) c.updateWorld(this.worldMatrix, changed);
  }

  traverse(fn: (n: Node) => void): void {
    fn(this);
    for (const c of this.children) c.traverse(fn);
  }
}

/** Column-major T * R * S without intermediate allocations. */
export function composeTRS(t: Vec3, q: Quat, s: Vec3, out: Mat4): Mat4 {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  const [sx, sy, sz] = s;
  out[0] = (1 - (yy + zz)) * sx; out[1] = (xy + wz) * sx;       out[2] = (xz - wy) * sx;        out[3] = 0;
  out[4] = (xy - wz) * sy;       out[5] = (1 - (xx + zz)) * sy; out[6] = (yz + wx) * sy;        out[7] = 0;
  out[8] = (xz + wy) * sz;       out[9] = (yz - wx) * sz;       out[10] = (1 - (xx + yy)) * sz; out[11] = 0;
  out[12] = t[0];                out[13] = t[1];                out[14] = t[2];                 out[15] = 1;
  return out;
}
