import type { ReliabilityStats } from '../../core/interfaces/stores.js';
import type { FailoverSession } from '../../companion/failover-sessions.js';
import { formatAge, formatBytes, formatRate } from '../../utils/format.js';

export interface StatusContext {
  providers: Array<{ id: string; name: string; api?: ReliabilityStats; streams?: ReliabilityStats }>;
  hosts: Array<{ key: string; stats: ReliabilityStats }>;
  sessions: FailoverSession[];
  now: number;
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

function pct(stats: ReliabilityStats | undefined): string {
  if (!stats) return '<span class="muted">no data yet</span>';
  const value = Math.round(stats.reliability * 100);
  const cls = value >= 70 ? 'ok' : value >= 40 ? 'warn' : 'bad';
  return `<span class="${cls}">${value}%</span> <span class="muted">(${stats.observations} checks, ${formatAge(Date.now() - stats.updatedAt)})</span>`;
}

export function renderStatusPage(ctx: StatusContext): string {
  const providerRows = ctx.providers
    .map((p) => `<tr><td>${esc(p.name)}</td><td>${pct(p.api)}</td><td>${pct(p.streams)}</td></tr>`)
    .join('');
  const hostRows = ctx.hosts
    .map(({ key, stats }) => {
      const speed = stats.throughputBps ? formatRate(stats.throughputBps) : '–';
      return `<tr><td>${esc(key.replace(/^host:/, ''))}</td><td>${pct(stats)}</td><td>${speed}</td></tr>`;
    })
    .join('');
  const sessionRows = ctx.sessions
    .flatMap((s) =>
      [...s.playbacks.values()].map((p) => {
        const target = p.pinnedIndex !== undefined ? s.chain[p.pinnedIndex] : undefined;
        const next = s.entryPoints.find((e) => e > (p.pinnedIndex ?? p.startIndex));
        const nextLabel = next !== undefined ? s.chain[next]?.label : undefined;
        return `<tr><td>${esc(s.mediaKey)}</td><td>${esc(target?.label ?? 'not started')}</td><td>${formatBytes(p.bytesServed)}</td>
          <td>${p.problem ? `<span class="warn">${esc(p.problem)}</span>` : '<span class="ok">ok</span>'}</td>
          <td>${nextLabel ? esc(nextLabel) : '–'}</td></tr>`;
      }),
    )
    .join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Smart AutoPilot · status</title>
<style>
 body{margin:0;font:14px/1.5 system-ui,sans-serif;background:#0f1115;color:#e8eaed} main{max-width:900px;margin:0 auto;padding:28px 18px}
 table{width:100%;border-collapse:collapse;margin:8px 0 24px} td,th{text-align:left;padding:6px 8px;border-bottom:1px solid #262a33;vertical-align:top}
 .ok{color:#3ecf8e}.warn{color:#f5a524}.bad{color:#ff5c5c}.muted{color:#9aa0a6;font-size:12px}
</style></head><body><main>
<h1>Source status</h1>
<p class="muted">Reliability is a time-weighted success rate that fades back to neutral within hours, so a temporary outage is forgiven quickly.</p>
<h2>Providers</h2>
<table><tr><th>Provider</th><th>API answered</th><th>Streams worked</th></tr>${providerRows || '<tr><td colspan="3" class="muted">No providers enabled.</td></tr>'}</table>
<h2>Hosts</h2>
<table><tr><th>Host</th><th>Reliability</th><th>Measured speed</th></tr>${hostRows || '<tr><td colspan="3" class="muted">No hosts tested yet.</td></tr>'}</table>
<h2>Recent playback (companion)</h2>
<table><tr><th>Title</th><th>Playing from</th><th>Served</th><th>State</th><th>Next alternative</th></tr>${sessionRows || '<tr><td colspan="5" class="muted">Companion is off or nothing has played yet.</td></tr>'}</table>
</main></body></html>`;
}
