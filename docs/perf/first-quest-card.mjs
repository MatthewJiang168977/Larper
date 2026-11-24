// Throwaway harness: time from navigation to first quest card painted, via raw CDP.
// usage: node perf.mjs <url> <runs>
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url, runs = "7"] = process.argv.slice(2);
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const port = 9400 + Math.floor(Math.random() * 300);
const proc = spawn(EDGE, [`--remote-debugging-port=${port}`, "--headless=new", "--disable-gpu", "--no-first-run", `--user-data-dir=${mkdtempSync(join(tmpdir(), "perf-"))}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ver;
for (let i = 0; i < 50 && !ver; i++) { try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { await sleep(200); } }
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map(); const listeners = [];
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } else listeners.forEach((l) => l(d)); };
const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });

const origin = new URL(url).origin;
const hook = `(() => {
  window.__card = null;
  const look = () => {
    if (window.__card !== null) return;
    if (document.body && document.body.innerText.includes("The Basement Record Shop")) {
      window.__card = -1; requestAnimationFrame(() => requestAnimationFrame(() => { window.__card = performance.now(); }));
    }
  };
  new MutationObserver(look).observe(document, { childList: true, subtree: true, characterData: true });
})()`;

const times = [];
for (let n = 0; n < Number(runs); n++) {
  const { result: { browserContextId } } = await send("Target.createBrowserContext", { disposeOnDetach: true });
  const { result: { targetId } } = await send("Target.createTarget", { url: "about:blank", browserContextId });
  const { result: { sessionId } } = await send("Target.attachToTarget", { targetId, flatten: true });
  const s = (m, p) => send(m, p, sessionId);
  await s("Page.enable"); await s("Network.enable"); await s("Runtime.enable");
  await s("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await s("Emulation.setCPUThrottlingRate", { rate: 4 });
  await s("Network.emulateNetworkConditions", { offline: false, latency: 150, downloadThroughput: 200000, uploadThroughput: 100000 });
  await s("Network.setCacheDisabled", { cacheDisabled: true });
  await s("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
  listeners.push((d) => {
    if (d.method !== "Fetch.requestPaused" || d.sessionId !== sessionId) return;
    const u = d.params.request.url;
    const local = u.startsWith(origin) || u.startsWith("data:") || u.startsWith("blob:");
    send(local ? "Fetch.continueRequest" : "Fetch.failRequest", local ? { requestId: d.params.requestId } : { requestId: d.params.requestId, errorReason: "BlockedByClient" }, sessionId);
  });
  await s("Network.setCookies", { cookies: ["__clerk_db_jwt", "__client_uat", "__clerk_db_jwt_ZXhhbXBs", "__client_uat_ZXhhbXBs"].map((name) => ({ name, value: name.includes("uat") ? "0" : "dev", url: origin })) });
  await s("Page.addScriptToEvaluateOnNewDocument", { source: hook });
  await s("Page.navigate", { url });
  let t = null;
  for (let i = 0; i < 150 && !(t > 0); i++) { await sleep(100); const r = await s("Runtime.evaluate", { expression: "window.__card", returnByValue: true }); t = r.result?.result?.value; }
  if (!(t > 0)) { const r = await s('Runtime.evaluate', { expression: 'document.body ? document.body.innerText.slice(0,300) : "nobody"', returnByValue: true }); console.error('no card; page text:', JSON.stringify(r.result?.result?.value), 'card=', t); }
  times.push(t);
  await send("Target.disposeBrowserContext", { browserContextId });
  listeners.length = 0;
}
ws.close(); proc.kill();
const sorted = [...times].sort((a, b) => a - b);
console.log(JSON.stringify({ url, times: times.map((x) => Math.round(x)), median: Math.round(sorted[Math.floor(sorted.length / 2)]), min: Math.round(sorted[0]), max: Math.round(sorted.at(-1)) }));
