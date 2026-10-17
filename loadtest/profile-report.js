// Summarises a cache-profile.sh run: cache hit rates (whole run and warm), request
// rate, and where the profiled pod's CPU went (self time by area and by function,
// plus inclusive time of the app's own functions).
//   node loadtest/profile-report.js loadtest/results/profile-<label>-<time>
const fs = require('fs');
const path = require('path');

const dir = process.argv[2];
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const out = [];
const pct = (x) => `${(100 * x).toFixed(1)}%`;

// --- cache -------------------------------------------------------------------
const snaps = {};
for (const line of read('cache.txt').trim().split('\n').filter(Boolean)) {
  const [at, cache, result, v] = line.split(' ');
  ((snaps[at] ??= {})[cache] ??= {})[result] = Number(v);
}
const delta = (a, b) => {
  const d = {};
  for (const [cache, rs] of Object.entries(snaps[b] || {})) {
    for (const [r, v] of Object.entries(rs)) ((d[cache] ??= {})[r] = v - (snaps[a]?.[cache]?.[r] ?? 0));
  }
  return d;
};
const rateRows = (d) => Object.entries(d).map(([cache, r]) => {
  const hit = r.hit ?? 0; const miss = r.miss ?? 0; const err = r.error ?? 0; const n = hit + miss + err;
  return `| ${cache} | ${n} | ${hit} | ${miss} | ${err} | ${n ? pct(hit / n) : '–'} |`;
});

out.push(`# Cache + CPU profile: ${path.basename(dir)}`);
out.push('');
out.push(`API resources: ${read('resources.json')}. Profiled pod: ${read('profiled-pod.txt').trim()}.`);
const summary = JSON.parse(read('summary.json'));
const reqs = summary.metrics['http_reqs{name:today}'] ?? summary.metrics.http_reqs;
const dur = summary.metrics['http_req_duration{name:today}'] ?? summary.metrics.http_req_duration;
if (dur) out.push(`k6: p50 ${dur.med?.toFixed(0)} ms, p95 ${dur['p(95)']?.toFixed(0)} ms.`);
out.push('');
out.push('## Cache hit rate');
out.push('');
out.push('`area` is only looked up on a `deck` miss (it feeds ranking), so its rate is among deck misses.');
for (const [title, a, b] of [['Whole run', 'start', 'end'], ['Warm (after the warmup)', 'warm', 'end']]) {
  out.push('');
  out.push(`**${title}**`);
  out.push('');
  out.push('| Cache | Lookups | Hit | Miss | Error | Hit rate |');
  out.push('|---|---|---|---|---|---|');
  out.push(...rateRows(delta(a, b)));
}

// --- CPU profile -------------------------------------------------------------
const prof = JSON.parse(read('api.cpuprofile'));
const byId = new Map(prof.nodes.map((n) => [n.id, n]));
const totalUs = prof.endTime - prof.startTime;
const samples = prof.samples.length;
const usPerSample = totalUs / samples;
const self = new Map(); // node id -> µs
for (const n of prof.nodes) self.set(n.id, (n.hitCount || 0) * usPerSample);

const area = (cf) => {
  const u = cf.url || '';
  if (!u) return cf.functionName.startsWith('(') ? cf.functionName : '(native / V8 builtins)';
  if (u.startsWith('node:')) return 'node core';
  // pnpm: node_modules/.pnpm/<pkg>@<ver>/node_modules/<pkg>/..., so take the last one.
  const m = [...u.matchAll(/node_modules\/((?:@[^/]+\/)?[^/]+)/g)].pop();
  if (m) return m[1];
  if (u.includes('/dist/')) return `app: ${u.slice(u.indexOf('/dist/') + 6)}`;
  return u;
};
// Only (idle) is idle. (program) is native work outside JS (HTTP parsing, syscalls).
const idleNames = new Set(['(idle)']);
let idle = 0; let busy = 0;
const byArea = new Map(); const byFn = new Map();
for (const n of prof.nodes) {
  const t = self.get(n.id);
  if (!t) continue;
  if (idleNames.has(n.callFrame.functionName)) { idle += t; continue; }
  busy += t;
  const a = area(n.callFrame);
  byArea.set(a, (byArea.get(a) || 0) + t);
  const fn = `${n.callFrame.functionName || '(anonymous)'} — ${a}${n.callFrame.url ? `:${n.callFrame.lineNumber + 1}` : ''}`;
  byFn.set(fn, (byFn.get(fn) || 0) + t);
}

// Inclusive time of app functions: self + descendants, counted once per sample path.
const parent = new Map();
for (const n of prof.nodes) for (const c of n.children || []) parent.set(c, n.id);
const incl = new Map();
for (const n of prof.nodes) {
  const t = self.get(n.id);
  if (!t || idleNames.has(n.callFrame.functionName)) continue;
  const seen = new Set();
  for (let id = n.id; id !== undefined; id = parent.get(id)) {
    const cf = byId.get(id).callFrame;
    if (!(cf.url || '').includes('/dist/')) continue;
    const key = `${cf.functionName || '(anonymous)'} — ${area(cf)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    incl.set(key, (incl.get(key) || 0) + t);
  }
}

const top = (m, n) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
out.push('');
out.push('## CPU profile (main thread)');
out.push('');
out.push(`${(totalUs / 1e6).toFixed(0)} s profiled, ${samples} samples. Busy ${pct(busy / (busy + idle))} of the time ` +
  `(≈ ${Math.round((1000 * busy) / (busy + idle))}m of one core; GC and libuv threads not included).`);
out.push('');
out.push('**Self time by area**');
out.push('');
out.push('| Area | Share of busy time |');
out.push('|---|---|');
for (const [a, t] of top(byArea, 15)) out.push(`| ${a} | ${pct(t / busy)} |`);
out.push('');
out.push('**Top functions by self time**');
out.push('');
out.push('| Function | Share of busy time |');
out.push('|---|---|');
for (const [f, t] of top(byFn, 25)) out.push(`| ${f.replace(/\|/g, '\\|')} | ${pct(t / busy)} |`);
out.push('');
out.push('**App functions by inclusive time** (including everything they call)');
out.push('');
out.push('| Function | Share of busy time |');
out.push('|---|---|');
for (const [f, t] of top(incl, 20)) out.push(`| ${f.replace(/\|/g, '\\|')} | ${pct(t / busy)} |`);
if (reqs) out.push('', `Requests (all VUs, whole run): ${reqs.count} at ${reqs.rate.toFixed(1)} req/s.`);
console.log(out.join('\n'));
