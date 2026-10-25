/**
 * requestAnimationFrame loop with clamped delta time. rAF already pauses in
 * background tabs; the clamp prevents a giant dt step when we come back.
 */
export type TickFn = (dt: number, time: number) => void;

export class FrameLoop {
  private handle = 0;
  private last = 0;
  private running = false;

  constructor(private readonly tick: TickFn, private readonly maxDt = 0.1) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const frame = (now: number) => {
      if (!this.running) return;
      const dt = Math.min((now - this.last) / 1000, this.maxDt);
      this.last = now;
      this.tick(dt, now / 1000);
      this.handle = requestAnimationFrame(frame);
    };
    this.handle = requestAnimationFrame(frame);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.handle);
  }
}
