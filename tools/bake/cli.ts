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
import { BASE_OPTIONS, BakeInputError, bakeFile } from './bake';
import { DETAIL_LEVELS, DeviceProfileError, deriveOptions, readDeviceProfile, type DetailLevel } from './device';
import { TARGETS, type BakeOptions, type TextureFormatOption } from './targets';
import { ASTC_BLOCKS, NATIVE_FORMATS, type AstcBlock } from './textures/native';
import { listPresets } from './device';
import type { NormalEncoding, VertexPrecision } from './quantize';

export const BAKE_PROTOCOL_VERSION = 1;

const HELP = `Usage: npm run bake -- <input.glb|input.gltf> [options]

Options:
  -o, --out <dir>             output directory (default: next to the input)
  --target <id>               target profile (${Object.keys(TARGETS).join(', ')}; default webgpu)
  --device <file|-|auto|preset>
                              tailor to a DeviceProfile from the probe page: a JSON file,
                              '-' = read it from stdin, 'auto' = run the probe in headless Chrome here,
                              or a built-in preset (estimates, not measurements): ${listPresets().join(', ')}
                              (also as preset:<name>)
  --detail <level>            low | medium | high | max (default medium; used with --device)
  --max-triangles <N>         full-detail triangle budget for the drawn scene (0 = unlimited)
  --lods <N>                  total LOD levels incl. full detail (webgpu default 4; 1 = off)
  --lod-ratio <r>             index-count ratio between LODs (default 0.5)
  --lod-max-error <e>         stop LODs above this relative error (default 0.05)
  --texture-format <f>        GPU-native, uploaded as-is (no decode/transcode at load):
                                auto (from --device; BC7 without a profile) | bc7 | astc | etc2 | rgba8
                                each = one file per native format: <name>.bc7.wgm, .astc.wgm, .etc2.wgm, .rgba8.wgm
                              transcoded at load (opt-in only):
                                universal = KTX2/Basis (ETC1S colour, UASTC data); uastc | etc1s force the codec
  --astc-block <WxH>          ${ASTC_BLOCKS.join(' | ')} (default 4x4; 6x6 from a profile at --detail low)
  --astc-quality <q>          fast | medium | thorough (default medium)
  --max-texture-size <px>     clamp the largest texture side (default 4096)
  --vertex-precision <p>      auto = smallest GPU vertex formats within the device's visible tolerance (default)
                              full = float32 streams; low = smallest formats regardless of error
  --normal-encoding <e>       auto (snorm8/16 xyz) | oct (octahedral snorm16x2, decoded in the vertex shader)
  --pixel-error <px>          position tolerance in screen pixels (default from --detail; 0.5 without a profile)
  --uastc-level <0-4>         UASTC effort (BC7/ETC2 intermediate and universal; default 2)
  --etc1s-quality <1-255>     universal only: ETC1S quality (default 192)
  --[no-]uastc-rdo            universal only: UASTC rate-distortion optimisation (default off)
  --zstd                      universal only: Zstd-supercompress UASTC (decompressed at load; default off)
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
  device?: string; detail: DetailLevel; printDevice: boolean; overrides: Partial<BakeOptions>; pixelError?: number;
}

function parseArgs(argv: string[]): Args | 'help' {
  const overrides: Partial<BakeOptions> = {};
  let input: string | undefined, out: string | undefined, target = 'webgpu', quiet = false, json = false;
  let device: string | undefined, detail: DetailLevel = 'medium', printDevice = false, pixelError: number | undefined;
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
      case '--astc-block': {
        const b = val(a, argv[++i]) as AstcBlock;
        if (!ASTC_BLOCKS.includes(b)) throw new UsageError(`--astc-block must be ${ASTC_BLOCKS.join(' | ')}`);
        overrides.astcBlock = b; break;
      }
      case '--astc-quality': {
        const q = val(a, argv[++i]);
        if (q !== 'fast' && q !== 'medium' && q !== 'thorough') throw new UsageError('--astc-quality must be fast | medium | thorough');
        overrides.astcQuality = q; break;
      }
      case '--vertex-precision': {
        const v = val(a, argv[++i]) as VertexPrecision;
        if (!['full', 'auto', 'low'].includes(v)) throw new UsageError('--vertex-precision must be full | auto | low');
        overrides.vertexPrecision = v; break;
      }
      case '--normal-encoding': {
        const v = val(a, argv[++i]) as NormalEncoding;
        if (v !== 'auto' && v !== 'oct') throw new UsageError('--normal-encoding must be auto | oct');
        overrides.normalEncoding = v; break;
      }
      case '--pixel-error': pixelError = num(a, argv[++i]); break;
      case '--zstd': overrides.zstd = true; break;
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
  return { input: input ?? '', out, target, quiet, json, device, detail, printDevice, overrides, pixelError };
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

  const merged: Partial<BakeOptions> = { ...derived, ...args.overrides };
  if (args.pixelError !== undefined) {
    merged.vertexTolerance = { ...BASE_OPTIONS.vertexTolerance, ...derived.vertexTolerance, pixelError: args.pixelError };
  }
  // `each`: one bake per native format, for targets whose formats are unknown.
  const formats: (TextureFormatOption | null)[] = merged.textureFormat === 'each' ? [...NATIVE_FORMATS] : [null];
  const outDir = args.out ?? path.dirname(args.input);
  await mkdir(outDir, { recursive: true });
  const stem = path.basename(args.input).replace(/\.(glb|gltf)$/i, '');
  const outputs: string[] = [];
  let last: Record<string, unknown> | undefined;
  for (const fmt of formats) {
    let result;
    try {
      result = await bakeFile(args.input, args.target, fmt ? { ...merged, textureFormat: fmt } : merged, { log: info, warn }, deviceSummary);
    } catch (e) {
      if (e instanceof BakeInputError || e instanceof DeviceProfileError) throw e;
      if (/unknown target|does not support --texture-format/.test((e as Error).message)) throw new UsageError((e as Error).message);
      throw Object.assign(e as Error, { bakeFailure: true });
    }
    const outPath = path.join(outDir, stem + (fmt ? `.${fmt}` : '') + result.target.fileExtension);
    await writeFile(outPath, result.bytes);
    outputs.push(path.resolve(outPath));
    const ms = Math.round(performance.now() - t0);
    const s = result.stats as { vertices?: number; triangles?: number; lodTriangles?: number[]; vertexBytesF32?: number; vertexBytes?: number };
    last = {
      output: path.resolve(outPath), inputBytes: inSize, outputBytes: result.bytes.byteLength, ms,
      target: result.target.id, options: result.options, stats: result.stats, device: deviceSummary ?? null,
    };
    if (fmt) {
      if (jsonMode) emit('output', last);
    }
    if (!jsonMode) {
      const kib = (n: number) => `${(n / 1024).toFixed(1)} KiB`;
      console.log(
        `${path.basename(args.input)} -> ${outPath}  [${result.target.id}, textures ${String((result.stats as Record<string, unknown>).textureFormat ?? result.options.textureFormat)}]\n` +
        `  ${kib(inSize)} -> ${kib(result.bytes.byteLength)}  verts ${s.vertices}  tris ${s.triangles}` +
        `  vertex data ${s.vertexBytesF32 !== undefined ? `${kib(s.vertexBytesF32)} -> ${kib(s.vertexBytes ?? 0)}` : '?'}` +
        `  LOD tris [${(s.lodTriangles ?? []).join(', ')}]  ${ms} ms`,
      );
    }
  }
  if (jsonMode && last) {
    if (outputs.length > 1) {
      // One summary event; `output` is a template the viewer resolves ({tex} -> best supported format).
      emit('result', {
        ...last, output: path.join(path.resolve(outDir), `${stem}.{tex}.wgm`), outputs,
        options: { ...(last.options as object), textureFormat: 'each' },
        outputBytes: undefined, stats: undefined,
      });
    } else emit('result', last);
  }
  return EXIT.ok;
}

const sourceOf = (device: string) => device === 'auto' ? 'headless' : device === '-' ? 'stdin'
  : device.startsWith('preset:') || (!device.includes('/') && !device.endsWith('.json') && listPresets().includes(device)) ? 'preset' : 'file';

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
