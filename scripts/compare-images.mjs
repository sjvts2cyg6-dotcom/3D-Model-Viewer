// Compare two same-sized PNG screenshots: prints PSNR, mean abs error and the
// share of pixels differing by more than a threshold; optionally writes an
// amplified diff image. Usage: node scripts/compare-images.mjs a.png b.png [diff.png]
import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';

const [a, b, diffOut] = process.argv.slice(2);
if (!a || !b) { console.error('usage: compare-images.mjs a.png b.png [diff.png]'); process.exit(2); }
const A = PNG.sync.read(readFileSync(a)), B = PNG.sync.read(readFileSync(b));
if (A.width !== B.width || A.height !== B.height) { console.error('size mismatch'); process.exit(2); }
const n = A.width * A.height;
const diff = new PNG({ width: A.width, height: A.height });
let se = 0, ae = 0, over8 = 0, max = 0, identical = 0;
for (let i = 0; i < n; i++) {
  let pmax = 0;
  for (let c = 0; c < 3; c++) {
    const d = Math.abs(A.data[i * 4 + c] - B.data[i * 4 + c]);
    se += d * d; ae += d; pmax = Math.max(pmax, d);
  }
  max = Math.max(max, pmax);
  if (pmax === 0) identical++;
  if (pmax > 8) over8++;
  const v = Math.min(255, pmax * 8);
  diff.data.set([v, v, v, 255], i * 4);
}
const mse = se / (n * 3);
const psnr = mse === 0 ? Infinity : 10 * Math.log10((255 * 255) / mse);
const result = {
  psnr: Number(psnr.toFixed(2)), meanAbs: Number((ae / (n * 3)).toFixed(3)), maxDiff: max,
  identicalPct: Number(((100 * identical) / n).toFixed(2)), over8Pct: Number(((100 * over8) / n).toFixed(3)),
};
console.log(JSON.stringify(result));
if (diffOut) writeFileSync(diffOut, PNG.sync.write(diff));
