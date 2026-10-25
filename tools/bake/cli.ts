/**
 * Asset baker CLI.
 *
 *   npm run bake -- <input.glb|.gltf> [-o <outdir>] [--target webgpu] [--lods N]
 *                   [--texture-format auto|uastc|etc1s|rgba8] [--max-texture-size N]
 *                   [--lod-ratio R] [--lod-max-error E] [--etc1s-quality Q] [--uastc-level L]
 *                   [--[no-]uastc-rdo] [--recompute-tangents] [--quiet]
 */
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { bakeFile } from './bake';
import { TARGETS, type BakeOptions, type TextureFormatOption } from './targets';

const HELP = `Usage: npm run bake -- <input.glb|input.gltf> [options]

Options:
  -o, --out <dir>             output directory (default: next to the input)
  --target <id>               target profile (${Object.keys(TARGETS).join(', ')}; default webgpu)
  --lods <N>                  total LOD levels incl. full detail (webgpu default 4; 1 = off)
  --lod-ratio <r>             index-count ratio between LODs (default 0.5)
  --lod-max-error <e>         stop LODs above this relative error (default 0.05)
  --texture-format <f>        auto | uastc | etc1s | rgba8 (default auto)
  --max-texture-size <px>     clamp the largest texture side (default 4096)
  --etc1s-quality <1-255>     ETC1S quality (default 192)
  --uastc-level <0-4>         UASTC effort (default 2)
  --[no-]uastc-rdo            UASTC rate-distortion optimisation for data (ORM) maps (webgpu default on)
  --recompute-tangents        regenerate MikkTSpace tangents even if present
  -q, --quiet                 only print the summary line
  -h, --help
`;

function parseArgs(argv: string[]): { input: string; out?: string; target: string; quiet: boolean; overrides: Partial<BakeOptions> } {
  const overrides: Partial<BakeOptions> = {};
  let input: string | undefined, out: string | undefined, target = 'webgpu', quiet = false;
  const num = (flag: string, v: string | undefined): number => {
    const n = Number(v);
    if (v === undefined || !Number.isFinite(n)) throw new Error(`${flag} expects a number`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h': case '--help': process.stdout.write(HELP); process.exit(0);
      // falls through (unreachable)
      case '-o': case '--out': out = argv[++i]; break;
      case '--target': target = argv[++i]; break;
      case '--lods': overrides.lods = Math.max(1, Math.floor(num(a, argv[++i]))); break;
      case '--lod-ratio': overrides.lodRatio = num(a, argv[++i]); break;
      case '--lod-max-error': overrides.lodMaxError = num(a, argv[++i]); break;
      case '--texture-format': overrides.textureFormat = argv[++i] as TextureFormatOption; break;
      case '--max-texture-size': overrides.maxTextureSize = num(a, argv[++i]); break;
      case '--etc1s-quality': overrides.etc1sQuality = num(a, argv[++i]); break;
      case '--uastc-level': overrides.uastcLevel = num(a, argv[++i]); break;
      case '--uastc-rdo': overrides.uastcRdo = true; break;
      case '--no-uastc-rdo': overrides.uastcRdo = false; break;
      case '--recompute-tangents': overrides.recomputeTangents = true; break;
      case '-q': case '--quiet': quiet = true; break;
      default:
        if (a.startsWith('-')) throw new Error(`unknown option ${a}\n\n${HELP}`);
        if (input) throw new Error(`unexpected extra argument ${a}`);
        input = a;
    }
  }
  if (!input) throw new Error(`missing input file\n\n${HELP}`);
  return { input, out, target, quiet, overrides };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = (m: string) => { if (!args.quiet) console.log(`  ${m}`); };
  const warn = (m: string) => console.warn(`  warning: ${m}`);
  const t0 = performance.now();
  const result = await bakeFile(args.input, args.target, args.overrides, { log, warn });
  const outDir = args.out ?? path.dirname(args.input);
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, path.basename(args.input).replace(/\.(glb|gltf)$/i, '') + result.target.fileExtension);
  await writeFile(outPath, result.bytes);
  const inSize = (await stat(args.input)).size;
  const kib = (n: number) => `${(n / 1024).toFixed(1)} KiB`;
  const s = result.stats as { vertices?: number; triangles?: number; lodTriangles?: number[] };
  console.log(
    `${path.basename(args.input)} -> ${outPath}  [${result.target.id}, textures ${result.options.textureFormat}]\n` +
    `  ${kib(inSize)} -> ${kib(result.bytes.byteLength)}  verts ${s.vertices}  tris ${s.triangles}` +
    `  LOD tris [${(s.lodTriangles ?? []).join(', ')}]  ${(performance.now() - t0).toFixed(0)} ms`,
  );
}

main().catch((e: unknown) => {
  console.error(`bake failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
