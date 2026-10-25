import { vec3, type Vec3 } from 'wgpu-matrix';
import type { PerspectiveCamera } from '../scene/camera';
import type { Aabb } from '../scene/bounds';

/**
 * Orbit camera driven by Pointer Events, so mouse, pen and touch share one path.
 *   mouse : left-drag orbit, right/middle/shift-drag pan, wheel zoom
 *   touch : 1 finger orbit, 2 fingers pinch-zoom + pan
 * Motion is damped with a framerate-independent exponential smoother.
 */
export class OrbitControls {
  readonly target: Vec3 = vec3.create(0, 0, 0);
  yaw = 0;
  pitch = 0.2;
  distance = 5;
  minDistance = 0.01;
  maxDistance = 1000;
  rotateSpeed = 2.5;      // radians per viewport-height dragged
  zoomSpeed = 1;
  /** Higher = snappier. ~10-20 feels good; Infinity disables damping. */
  damping = 14;
  enabled = true;

  private goal = { yaw: 0, pitch: 0.2, distance: 5, target: vec3.create(0, 0, 0) };
  private readonly pointers = new Map<number, { x: number; y: number; button: number; shift: boolean }>();
  private pinchDist = 0;
  private pinchMid = { x: 0, y: 0 };
  private readonly unbind: () => void;

  constructor(private readonly element: HTMLElement, private readonly camera: PerspectiveCamera) {
    element.style.touchAction = 'none';
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      element.addEventListener(type, fn, opts);
      return () => element.removeEventListener(type, fn);
    };
    const offs = [
      on('pointerdown', this.onDown),
      on('pointermove', this.onMove),
      on('pointerup', this.onUp),
      on('pointercancel', this.onUp),
      on('wheel', this.onWheel, { passive: false }),
      on('contextmenu', (e) => e.preventDefault()),
    ];
    this.unbind = () => offs.forEach((off) => off());
  }

  dispose(): void {
    this.unbind();
  }

  /** Points the camera at a bounding box and sets sane near/far planes. */
  frame(bounds: Aabb, padding = 1.0): void {
    const center = vec3.lerp(bounds.min, bounds.max, 0.5);
    const radius = Math.max(vec3.distance(bounds.min, bounds.max) * 0.5, 1e-3);
    const dist = (radius * padding) / Math.sin(this.camera.fovY / 2);
    vec3.copy(center, this.goal.target);
    vec3.copy(center, this.target);
    this.goal.distance = this.distance = dist;
    this.minDistance = radius * 0.05;
    this.maxDistance = radius * 50;
    this.camera.near = radius * 0.01;
    this.camera.far = radius * 100;
    this.apply();
  }

  setAngles(yaw: number, pitch: number): void {
    this.goal.yaw = this.yaw = yaw;
    this.goal.pitch = this.pitch = pitch;
    this.apply();
  }

  /** Call once per frame before rendering. */
  update(dt: number): void {
    const k = Number.isFinite(this.damping) ? 1 - Math.exp(-this.damping * dt) : 1;
    this.yaw += (this.goal.yaw - this.yaw) * k;
    this.pitch += (this.goal.pitch - this.pitch) * k;
    this.distance += (this.goal.distance - this.distance) * k;
    vec3.lerp(this.target, this.goal.target, k, this.target);
    this.apply();
  }

  private apply(): void {
    const cp = Math.cos(this.pitch);
    const offset = vec3.create(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
    vec3.addScaled(this.target, offset, this.distance, this.camera.position);
    vec3.copy(this.target, this.camera.target);
  }

  // ---------------------------------------------------------------- input

  private rotate(dx: number, dy: number): void {
    const h = this.element.clientHeight || 1;
    this.goal.yaw -= (dx / h) * this.rotateSpeed;
    const limit = Math.PI / 2 - 0.01;
    this.goal.pitch = Math.max(-limit, Math.min(limit, this.goal.pitch + (dy / h) * this.rotateSpeed));
  }

  private pan(dx: number, dy: number): void {
    const h = this.element.clientHeight || 1;
    const worldPerPixel = (2 * this.goal.distance * Math.tan(this.camera.fovY / 2)) / h;
    const fwd = vec3.normalize(vec3.subtract(this.camera.target, this.camera.position));
    const right = vec3.normalize(vec3.cross(fwd, this.camera.up));
    const up = vec3.cross(right, fwd);
    vec3.addScaled(this.goal.target, right, -dx * worldPerPixel, this.goal.target);
    vec3.addScaled(this.goal.target, up, dy * worldPerPixel, this.goal.target);
  }

  private zoom(factor: number): void {
    this.goal.distance = Math.max(this.minDistance, Math.min(this.maxDistance, this.goal.distance * factor));
  }

  private pinchState(): { dist: number; mid: { x: number; y: number } } {
    const [a, b] = [...this.pointers.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  }

  private onDown = (e: PointerEvent): void => {
    if (!this.enabled) return;
    this.element.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey });
    if (this.pointers.size === 2) {
      const s = this.pinchState();
      this.pinchDist = s.dist;
      this.pinchMid = s.mid;
    }
  };

  private onMove = (e: PointerEvent): void => {
    const p = this.pointers.get(e.pointerId);
    if (!p || !this.enabled) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;

    if (this.pointers.size === 1) {
      const panning = p.button === 1 || p.button === 2 || p.shift;
      if (panning) this.pan(dx, dy);
      else this.rotate(dx, dy);
    } else if (this.pointers.size === 2) {
      const s = this.pinchState();
      if (this.pinchDist > 0 && s.dist > 0) this.zoom(this.pinchDist / s.dist);
      this.pan(s.mid.x - this.pinchMid.x, s.mid.y - this.pinchMid.y);
      this.pinchDist = s.dist;
      this.pinchMid = s.mid;
    }
  };

  private onUp = (e: PointerEvent): void => {
    this.pointers.delete(e.pointerId);
    if (this.element.hasPointerCapture(e.pointerId)) this.element.releasePointerCapture(e.pointerId);
    this.pinchDist = 0;
  };

  private onWheel = (e: WheelEvent): void => {
    if (!this.enabled) return;
    e.preventDefault();
    // deltaMode 1 = lines (Firefox), normalise roughly to pixels.
    const delta = e.deltaY * (e.deltaMode === 1 ? 16 : 1);
    this.zoom(Math.exp(delta * 0.001 * this.zoomSpeed));
  };
}
