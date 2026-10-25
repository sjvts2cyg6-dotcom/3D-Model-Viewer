import { vec3, type Vec3 } from 'wgpu-matrix';
import { Node } from './node';

export interface DirectionalLight {
  /** Direction the light travels (world space, need not be normalised). */
  direction: Vec3;
  color: Vec3;
  intensity: number;
  /**
   * Whether this light casts shadows. Only honoured when the renderer was
   * created with `{ shadows: ... }` (opt-in, see renderer/config.ts); the
   * light-space matrix comes from `computeDirectionalLightViewProj` (lighting.ts).
   */
  castShadows: boolean;
}

export interface Environment {
  /** Simple hemisphere ambient: sky colour (up) and ground colour (down). */
  skyColor: Vec3;
  groundColor: Vec3;
  intensity: number;
}

export class Scene {
  readonly root = new Node('root');

  light: DirectionalLight = {
    direction: vec3.normalize(vec3.create(-0.4, -1.0, -0.6)),
    color: vec3.create(1.0, 0.97, 0.92),
    intensity: 3.0,
    castShadows: false,
  };

  ambient: Environment = {
    skyColor: vec3.create(0.55, 0.62, 0.75),
    groundColor: vec3.create(0.22, 0.2, 0.18),
    intensity: 1.0,
  };

  add(node: Node): this {
    this.root.add(node);
    return this;
  }

  update(): void {
    this.root.updateWorld();
  }
}
