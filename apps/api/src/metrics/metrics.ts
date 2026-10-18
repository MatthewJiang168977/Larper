import { createServer, type Server } from 'node:http';
import { Session } from 'node:inspector/promises';
import type { NextFunction, Request, Response } from 'express';
import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';

// Prometheus metrics. Served on their own port (not through the ingress), so the
// public internet can't read them; Prometheus scrapes each pod directly.
export const registry = new Registry();
collectDefaultMetrics({ register: registry }); // event-loop lag, heap, GC, CPU

const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'API request latency, by route template (not raw URL, to bound cardinality)',
  labelNames: ['method', 'route', 'status'],
  // Fine-grained under 1 s, where the p95 we care about lives.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

// Cache-aside lookups by cache (the key prefix: deck, area) and result (hit, miss,
// error). Hit rate = hit / (hit + miss + error).
export const cacheLookups = new Counter({
  name: 'cache_lookups_total',
  help: 'Cache-aside lookups, by cache and result',
  labelNames: ['cache', 'result'],
  registers: [registry],
});

// Requests refused with 429, by limit (ip, user) and route (Controller.handler).
export const rateLimited = new Counter({
  name: 'rate_limited_total',
  help: 'Requests refused by a rate limit, by scope (ip, user) and route',
  labelNames: ['scope', 'route'],
  registers: [registry],
});

// Limit checks let through unchecked because Redis didn't answer (the limiter fails
// open). Non-zero means limits aren't being enforced.
export const rateLimitStorageErrors = new Counter({
  name: 'rate_limit_storage_errors_total',
  help: 'Rate-limit checks that failed open because Redis was down or slow, by limit window',
  labelNames: ['throttler'],
  registers: [registry],
});

// Express middleware. The route is read when the response finishes, after the
// router has matched it; unmatched paths share one label.
export function httpMetrics(req: Request, res: Response, next: NextFunction) {
  const end = httpDuration.startTimer();
  res.on('finish', () => {
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : 'unmatched';
    end({ method: req.method, route, status: String(res.statusCode) });
  });
  next();
}

// CPU profile of this process for N seconds (1-120), as a .cpuprofile that Chrome
// DevTools or speedscope opens. Off unless CPU_PROFILING=1; even then it's only on
// the metrics port, which the ingress never routes to.
async function cpuProfile(seconds: number): Promise<string> {
  const session = new Session();
  session.connect();
  try {
    await session.post('Profiler.enable');
    await session.post('Profiler.start');
    await new Promise((r) => setTimeout(r, seconds * 1000));
    const { profile } = await session.post('Profiler.stop');
    return JSON.stringify(profile);
  } finally {
    session.disconnect();
  }
}

export function serveMetrics(port: number): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/metrics') {
      res.writeHead(200, { 'Content-Type': registry.contentType });
      res.end(await registry.metrics());
      return;
    }
    if (url.pathname === '/debug/cpu-profile' && process.env.CPU_PROFILING === '1') {
      const seconds = Math.min(120, Math.max(1, Number(url.searchParams.get('seconds')) || 30));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(await cpuProfile(seconds));
      return;
    }
    res.writeHead(404).end();
  }).listen(port, '0.0.0.0');
}
