/**
 * npm run local -- <model.glb|.gltf> [-o out/] [orchestrator flags] [baker flags...]
 * Probe this machine in its real browser, then bake for it. See README / PROTOCOL.md.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EXIT, Orchestrator, OrchestratorError, defaultCacheDir, type OrchestratorOptions } from './orchestrator';
import { splitCommand } from './processes';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const HELP = `Usage: npm run local -- <model.glb|model.gltf> [options] [baker options]

Probes this machine in its real default browser (the probe page reports its
DeviceProfile back to a loopback server), then runs the baker with that profile.

Options:
  -o, --out <dir>            output directory (default: next to the input)
  --probe-timeout <s>        wait this long for the probe report (default 120)
  --allow-cached             if the browser probe fails or times out, use the cached profile
  --fallback-headless        if the browser probe fails or times out, use the baker's
                             headless probe (--device auto; usually a software GPU)
  --use-cached               skip probing and use the cached profile
  --no-cache                 do not save the received profile
  --cache-dir <dir>          profile cache dir (default ${defaultCacheDir()})
  --open                     open the viewer on the baked file and serve it until Ctrl-C
  --serve-for <s>            with --open: stop serving after s seconds
  --browser-cmd "<cmd>"      command that opens a URL ({url} placeholder or appended);
                             default: open / start / xdg-open   (env WGM_BROWSER)
  --baker-cmd "<cmd>"        baker command (default: tsx tools/bake/cli.ts; env WGM_BAKER)
  --probe-url <url>          probe page to open (default: the local build's /probe.html)
  --app-dir <dir>            built app to serve (default dist/; run npm run build first)
  --port <n>                 loopback port (default: random)
  --json                     NDJSON events on stdout
  -h, --help

Every other option (e.g. --detail low, --max-triangles 200000, --lods 3,
--texture-format etc1s) is passed to the baker unchanged.
Exit codes: 0 ok, 2 usage, 10 probe timeout, 11 probe failed/closed, 12 no browser,
            13 fallback failed, 20 baker failed, 1 internal.
`;

function parse(argv: string[]) {
  const env = process.env;
  const o: Partial<OrchestratorOptions> & { json: boolean } = {
    bakerArgs: [], probeTimeoutMs: 120_000, useCached: false, allowCached: false, fallbackHeadless: false,
    writeCache: true, cacheDir: defaultCacheDir(), open: false, json: false,
    browserCmd: env.WGM_BROWSER ? splitCommand(env.WGM_BROWSER) : null,
    bakerCmd: env.WGM_BAKER ? splitCommand(env.WGM_BAKER)
      : [process.execPath, path.join(ROOT, 'node_modules/tsx/dist/cli.mjs'), path.join(ROOT, 'tools/bake/cli.ts')],
    appDir: path.join(ROOT, 'dist'),
  };
  const val = (f: string, v: string | undefined) => { if (v === undefined) throw new OrchestratorError(`${f} expects a value`, EXIT.usage, 'usage'); return v; };
  const num = (f: string, v: string | undefined) => {
    const n = Number(val(f, v));
    if (!Number.isFinite(n) || n < 0) throw new OrchestratorError(`${f} expects a non-negative number`, EXIT.usage, 'usage');
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h': case '--help': return 'help' as const;
      case '-o': case '--out': o.outDir = val(a, argv[++i]); break;
      case '--probe-timeout': o.probeTimeoutMs = num(a, argv[++i]) * 1000; break;
      case '--allow-cached': o.allowCached = true; break;
      case '--fallback-headless': o.fallbackHeadless = true; break;
      case '--use-cached': o.useCached = true; break;
      case '--no-cache': o.writeCache = false; break;
      case '--cache-dir': o.cacheDir = val(a, argv[++i]); break;
      case '--open': o.open = true; break;
      case '--serve-for': o.serveForMs = num(a, argv[++i]) * 1000; break;
      case '--browser-cmd': o.browserCmd = splitCommand(val(a, argv[++i])); break;
      case '--baker-cmd': o.bakerCmd = splitCommand(val(a, argv[++i])); break;
      case '--probe-url': o.probeUrl = val(a, argv[++i]); break;
      case '--app-dir': o.appDir = path.resolve(val(a, argv[++i])); break;
      case '--port': o.port = num(a, argv[++i]); break;
      case '--json': o.json = true; break;
      default:
        if (!o.input && !a.startsWith('-') && /\.(glb|gltf)$/i.test(a)) o.input = a;
        else o.bakerArgs!.push(a);
    }
  }
  if (!o.input) throw new OrchestratorError('missing input model (.glb or .gltf)', EXIT.usage, 'usage');
  if (!existsSync(o.input)) throw new OrchestratorError(`input not found: ${o.input}`, EXIT.usage, 'usage');
  o.input = path.resolve(o.input);
  o.outDir = path.resolve(o.outDir ?? path.dirname(o.input));
  if (!o.probeUrl && !o.useCached && !existsSync(path.join(o.appDir!, 'probe.html'))) {
    throw new OrchestratorError(`${path.join(o.appDir!, 'probe.html')} not found: run npm run build first`, EXIT.usage, 'usage');
  }
  return o as OrchestratorOptions & { json: boolean };
}

const t0 = Date.now();
let json = process.argv.includes('--json');
function emit(event: string, data: Record<string, unknown>): void {
  if (json) { process.stdout.write(JSON.stringify({ event, t: Date.now() - t0, ...data }) + '\n'); return; }
  const say = (m: string) => console.log(`[local] ${m}`);
  switch (event) {
    case 'state': say(`state: ${data.from} -> ${data.to}${data.source ? ` (profile source: ${data.source})` : ''}`); break;
    case 'probe': say(data.url ? `opening probe in browser (${data.browser}): ${data.url}` : `probing via ${data.browser}`); if (data.url) say(`waiting up to ${Math.round(Number(data.timeoutMs) / 1000)} s for the probe to report...`); break;
    case 'report-rejected': say(`rejected a report (${data.status}): ${data.reason}`); break;
    case 'probe-failed': say(`probe failed: ${data.message}`); break;
    case 'fallback-unavailable': say(`fallback ${data.fallback} unavailable: ${data.message}`); break;
    case 'profile': say(`PROFILE SOURCE: ${String(data.source).toUpperCase()}  (${data.summary}; probed ${data.probedAt})`); break;
    case 'cache-written': say(`profile cached at ${data.file}`); break;
    case 'baker-spawned': say(`baker started (pid ${data.pid})`); break;
    case 'baker': {
      const e = data.data as Record<string, unknown>;
      if (e.event === 'log') console.log(`[bake] ${e.level === 'warn' ? 'warning: ' : ''}${e.message}`);
      else if (e.event === 'device') {
        for (const d of (e.decisions as string[]) ?? []) console.log(`[bake] device: ${d}`);
        const ov = (e.overriddenByFlags as string[]) ?? [];
        if (ov.length) console.log(`[bake] device: overridden by your flags: ${ov.join(', ')}`);
      }
      else if (e.event === 'result') console.log(`[bake] wrote ${e.output} (${e.inputBytes} B -> ${e.outputBytes} B, ${e.ms} ms)`);
      else if (e.event === 'error') console.log(`[bake] error (${e.code}): ${e.message}`);
      break;
    }
    case 'viewer': say(data.opened ? `viewer opened: ${data.url} (Ctrl-C to stop serving)` : `${data.message}: ${data.url}`); break;
    case 'warning': say(`warning: ${data.message}`); break;
    case 'done': say(`done: ${data.output} (profile source: ${data.source})`); break;
    case 'error': console.error(`[local] error: ${data.message}`); break;
    default: say(`${event} ${JSON.stringify(data)}`);
  }
}

async function main(): Promise<number> {
  let opts;
  try { opts = parse(process.argv.slice(2)); } catch (e) {
    const err = e as OrchestratorError;
    emit('error', { code: err.code ?? 'usage', exitCode: EXIT.usage, message: err.message });
    if (!json) process.stderr.write(`\n${HELP}`);
    return EXIT.usage;
  }
  if (opts === 'help') { process.stdout.write(HELP); return EXIT.ok; }
  json = opts.json;
  const orch = new Orchestrator({ ...opts, emit });
  try {
    const r = await orch.run();
    emit('done', { output: r.output, source: r.source });
    return EXIT.ok;
  } catch (e) {
    const err = e as OrchestratorError;
    emit('error', { code: err.code, exitCode: err.exitCode, message: err.message, bakerSpawned: orch.bakerSpawned });
    return err.exitCode ?? EXIT.internal;
  }
}

main().then((code) => { process.exitCode = code; });
