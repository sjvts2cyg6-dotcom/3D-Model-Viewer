/**
 * Asset baker CLI. Human output by default; `--json` switches stdout to
 * newline-delimited JSON events for other programs (see PROTOCOL.md).
 *
 * Exit codes: 0 ok, 1 internal error, 2 usage, 3 input unreadable,
 *             4 device profile invalid / probe failed, 5 bake failed.
 */
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { BakeInputError, bakeFile } from './bake';
import { DETAIL_LEVELS, DeviceProfileError, deriveOptions, readDeviceProfile, type DetailLevel } from './device';
import { TARGETS, type BakeOptions, type TextureFormatOption } from './targets';

export const BAKE_PROTOCOL_VERSION = 1;

const HELP = `Usage: npm run bake -- <input.glb|input.gltf> [options]

Options:
  -o, --out <dir>             output directory (default: next to the input)
  --target <id>               target profile (${Object.keys(TARGETS).join(', ')}; default webgpu)
  --device <file|-|auto>      tailor to a DeviceProfile from the probe page: a JSON file,
                              '-' = read it from stdin, 'auto' = run the probe in headless Chrome here
  --detail <level>            low | medium | high | max (default medium; used with --device)
  --max-triangles <N>         full-detail triangle budget for the drawn scene (0 = unlimited)
  --lods <N>                  total LOD levels incl. full detail (webgpu default 4; 1 = off)
  --lod-ratio <r>             index-count ratio between LODs (default 0.5)
  --lod-max-error <e>         stop LODs above this relative error (default 0.05)
  --texture-format <f>        auto | uastc | etc1s | rgba8 (default auto)
  --max-texture-size <px>     clamp the largest texture side (default 4096)
  --etc1s-quality <1-255>     ETC1S quality (default 192)
  --uastc-level <0-4>         UASTC effort (default 2)
  --[no-]uastc-rdo            UASTC rate-distortion optimisation for data (ORM) maps (webgpu default on)
  --recompute-tangents        regenerate MikkTSpace tangents even if present
  --print-device              resolve --device, print the full profile (JSON event "profile") and exit
                              without baking; input not required
  --json                      machine-readable NDJSON events on stdout (see PROTOCOL.md)
  -q, --quiet                 only print the summary line
  -h, --help

Explicit options always override values derived from --device.
Exit codes: 0 ok, 1 internal, 2 usage, 3 input, 4 device profile, 5 bake.
`;

class UsageError extends Error { override name = 'UsageError'; }

interface Args {
  input: string; out?: string; target: string; quiet: boolean; json: boolean;
  device?: string; detail: DetailLevel; printDevice: boolean; overrides: Partial<BakeOptions>;
}

function parseArgs(argv: string[]): Args | 'help' {
  const overrides: Partial<BakeOptions> = {};
  let input: string | undefined, out: string | undefined, target = 'webgpu', quiet = false, json = false;
  let device: string | undefined, detail: DetailLevel = 'medium', printDevice = false;
  const val = (flag: string, v: string | undefined): string => {
    if (v === undefined) throw new UsageError(`${flag} expects a value`);
    return v;
  };
  const num = (flag: string, v: string | undefined): number => {
    const n = Number(val(flag, v));
    if (!Number.isFinite(n)) throw new UsageError(`${flag} expects a number`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h': case '--help': return 'help';
      case '-o': case '--out': out = val(a, argv[++i]); break;
      case '--target': target = val(a, argv[++i]); break;
      case '--device': device = val(a, argv[++i]); break;
      case '--detail': {
        const d = val(a, argv[++i]) as DetailLevel;
        if (!DETAIL_LEVELS.includes(d)) throw new UsageError(`--detail must be ${DETAIL_LEVELS.join(' | ')}`);
        detail = d; break;
      }
      case '--max-triangles': overrides.maxTriangles = Math.max(0, Math.floor(num(a, argv[++i]))); break;
      case '--lods': overrides.lods = Math.max(1, Math.floor(num(a, argv[++i]))); break;
      case '--lod-ratio': overrides.lodRatio = num(a, argv[++i]); break;
      case '--lod-max-error': overrides.lodMaxError = num(a, argv[++i]); break;
      case '--texture-format': overrides.textureFormat = val(a, argv[++i]) as TextureFormatOption; break;
      case '--max-texture-size': overrides.maxTextureSize = num(a, argv[++i]); break;
      case '--etc1s-quality': overrides.etc1sQuality = num(a, argv[++i]); break;
      case '--uastc-level': overrides.uastcLevel = num(a, argv[++i]); break;
      case '--uastc-rdo': overrides.uastcRdo = true; break;
      case '--no-uastc-rdo': overrides.uastcRdo = false; break;
      case '--recompute-tangents': overrides.recomputeTangents = true; break;
      case '--json': json = true; break;
      case '--print-device': printDevice = true; break;
      case '-q': case '--quiet': quiet = true; break;
      default:
        if (a.startsWith('-')) throw new UsageError(`unknown option ${a}`);
        if (input) throw new UsageError(`unexpected extra argument ${a}`);
        input = a;
    }
  }
  if (printDevice && !device) throw new UsageError('--print-device needs --device');
  if (!input && !printDevice) throw new UsageError('missing input file');
  return { input: input ?? '', out, target, quiet, json, device, detail, printDevice, overrides };
}

const EXIT = { ok: 0, internal: 1, usage: 2, input: 3, device: 4, bake: 5 } as const;
type ErrorCode = Exclude<keyof typeof EXIT, 'ok'>;

let jsonMode = process.argv.includes('--json');
const t0 = performance.now();
function emit(event: string, data: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify({ event, t: Math.round(performance.now() - t0), ...data }) + '\n');
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') { process.stdout.write(HELP); return EXIT.ok; }
  const args = parsed;
  jsonMode = args.json;
  const info = (m: string) => { if (jsonMode) emit('log', { level: 'info', message: m }); else if (!args.quiet) console.log(`  ${m}`); };
  const warn = (m: string) => { if (jsonMode) emit('log', { level: 'warn', message: m }); else console.warn(`  warning: ${m}`); };
  if (jsonMode) emit('start', { tool: 'wgm-bake', protocol: BAKE_PROTOCOL_VERSION, input: args.input, target: args.target, pid: process.pid });

  if (args.printDevice) {
    const profile = await resolveProfile(args.device!, info);
    if (jsonMode) emit('profile', { source: sourceOf(args.device!), profile });
    else process.stdout.write(JSON.stringify(profile, null, 2) + '\n');
    return EXIT.ok;
  }

  let inSize: number;
  try { inSize = (await stat(args.input)).size; } catch { throw new BakeInputError(`input not found: ${args.input}`); }

  // Device profile -> derived options; explicit flags win.
  let derived: Partial<BakeOptions> = {};
  let deviceSummary: Record<string, unknown> | undefined;
  if (args.device) {
    const profile = await resolveProfile(args.device, info);
    const source = sourceOf(args.device);
    const d = deriveOptions(profile, args.detail);
    derived = d.options;
    deviceSummary = { source, ...d.summary };
    const overridden = Object.keys(d.options).filter((k) => k in args.overrides);
    if (jsonMode) emit('device', { source, summary: d.summary, decisions: d.decisions, options: d.options, overriddenByFlags: overridden });
    else {
      info(`device profile (${source}): ${d.summary.deviceClass}, ${d.summary.gpu || 'unknown GPU'}, screen ${d.summary.screen}`);
      for (const line of d.decisions) info(`  ${line}`);
      if (overridden.length) info(`  overridden by flags: ${overridden.join(', ')}`);
    }
  }

  let result;
  try {
    result = await bakeFile(args.input, args.target, { ...derived, ...args.overrides }, { log: info, warn }, deviceSummary);
  } catch (e) {
    if (e instanceof BakeInputError || e instanceof DeviceProfileError) throw e;
    if (/unknown target|does not support --texture-format/.test((e as Error).message)) throw new UsageError((e as Error).message);
    throw Object.assign(e as Error, { bakeFailure: true });
  }
  const outDir = args.out ?? path.dirname(args.input);
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, path.basename(args.input).replace(/\.(glb|gltf)$/i, '') + result.target.fileExtension);
  await writeFile(outPath, result.bytes);
  const ms = Math.round(performance.now() - t0);
  const s = result.stats as { vertices?: number; triangles?: number; lodTriangles?: number[] };
  if (jsonMode) {
    emit('result', {
      output: path.resolve(outPath), inputBytes: inSize, outputBytes: result.bytes.byteLength, ms,
      target: result.target.id, options: result.options, stats: result.stats, device: deviceSummary ?? null,
    });
  } else {
    const kib = (n: number) => `${(n / 1024).toFixed(1)} KiB`;
    console.log(
      `${path.basename(args.input)} -> ${outPath}  [${result.target.id}, textures ${result.options.textureFormat}]\n` +
      `  ${kib(inSize)} -> ${kib(result.bytes.byteLength)}  verts ${s.vertices}  tris ${s.triangles}` +
      `  LOD tris [${(s.lodTriangles ?? []).join(', ')}]  ${ms} ms`,
    );
  }
  return EXIT.ok;
}

const sourceOf = (device: string) => device === 'auto' ? 'headless' : device === '-' ? 'stdin' : 'file';

async function resolveProfile(device: string, info: (m: string) => void) {
  if (device === 'auto') {
    info('probing this machine in headless Chrome (--device auto)...');
    const { probeHeadless } = await import('./headlessProbe');
    return probeHeadless();
  }
  return readDeviceProfile(device);
}

function classify(e: unknown): ErrorCode {
  if (e instanceof UsageError) return 'usage';
  if (e instanceof BakeInputError) return 'input';
  if (e instanceof DeviceProfileError) return 'device';
  if ((e as { bakeFailure?: boolean })?.bakeFailure) return 'bake';
  return 'internal';
}

main().then((code) => { process.exitCode = code; }, (e: unknown) => {
  const code = classify(e);
  const message = e instanceof Error ? e.message : String(e);
  if (jsonMode) emit('error', { code, exitCode: EXIT[code], message });
  else console.error(`bake failed: ${message}${code === 'usage' ? `\n\n${HELP}` : ''}`);
  process.exitCode = EXIT[code];
});
