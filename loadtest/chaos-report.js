// Turns a chaos.sh run (k6.csv + events.tsv) into a markdown report: for each kill,
// how many /quests/today requests failed, how long users saw errors, and how long
// the replacement took to become Ready.
//   node loadtest/chaos-report.js loadtest/results/chaos-<time>
const fs = require('fs');
const readline = require('readline');
const path = require('path');

const dir = process.argv[2];
const WINDOW = 60; // seconds after a kill that count towards it

// CSV fields can be quoted (k6 error messages contain commas).
function splitCsv(line) {
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

async function main() {
  const events = fs.readFileSync(path.join(dir, 'events.tsv'), 'utf8').trim().split('\n')
    .map((l) => { const [t, ...rest] = l.split('\t'); return { t: Number(t), text: rest.join('\t') }; });

  // Per-second request and failure counts for the "today" requests.
  const reqs = new Map(); const fails = new Map(); const statuses = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(path.join(dir, 'k6.csv')) });
  let cols = null;
  for await (const line of rl) {
    const f = splitCsv(line);
    if (!cols) { cols = Object.fromEntries(f.map((c, i) => [c, i])); continue; }
    if (f[cols.metric_name] !== 'http_req_failed' || f[cols.name] !== 'today') continue;
    const t = Number(f[cols.timestamp]);
    reqs.set(t, (reqs.get(t) || 0) + 1);
    if (Number(f[cols.metric_value]) === 1) {
      fails.set(t, (fails.get(t) || 0) + 1);
      const s = f[cols.status] || '0';
      statuses.set(s, (statuses.get(s) || 0) + 1);
    }
  }

  const sum = (m, from, to) => { let n = 0; for (const [t, v] of m) if (t >= from && t < to) n += v; return n; };
  const failTimes = (from, to) => [...fails.keys()].filter((t) => t >= from && t < to).sort((a, b) => a - b);

  const start = events.find((e) => e.text.startsWith('START')).t;
  const end = events.find((e) => e.text.startsWith('END')).t;
  const kills = events.filter((e) => e.text.startsWith('KILL'));
  const ready = (label) => {
    const e = events.find((x) => x.text.startsWith(`READY ${label} `));
    return e ? e.text.replace(`READY ${label} after `, '') : '?';
  };

  const out = [];
  out.push(`# Failure test, ${new Date(start * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  out.push('');
  const total = sum(reqs, 0, Infinity); const failed = sum(fails, 0, Infinity);
  out.push(`Steady load for ${end - start} s: ${total} requests, ${failed} failed (${(100 * failed / total).toFixed(2)}%).`);
  if (statuses.size) out.push(`Failed by status: ${[...statuses].map(([s, n]) => `${s === '0' ? 'conn error' : s} ×${n}`).join(', ')}.`);
  out.push('');
  out.push('| At | Killed | Requests (next 60 s) | Failed | User-visible error window | Ready again after |');
  out.push('|---|---|---|---|---|---|');
  kills.forEach((k, i) => {
    const label = k.text.split(' ')[1];
    // A kill's window ends at the next kill (or 60 s), so outages aren't double counted.
    const next = kills.slice(i + 1).find((x) => x.t > k.t);
    const to = Math.min(k.t + WINDOW, next ? next.t : Infinity, end);
    const ft = failTimes(k.t, to);
    const win = ft.length ? `${ft[ft.length - 1] - ft[0] + 1} s` : '—';
    out.push(`| ${k.t - start} s | ${k.text.replace(/^KILL \S+ /, '')} | ${sum(reqs, k.t, to)} | ${sum(fails, k.t, to)} | ${win} | ${ready(label)} |`);
  });
  const before = failTimes(start, kills.length ? kills[0].t : end).length;
  out.push('');
  out.push(`Failures before the first kill (baseline): ${before ? sum(fails, start, kills[0].t) : 0}.`);
  out.push('');
  out.push('Healing after the load stopped:');
  for (const e of events.filter((x) => x.text.startsWith('HEAL'))) out.push(`- ${e.text.replace(/^HEAL /, '')}`);
  console.log(out.join('\n'));
}

main().catch((e) => { console.error(e); process.exit(1); });
