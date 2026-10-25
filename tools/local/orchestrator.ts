/**
 * Local orchestrator: a thin, strictly sequential coordinator between the probe
 * page (running in the user's real browser) and the baker CLI (a separate
 * process). It never measures or bakes anything itself.
 *
 *   idle -> probing -> profile-received -> baking -> done
 *             \-------------\------------------\---> error
 *
 * The baker is only ever spawned in state `profile-received`, i.e. after a
 * complete, schema-valid DeviceProfile is in hand.
 */
import type { ChildProcess } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultBrowserCommand, openUrl, runBaker } from './processes';
import { summarize, validateProfile, type BakerEvent, type DeviceProfileJson } from './protocol';
import { startLocalServer, type LocalServer, type ReportOutcome } from './server';

export type State = 'idle' | 'probing' | 'profile-received' | 'baking' | 'done' | 'error';

const TRANSITIONS: Record<State, readonly State[]> = {
  'idle': ['probing', 'error'],
  'probing': ['profile-received', 'error'],
  'profile-received': ['baking', 'error'],
  'baking': ['done', 'error'],
  'done': [],
  'error': [],
};

export type ProfileSource = 'browser' | 'cache' | 'headless';

export const EXIT = {
  ok: 0, usage: 2, probeTimeout: 10, probeFailed: 11, noBrowser: 12, fallbackFailed: 13, bakerFailed: 20, internal: 1,
} as const;

export class OrchestratorError extends Error {
  constructor(message: string, readonly exitCode: number, readonly code: string) { super(message); }
}

export interface OrchestratorOptions {
  input: string;
  outDir: string;
  /** Extra arguments passed verbatim to the baker (reduction knobs etc.). */
  bakerArgs: string[];
  /** Baker command (argv prefix); the orchestrator appends its own arguments. */
  bakerCmd: string[];
  /** Built app directory served on loopback (contains probe.html and the viewer). */
  appDir: string;
  /** Command used to open URLs; null = platform default (none on a headless box). */
  browserCmd: string[] | null;
  /** Probe page URL; default `<server>/probe.html`. */
  probeUrl?: string;
  probeTimeoutMs: number;
  /** Use the cached profile instead of probing (explicit). */
  useCached: boolean;
  /** If the browser probe fails/times out, fall back to the cached profile. */
  allowCached: boolean;
  /** If the browser probe fails/times out, fall back to the baker's headless `--device auto` probe. */
  fallbackHeadless: boolean;
  writeCache: boolean;
  cacheDir: string;
  open: boolean;
  /** With open: stop serving after N ms (undefined = until SIGINT). */
  serveForMs?: number;
  port?: number;
  /** Event sink (state changes, relayed baker events, ...). */
  emit: (event: string, data: Record<string, unknown>) => void;
}

export interface OrchestratorResult {
  source: ProfileSource;
  output: string;
  bakerResult: BakerEvent;
}

export function defaultCacheDir(): string {
  if (process.env.WGM_CONFIG_DIR) return process.env.WGM_CONFIG_DIR;
  const base = process.env.XDG_CONFIG_HOME || (process.platform === 'win32' ? process.env.APPDATA : undefined) || path.join(os.homedir(), '.config');
  return path.join(base!, 'webgpu-engine');
}

export class Orchestrator {
  private state: State = 'idle';
  private server: LocalServer | null = null;
  private browsers: ChildProcess[] = [];
  private profile: DeviceProfileJson | null = null;
  private source: ProfileSource | null = null;
  bakerSpawned = false;

  constructor(private readonly o: OrchestratorOptions) {}

  get current(): State { return this.state; }

  private go(to: State, detail: Record<string, unknown> = {}): void {
    if (!TRANSITIONS[this.state].includes(to)) throw new Error(`illegal state transition ${this.state} -> ${to}`);
    const from = this.state;
    this.state = to;
    this.o.emit('state', { from, to, ...detail });
  }

  private get cacheFile(): string { return path.join(this.o.cacheDir, 'device-profile.json'); }

  async run(): Promise<OrchestratorResult> {
    try {
      this.server = await startLocalServer({
        appDir: this.o.appDir, port: this.o.port,
        onRejected: (r) => this.o.emit('report-rejected', { status: r.status, reason: r.reason }),
      });
      this.go('probing');
      await this.acquireProfile();
      this.go('profile-received', { source: this.source });
      const result = await this.bake();
      this.go('done', { output: result.output });
      if (this.o.open) await this.openViewer(result.output);
      return result;
    } catch (e) {
      const err = e instanceof OrchestratorError ? e : new OrchestratorError((e as Error).message ?? String(e), EXIT.internal, 'internal');
      if (this.state !== 'error' && this.state !== 'done') this.go('error', { code: err.code, message: err.message });
      throw err;
    } finally {
      await this.shutdown();
    }
  }

  // ----------------------------------------------------------- step 1: probe

  private async acquireProfile(): Promise<void> {
    if (this.o.useCached) {
      const cached = await this.readCache();
      if (!cached) throw new OrchestratorError(`--use-cached: no valid cached profile at ${this.cacheFile}`, EXIT.fallbackFailed, 'no-cache');
      return this.accept(cached, 'cache');
    }
    let failure: OrchestratorError;
    try {
      const p = await this.probeInBrowser();
      return this.accept(p, 'browser');
    } catch (e) {
      if (!(e instanceof OrchestratorError)) throw e;
      failure = e;
    }
    // The browser probe did not deliver. Only fall back if explicitly allowed.
    this.o.emit('probe-failed', { code: failure.code, message: failure.message });
    if (this.o.allowCached) {
      const cached = await this.readCache();
      if (cached) return this.accept(cached, 'cache');
      this.o.emit('fallback-unavailable', { fallback: 'cache', message: `no valid cached profile at ${this.cacheFile}` });
    }
    if (this.o.fallbackHeadless) return this.accept(await this.probeHeadlessViaBaker(), 'headless');
    if (!this.o.allowCached && !this.o.fallbackHeadless) {
      failure.message += ' (not baking; pass --allow-cached or --fallback-headless to allow a fallback profile)';
      throw failure;
    }
    throw new OrchestratorError(`${failure.message}; no fallback profile available, not baking`, EXIT.fallbackFailed, 'fallback-failed');
  }

  private accept(profile: DeviceProfileJson, source: ProfileSource): void {
    const errs = validateProfile(profile);
    if (errs.length) throw new OrchestratorError(`${source} profile invalid: ${errs.join('; ')}`, EXIT.probeFailed, 'invalid-profile');
    this.profile = profile;
    this.source = source;
    this.o.emit('profile', { source, summary: summarize(profile), probedAt: profile.probedAt });
    if ((profile.probe as { headless?: unknown } | undefined)?.headless === true) {
      this.o.emit('warning', { message: 'this profile was measured by a headless/automated browser; it may not reflect the real GPU or display' });
    }
  }

  private async probeInBrowser(): Promise<DeviceProfileJson> {
    const server = this.server!;
    const cmd = this.o.browserCmd ?? defaultBrowserCommand();
    if (!cmd) {
      throw new OrchestratorError('no real browser can be opened here (no display / opener found)', EXIT.noBrowser, 'no-browser');
    }
    const page = new URL(this.o.probeUrl ?? `${server.origin}/probe.html`);
    page.searchParams.set('report', server.reportUrl);
    page.searchParams.set('token', server.token);
    this.o.emit('probe', { url: page.href.replace(server.token, '<token>'), browser: cmd[0], timeoutMs: this.o.probeTimeoutMs });

    const launched = openUrl(cmd, page.href);
    this.browsers.push(launched.child);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new OrchestratorError(
        `the probe page did not report within ${Math.round(this.o.probeTimeoutMs / 1000)} s`, EXIT.probeTimeout, 'probe-timeout')), this.o.probeTimeoutMs);
    });
    const launcherFailed = launched.exited.then((r) => {
      if (r.error || (r.code !== 0 && r.code !== null)) {
        throw new OrchestratorError(`browser launcher "${cmd[0]}" failed: ${r.error ?? `exit code ${r.code}`}`, EXIT.probeFailed, 'browser-failed');
      }
      return new Promise<never>(() => {}); // launcher exited normally: keep waiting for the report
    });
    try {
      const outcome: ReportOutcome = await Promise.race([server.nextReport(), timeout, launcherFailed]);
      if (outcome.kind === 'profile') return outcome.profile;
      if (outcome.kind === 'closed') throw new OrchestratorError('the probe page was closed before it reported', EXIT.probeFailed, 'probe-closed');
      throw new OrchestratorError(`the probe reported an error: ${outcome.message}`, EXIT.probeFailed, 'probe-error');
    } finally {
      clearTimeout(timer);
      server.closeReports();
    }
  }

  /** Fallback: ask the baker to run its own headless probe and print the profile, without baking. */
  private async probeHeadlessViaBaker(): Promise<DeviceProfileJson> {
    this.o.emit('probe', { url: null, browser: 'headless (baker --device auto --print-device)' });
    const run = runBaker(this.o.bakerCmd, ['--device', 'auto', '--print-device', '--json'], null, (e) => this.o.emit('baker', { phase: 'probe', data: e }));
    const r = await run.done;
    const ev = r.events.find((e) => e.event === 'profile');
    if (r.exitCode !== 0 || !ev) {
      const err = r.events.find((e) => e.event === 'error');
      throw new OrchestratorError(`headless probe failed: ${(err?.message as string) ?? (r.stderr.trim() || `exit code ${r.exitCode}`)}`, EXIT.fallbackFailed, 'fallback-failed');
    }
    return ev.profile as DeviceProfileJson;
  }

  private async readCache(): Promise<DeviceProfileJson | null> {
    try {
      const c = JSON.parse(await readFile(this.cacheFile, 'utf8')) as { profile?: unknown };
      return validateProfile(c.profile).length ? null : (c.profile as DeviceProfileJson);
    } catch { return null; }
  }

  private async writeCache(): Promise<void> {
    await mkdir(this.o.cacheDir, { recursive: true });
    const tmp = `${this.cacheFile}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ savedAt: new Date().toISOString(), source: this.source, profile: this.profile }, null, 2));
    await rename(tmp, this.cacheFile);
    this.o.emit('cache-written', { file: this.cacheFile });
  }

  // ------------------------------------------------------------ step 2: bake

  private async bake(): Promise<OrchestratorResult> {
    if (this.state !== 'profile-received' || !this.profile || !this.source) {
      throw new Error(`refusing to start the baker in state ${this.state}`); // invariant guard
    }
    if (this.source === 'browser' && this.o.writeCache) await this.writeCache().catch((e: Error) => this.o.emit('warning', { message: `cache not written: ${e.message}` }));
    const args = [this.o.input, '-o', this.o.outDir, '--device', '-', '--json', ...this.o.bakerArgs];
    this.go('baking');
    const run = runBaker(this.o.bakerCmd, args, JSON.stringify(this.profile), (e) => this.o.emit('baker', { phase: 'bake', data: e }));
    this.bakerSpawned = true;
    this.o.emit('baker-spawned', { pid: run.child.pid ?? null, args });
    const r = await run.done;
    const result = r.events.find((e) => e.event === 'result');
    if (r.exitCode !== 0 || !result) {
      const err = r.events.find((e) => e.event === 'error');
      const why = (err?.message as string) ?? (r.stderr.trim().split('\n').pop() || 'no result event');
      throw new OrchestratorError(`baker failed (exit code ${r.exitCode}): ${why}`, EXIT.bakerFailed, 'baker-failed');
    }
    return { source: this.source, output: String(result.output), bakerResult: result };
  }

  // ------------------------------------------------- optional step 3: viewer

  private async openViewer(output: string): Promise<void> {
    const server = this.server!;
    server.setOutDir(path.dirname(output));
    const url = `${server.origin}/?model=/out/${encodeURIComponent(path.basename(output))}`;
    const cmd = this.o.browserCmd ?? defaultBrowserCommand();
    if (!cmd) { this.o.emit('viewer', { url, opened: false, message: 'no browser to open; viewer URL is served until Ctrl-C' }); }
    else { this.browsers.push(openUrl(cmd, url).child); this.o.emit('viewer', { url, opened: true }); }
    await new Promise<void>((resolve) => {
      const stop = () => { process.off('SIGINT', stop); resolve(); };
      process.on('SIGINT', stop);
      if (this.o.serveForMs !== undefined) setTimeout(stop, this.o.serveForMs);
    });
  }

  private async shutdown(): Promise<void> {
    for (const b of this.browsers) {
      // Stand-in/automated browsers may still run; real launchers have already exited.
      if (b.exitCode === null && b.signalCode === null) { try { b.kill(); } catch { /* gone */ } }
    }
    await this.server?.close();
    this.server = null;
  }
}
