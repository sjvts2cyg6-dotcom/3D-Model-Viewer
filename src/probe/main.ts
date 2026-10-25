/**
 * Probe page. Standalone: measures the device, shows the DeviceProfile and
 * offers it as a download. With `?report=<url>&token=<t>` it also POSTs the
 * result to a local tool (loopback hosts only); see PROTOCOL.md.
 *   ?bench=0   skip the GPU fill-rate benchmark
 */
import { measureDevice } from './measure';
import type { DeviceProfile } from './profile';

type ReportMessage =
  | { type: 'profile'; token: string; profile: DeviceProfile }
  | { type: 'error'; token: string; message: string }
  | { type: 'closed'; token: string };

interface ProbeState {
  state: 'measuring' | 'done' | 'error';
  profile?: DeviceProfile;
  error?: string;
  report: 'none' | 'sending' | 'sent' | 'failed';
  reportError?: string;
}
declare global { interface Window { __probe: ProbeState } }

const params = new URLSearchParams(location.search);
const status = document.getElementById('status')!;
const out = document.getElementById('profile')!;
const summary = document.getElementById('summary')!;
const download = document.getElementById('download') as HTMLAnchorElement;
window.__probe = { state: 'measuring', report: 'none' };

function reportTarget(): { url: string; token: string } | null {
  const raw = params.get('report');
  const token = params.get('token');
  if (!raw || !token) return null;
  let u: URL;
  try { u = new URL(raw); } catch { throw new Error(`invalid report URL ${raw}`); }
  // Only ever report to a tool on this machine.
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || !/^https?:$/.test(u.protocol)) {
    throw new Error(`refusing to report to non-loopback host ${u.host}`);
  }
  return { url: u.href, token };
}

async function send(target: { url: string }, msg: ReportMessage): Promise<void> {
  const res = await fetch(target.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(msg) });
  if (!res.ok) throw new Error(`report endpoint answered ${res.status} ${await res.text().catch(() => '')}`);
}

function render(p: DeviceProfile): void {
  const rows: [string, string][] = [
    ['class', p.deviceClass],
    ['GPU', p.gpu.available ? `${p.gpu.vendor} ${p.gpu.architecture} ${p.gpu.description}`.trim() || '(adapter info hidden)' : 'WebGPU unavailable'],
    ['compression', Object.entries(p.gpu.textureCompression).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none'],
    ['max texture', String(p.gpu.limits.maxTextureDimension2D ?? '-')],
    ['screen', `${p.display.screenWidth}x${p.display.screenHeight} CSS px @ ${p.display.devicePixelRatio}x`],
    ['fill rate', p.benchmark.fillRateMPixPerSec === null ? '-' : `${p.benchmark.fillRateMPixPerSec} MPix/s`],
    ['headless', String(p.probe.headless)],
  ];
  summary.innerHTML = rows.map(([k, v]) => `<tr><th>${k}</th><td>${v.replace(/</g, '&lt;')}</td></tr>`).join('');
  const json = JSON.stringify(p, null, 2);
  out.textContent = json;
  download.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  download.style.display = '';
}

async function run(): Promise<void> {
  let target: { url: string; token: string } | null = null;
  try { target = reportTarget(); } catch (e) { window.__probe.reportError = (e as Error).message; }
  // If the page is closed before a result was sent, tell the waiting tool.
  let finished = false;
  if (target) {
    const t = target;
    addEventListener('pagehide', () => {
      if (finished) return;
      navigator.sendBeacon(t.url, new Blob([JSON.stringify({ type: 'closed', token: t.token } satisfies ReportMessage)], { type: 'text/plain;charset=UTF-8' }));
    });
  }
  try {
    status.textContent = 'Measuring this device...';
    const profile = await measureDevice({ benchmark: params.get('bench') !== '0' });
    window.__probe.profile = profile;
    window.__probe.state = 'done';
    render(profile);
    status.textContent = 'Done. Save the profile and pass it to the baker with --device profile.json.';
    if (target) {
      window.__probe.report = 'sending';
      status.textContent = 'Sending profile to the local tool...';
      await send(target, { type: 'profile', token: target.token, profile });
      finished = true;
      window.__probe.report = 'sent';
      status.textContent = 'Profile sent to the local tool. You can close this tab.';
    } else if (window.__probe.reportError) {
      status.textContent = `Not reported: ${window.__probe.reportError}`;
    }
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    if (window.__probe.state === 'done') {
      window.__probe.report = 'failed';
      window.__probe.reportError = message;
      status.textContent = `Could not send the profile: ${message}. Use the download link instead.`;
    } else {
      window.__probe.state = 'error';
      window.__probe.error = message;
      status.textContent = `Probe failed: ${message}`;
      if (target) {
        await send(target, { type: 'error', token: target.token, message }).catch(() => {});
        finished = true;
      }
    }
  }
}

void run();
