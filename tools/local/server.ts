/**
 * Loopback-only HTTP server for one orchestrator run:
 *   GET  /...            static files of the built app (probe page, viewer)
 *   GET  /out/...        the bake output directory (for --open)
 *   POST /report         the probe's one-time report (token-protected)
 * It contains no probe logic: it only receives and checks the report message.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { validateProfile, type DeviceProfileJson, type ProbeReport } from './protocol';

const MAX_BODY = 512 * 1024;
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

export type ReportOutcome =
  | { kind: 'profile'; profile: DeviceProfileJson }
  | { kind: 'error'; message: string }
  | { kind: 'closed' };

export interface RejectedReport { status: number; reason: string }

export interface LocalServer {
  readonly origin: string;
  readonly reportUrl: string;
  readonly token: string;
  /** Resolves with the first valid report; invalid/wrong-token posts are rejected and reported via onRejected. */
  nextReport(): Promise<ReportOutcome>;
  /** Stop accepting reports (token becomes invalid). */
  closeReports(): void;
  setOutDir(dir: string): void;
  close(): Promise<void>;
}

function safeJoin(root: string, urlPath: string): string | null {
  let rel: string;
  try { rel = decodeURIComponent(urlPath); } catch { return null; }
  const file = path.resolve(root, '.' + (rel.endsWith('/') ? rel + 'index.html' : rel));
  return file === root || file.startsWith(root + path.sep) ? file : null;
}

function sendFile(res: ServerResponse, file: string | null): void {
  if (!file || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
  createReadStream(file).pipe(res);
}

export async function startLocalServer(opts: {
  appDir: string; port?: number; onRejected?: (r: RejectedReport) => void;
}): Promise<LocalServer> {
  const token = randomBytes(24).toString('hex');
  const tokenBuf = Buffer.from(token);
  let accepting = true;
  let outDir: string | null = null;
  let deliver: ((r: ReportOutcome) => void) | null = null;
  const pending: ReportOutcome[] = [];
  const appDir = path.resolve(opts.appDir);

  const reject = (res: ServerResponse, status: number, reason: string) => {
    opts.onRejected?.({ status, reason });
    res.writeHead(status, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' }).end(reason);
  };

  const handleReport = (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    let size = 0, aborted = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY && !aborted) { aborted = true; reject(res, 413, 'report too large'); req.destroy(); return; }
      if (!aborted) chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      let msg: Partial<ProbeReport> & { token?: unknown };
      try { msg = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { reject(res, 400, 'body is not JSON'); return; }
      const t = typeof msg?.token === 'string' ? Buffer.from(msg.token) : Buffer.alloc(0);
      if (t.length !== tokenBuf.length || !timingSafeEqual(t, tokenBuf)) { reject(res, 403, 'wrong or missing token'); return; }
      if (!accepting) { reject(res, 409, 'not waiting for a report (token already used)'); return; }
      let outcome: ReportOutcome;
      if (msg.type === 'profile') {
        const errs = validateProfile((msg as { profile?: unknown }).profile);
        if (errs.length) { reject(res, 400, `invalid DeviceProfile: ${errs.join('; ')}`); return; }
        outcome = { kind: 'profile', profile: (msg as { profile: DeviceProfileJson }).profile };
      } else if (msg.type === 'error') {
        outcome = { kind: 'error', message: String((msg as { message?: unknown }).message ?? 'unknown probe error') };
      } else if (msg.type === 'closed') {
        outcome = { kind: 'closed' };
      } else { reject(res, 400, 'unknown report type'); return; }
      accepting = false; // one-time token
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }).end('{"ok":true}');
      if (deliver) { const d = deliver; deliver = null; d(outcome); } else pending.push(outcome);
    });
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/report') {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600',
        }).end();
        return;
      }
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      handleReport(req, res);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    if (url.pathname.startsWith('/out/')) {
      sendFile(res, outDir ? safeJoin(outDir, url.pathname.slice(4)) : null);
      return;
    }
    sendFile(res, safeJoin(appDir, url.pathname));
  });
  await new Promise<void>((resolve, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    reportUrl: `${origin}/report`,
    token,
    nextReport: () => new Promise((resolve) => {
      const p = pending.shift();
      if (p) resolve(p); else deliver = resolve;
    }),
    closeReports: () => { accepting = false; },
    setOutDir: (dir) => { outDir = path.resolve(dir); },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
