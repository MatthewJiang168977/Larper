#!/usr/bin/env bash
# Records the stack's footprint for a while: every pod's CPU and memory (metrics-server,
# `kubectl top`) and each k3d node container's total memory (`docker stats`, which also
# counts k3s itself: API server, kubelet, containerd). Then summarises per pod (mean and
# peak), per namespace and for the whole cluster.
#
#   loadtest/footprint.sh <label> [seconds=180] [interval=10]
#
# Run k6 alongside it to measure under load. Output: loadtest/results/footprint-<label>-*/
set -uo pipefail
cd "$(dirname "$0")/.."

LABEL=${1:?usage: footprint.sh <label> [seconds] [interval]}
SECONDS_TOTAL=${2:-180}
INTERVAL=${3:-10}
OUT=loadtest/results/footprint-$LABEL-$(date +%Y%m%d-%H%M%S)
mkdir -p "$OUT"
NODES=$(docker ps --filter name=k3d-larper- --format '{{.Names}}' | grep -E 'server-|agent-' | sort | tr '\n' ' ')

end=$(( $(date +%s) + SECONDS_TOTAL ))
while [ "$(date +%s)" -lt "$end" ]; do
  t=$(date +%s)
  kubectl top pods -A --no-headers 2>/dev/null | awk -v t="$t" '{print t, $1, $2, $3, $4}' >>"$OUT/pods.txt"
  # shellcheck disable=SC2086
  docker stats --no-stream --format '{{.Name}} {{.MemUsage}} {{.CPUPerc}}' $NODES 2>/dev/null |
    awk -v t="$t" '{print t, $1, $2, $NF}' >>"$OUT/nodes.txt"
  sleep "$INTERVAL"
done
kubectl get pods -A -o custom-columns=NS:.metadata.namespace,POD:.metadata.name,REQ_CPU:.spec.containers[*].resources.requests.cpu,REQ_MEM:.spec.containers[*].resources.requests.memory,LIM_MEM:.spec.containers[*].resources.limits.memory --no-headers >"$OUT/requests.txt"

node - "$OUT" "$LABEL" <<'EOF' | tee "$OUT/report.md"
const fs = require('fs');
const path = require('path');
const [dir, label] = process.argv.slice(2);
const mi = (s) => { // "123Mi", "1Gi", "2.5GiB", "800MiB", "512KiB"
  const m = /^([\d.]+)([KMG]i?)?B?$/.exec(s);
  if (!m) return NaN;
  return Number(m[1]) * ({ K: 1 / 1024, Ki: 1 / 1024, M: 1, Mi: 1, G: 1024, Gi: 1024 }[m[2]] ?? 1 / 1048576);
};
const cpu = (s) => (s.endsWith('m') ? Number(s.slice(0, -1)) : Number(s) * 1000);
const lines = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean) : []);
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const max = (xs) => Math.max(0, ...xs);
const f0 = (x) => Math.round(x);

const pods = new Map(); const samples = new Map();
for (const l of lines('pods.txt')) {
  const [t, ns, pod, c, m] = l.split(' ');
  const k = `${ns}/${pod}`;
  if (!pods.has(k)) pods.set(k, { ns, pod, cpu: [], mem: [] });
  pods.get(k).cpu.push(cpu(c)); pods.get(k).mem.push(mi(m));
  if (!samples.has(t)) samples.set(t, new Map());
  const s = samples.get(t); const a = s.get(ns) || { cpu: 0, mem: 0 };
  a.cpu += cpu(c); a.mem += mi(m); s.set(ns, a);
}
const nodeSamples = new Map();
for (const l of lines('nodes.txt')) {
  const [t, name, mem] = l.split(' ');
  if (!nodeSamples.has(t)) nodeSamples.set(t, 0);
  nodeSamples.set(t, nodeSamples.get(t) + mi(mem));
}

const out = [`# Footprint: ${label}`, '', `${samples.size} samples of every pod (kubectl top), ${nodeSamples.size} of the k3d node containers (docker stats).`, ''];
out.push('| Namespace | CPU mean / peak (m) | Memory mean / peak (Mi) |', '|---|---|---|');
const nss = [...new Set([...pods.values()].map((p) => p.ns))].sort();
const totalCpu = []; const totalMem = []; const appCpu = []; const appMem = [];
for (const s of samples.values()) {
  let c = 0; let m = 0; let ac = 0; let am = 0;
  for (const [ns, a] of s) { c += a.cpu; m += a.mem; if (ns !== 'monitoring') { ac += a.cpu; am += a.mem; } }
  totalCpu.push(c); totalMem.push(m); appCpu.push(ac); appMem.push(am);
}
for (const ns of nss) {
  const c = [...samples.values()].map((s) => s.get(ns)?.cpu ?? 0);
  const m = [...samples.values()].map((s) => s.get(ns)?.mem ?? 0);
  out.push(`| ${ns} | ${f0(mean(c))} / ${f0(max(c))} | ${f0(mean(m))} / ${f0(max(m))} |`);
}
out.push(`| **all pods except monitoring** | **${f0(mean(appCpu))} / ${f0(max(appCpu))}** | **${f0(mean(appMem))} / ${f0(max(appMem))}** |`);
out.push(`| all pods | ${f0(mean(totalCpu))} / ${f0(max(totalCpu))} | ${f0(mean(totalMem))} / ${f0(max(totalMem))} |`);
const nm = [...nodeSamples.values()];
if (nm.length) out.push('', `k3d node containers (pods + k3s + containerd, 3 nodes): ${f0(mean(nm))} Mi mean, ${f0(max(nm))} Mi peak.`);
out.push('', '| Pod | CPU mean / peak (m) | Memory mean / peak (Mi) |', '|---|---|---|');
for (const p of [...pods.values()].sort((a, b) => a.ns.localeCompare(b.ns) || a.pod.localeCompare(b.pod))) {
  out.push(`| ${p.ns}/${p.pod} | ${f0(mean(p.cpu))} / ${f0(max(p.cpu))} | ${f0(mean(p.mem))} / ${f0(max(p.mem))} |`);
}
console.log(out.join('\n'));
EOF
