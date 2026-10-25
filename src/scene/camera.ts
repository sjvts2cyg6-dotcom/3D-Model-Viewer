import { mat4, vec3, type Mat4, type Vec3 } from 'wgpu-matrix';

/** Perspective camera using WebGPU's [0, 1] clip-space depth. */
export class PerspectiveCamera {
  fovY = (45 * Math.PI) / 180;
  aspect = 1;
  near = 0.05;
  far = 500;

  readonly position: Vec3 = vec3.create(0, 0, 5);
  readonly target: Vec3 = vec3.create(0, 0, 0);
  readonly up: Vec3 = vec3.create(0, 1, 0);

  readonly view: Mat4 = mat4.identity();
  readonly projection: Mat4 = mat4.identity();
  readonly viewProjection: Mat4 = mat4.identity();

  update(): void {
    mat4.lookAt(this.position, this.target, this.up, this.view);
    mat4.perspective(this.fovY, this.aspect, this.near, this.far, this.projection);
    mat4.multiply(this.projection, this.view, this.viewProjection);
  }
}
