/**
 * Keeps the canvas backing store in sync with its CSS size * devicePixelRatio.
 *
 * Uses `device-pixel-content-box` when available (exact physical pixels, no
 * rounding blur); falls back to contentBox * devicePixelRatio (e.g. Safari).
 * `maxPixelRatio` lets low-power targets (phones) cap fill-rate cost.
 */
export interface ResizeOptions {
  maxTextureDimension: number;
  maxPixelRatio?: number;
  onResize?: (width: number, height: number) => void;
}

export function observeCanvasSize(canvas: HTMLCanvasElement, opts: ResizeOptions): () => void {
  const maxRatio = opts.maxPixelRatio ?? Infinity;

  const apply = (w: number, h: number) => {
    w = Math.max(1, Math.min(Math.round(w), opts.maxTextureDimension));
    h = Math.max(1, Math.min(Math.round(h), opts.maxTextureDimension));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      opts.onResize?.(w, h);
    }
  };

  const observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const dpr = window.devicePixelRatio || 1;
      const scale = Math.min(1, maxRatio / dpr);
      const dpBox = entry.devicePixelContentBoxSize?.[0];
      if (dpBox) {
        apply(dpBox.inlineSize * scale, dpBox.blockSize * scale);
      } else {
        const box = entry.contentBoxSize?.[0];
        const cssW = box ? box.inlineSize : entry.contentRect.width;
        const cssH = box ? box.blockSize : entry.contentRect.height;
        const ratio = Math.min(dpr, maxRatio);
        apply(cssW * ratio, cssH * ratio);
      }
    }
  });

  try {
    observer.observe(canvas, { box: 'device-pixel-content-box' });
  } catch {
    observer.observe(canvas, { box: 'content-box' });
  }
  return () => observer.disconnect();
}
