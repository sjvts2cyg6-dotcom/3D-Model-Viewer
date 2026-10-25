/** Starting the other programs: the user's browser and the baker CLI. */
import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { parseNdjsonLine, type BakerEvent } from './protocol';

/** Split a command line on whitespace (no shell, no quoting). */
export function splitCommand(cmd: string): string[] {
  return cmd.trim().split(/\s+/).filter(Boolean);
}

function onPath(bin: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    try { accessSync(path.join(dir, bin), constants.X_OK); return true; } catch { /* next */ }
  }
  return false;
}

/** The default way to open a URL in the machine's real default browser, or null if there is none. */
export function defaultBrowserCommand(): string[] | null {
  if (process.platform === 'darwin') return ['open'];
  if (process.platform === 'win32') return ['cmd', '/c', 'start', '""'];
  const hasDisplay = !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  if (!hasDisplay) return null;
  for (const bin of ['xdg-open', 'gio', 'sensible-browser']) if (onPath(bin)) return bin === 'gio' ? ['gio', 'open'] : [bin];
  return null;
}

export interface LaunchedBrowser {
  child: ChildProcess;
  /** Resolves when the launcher process exits (most launchers exit immediately). */
  exited: Promise<{ code: number | null; error?: string }>;
}

/** Open `url` with `cmd` (`{url}` placeholder, else appended). */
export function openUrl(cmd: string[], url: string): LaunchedBrowser {
  const argv = cmd.some((a) => a.includes('{url}')) ? cmd.map((a) => a.replaceAll('{url}', url)) : [...cmd, url];
  const child = spawn(argv[0], argv.slice(1), { stdio: 'ignore', detached: process.platform !== 'win32' });
  const exited = new Promise<{ code: number | null; error?: string }>((resolve) => {
    child.once('error', (e) => resolve({ code: null, error: e.message }));
    child.once('exit', (code) => resolve({ code }));
  });
  return { child, exited };
}

export interface BakerRun {
  child: ChildProcess;
  done: Promise<{ exitCode: number | null; events: BakerEvent[]; stderr: string }>;
}

/**
 * Run the baker CLI as a separate process in `--json` mode. `stdin` (if given)
 * is written to the process and closed. Every stdout event is passed to onEvent.
 */
export function runBaker(cmd: string[], args: string[], stdin: string | null, onEvent: (e: BakerEvent) => void): BakerRun {
  const child = spawn(cmd[0], [...cmd.slice(1), ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  const events: BakerEvent[] = [];
  let stderr = '';
  child.stderr!.on('data', (c: Buffer) => { stderr += c.toString(); });
  const rl = createInterface({ input: child.stdout! });
  rl.on('line', (line) => {
    const e = parseNdjsonLine(line);
    if (e) { events.push(e); onEvent(e); }
  });
  child.stdin!.on('error', () => { /* baker may exit before reading stdin */ });
  if (stdin !== null) child.stdin!.end(stdin); else child.stdin!.end();
  const done = new Promise<{ exitCode: number | null; events: BakerEvent[]; stderr: string }>((resolve) => {
    let closed = false;
    child.once('error', (e) => { if (!closed) { closed = true; resolve({ exitCode: null, events, stderr: stderr + e.message }); } });
    child.once('close', (code) => { if (!closed) { closed = true; rl.close(); resolve({ exitCode: code, events, stderr }); } });
  });
  return { child, done };
}
