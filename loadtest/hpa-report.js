// Summarises an hpa-run.sh run: per 30 s, the load (VUs, req/s), latency, errors,
// API replicas and CPU. Plus when the HPA first scaled and at what load.
//   node loadtest/hpa-report.js loadtest/results/hpa-<label>-<time>
const fs = require('fs');
const readline = require('readline');
const path = require('path');

const dir = process.argv[2];
const BUCKET = 30;

function splitCsv(line) { // k6 quotes fields that contain commas
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true; else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}
const pct = (xs, p) => { if (!xs.length) return NaN; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };

async function main() {
  const durs = []; const failed = []; const vus = [];
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, 'k6.csv')) });
  let cols = null;
  for await (const line of rl) {
    const f = splitCsv(line);
    if (!cols) { cols = Object.fromEntries(f.map((c, i) => [c, i])); continue; }
    const m = f[cols.metric_name]; const t = Number(f[cols.timestamp]); const v = Number(f[cols.metric_value]);
    if (m === 'vus') vus.push([t, v]);
    else if (f[cols.name] !== 'today') continue;
    else if (m === 'http_req_duration') durs.push([t, v]);
    else if (m === 'http_req_failed') failed.push([t, v]);
  }
  const hpa = fs.readFileSync(path.join(dir, 'hpa.tsv'), 'utf8').trim().split('\n').map((l) => {
    const [t, r, d, u, cpu, pg, redis] = l.split('\t');
    const pods = (cpu || '').split(',').filter(Boolean).map(Number);
    return { t: Number(t), replicas: Number(r), desired: Number(d), util: u === '' ? NaN : Number(u), pods,
      pg: pg === undefined ? NaN : Number(pg), redis: redis === undefined ? NaN : Number(redis) };
  });
  const res = JSON.parse(fs.readFileSync(path.join(dir, 'resources.json'), 'utf8') || '{}');
  const spec = (JSON.parse(fs.readFileSync(path.join(dir, 'hpa.json'), 'utf8')).spec) || null;

  const t0 = Math.min(...durs.map((d) => d[0])); const t1 = Math.max(...durs.map((d) => d[0]));
  const inB = (xs, a, b) => xs.filter(([t]) => t >= a && t < b);
  const rows = [];
  for (let a = t0; a <= t1; a += BUCKET) {
    const b = a + BUCKET;
    const d = inB(durs, a, b).map((x) => x[1]);
    const fl = inB(failed, a, b);
    const h = hpa.filter((x) => x.t >= a && x.t < b);
    const cpuTotals = h.map((x) => x.pods.reduce((s, c) => s + c, 0)).filter((x) => x > 0);
    const cpuPods = h.flatMap((x) => x.pods);
    rows.push({
      at: a - t0, vus: Math.max(0, ...inB(vus, a, b).map((x) => x[1])), rps: d.length / BUCKET,
      p95: pct(d, 0.95), err: fl.length ? fl.filter((x) => x[1] === 1).length / fl.length : 0,
      replicas: h.length ? Math.max(...h.map((x) => x.replicas)) : NaN,
      podCpu: cpuPods.length ? cpuPods.reduce((s, c) => s + c, 0) / cpuPods.length : NaN,
      totalCpu: cpuTotals.length ? cpuTotals.reduce((s, c) => s + c, 0) / cpuTotals.length : NaN,
    });
  }

  const all = durs.map((x) => x[1]);
  const errs = failed.filter((x) => x[1] === 1).length;
  const startReplicas = hpa.find((x) => x.t >= t0)?.replicas;
  const firstUp = hpa.find((x) => x.t >= t0 && x.replicas > startReplicas);
  const vusAt = (t) => { let v = 0; for (const [tt, vv] of vus) if (tt <= t) v = vv; return v; };
  const rpsAt = (t) => inB(durs, t - BUCKET, t).length / BUCKET;
  const f0 = (x) => (Number.isFinite(x) ? x.toFixed(0) : '–');

  const out = [];
  out.push(`# HPA run: ${path.basename(dir)}`);
  out.push('');
  out.push(`API resources: requests ${JSON.stringify(res.requests || {})}, limits ${JSON.stringify(res.limits || {})}.`);
  if (spec) {
    const target = spec.metrics?.[0]?.resource?.target?.averageUtilization;
    const req = parseInt(res.requests?.cpu || '0', 10);
    out.push(`HPA: ${spec.minReplicas}–${spec.maxReplicas} replicas, target ${target}% of the CPU request` +
      (req ? ` (= ${Math.round((req * target) / 100)}m per pod)` : '') +
      `, behavior ${spec.behavior ? JSON.stringify(spec.behavior) : 'Kubernetes defaults'}.`);
  } else out.push('HPA: off (fixed replicas).');
  out.push('');
  out.push(`${all.length} requests, ${(100 * errs / Math.max(1, failed.length)).toFixed(2)}% failed, p50 ${f0(pct(all, 0.5))} ms, p95 ${f0(pct(all, 0.95))} ms, p99 ${f0(pct(all, 0.99))} ms.`);
  out.push(firstUp
    ? `First scale-up (${startReplicas} → ${firstUp.replicas}) ${firstUp.t - t0} s in, at ${vusAt(firstUp.t)} VUs / ~${rpsAt(firstUp.t).toFixed(0)} req/s.`
    : `No scale-up (stayed at ${startReplicas} replicas).`);
  out.push(`Max replicas: ${Math.max(...hpa.map((x) => x.replicas).filter(Number.isFinite))}.`);
  out.push('');
  out.push('| t (s) | VUs | req/s | p95 (ms) | errors | replicas | CPU/pod (m) | API CPU total (m) | CPU per req/s (m) |');
  out.push('|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    out.push(`| ${r.at} | ${r.vus} | ${r.rps.toFixed(1)} | ${f0(r.p95)} | ${(100 * r.err).toFixed(1)}% | ${f0(r.replicas)} | ${f0(r.podCpu)} | ${f0(r.totalCpu)} | ${r.rps > 1 ? (r.totalCpu / r.rps).toFixed(1) : '–'} |`);
  }

  // Load levels: stretches where the VU count holds for 45 s or more (the steps
  // scenario, or a ramp's plateau), minus the first 15 s while things settle.
  const levels = [];
  for (let i = 0; i < vus.length;) {
    let j = i;
    while (j + 1 < vus.length && vus[j + 1][1] === vus[i][1]) j++;
    if (vus[i][1] > 0 && vus[j][0] - vus[i][0] >= 45) levels.push({ vus: vus[i][1], a: vus[i][0] + 15, b: vus[j][0] });
    i = j + 1;
  }
  if (levels.length) {
    const lim = String(res.limits?.cpu || '');
    const limitM = lim.endsWith('m') ? parseInt(lim, 10) : Number(lim) * 1000;
    const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
    const L = levels.map((l) => {
      const d = inB(durs, l.a, l.b).map((x) => x[1]);
      const fl = inB(failed, l.a, l.b);
      const h = hpa.filter((x) => x.t >= l.a && x.t < l.b);
      const replicas = mean(h.map((x) => x.replicas).filter(Number.isFinite));
      const rps = d.length / (l.b - l.a);
      const podCpu = mean(h.flatMap((x) => x.pods));
      return {
        ...l, rps, replicas, perPod: rps / replicas, p50: pct(d, 0.5), p95: pct(d, 0.95), p99: pct(d, 0.99),
        err: fl.length ? fl.filter((x) => x[1] === 1).length / fl.length : 0, podCpu,
        cpuPerRps: (podCpu * replicas) / rps,
        pg: mean(h.map((x) => x.pg).filter(Number.isFinite)), redis: mean(h.map((x) => x.redis).filter(Number.isFinite)),
      };
    });
    // Degraded: p95 more than twice the lightest level's.
    const firstBad = L.findIndex((l) => l.p95 > 2 * L[0].p95);
    out.push('');
    out.push('## Load levels');
    out.push('');
    out.push('| VUs | req/s | replicas | req/s per pod | p50 (ms) | p95 (ms) | p99 (ms) | errors | CPU/pod (m) | CPU per req/s (m) | Postgres CPU (m) | Redis CPU (m) | |');
    out.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    L.forEach((l, i) => {
      const notes = [];
      if (limitM && l.podCpu >= 0.9 * limitM) notes.push('at CPU limit');
      if (i === firstBad) notes.push('p95 degraded');
      out.push(`| ${l.vus} | ${l.rps.toFixed(1)} | ${l.replicas.toFixed(1)} | ${l.perPod.toFixed(1)} | ${f0(l.p50)} | ${f0(l.p95)} | ${f0(l.p99)} | ${(100 * l.err).toFixed(1)}% | ${f0(l.podCpu)} | ${l.cpuPerRps.toFixed(1)} | ${f0(l.pg)} | ${f0(l.redis)} | ${notes.join(', ')} |`);
    });
    out.push('');
    if (firstBad > 0) {
      const ok = L[firstBad - 1]; const bad = L[firstBad];
      out.push(`Saturation: p95 holds up to ~${ok.perPod.toFixed(1)} req/s per pod (p95 ${f0(ok.p95)} ms, ${f0(ok.podCpu)}m/pod) ` +
        `and degrades by ~${bad.perPod.toFixed(1)} req/s per pod (p95 ${f0(bad.p95)} ms, ${f0(bad.podCpu)}m/pod).`);
    } else if (firstBad === -1 && L.length > 1) out.push('Saturation: p95 never more than doubled; the highest level is still below saturation.');
  }
  console.log(out.join('\n'));
}

main().catch((e) => { console.error(e); process.exit(1); });
